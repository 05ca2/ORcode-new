// 光标完整性 + 模型记忆系统测试: 隔离 HOME + mock stdout
const os = require('os');
const path = require('path');
const fs = require('fs');

const testHome = path.join(os.tmpdir(), 'orcode-cursor-mem-' + Date.now());
fs.mkdirSync(testHome, { recursive: true });
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

const cfgDir = path.join(testHome, '.orcode');
fs.mkdirSync(cfgDir, { recursive: true });
fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
  version: '0.2.4', workers: 2, verifyRounds: 1,
  defaultModel: { name: 'test-model', provider: 'test' },
  models: [{ name: 'test-model', provider: 'test', baseUrl: 'http://x', modelId: 'm1', displayName: 'Test' }],
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

  // ==================== 第一部分: 光标完整性 ====================

  // 1. 输入时光标自动跟随到末端 (核心 bug 修复)
  tui.__test.setInput('');
  await tui.__test.handleKeyPublic('h', K('h'));
  check('输入 h 后光标=1', state.cursorPosition === 1);
  await tui.__test.handleKeyPublic('i', K('i'));
  check('输入 hi 后光标=2 (跟随末端)', state.cursorPosition === 2);
  check('输入内容正确', state.currentInput === 'hi');

  // 2. 光标在中间时输入 → 插入到光标处, 光标后移
  tui.__test.setInput('hello');
  state.cursorPosition = 2;                 // 光标在 he|llo 之间
  await tui.__test.handleKeyPublic('X', K('X'));
  check('中间插入字符正确', state.currentInput === 'heXllo');
  check('插入后光标=3', state.cursorPosition === 3);

  // 3. 退格删除光标前字符 (之前卡住的根因)
  await tui.__test.handleKeyPublic('', K('backspace'));
  check('退格删除光标前字符', state.currentInput === 'hello');
  check('退格后光标=2', state.cursorPosition === 2);

  // 4. 退格在光标=0 时不误删
  tui.__test.setInput('abc');
  state.cursorPosition = 0;
  await tui.__test.handleKeyPublic('', K('backspace'));
  check('光标在顶端时退格不删内容', state.currentInput === 'abc');

  // 5. 左右箭头移动光标
  state.cursorPosition = 1;
  await tui.__test.handleKeyPublic('', K('left'));
  check('左箭头光标-1', state.cursorPosition === 0);
  await tui.__test.handleKeyPublic('', K('left'));
  check('左箭头到底不越界', state.cursorPosition === 0);
  await tui.__test.handleKeyPublic('', K('right'));
  check('右箭头光标+1', state.cursorPosition === 1);
  await tui.__test.handleKeyPublic('', K('right'));
  await tui.__test.handleKeyPublic('', K('right'));
  await tui.__test.handleKeyPublic('', K('right'));
  check('右箭头到顶不越界', state.cursorPosition === 3);

  // 6. Esc 清空输入时光标归零
  state.cursorPosition = 2;
  await tui.__test.handleKeyPublic('', K('escape'));
  check('Esc 清空输入', state.currentInput === '');
  check('Esc 后光标归零', state.cursorPosition === 0);

  // 7. 清空后立即可正常输入 (不卡住)
  await tui.__test.handleKeyPublic('a', K('a'));
  await tui.__test.handleKeyPublic('b', K('b'));
  check('清空后输入正常', state.currentInput === 'ab' && state.cursorPosition === 2);

  // 8. clampCursor 兜底: 越位光标被夹紧
  state.currentInput = 'xy';
  state.cursorPosition = 99;
  tui.__test.clampCursor();
  check('越位光标被夹紧到长度', state.cursorPosition === 2);
  state.cursorPosition = -5;
  tui.__test.clampCursor();
  check('负光标被夹紧到 0', state.cursorPosition === 0);

  // 9. setInput 光标落末端
  tui.__test.setInput('hello world');
  check('setInput 光标=长度', state.cursorPosition === 11);

  // 10. 渲染中光标位置正确 (cursorX = 4 + 显示宽度)
  tui.__test.setInput('abc');
  state.cursorPosition = 1;
  out = '';
  tui.__test.render();
  // ANSI: 光标绘制序列 \x1b[<row>;<col>H 后面跟 █; col 应为 4+1=5
  const cursorSeq = out.match(/\x1b\[(\d+);(\d+)H\x1b\[38;5;252m█/);
  check('渲染光标列 = 4+显示宽度 (纯 ASCII)', cursorSeq && parseInt(cursorSeq[2], 10) === 5);

  // 10b. 含中文时光标按显示宽度算列 (每个宽字符 +1 列) — "卡在前一个"的修复验证
  // 字符串: 中文abc测试 → 显示宽 2+2+1+1+1+2+2 = 11 列, 共 8 字符
  tui.__test.setInput('中文abc测试');
  state.cursorPosition = state.currentInput.length;   // 光标在末尾
  out = '';
  tui.__test.render();
  const wideSeq = out.match(/\x1b\[(\d+);(\d+)H\x1b\[38;5;252m█/);
  // 光标列 = 4 + 11 = 15 (若按字符数算会得 12, 光标卡在前几个字符身上)
  check('含中文时光标列=4+显示宽度(15)', wideSeq && parseInt(wideSeq[2], 10) === 15);

  // 10c. 中文中间位置: 光标在前 2 字符 (中文) 之后 → 显示宽 4 → 列 8
  state.cursorPosition = 2;
  out = '';
  tui.__test.render();
  const midSeq = out.match(/\x1b\[(\d+);(\d+)H\x1b\[38;5;252m█/);
  check('中文中间光标列=4+4=8', midSeq && parseInt(midSeq[2], 10) === 8);

  // 10d. 鼠标点击: 宽字符输入按显示宽度反推索引
  // '中文abc测试' 显示区间: 中[0,2) 文[2,4) a[4,5) b[5,6) c[6,7) 测[7,9) 试[9,11)
  // 输入区从列 4 开始 → 列 = 4 + 偏移
  check('点击列 4 (输入起点) → 索引 0', tui.__test.colToCursorIndex(4, 4) === 0);
  check('点击列 5 (中右半) → 索引 0', tui.__test.colToCursorIndex(5, 4) === 0);
  check('点击列 6 (文左半) → 索引 1', tui.__test.colToCursorIndex(6, 4) === 1);
  check('点击列 7 (文右半) → 索引 1', tui.__test.colToCursorIndex(7, 4) === 1);
  check('点击列 8 (a 处) → 索引 2', tui.__test.colToCursorIndex(8, 4) === 2);
  check('点击列 9 (b 处) → 索引 3', tui.__test.colToCursorIndex(9, 4) === 3);
  check('点击列 10 (c 处) → 索引 4', tui.__test.colToCursorIndex(10, 4) === 4);
  check('点击列 11 (测左半) → 索引 5', tui.__test.colToCursorIndex(11, 4) === 5);
  check('点击列 12 (测右半) → 索引 5', tui.__test.colToCursorIndex(12, 4) === 5);
  check('点击列 13 (试左半) → 索引 6', tui.__test.colToCursorIndex(13, 4) === 6);
  check('点击列 14 (试右半) → 索引 6', tui.__test.colToCursorIndex(14, 4) === 6);
  check('点击列 15 (文本末尾) → 索引 7', tui.__test.colToCursorIndex(15, 4) === 7);
  check('点击超出文本 → 末尾索引 7', tui.__test.colToCursorIndex(999, 4) === 7);
  check('点击提示符区域 (列 3) → 0', tui.__test.colToCursorIndex(3, 4) === 0);

  // 11. 中文输入 (多 code point) 光标正确后移
  tui.__test.setInput('');
  await tui.__test.handleKeyPublic('中', K('中'));
  check('中文字符光标=1', state.cursorPosition === 1 && state.currentInput === '中');

  // 12. ctrl+p 打开命令面板时光标在 '/' 后
  await tui.__test.handleKeyPublic('', K('p', { ctrl: true }));
  check('ctrl+p 输入为 /', state.currentInput === '/');
  check('ctrl+p 光标=1', state.cursorPosition === 1);
  // 面板激活时继续输入字符
  await tui.__test.handleKeyPublic('h', K('h'));
  check('命令面板续接输入', state.currentInput === '/h' && state.cursorPosition === 2);
  await tui.__test.handleKeyPublic('', K('escape'));

  // ==================== 第二部分: 模型记忆系统 ====================

  // 13. 手动添加记忆
  const m1 = tui.__test.addMemory('用户是九年级国际学校学生', ['背景'], 'manual');
  check('addMemory 返回条目', m1 && m1.id && m1.content === '用户是九年级国际学校学生');
  const list1 = tui.__test.loadMemory();
  check('记忆已持久化到列表', list1.some(m => m.id === m1.id));

  // 14. 磁盘落盘验证
  const disk = JSON.parse(fs.readFileSync(path.join(cfgDir, 'memory.json'), 'utf-8'));
  check('memory.json 已写入磁盘', Array.isArray(disk) && disk.some(m => m.id === m1.id));

  // 15. 关键词检索
  tui.__test.addMemory('用户喜欢荧光粉色主题', ['偏好']);
  const found = tui.__test.searchMemories('荧光粉', 5);
  check('关键词检索命中', found.some(m => m.content.includes('荧光粉')));
  const miss = tui.__test.searchMemories('不存在的关键词xyz', 5);
  check('无命中时返回最近记忆 (不为空)', miss.length > 0);

  // 16. extractMemories: 解析模型记忆块
  const resp = '好的, 我会记住。\n<<<MEMORY\n{"content":"项目使用 Node 22","tags":["技术栈"]}\nMEMORY>>>\n还有其他问题吗?';
  const { cleaned, memories } = tui.__test.extractMemories(resp);
  check('extractMemories 解析出 1 条', memories.length === 1 && memories[0].content === '项目使用 Node 22');
  check('extractMemories 清除标记块', !cleaned.includes('MEMORY') && cleaned.includes('好的'));

  // 17. extractMemories: 多条 + 非法块忽略
  const resp2 = 'A<<<MEMORY\n{"content":"事实一"}\nMEMORY>>>B<<<MEMORY\n{"content":"事实二"}\nMEMORY>>>C<<<MEMORY\nnot json\nMEMORY>>>';
  const r2 = tui.__test.extractMemories(resp2);
  check('多条记忆解析', r2.memories.length === 2);
  check('非法记忆块被忽略并清除', !r2.cleaned.includes('not json'));

  // 18. removeMemory: 按 id 和关键词
  const before = tui.__test.loadMemory().length;
  const delById = tui.__test.removeMemory(m1.id);
  check('按 id 删除 1 条', delById === 1 && tui.__test.loadMemory().length === before - 1);
  const delByKw = tui.__test.removeMemory('荧光粉');
  check('按关键词删除', delByKw >= 1 && !tui.__test.loadMemory().some(m => m.content.includes('荧光粉')));

  // 19. buildModelContext: 包含环境/最近对话/记忆
  tui.__test.setInput('');
  state.history = [];
  tui.__test.logUserTurn('帮我配置 deepseek');
  tui.__test.addMemory('用户偏好中文回答', ['偏好']);
  const ctx = tui.__test.buildModelContext('帮我配置 deepseek');
  check('上下文含工作区环境', ctx.includes('[环境]') && ctx.includes(state.workspaceDir));
  check('上下文含最近对话', ctx.includes('[最近对话]') && ctx.includes('帮我配置 deepseek'));
  check('上下文含记忆', ctx.includes('[你的记忆]') && ctx.includes('用户偏好中文回答'));

  // 20. 上下文随记忆增长 (相关性)
  const ctx2 = tui.__test.buildModelContext('中文');
  check('相关记忆排前 (含偏好)', ctx2.includes('用户偏好中文回答'));

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
