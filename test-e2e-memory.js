// 端到端集成: mock OpenAI 兼容服务, 验证上下文注入 + 记忆自动保存 + 光标流程
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const testHome = path.join(os.tmpdir(), 'orcode-e2e-' + Date.now());
fs.mkdirSync(testHome, { recursive: true });
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

const cfgDir = path.join(testHome, '.orcode');
fs.mkdirSync(cfgDir, { recursive: true });
fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
  version: '0.2.4', workers: 2, verifyRounds: 1,
  defaultModel: { name: 'MockModel', provider: 'mock' },
  models: [{ name: 'MockModel', provider: 'mock', baseUrl: 'http://127.0.0.1:18923/v1', modelId: 'mock-1', displayName: 'MockModel' }],
  positions: { director: { name: 'MockModel', provider: 'mock', baseUrl: 'http://127.0.0.1:18923/v1', modelId: 'mock-1' } },
  workspaceDir: testHome, defaultWorkspaceDir: testHome,
  initialized: true, pathPermissions: {}, apiKeys: { mock: 'test-key' }
}, null, 2));

const results = [];
function check(name, cond) {
  results.push([name, !!cond]);
  console.error(`${cond ? '✓' : '✗'} ${name}`);
}

// mock 服务: 第一轮返回带 MEMORY 块的回复; 记录收到的 prompt 供断言
let lastPrompt = '';
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    try {
      const obj = JSON.parse(body);
      lastPrompt = (obj.messages || []).map(m => m.content).join('\n');
    } catch (e) { /* ignore */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '收到, 我会记住这个偏好。\n<<<MEMORY\n{"content":"用户喜欢简洁的回答","tags":["偏好"]}\nMEMORY>>>\n还有什么可以帮你?' } }]
    }));
  });
});

server.listen(18923, '127.0.0.1', async () => {
  process.stdout.write = (c) => true;   // 静默 TUI 输出
  const tui = require('./scripts/tui.js');
  const state = tui.__test.initState();
  const K = (name, extra = {}) => Object.assign({ name, ctrl: false, meta: false }, extra);

  try {
    // 预置一条历史对话 + 一条记忆, 供上下文断言
    state.history = [];
    tui.__test.logUserTurn('之前的问题: 介绍下你自己');
    tui.__test.addMemory('用户是九年级学生', ['背景']);

    // 模拟用户输入并回车 (单模型调用)
    tui.__test.setInput('');
    for (const ch of '我喜欢简洁的回答') {
      await tui.__test.handleKeyPublic(ch, K(ch));
    }
    check('输入后光标跟随末端', state.cursorPosition === '我喜欢简洁的回答'.length);
    await tui.__test.handleKeyPublic('', K('return'));
    // 等待异步调用完成 (mock 服务立即返回, 给事件循环留时间)
    await new Promise(r => setTimeout(r, 800));

    // 1. 上下文注入验证
    check('prompt 包含工作区环境', lastPrompt.includes('[环境]') && lastPrompt.includes(testHome));
    check('prompt 包含最近对话 (可翻阅)', lastPrompt.includes('[最近对话]') && lastPrompt.includes('之前的问题'));
    check('prompt 包含记忆 (可调用)', lastPrompt.includes('[你的记忆]') && lastPrompt.includes('九年级学生'));

    // 2. 记忆自动保存验证
    const mems = tui.__test.loadMemory();
    check('模型回复中的 MEMORY 块已自动保存', mems.some(m => m.content === '用户喜欢简洁的回答' && m.source === 'model'));

    // 3. 回复中 MEMORY 标记不泄漏到界面历史
    const histText = state.history.map(h => (typeof h === 'object' ? h.text : h)).join('\n');
    check('MEMORY 标记不出现在历史', !histText.includes('<<<MEMORY'));
    check('🧠 已记住 日志出现', histText.includes('🧠 已记住'));

    // 4. 光标在调用结束后重置
    check('提交后输入清空且光标归零', state.currentInput === '' && state.cursorPosition === 0);
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
