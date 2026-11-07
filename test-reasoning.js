// 推理旁白测试: 每个智能体都要有自然语言推理过程 (理解→查看动作→判断→所以决定→结论)
const os = require('os');
const path = require('path');
const fs = require('fs');

const testHome = path.join(os.tmpdir(), 'orcode-reason-' + Date.now());
fs.mkdirSync(testHome, { recursive: true });
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

const cfgDir = path.join(testHome, '.orcode');
fs.mkdirSync(cfgDir, { recursive: true });
fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
  version: '0.2.17', workers: 1, verifyRounds: 1,
  maxFileReadSize: 100 * 1024 * 1024, maxFileReadChars: 20000,
  defaultModel: { name: 'm1', provider: 'test' },
  models: [
    { name: 'm1', provider: 'test', baseUrl: 'http://x', modelId: 'm1', displayName: 'M1' },
    { name: 'm2', provider: 'test', baseUrl: 'http://x', modelId: 'm2', displayName: 'M2' }
  ],
  positions: {}, workspaceDir: testHome, defaultWorkspaceDir: testHome,
  initialized: true, pathPermissions: {}, apiKeys: {}
}, null, 2));

let out = '';
const origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...a) => { out += String(chunk); return true; };

const results = [];
function check(name, cond) {
  results.push([name, !!cond]);
  console.error(`${cond ? '✓' : '✗'} ${name}`);
}
const K = (name, extra = {}) => Object.assign({ name, ctrl: false, meta: false }, extra);

(async () => {
  const tui = require('./scripts/tui.js');
  const state = tui.__test.initState();
  state.terminalWidth = 110;
  state.terminalHeight = 32;
  const ALL = tui.__test.POSITIONS;
  const task = '帮我做一个游戏关卡的视觉方案';

  // ==================== 1. 每岗都有专属推理脚本 ====================
  check('19 个岗位全部有推理 profile', ALL.every(p => !!tui.__test.REASONING_PROFILES[p.key]));
  const scripts = {};
  ALL.forEach(p => { scripts[p.key] = tui.__test.buildReasoning(p.key, task); });
  check('每岗生成 5 步推理', ALL.every(p => scripts[p.key].length === 5));
  check('推理里带真实任务摘要', ALL.every(p => scripts[p.key][0].includes('游戏关卡的视觉方案')));
  check('每岗都有 ◎ 查看/动作行', ALL.every(p => scripts[p.key][1].startsWith('◎')));
  check('有"确认了"的判断句', ALL.every(p => scripts[p.key][2].startsWith('确认了：')));
  check('有"所以决定"的推理结论', ALL.every(p => scripts[p.key][3].startsWith('所以决定：')));
  check('有"✓ 完成"收尾', ALL.every(p => scripts[p.key][4].includes('✓ 完成')));
  check('推理句不是干巴巴的标签 (平均长度 > 18 字)',
    ALL.every(p => scripts[p.key].reduce((s, l) => s + l.length, 0) / 5 > 18));

  // 岗位差异化
  check('不同岗位推理内容不同 (coder vs art-director)', scripts.coder[2] !== scripts['art-director'][2]);
  check('美术指导推理里提到视觉风格', scripts['art-director'].join('').includes('视觉风格'));
  check('程序员推理里有"查看文件、修改"式动作', scripts.coder[1].includes('修改'));
  check('视觉设计师推理贴视觉职责', scripts['visual-designer'].join('').includes('配色'));
  check('图像分析师推理贴读图职责', scripts['vision-analyst'].join('').includes('图'));

  // ==================== 2. 树内/窗口内渲染区分图标 ====================
  state.treeThinking.coder = true;
  state.positions.coder.thought = scripts.coder.slice();
  out = '';
  tui.__test.render();
  check('树内思考行渲染 ◎ 动作图标', out.includes('◎ 查看'));
  check('树内思考行渲染判断句', out.includes('确认了：'));
  check('树内思考行渲染 ✓ 结论', out.includes('✓ 完成'));

  tui.__test.openSubSessionTab('coder');
  out = '';
  tui.__test.render();
  check('窗口"深度思考"显示完整推理链', out.includes('接到「') && out.includes('所以决定：'));
  check('窗口区分 ◎ / ✓ 图标', out.includes('◎ 查看') && out.includes('✓ 完成'));
  check('窗口标题显示推理条数', out.includes('深度思考'));

  // ==================== 3. HOR-loop 中每岗都产出真实推理 ====================
  tui.__test.returnToMainTab();
  state.treeThinking = {};
  await new Promise(res => {
    tui.__test.setInput('/hor-loop');
    tui.__test.handleKeyPublic('', K('return')).then(() => {
      tui.__test.setInput(task);
      tui.__test.handleKeyPublic('', K('return')).then(res);
    });
  });
  check('HOR-loop 后 19 岗都有推理记录', ALL.every(p => (state.positions[p.key].thought || []).length > 0));
  check('每岗推理都含 ◎ 动作行', ALL.every(p => state.positions[p.key].thought.some(t => t.startsWith('◎'))));
  check('每岗推理都含"所以决定"', ALL.every(p => state.positions[p.key].thought.some(t => t.startsWith('所以决定：'))));
  check('每岗推理都含"✓ 完成"', ALL.every(p => state.positions[p.key].thought.some(t => t.includes('✓ 完成'))));
  check('推理过程归档进各岗子会话', ALL.every(p => tui.__test.getSubSession(p.key).log.some(l => l.startsWith('确认了：'))));
  check('子岗推理带任务摘要', tui.__test.getSubSession('coder').log.some(l => l.includes('游戏关卡')));
  check('推理链未被截断 (每岗 ≥5 条)', ALL.every(p => state.positions[p.key].thought.length >= 5));

  // ==================== 4. 单模型调用也有推理 ====================
  // 用 e2e 的 mock 服务器不方便, 这里验证推理写入函数与归档路径
  const before = tui.__test.getSubSession('director').log.length;
  tui.__test.emitReasoning('director', tui.__test.buildReasoning('director', '测试一句话').slice(0, 3));
  check('emitReasoning 同时写 thought 与 subLog',
    state.positions.director.thought.some(t => t.includes('测试一句话')) &&
    tui.__test.getSubSession('director').log.length === before + 3);

  // ==================== 汇总 ====================
  const pass = results.filter(r => r[1]).length;
  console.error(`\n══ 推理旁白测试: ${pass}/${results.length} 通过 ══`);
  process.stdout.write = origWrite;
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => {
  process.stdout.write = origWrite;
  console.error('TEST ERROR:', e);
  process.exit(1);
});
