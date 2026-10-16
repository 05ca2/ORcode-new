// 工作树测试: 岗位树结构 (流程层+职能层子分支), 树形渲染, 折叠/展开, 滚动, 点击进入子会话
const os = require('os');
const path = require('path');
const fs = require('fs');

const testHome = path.join(os.tmpdir(), 'orcode-tree-' + Date.now());
fs.mkdirSync(testHome, { recursive: true });
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

const cfgDir = path.join(testHome, '.orcode');
fs.mkdirSync(cfgDir, { recursive: true });
fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
  version: '0.2.13', workers: 2, verifyRounds: 1,
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

// ANSI 输出 → 二维网格 (用于验证树不超出面板/不压底部输入区)
function toGrid(W, H) {
  const grid = Array.from({ length: H }, () => Array(W).fill(' '));
  const re = /\x1b\[(\d+);(\d+)H|\x1b\[[0-9;]*m|([^\x1b]+)/g;
  let m, cy = 1, cx = 1;
  const s = out; out = '';
  while ((m = re.exec(s))) {
    if (m[1] !== undefined) { cy = +m[1]; cx = +m[2]; }
    else if (m[3]) { for (const ch of m[3]) { if (cy <= H && cx <= W) grid[cy - 1][cx - 1] = ch; cx++; } }
  }
  return grid;
}

(async () => {
  const tui = require('./scripts/tui.js');
  const state = tui.__test.initState();
  const { POSITIONS, POSITION_TREE, TOP_POSITION_KEYS } = tui.__test;

  // ==================== 1. 岗位树结构 ====================
  check('流程层 4 个父节点', TOP_POSITION_KEYS.length === 4);
  check('流程层顺序 = director/planner/worker/verifier',
    JSON.stringify(TOP_POSITION_KEYS) === JSON.stringify(['director', 'planner', 'worker', 'verifier']));
  check('每个父节点都有子分支', POSITION_TREE.every(p => Array.isArray(p.children) && p.children.length >= 1 || p.key === 'verifier'));
  check('职能层共 12 个子节点', POSITIONS.length - TOP_POSITION_KEYS.length === 12);
  check('扁平化总数 16', POSITIONS.length === 16);
  check('子节点带 parent 指向父节点', POSITIONS.filter(p => p.parent).every(p => TOP_POSITION_KEYS.includes(p.parent)));
  check('包含新增职能岗 (researcher/coder/critic/translator...)',
    ['researcher', 'data', 'coder', 'tester', 'security', 'critic', 'editor', 'translator', 'summarizer', 'pm', 'coordinator', 'architect']
      .every(k => POSITIONS.some(p => p.key === k)));
  check('state.positions 覆盖全部 16 岗', Object.keys(state.positions).length === 16);
  check('子岗有 status/model 字段', state.positions.coder && state.positions.coder.status === 'idle' && state.positions.coder.model === '-');

  // ==================== 2. 树形渲染 + 几何登记 ====================
  state.terminalWidth = 110;
  state.terminalHeight = 34;
  state.selectedIndex = 0;
  tui.__test.render();
  const g = state._treeGeom;
  check('树几何已登记 (_treeGeom)', !!g && Array.isArray(g.rows) && g.rows.length > 0);
  check('大终端一屏放得下 (maxScroll=0)', g.maxScroll === 0);
  check('16 个节点行全部可见 (父+子)', g.rows.filter(r => !r.isParent || true).length >= 16);
  check('几何行键都是合法岗位', g.rows.every(r => POSITIONS.some(p => p.key === r.key)));

  // 渲染输出不超出树面板右边界, 不压底部输入区 (H-4 以下)
  const grid = toGrid(110, 34);
  const treeW = Math.max(30, Math.floor(110 * 0.34));
  const treeX = 110 - treeW + 1;
  const treeRight = treeX + (treeW - 1) - 1;
  let overflow = false, hitBottom = false;
  for (let y = 3; y < 34; y++) {
    for (let x = treeX; x < 110; x++) {
      if (grid[y - 1][x] !== ' ') {
        if (x > treeRight) overflow = true;
        // 只查输入行 (H-3) 与其下空行 (H-2); H-4 是通宽分割线, 合法穿越树列
        if (y >= 34 - 3 && y <= 34 - 2) hitBottom = true;
      }
    }
  }
  check('树内容不超出面板右边界', !overflow);
  check('树内容不压底部输入区', !hitBottom);

  // ==================== 3. 窄终端: 标签截断不溢出 ====================
  state.terminalWidth = 70;   // treeW=30, 可用 29 列
  state.selectedIndex = 10;   // security
  tui.__test.render();
  const grid2 = toGrid(70, 34);
  const treeW2 = Math.max(30, Math.floor(70 * 0.34));
  const treeX2 = 70 - treeW2 + 1;
  const treeRight2 = treeX2 + (treeW2 - 1) - 1;
  let ov2 = false;
  for (let y = 3; y < 34; y++) {
    for (let x = treeX2; x < 70; x++) {
      if (grid2[y - 1][x] !== ' ' && x > treeRight2) ov2 = true;
    }
  }
  check('窄终端长标签截断后不溢出面板', !ov2);
  check('窄终端安全审计岗仍在树中', state._treeGeom.rows.some(r => r.key === 'security'));

  // ==================== 4. 小终端: 自动滚动 + 焦点可见 ====================
  state.terminalWidth = 100;
  state.terminalHeight = 22;
  state.selectedIndex = 15;   // verifier (最后一个)
  state.treeScroll = 0;
  tui.__test.render();
  const g3 = state._treeGeom;
  check('小终端触发滚动 (maxScroll>0)', g3.maxScroll > 0);
  const selRow = g3.rows.find(r => r.key === 'verifier');
  check('选中节点 (verifier) 滚入视窗', !!selRow && selRow.y >= 4 && selRow.y <= 4 + g3.visRows - 1);
  check('焦点行在最底附近 (自动跟随)', !!selRow && selRow.y >= 4 + g3.visRows - 2);

  // 手动滚动越界钳制 (先渲染一次锁定焦点 token, 避免焦点变化触发自动跟随)
  state.selectedIndex = 0;   // director (焦点在顶)
  state.treeScroll = 0;
  tui.__test.render();
  state.treeScroll = 999;
  tui.__test.render();
  check('treeScroll 越界钳制到 maxScroll', state.treeScroll === state._treeGeom.maxScroll);
  state.treeScroll = -5;
  tui.__test.render();
  check('treeScroll 负值钳制到 0', state.treeScroll === 0);
  // 焦点未变时, 手动滚动不被焦点跟随弹回
  state.treeScroll = 4;
  tui.__test.render();
  check('焦点未变时手动滚动不被弹回', state.treeScroll === 4);
  // 切换选中 → 自动跟随到新焦点
  state.selectedIndex = 15;  // verifier
  tui.__test.render();
  check('切换选中后自动跟随焦点 (verifier 可见)', state._treeGeom.rows.some(r => r.key === 'verifier'));

  // ==================== 5. 折叠/展开 ====================
  state.terminalWidth = 110;
  state.terminalHeight = 34;
  state.treeScroll = 0;
  state.selectedIndex = 0;
  state.treeCollapsed = {};
  tui.__test.render();
  check('默认展开: worker 子岗可见', state._treeGeom.rows.some(r => r.key === 'coder'));

  // 点 worker 行的折叠标记 (行尾 ▾)
  const workerRow = state._treeGeom.rows.find(r => r.key === 'worker');
  tui.__test.handleMouseClick(workerRow.toggleX1, workerRow.y);
  check('点 ▾ 收起 worker 子分支', state.treeCollapsed.worker === true);
  check('收起后子岗 (coder) 不可见', !state._treeGeom.rows.some(r => r.key === 'coder'));
  check('收起后父岗仍在', state._treeGeom.rows.some(r => r.key === 'worker'));

  // 再点展开
  const workerRow2 = state._treeGeom.rows.find(r => r.key === 'worker');
  tui.__test.handleMouseClick(workerRow2.toggleX1, workerRow2.y);
  check('点 ▸ 重新展开 worker 子分支', state.treeCollapsed.worker === false);
  check('展开后子岗恢复可见', state._treeGeom.rows.some(r => r.key === 'coder'));

  // ==================== 6. 点击岗位行进子会话 ====================
  state.selectedIndex = 0;
  state.subSession = null;
  tui.__test.render();
  const coderRow = state._treeGeom.rows.find(r => r.key === 'coder');
  tui.__test.handleMouseClick(coderRow ? state._treeGeom.x + 6 : 0, coderRow.y);
  check('点击子岗行 (程序员) 进入子会话', state.subSession === 'coder');

  // director 行点击只选中不进子会话
  state.subSession = null;
  tui.__test.render();
  const dirRow = state._treeGeom.rows.find(r => r.key === 'director');
  tui.__test.handleMouseClick(dirRow ? state._treeGeom.x + 6 : 0, dirRow.y);
  check('点击 Director 保持主会话 (不进子会话)', state.subSession === null);
  check('点击 Director 同步 selectedIndex', POSITIONS[state.selectedIndex].key === 'director');

  // 点岗位行 (非折叠标记) 不会误触折叠
  state.treeCollapsed = {};
  tui.__test.render();
  const plannerRow = state._treeGeom.rows.find(r => r.key === 'planner');
  tui.__test.handleMouseClick(state._treeGeom.x + 8, plannerRow.y);
  check('点行主体不触发折叠', state.treeCollapsed.planner !== true);
  check('点 Planner 行进子会话', state.subSession === 'planner');

  // ==================== 汇总 ====================
  const pass = results.filter(r => r[1]).length;
  console.error(`\n══ 工作树测试: ${pass}/${results.length} 通过 ══`);
  process.stdout.write = origWrite;
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => {
  process.stdout.write = origWrite;
  console.error('TEST ERROR:', e);
  process.exit(1);
});
