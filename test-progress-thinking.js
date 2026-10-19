// 进度 + 思考折叠测试: 每岗完成进度, 行内/窗口内可折叠展开的推理思考过程
const os = require('os');
const path = require('path');
const fs = require('fs');

const testHome = path.join(os.tmpdir(), 'orcode-prog-' + Date.now());
fs.mkdirSync(testHome, { recursive: true });
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

const cfgDir = path.join(testHome, '.orcode');
fs.mkdirSync(cfgDir, { recursive: true });
fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
  version: '0.2.16', workers: 1, verifyRounds: 1,
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
  state.terminalHeight = 30;

  // ==================== 1. 完成进度 ====================
  check('叶子岗默认 0%', tui.__test.positionProgress('coder') === 0);
  state.positions.coder.status = 'thinking';
  check('思考中 = 35%', tui.__test.positionProgress('coder') === 35);
  state.positions.coder.status = 'working';
  check('执行中 = 70%', tui.__test.positionProgress('coder') === 70);
  state.positions.coder.status = 'completed';
  check('完成 = 100%', tui.__test.positionProgress('coder') === 100);
  check('叶子进度标签 = 百分比', tui.__test.progressLabel('coder') === '100%');

  // 父节点 = 子智能体完成比例 (先复位叶子岗)
  state.positions.coder.status = 'idle';
  check('worker 父节点 0/11 = 0%', tui.__test.positionProgress('worker') === 0);
  const wk = tui.__test.childKeys('worker');
  wk.slice(0, 3).forEach(k => { state.positions[k].status = 'completed'; });
  check('worker 3/11 ≈ 27%', tui.__test.positionProgress('worker') === 27);
  check('父节点进度标签 = 完成数', tui.__test.progressLabel('worker') === '3/11');
  check('planner 父节点进度正常计算', tui.__test.positionProgress('planner') === 0);

  const pb = tui.__test.progressBar('worker');
  check('进度条 10 格', pb.bar.length === 10 && pb.bar.includes('■') && pb.bar.includes('░'));
  check('进度条文本含百分比与子岗数', pb.text.includes('27%') && pb.text.includes('3/11'));
  // 复位
  wk.forEach(k => { state.positions[k].status = 'idle'; });
  state.positions.coder.status = 'idle';

  // ==================== 2. 树内思考折叠/展开 ====================
  state.selectedIndex = 0;
  state.treeThinking = {};
  tui.__test.render();
  out = '';
  tui.__test.render();
  check('默认不展开思考 (无 🧠 行)', !out.includes('🧠'));

  // 给 director 加点思考内容
  state.positions.director.thought = ['接收指令，准备协调', '整合所有结果'];
  // 点 director 的描述行 → 展开思考
  const tg = state._treeGeom;
  const dirDesc = tg.descRows.find(r => r.key === 'director');
  check('描述行几何已登记', !!dirDesc);
  tui.__test.handleMouseClick(tg.x + 2, dirDesc.y);
  check('点描述行 = 展开思考', state.treeThinking.director === true);
  out = '';
  tui.__test.render();
  check('展开后树内出现 🧠 思考行', out.includes('🧠'));
  check('思考内容上屏 (接收指令)', out.includes('接收指令'));
  // 再点 → 折叠
  const tg2 = state._treeGeom;
  const dirDesc2 = tg2.descRows.find(r => r.key === 'director');
  tui.__test.handleMouseClick(tg2.x + 2, dirDesc2.y);
  check('再点描述行 = 折叠思考', state.treeThinking.director === false);
  out = '';
  tui.__test.render();
  check('折叠后 🧠 行消失', !out.includes('🧠'));

  // 点节点行图标列 → 切换思考
  const tg3 = state._treeGeom;
  const dirRow = tg3.rows.find(r => r.key === 'director');
  tui.__test.handleMouseClick(dirRow.iconX1, dirRow.y);
  check('点图标列 = 展开思考', state.treeThinking.director === true);
  tui.__test.handleMouseClick(dirRow.iconX1, dirRow.y);
  check('再点图标列 = 折叠思考', state.treeThinking.director === false);

  // 点子岗 (coder) 图标 → 也能展开 (所有智能体都有)
  state.positions.coder.thought = ['分析任务需求', '写代码'];
  const tg4 = state._treeGeom;
  const coderRow = tg4.rows.find(r => r.key === 'coder');
  tui.__test.handleMouseClick(coderRow.iconX1, coderRow.y);
  check('子岗也能展开思考 (coder)', state.treeThinking.coder === true);
  out = '';
  tui.__test.render();
  check('子岗思考内容上屏 (写代码)', out.includes('写代码'));

  // 点节点行主体 (非图标/非行尾) → 仍打开子会话窗口, 不误触思考
  const tabsBefore = state.sessions.length;
  const tg5 = state._treeGeom;
  const coderRow2 = tg5.rows.find(r => r.key === 'coder');
  tui.__test.handleMouseClick(tg5.x + 12, coderRow2.y);
  check('点行主体仍打开子会话窗口', state.subSession === 'coder' && state.sessions.length === tabsBefore + 1);

  // ==================== 3. 子会话窗口: 进度条 + 可折叠深度思考 ====================
  tui.__test.returnToMainTab();
  state.treeThinking = {};   // 复位树内思考展开 (第 2 节开过), 避免干扰窗口断言
  // 先设置实时状态再开窗口 (窗口复制实时进度/思考)
  state.positions.coder.status = 'working';
  state.positions.coder.thought = ['分析任务需求', '写代码', '自测'];
  tui.__test.openSubSessionTab('coder');
  out = '';
  tui.__test.render();
  check('窗口显示进度条', out.includes('■') && out.includes('70%'));
  check('窗口显示"深度思考"标题', out.includes('深度思考'));
  check('默认展开: 思考内容可见', out.includes('自测'));
  check('进度条含状态文字 (执行中)', out.includes('执行中'));

  // t 键折叠
  await tui.__test.handleKeyPublic('t', K('t'));
  check('t 键折叠深度思考', state.subThinkOpen === false);
  out = '';
  tui.__test.render();
  check('折叠后思考内容隐藏', !out.includes('自测') && out.includes('深度思考'));
  // 点标题行展开
  tui.__test.handleMouseClick(4, state._subThinkHeaderY);
  check('点标题行重新展开', state.subThinkOpen === true);
  out = '';
  tui.__test.render();
  check('展开后思考内容恢复', out.includes('自测'));

  // 只读仍然生效
  await tui.__test.handleKeyPublic('x', K('x'));
  check('只读拦截仍然生效', state.currentInput === '');

  // ==================== 4. HOR-loop 后全员有进度 ====================
  tui.__test.returnToMainTab();
  await new Promise(res => {
    tui.__test.setInput('/hor-loop');
    tui.__test.handleKeyPublic('', K('return')).then(() => {
      tui.__test.setInput('画一张游戏地图');
      tui.__test.handleKeyPublic('', K('return')).then(res);
    });
  });
  const allKeys = tui.__test.POSITIONS.map(p => p.key);
  check('HOR-loop 后全部 19 岗 100%', allKeys.every(k => tui.__test.positionProgress(k) === 100));
  check('父岗进度标签 = 全部完成', tui.__test.progressLabel('worker') === '11/11' && tui.__test.progressLabel('director') === '2/2');
  check('每岗都有思考记录', allKeys.every(k => (state.positions[k].thought || []).length > 0));

  // ==================== 汇总 ====================
  const pass = results.filter(r => r[1]).length;
  console.error(`\n══ 进度/思考测试: ${pass}/${results.length} 通过 ══`);
  process.stdout.write = origWrite;
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => {
  process.stdout.write = origWrite;
  console.error('TEST ERROR:', e);
  process.exit(1);
});
