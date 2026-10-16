// v0.2.12 测试: 指令向导小窗口 (滚动/点击/翻页) + 像素 logo 双色 + 搜索自动触发提示
const os = require('os');
const path = require('path');
const fs = require('fs');

const testHome = path.join(os.tmpdir(), 'orcode-v0212-' + Date.now());
const workspace = path.join(testHome, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

const cfgDir = path.join(testHome, '.orcode');
fs.mkdirSync(cfgDir, { recursive: true });
fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
  version: '0.2.12', workers: 2, verifyRounds: 1,
  defaultModel: { name: 'test-model', provider: 'test' },
  models: [{ name: 'test-model', provider: 'test', baseUrl: 'http://x', modelId: 'm1', displayName: 'Test' }],
  positions: {}, workspaceDir: workspace, defaultWorkspaceDir: workspace,
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
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

(async () => {
  const tui = require('./scripts/tui.js');
  const T = tui.__test;
  const state = T.initState();

  // ==================== 1. 像素 logo 双色 ====================
  const GRAY = '\x1b[38;5;245m';
  const BLUE = '\x1b[38;2;5;5;26m';
  const logo = T.renderPixelLogo();
  check('logo 5 行', logo.length === 5);
  check('每行同时含灰色段与蓝黑段', logo.every(l => l.includes(GRAY) && l.includes(BLUE)));
  check('灰色段在前、蓝黑段在后', logo.every(l => l.indexOf(GRAY) < l.indexOf(BLUE)));
  check('字形内容不变 (去 ANSI 后 36 列)', logo.every(l => stripAnsi(l).length === 36));
  check('每行两段各 18 列', logo.every(l => stripAnsi(l.split(BLUE)[0].replace(GRAY, '')).length === 18));

  // ==================== 2. 指令小窗口: 几何与滚动 ====================
  state.terminalWidth = 90;
  state.terminalHeight = 30;
  T.setInput('/');
  state.guideIndex = 0;
  state.guideScroll = 0;
  out = '';
  T.renderCommandGuide();
  const g = state._guideGeom;
  const count = state.filteredCommands().length;
  check('几何已记录', !!g && g.count === count);
  check('窗口高 = 可见行数 + 2 边框', g.ph === g.visRows + 2);
  check('窗口顶部不小于 2', g.py >= 2);
  check('窗口底边在输入行上方', g.py + g.ph - 1 <= state.terminalHeight - 5);
  check('窗口宽 52', g.pw === 52);
  check('命令多时最多可见 12 行', g.visRows === 12);
  check('渲染输出含边框与高亮选中行', out.includes('┌') && out.includes('└') && out.includes('\x1b[7m'));

  // guideIndex 追到末尾 → scroll 跟随
  state.guideIndex = count - 1;
  T.renderCommandGuide();
  check('选中末项时滚动跟随 (top = count - visRows)', state.guideScroll === count - g.visRows);

  // scroll 越界钳制
  state.guideScroll = 999;
  T.renderCommandGuide();
  check('scroll 越界钳制到 maxScroll', state.guideScroll === Math.max(0, count - g.visRows));

  // 小终端: 顶部不越界、可见行数收缩
  state.terminalHeight = 12;
  state.guideIndex = 0;
  state.guideScroll = 0;
  T.renderCommandGuide();
  const gSmall = state._guideGeom;
  check('小终端可见行数收缩 (≥1)', gSmall.visRows >= 1 && gSmall.visRows < 12);
  check('小终端窗口顶 ≥ 2', gSmall.py >= 2);
  check('小终端窗口底仍在输入行上方', gSmall.py + gSmall.ph - 1 <= 12 - 5);

  // ==================== 3. 悬停与点击 ====================
  state.terminalHeight = 30;
  T.setInput('/re');            // 过滤出 /remember /readlimit
  state.guideIndex = 0;
  state.guideScroll = 0;
  T.renderCommandGuide();
  const gf = state._guideGeom;
  check('/re 过滤出 2 条命令', gf.count === 2);
  T.handleMouseHover(gf.px + 10, gf.py + 1 + 1);
  check('悬停第二行 → 选中 index 1', state.guideIndex === 1);

  T.setInput('/readlimit');     // 单条, 点击执行 (安全命令: 仅打印当前上限)
  state.guideIndex = 0;
  state.guideScroll = 0;
  T.renderCommandGuide();
  const g1 = state._guideGeom;
  check('/readlimit 过滤出 1 条', g1.count === 1);
  T.handleMouseClick(g1.px + 10, g1.py + 1);
  check('点击命令项 → 执行后清空输入', state.currentInput === '');
  check('点击后 guideIndex 复位', state.guideIndex === 0);

  // 点击窗口外不触发
  T.setInput('/readlimit');
  state.guideIndex = 0;
  T.renderCommandGuide();
  T.handleMouseClick(2, 2);     // logo 区域, 不在窗口内
  check('点击窗口外不执行且输入保留', state.currentInput === '/readlimit');

  // ==================== 4. 键盘翻页 (PgUp/PgDn) ====================
  T.setInput('/');
  state.guideIndex = 0;
  state.guideScroll = 0;
  T.renderCommandGuide();
  state.guideIndex = 20;
  await T.handleKey('', { name: 'pagedown', ctrl: false, meta: false });
  check('pagedown 向后翻一页 (钳到末项)', state.guideIndex === count - 1);
  await T.handleKey('', { name: 'pageup', ctrl: false, meta: false });
  await T.handleKey('', { name: 'pageup', ctrl: false, meta: false });
  check('pageup 两次向前翻两页', state.guideIndex === Math.max(0, count - 1 - 2 * ((state._guideGeom || {}).visRows || 8)));
  check('翻页后选中项在可见窗口内', state.guideIndex >= state.guideScroll
    && state.guideIndex < state.guideScroll + state._guideGeom.visRows);

  // up/down 导航仍工作
  state.guideIndex = 3;
  await T.handleKey('', { name: 'down', ctrl: false, meta: false });
  check('down 键选中 +1', state.guideIndex === 4);
  await T.handleKey('', { name: 'up', ctrl: false, meta: false });
  await T.handleKey('', { name: 'up', ctrl: false, meta: false });
  check('up 键选中 -1 (×2)', state.guideIndex === 2);

  // ==================== 5. 搜索自动触发提示 (start.js) ====================
  const startSrc = fs.readFileSync(path.join(__dirname, 'scripts', 'start.js'), 'utf-8');
  check('提示词含自动触发规则', startSrc.includes('搜索自动触发'));
  check('提示词强调无需 /search 命令', startSrc.includes('无需用户要求') && startSrc.includes('/search'));
  check('提示词列明时效性场景', startSrc.includes('时效性信息'));
  check('SEARCH 工具块协议保留', startSrc.includes('<<<SEARCH'));

  // ==================== 结果 ====================
  const pass = results.filter(r => r[1]).length;
  console.error(`\n==== guide/logo/autosearch 测试: ${pass}/${results.length} 通过 ====`);
  process.exitCode = pass === results.length ? 0 : 1;
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
