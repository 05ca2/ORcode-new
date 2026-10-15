// 对话历史翻看 + 分割线测试: 隔离 HOME + mock stdout
const os = require('os');
const path = require('path');
const fs = require('fs');

// 隔离 HOME (避免动真实 ~/.orcode)
const testHome = path.join(os.tmpdir(), 'orcode-hist-test-' + Date.now());
fs.mkdirSync(testHome, { recursive: true });
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

const cfgDir = path.join(testHome, '.orcode');
fs.mkdirSync(cfgDir, { recursive: true });
fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
  version: '0.2.3', workers: 2, verifyRounds: 1,
  defaultModel: { name: 'test-model', provider: 'test' },
  models: [{ name: 'test-model', provider: 'test', baseUrl: 'http://x', modelId: 'm1', displayName: 'Test' }],
  positions: {}, workspaceDir: testHome, defaultWorkspaceDir: testHome,
  initialized: true, pathPermissions: {}, apiKeys: {}
}, null, 2));

// mock stdout (测试日志走 stderr)
let out = '';
const origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...a) => { out += String(chunk); return true; };

const results = [];
function check(name, cond) {
  results.push([name, !!cond]);
  console.error(`${cond ? '✓' : '✗'} ${name}`);
}

(async () => {
  const tui = require('./scripts/tui.js');
  const state = tui.__test.initState();

  // ---- 1. logUserTurn: 分割线 + 用户输入 ----
  const beforeLen = state.history.length;
  tui.__test.logUserTurn('你好, 帮我写个函数');
  check('logUserTurn 追加 2 行 (分割线+输入)', state.history.length === beforeLen + 2);
  check('分割线对象带 separator 标记', state.history[beforeLen].separator === true);
  check('用户输入行以 ▸ 你: 开头', state.history[beforeLen + 1].text.startsWith('▸ 你:'));
  check('用户输入内容完整记录', state.history[beforeLen + 1].text.includes('你好, 帮我写个函数'));
  check('用户输入行用 accent 色', state.history[beforeLen + 1].color && state.history[beforeLen + 1].color.length > 0);

  // ---- 2. 分割线渲染: 铺满面板宽度 ----
  out = '';
  state.history = [
    { text: '', color: '\x1b[38;5;240m', separator: true },
    '第一条对话内容',
    '第二条对话内容'
  ];
  state.historyScroll = 0;
  tui.__test.render();
  check('分割线在渲染中输出为 ─ 重复', /─{10,}/.test(out));

  // ---- 3. 滚动逻辑 ----
  // 填满超过面板容量的历史 (面板 avail = H-4-11)
  const H = state.terminalHeight;
  const avail = H - 4 - 11;
  state.history = [];
  for (let i = 0; i < avail + 30; i++) {
    state.history.push(`历史行 ${String(i).padStart(3, '0')}`);
  }
  state.historyScroll = 0;

  // 初始贴底: 渲染应包含最后一行
  out = '';
  tui.__test.render();
  check('贴底时显示最新行', out.includes(`历史行 ${String(avail + 29).padStart(3, '0')}`));
  check('贴底时不显示最旧行', !out.includes(`历史行 000`));

  // 向上滚 5 行
  tui.__test.scrollHistory(5);
  check('historyScroll=5', state.historyScroll === 5);
  out = '';
  tui.__test.render();
  // start = total-avail-5 = 25, 视口为 [25, 25+avail-1], 共 avail 行不溢出
  check('上滚后显示更早的行 (视口首行 025)', out.includes('历史行 025'));
  check('上滚后最新行移出视野', !out.includes(`历史行 ${String(avail + 29).padStart(3, '0')}`));
  check('上滚后不渲染超过面板容量', !out.includes(`历史行 ${String(avail + 24).padStart(3, '0')}`) === false);
  check('上滚提示显示', out.includes('已上滚 5 行'));

  // 滚到顶: 夹紧
  tui.__test.scrollHistory(1000);
  check('滚到顶时夹紧到 maxScroll', state.historyScroll === 30);
  out = '';
  tui.__test.render();
  check('顶部时显示第一行', out.includes('历史行 000'));
  check('顶部时滑块在轨道顶部', out.includes('█'));

  // 向下回底
  tui.__test.scrollHistory(-1000);
  check('下滚夹紧回 0 (贴底)', state.historyScroll === 0);
  out = '';
  tui.__test.render();
  check('回底后显示最新行', out.includes(`历史行 ${String(avail + 29).padStart(3, '0')}`));

  // ---- 4. 滚动条渲染 ----
  out = '';
  tui.__test.scrollHistory(10);
  check('可滚动时绘制滚动条轨道 │', out.includes('│'));
  check('滚动条滑块 █ 渲染', out.includes('█'));

  // ---- 5. PgUp/PgDn 经 handleKey ----
  state.historyScroll = 0;
  await tui.__test.handleKeyPublic('', { name: 'pageup', ctrl: false, meta: false });
  check('PgUp 上滚 10 行', state.historyScroll === 10);
  await tui.__test.handleKeyPublic('', { name: 'pagedown', ctrl: false, meta: false });
  check('PgDn 下滚 10 行', state.historyScroll === 0);
  await tui.__test.handleKeyPublic('', { name: 'pagedown', ctrl: false, meta: false });
  check('PgDn 在底部不变成负数', state.historyScroll === 0);

  // ---- 6. 历史不足一屏时不可滚动 ----
  state.history = ['只有一行'];
  state.historyScroll = 0;
  tui.__test.scrollHistory(5);
  check('内容不足一屏时保持 0', state.historyScroll === 0);

  // ---- 7. logUserTurn 重置滚动 (提交新回合回底) ----
  state.history = [];
  for (let i = 0; i < avail + 10; i++) state.history.push(`行${i}`);
  tui.__test.scrollHistory(8);
  check('已上滚 8 行', state.historyScroll === 8);
  tui.__test.logUserTurn('新一轮问题');
  check('新回合提交后回底 (historyScroll=0)', state.historyScroll === 0);

  // ---- 8. 会话切换时 historyScroll 持久化 ----
  state.historyScroll = 4;
  // 模拟 serialize/restore (通过 switchSession 需要 sessions 结构, 直接验证字段在 SESSION_FIELDS)
  const src = fs.readFileSync(path.join(__dirname, 'scripts', 'tui.js'), 'utf-8');
  check('historyScroll 在 SESSION_FIELDS 中', /SESSION_FIELDS = \[[\s\S]*?'historyScroll'/.test(src));

  // ---- 汇总 ----
  const pass = results.filter(r => r[1]).length;
  console.error(`\n══ 结果: ${pass}/${results.length} 通过 ══`);
  process.stdout.write = origWrite;
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => {
  process.stdout.write = origWrite;
  console.error('TEST ERROR:', e);
  process.exit(1);
});
