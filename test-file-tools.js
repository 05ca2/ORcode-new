// 模型文件工具测试: READ/LIST 解析、真实执行、权限集成
const os = require('os');
const path = require('path');
const fs = require('fs');

const testHome = path.join(os.tmpdir(), 'orcode-filetool-' + Date.now());
const workspace = path.join(testHome, 'workspace');
const outside = path.join(testHome, 'outside');
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

const cfgDir = path.join(testHome, '.orcode');
fs.mkdirSync(cfgDir, { recursive: true });
fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
  version: '0.2.7', workers: 2, verifyRounds: 1,
  defaultModel: { name: 'test-model', provider: 'test' },
  models: [{ name: 'test-model', provider: 'test', baseUrl: 'http://x', modelId: 'm1', displayName: 'Test' }],
  positions: {}, workspaceDir: workspace, defaultWorkspaceDir: workspace,
  initialized: true, pathPermissions: {}, apiKeys: {}
}, null, 2));

// 测试文件
fs.writeFileSync(path.join(workspace, 'notes.txt'), '第一行\n第二行\n第三行', 'utf-8');
fs.writeFileSync(path.join(workspace, 'big.txt'), 'x'.repeat(5000), 'utf-8');       // 5000 字符 (小于默认 20000, 不截断)
fs.writeFileSync(path.join(workspace, 'huge.txt'), 'y'.repeat(25000), 'utf-8');     // 25000 字符 (超默认, 截断)
fs.writeFileSync(path.join(workspace, 'mid.bin'), 'z'.repeat(2 * 1024 * 1024), 'utf-8'); // 2MB (远低于新 100MB 限)
// 真实二进制文件 (含 NUL 字节) — 应被识别为二进制而拒绝
const binBuf = Buffer.alloc(2048); binBuf[0] = 0x00; binBuf[100] = 0xFF; binBuf[1023] = 0x00;
fs.writeFileSync(path.join(workspace, 'real.bin'), binBuf);
// 5MB 纯文本 — 验证部分读取 (只加载前 ~80KB, 不整体载入内存)
fs.writeFileSync(path.join(workspace, 'large.txt'), 'a'.repeat(5 * 1024 * 1024), 'utf-8');
fs.mkdirSync(path.join(workspace, 'sub'), { recursive: true });
fs.writeFileSync(path.join(workspace, 'sub', 'a.md'), '# 标题', 'utf-8');
fs.writeFileSync(path.join(outside, 'secret.txt'), '机密内容', 'utf-8');

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

  // ==================== 1. resolveModelPath ====================
  check('相对路径基于工作区', tui.__test.resolveModelPath('notes.txt') === path.join(workspace, 'notes.txt'));
  check('相对子目录路径', tui.__test.resolveModelPath('sub/a.md') === path.join(workspace, 'sub', 'a.md'));
  check('绝对路径原样规范化', tui.__test.resolveModelPath(outside + '/secret.txt') === path.join(outside, 'secret.txt'));
  check('~ 展开为 HOME', tui.__test.resolveModelPath('~') === testHome);
  check('~/x 展开', tui.__test.resolveModelPath('~/x') === path.join(testHome, 'x'));
  check('空路径返回空', tui.__test.resolveModelPath('') === '' && tui.__test.resolveModelPath(null) === '');

  // ==================== 2. extractFileOps ====================
  const r1 = tui.__test.extractFileOps('我先看看文件。\n<<<READ {"path":"notes.txt","reason":"查看笔记"} READ>>>\n然后列目录。\n<<<LIST {"path":"sub"} LIST>>>');
  check('解析出 2 个操作 (read+list)', r1.ops.length === 2 && r1.ops[0].type === 'read' && r1.ops[1].type === 'list');
  check('操作参数正确', r1.ops[0].path === 'notes.txt' && r1.ops[0].reason === '查看笔记');
  check('清除标记块', !r1.cleaned.includes('READ') && !r1.cleaned.includes('LIST') && r1.cleaned.includes('我先看看文件'));

  const r2 = tui.__test.extractFileOps('无工具调用');
  check('无工具块时 ops 为空', r2.ops.length === 0 && r2.cleaned === '无工具调用');

  const r3 = tui.__test.extractFileOps('<<<READ not json READ>>>');
  check('非法 JSON 被忽略', r3.ops.length === 0);

  const r4 = tui.__test.extractFileOps('<<<READ {"path":"a.txt"} READ>>><<<READ {"path":"b.txt"} READ>>>');
  check('多个 READ 都解析', r4.ops.length === 2);

  // ==================== 3. executeFileOps — 工作区内直接放行 ====================
  const res1 = await tui.__test.executeFileOps([{ type: 'read', path: 'notes.txt', reason: '测试' }]);
  check('工作区内读取无需权限面板', state.permissionRequest === null);
  check('读取内容正确', res1[0].ok && res1[0].content === '第一行\n第二行\n第三行');
  check('resolved 路径正确', res1[0].resolved === path.join(workspace, 'notes.txt'));

  const res2 = await tui.__test.executeFileOps([{ type: 'list', path: 'sub', reason: '测试' }]);
  check('列目录成功', res2[0].ok && res2[0].content.includes('[文件] a.md'));

  const res3 = await tui.__test.executeFileOps([{ type: 'read', path: 'sub', reason: '测试' }]);
  check('读目录报错并提示用 LIST', !res3[0].ok && res3[0].error.includes('LIST'));

  const res4 = await tui.__test.executeFileOps([{ type: 'read', path: 'not-exist.txt', reason: '测试' }]);
  check('读不存在文件报错', !res4[0].ok && res4[0].error.length > 0);

  const res5 = await tui.__test.executeFileOps([{ type: 'read', path: 'big.txt', reason: '测试' }]);
  check('5000 字符文件完整读取 (默认 20000 上限)', res5[0].ok && res5[0].content.length === 5000 && res5[0].truncated === false);

  const res5b = await tui.__test.executeFileOps([{ type: 'read', path: 'huge.txt', reason: '测试' }]);
  check('25000 字符文件截断到 20000', res5b[0].ok && res5b[0].content.length === 20000 && res5b[0].truncated === true);

  const res5c = await tui.__test.executeFileOps([{ type: 'read', path: 'mid.bin', reason: '测试' }]);
  check('2MB 文件可读 (上限已提高到 100MB)', res5c[0].ok);

  // 二进制文件应被识别并拒绝 (含 NUL 字节)
  const resBin = await tui.__test.executeFileOps([{ type: 'read', path: 'real.bin', reason: '测试' }]);
  check('二进制文件被识别并拒绝', !resBin[0].ok && resBin[0].error.includes('二进制'));

  // 大文件部分读取: 5MB 文本, 默认字符上限 20000 → 只读前 ~80KB 并截断
  const resLarge = await tui.__test.executeFileOps([{ type: 'read', path: 'large.txt', reason: '测试' }]);
  check('大文件部分读取 (仅加载前段, 不整体载入)', resLarge[0].ok && resLarge[0].truncated === true && resLarge[0].content.length === 20000);

  // ==================== 3b. 上限可配置 ====================
  check('默认大小上限 100MB', tui.__test.getMaxReadSize() === 100 * 1024 * 1024);
  check('默认字符上限 20000', tui.__test.getMaxReadChars() === 20000);

  // 调小上限 → 2MB 文件被拒
  state.config.maxFileReadSize = 1 * 1024 * 1024;
  const res5d = await tui.__test.executeFileOps([{ type: 'read', path: 'mid.bin', reason: '测试' }]);
  check('调小上限后 2MB 文件被拒', !res5d[0].ok && res5d[0].error.includes('文件过大'));
  state.config.maxFileReadSize = 100 * 1024 * 1024;

  // 调小字符上限 → 截断到设定值
  state.config.maxFileReadChars = 1000;
  const res5e = await tui.__test.executeFileOps([{ type: 'read', path: 'big.txt', reason: '测试' }]);
  check('调小字符上限后按新值截断', res5e[0].ok && res5e[0].content.length === 1000 && res5e[0].truncated === true);
  state.config.maxFileReadChars = 20000;

  // 非法配置值回退默认
  state.config.maxFileReadSize = -5;
  state.config.maxFileReadChars = 'abc';
  check('非法配置回退默认 100MB', tui.__test.getMaxReadSize() === 100 * 1024 * 1024);
  check('非法配置回退默认 20000', tui.__test.getMaxReadChars() === 20000);
  state.config.maxFileReadSize = 100 * 1024 * 1024;
  state.config.maxFileReadChars = 20000;

  // ==================== 4. executeFileOps — 工作区外需权限 ====================
  let denied = null;
  const p1 = tui.__test.executeFileOps([{ type: 'read', path: outside + '/secret.txt', reason: '测试跨区读' }]);
  check('工作区外读取触发权限面板', state.permissionRequest !== null);
  check('面板路径为区外文件', state.permissionRequest && state.permissionRequest.path === path.join(outside, 'secret.txt'));

  // 拒绝 → 错误回传
  await tui.__test.handlePermissionKey('n', K('n'));
  denied = await p1;
  check('拒绝后返回失败结果', !denied[0].ok && denied[0].error.includes('拒绝'));

  // 同意 → 读取成功并持久化
  const p2 = tui.__test.executeFileOps([{ type: 'read', path: outside + '/secret.txt', reason: '测试跨区读' }]);
  check('再次请求仍弹面板 (未授权)', state.permissionRequest !== null);
  await tui.__test.handlePermissionKey('y', K('y'));
  const granted = await p2;
  check('Y 同意后读取成功', granted[0].ok && granted[0].content === '机密内容');
  check('授权已持久化', state.config.pathPermissions[path.join(outside, 'secret.txt')] === 'read');

  // 已授权 → 直接放行无面板
  const res6 = await tui.__test.executeFileOps([{ type: 'read', path: outside + '/secret.txt', reason: '再次读' }]);
  check('已授权路径无面板直接读', state.permissionRequest === null && res6[0].ok);

  // ==================== 5. 空路径 ====================
  const res7 = await tui.__test.executeFileOps([{ type: 'read', path: '', reason: '' }]);
  check('空路径返回错误不崩溃', !res7[0].ok && res7[0].error.includes('路径为空'));

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
