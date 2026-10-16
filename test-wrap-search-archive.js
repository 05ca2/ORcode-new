// v0.2.11 测试: 自适应换行 / 联网搜索解析 / 存档功能
const os = require('os');
const path = require('path');
const fs = require('fs');

const testHome = path.join(os.tmpdir(), 'orcode-v0211-' + Date.now());
const workspace = path.join(testHome, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

const cfgDir = path.join(testHome, '.orcode');
fs.mkdirSync(cfgDir, { recursive: true });
fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
  version: '0.2.11', workers: 2, verifyRounds: 1,
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

(async () => {
  const tui = require('./scripts/tui.js');
  const T = tui.__test;
  const state = T.initState();

  // ==================== 1. wrapText 自适应换行 ====================
  const w = T.wrapText;
  check('短行不折', w('hello', 40).length === 1 && w('hello', 40)[0] === 'hello');
  check('窄宽度兜底 (width<8 不折)', w('a'.repeat(50), 4).length === 1);

  const long = 'a'.repeat(30) + ' ' + 'b'.repeat(30);
  const wrapped = w(long, 32);
  check('长 ASCII 行折成多行', wrapped.length >= 2);
  check('每行不超过宽度', wrapped.every(l => l.length <= 32));
  check('续行跳过行首空格', wrapped[1][0] !== ' ');

  const cjk = '中'.repeat(20);   // 每个字 2 列 → 40 列
  const cw = w(cjk, 12);
  check('中文按显示宽度折行 (2列/字)', cw.length === 4 && cw.slice(0, 3).every(l => l.length === 6) && cw[3].length === 2);

  const mixed = '路径D:\\Claw\\学习\\School\\German\\German_Conjugation_Tables.md 文件内容说明很长很长很长很长很长';
  const mw = w(mixed, 30);
  check('中英混排折行', mw.length >= 2 && mw.every(l => {
    // 手动校验显示宽度 ≤ 30
    let wd = 0;
    for (const ch of l) wd += ch.codePointAt(0) > 0x1100 && /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
    return wd <= 30;
  }));

  const ansi = '\x1b[31m' + 'r'.repeat(25) + '\x1b[0m more text here to force wrap';
  const aw = w(ansi, 20);
  check('ANSI 色码保留且不计宽度', aw.length >= 2 && aw[0].startsWith('\x1b[31m') && aw.join('').includes('\x1b[0m'));

  // ==================== 2. state.log 自动换行入历史 ====================
  state.terminalWidth = 90;   // wrapW = 90 - 30 - 5 = 55
  state.history = [];
  const longLine = 'D:\\Claw\\学习\\School\\German\\October-Holiday-HW-2026\\核心资料\\变更记录.md ' + 'x'.repeat(80);
  state.log(longLine, '\x1b[36m');
  const logLines = state.history.filter(h => typeof h === 'object' && h.text);
  check('log() 长行折为多条历史', logLines.length >= 2);
  check('log() 每条都带颜色', logLines.every(h => h.color === '\x1b[36m'));
  check('log() 内容不丢 (拼接后包含全文)', logLines.map(h => h.text).join(' ').replace(/ {2}/g, ' ').includes('变更记录.md'));

  state.log('短行不折');
  check('log() 短行原样入历史', state.history.some(h => (typeof h === 'object' ? h.text : h) === '短行不折'));

  // 历史上限 600
  for (let i = 0; i < 700; i++) state.log('行' + i);
  check('历史上限 600 生效', state.history.length <= 600);

  // ==================== 3. SEARCH 工具解析 ====================
  const { cleaned, ops } = T.extractFileOps(
    '先看文件 <<<READ {"path":"a.txt","reason":"r1"} READ>>> 再搜索 <<<SEARCH {"query":"德国德语变位表","reason":"查资料"} SEARCH>>> 完成'
  );
  check('SEARCH 块被解析', ops.some(o => o.type === 'search' && o.query === '德国德语变位表'));
  check('READ 与 SEARCH 共存', ops.length === 2 && ops[0].type === 'read');
  check('SEARCH 块从正文清除', !cleaned.includes('<<<SEARCH') && !cleaned.includes('SEARCH>>>') && cleaned.includes('先看文件'));

  const bad = T.extractFileOps('<<<SEARCH not-json SEARCH>>>');
  check('非法 JSON 的 SEARCH 被忽略', bad.ops.length === 0 && !bad.cleaned.includes('<<<SEARCH'));

  // ==================== 4. parseSearchResults (DuckDuckGo HTML) ====================
  const sampleHtml = `
  <html><body><table>
  <tr><td><a rel="nofollow" class="result-link" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://example.com/german-tables')}&rut=abc">German%20Conjugation%20Tables%20&amp;%20Charts</a></td></tr>
  <tr><td class="result-snippet">完整的 <b>德语动词变位</b> 表格, 含现在时/过去时 &amp; 虚拟式</td></tr>
  <tr><td><a rel="nofollow" href="https://deutsch.lingolia.com/zh/conjugation" class="result-link">德语动词变位 - Lingolia</a></td></tr>
  <tr><td class="result-snippet">在线练习德语变位</td></tr>
  <tr><td><a class="result-link" href="https://example.com/german-tables">重复标题应去重</a></td></tr>
  </table></body></html>`;
  const rs = T.parseSearchResults(sampleHtml, 8);
  check('解析出 2 条结果 (重复 URL 去重)', rs.length === 2);
  check('uddg 跳转链接还原真实地址', rs[0].url === 'https://example.com/german-tables');
  check('HTML 实体解码 (&amp;)', rs[0].title.includes('&'));
  check('标签剥离 (<b>)', rs[0].snippet.includes('德语动词变位') && !rs[0].snippet.includes('<b>'));
  check('snippet 与链接按序对应', rs[1].snippet === '在线练习德语变位');
  check('limit 截断生效', T.parseSearchResults(sampleHtml, 1).length === 1);
  check('空 HTML 返回空数组', T.parseSearchResults('<html></html>').length === 0);

  // webSearch 无网络时的错误处理 (沙箱无外网, 期待 reject 而非 crash)
  let searchErr = null;
  try { await T.webSearch('test query for orcode'); } catch (e) { searchErr = e; }
  check('webSearch 失败时抛错不 crash (沙箱无外网)', searchErr !== null);

  // ==================== 5. 存档功能 ====================
  state.history = [];
  state.log('▸ 你: 帮我整理德语变位表', '\x1b[36m');
  state.history.push({ separator: true, color: '\x1b[2m' });
  state.log('已读取文件: D:\\Claw\\学习\\变位规则.md (3522 字节)', '\x1b[36m');
  const file = T.writeArchiveFile();
  check('存档文件生成于工作区', file.startsWith(workspace) && fs.existsSync(file));
  const content = fs.readFileSync(file, 'utf-8');
  check('存档含会话头信息', content.includes('# ORcode 会话存档') && content.includes('## 对话记录'));
  check('存档含用户输入行', content.includes('▸ 你: 帮我整理德语变位表'));
  check('存档分割线转为 ---', content.includes('\n---\n'));
  check('存档含系统日志行', content.includes('已读取文件: D:\\Claw\\学习\\变位规则.md'));

  // /archives 列表
  out = '';
  T.listArchives();
  check('/archives 输出存档列表', out.includes('会话存档') && out.includes(path.basename(file)));

  // closeSession 自动存档
  state.history = [];
  state.log('▸ 你: 自动存档测试对话');
  state.sessions.push({ id: 's2', title: '会话 2', snapshot: null });
  state.activeIndex = 0;
  T.closeSession(0);
  const archives = fs.readdirSync(workspace).filter(f => /^orcode-archive-.*\.md$/.test(f));
  check('关闭会话自动存档落盘', archives.length >= 2);
  const autoContent = fs.readFileSync(path.join(workspace, archives.sort().reverse()[0]), 'utf-8');
  check('自动存档包含对话内容', autoContent.includes('▸ 你: 自动存档测试对话'));
  check('关闭后回到保留会话', state.sessions.length >= 1);

  // 无对话内容的会话关闭不产生新存档
  const before = fs.readdirSync(workspace).filter(f => /^orcode-archive-/.test(f)).length;
  state.history = [];
  state.sessions.push({ id: 's3', title: '会话 3', snapshot: null });
  T.closeSession(state.activeIndex);
  const after = fs.readdirSync(workspace).filter(f => /^orcode-archive-/.test(f)).length;
  check('无对话会话关闭不生成空存档', after === before);

  process.stdout.write = origWrite;
  const pass = results.filter(r => r[1]).length;
  console.log(`\n==== wrap/search/archive 测试: ${pass}/${results.length} 通过 ====`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => {
  process.stdout.write = origWrite;
  console.error('测试异常:', e);
  process.exit(1);
});
