// 权限系统测试: 隔离 HOME + mock stdout, 验证权限申请面板流程
const os = require('os');
const path = require('path');
const fs = require('fs');

// 隔离 HOME (避免动真实 ~/.orcode)
const testHome = path.join(os.tmpdir(), 'orcode-perm-test-' + Date.now());
fs.mkdirSync(testHome, { recursive: true });
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

// 预置一个已初始化的配置, 跳过初始化遮罩
const cfgDir = path.join(testHome, '.orcode');
fs.mkdirSync(cfgDir, { recursive: true });
fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
  version: '0.2.2', workers: 2, verifyRounds: 1,
  defaultModel: { name: 'test-model', provider: 'test' },
  models: [{ name: 'test-model', provider: 'test', baseUrl: 'http://x', modelId: 'm1', displayName: 'Test' }],
  positions: {}, workspaceDir: testHome, defaultWorkspaceDir: testHome,
  initialized: true, pathPermissions: {}, apiKeys: {}
}, null, 2));

// 收集输出
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

  // 1. 初始状态: 权限对象存在, 默认拒绝
  check('permissions 对象已初始化', state.permissions && typeof state.permissions === 'object');
  check('默认策略为 denied', state.permissions.default === 'denied');
  check('初始无待处理申请', state.permissionRequest === null);

  // 2. 工作区内路径 → full
  const insidePath = path.join(testHome, 'src', 'app.js');
  // getPermission 未导出, 通过 checkPathPermission 行为间接验证
  const okInside = await tui.__test.checkPathPermission(insidePath, 'write');
  check('工作区内 write 直接放行', okInside === true);

  // 3. 工作区外路径 → 触发申请
  const outsidePath = path.join(os.tmpdir(), 'orcode-perm-outside-' + Date.now());
  let resolveResult = null;
  const permPromise = tui.__test.checkPathPermission(outsidePath, 'write', '测试跨区写入');
  check('工作区外访问触发申请面板', state.permissionRequest !== null);
  check('申请路径正确', state.permissionRequest && state.permissionRequest.path === path.resolve(outsidePath));
  check('申请动作为 write', state.permissionRequest && state.permissionRequest.action === 'write');
  check('面板已渲染 (含"权限申请")', out.includes('权限申请'));

  // 4. 拒绝 (N)
  out = '';
  await tui.__test.handlePermissionKey('n', { name: 'n', ctrl: false, meta: false });
  resolveResult = await permPromise;
  check('N 拒绝后 resolve(false)', resolveResult === false);
  check('N 拒绝后面板关闭', state.permissionRequest === null);
  check('N 拒绝后无持久化授权', !state.permissions[path.resolve(outsidePath)]);

  // 5. 同意 (Y) → 持久化
  const p2 = tui.__test.checkPathPermission(outsidePath, 'read', '测试跨区读取');
  check('read 也触发申请 (未授权过)', state.permissionRequest !== null);
  await tui.__test.handlePermissionKey('y', { name: 'y', ctrl: false, meta: false });
  const r2 = await p2;
  check('Y 同意后 resolve(true)', r2 === true);
  check('Y 同意后持久化到配置', state.config.pathPermissions[path.resolve(outsidePath)] === 'read');

  // 6. 已授权路径再次访问 → 直接放行 (无面板)
  const r3 = await tui.__test.checkPathPermission(outsidePath, 'read');
  check('已授权路径 read 直接放行', r3 === true && state.permissionRequest === null);

  // 7. 已授权 read 路径请求 write → 需升级, 弹面板
  const p4 = tui.__test.checkPathPermission(outsidePath, 'write', '需要写权限');
  check('read 权限请求 write 时弹升级面板', state.permissionRequest !== null);
  await tui.__test.handlePermissionKey('e', { name: 'e', ctrl: false, meta: false });
  const r4 = await p4;
  check('E 仅本次授权 resolve(true)', r4 === true);
  check('E 不修改持久化配置', state.config.pathPermissions[path.resolve(outsidePath)] === 'read');

  // 8. Esc = 拒绝
  const p5 = tui.__test.checkPathPermission(outsidePath + '-x', 'execute');
  check('execute 触发申请', state.permissionRequest !== null);
  await tui.__test.handlePermissionKey('', { name: 'escape', ctrl: false, meta: false });
  const r5 = await p5;
  check('Esc 拒绝 resolve(false)', r5 === false);

  // 9. 面板打开时其它键被拦截 (不泄漏)
  const p6 = tui.__test.checkPathPermission(outsidePath + '-y', 'read');
  const before = state.currentInput;
  await tui.__test.handlePermissionKey('a', { name: 'a', ctrl: false, meta: false });
  check('面板打开时普通键不泄漏到输入框', state.currentInput === before);
  await tui.__test.handlePermissionKey('n', { name: 'n', ctrl: false, meta: false });
  await p6;

  // 10. /perm 列表渲染
  out = '';
  tui.__test.showPermissionList();
  check('/perm 显示工作区 full', out.includes('完整权限'));
  // 注意: 面板宽 65 列, 长路径会被 truncateAnsi 截断, 故检查路径前缀
  check('/perm 显示已授权路径', out.includes('orcode-perm-outside'));

  // 11. handleKey 中权限面板最高优先级
  const p7 = tui.__test.checkPathPermission(outsidePath + '-z', 'read');
  await tui.__test.handleKeyPublic('x', { name: 'x', ctrl: false, meta: false });
  check('handleKey 拦截面板打开时的输入', state.permissionRequest !== null && state.currentInput === before);
  await tui.__test.handlePermissionKey('N', { name: 'N', ctrl: false, meta: false });
  await p7;

  // 汇总
  const pass = results.filter(r => r[1]).length;
  console.error(`\n══ 结果: ${pass}/${results.length} 通过 ══`);
  process.stdout.write = origWrite;
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => {
  process.stdout.write = origWrite;
  console.error('TEST ERROR:', e);
  process.exit(1);
});
