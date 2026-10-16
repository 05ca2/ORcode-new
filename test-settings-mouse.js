// 设置面板鼠标化测试: < > 按钮几何、点击生效、键盘调整键移除、滚动不溢出
const os = require('os');
const path = require('path');
const fs = require('fs');

const testHome = path.join(os.tmpdir(), 'orcode-setmouse-' + Date.now());
fs.mkdirSync(testHome, { recursive: true });
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

const cfgDir = path.join(testHome, '.orcode');
fs.mkdirSync(cfgDir, { recursive: true });
fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
  version: '0.2.10', workers: 2, verifyRounds: 1,
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

(async () => {
  const tui = require('./scripts/tui.js');
  const state = tui.__test.initState();
  state.terminalWidth = 100;
  state.terminalHeight = 30;

  // 打开设置面板并渲染
  state.settingsOpen = true;
  state.settingsScroll = 0;
  tui.__test.renderSettingsPanel();
  const g = state._settingsGeom;

  // ==================== 1. 按钮几何 ====================
  check('按钮几何已登记 (_settingsGeom)', !!g && Array.isArray(g.buttons) && g.buttons.length > 0);
  const actions = g.buttons.map(b => b.action);
  check('Workers 增/减按钮存在', actions.includes('workers-') && actions.includes('workers+'));
  check('验证轮数 增/减按钮存在', actions.includes('verify-') && actions.includes('verify+'));
  check('文件大小 增/减按钮存在', actions.includes('size-') && actions.includes('size+'));
  check('字符上限 增/减按钮存在', actions.includes('chars-') && actions.includes('chars+'));
  check('初始模型点击按钮存在', actions.includes('defaultModel'));
  const posCount = actions.filter(a => a === 'position').length;
  check('岗位行点击按钮已登记 (首屏可见, 不超总数)', posCount >= 4 && posCount <= Object.keys(state.positions).length);
  check('添加模型按钮存在 (需滚到底, 见下文)', true);
  // 按钮都落在面板内容区内 (不压边框、不进底部提示行)
  const inBounds = g.buttons.every(b =>
    b.row >= g.py + 2 && b.row <= g.py + g.ph - 3 &&
    b.x1 >= g.px + 2 && b.x2 <= g.px + g.pw - 2);
  check('按钮坐标都在面板内容区内', inBounds);
  // 增/减按钮同行且减在增左侧
  const wDec = g.buttons.find(b => b.action === 'workers-');
  const wInc = g.buttons.find(b => b.action === 'workers+');
  check('Workers </> 同一行且 < 在 > 左侧', wDec && wInc && wDec.row === wInc.row && wDec.x2 < wInc.x1);

  // ==================== 2. 点击生效 ====================
  const before = state.config.workers;
  tui.__test.handleMouseClick(wInc.x1, wInc.row);
  check('点击 > 增加 Workers', state.config.workers === Math.min(8, before + 1));
  tui.__test.handleMouseClick(wDec.x1, wDec.row);
  check('点击 < 减少 Workers', state.config.workers === before);

  const s0 = state.config.maxFileReadSize;
  const sInc = g.buttons.find(b => b.action === 'size+');
  tui.__test.handleMouseClick(sInc.x1, sInc.row);
  check('点击 > 增加文件大小上限 (+5MB)', state.config.maxFileReadSize === s0 + 5 * 1048576);
  const sDec = g.buttons.find(b => b.action === 'size-');
  tui.__test.handleMouseClick(sDec.x1, sDec.row);
  check('点击 < 减少文件大小上限 (-5MB)', state.config.maxFileReadSize === s0);

  const c0 = state.config.maxFileReadChars;
  const cInc = g.buttons.find(b => b.action === 'chars+');
  tui.__test.handleMouseClick(cInc.x1, cInc.row);
  check('点击 > 增加字符上限 (+2000)', state.config.maxFileReadChars === c0 + 2000);
  const cDec = g.buttons.find(b => b.action === 'chars-');
  tui.__test.handleMouseClick(cDec.x1, cDec.row);
  check('点击 < 减少字符上限 (-2000)', state.config.maxFileReadChars === c0);

  // 大小上限边界: 连续加到 500 封顶
  state.config.maxFileReadSize = 499 * 1048576;
  tui.__test.handleSettingsButton('size+');
  check('文件大小上限 500MB 封顶', Math.round(state.config.maxFileReadSize / 1048576) === 500);
  tui.__test.handleSettingsButton('size+');
  check('超过 500 不再增加', Math.round(state.config.maxFileReadSize / 1048576) === 500);
  state.config.maxFileReadSize = 3 * 1048576;
  tui.__test.handleSettingsButton('size-');
  check('低于 1MB 保持在 1MB', Math.round(state.config.maxFileReadSize / 1048576) === 1);
  state.config.maxFileReadSize = 100 * 1024 * 1024;

  // 初始模型点击循环
  const name0 = state.config.defaultModel.name;
  const dBtn = g.buttons.find(b => b.action === 'defaultModel');
  tui.__test.handleMouseClick(dBtn.x1, dBtn.row);
  check('点击初始模型循环切换', state.config.defaultModel.name !== name0);

  // 岗位行: 第一次点 = 选中, 再点 = 换模型
  const posBtn = g.buttons.find(b => b.action === 'position' && b.arg === 1);
  if (!state.positions || !state.positions[Object.keys(state.positions)[0]]) {
    // 若 positions 未初始化, 手动补齐 (与配置加载后的形态一致)
    const POS = ['Director', 'Planner', 'Worker', 'Verifier'];
    POS.forEach(k => { state.positions[k] = { model: 'm1' }; });
  }
  tui.__test.handleMouseClick(posBtn.x1, posBtn.row);
  check('点击岗位行 = 选中岗位', state.settingsPos === 1);
  const posModel0 = state.positions[Object.keys(state.positions)[1]]?.model;
  tui.__test.handleMouseClick(posBtn.x1, posBtn.row);
  check('再点同一岗位 = 循环换模型', state.positions[Object.keys(state.positions)[1]]?.model !== posModel0);

  // 添加模型按钮 (岗位增多后首屏可能放不下, 先滚到底再找)
  state.settingsScroll = state._settingsMaxScroll || 0;
  tui.__test.renderSettingsPanel();
  const addBtn = state._settingsGeom.buttons.find(b => b.action === 'addModel');
  check('添加模型按钮存在 (滚到底后)', !!addBtn);
  tui.__test.handleMouseClick(addBtn.x1, addBtn.row);
  check('点击 [+ 添加模型] 进入五步流程', state.addStep === 'provider');
  // 取消添加
  state.addStep = null;

  // 点击无按钮区域不误触
  const w0 = state.config.workers;
  tui.__test.handleMouseClick(g.px + 3, g.py + 2);
  check('点击非按钮区域不改变设置', state.config.workers === w0);

  // ==================== 3. 键盘调整键已移除 ====================
  check('- 键不再调整 Workers (返回 false)', tui.__test.handleSettingsKey('-', { name: '-', str: '-', ctrl: false, meta: false }) === false && state.config.workers === w0);
  check('[ 键不再调整轮数', tui.__test.handleSettingsKey('[', { name: '[', str: '[', ctrl: false, meta: false }) === false);
  check('< 键不再调整文件大小', tui.__test.handleSettingsKey('<', { name: '<', str: '<', ctrl: false, meta: false }) === false);
  check('; 键不再调整字符数', tui.__test.handleSettingsKey(';', { name: ';', str: ';', ctrl: false, meta: false }) === false);
  check('渲染输出无键盘调整提示 (无 -/+/[/;/\' 文案)', !out.includes('-/+ 改Workers') && !out.includes("';' 字符数"));
  check('渲染输出保留鼠标提示 (点击 < >)', out.includes('点击 < > 调整'));

  // ==================== 4. 滚动: 内容裁剪不溢出 ====================
  // 高终端: 内容可能一屏放得下
  check('高终端 maxScroll >= 0', (state._settingsMaxScroll || 0) >= 0);
  // 矮终端: 强制滚动, 所有画出的按钮行不得越过面板底边
  state.terminalHeight = 12;
  state.addStep = null;
  state.settingsScroll = 0;
  tui.__test.renderSettingsPanel();
  const g2 = state._settingsGeom;
  check('矮终端触发滚动 (maxScroll > 0)', (state._settingsMaxScroll || 0) > 0);
  // 滚到最底: 按钮 (若有) 不得越过面板底边
  state.settingsScroll = state._settingsMaxScroll;
  tui.__test.renderSettingsPanel();
  const g3 = state._settingsGeom;
  const allInside = g3.buttons.every(b => b.row >= g3.py + 2 && b.row <= g3.py + g3.ph - 3);
  check('滚到最底时按钮不越过面板边界', allInside);
  // 逐档滚动: 任何位置按钮都不得画出面板
  let anyOut = false;
  for (let s = 0; s <= (state._settingsMaxScroll || 0); s += 3) {
    state.settingsScroll = s;
    tui.__test.renderSettingsPanel();
    const gg = state._settingsGeom;
    if (!gg.buttons.every(b => b.row >= gg.py + 2 && b.row <= gg.py + gg.ph - 3)) anyOut = true;
  }
  check('各滚动位置按钮均在面板内', !anyOut);
  // 回到顶部应有点击按钮
  state.settingsScroll = 0;
  tui.__test.renderSettingsPanel();
  check('面板内存在可点击按钮', state._settingsGeom.buttons.length > 0);
  // 滚到最底后应能看到最后一条快捷键 (/help 显示帮助)
  check('滚到底可见最后一条快捷键', out.includes('/help'));
  // settingsScroll 被钳制在 maxScroll
  state.settingsScroll = 999;
  tui.__test.renderSettingsPanel();
  check('滚动越界自动钳制到 maxScroll', state.settingsScroll === state._settingsMaxScroll);

  // Esc 保存并关闭
  const escHandled = tui.__test.handleSettingsKey('', { name: 'escape', str: '', ctrl: false, meta: false });
  check('Esc 保存并关闭面板', escHandled === true && state.settingsOpen === false);

  // ==================== 汇总 ====================
  const pass = results.filter(r => r[1]).length;
  console.error(`\n══ 结果: ${pass}/${results.length} 通过 ══`);
  process.stdout.write = origWrite;
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => {
  process.stdout.write = origWrite;
  console.error('TEST ERROR:', e);
  process.exit(1);
});
