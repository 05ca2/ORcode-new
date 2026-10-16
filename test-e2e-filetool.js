// 端到端: 模型通过 READ 工具块读取工作区内文件, 结果回传后给出最终答案
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const testHome = path.join(os.tmpdir(), 'orcode-e2e-file-' + Date.now());
const workspace = path.join(testHome, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

const cfgDir = path.join(testHome, '.orcode');
fs.mkdirSync(cfgDir, { recursive: true });
fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
  version: '0.2.7', workers: 2, verifyRounds: 1,
  defaultModel: { name: 'MockModel', provider: 'mock' },
  models: [{ name: 'MockModel', provider: 'mock', baseUrl: 'http://127.0.0.1:18924/v1', modelId: 'mock-1', displayName: 'MockModel' }],
  positions: { director: { name: 'MockModel', provider: 'mock', baseUrl: 'http://127.0.0.1:18924/v1', modelId: 'mock-1' } },
  workspaceDir: workspace, defaultWorkspaceDir: workspace,
  initialized: true, pathPermissions: {}, apiKeys: { mock: 'test-key' }
}, null, 2));

// 工作区内放一个文件
fs.writeFileSync(path.join(workspace, 'geography.txt'), 'Unit 6: Changing Population\n关键词: 人口增长、城市化、人口迁移', 'utf-8');

const results = [];
function check(name, cond) {
  results.push([name, !!cond]);
  console.error(`${cond ? '✓' : '✗'} ${name}`);
}

// mock 服务: 第一轮回复 READ 工具块; 第二轮基于回传的文件内容作答
let callCount = 0;
const prompts = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    callCount++;
    let prompt = '';
    try {
      const obj = JSON.parse(body);
      prompt = (obj.messages || []).map(m => m.content).join('\n');
    } catch (e) { /* ignore */ }
    prompts.push(prompt);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    let content;
    if (callCount === 1) {
      // 第一轮: 模型发起读取请求
      content = '好的，我先读取目录里的资料。\n<<<READ {"path":"geography.txt","reason":"查看用户的地理学习资料"} READ>>>';
    } else {
      // 第二轮: 基于文件结果作答
      content = prompt.includes('Unit 6: Changing Population')
        ? '已读取资料：Unit 6 Changing Population，涵盖人口增长、城市化、人口迁移三个关键词。总结如下：……'
        : '我没有拿到文件内容。';
    }
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
  });
});

server.listen(18924, '127.0.0.1', async () => {
  process.stdout.write = (c) => true;
  const tui = require('./scripts/tui.js');
  const state = tui.__test.initState();
  const K = (name, extra = {}) => Object.assign({ name, ctrl: false, meta: false }, extra);

  try {
    // 用户输入 (模拟截图场景: "ppt在这个目录里，你自己查看")
    tui.__test.setInput('');
    const input = 'geography.txt在这个目录里，你自己查看';
    for (const ch of input) await tui.__test.handleKeyPublic(ch, K(ch));
    await tui.__test.handleKeyPublic('', K('return'));
    // 等待两轮模型调用 + 文件执行完成
    await new Promise(r => setTimeout(r, 1500));

    check('共发生 2 次模型调用 (读文件→作答)', callCount === 2);
    check('第一轮 prompt 教了文件工具协议', prompts[0] && prompts[0].includes('[工具]') && prompts[0].includes('READ') && prompts[0].includes('SEARCH'));
    check('第二轮 prompt 含文件结果回传', prompts[1] && prompts[1].includes('[文件结果·文件内容]') && prompts[1].includes('Unit 6: Changing Population'));
    check('文件结果指向工作区内真实路径', prompts[1] && prompts[1].includes(path.join(workspace, 'geography.txt')));

    // 界面历史体现执行痕迹
    const hist = state.history.map(h => (typeof h === 'object' ? h.text : h)).join('\n');
    check('历史含 📖 已读取文件 日志', hist.includes('📖 已读取文件'));
    check('最终答复基于文件内容', hist.includes('Unit 6 Changing Population') && hist.includes('人口增长'));
    check('工具标记不出现在历史', !hist.includes('<<<READ'));

    // 权限: 工作区内读取全程无面板
    check('工作区内读取未弹权限面板', state.permissionRequest === null);
  } catch (e) {
    console.error('E2E ERROR:', e);
    results.push(['无异常', false]);
  } finally {
    server.close();
    const pass = results.filter(r => r[1]).length;
    console.error(`\n══ E2E 结果: ${pass}/${results.length} 通过 ══`);
    process.exit(pass === results.length ? 0 : 1);
  }
});
