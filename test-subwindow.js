// 子会话窗口测试: 每岗位一个子会话, 点击工作树在新标签页打开 (只读), 不可与子模型对话
const os = require('os');
const path = require('path');
const fs = require('fs');

const testHome = path.join(os.tmpdir(), 'orcode-subwin-' + Date.now());
fs.mkdirSync(testHome, { recursive: true });
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

const cfgDir = path.join(testHome, '.orcode');
fs.mkdirSync(cfgDir, { recursive: true });
fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
  version: '0.2.14', workers: 1, verifyRounds: 1,
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

  // ==================== 1. 打开子会话窗口 ====================
  check('初始只有 1 个主会话标签', state.sessions.length === 1 && state.sessions[0].kind === 'main');
  tui.__test.openSubSessionTab('coder');
  check('打开 coder 子会话 → 新增标签', state.sessions.length === 2);
  check('新标签 kind=sub 且 posKey=coder', state.sessions[1].kind === 'sub' && state.sessions[1].posKey === 'coder');
  check('切换到子标签 (activeIndex=1)', state.activeIndex === 1);
  check('state.subSession = coder', state.subSession === 'coder');
  check('标签标题 = 岗位名', state.sessions[1].title.includes('Coder'));
  check('初始子会话记录为空', state.subSessionLog.length === 0);

  // 再打开同一岗位 → 聚焦已有标签, 不新建
  tui.__test.returnToMainTab();
  check('Esc 返回主会话标签', state.activeIndex === 0 && state.sessions[0].kind === 'main' && state.subSession === null);
  tui.__test.openSubSessionTab('coder');
  check('重复打开不新建标签 (聚焦已有)', state.sessions.length === 2 && state.activeIndex === 1);

  // ==================== 2. 子会话记录积累与回显 ====================
  tui.__test.returnToMainTab();
  tui.__test.subLog('coder', '○ 分析任务需求');
  tui.__test.subLog('coder', '✓ 计划完成');
  check('subLog 写入子会话存储', tui.__test.getSubSession('coder').log.length === 2);
  tui.__test.openSubSessionTab('coder');
  check('重开窗口显示累计记录', state.subSessionLog.length === 2 && state.subSessionLog[1] === '✓ 计划完成');
  check('窗口"最近思考"取自记录尾部', state.positions.coder.thought[state.positions.coder.thought.length - 1] === '✓ 计划完成');

  // ==================== 3. 只读: 不可与子模型对话 ====================
  tui.__test.setInput('');
  await tui.__test.handleKeyPublic('h', K('h'));
  await tui.__test.handleKeyPublic('i', K('i'));
  check('只读窗口: 键入不进入输入框', state.currentInput === '');
  await tui.__test.handleKeyPublic('', K('return'));
  check('只读窗口: 回车不产生指令记录', !state.subSessionLog.some(l => l.startsWith('▸ 指令:')));
  check('只读窗口: 回车给出提示', out.includes('只读窗口') || state.history.some(h => String(typeof h === 'object' ? h.text : h).includes('只读窗口')));
  check('只读窗口: 仍未离开子标签', state.subSession === 'coder' && state.sessions[state.activeIndex].kind === 'sub');
  await tui.__test.handleKeyPublic('', K('escape'));
  check('Esc 返回主会话', state.subSession === null && state.sessions[state.activeIndex].kind === 'main');

  // ==================== 4. HOR-loop 活动写入各岗位子会话 ====================
  state.config.workers = 1;
  state.config.verifyRounds = 1;
  // 确保在主会话标签再启动 (只读子窗口会拦截输入)
  tui.__test.returnToMainTab();
  await new Promise(res => {
    tui.__test.setInput('/hor-loop');
    tui.__test.handleKeyPublic('', K('return')).then(() => {
      tui.__test.setInput('写一个待办清单');
      tui.__test.handleKeyPublic('', K('return')).then(res);
    });
  });
  check('HOR-loop 后 director 子会话有记录', tui.__test.getSubSession('director').log.length > 0);
  check('HOR-loop 后 planner 子会话有记录', tui.__test.getSubSession('planner').log.some(l => l.includes('计划完成')));
  check('HOR-loop 后 worker 子会话有记录', tui.__test.getSubSession('worker').log.some(l => l.includes('Worker 1')));
  check('HOR-loop 后 verifier 子会话有记录', tui.__test.getSubSession('verifier').log.some(l => l.includes('第 1 轮')));
  check('职能岗 (coder) 无 HOR 活动 → 记录为空', tui.__test.getSubSession('coder').log.length === 2);

  // ==================== 5. 标签栏渲染 ====================
  out = '';
  tui.__test.render();
  check('标签栏渲染含"子会话"字样', out.includes('子会话'));
  check('标签栏渲染含 [+ 新会话]', out.includes('[+ 新会话]'));

  // ==================== 6. 关闭子标签 ====================
  tui.__test.openSubSessionTab('tester');
  check('打开 tester 子窗口', state.sessions.some(s => s.kind === 'sub' && s.posKey === 'tester'));
  const before = state.sessions.length;
  tui.__test.closeSession(state.activeIndex);
  check('关闭子标签成功', state.sessions.length === before - 1 && !state.sessions.some(s => s.posKey === 'tester'));
  check('关闭后记录仍保留在存储', tui.__test.getSubSession('coder').log.length === 2);

  // ==================== 7. subKeyForModel 路由 ====================
  state.positions.coder.model = 'm2';
  check('模型名 → 岗位 key 路由', tui.__test.subKeyForModel('m2') === 'coder');
  check('未知模型回退 director', tui.__test.subKeyForModel('nope') === 'director');

  // ==================== 汇总 ====================
  const pass = results.filter(r => r[1]).length;
  console.error(`\n══ 子会话窗口测试: ${pass}/${results.length} 通过 ══`);
  process.stdout.write = origWrite;
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => {
  process.stdout.write = origWrite;
  console.error('TEST ERROR:', e);
  process.exit(1);
});
