// ORcode - 交互式 TUI 界面 (暗色低调风格)
// 布局: 左上像素 ORCODE 标识 | 左主区域 | 粉色分割线 | 右工作树 | 底部输入框 + 状态栏
// 规则: 多模型工作流必须输入 /hor-loop 启动; 普通文字不会触发
// 功能: / 实时指令面板 (↑↓选择) | 右下角⚙可点击打开设置 | 设置中可添加模型

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { callModelSafe } = require('./start.js');
const { dbManager } = require('./database-manager.js');

// 获取系统路径
const homePath = process.env.HOME || process.env.USERPROFILE || __dirname;
const configDir = path.join(homePath, '.orcode');
const configPath = path.join(configDir, 'config.json');

// 默认配置 (不预置任何假模型, 由用户添加真实模型)
const defaultConfig = {
  version: '0.2.12',
  workers: 2,
  verifyRounds: 1,
  defaultModel: null,
  models: [],
  positions: {},
  workspaceDir: homePath,
  defaultWorkspaceDir: null,   // 初始化时填写的默认工作区 (新会话继承此值)
  initialized: false,          // 是否已初始化 (orcode init 后变为 true)
  pathPermissions: {},         // 持久化的路径授权: { 绝对路径: 'full' | 'read' | 'denied' }
  maxFileReadSize: 100 * 1024 * 1024,  // 模型读取文件的字节上限 (默认 100MB, 可调 1-500MB)
  maxFileReadChars: 20000,            // 单次回传给模型的字符上限 (默认 20000)
  apiKeys: {}
};

// 加载配置
function loadConfig() {
  if (!fs.existsSync(configPath)) {
    return defaultConfig;
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    // 兼容旧配置: 补齐字段 (不再注入假模型)
    if (!cfg.models) cfg.models = [];
    if (!cfg.positions) cfg.positions = {};
    if (!cfg.apiKeys) cfg.apiKeys = {};
    if (!cfg.pathPermissions) cfg.pathPermissions = {};
    if (typeof cfg.maxFileReadSize !== 'number' || cfg.maxFileReadSize <= 0) cfg.maxFileReadSize = defaultConfig.maxFileReadSize;
    if (typeof cfg.maxFileReadChars !== 'number' || cfg.maxFileReadChars <= 0) cfg.maxFileReadChars = defaultConfig.maxFileReadChars;
    if (!cfg.defaultWorkspaceDir) cfg.defaultWorkspaceDir = cfg.workspaceDir || null;
    if (typeof cfg.initialized !== 'boolean') cfg.initialized = false;
    if (!cfg.defaultModel) {
      cfg.defaultModel = cfg.models.length > 0
        ? { name: cfg.models[0].name, provider: cfg.models[0].provider }
        : null;
    }
    return cfg;
  } catch (e) {
    return defaultConfig;
  }
}

// 保存配置
function saveConfig(cfg) {
  try {
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    return true;
  } catch (e) {
    return false;
  }
}

// ============ 低调暗色配色 ============
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  reverse: '\x1b[7m',
  text: '\x1b[38;5;252m',        // 亮灰白 (主文字)
  sub: '\x1b[38;5;245m',         // 中灰 (次要文字)
  faint: '\x1b[38;5;240m',       // 暗灰 (弱提示)
  accent: '\x1b[38;5;117m',      // 淡蓝 (选中/箭头)
  green: '\x1b[38;5;108m',       // 灰绿 (完成)
  yellow: '\x1b[38;5;179m',      // 暗黄 (思考)
  red: '\x1b[38;5;174m',         // 暗红 (错误)
  pink: '\x1b[38;5;175m',        // 藕粉 (最终输出)
  pinkBright: '\x1b[38;5;218m',  // 亮粉 (分割线/齿轮)
  cyan: '\x1b[38;5;115m',        // 青灰
  logoGray: '\x1b[38;5;245m',    // logo 前三字母 (灰)
  logoBlue: '\x1b[38;5;17m',     // logo 后三字母 (蓝黑)
  border: '\x1b[38;5;238m',      // 边框灰
};

// ============ 像素 ORCODE 标识 (5x5 点阵) ============
const PIXEL_FONT = {
  O: [' ███ ', '█   █', '█   █', '█   █', ' ███ '],
  R: ['████ ', '█   █', '████ ', '█  █ ', '█   █'],  // 带斜腿
  C: [' ████', '█    ', '█    ', '█    ', ' ████'],
  D: ['████ ', '█   █', '█   █', '█   █', '████ '],
  E: ['█████', '█    ', '████ ', '█    ', '█████']
};

function renderPixelLogo() {
  const lines = ['', '', '', '', ''];
  const letters = 'ORCODE'.split('');
  for (let li = 0; li < letters.length; li++) {
    const glyph = PIXEL_FONT[letters[li]] || PIXEL_FONT.O;
    for (let i = 0; i < 5; i++) {
      lines[i] += glyph[i] + ' ';
    }
  }
  // 前三字母 (ORC) 灰色, 后三字母 (ODE) 蓝黑色
  const grayLen = 3 * 6; // 每字母占 6 列 (5 点 + 1 空格)
  return lines.map(line =>
    `${c.logoGray}${line.slice(0, grayLen)}${c.reset}${c.logoBlue}${line.slice(grayLen)}${c.reset}`
  );
}

// ============ 岗位定义 ============
const POSITIONS = [
  { key: 'director', label: '指挥 Director', desc: '拆解任务、分派岗位' },
  { key: 'planner', label: '规划 Planner', desc: '制定顺序执行计划' },
  { key: 'worker', label: '执行 Workers', desc: '多岗位并发协作执行' },
  { key: 'verifier', label: '检验 Verifier', desc: '核查结果并驱动修复' }
];

// ============ 指令面板命令 ============
const GUIDE_COMMANDS = [
  ['/hor-loop', 'Start HOR-loop multi-model workflow'],
  ['/agents', 'Switch agent'],
  ['/connect', 'Connect provider'],
  ['/debug', 'View debug info'],
  ['/diff', 'Open diff viewer'],
  ['/editor', 'Open editor'],
  ['/exit', 'Exit the app'],
  ['/help', 'Help'],
  ['/mcps', 'Toggle MCPs'],
  ['/models', 'Switch model'],
  ['/move', 'Move to another project dir'],
  ['/cd', 'Change workspace dir (per session)'],
  ['/settings', 'Settings'],
  ['/add-model', 'Add a model'],
  ['/ask', 'Demo: agent asks a questionnaire'],
  ['/history', 'View session history'],
  ['/init', 'Initialize ORcode (required first run)'],
  ['/new', 'Open a new session tab'],
  ['/close', 'Close current session tab'],
  ['/archive', 'Save current session transcript to file'],
  ['/archives', 'List saved session archives'],
  ['/search', 'Web search (DuckDuckGo)'],
  ['/perm', 'View and manage path permissions'],
  ['/readlimit', 'View or set file read limits (MB)'],
  ['/remember', 'Save a fact to long-term memory'],
  ['/memory', 'List saved memories'],
  ['/forget', 'Delete memories by id or keyword'],
  ['/context', 'Preview context sent to the model'],
  ['/run', 'Run task (alias of /hor-loop)']
];

// ============ TUI 状态 ============
class TUIState {
  constructor() {
    this.config = loadConfig();
    this.positions = {};
    this.history = [];
    this.currentInput = '';
    this.cursorPosition = 0; // 光标位置 (字符索引)
    this.selectedIndex = 0;
    this.guideIndex = 0;
    this.guideScroll = 0;          // 指令小窗口滚动偏移 (可见首行的 filtered 索引)
    this._guideGeom = null;        // 指令小窗口几何信息 (鼠标悬停/点击/滚轮用)
    this.settingsOpen = false;
    this.settingsPos = 0;
    this.settingsScroll = 0; // 设置面板内滚动偏移
    // 添加模型五步流程: provider → baseUrl → apiKey → modelId → displayName → afterAdd
    this.addStep = null;
    this.addDraft = { provider: '', baseUrl: '', apiKey: '', modelId: '', displayName: '' };
    this.waitingForTask = false;   // /hor-loop 后等待任务输入
    this.modelsOpen = false;       // /models 模型选择面板
    this.modelsIndex = 0;          // 面板内扁平选中索引
    this.modelsFilter = '';        // 面板内搜索过滤词
    this._modelsGeom = null;       // 面板几何信息 (鼠标悬停/点击用)
    this.questionnaire = null;     // 智能体提问问卷: null | {title,questions,qIndex,optIndex,selections}
    this.questionnaireResolve = null; // 问卷 Promise 的 resolve (用户提交/跳过时调用)
    this._qGeom = null;           // 问卷面板几何信息 (鼠标用)
    this.subSession = null;        // 岗位子会话: null | positionKey
    this.subSessionLog = [];       // 子会话内的对话记录
    this.running = false;
    this.activePos = null;         // 工作树实时动态: 当前正在执行的岗位 key
    this.sessionId = null;
    this.tokens = 0;
    this.terminalWidth = process.stdout.columns || 100;
    this.terminalHeight = process.stdout.rows || 30;

    // 每会话独立工作区 (从默认工作区继承)
    this.workspaceDir = this.config.defaultWorkspaceDir || this.config.workspaceDir || homePath;

    // 多会话 (浏览器式标签): sessions 保存各会话快照, activeIndex 为当前
    this.sessions = [{ id: crypto.randomUUID().slice(0, 8), title: '会话 1', snapshot: null }];
    this.activeIndex = 0;
    this._tabsGeom = null;        // 标签栏几何信息 (鼠标点击用)

    // 初始化门禁: 未初始化时 TUI 显示遮罩, 必须先 orcode init
    this.needsInit = !this.config.initialized;
    this.initMode = false;         // 内联初始化进行中
    this.pathMode = null;          // 'workspace' = 正在输入路径以切换工作区

    // 权限管理: 工作区内 full, 跨工作区需申请
    // permissions: { [绝对路径]: 'full' | 'read' | 'write' | 'denied', default: 'denied' }
    this.permissions = Object.assign({}, this.config.pathPermissions || {}, { default: 'denied' });
    this.permissionRequest = null;  // 待确认的权限申请: {path, action, reason, resolve}
    this._permGeom = null;         // 权限面板几何信息 (鼠标用)

    // 对话历史滚动: 0 = 跟随底部 (最新); >0 = 向上翻看的行数
    this.historyScroll = 0;

    POSITIONS.forEach(p => {
      this.positions[p.key] = {
        ...p,
        status: 'idle',
        model: this.config.positions[p.key]?.name || '-',
        thought: [],
        output: null
      };
    });

    // 枚举构造不需要自动序列化, 改为在 startTUI 中完成
  }

  get guideActive() {
    return this.currentInput.startsWith('/') && !this.settingsOpen && !this.addStep && !this.subSession;
  }

  filteredCommands() {
    const q = this.currentInput.slice(1).toLowerCase();
    if (!q) return GUIDE_COMMANDS;
    return GUIDE_COMMANDS.filter(([cmd]) => cmd.slice(1).toLowerCase().startsWith(q));
  }

  updatePosition(key, updates) {
    if (this.positions[key]) Object.assign(this.positions[key], updates);
  }

  addThought(key, text) {
    if (this.positions[key]) {
      this.positions[key].thought.push(text);
      if (this.positions[key].thought.length > 3) {
        this.positions[key].thought.shift();
      }
    }
  }

  log(text, color) {
    // color 可选: 显式指定渲染颜色 (否则按关键词自动着色)
    // 自适应换行: 按左侧历史面板可用宽度折行, 长行 (长路径/长答复) 不再被截断丢失
    const W = this.terminalWidth || 100;
    const treeW = Math.max(30, Math.floor(W * 0.34));
    const wrapW = Math.max(20, W - treeW - 5);   // 与渲染区 mainW-4 对齐
    const wrapped = wrapText(text, wrapW);
    for (const ln of wrapped) {
      this.history.push(color ? { text: ln, color } : ln);
    }
    if (this.history.length > 600) this.history.splice(0, this.history.length - 600);
  }
}

// ============ 多会话 (浏览器式标签) 管理 ============
// 每会话独立的状态字段 — 切换时整体序列化/恢复
const SESSION_FIELDS = [
  'workspaceDir', 'history', 'currentInput', 'cursorPosition', 'selectedIndex',
  'subSession', 'subSessionLog', 'running', 'activePos',
  'sessionId', 'tokens', 'positions', 'permissions', 'historyScroll'
];

function expandPath(p) {
  if (!p) return '';
  if (p === '~') return homePath;
  if (p.startsWith('~/')) return path.join(homePath, p.slice(2));
  return path.resolve(p);
}

// ============ 输入框辅助 (光标安全) ============
// 统一设置输入内容: 光标默认落到末端 (程序化赋值用)
function setInput(text) {
  state.currentInput = String(text);
  state.cursorPosition = state.currentInput.length;
  if (state.cursorPosition < 0) state.cursorPosition = 0;
}

// 在光标处插入字符 (主输入模式), 光标随之后移
function insertAtCursor(str) {
  if (!str) return;
  const p = Math.max(0, Math.min(state.cursorPosition, state.currentInput.length));
  state.currentInput = state.currentInput.slice(0, p) + str + state.currentInput.slice(p);
  state.cursorPosition = p + str.length;
}

// 渲染前兜底: 光标夹紧到合法范围 (防止任何路径越界)
function clampCursor() {
  if (state.cursorPosition < 0) state.cursorPosition = 0;
  if (state.cursorPosition > state.currentInput.length) state.cursorPosition = state.currentInput.length;
}

// ---------- 显示宽度感知的光标定位 ----------
// 光标之前文本的显示宽度 (中文/全角字符占 2 列, 必须按显示宽度算列号,
// 否则含中文的输入会把光标画到前几个字符身上 — "卡在前一个"的根因)
function cursorDisplayOffset() {
  const before = state.currentInput.slice(0, state.cursorPosition);
  return displayWidth(before);
}

// 鼠标点击列号 → 字符索引 (按显示宽度反推)
function colToCursorIndex(col, inputStartCol) {
  const s = state.currentInput;
  const target = col - inputStartCol;   // 点击处在输入区内的显示偏移
  if (target <= 0) return 0;
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const cw = displayWidth(s[i]);
    // 字符 i 占据显示列 [w, w+cw); 点击落在其中 → 光标停到它前面
    if (target < w + cw) return i;
    w += cw;
  }
  return s.length;
}

// 把当前活跃会话的状态写入 sessions[idx].snapshot
function serializeSession(idx) {
  if (!state.sessions[idx]) return;
  const snap = {};
  SESSION_FIELDS.forEach(f => {
    const v = state[f];
    snap[f] = (f === 'positions') ? JSON.parse(JSON.stringify(v)) : v;
  });
  state.sessions[idx].snapshot = snap;
}

// 用 sessions[idx].snapshot 覆盖当前状态 (无快照则重置为全新会话)
function restoreSession(idx) {
  const snap = state.sessions[idx] && state.sessions[idx].snapshot;
  if (!snap) { applyFreshSession(); return; }
  SESSION_FIELDS.forEach(f => {
    state[f] = (f === 'positions') ? JSON.parse(JSON.stringify(snap.positions)) : snap[f];
  });
}

// 重置当前状态为全新会话 (从 config 继承工作区与岗位模型)
function applyFreshSession() {
  state.history = [];
  setInput('');
  state.selectedIndex = 0;
  state.subSession = null;
  state.subSessionLog = [];
  state.running = false;
  state.activePos = null;
  state.sessionId = null;
  state.tokens = 0;
  state.workspaceDir = state.config.defaultWorkspaceDir || state.config.workspaceDir || homePath;
  // 初始化权限系统：从配置加载已授权的路径, 工作区内默认 full
  state.permissions = Object.assign({}, state.config.pathPermissions || {}, { default: 'denied' });
  state.permissionRequest = null;
  state._permGeom = null;
  state.historyScroll = 0;   // 新会话从最新对话开始看
  const positions = {};
  POSITIONS.forEach(p => {
    positions[p.key] = {
      ...p,
      status: 'idle',
      model: state.config.positions[p.key]?.name || '-',
      thought: [],
      output: null
    };
  });
  state.positions = positions;
}

function newSession() {
  if (state.running || state.questionnaire) return;
  serializeSession(state.activeIndex);
  applyFreshSession();
  const title = `会话 ${state.sessions.length + 1}`;
  state.sessions.push({ id: crypto.randomUUID().slice(0, 8), title, snapshot: null });
  state.activeIndex = state.sessions.length - 1;
  state.log(`▸ 新建${title} · 工作区: ${state.workspaceDir}`);
  render();
}

function switchSession(idx) {
  if (idx === state.activeIndex) return;
  if (idx < 0 || idx >= state.sessions.length) return;
  if (state.running || state.questionnaire) return;  // 运行中禁止切换
  serializeSession(state.activeIndex);
  state.activeIndex = idx;
  restoreSession(idx);
  state.log(`▸ 切换到 ${state.sessions[idx].title}`);
  render();
}

function closeSession(idx) {
  // 调试日志
  console.error('[DEBUG] closeSession 调用:', {
    idx,
    activeIndex: state.activeIndex,
    sessionCount: state.sessions.length,
    running: state.running,
    questionnaire: !!state.questionnaire
  });

  if (state.sessions.length <= 1) {
    state.log('◍ 至少要保留一个会话');
    render();
    return;
  }
  if (state.running || state.questionnaire) {
    state.log('◍ 任务进行中，请完成后再关闭会话');
    render();
    return;
  }
  // 自动存档: 关闭当前会话前, 若该会话有真实对话 (用户输入过), 先落盘保存记录
  if (idx === state.activeIndex &&
      state.history.some(h => (typeof h === 'object' ? (h.text || '') : String(h)).startsWith('▸ 你:'))) {
    try {
      const f = writeArchiveFile();
      state.log(`🗄 已自动存档该会话: ${path.basename(f)}`, c.cyan);
    } catch (e) { /* 存档失败不阻塞关闭 */ }
  }
  // 关闭前先把当前 (若正是它) 序列化, 选好邻居
  const neighbor = (idx === state.activeIndex) ? Math.max(0, idx - 1) : state.activeIndex;
  if (idx === state.activeIndex) serializeSession(idx);
  state.sessions.splice(idx, 1);
  if (idx < state.activeIndex) state.activeIndex--;
  state.activeIndex = neighbor;
  restoreSession(state.activeIndex);
  state.log(`▸ 已关闭会话，当前: ${state.sessions[state.activeIndex].title}`);
  render();
}

// ============ 渲染辅助 ============
let state = null;

function clearScreen() {
  process.stdout.write('\x1b[2J\x1b[H');
}

function moveCursor(x, y) {
  process.stdout.write(`\x1b[${y};${x}H`);
}

function displayWidth(str) {
  // eslint-disable-next-line no-control-regex
  const plain = str.replace(/\x1b\[[0-9;]*m/g, '');
  let w = 0;
  for (const ch of plain) {
    w += (ch.codePointAt(0) > 0x1100 && /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch)) ? 2 : 1;
  }
  return w;
}

function truncateAnsi(str, maxWidth) {
  if (displayWidth(str) <= maxWidth) return str;
  let result = '';
  let w = 0;
  let i = 0;
  while (i < str.length) {
    const m = str.slice(i).match(/^\x1b\[[0-9;]*m/);
    if (m) {
      result += m[0];
      i += m[0].length;
      continue;
    }
    const ch = str[i];
    const cw = displayWidth(ch);
    if (w + cw > maxWidth) break;
    result += ch;
    w += cw;
    i++;
  }
  return result + c.reset;
}

// 自适应换行: 按显示宽度把一行文本折成多行 (中英文混排/宽字符安全, 保留 ANSI 色码)
function wrapText(text, width) {
  const s = String(text ?? '');
  if (width < 8 || displayWidth(s) <= width) return [s];
  const chars = Array.from(s);
  const lines = [];
  let cur = '';
  let w = 0;
  let i = 0;
  while (i < chars.length) {
    // ANSI 色码 (ESC [ ... m) 原样保留, 不计宽度
    if (chars[i] === '\x1b' && chars[i + 1] === '[') {
      let j = i + 2;
      while (j < chars.length && /[0-9;]/.test(chars[j])) j++;
      if (chars[j] === 'm') {
        cur += chars.slice(i, j + 1).join('');
        i = j + 1;
        continue;
      }
    }
    const ch = chars[i];
    const cw = displayWidth(ch);
    if (w + cw > width) {
      lines.push(cur);
      cur = '';
      w = 0;
      while (chars[i] === ' ') i++;   // 续行跳过行首空格
      continue;
    }
    cur += ch;
    w += cw;
    i++;
  }
  if (cur || lines.length === 0) lines.push(cur);
  return lines;
}

function write(x, y, text, color) {
  moveCursor(x, y);
  const maxLen = Math.max(0, state.terminalWidth - x);
  const body = color ? `${color}${text}${c.reset}` : text;
  process.stdout.write(truncateAnsi(body, maxLen));
}

function getStatusIcon(status) {
  return { idle: '○', thinking: '◔', working: '●', completed: '✓', error: '✗' }[status] || '○';
}

function getStatusColor(status) {
  return { idle: c.faint, thinking: c.yellow, working: c.accent, completed: c.green, error: c.red }[status] || c.faint;
}

// ============ 权限管理 ============
// 权限级别: 'full' 完整 (读/写/执行) · 'read' 只读 · 'denied' 拒绝
// 规则: 当前工作区目录内默认 full; 工作区外一律 denied, 需用户批准

function normalizePath(p) {
  if (!p) return '';
  if (p === '~') return homePath;
  if (p.startsWith('~/')) return path.join(homePath, p.slice(2));
  return path.resolve(p);
}

// 判断目标路径是否在当前工作区内 (含自身)
function isInsideWorkspace(p) {
  const target = normalizePath(p);
  const ws = normalizePath(state.workspaceDir);
  if (!target || !ws) return false;
  const rel = path.relative(ws, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function getPermission(p) {
  const target = normalizePath(p);
  if (isInsideWorkspace(target)) return 'full';   // 工作区内: 完整权限
  return state.permissions[target] || state.permissions['default'] || 'denied';
}

// 保存单条权限到配置 (持久化, 跨会话生效)
function grantPermission(p, level) {
  const target = normalizePath(p);
  if (!target) return;
  state.permissions[target] = level;
  const cfg = state.config;
  if (!cfg.pathPermissions) cfg.pathPermissions = {};
  cfg.pathPermissions[target] = level;
  saveConfig(cfg);
}

// 弹出权限申请面板 (Y=同意 · N=拒绝 · E=本次授权/仅这次)
function requestPermission(p, action = 'read', reason = '') {
  const target = normalizePath(p);
  return new Promise(resolve => {
    state.permissionRequest = {
      path: target,
      action,             // read | write | execute
      reason,
      resolve
    };
    state.log(`⚠ 权限申请 · ${target} (${action === 'write' ? '写入' : action === 'execute' ? '执行' : '读取'})`, c.yellow);
    render();
  });
}

// 用户在面板中确认后调用
function resolvePermissionRequest(choice) {
  const req = state.permissionRequest;
  if (!req) return;
  state.permissionRequest = null;
  state._permGeom = null;
  if (choice === 'Y') {
    grantPermission(req.path, req.action === 'read' ? 'read' : 'full');
    state.log(`✓ 已授权: ${req.path} → ${req.action === 'read' ? '只读' : '完整'}`, c.green);
    req.resolve(true);
  } else if (choice === 'E') {
    // 仅本次授权, 不持久化
    state.log(`◐ 本次授权: ${req.path} (仅当前任务有效)`, c.yellow);
    req.resolve(true);
  } else {
    state.log(`✗ 已拒绝: ${req.path}`, c.red);
    req.resolve(false);
  }
  render();
}

// 对外统一入口: 需要访问路径时调用, 工作区内直接放行, 工作区外弹面板
async function checkPathPermission(p, action = 'read', reason = '') {
  const perm = getPermission(p);
  if (perm === 'full' || (perm === 'read' && action === 'read')) return true;
  if (perm === 'denied') {
    return await requestPermission(p, action, reason);
  }
  // perm === 'read' 但请求 write/execute → 需升级授权
  return await requestPermission(p, action, reason || '需要更高权限 (当前: 只读)');
}

// 权限申请面板键盘处理
function handlePermissionKey(str, key) {
  const req = state.permissionRequest;
  if (!req) return false;
  if (key.name === 'escape' || str === 'e' || str === 'E') {
    // E = 仅本次授权; Esc = 拒绝
    if (key.name === 'escape') { resolvePermissionRequest('N'); return true; }
    resolvePermissionRequest('E'); return true;
  }
  if (str === 'y' || str === 'Y') { resolvePermissionRequest('Y'); return true; }
  if (str === 'n' || str === 'N') { resolvePermissionRequest('N'); return true; }
  return true;   // 拦截其它键, 防止泄漏到输入框
}

// 渲染权限申请面板 (居中对话框)
function renderPermissionPanel() {
  const req = state.permissionRequest;
  if (!req) return;
  const W = state.terminalWidth, H = state.terminalHeight;
  const pw = Math.min(60, W - 8);
  const lines = [
    '智能体请求访问工作区之外的路径',
    '',
    `路径:   ${req.path}`,
    `操作:   ${req.action === 'write' ? '写入 (write)' : req.action === 'execute' ? '执行 (execute)' : '读取 (read)'}`,
    `原因:   ${req.reason || '完成任务需要访问该资源'}`,
    '',
    '是否授予权限?',
    '  Y = 同意并记住 (写入配置)',
    '  E = 仅本次授权 (不写入配置)',
    '  N / Esc = 拒绝'
  ];
  const ph = lines.length + 2;
  const px = Math.max(2, Math.floor((W - pw) / 2));
  const py = Math.max(1, Math.floor((H - ph) / 2));

  for (let i = 0; i < ph; i++) { moveCursor(px, py + i); process.stdout.write(' '.repeat(pw)); }
  moveCursor(px, py);
  process.stdout.write(`${c.border}╭─ 权限申请 ${'─'.repeat(Math.max(0, pw - 14))}╮${c.reset}`);
  for (let i = 1; i < ph - 1; i++) {
    moveCursor(px, py + i);
    process.stdout.write(`${c.border}│${c.reset}`);
    moveCursor(px + pw - 1, py + i);
    process.stdout.write(`${c.border}│${c.reset}`);
  }
  lines.forEach((ln, i) => {
    const color = i === 0 ? c.yellow : (ln.startsWith('  Y') ? c.green : ln.startsWith('  N') ? c.red : c.text);
    moveCursor(px + 2, py + 1 + i);
    process.stdout.write(`${color}${truncateAnsi(ln, pw - 4)}${c.reset}`);
  });
  moveCursor(px, py + ph - 1);
  process.stdout.write(`${c.border}╰${'─'.repeat(pw - 2)}╯${c.reset}`);
  state._permGeom = { px, py, pw, ph };
}

// 显示当前权限列表 (/perm)
function showPermissionList() {
  const ws = normalizePath(state.workspaceDir);
  state.log('══ 权限概览 ══', c.accent);
  state.log(`▸ 工作区: ${ws} → 🔓 完整权限 (读/写/执行)`, c.green);
  const entries = Object.entries(state.permissions).filter(([k]) => k !== 'default');
  if (entries.length === 0) {
    state.log('▸ 暂无额外授权的区外路径', c.sub);
  } else {
    entries.forEach(([p, lvl]) => {
      const icon = lvl === 'full' ? '🔓' : lvl === 'read' ? '👁' : '🔒';
      const label = lvl === 'full' ? '完整' : lvl === 'read' ? '只读' : '拒绝';
      state.log(`▸ ${p} → ${icon} ${label}`, lvl === 'denied' ? c.red : c.text);
    });
  }
  state.log('· 默认策略: 工作区外访问需申请 (Y 记住 / E 仅本次 / N 拒绝)', c.faint);
  render();
}

// ============ 对话历史 (翻看 + 分割线) ============
// 每轮用户输入前插入一条分割线, 并把用户输入本身记入历史 (之前只记模型输出)
function logUserTurn(text) {
  state.history.push({ text: '', color: c.border, separator: true });
  state.log(`▸ 你: ${text}`, c.accent);
  state.historyScroll = 0;   // 新回合回到底部, 保证能看到响应
}

// 历史滚动: delta > 0 向上翻 (看更早), < 0 向下 (回近期); 夹紧到 [0, maxScroll]
function scrollHistory(delta) {
  const H = state.terminalHeight;
  const historyTop = 11, historyBottom = H - 4;
  const avail = historyBottom - historyTop;
  const maxScroll = Math.max(0, state.history.length - avail);
  const before = state.historyScroll;
  state.historyScroll = Math.max(0, Math.min(maxScroll, state.historyScroll + delta));
  if (state.historyScroll !== before) render();
}

// ============ 模型记忆系统 ============
// 持久化记忆: ~/.orcode/memory.json — [{id, content, tags, source, createdAt}]
// 模型可通过回复中嵌入 <<<MEMORY {...} MEMORY>>> 块主动记忆; 用户也可 /remember 手动记忆
const memoryPath = path.join(configDir, 'memory.json');

function loadMemory() {
  try {
    if (fs.existsSync(memoryPath)) {
      const list = JSON.parse(fs.readFileSync(memoryPath, 'utf-8'));
      if (Array.isArray(list)) return list;
    }
  } catch (e) { /* 损坏则重置 */ }
  return [];
}

function saveMemoryStore(list) {
  try {
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(memoryPath, JSON.stringify(list.slice(-200), null, 2)); // 最多保留 200 条
    return true;
  } catch (e) { return false; }
}

function addMemory(content, tags = [], source = 'manual') {
  const list = loadMemory();
  const entry = {
    id: 'mem-' + crypto.randomUUID().slice(0, 8),
    content: String(content).slice(0, 500),
    tags: (Array.isArray(tags) ? tags : []).map(String).slice(0, 6),
    source,
    createdAt: new Date().toISOString()
  };
  list.push(entry);
  saveMemoryStore(list);
  return entry;
}

function removeMemory(idOrKeyword) {
  const list = loadMemory();
  const kw = String(idOrKeyword).toLowerCase();
  const kept = list.filter(m => m.id !== idOrKeyword && !m.content.toLowerCase().includes(kw));
  const removed = list.length - kept.length;
  if (removed > 0) saveMemoryStore(kept);
  return removed;
}

// 关键词检索 + 最近记忆 (供上下文注入)
function searchMemories(query, limit = 5) {
  const list = loadMemory();
  if (list.length === 0) return [];
  const kw = String(query || '').toLowerCase();
  const words = kw.split(/\s+/).filter(w => w.length >= 2);
  const scored = list.map((m, idx) => {
    let score = idx; // 基础分: 越新越高 (后面加的)
    const hay = (m.content + ' ' + m.tags.join(' ')).toLowerCase();
    words.forEach(w => { if (hay.includes(w)) score += 10; });
    return { m, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => s.m);
}

// 从模型回复中提取记忆块: <<<MEMORY {"content":"...","tags":[...]} MEMORY>>>
function extractMemories(text) {
  const s = String(text || '');
  const re = /<<<MEMORY([\s\S]*?)MEMORY>>>/g;
  const memories = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    try {
      const obj = JSON.parse(m[1].trim());
      if (obj && obj.content) memories.push({ content: obj.content, tags: obj.tags || [] });
    } catch (e) { /* 非法 JSON 忽略 */ }
  }
  const cleaned = s.replace(/<<<MEMORY[\s\S]*?MEMORY>>>/g, '').trim();
  return { cleaned, memories };
}

// ============ 模型文件工具 (读取/列目录, 权限实时生效) ============
// 模型通过回复中的工具块请求文件访问, TUI 执行并经权限系统把关:
//   <<<READ {"path":"...", "reason":"..."} READ>>>   读取文件 (大小/字符上限可配置)
//   <<<LIST {"path":"...", "reason":"..."} LIST>>>   列出目录 (最多 100 项)

// 文件读取上限 (可在设置面板调整, 持久化到 config)
function getMaxReadSize() {
  const v = state.config.maxFileReadSize;
  return (typeof v === 'number' && v > 0) ? v : 100 * 1024 * 1024;  // 默认 100MB
}
function getMaxReadChars() {
  const v = state.config.maxFileReadChars;
  return (typeof v === 'number' && v > 0) ? v : 20000;               // 默认 20000 字符
}

// 解析模型给的路径: 相对路径基于当前工作区, ~ 基于 HOME
function resolveModelPath(p) {
  if (!p) return '';
  let s = String(p).trim().replace(/^["']+|["']+$/g, '');
  if (!s) return '';
  if (s === '~') return homePath;
  if (s.startsWith('~/')) return path.join(homePath, s.slice(2));
  if (path.isAbsolute(s)) return path.normalize(s);
  return path.resolve(state.workspaceDir || homePath, s);
}

function extractFileOps(text) {
  const s = String(text || '');
  const ops = [];
  let m;
  const readRe = /<<<READ\s*([\s\S]*?)\s*READ>>>/g;
  while ((m = readRe.exec(s)) !== null) {
    try {
      const o = JSON.parse(m[1].trim());
      if (o && o.path) ops.push({ type: 'read', path: String(o.path), reason: String(o.reason || '') });
    } catch (e) { /* 非法 JSON 忽略 */ }
  }
  const listRe = /<<<LIST\s*([\s\S]*?)\s*LIST>>>/g;
  while ((m = listRe.exec(s)) !== null) {
    try {
      const o = JSON.parse(m[1].trim());
      if (o && o.path) ops.push({ type: 'list', path: String(o.path), reason: String(o.reason || '') });
    } catch (e) { /* 非法 JSON 忽略 */ }
  }
  const searchRe = /<<<SEARCH\s*([\s\S]*?)\s*SEARCH>>>/g;
  while ((m = searchRe.exec(s)) !== null) {
    try {
      const o = JSON.parse(m[1].trim());
      if (o && o.query) ops.push({ type: 'search', query: String(o.query), reason: String(o.reason || '') });
    } catch (e) { /* 非法 JSON 忽略 */ }
  }
  const cleaned = s
    .replace(/<<<READ[\s\S]*?READ>>>/g, '')
    .replace(/<<<LIST[\s\S]*?LIST>>>/g, '')
    .replace(/<<<SEARCH[\s\S]*?SEARCH>>>/g, '')
    .trim();
  return { cleaned, ops };
}

// ============ 联网搜索 (DuckDuckGo, 无需 API Key) ============
function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      try { return code > 0 ? String.fromCodePoint(code) : ''; } catch (e) { return ''; }
    });
}

// 解析 DuckDuckGo (lite/html 端点) 搜索结果 HTML → [{title,url,snippet}]
function parseSearchResults(html, limit = 8) {
  const out = [];
  const decodeDdgUrl = (u) => {
    // DDG 常把外链包成 //duckduckgo.com/l/?uddg=<encodeURIComponent(url)>&rut=...
    const m = String(u || '').match(/[?&]uddg=([^&]+)/);
    if (m) { try { return decodeURIComponent(m[1]); } catch (e) { /* 原样返回 */ } }
    return u.startsWith('//') ? 'https:' + u : u;
  };
  const collect = (re, arr) => {
    let mm;
    while ((mm = re.exec(html)) !== null) arr.push(mm);
  };
  // 兼容属性顺序不同的两种写法
  const links = [];
  collect(/<a[^>]*class=['"]result-link['"][^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi, links);
  collect(/<a[^>]*href=['"]([^'"]+)['"][^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi, links);
  // 去重保序 (url, title)
  const seen = new Set();
  const ordered = [];
  for (const l of links) {
    const url = decodeDdgUrl(decodeHtmlEntities(l[1]).trim());
    const title = decodeHtmlEntities(l[2]).replace(/\s+/g, ' ').trim();
    if (!url.startsWith('http') || !title) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    ordered.push({ url, title });
  }
  const snippets = [];
  collect(/<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi, snippets);
  for (let i = 0; i < ordered.length && out.length < limit; i++) {
    out.push({
      title: ordered[i].title,
      url: ordered[i].url,
      snippet: snippets[i] ? decodeHtmlEntities(snippets[i][1]).replace(/\s+/g, ' ').trim() : ''
    });
  }
  return out;
}

// 真实联网搜索 (Node 22 内置 fetch, 15s 超时)
async function webSearch(query, limit = 8) {
  const q = String(query || '').trim();
  if (!q) throw new Error('搜索词为空');
  const url = 'https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(q);
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ORcode/0.2.12',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const results = parseSearchResults(html, limit);
  if (results.length === 0) throw new Error('没有解析到结果 (搜索引擎可能限流, 稍后再试)');
  return results;
}

// 执行文件操作 (权限不足时弹申请面板; 用户拒绝则返回错误回传给模型)
async function executeFileOps(ops) {
  const results = [];
  for (const op of ops) {
    // 联网搜索: 不走文件路径/权限, 直接请求 DuckDuckGo
    if (op.type === 'search') {
      state.log(`🌐 正在联网搜索: ${op.query}`, c.accent);
      render();
      try {
        const sres = await webSearch(op.query, 8);
        const content = sres.map((r, i) =>
          `${i + 1}. ${r.title}\n   链接: ${r.url}${r.snippet ? `\n   摘要: ${r.snippet}` : ''}`
        ).join('\n');
        results.push({ op, ok: true, content, resolved: `web:${op.query}` });
        state.log(`🌐 已搜索: ${op.query} (${sres.length} 条结果)`, c.cyan);
      } catch (e) {
        results.push({ op, ok: false, error: `搜索失败: ${e.message}` });
        state.log(`✗ 搜索失败: ${op.query} — ${e.message}`, c.red);
      }
      render();
      continue;
    }
    const p = resolveModelPath(op.path);
    if (!p) { results.push({ op, ok: false, error: '路径为空' }); continue; }
    // 权限检查: 工作区内直接放行; 工作区外弹面板由用户决定
    const ok = await checkPathPermission(p, 'read', op.reason || `模型请求${op.type === 'list' ? '列目录' : '读取文件'}`);
    if (!ok) {
      results.push({ op, ok: false, error: '用户拒绝了访问权限' });
      state.log(`✗ 模型读取被拒绝: ${p}`, c.red);
      render();
      continue;
    }
    try {
      if (op.type === 'list') {
        const entries = fs.readdirSync(p, { withFileTypes: true });
        const lines = entries.slice(0, 100).map(e => `${e.isDirectory() ? '[目录]' : '[文件]'} ${e.name}`);
        results.push({ op, ok: true, content: lines.join('\n') || '(空目录)', resolved: p });
        state.log(`📂 已列出目录: ${p} (${entries.length} 项)`, c.cyan);
      } else {
        const stat = fs.statSync(p);
        if (stat.isDirectory()) {
          results.push({ op, ok: false, error: '这是目录 — 请改用 LIST 列目录', resolved: p });
          continue;
        }
        const maxSize = getMaxReadSize();
        if (stat.size > maxSize) {
          results.push({ op, ok: false, error: `文件过大 (${(stat.size / 1048576).toFixed(1)}MB > ${(maxSize / 1048576).toFixed(0)}MB 上限, /readlimit 可调)`, resolved: p });
          continue;
        }
        const maxChars = getMaxReadChars();
        // 大文件优化: 只读前 maxChars*4 字节 (UTF-8 最坏 4 字节/字符) 再解码,
        // 避免把几百 MB 的文件整体载入内存
        const readBytes = Math.min(stat.size, maxChars * 4 + 4);
        const fd = fs.openSync(p, 'r');
        let buf;
        try {
          buf = Buffer.alloc(readBytes);
          fs.readSync(fd, buf, 0, readBytes, 0);
        } finally {
          fs.closeSync(fd);
        }
        // 二进制识别: 前 1024 字节含 NUL → 非文本文件 (PPT/PDF/图片等), 不喂乱码
        if (buf.subarray(0, Math.min(1024, buf.length)).includes(0)) {
          results.push({ op, ok: false, error: '二进制文件 (如 PPT/PDF/图片/压缩包) — 暂不支持直接读取文本内容', resolved: p });
          state.log(`⊘ 二进制文件跳过: ${p}`, c.yellow);
          render();
          continue;
        }
        let content = buf.toString('utf-8');
        // 去掉可能被截断的多字节字符残留 (替换码)
        const truncated = stat.size > readBytes || content.length > maxChars;
        if (content.length > maxChars) content = content.slice(0, maxChars);
        results.push({ op, ok: true, content, truncated, resolved: p });
        state.log(`📖 已读取文件: ${p} (${stat.size} 字节${truncated ? `, 截断至 ${maxChars} 字符` : ''})`, c.cyan);
      }
    } catch (e) {
      results.push({ op, ok: false, error: e.message, resolved: p });
      state.log(`✗ 文件操作失败: ${p} — ${e.message}`, c.red);
    }
    render();
  }
  return results;
}

// ============ 对话上下文构建 (模型调用前注入) ============
// 让模型能"翻阅"最近对话并"调用"记忆 — 上下文随指令一起发送
function buildModelContext(instruction) {
  const parts = [];
  // 1. 环境信息
  parts.push(`[环境] 工作区: ${state.workspaceDir} (工作区内你有完整文件权限; 工作区外需要用户批准)`);
  // 2. 最近对话 (从历史中提取最近的用户回合, 最多 3 轮)
  const turns = [];
  const hist = state.history;
  for (let i = hist.length - 1; i >= 0 && turns.length < 3; i--) {
    const line = hist[i];
    const text = typeof line === 'object' ? line.text : line;
    if (typeof text === 'string' && text.startsWith('▸ 你:')) {
      turns.unshift(text);
    }
  }
  if (turns.length > 0) {
    parts.push(`[最近对话]\n${turns.join('\n')}`);
  }
  // 3. 相关记忆 (关键词命中 + 最近)
  const mems = searchMemories(instruction, 5);
  if (mems.length > 0) {
    parts.push(`[你的记忆] (跨会话保存的事实)\n${mems.map(m => `- ${m.content}${m.tags.length ? ` (${m.tags.join(',')})` : ''}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

// ============ 主渲染 ============
function render() {
  if (!state) return;
  clearScreen();

  // 未初始化遮罩: 强制先 orcode init
  if (state.needsInit) {
    renderInitOverlay();
    return;
  }

  // 顶部标签栏 (浏览器式多会话)
  renderTabBar();

  const W = state.terminalWidth;
  const H = state.terminalHeight;
  const treeW = Math.max(30, Math.floor(W * 0.34));
  const mainW = W - treeW - 1;
  const divX = mainW + 1;
  const cfg = state.config;

  // ---------- 左上: 像素 ORCODE 标识 (前三字母灰 / 后三字母蓝黑, 颜色内嵌) ----------
  renderPixelLogo().forEach((line, i) => {
    write(2, 2 + i, line);
  });

  // ---------- 左上: 路径与当前岗位 ----------
  const wsDir = state.workspaceDir || '~';
  const grantedCount = Object.keys(state.permissions).filter(k => k !== 'default' && state.permissions[k] !== 'denied').length;
  write(2, 8, `${wsDir}`, c.text);
  write(2, 9, `当前岗位: ${POSITIONS[state.selectedIndex].label}`, c.sub);
  write(2, 10, `🔓 工作区内: 完整权限${grantedCount > 0 ? ` · 🔑 已授权区外路径: ${grantedCount}` : ''}`, c.green);

  // ---------- 粉色分割线 (明显) ----------
  for (let y = 2; y <= H - 5; y++) {
    moveCursor(divX, y);
    process.stdout.write(`${c.pinkBright}║${c.reset}`);
  }

  // ---------- 左栏: 欢迎语 / 会话历史 / 岗位子会话 ----------
  const historyTop = 11;
  if (state.subSession) {
    renderSubSession(mainW, H);
  } else if (state.history.length === 0) {
    write(2, historyTop, '欢迎使用 ORcode 终端模式。', c.text);
    write(2, historyTop + 1, '直接输入文字 = 单模型调用 (初始模型对话) · /hor-loop = 多模型工作流。', c.text);
    write(2, historyTop + 2, '/ 查看命令 · tab 切换岗位 · 空输入回车进子会话 · 点击 ⚙ 设置。', c.text);
    write(2, historyTop + 3, '对话历史可翻看: 滚轮 / PgUp / PgDn · 每轮对话之间有分割线。', c.faint);
  } else {
    const historyBottom = H - 4;
    const avail = historyBottom - historyTop;               // 面板可容纳行数
    const total = state.history.length;
    const maxScroll = Math.max(0, total - avail);           // 最多可上滚行数
    if (state.historyScroll > maxScroll) state.historyScroll = maxScroll;
    // historyScroll = 0 → 贴底 (显示最新); >0 → 向上翻这么多行
    const start = Math.max(0, total - avail - state.historyScroll);
    const end = Math.min(total, start + avail);   // 最多画 avail 行, 防止上滚时溢出面板
    for (let i = start; i < end; i++) {
      const line = state.history[i];
      const y = historyTop + (i - start);
      // 对话分割线 (特殊行: 铺满面板宽度)
      if (typeof line === 'object' && line.separator) {
        write(2, y, '─'.repeat(Math.max(4, mainW - 5)), line.color || c.border);
        continue;
      }
      // 显式指定颜色的行 (对象) 直接使用
      if (typeof line === 'object' && line.color) {
        write(2, y, truncateAnsi(line.text, mainW - 4), line.color);
        continue;
      }
      const text = typeof line === 'object' ? line.text : line;
      let color = c.text;
      if (text.includes('✓') || text.includes('完成') || text.includes('通过')) color = c.green;
      if (text.includes('✗') || text.includes('失败')) color = c.red;
      if (text.includes('思考') || text.includes('分析')) color = c.yellow;
      if (text.includes('OUTPUT') || text.includes('Pink')) color = c.pinkBright;
      if (text.includes('◍') || text.includes('请输入')) color = c.yellow;
      if (text.startsWith('▸ 你:')) color = c.accent;   // 用户输入行高亮
      write(2, y, truncateAnsi(text, mainW - 4), color);
    }

    // ---------- 历史区滚动条 (紧贴粉色分割线左侧) ----------
    if (maxScroll > 0) {
      const sbX = divX - 1;
      const trackH = avail;
      for (let i = 0; i < trackH; i++) {
        moveCursor(sbX, historyTop + i);
        process.stdout.write(`${c.border}│${c.reset}`);
      }
      const ratio = avail / total;
      const thumbH = Math.max(1, Math.floor(avail * ratio));
      // 滚动位置: 贴底时滑块在底部; 翻到顶时在顶部
      const thumbStart = Math.floor(((maxScroll - state.historyScroll) / maxScroll) * (trackH - thumbH));
      for (let i = 0; i < thumbH; i++) {
        moveCursor(sbX, historyTop + thumbStart + i);
        process.stdout.write(`${c.accent}█${c.reset}`);
      }
      // 上翻时在面板底部显示回底提示
      if (state.historyScroll > 0) {
        moveCursor(2, historyBottom - 1);
        process.stdout.write(`${c.yellow}↑ 已上滚 ${state.historyScroll} 行 · PgDn / 滚轮下滚回到底部${c.reset}`);
      }
    }
  }

  // ---------- 右栏: 工作树 ----------
  const treeX = divX + 1;
  write(treeX, 2, `▸ 工作树 · 多模型协作`, c.sub);

  let ty = 4;
  POSITIONS.forEach((p, idx) => {
    const pos = state.positions[p.key];
    const selected = state.selectedIndex === idx;
    const inSub = state.subSession === p.key;
    const active = state.activePos === p.key;
    const icon = active ? '◈' : (inSub ? '◐' : getStatusIcon(pos.status));
    const arrow = active ? '▶' : (selected ? '▸' : ' ');
    // 正在执行的岗位用荧光粉高亮, 其次是选中的
    const rowColor = active ? c.pinkBright : (inSub ? c.pink : (selected ? c.text : c.sub));
    const activeTag = active ? `  ${c.pinkBright}◀ 执行中${c.reset}` : (inSub ? `  ${c.pink}[子会话]${c.reset}` : '');
    write(treeX, ty, `${arrow} ${icon} ${p.label}  ${c.sub}${pos.model}${c.reset}${activeTag}`, rowColor);
    ty++;
    const isLast = idx === POSITIONS.length - 1;
    const connector = isLast ? '  ' : '│ ';
    write(treeX + 2, ty, `${connector}   ${c.faint}${p.desc}${c.reset}`, c.faint);
    ty++;
  });

  ty++;
  const doneCount = POSITIONS.filter(p => state.positions[p.key].status === 'completed').length;
  if (state.subSession) {
    write(treeX, ty, `子会话中 · Esc 返回主会话`, c.pink); ty++;
  } else if (state.running && state.activePos) {
    const ap = POSITIONS.find(p => p.key === state.activePos);
    write(treeX, ty, `▶ 执行中: ${ap ? ap.label : state.activePos} · ${doneCount}/${POSITIONS.length} 完成`, c.pinkBright); ty++;
  } else if (state.running) {
    write(treeX, ty, `运行中 · ${doneCount}/${POSITIONS.length} 岗位完成`, c.yellow); ty++;
  } else if (state.waitingForTask) {
    write(treeX, ty, `等待任务输入 · 回车启动 HOR-loop`, c.accent); ty++;
  } else {
    write(treeX, ty, `待命 · /hor-loop 启动协作`, c.faint); ty++;
  }
  write(treeX, ty, `${POSITIONS.length} 个岗位 · ${state.config.models.length} 个模型 · ${state.tokens} tok`, c.faint);

  // ---------- 底部: 输入框 ----------
  const inputY = H - 3;
  moveCursor(1, inputY - 1);
  process.stdout.write(`${c.border}${'─'.repeat(W - 1)}${c.reset}`);

  const prompt = '> ';
  let placeholder = 'Ask ORcode to do anything (单模型调用) · /hor-loop 多模型工作流';
  if (state.addStep === 'provider') placeholder = '步骤 1/5 · 输入供应商名称 (如 openai / deepseek / ollama)';
  else if (state.addStep === 'workspace') placeholder = '初始化 · 输入默认工作区目录 (必填, 如 /home/user/projects 或 ~/projects)';
  else if (state.addStep === 'baseUrl') placeholder = '步骤 2/5 · 输入 Base URL (如 https://api.deepseek.com/v1，本地可 http://localhost:11434)';
  else if (state.addStep === 'apiKey') placeholder = '步骤 3/5 · 输入 API Key (可留空，直接回车跳过)';
  else if (state.addStep === 'modelId') placeholder = '步骤 4/5 · 输入模型 ID (如 deepseek-chat / qwen-max)';
  else if (state.addStep === 'displayName') placeholder = '步骤 5/5 · 输入显示名称 (如 DeepSeek V3)';
  else if (state.addStep === 'afterAdd') placeholder = '回车 = 继续添加同一供应商模型 · 空格 = 添加其他供应商模型 · s = 完成添加';
  else if (state.subSession) placeholder = `子会话 · ${POSITIONS.find(p => p.key === state.subSession)?.label || ''} — 直接输入用该岗位模型执行 · Esc 返回`;
  else if (state.modelsOpen) placeholder = '模型选择中 · ↑↓/鼠标悬停选择 · 输入字符过滤 · enter 确认 · esc 关闭';
  else if (state.questionnaire) placeholder = '问卷回答中 · ↑↓ 切换 · 空格 勾选/选择 · enter 提交 · esc 跳过';
  else if (state.permissionRequest) placeholder = '权限申请中 · Y 同意并记住 · E 仅本次授权 · N/Esc 拒绝';
  else if (state.pathMode === 'workspace') placeholder = '切换工作区 · 输入路径 (enter 确认 · esc 取消)';
  else if (state.waitingForTask) placeholder = '输入任务内容，回车启动 HOR-loop 多模型工作流';
  else if (state.currentInput) placeholder = '';

  if (state.currentInput || !placeholder) {
    write(2, inputY, `${prompt}${state.currentInput}`, c.text);
  } else {
    write(2, inputY, `${prompt}${placeholder}`, (state.waitingForTask || state.subSession) ? c.accent : c.faint);
  }
  // 重新定位光标到正确位置 (光标可能在中间) — 先夹紧防越界
  clampCursor();
  // 关键: 按"显示宽度"算列号 (中文宽字符占 2 列), 否则光标会偏在左侧
  const cursorX = Math.min(2 + prompt.length + cursorDisplayOffset(), W - 1);
  moveCursor(cursorX, inputY);
  process.stdout.write(`${c.text}█${c.reset}`);

  // ---------- 底部: 状态栏 ----------
  const barY = H - 1;
  moveCursor(1, barY);
  process.stdout.write(`${c.border}${'─'.repeat(W - 1)}${c.reset}`);
  const mode = state.running ? 'running' : (state.waitingForTask ? 'awaiting' : 'idle');
  const defaultName = cfg.defaultModel?.name || '未配置模型';
  const permBadge = state.permissionRequest ? '⏳ 权限申请中' : '🔓 工作区权限';
  const left = `${defaultName} · ${state.workspaceDir || '~'} · ${permBadge} · ${mode} · 会话 ${state.activeIndex + 1}/${state.sessions.length}`;
  const right = `Ctrl+T 新会话 · Ctrl+W 关闭 · Ctrl+1-9 切换`;
  moveCursor(2, barY);
  process.stdout.write(`${c.sub}${truncateAnsi(left, divX - 4)}${c.reset}`);
  const rightX = W - displayWidth(right) - 6;
  moveCursor(rightX, barY);
  process.stdout.write(`${c.faint}${right}${c.reset}`);
  // 右下角设置齿轮 (可点击 / ctrl+,)
  moveCursor(W - 2, barY);
  process.stdout.write(`${c.pinkBright}⚙${c.reset}`);

  // ---------- 指令面板 (输入 / 时实时显示) ----------
  if (state.guideActive) renderCommandGuide();

  // ---------- /models 模型选择面板 ----------
  if (state.modelsOpen) renderModelPanel();

  // ---------- 智能体问卷面板 ----------
  if (state.questionnaire) renderQuestionnaire();

  // ---------- 权限申请面板 (最高层级) ----------
  if (state.permissionRequest) renderPermissionPanel();

  // ---------- 设置面板 ----------
  if (state.settingsOpen) renderSettingsPanel();
}

// ---------- 顶部标签栏 (浏览器式多会话) ----------
function renderTabBar() {
  const W = state.terminalWidth;
  const y = 1;
  moveCursor(1, y);
  process.stdout.write(' '.repeat(W));   // 清空该行
  const geom = [];
  let x = 2;
  state.sessions.forEach((t, i) => {
    const active = i === state.activeIndex;
    const wsd = i === state.activeIndex
      ? state.workspaceDir
      : (t.snapshot ? t.snapshot.workspaceDir : (state.config.defaultWorkspaceDir || state.config.workspaceDir));
    const wsBase = (wsd ? path.basename(wsd) : '~');
    const label = `${i + 1}.${t.title} · ${wsBase}`;
    const disp = `${active ? '▸' : ' '}${label}${active ? ' ' : '  '}`;
    moveCursor(x, y);
    if (active) process.stdout.write(`${c.reverse}${c.text}${disp}${c.reset}`);
    else process.stdout.write(`${c.sub}${label}  ${c.reset}`);
    geom.push({ index: i, x1: x, x2: x + displayWidth(label) });
    x += displayWidth(disp) + 1;
  });
  // [+] 新建
  moveCursor(x, y);
  const plus = '[+ 新会话]';
  process.stdout.write(`${c.accent}${plus}${c.reset}`);
  geom.push({ index: 'new', x1: x, x2: x + displayWidth(plus) });
  state._tabsGeom = geom;
}

// ---------- 初始化遮罩 (未初始化时强制) ----------
function renderInitOverlay() {
  const W = state.terminalWidth;
  const H = state.terminalHeight;
  const title = '─ ORcode 尚未初始化 ─';
  const lines = [
    '',
    '  请先完成初始化才能使用 ORcode。',
    '',
    '  ◆ 方式一: 在另一个终端运行  orcode init  (推荐)',
    '  ◆ 方式二: 按 I 在此直接初始化 (填写默认工作区 + 模型)',
    '',
    '  初始化后, 按 R 重新加载配置即可进入。',
    '',
    '  [ I ] 立即初始化      [ R ] 重新加载      [ Q ] 退出',
  ];
  const pw = Math.max(46, Math.min(70, Math.max(...lines.map(l => displayWidth(l))) + 4));
  const ph = lines.length + 4;
  const px = Math.max(2, Math.floor((W - pw) / 2));
  const py = Math.max(2, Math.floor((H - ph) / 2));
  for (let i = 0; i < ph; i++) { moveCursor(px, py + i); process.stdout.write(' '.repeat(pw)); }
  const top = `╭${title}${'─'.repeat(Math.max(0, pw - 2 - displayWidth(title)))}╮`;
  moveCursor(px, py);
  process.stdout.write(`${c.border}${top}${c.reset}`);
  moveCursor(px, py + ph - 1);
  process.stdout.write(`${c.border}╰${'─'.repeat(pw - 2)}╯${c.reset}`);
  for (let i = 1; i < ph - 1; i++) {
    moveCursor(px, py + i); process.stdout.write(`${c.border}│${c.reset}`);
    moveCursor(px + pw - 1, py + i); process.stdout.write(`${c.border}│${c.reset}`);
  }
  lines.forEach((l, i) => {
    moveCursor(px + 2, py + 2 + i);
    process.stdout.write(`${c.text}${l}${c.reset}`);
  });
}

// ---------- 岗位子会话视图 ----------
function renderSubSession(mainW, H) {
  const key = state.subSession;
  const pos = state.positions[key];
  if (!pos) return;

  // 标题栏
  write(2, 11, `◈ 子会话 · ${pos.label}  ${c.sub}(${pos.model})${c.reset}`, c.accent);
  write(2, 12, `${c.faint}${'─'.repeat(mainW - 6)}${c.reset}`, c.faint);

  let ry = 14;

  // ---- 思考过程 ----
  write(2, ry, `${c.sub}▸ 思考过程 (Thought)${c.reset}`, c.sub);
  ry++;
  if (pos.thought.length === 0) {
    write(4, ry, `${c.faint}(暂无思考记录 — 运行 /hor-loop 后在此显示)${c.reset}`, c.faint);
    ry++;
  } else {
    pos.thought.forEach((t, i) => {
      write(4, ry, `${c.faint}${i + 1}.${c.reset} ${c.yellow}${truncateAnsi(t, mainW - 12)}${c.reset}`);
      ry++;
    });
  }
  ry++;

  // ---- 主会话中该岗位的执行记录 ----
  write(2, ry, `${c.sub}▸ 执行记录 (来自主会话)${c.reset}`, c.sub);
  ry++;
  const labelWord = pos.label.split(' ')[1] || pos.label; // 如 Planner
  const related = state.history.filter(l => l.includes(labelWord));
  if (related.length === 0) {
    write(4, ry, `${c.faint}(暂无执行记录)${c.reset}`, c.faint);
    ry++;
  } else {
    const maxRows = Math.max(3, H - 14 - ry - 6);
    const show = related.slice(-maxRows);
    show.forEach(l => {
      let color = c.text;
      if (l.includes('✓')) color = c.green;
      if (l.includes('○')) color = c.yellow;
      if (l.includes('●')) color = c.accent;
      write(4, ry, truncateAnsi(l, mainW - 8), color);
      ry++;
    });
  }

  // ---- 子会话对话记录 ----
  if (state.subSessionLog.length > 0) {
    ry++;
    write(2, ry, `${c.sub}▸ 子会话指令记录${c.reset}`, c.sub);
    ry++;
    state.subSessionLog.slice(-6).forEach(l => {
      write(4, ry, truncateAnsi(l, mainW - 8), l.startsWith('▸') ? c.accent : c.text);
      ry++;
    });
  }

  // ---- 底部提示 ----
  write(2, H - 4, `${c.faint}直接输入 = 用该岗位模型单独执行 · Esc = 返回主会话${c.reset}`, c.faint);
}

// 进入岗位子会话
function enterSubSession(key) {
  state.subSession = key;
  state.subSessionLog = [];
  setInput('');
  state.waitingForTask = false;
  state.log(`▸ 进入子会话: ${POSITIONS.find(p => p.key === key)?.label || key}`);
  render();
}

// 退出子会话
function exitSubSession() {
  const key = state.subSession;
  state.subSession = null;
  state.subSessionLog = [];
  setInput('');
  if (key) state.log(`◂ 退出子会话: ${POSITIONS.find(p => p.key === key)?.label || key}`);
  render();
}

// 子会话内单独调用该岗位模型
async function runSubSessionCall(instruction) {
  const key = state.subSession;
  const pos = state.positions[key];
  if (!pos) return;

  state.running = true;
  state.activePos = key;
  state.subSessionLog.push(`▸ 指令: ${instruction}`);
  state.subSessionLog.push('  ▸ 思考中...');
  render();

  const cfg = state.config;
  const modelEntry = (cfg.models.find(m => m.name === pos.model)) || null;

  // 数据库: 子会话记录
  const sid = crypto.randomUUID();
  dbManager.createSession(sid, `[子会话·${pos.label}] ${instruction}`, { [key]: modelEntry || { name: '-', provider: '-' } });

  let result;
  if (!modelEntry) {
    result = '[未配置] 该岗位没有分配模型 — 请在设置中按 m 分配';
  } else {
    const singleCfg = Object.assign({}, cfg, {
      positions: { [key]: modelEntry }
    });
    try {
      result = await runModelWithQuestionnaire(key, instruction, singleCfg, buildModelContext(instruction));
    } catch (e) {
      result = `[错误] ${e.message}`;
    }
  }

  dbManager.logMessage(sid, key, `指令: ${instruction}`, 'info');
  dbManager.logMessage(sid, key, `响应: ${String(result).substring(0, 200)}`, result.startsWith('[') ? 'error' : 'success');
  dbManager.updateSessionStatus(sid, 'completed');

  state.subSessionLog.push(`  ▸ 响应:`);
  String(result).split('\n').forEach(line => {
    state.subSessionLog.push(`  ${line}`);
  });
  state.tokens += 32;
  state.activePos = null;
  state.running = false;
  render();
}

// ---------- /models 模型选择面板 (按供应商分组, 参考 OpenCode Select model) ----------
function getModelGroups() {
  const byProvider = {};
  const groups = [];
  state.config.models.forEach(m => {
    const p = m.provider || 'custom';
    if (!byProvider[p]) { byProvider[p] = []; groups.push({ provider: p, models: byProvider[p] }); }
    byProvider[p].push(m);
  });
  return groups;
}

function getFlatModels() {
  // 返回 [{provider, models}] — 应用搜索过滤后的分组列表
  const q = (state.modelsFilter || '').toLowerCase();
  return getModelGroups()
    .map(g => ({
      provider: g.provider,
      models: g.models.filter(m => !q
        || (m.name || '').toLowerCase().includes(q)
        || (m.modelId || '').toLowerCase().includes(q))
    }))
    .filter(g => g.models.length > 0);
}

function renderModelPanel() {
  const W = state.terminalWidth;
  const H = state.terminalHeight;
  const groups = getFlatModels();
  const flatCount = groups.reduce((n, g) => n + g.models.length, 0);
  if (state.modelsIndex >= flatCount) state.modelsIndex = Math.max(0, flatCount - 1);
  if (state.modelsIndex < 0) state.modelsIndex = 0;

  const pw = Math.max(46, Math.min(64, W - 16));
  const ph = flatCount + groups.length + 6;
  const px = Math.max(2, Math.floor((W - pw) / 2));
  const py = Math.max(1, Math.floor((H - ph) / 2) - 2);

  // 面板背景
  for (let i = 0; i < ph; i++) {
    moveCursor(px, py + i);
    process.stdout.write(' '.repeat(pw));
  }
  // 顶部边框 (标题 + esc)
  const title = '─ Select model ';
  const escTag = ' esc ';
  const dashes = Math.max(0, pw - 2 - displayWidth(title) - displayWidth(escTag));
  moveCursor(px, py);
  process.stdout.write(`${c.border}╭${title}${'─'.repeat(dashes)}${c.border}${escTag}╮${c.reset}`);

  // 搜索行
  let ry = py + 2;
  moveCursor(px + 2, ry);
  process.stdout.write(`${c.sub}Search: ${c.text}${state.modelsFilter}█${c.reset}`);
  ry++;

  // 分组渲染 (供应商名淡蓝分组头, 模型行选中反白)
  const geomRows = [];
  geomRows.push({ y: ry, flatIdx: -1 }); // 搜索行不可选
  let flat = 0;
  groups.forEach(g => {
    moveCursor(px + 2, ry);
    process.stdout.write(`${c.accent}${g.provider}${c.reset}`);
    geomRows.push({ y: ry, flatIdx: -1 }); // 分组头不可选
    ry++;
    g.models.forEach(m => {
      const sel = flat === state.modelsIndex;
      const label = `${sel ? '▸ ' : '  '}${m.name}`;
      const mid = m.modelId || '';
      const pad = ' '.repeat(Math.max(1, pw - 4 - displayWidth(label) - displayWidth(mid)));
      moveCursor(px + 2, ry);
      if (sel) {
        process.stdout.write(`${c.reverse}${c.text}${label}${pad}${c.faint}${mid}${c.reset}`);
      } else {
        process.stdout.write(`${c.text}${label}${pad}${c.faint}${mid}${c.reset}`);
      }
      geomRows.push({ y: ry, flatIdx: flat, model: m });
      flat++; ry++;
    });
  });
  // 空行占位 (过滤后行数变少, 清掉残留)
  for (let i = ry; i < py + ph - 1; i++) {
    moveCursor(px + 2, i);
    process.stdout.write(' '.repeat(pw - 4));
  }

  // 底部边框 + 操作提示
  const hint = ' enter 选择为初始模型 · esc 关闭 ';
  const hd = Math.max(0, pw - 2 - displayWidth(hint));
  moveCursor(px, py + ph - 1);
  process.stdout.write(`${c.border}╰${'─'.repeat(hd)}${c.faint}${hint}${c.border}╯${c.reset}`);

  state._modelsGeom = { px, py, pw, ph, rows: geomRows };
}

function closeModelPanel() {
  state.modelsOpen = false;
  state.modelsFilter = '';
  state.modelsIndex = 0;
  state._modelsGeom = null;
  setInput('');
  render();
}

function applySelectedModel() {
  const flatList = [];
  getFlatModels().forEach(g => g.models.forEach(m => flatList.push(m)));
  const m = flatList[state.modelsIndex];
  if (!m) return;
  state.config.defaultModel = { name: m.name, provider: m.provider };
  saveConfig(state.config);
  state.modelsOpen = false;
  state.modelsFilter = '';
  state.modelsIndex = 0;
  state._modelsGeom = null;
  setInput('');
  state.log(`✓ 初始模型已切换: ${m.name} (${m.provider})`);
  render();
}

// ---------- 智能体问卷 (模型不确定时向用户提问, 支持单选/多选) ----------
// 模型在回复中嵌入如下块即可触发问卷 (选项需具体):
//   <<<QUESTIONNAIRE
//   {"title":"确认","questions":[{"id":"q1","prompt":"...","multi":false,"options":["A","B"]}]}
//   QUESTIONNAIRE>>>

const Q_MARK_START = '<<<QUESTIONNAIRE';
const Q_MARK_END = 'QUESTIONNAIRE>>>';

function extractQuestionnaire(text) {
  const s = String(text || '');
  const m = s.match(/<<<QUESTIONNAIRE([\s\S]*?)QUESTIONNAIRE>>>/);
  if (!m) return { cleaned: s, q: null };
  const cleaned = s.replace(/<<<QUESTIONNAIRE[\s\S]*?QUESTIONNAIRE>>>/, '').trim();
  let q = null;
  try {
    const obj = JSON.parse(m[1].trim());
    if (obj && Array.isArray(obj.questions) && obj.questions.length) q = obj;
  } catch (e) { /* 非法 JSON 视为无问卷 */ }
  return { cleaned, q };
}

function normalizeQuestionnaire(raw) {
  const q = { title: raw.title || '需要你的确认', questions: [], qIndex: 0, optIndex: 0, selections: {}, freeText: {} };
  (raw.questions || []).forEach((qu, i) => {
    if (!qu || !qu.prompt || !Array.isArray(qu.options) || qu.options.length === 0) return;
    // 支持添加"其他"自定义输入选项
    const options = qu.options.map(String);
    // 如果模型指定了 allowFreeText，则添加自定义输入选项
    if (qu.allowFreeText) {
      options.push('※ 由用户自行输入答案 ※');
    }
    q.questions.push({
      id: qu.id || ('q' + i),
      prompt: String(qu.prompt),
      multi: !!qu.multi,
      allowFreeText: !!qu.allowFreeText,
      options: options
    });
  });
  return q;
}

function buildAnswerInstruction(original, answers) {
  const lines = answers.map(a => `- ${a.prompt} → ${a.answers.length ? a.answers.join('、') : '(用户未选择)'}`);
  return `${original}\n\n【用户回答问卷】\n${lines.join('\n')}\n请基于以上回答继续完成任务。`;
}

// 解析/render 后统一收集答案
function collectAnswers(q) {
  return q.questions.map(qu => ({
    id: qu.id,
    prompt: qu.prompt,
    multi: qu.multi,
    answers: (q.selections[qu.id] || []).map(oi => qu.options[oi]).filter(Boolean)
  }));
}

function questionnaireToggle() {
  const q = state.questionnaire;
  if (!q) return;
  const qu = q.questions[q.qIndex];
  const sel = q.selections[qu.id] || (q.selections[qu.id] = []);
  const idx = q.optIndex;
  if (qu.multi) {
    const p = sel.indexOf(idx);
    if (p >= 0) sel.splice(p, 1); else sel.push(idx);
  } else {
    q.selections[qu.id] = [idx];
  }
}

function moveQCursor(delta) {
  const q = state.questionnaire;
  const flat = [];
  q.questions.forEach((qu, qi) => qu.options.forEach((o, oi) => flat.push([qi, oi])));
  let i = flat.findIndex(([qi, oi]) => qi === q.qIndex && oi === q.optIndex);
  if (i < 0) i = 0;
  i = Math.max(0, Math.min(flat.length - 1, i + delta));
  q.qIndex = flat[i][0];
  q.optIndex = flat[i][1];
}

function showQuestionnaire(qData) {
  const q = normalizeQuestionnaire(qData);
  if (q.questions.length === 0) return Promise.resolve([]);
  state.questionnaire = q;
  state.questionnaireResolve = null;
  // 保留问答历史，用于显示确认信息
  if (!state.questionnaireHistory) state.questionnaireHistory = [];
  state.questionnaireHistory = []; // 清出新的一次
  render();
  return new Promise(res => { state.questionnaireResolve = res; });
}

function resolveQuestionnaire(answers) {
  const r = state.questionnaireResolve;
  // 保存确认历史信息
  if (answers && state.questionnaire) {
    const confirmation = {
      title: state.questionnaire.title,
      questions: state.questionnaire.questions.map(q => {
        const answersForQ = answers.find(a => a.id === q.id);
        return {
          prompt: q.prompt,
          answer: answersForQ ? answersForQ.answers.join('、') : '(用户未选择)',
          freeText: state.questionnaire.freeText && state.questionnaire.freeText[q.id]
        };
      })
    };
    if (!state.questionnaireHistory) state.questionnaireHistory = [];
    state.questionnaireHistory.push(confirmation);
  }

  state.questionnaire = null;
  state.questionnaireResolve = null;
  state._qGeom = null;
  state.freeTextInput = false;
  render();
  if (r) r(answers);
}

function handleQuestionnaireKey(str, key) {
  const q = state.questionnaire;
  if (!q) return;

  // 自定义输入模式
  const currentQ = q.questions[q.qIndex];
  const hasFreeText = currentQ.allowFreeText && (q.selections[currentQ.id] || []).includes(currentQ.options.length - 1);

  if (hasFreeText) {
    // 在自由文本输入模式下
    if (key.name === 'escape') {
      // esc 退出自由文本输入，但不关闭问卷
      state.freeTextInput = false;
      render();
      return;
    }
    if (key.name === 'return' || key.name === 'enter') {
      // 回车直接提交问卷
      state.freeTextInput = false;
      resolveQuestionnaire(collectAnswers(q));
      return;
    }
    if (key.name === 'backspace') {
      // 删除自由文本
      q.freeText = q.freeText || {};
      q.freeText[currentQ.id] = q.freeText[currentQ.id].slice(0, -1);
      render();
      return;
    }
    if (str && !key.ctrl && !key.meta) {
      // 输入自定义文本
      q.freeText = q.freeText || {};
      q.freeText[currentQ.id] += str;
      render();
      return;
    }
    // 注意：在自由文本模式下，其他键不响应，避免干扰文本输入
    return;
  }

  // 正常问卷模式
  if (key.name === 'escape') {
    resolveQuestionnaire(null);
    return;
  }
  if (key.name === 'return' || key.name === 'enter') {
    resolveQuestionnaire(collectAnswers(q));
    return;
  }
  if (key.name === 'up') {
    moveQCursor(-1);
    render();
    return;
  }
  if (key.name === 'down') {
    moveQCursor(1);
    render();
    return;
  }
  if (key.name === 'left') {
    const qu = q.questions[q.qIndex];
    q.optIndex = Math.max(0, q.optIndex - 1);
    render();
    return;
  }
  if (key.name === 'right') {
    const qu = q.questions[q.qIndex];
    q.optIndex = Math.min(qu.options.length - 1, q.optIndex + 1);
    render();
    return;
  }
  if (str === ' ') {
    questionnaireToggle();
    render();
    return;
  }
}

function renderQuestionnaire() {
  const q = state.questionnaire;
  if (!q) return;
  const W = state.terminalWidth, H = state.terminalHeight;
  const qn = q.questions;
  let pw = 56;
  qn.forEach(qu => {
    pw = Math.max(pw, displayWidth(qu.prompt) + 8);
    qu.options.forEach(o => { pw = Math.max(pw, displayWidth(o) + 10); });
  });
  pw = Math.min(W - 8, pw);
  let lines = 3; // 顶栏 + 标题 + 空行
  qn.forEach(qu => { lines += 1 + qu.options.length + 1; });
  lines += 1; // 底部提示
  const ph = lines;
  const px = Math.max(2, Math.floor((W - pw) / 2));
  const py = Math.max(1, Math.floor((H - ph) / 2) - 1);

  for (let i = 0; i < ph; i++) { moveCursor(px, py + i); process.stdout.write(' '.repeat(pw)); }
  const title = `─ ${q.title} `;
  const dash = Math.max(0, pw - 2 - displayWidth(title));
  moveCursor(px, py);
  process.stdout.write(`${c.border}╭${title}${'─'.repeat(dash)}╮${c.reset}`);

  let ry = py + 2;
  const rows = [];
  qn.forEach((qu, qi) => {
    moveCursor(px + 2, ry);
    const cur = qi === q.qIndex;
    process.stdout.write(`${cur ? c.accent : c.sub}Q${qi + 1}. ${qu.prompt}${c.reset}`);
    ry++;
    qu.options.forEach((opt, oi) => {
      const sel = (q.selections[qu.id] || []).includes(oi);
      const isCur = qi === q.qIndex && oi === q.optIndex;
      const box = qu.multi ? (sel ? '[✓]' : '[ ]') : (sel ? '◉' : '○');
      const marker = isCur ? '▸ ' : '  ';
      const line = `${marker}${box} ${opt}`;
      moveCursor(px + 4, ry);
      if (isCur) process.stdout.write(`${c.reverse}${c.text}${line}${c.reset}`);
      else process.stdout.write(`${sel ? c.green : c.text}${line}${c.reset}`);
      rows.push({ y: ry, qIdx: qi, optIdx: oi });
      ry++;
    });
    ry++;
  });
  // 检查当前问题是否选择了自定义输入选项
  const currentQ = qn[q.qIndex];
  const hasFreeTextSelection = currentQ.allowFreeText && (q.selections[currentQ.id] || []).includes(currentQ.options.length - 1);
  if (hasFreeTextSelection) {
    // 显示自定义输入提示
    moveCursor(px + 2, ry);
    process.stdout.write(`${c.accent}请输入你的自定义答案:${c.reset}`);
    ry++;
    // 显示当前输入内容 (如果有)
    if (q.freeText[currentQ.id]) {
      moveCursor(px + 2, ry);
      process.stdout.write(`${c.faint}当前内容: ${q.freeText[currentQ.id]}${c.reset}`);
      ry++;
    }
  }
  moveCursor(px + 2, ry);
  const multi = qn.some(x => x.multi);
  process.stdout.write(`${c.faint}↑↓ 切换 · 空格 ${multi ? '勾选' : '选择'} · Enter 提交 · Esc 跳过${c.reset}`);
  state._qGeom = { px, py, pw, ph, rows };
}

// 模型调用封装: 若回复含问卷则弹出, 收集答案后追加回指令继续 (最多 5 轮)
async function runModelWithQuestionnaire(role, instruction, cfg, context = '') {
  let currentInstruction = instruction;
  let finalResult = '';
  state.questionnaireHistory = []; // 清新一届确认历史

  for (let attempt = 0; attempt < 5; attempt++) {
    let result;
    try {
      result = await callModelSafe(role, currentInstruction, cfg, context);
    } catch (e) {
      return `[错误] ${e.message}`;
    }
    // 提取模型主动写入的记忆块并持久化
    const { cleaned: noMem, memories } = extractMemories(result);
    if (memories.length > 0) {
      result = noMem;
      memories.forEach(mem => {
        addMemory(mem.content, mem.tags, 'model');
        state.log(`🧠 已记住: ${String(mem.content).slice(0, 60)}${mem.tags.length ? ` [${mem.tags.join(',')}]` : ''}`, c.cyan);
      });
      render();
    }
    // 提取模型的文件工具调用 (READ/LIST) 并真实执行 (权限系统把关)
    const { cleaned: noOps, ops } = extractFileOps(result);
    if (ops.length > 0) {
      result = noOps;
      state.log(`🔧 模型请求 ${ops.length} 个工具操作`, c.accent);
      const fileResults = await executeFileOps(ops);
      const feedback = fileResults.map(r => {
        const target = r.resolved || resolveModelPath(r.op.path);
        if (r.ok) {
          const label = r.op.type === 'list' ? '目录列表' : '文件内容';
          return `[文件结果·${label}] ${target}:\n${r.content}${r.truncated ? '\n...(内容过长已截断, 可换更精确的路径或文件)' : ''}`;
        }
        return `[文件结果·失败] ${target}: ${r.error}`;
      }).join('\n\n');
      currentInstruction = `${currentInstruction}\n\n${feedback}\n请基于以上工具结果继续完成任务 (如需更多文件或联网信息, 可继续发起 READ/LIST/SEARCH)。`;
      continue;   // 把文件结果回传给模型, 继续循环
    }
    const { cleaned, q } = extractQuestionnaire(result);
    if (!q) {
      finalResult = (cleaned && cleaned.trim()) ? cleaned : result;
      break;
    }
    if (cleaned && cleaned.trim()) state.log(`  ${cleaned.trim()}`, c.sub);

    // 显示待确认问题
    state.log(`◆ 需要向你确认 (${q.questions.length} 个问题)` + (q.title ? ` · ${q.title}` : ''), c.accent);
    const answers = await showQuestionnaire(q);
    if (!answers) {
      state.log(`  ↳ 你跳过了提问，继续`, c.faint);
      finalResult = (cleaned && cleaned.trim()) ? cleaned : result;
      break;
    }

    // 显示确认结果（保留在界面上）
    state.log(`□ 已确认信息:`);
    answers.forEach(a => {
      // 检查是否有自由文本
      const freeText = state.questionnaireHistory && state.questionnaireHistory[state.questionnaireHistory.length - 1] &&
                       state.questionnaireHistory[state.questionnaireHistory.length - 1].questions.find(qt => qt.prompt === a.prompt && qt.freeText);
      const txt = a.answers.length ? a.answers.join('、') + (freeText ? ` + "${freeText.freeText}"` : '') : '(未选择)';
      state.log(`  ↳ ${a.prompt}: ${txt}`, c.green);
    });

    // 添加子会话推理步骤
    state.log(`◎ 推理过程: 模型检测到需要确认的信息，通过问卷收集用户反馈`);
    state.log(`  子模型思考: 识别到多义性风险，请求用户澄清`);

    // 更新指令，继续任务
    currentInstruction = buildAnswerInstruction(instruction, answers);
  }
  return finalResult;
}

// 演示: 模拟 Agent 在开工前先提问 (无需 API 即可体验)
async function demoQuestionnaire() {
  const sample = {
    title: '开工前确认',
    questions: [
      { id: 'q1', prompt: '目标语言?', multi: false, options: ['中文', 'English', '双语'] },
      { id: 'q2', prompt: '重点关注?', multi: true, options: ['性能', '可读性', '安全性'] },
      { id: 'q3', prompt: '输出形式?', multi: false, options: ['代码片段', '设计说明', '两者都要'] }
    ]
  };
  state.log('◆ Director 在开工前想先确认几个问题：', c.accent);
  const answers = await showQuestionnaire(sample);
  if (!answers) { state.log('  ↳ 你跳过了提问', c.faint); render(); return; }
  answers.forEach(a => state.log(`  ↳ ${a.prompt}: ${a.answers.length ? a.answers.join('、') : '(未选择)'}`, c.green));
  render();
}

// ---------- 指令面板 (OpenCode 风格小窗口, 支持滚动) ----------
function renderCommandGuide() {
  const W = state.terminalWidth;
  const H = state.terminalHeight;
  const filtered = state.filteredCommands();
  state._guideGeom = null;
  if (filtered.length === 0) {
    const bx = 3;
    moveCursor(bx, H - 6);
    process.stdout.write(`${c.border}┌${'─'.repeat(22)}┐${c.reset}`);
    moveCursor(bx, H - 5);
    process.stdout.write(`${c.border}│${c.reset}${c.faint} (无匹配命令)${' '.repeat(9)}${c.border}│${c.reset}`);
    moveCursor(bx, H - 4);
    process.stdout.write(`${c.border}└${'─'.repeat(22)}┘${c.reset}`);
    return;
  }
  if (state.guideIndex >= filtered.length) state.guideIndex = filtered.length - 1;
  if (state.guideIndex < 0) state.guideIndex = 0;

  const pw = 52;                                   // 窗口宽 (含边框)
  const px = 3;                                    // 左栏内贴左
  const inputY = H - 3;                            // 输入行
  const boxBottom = inputY - 2;                    // 窗口底边在输入行上方 2 行
  const maxVis = Math.max(1, Math.min(12, boxBottom - 4)); // 最多可见行数 (顶部留 3 行给 logo)
  const visRows = Math.min(filtered.length, maxVis);
  const boxH = visRows + 2;
  const py = Math.max(2, boxBottom - boxH + 1);

  // 滚动: 保证 guideIndex 可见
  const maxScroll = Math.max(0, filtered.length - visRows);
  if (state.guideScroll > maxScroll) state.guideScroll = maxScroll;
  if (state.guideScroll < 0) state.guideScroll = 0;
  if (state.guideIndex < state.guideScroll) state.guideScroll = state.guideIndex;
  if (state.guideIndex >= state.guideScroll + visRows) state.guideScroll = state.guideIndex - visRows + 1;

  // 边框
  moveCursor(px, py);
  process.stdout.write(`${c.border}┌${'─'.repeat(pw - 2)}┐${c.reset}`);
  for (let i = 0; i < visRows; i++) {
    moveCursor(px, py + 1 + i);
    process.stdout.write(`${c.border}│${c.reset}`);
    moveCursor(px + pw - 1, py + 1 + i);
    process.stdout.write(`${c.border}│${c.reset}`);
  }
  moveCursor(px, py + boxH - 1);
  process.stdout.write(`${c.border}└${'─'.repeat(pw - 2)}┘${c.reset}`);

  // 行内容 (可见窗口)
  for (let i = 0; i < visRows; i++) {
    const idx = state.guideScroll + i;
    const [cmd, desc] = filtered[idx];
    const selected = idx === state.guideIndex;
    const label = ` ${cmd.padEnd(12)}${desc}`;
    const padded = label + ' '.repeat(Math.max(0, pw - 3 - displayWidth(label)));
    moveCursor(px + 1, py + 1 + i);
    if (selected) {
      process.stdout.write(`${c.reverse}${c.text}${padded}${c.reset}`);
    } else {
      const descPad = ' '.repeat(Math.max(0, pw - 4 - 12 - displayWidth(desc)));
      process.stdout.write(`${c.sub} ${cmd.padEnd(12)}${c.reset}${c.faint}${desc}${descPad}${c.reset}`);
    }
  }

  // 内嵌滚动条 (右边框上, 有溢出时显示)
  if (filtered.length > visRows) {
    const track = visRows;
    const thumbLen = Math.max(1, Math.round(track * visRows / filtered.length));
    const thumbPos = Math.round((track - thumbLen) * (maxScroll === 0 ? 0 : state.guideScroll / maxScroll));
    for (let i = 0; i < track; i++) {
      if (i < thumbPos || i >= thumbPos + thumbLen) continue;
      moveCursor(px + pw - 1, py + 1 + i);
      process.stdout.write(`${c.accent}█${c.reset}`);
    }
  }

  state._guideGeom = { px, py, pw, ph: boxH, visRows, top: state.guideScroll, count: filtered.length };
}

// ---------- 设置面板 (含五步添加模型) ----------
function renderSettingsPanel() {
  const W = state.terminalWidth;
  const H = state.terminalHeight;
  const cfg = state.config;
  const adding = !!state.addStep;
  const pw = 52;
  const ph = adding ? 26 : 19;
  const px = Math.max(4, Math.floor((W - Math.max(30, Math.floor(W * 0.34))) * 0.5) - Math.floor(pw / 2));
  const py = Math.max(1, Math.floor((H - ph) / 2));

  // 视窗: 内容行可用区域 (py+2 .. py+ph-3), 底部一行留给固定操作提示
  const viewTop = py + 2;
  const viewBottom = py + ph - 3;
  const viewH = viewBottom - viewTop + 1;

  // 面板背景 + 边框 (清屏)
  for (let i = 0; i < ph; i++) {
    moveCursor(px, py + i);
    process.stdout.write(`${' '.repeat(pw)}`);
  }
  const top = `╭─ 设置 ${'─'.repeat(pw - 10)}╮`;
  const bottom = `╰${'─'.repeat(pw - 2)}╯`;
  moveCursor(px, py);
  process.stdout.write(`${c.border}${top}${c.reset}`);
  moveCursor(px, py + ph - 1);
  process.stdout.write(`${c.border}${bottom}${c.reset}`);
  for (let i = 1; i < ph - 1; i++) {
    moveCursor(px, py + i);
    process.stdout.write(`${c.border}│${c.reset}`);
    moveCursor(px + pw - 1, py + i);
    process.stdout.write(`${c.border}│${c.reset}`);
  }

  // ---------- 行缓冲: 先构建逻辑内容行, 再按滚动窗口裁剪绘制 ----------
  // 每行 = { segs: [{col, s}], btns: [{x1, x2, action, arg}] }
  // 这样内容再多也只会画出视窗内的行, 不会溢出边框
  const lines = [];
  const addLine = (segs, btns) => lines.push({ segs: segs || [], btns: btns || [] });
  const blank = () => addLine([]);
  // 可调数值行: label + "< val >" (两侧箭头是可点击按钮)
  const adjustRow = (label, valStr, vcol, dec, inc) => {
    const len = valStr.length + 4;
    addLine(
      [
        { col: px + 3, s: `${c.text}${label}${c.reset}` },
        { col: vcol, s: `${c.faint}< ${c.reset}${c.accent}${valStr}${c.reset}${c.faint} >${c.reset}` }
      ],
      [
        { x1: vcol, x2: vcol + 1, action: dec },
        { x1: vcol + len - 2, x2: vcol + len - 1, action: inc }
      ]
    );
  };

  if (!adding) {
    // -- 数值设置 (全部鼠标可点) --
    adjustRow('并行 Workers 数量', String(cfg.workers), px + pw - 14, 'workers-', 'workers+');
    adjustRow('验证轮数', String(cfg.verifyRounds), px + pw - 14, 'verify-', 'verify+');
    adjustRow('读取文件大小上限', `${Math.round(getMaxReadSize() / 1048576)}MB`, px + pw - 16, 'size-', 'size+');
    adjustRow('单次读取字符上限', `${Math.round(getMaxReadChars() / 1000)}k`, px + pw - 16, 'chars-', 'chars+');
    // 初始模型 (点击循环切换)
    addLine(
      [
        { col: px + 3, s: `${c.text}初始模型${c.reset}` },
        { col: px + pw - 20, s: `${c.accent}${truncateAnsi(cfg.defaultModel?.name || '-', 14)}${c.reset}` }
      ],
      [{ x1: px + pw - 20, x2: px + pw - 7, action: 'defaultModel' }]
    );
    blank();
    // 岗位模型 (点击选择岗位; 再点同一岗位循环换模型)
    addLine([{ col: px + 3, s: `${c.sub}岗位模型 ${'─'.repeat(pw - 14)}${c.reset}` }]);
    POSITIONS.forEach((p, idx) => {
      const sel = state.settingsPos === idx;
      const marker = sel ? '▸' : ' ';
      const model = state.positions[p.key]?.model || cfg.positions[p.key]?.name || '-';
      addLine(
        [sel
          ? { col: px + 3, s: `${c.accent}${marker} ${p.key.padEnd(10)}${c.text}${model}${c.reset}` }
          : { col: px + 3, s: `${c.faint}${marker} ${p.key.padEnd(10)}${c.sub}${model}${c.reset}` }],
        [{ x1: px + 3, x2: px + pw - 5, action: 'position', arg: idx }]
      );
    });
    blank();
    // 可用模型
    addLine([{ col: px + 3, s: `${c.sub}可用模型 (${cfg.models.length})${c.reset}` }]);
    if (cfg.models.length === 0) {
      addLine([{ col: px + 3, s: `${c.yellow}(暂无模型 — 点击下方 [+ 添加模型] 创建)${c.reset}` }]);
    } else {
      const names = cfg.models.map(m => m.name).join(' · ');
      addLine([{ col: px + 3, s: `${c.faint}${truncateAnsi(names, pw - 8)}${c.reset}` }]);
    }
    addLine(
      [{ col: px + 3, s: `${c.accent}[+ 添加模型]${c.reset}` }],
      [{ x1: px + 3, x2: px + 16, action: 'addModel' }]
    );
    blank();
  } else {
    // -- 添加模型五步流程 --
    addLine([{ col: px + 3, s: `${c.sub}── 添加模型 ${'─'.repeat(pw - 16)}${c.reset}` }]);
    const d = state.addDraft;
    const steps = [
      ['1', '供应商名称', d.provider, state.addStep === 'provider'],
      ['2', 'Base URL', d.baseUrl, state.addStep === 'baseUrl'],
      ['3', 'API Key', d.apiKey ? '••••••••' : '(未设置)', state.addStep === 'apiKey'],
      ['4', '模型 ID', d.modelId, state.addStep === 'modelId'],
      ['5', '显示名称', d.displayName, state.addStep === 'displayName']
    ];
    steps.forEach(([num, label, value, isCurrent]) => {
      const done = value && !isCurrent ? `${c.green}✓${c.reset}` : (isCurrent ? `${c.accent}▸${c.reset}` : `${c.faint}○${c.reset}`);
      const valColor = isCurrent ? c.accent : c.sub;
      const display = isCurrent ? `${value || ''}█` : (value || '—');
      addLine([{ col: px + 3, s: `${done} ${c.faint}${num}.${c.reset} ${c.text}${label.padEnd(6)}${c.reset} ${valColor}${truncateAnsi(display, pw - 20)}${c.reset}` }]);
    });
    blank();
    if (state.addStep === 'afterAdd') {
      addLine([{ col: px + 3, s: `${c.green}✓ 已添加: ${c.text}${d.displayName}${c.reset} ${c.faint}(${d.provider} / ${d.modelId})${c.reset}` }]);
      addLine([{ col: px + 3, s: `${c.yellow}回车${c.reset}=继续同一供应商  ${c.yellow}空格${c.reset}=其他供应商  ${c.yellow}s${c.reset}=完成添加` }]);
    } else {
      addLine([{ col: px + 3, s: `${c.faint}Esc 取消添加${c.reset}` }]);
    }
  }

  // 快捷键帮助 (作为普通内容行参与滚动, 不会再溢出边框)
  blank();
  addLine([{ col: px + 3, s: `${c.sub}快捷键 ${'─'.repeat(pw - 12)}${c.reset}` }]);
  const shortcuts = [
    ['Ctrl+T', '新建会话'],
    ['Ctrl+W', '关闭当前会话'],
    ['Ctrl+1-9', '切换到第 X 个会话'],
    ['Ctrl+N', '快速新建会话 (备用)'],
    ['Esc', '取消操作 / 清空输入'],
    ['Tab', '切换岗位'],
    ['Ctrl+P', '命令面板 (/)'],
    ['Ctrl+O', '打开设置'],
    ['PgUp/PgDn', '翻看对话历史'],
    ['/perm', '查看路径权限'],
    ['/help', '显示帮助']
  ];
  shortcuts.forEach(([k, desc]) => {
    const line = `${c.faint}${k.padEnd(12)}${c.text}${desc}${c.reset}`;
    const displayW = displayWidth(line.replace(/\x1b\[[0-9;]*m/g, ''));
    const remaining = Math.max(0, pw - 8 - displayW);
    addLine([{ col: px + 3, s: `${line}${c.faint}${' '.repeat(remaining)}${c.reset}` }]);
  });

  // ---------- 滚动计算 + 视窗绘制 ----------
  const total = lines.length;
  const maxScroll = Math.max(0, total - viewH);
  state._settingsMaxScroll = maxScroll;
  state.settingsScroll = Math.min(maxScroll, Math.max(0, state.settingsScroll));

  // 滚动条 (面板内右缘)
  const scrollbarCol = px + pw - 4;
  if (maxScroll > 0) {
    const ratio = viewH / total;
    const thumbHeight = Math.max(1, Math.floor(viewH * ratio));
    for (let i = 0; i < viewH; i++) {
      moveCursor(scrollbarCol, viewTop + i);
      process.stdout.write(`${c.border}│${c.reset}`);
    }
    const thumbStart = Math.floor((state.settingsScroll / maxScroll) * (viewH - thumbHeight));
    for (let i = 0; i < thumbHeight; i++) {
      moveCursor(scrollbarCol, viewTop + thumbStart + i);
      process.stdout.write(`${c.accent}█${c.reset}`);
    }
  }

  // 绘制视窗内的行, 并记录实际画出的按钮几何 (供鼠标点击命中)
  state._settingsGeom = { px, py, pw, ph, buttons: [] };
  for (let i = 0; i < viewH; i++) {
    const li = state.settingsScroll + i;
    if (li >= total) break;
    const line = lines[li];
    const row = viewTop + i;
    for (const seg of line.segs) {
      moveCursor(seg.col, row);
      process.stdout.write(seg.s);
    }
    for (const b of line.btns) {
      state._settingsGeom.buttons.push({ row, x1: b.x1, x2: b.x2, action: b.action, arg: b.arg });
    }
  }

  // 底部操作提示 (固定在面板内最后一行)
  moveCursor(px + 3, py + ph - 2);
  if (adding) {
    process.stdout.write(`${c.faint}每步输入后按回车确认 · Esc 取消${c.reset}`);
  } else {
    process.stdout.write(`${c.faint}点击 < > 调整 · 滚轮/↑↓ 滚动 · Esc 保存${c.reset}`);
  }
}

// 保存设置到配置文件
function persistSettings() {
  const cfg = state.config;
  cfg.positions = cfg.positions || {};
  POSITIONS.forEach(p => {
    const modelName = state.positions[p.key].model;
    // 只持久化真实存在的模型 (跳过 '-' 占位)
    const entry = cfg.models.find(m => m.name === modelName);
    if (entry) {
      cfg.positions[p.key] = {
        name: entry.name,
        provider: entry.provider,
        baseUrl: entry.baseUrl,
        modelId: entry.modelId
      };
    }
  });
  const ok = saveConfig(cfg);
  state.log(ok ? '✓ 设置已保存到配置文件' : '✗ 设置保存失败');
}

// ---------- HOR-loop 执行 ----------
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runHorLoop(instruction) {
  // 无模型守卫
  if (!state.config.models || state.config.models.length === 0) {
    state.log('◍ 尚未配置模型 — 按 Ctrl+O 或点击右下角 ⚙ 打开设置, 按 a 添加模型');
    state.waitingForTask = false;
    state.running = false;
    render();
    return;
  }

  state.running = true;
  state.waitingForTask = false;
  state.sessionId = crypto.randomUUID();
  state.tokens = 0;

  // 数据库: 创建 HOR-loop 会话
  dbManager.createSession(state.sessionId, `[HOR-loop] ${instruction}`, state.config.positions);

  state.log(`◆ 任务: ${instruction}`);
  render();

  // Director
  state.activePos = 'director';
  state.updatePosition('director', { status: 'thinking' });
  state.addThought('director', '接收指令，准备协调');
  state.log(`○ 指挥 Director · 思考中`);
  dbManager.logMessage(state.sessionId, 'director', '接收指令', 'info');
  await sleep(700); render();

  // Planner
  state.activePos = 'planner';
  state.updatePosition('planner', { status: 'thinking' });
  state.addThought('planner', '分析任务需求');
  state.log(`○ 规划 Planner · 分析任务需求`);
  dbManager.logMessage(state.sessionId, 'planner', '分析任务需求', 'info');
  await sleep(600); render();
  state.addThought('planner', '制定执行步骤');
  state.log(`○ 规划 Planner · 制定执行步骤`);
  dbManager.logMessage(state.sessionId, 'planner', '制定执行步骤', 'info');
  await sleep(600); render();
  state.updatePosition('planner', { status: 'completed' });
  state.log(`✓ 规划 Planner · 计划完成`);
  dbManager.logMessage(state.sessionId, 'planner', '计划完成', 'success');
  await sleep(300); render();

  // Workers
  state.activePos = 'worker';
  state.updatePosition('worker', { status: 'working' });
  for (let i = 1; i <= state.config.workers; i++) {
    state.addThought('worker', `Worker ${i} 执行中`);
    state.log(`● 执行 Workers · Worker ${i} 并发执行`);
    dbManager.logMessage(state.sessionId, 'worker', `Worker ${i} 执行`, 'info');
    await sleep(500); render();
  }
  state.updatePosition('worker', { status: 'completed' });
  state.log(`✓ 执行 Workers · ${state.config.workers} 个并发完成`);
  await sleep(300); render();

  // Verifier
  state.activePos = 'verifier';
  state.updatePosition('verifier', { status: 'thinking' });
  for (let r = 1; r <= state.config.verifyRounds; r++) {
    state.addThought('verifier', `第 ${r} 轮核查`);
    state.log(`○ 检验 Verifier · 第 ${r} 轮核查`);
    dbManager.logMessage(state.sessionId, 'verifier', `第 ${r} 轮核查`, 'info');
    await sleep(600); render();
    state.log(`✓ 检验 Verifier · 第 ${r} 轮通过`);
    dbManager.logMessage(state.sessionId, 'verifier', `第 ${r} 轮通过`, 'success');
  }
  state.updatePosition('verifier', { status: 'completed' });
  await sleep(300); render();

  // Director 最终输出 (荧光粉)
  state.activePos = 'director';
  state.updatePosition('director', { status: 'working' });
  state.addThought('director', '整合所有结果');
  state.log(`○ 指挥 Director · 整合输出`);
  dbManager.logMessage(state.sessionId, 'director', '整合输出', 'info');
  await sleep(500); render();

  state.updatePosition('director', { status: 'completed' });
  state.activePos = null;
  state.tokens += 128;
  dbManager.logMessage(state.sessionId, 'director', '任务完成', 'success');
  dbManager.updateSessionStatus(state.sessionId, 'completed');
  state.log('');
  // 最终输出: 荧光粉高亮
  state.log(`━━━ OUTPUT ━━━`, c.pinkBright);
  state.log(`指令: ${instruction}`, c.pinkBright);
  state.log(`流程: Director → Planner → Workers(${state.config.workers}) → Verifier(${state.config.verifyRounds})`, c.pinkBright);
  state.log(`状态: 全部完成 ✓`, c.pinkBright);
  state.log(`━━━━━━━━━━━━━━━━━━━━━━━━`, c.pinkBright);
  state.running = false;
  render();
}

// ---------- 单模型调用 (普通文字输入, 使用初始模型) ----------
async function runSingleModel(instruction) {
  const cfg = state.config;

  // 无模型守卫
  if (!cfg.models || cfg.models.length === 0 || !cfg.defaultModel) {
    state.log('◍ 尚未配置模型 — 按 Ctrl+O 或点击右下角 ⚙ 打开设置, 按 a 添加模型');
    state.running = false;
    render();
    return;
  }

  state.running = true;
  const modelEntry = (cfg.models.find(m => m.name === cfg.defaultModel.name)) || cfg.defaultModel;

  // 数据库: 创建会话
  const sid = crypto.randomUUID();
  dbManager.createSession(sid, `[单模型] ${instruction}`, { director: modelEntry });

  state.log(`◆ 单模型调用 · ${modelEntry.name}`);
  state.log('  ▸ 思考中...');
  state.activePos = 'director';
  state.updatePosition('director', { status: 'thinking' });
  state.addThought('director', `单模型调用: ${instruction.substring(0, 24)}`);
  render();

  // 构造仅含默认模型的配置, 复用 callModelSafe
  const singleCfg = Object.assign({}, cfg, {
    positions: { director: modelEntry }
  });

  let result;
  try {
    result = await runModelWithQuestionnaire('director', instruction, singleCfg, buildModelContext(instruction));
  } catch (e) {
    result = `[错误] ${e.message}`;
  }

  // 数据库: 记录消息并完成会话
  dbManager.logMessage(sid, 'director', `指令: ${instruction}`, 'info');
  dbManager.logMessage(sid, 'director', `响应: ${String(result).substring(0, 200)}`, result.startsWith('[') ? 'error' : 'success');
  dbManager.updateSessionStatus(sid, 'completed');

  state.updatePosition('director', { status: 'completed' });
  state.activePos = null;
  state.addThought('director', '响应完成');
  state.log('  ▸ 响应:');
  String(result).split('\n').forEach(line => {
    state.log(`  ${line}`, c.pinkBright);
  });
  state.tokens += 64;
  state.running = false;
  render();
}

// ---------- 初始化 / 工作区 / 存档 辅助 ----------
function startInit() {
  state.initMode = true;
  state.needsInit = false;          // 放行 addStep 流程
  state.addStep = 'workspace';
  state.addDraft = { provider: '', baseUrl: '', apiKey: '', modelId: '', displayName: '' };
  setInput('');
  state.log('◆ 初始化 ORcode — 步骤 0: 输入默认工作区目录 (必填, 如 ~/projects 或 /home/user/projects)');
  render();
}

function completeInit() {
  state.config.initialized = true;
  if (!state.config.defaultWorkspaceDir) {
    state.config.defaultWorkspaceDir = state.workspaceDir;
  }
  saveConfig(state.config);
  state.initMode = false;
  state.needsInit = false;
  state.addStep = null;
  state.log('✓ 初始化完成 — 现在可以开始使用 ORcode 了');
  render();
}

function startPathMode() {
  state.pathMode = 'workspace';
  setInput('');
  state.log('◆ 切换工作区 — 输入路径 (enter 确认 · esc 取消)');
  render();
}

// 把当前会话历史写成 Markdown 存档文件 (同步, 返回文件路径)
function writeArchiveFile() {
  const ws = state.workspaceDir || homePath;
  if (!fs.existsSync(ws)) {
    try { fs.mkdirSync(ws, { recursive: true }); } catch (e) { /* 由调用方捕获写错误 */ }
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);   // 含毫秒, 避免同秒存档互相覆盖
  const file = path.join(ws, `orcode-archive-${ts}.md`);
  const head = [
    '# ORcode 会话存档',
    '',
    `- 时间: ${new Date().toLocaleString('zh-CN')}`,
    `- 工作区: ${ws}`,
    `- 会话: ${state.sessions[state.activeIndex].title}`,
    `- 初始模型: ${state.config.defaultModel?.name || '未配置'}`,
    '',
    '## 对话记录',
    ''
  ];
  const body = state.history.map(h => {
    if (typeof h === 'object' && h.separator) return '\n---\n';
    if (typeof h === 'object' && h.text) return h.text;
    return h;
  });
  fs.writeFileSync(file, head.concat(body).join('\n'), 'utf-8');
  return file;
}

async function archiveSession() {
  const ws = state.workspaceDir || homePath;
  // 权限检查: 写入工作区内直接放行; 工作区外需申请
  const ok = await checkPathPermission(ws, 'write', '存档会话记录到工作目录');
  if (!ok) {
    state.log('✗ 存档取消 — 未获得写入权限', c.red);
    render();
    return;
  }
  try {
    const file = writeArchiveFile();
    state.log(`✓ 已存档到: ${file}`, c.green);
  } catch (e) {
    state.log(`✗ 存档失败: ${e.message}`, c.red);
  }
  render();
}

// 列出当前工作区的存档文件 (/archives)
function listArchives() {
  const ws = state.workspaceDir || homePath;
  try {
    const files = fs.readdirSync(ws)
      .filter(f => /^orcode-archive-.*\.md$/.test(f))
      .sort()
      .reverse()
      .slice(0, 10);
    if (files.length === 0) {
      state.log('◍ 当前工作区暂无存档 — /archive 手动存档; 关闭会话时也会自动存档');
    } else {
      state.log('🗄 会话存档 (最新 10 份):', c.accent);
      files.forEach(f => {
        try {
          const st = fs.statSync(path.join(ws, f));
          state.log(`  📄 ${f} (${(st.size / 1024).toFixed(1)}KB · ${st.mtime.toLocaleString('zh-CN')})`);
        } catch (e) { state.log(`  📄 ${f}`); }
      });
    }
  } catch (e) {
    state.log(`✗ 读取存档失败: ${e.message}`, c.red);
  }
  render();
}

// ---------- 斜杠命令执行 ----------
async function executeGuideCommand(cmd) {
  const parts = cmd.split(' ');
  const command = parts[0];
  setInput('');
  state.guideIndex = 0;

  switch (command) {
    case '/exit':
      process.stdout.write('\x1b[?25h\x1b[?1000l\x1b[?1003l\x1b[?1006l');
      console.log(`\n${c.sub}再见${c.reset}`);
      process.exit(0);
      break;
    case '/settings':
    case '/config':
      state.settingsOpen = true;
      state.addStep = null;
      state.settingsPos = 0;
      state.settingsScroll = 0;
      render();
      break;
    case '/add-model':
      state.settingsOpen = true;
      state.log('◆ 添加模型 — 步骤 1/5: 输入供应商名称');
      startAddModel();
      break;
    case '/ask':
    case '/questionnaire':
      setInput('');
      demoQuestionnaire();
      break;
    case '/hor-loop':
    case '/run': {
      const task = parts.slice(1).join(' ').trim();
      if (task && !state.running) {
        runHorLoop(task);
      } else if (!state.running) {
        state.waitingForTask = true;
        state.log('◆ HOR-loop 待命 — 请输入任务内容，回车启动多模型工作流');
        render();
      }
      break;
    }
    case '/help':
      state.log('多模型工作流: 输入 /hor-loop 后回车，再输入任务');
      state.log('命令: / 查看面板 · tab 切换岗位 · ctrl+, 或点击 ⚙ 打开设置');
      render();
      break;
    case '/models':
      if (state.config.models.length === 0) {
        state.log('◍ 暂无模型 — 按 a 或 /add-model 添加');
        render();
      } else {
        state.modelsOpen = true;
        state.modelsIndex = 0;
        state.modelsFilter = '';
        setInput('');
        render();
      }
      break;
    case '/history': {
      // 从数据库读取最近会话
      const sessions = dbManager.getAllSessions(5);
      if (sessions.length === 0) {
        state.log('◍ 暂无历史会话记录');
      } else {
        state.log('📜 最近会话 (SQLite):');
        sessions.forEach(s => {
          const time = s.startTime.toLocaleTimeString('zh-CN', { hour12: false });
          const statusIcon = s.status === 'completed' ? '✓' : (s.status === 'active' ? '○' : '✗');
          state.log(`  ${statusIcon} [${time}] ${s.instruction.substring(0, 40)}`);
        });
      }
      render();
      break;
    }
    case '/init':
      if (state.config.initialized) {
        state.log('✓ 已经初始化过了 — 若要重新初始化，请运行 orcode init');
        render();
      } else {
        startInit();
      }
      break;
    case '/new':
      newSession();
      break;
    case '/close':
      closeSession(state.activeIndex);
      break;
    case '/cd':
    case '/move':
      startPathMode();
      break;
    case '/archive':
    case '/save':
      archiveSession();
      break;
    case '/archives':
      listArchives();
      break;
    case '/search': {
      const query = parts.slice(1).join(' ').trim();
      if (!query) {
        state.log('◍ 用法: /search <搜索词>   (模型也会通过 <<<SEARCH>>> 工具自动联网)');
        render();
        break;
      }
      if (state.running) {
        state.log('◍ 任务进行中，请稍后再搜索');
        render();
        break;
      }
      state.running = true;
      state.log(`🌐 正在联网搜索: ${query}`, c.accent);
      render();
      webSearch(query, 8).then(results => {
        state.log(`🌐 搜索结果 (${results.length} 条):`, c.accent);
        results.forEach((r, i) => {
          state.log(`  ${i + 1}. ${r.title}`, c.text);
          state.log(`     ${r.url}`, c.faint);
          if (r.snippet) state.log(`     ${r.snippet}`, c.sub);
        });
      }).catch(e => {
        state.log(`✗ 搜索失败: ${e.message}`, c.red);
      }).finally(() => {
        state.running = false;
        render();
      });
      break;
    }
    case '/perm':
      showPermissionList();
      break;
    case '/readlimit': {
      const arg = parts.slice(1).join(' ').trim();
      const curMB = (getMaxReadSize() / 1048576).toFixed(0);
      const curK = (getMaxReadChars() / 1000).toFixed(0);
      if (!arg) {
        state.log(`📏 当前读取上限: 文件大小 ${curMB}MB · 单次字符 ${curK}k`);
        state.log('  用法: /readlimit <MB> (1-500) 调整文件大小上限; 设置面板中 ; \' 调字符数');
        render();
        break;
      }
      const mb = parseInt(arg, 10);
      if (!Number.isFinite(mb) || mb < 1 || mb > 500) {
        state.log('◍ 请输入 1-500 之间的数字 (MB)');
        render();
        break;
      }
      state.config.maxFileReadSize = mb * 1048576;
      saveConfig(state.config);
      state.log(`✓ 读取文件大小上限已设为: ${mb}MB`, c.green);
      render();
      break;
    }
    case '/remember': {
      const fact = parts.slice(1).join(' ').trim();
      if (!fact) {
        state.log('◍ 用法: /remember <要记住的事实>  (模型也会通过 <<<MEMORY>>> 块自动记忆)');
        render();
        break;
      }
      const entry = addMemory(fact, [], 'manual');
      state.log(`🧠 已记住 [${entry.id}]: ${fact}`, c.cyan);
      render();
      break;
    }
    case '/memory': {
      const list = loadMemory();
      if (list.length === 0) {
        state.log('🧠 记忆为空 — /remember <事实> 手动添加, 或让模型在回复中嵌入 <<<MEMORY>>> 块');
      } else {
        state.log(`🧠 记忆库 (${list.length} 条):`, c.cyan);
        list.slice(-10).forEach(m => {
          state.log(`  [${m.id}] ${m.content}${m.tags.length ? ` (${m.tags.join(',')})` : ''} · ${m.source}`);
        });
      }
      render();
      break;
    }
    case '/forget': {
      const kw = parts.slice(1).join(' ').trim();
      if (!kw) {
        state.log('◍ 用法: /forget <记忆ID 或 关键词>');
        render();
        break;
      }
      const n = removeMemory(kw);
      state.log(n > 0 ? `✓ 已删除 ${n} 条记忆` : '◍ 没有匹配的记忆', n > 0 ? c.green : c.yellow);
      render();
      break;
    }
    case '/context': {
      const ctx = buildModelContext(parts.slice(1).join(' ').trim() || '当前任务');
      state.log('══ 将发送给模型的上下文 ══', c.accent);
      String(ctx).split('\n').forEach(l => state.log(l));
      state.log('══ (上下文随指令一起发送, 模型可翻阅) ══', c.accent);
      render();
      break;
    }
    case '/agents':
      state.selectedIndex = (state.selectedIndex + 1) % POSITIONS.length;
      state.log(`▸ 已切换岗位: ${POSITIONS[state.selectedIndex].label}`);
      render();
      break;
    default:
      state.log(`${command} — OpenCode 兼容命令 (演示)`);
      render();
  }
}

// ---------- 添加模型五步流程 ----------
function startAddModel() {
  state.addStep = 'provider';
  state.addDraft = { provider: '', baseUrl: '', apiKey: '', modelId: '', displayName: '' };
  setInput('');
  state.log('◆ 添加模型 — 步骤 1/5: 输入供应商名称');
  render();
}

function cancelAddModel() {
  state.addStep = null;
  state.addDraft = { provider: '', baseUrl: '', apiKey: '', modelId: '', displayName: '' };
  setInput('');
  state.log('◍ 已取消添加模型');
  render();
}

function finishAddModel() {
  state.addStep = null;
  state.addDraft = { provider: '', baseUrl: '', apiKey: '', modelId: '', displayName: '' };
  setInput('');
  state.log('✓ 模型添加完成 — 在设置中按 m 可分配给岗位');
  render();
}

// 确认当前步骤输入
function confirmAddStep(text) {
  const t = text.trim();
  const d = state.addDraft;

  switch (state.addStep) {
    case 'workspace':
      if (!t) {
        state.log('◍ 默认工作区不能为空 — 请重新输入 (如 ~/projects)');
        render();
        return;
      }
      state.config.defaultWorkspaceDir = expandPath(t);
      state.workspaceDir = state.config.defaultWorkspaceDir;
      state.addStep = 'provider';
      setInput('');
      state.log(`◆ 步骤 1/5: 输入供应商名称 (默认工作区: ${state.config.defaultWorkspaceDir})`);
      break;
    case 'provider':
      // 初始化模式下, 供应商留空 = 跳过模型添加, 直接完成初始化
      if (!t && state.initMode) { completeInit(); return; }
      d.provider = t || 'custom';
      state.addStep = 'baseUrl';
      state.log(`◆ 步骤 2/5: 输入 Base URL (供应商: ${d.provider})`);
      break;
    case 'baseUrl':
      d.baseUrl = t;
      state.addStep = 'apiKey';
      state.log('◆ 步骤 3/5: 输入 API Key (可留空跳过)');
      break;
    case 'apiKey':
      d.apiKey = t;
      if (t) {
        state.config.apiKeys = state.config.apiKeys || {};
        state.config.apiKeys[d.provider] = t;
      }
      state.addStep = 'modelId';
      state.log('◆ 步骤 4/5: 输入模型 ID');
      break;
    case 'modelId':
      if (!t) {
        state.log('◍ 模型 ID 不能为空，请重新输入');
        render();
        return;
      }
      d.modelId = t;
      state.addStep = 'displayName';
      state.log(`◆ 步骤 5/5: 输入显示名称 (模型 ID: ${t})`);
      break;
    case 'displayName':
      d.displayName = t || d.modelId;
      // 写入模型列表 (按显示名去重)
      const entry = {
        name: d.displayName,
        provider: d.provider,
        baseUrl: d.baseUrl,
        modelId: d.modelId
      };
      const exist = state.config.models.find(m => m.name === entry.name);
      if (exist) Object.assign(exist, entry);
      else state.config.models.push(entry);
      // 首个模型 (或岗位尚未分配) → 自动设为初始模型并分配给所有岗位
      const posUnset = POSITIONS.every(p => !state.positions[p.key].model || state.positions[p.key].model === '-');
      if (!state.config.defaultModel || posUnset) {
        state.config.defaultModel = { name: entry.name, provider: entry.provider };
        POSITIONS.forEach(p => {
          state.positions[p.key].model = entry.name;
          state.config.positions[p.key] = { name: entry.name, provider: entry.provider, baseUrl: entry.baseUrl, modelId: entry.modelId };
        });
      }
      const ok = saveConfig(state.config);
      state.addStep = 'afterAdd';
      state.log(ok
        ? `✓ 已添加模型: ${entry.name} (${entry.provider} / ${entry.modelId})`
        : '✗ 模型添加失败 (无法写入配置)');
      state.log('  回车 = 继续同一供应商 · 空格 = 其他供应商 · s = 完成');
      break;
  }
  setInput('');
  render();
}

// ---------- 鼠标悬停跟踪 (光标跟随鼠标) ----------
function handleMouseHover(col, row) {
  // 智能体问卷: 悬停移动光标到对应选项
  if (state.questionnaire) {
    const g = state._qGeom;
    if (!g) return;
    const hit = g.rows.find(r => r.y === row);
    if (hit && (hit.qIdx !== state.questionnaire.qIndex || hit.optIdx !== state.questionnaire.optIndex)) {
      state.questionnaire.qIndex = hit.qIdx;
      state.questionnaire.optIndex = hit.optIdx;
      render();
    }
    return;
  }
  // /models 模型面板: 悬停移动选中项
  if (state.modelsOpen) {
    const g = state._modelsGeom;
    if (!g) return;
    const hit = g.rows.find(r => r.y === row && r.flatIdx >= 0);
    if (hit && hit.flatIdx !== state.modelsIndex) {
      state.modelsIndex = hit.flatIdx;
      render();
    }
    return;
  }
  // 指令小窗口: 悬停移动选中命令 (几何由 renderCommandGuide 记录)
  if (state.guideActive && !state.running) {
    const g = state._guideGeom;
    if (g && col >= g.px && col <= g.px + g.pw && row > g.py && row < g.py + g.ph) {
      const vis = row - g.py - 1;
      const idx = g.top + vis;
      if (vis >= 0 && vis < g.visRows && idx < g.count && state.guideIndex !== idx) {
        state.guideIndex = idx;
        render();
      }
    }
  }
}

// ---------- 鼠标点击处理 ----------
function handleMouseClick(col, row) {
  // 权限申请面板打开时: 点击面板外 = 拒绝, 面板内忽略 (需按键选择)
  if (state.permissionRequest) {
    const g = state._permGeom;
    if (g && !(col >= g.px && col <= g.px + g.pw && row >= g.py && row <= g.py + g.ph)) {
      resolvePermissionRequest('N');
    }
    return;
  }

  const W = state.terminalWidth;
  const H = state.terminalHeight;
  const treeW = Math.max(30, Math.floor(W * 0.34));
  const divX = W - treeW;
  const treeX = divX + 1;

  // 标签栏点击 (y===1): 切换会话或新建
  if (row === 1 && state._tabsGeom) {
    const hit = state._tabsGeom.find(g => col >= g.x1 && col <= g.x2);
    if (hit) {
      if (hit.index === 'new') newSession();
      else switchSession(hit.index);
      return;
    }
  }

  // 点击右下角 ⚙ → 切换设置
  if (row >= H - 1 && col >= W - 4) {
    state.settingsOpen = !state.settingsOpen;
    if (state.settingsOpen) {
      state.settingsPos = 0;
      state.addStep = null;
      state.settingsScroll = 0;
    }
    render();
    return;
  }

  // 智能体问卷打开时: 点击选项行 = 选择/勾选, 点击面板外 = 跳过
  if (state.questionnaire) {
    const g = state._qGeom;
    if (!g) return;
    const inside = col >= g.px && col <= g.px + g.pw && row >= g.py && row <= g.py + g.ph;
    if (!inside) { resolveQuestionnaire(null); return; }
    const hit = g.rows.find(r => r.y === row);
    if (hit) {
      state.questionnaire.qIndex = hit.qIdx;
      state.questionnaire.optIndex = hit.optIdx;
      questionnaireToggle();
      render();
    }
    return;
  }

  // /models 模型面板打开时: 点击模型行选中并应用, 点击面板外关闭
  if (state.modelsOpen) {
    const g = state._modelsGeom;
    if (!g) return;
    const inside = col >= g.px && col <= g.px + g.pw && row >= g.py && row <= g.py + g.ph;
    if (!inside) { closeModelPanel(); return; }
    const hit = g.rows.find(r => r.y === row && r.flatIdx >= 0);
    if (hit) {
      state.modelsIndex = hit.flatIdx;
      applySelectedModel();
    }
    return;
  }

  // 设置面板打开时: 命中 renderSettingsPanel 登记的按钮几何
  if (state.settingsOpen) {
    const g = state._settingsGeom;
    if (!g) return;
    const hit = g.buttons.find(b => row === b.row && col >= b.x1 && col <= b.x2);
    if (hit) handleSettingsButton(hit.action, hit.arg);
    return;
  }

  // 输入框点击: 设置光标位置
  if (!state.running && !state.questionnaire && !state.modelsOpen && !state.addStep && !state.pathMode) {
    const inputY = H - 3;
    // render: write(2, inputY, '> ' + input) → 提示符占 2 列 (列 2-3), 输入区从列 4 开始
    // cursorX = 2 + prompt.length + displayWidth(光标前文本) = 4 + 显示宽度
    const inputStartCol = 4;
    if (row === inputY && col >= 2) {
      state.cursorPosition = colToCursorIndex(col, inputStartCol);
      render();
    }
  }

  // 指令小窗口激活时: 点击命令项执行
  if (state.guideActive) {
    const g = state._guideGeom;
    if (g && col >= g.px && col <= g.px + g.pw && row > g.py && row < g.py + g.ph) {
      const vis = row - g.py - 1;
      const idx = g.top + vis;
      if (vis >= 0 && vis < g.visRows && idx < g.count) {
        state.guideIndex = idx;
        executeGuideCommand(state.filteredCommands()[idx][0]);
      }
    }
    return;
  }

  // 点击工作树岗位行 → director 选中, 其他岗位进入子会话
  for (let i = 0; i < POSITIONS.length; i++) {
    const rowY = 4 + i * 2;
    if (row === rowY && col >= treeX) {
      const key = POSITIONS[i].key;
      state.selectedIndex = i;
      if (key === 'director') {
        state.log('▸ Director 为主会话 — 其他岗位可点击进入子会话');
        render();
      } else {
        enterSubSession(key);
      }
      return;
    }
  }
}

// ---------- 设置面板键盘处理 ----------
function handleSettingsKey(str, key) {
  const cfg = state.config;

  // Esc: 关闭并保存
  if (key.name === 'escape') {
    persistSettings();
    state.settingsOpen = false;
    render();
    return true;
  }

  // 设置面板滚动: 上下箭头 (maxScroll 由 renderSettingsPanel 按实际内容行计算)
  if (key.name === 'up') {
    const max = state._settingsMaxScroll || 0;
    state.settingsScroll = Math.max(0, state.settingsScroll - 1);
    if (state.settingsScroll > max) state.settingsScroll = max;
    render();
    return true;
  }
  if (key.name === 'down') {
    const max = state._settingsMaxScroll || 0;
    state.settingsScroll = Math.min(max, state.settingsScroll + 1);
    render();
    return true;
  }

  // a: 添加模型 (五步流程)
  if (str === 'a' || str === 'A') {
    startAddModel();
    return true;
  }

  // d: 更换初始模型 (点击"初始模型"值的键盘等价, 不再在面板中提示)
  if (str === 'd' || str === 'D') {
    cycleDefaultModel();
    render();
    return true;
  }

  // (键盘数值调整键已移除 — 改为鼠标点击面板中的 < > 按钮)

  // tab 切换岗位
  if (key.name === 'tab') {
    state.settingsPos = (state.settingsPos + 1) % POSITIONS.length;
    render();
    return true;
  }

  // m 更换模型 (点击岗位行的键盘等价, 不再在面板中提示)
  if (str === 'm' || str === 'M') {
    cyclePositionModel(state.settingsPos);
    render();
    return true;
  }

  return false;
}

// ---------- 设置面板鼠标按钮动作 ----------
function cycleDefaultModel() {
  const cfg = state.config;
  if (!cfg.models || cfg.models.length === 0) {
    state.log('◍ 暂无可用模型 — 点击 [+ 添加模型] 先添加');
    return;
  }
  const names = cfg.models.map(m => m.name);
  const cur = cfg.defaultModel?.name;
  const idx = names.indexOf(cur);
  const nextName = names[(idx + 1) % names.length];
  const next = cfg.models.find(m => m.name === nextName);
  cfg.defaultModel = { name: next.name, provider: next.provider };
  saveConfig(cfg);
}

function cyclePositionModel(posIdx) {
  const cfg = state.config;
  if (!cfg.models || cfg.models.length === 0) {
    state.log('◍ 暂无可用模型 — 点击 [+ 添加模型] 先添加');
    return;
  }
  const p = POSITIONS[posIdx];
  const names = cfg.models.map(m => m.name);
  const cur = state.positions[p.key].model;
  const idx = names.indexOf(cur);
  // 当前岗位模型不在列表中时 (显示 '-') 从第一个开始
  const next = names[(idx + 1) % names.length] || names[0];
  state.positions[p.key].model = next;
  // 同步写配置并持久化
  const entry = cfg.models.find(m => m.name === next);
  cfg.positions[p.key] = { name: entry.name, provider: entry.provider, baseUrl: entry.baseUrl, modelId: entry.modelId };
  saveConfig(cfg);
  state.log(`▸ ${p.label} 模型已设为: ${next}`);
}

function handleSettingsButton(action, arg) {
  const cfg = state.config;
  switch (action) {
    case 'workers-': cfg.workers = Math.max(1, cfg.workers - 1); break;
    case 'workers+': cfg.workers = Math.min(8, cfg.workers + 1); break;
    case 'verify-': cfg.verifyRounds = Math.max(1, cfg.verifyRounds - 1); break;
    case 'verify+': cfg.verifyRounds = Math.min(5, cfg.verifyRounds + 1); break;
    case 'size-':
    case 'size+': {
      const mb = Math.min(500, Math.max(1, Math.round(getMaxReadSize() / 1048576) + (action === 'size+' ? 5 : -5)));
      cfg.maxFileReadSize = mb * 1048576;
      state.log(`▸ 读取文件大小上限: ${mb}MB`);
      break;
    }
    case 'chars-':
    case 'chars+': {
      cfg.maxFileReadChars = action === 'chars+'
        ? Math.min(200000, getMaxReadChars() + 2000)
        : Math.max(2000, getMaxReadChars() - 2000);
      state.log(`▸ 单次读取字符上限: ${cfg.maxFileReadChars}`);
      break;
    }
    case 'defaultModel':
      cycleDefaultModel();
      break;
    case 'position':
      // 第一次点 = 选中岗位; 再点同一岗位 = 循环换模型
      if (state.settingsPos === arg) {
        cyclePositionModel(arg);
      } else {
        state.settingsPos = arg;
      }
      break;
    case 'addModel':
      state.settingsScroll = 0;
      startAddModel();
      return; // startAddModel 内部已 render
    default:
      return;
  }
  render();
}

// ---------- 自定义输入解析 (避免 readline 拆碎鼠标序列泄漏到输入框) ----------
let inputBuffer = '';
let escTimer = null;

function mapKey(ch) {
  if (ch === '\r' || ch === '\n') return { name: 'return', str: '', ctrl: false, meta: false };
  if (ch === '\x7f' || ch === '\x08') return { name: 'backspace', str: '', ctrl: false, meta: false };
  if (ch === '\t') return { name: 'tab', str: '', ctrl: false, meta: false };
  const code = ch.charCodeAt(0);
  // ctrl+字母/数字: \x01-\x1a (ASCII 1-26)
  if (code >= 1 && code <= 26) {
    let name;
    if (code <= 9) {
      name = String.fromCharCode(code + 48); // 1 -> '1', 9 -> '9'
    } else {
      name = String.fromCharCode(code + 96); // 10 -> 'j', 26 -> 'z'
    }
    return { name, str: '', ctrl: true, meta: false };
  }
  return { name: ch, str: ch, ctrl: false, meta: false };
}

function parseInput() {
  while (inputBuffer.length > 0) {
    // 1. SGR 鼠标序列: ESC [ < button ; col ; row M/m — 优先吃掉, 防止泄漏
    const mouse = inputBuffer.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
    if (mouse) {
      const btn = parseInt(mouse[1], 10);
      const col = parseInt(mouse[2], 10);
      const row = parseInt(mouse[3], 10);
      if (!state.running) {
        if (btn === 35 && mouse[4] === 'M') {
          handleMouseHover(col, row);            // 无按键移动 = 悬停跟踪
        } else if (btn < 32 && mouse[4] === 'M') {
          handleMouseClick(col, row);            // 左/中/右键按下 = 点击
        } else if (btn >= 64 && btn <= 67 && mouse[4] === 'M') {
          // 滚轮事件: 64=up, 65=down, 66=left, 67=right
          const wheelUp = btn === 64 || btn === 66;
          // ⓪ 指令小窗口内 → 窗口滚动 (覆盖层, 最高优先)
          if (state.guideActive && !state.running) {
            const gg = state._guideGeom;
            if (gg && col >= gg.px && col <= gg.px + gg.pw && row >= gg.py && row <= gg.py + gg.ph) {
              const delta = wheelUp ? -2 : 2;
              const max = Math.max(0, gg.count - gg.visRows);
              state.guideScroll = Math.max(0, Math.min(max, state.guideScroll + delta));
              render();
            }
          }
          // ① 设置面板内 → 设置面板滚动 (面板是覆盖层; 几何由 renderSettingsPanel 记录)
          if (state.settingsOpen) {
            const g = state._settingsGeom;
            if (g && col >= g.px && col <= g.px + g.pw && row >= g.py && row <= g.py + g.ph) {
              const delta = wheelUp ? -2 : 2;
              const max = state._settingsMaxScroll || 0;
              state.settingsScroll = Math.max(0, Math.min(max, state.settingsScroll + delta));
              render();
            }
          } else if (!state.questionnaire && !state.modelsOpen && !state.permissionRequest
                     && !state.subSession && state.history.length > 0) {
            // ② 鼠标在左栏对话历史区 (粉色分割线左侧) → 翻看历史
            const treeW = Math.max(30, Math.floor(state.terminalWidth * 0.34));
            const divX = state.terminalWidth - treeW;
            const historyTop = 11, historyBottom = state.terminalHeight - 4;
            if (col >= 2 && col < divX && row >= historyTop && row < historyBottom) {
              // wheelUp → 看更早 (historyScroll++); wheelDown → 回近期 (historyScroll--)
              scrollHistory(wheelUp ? 3 : -3);
            }
          }
        }
        // 32-34 拖拽、m 释放: 忽略
      }
      inputBuffer = inputBuffer.slice(mouse[0].length);
      continue;
    }
    // 2. CSI 序列 (方向键)
    const csi = inputBuffer.match(/^\x1b\[([A-D])/);
    if (csi) {
      const names = { A: 'up', B: 'down', C: 'right', D: 'left' };
      handleKey('', { name: names[csi[1]], ctrl: false, meta: false }).catch(() => {});
      inputBuffer = inputBuffer.slice(csi[0].length);
      continue;
    }
    // 2b. CSI 序列 (PgUp=ESC[5~ / PgDn=ESC[6~) — 历史翻页
    const pg = inputBuffer.match(/^\x1b\[([56])~/);
    if (pg) {
      const name = pg[1] === '5' ? 'pageup' : 'pagedown';
      handleKey('', { name, ctrl: false, meta: false }).catch(() => {});
      inputBuffer = inputBuffer.slice(pg[0].length);
      continue;
    }
    // 3. 单独 ESC — 等待 30ms 确认不是序列开头, 否则视为 Esc 键
    if (inputBuffer === '\x1b') {
      if (!escTimer) {
        escTimer = setTimeout(() => {
          escTimer = null;
          if (inputBuffer === '\x1b') {
            inputBuffer = '';
            handleKey('\x1b', { name: 'escape', ctrl: false, meta: false }).catch(() => {});
          } else {
            parseInput();
          }
        }, 30);
      }
      return;
    }
    // 4. ESC + 其他字符 (Alt 组合) — 丢弃 ESC, 忽略其余
    if (inputBuffer[0] === '\x1b') {
      inputBuffer = inputBuffer.slice(1);
      continue;
    }
    // 5. 普通字符 (按 code point 处理, 兼容中文)
    const ch = String.fromCodePoint(inputBuffer.codePointAt(0));
    const key = mapKey(ch);
    handleKey(key.str || '', key).catch(() => {});
    inputBuffer = inputBuffer.slice(ch.length);
  }
}

// ---------- 按键处理 (原 keypress 逻辑) ----------
async function handleKey(str, key) {
  // ---- ctrl+c 退出 ----
  if (key.ctrl && key.name === 'c') {
    process.stdout.write('\x1b[?25h\x1b[?1000l\x1b[?1003l\x1b[?1006l');
    console.log(`\n${c.sub}再见${c.reset}`);
    process.exit(0);
  }

  // ---- 未初始化门禁 (初始化进行中 addStep 已激活则放行) ----
  if (state.needsInit && !state.addStep) {
    if (key.name === 'i' || str === 'i') { startInit(); return; }
    if (key.name === 'r' || str === 'r') {
      state.config = loadConfig();
      state.needsInit = !state.config.initialized;
      if (!state.needsInit) applyFreshSession();
      state.log(state.needsInit ? '◍ 仍未检测到初始化，请先运行 orcode init' : '✓ 已检测到初始化配置，进入主界面');
      render();
      return;
    }
    if (key.name === 'q' || str === 'q') {
      process.stdout.write('\x1b[?25h\x1b[?1000l\x1b[?1003l\x1b[?1006l');
      console.log(`\n${c.sub}再见 (请先运行 orcode init)${c.reset}`);
      process.exit(0);
    }
    return;   // 其它按键忽略, 直到初始化完成
  }

  // ---- 权限申请面板 (最高优先级, 弹出时拦截所有其它输入) ----
  if (state.permissionRequest) {
    handlePermissionKey(str, key);
    return;
  }

  // ---- 智能体问卷 (最高优先级, 弹出时拦截所有其它输入) ----
  if (state.questionnaire) {
    handleQuestionnaireKey(str, key);
    return;
  }

  // ---- /models 模型选择面板 ----
  if (state.modelsOpen) {
    if (key.name === 'escape') { closeModelPanel(); return; }
    if (key.name === 'up') {
      state.modelsIndex = Math.max(0, state.modelsIndex - 1);
      render(); return;
    }
    if (key.name === 'down') {
      state.modelsIndex = Math.min(Math.max(0, getFlatModels().reduce((n, g) => n + g.models.length, 0) - 1), state.modelsIndex + 1);
      render(); return;
    }
    if (key.name === 'return' || key.name === 'enter') {
      applySelectedModel(); return;
    }
    if (key.name === 'backspace') {
      state.modelsFilter = state.modelsFilter.slice(0, -1);
      state.modelsIndex = 0;
      render(); return;
    }
    if (str && !key.ctrl && !key.meta) {
      state.modelsFilter += str;   // 输入字符即时过滤 (含空格, 如 "DeepSeek V3")
      state.modelsIndex = 0;
      render(); return;
    }
    return;
  }

  // ---- 岗位子会话模式 (次最高优先级) ----
  if (state.subSession && !state.running) {
    // Esc 返回主会话
    if (key.name === 'escape') {
      exitSubSession();
      return;
    }
    // 回车: 用该岗位模型执行输入
    if (key.name === 'return' || key.name === 'enter') {
      const input = state.currentInput.trim();
      if (input) {
        setInput('');
        logUserTurn(input);           // 分割线 + 用户输入入历史
        await runSubSessionCall(input);
      }
      return;
    }
    // 退格
    if (key.name === 'backspace') {
      state.currentInput = state.currentInput.slice(0, -1);
      state.cursorPosition = state.currentInput.length;   // 追加型模式: 光标保持末端
      render();
      return;
    }
    // 普通字符输入
    if (str && !key.ctrl && !key.meta) {
      state.currentInput += str;
      state.cursorPosition = state.currentInput.length;   // 追加型模式: 光标保持末端
      render();
    }
    return;
  }

  // ---- 切换工作区路径输入模式 (pathMode) ----
  if (state.pathMode === 'workspace') {
    if (key.name === 'escape') {
      state.pathMode = null;
      setInput('');
      state.log('◍ 已取消切换工作区');
      render();
      return;
    }
    if (key.name === 'return' || key.name === 'enter') {
      const p = expandPath(state.currentInput.trim());
      if (!p) {
        state.log('◍ 路径不能为空');
        render();
        return;
      }
      state.workspaceDir = p;
      state.pathMode = null;
      setInput('');
      state.log(`✓ 工作区已切换为: ${p}`);
      render();
      return;
    }
    if (key.name === 'backspace') {
      state.currentInput = state.currentInput.slice(0, -1);
      state.cursorPosition = state.currentInput.length;
      render();
      return;
    }
    if (str && !key.ctrl && !key.meta) {
      state.currentInput += str;
      state.cursorPosition = state.currentInput.length;
      render();
    }
    return;
  }

  // ---- 添加模型流程 (最高优先级) ----
  if (state.addStep) {
    // 完成一步后的分支选择: 回车=同供应商继续 · 空格=其他供应商 · s=完成
    if (state.addStep === 'afterAdd') {
      if (key.name === 'return' || key.name === 'enter') {
        state.addStep = 'modelId';      // 继续同一供应商 (保留 provider/baseUrl/key)
        setInput('');
        state.log('◆ 继续添加 — 步骤 4/5: 输入模型 ID (同一供应商)');
        render();
        return;
      }
      if (str === ' ') {                 // 空格 → 其他供应商
        state.addStep = 'provider';
        state.addDraft = { provider: '', baseUrl: '', apiKey: '', modelId: '', displayName: '' };
        setInput('');
        state.log('◆ 添加其他供应商模型 — 步骤 1/5: 输入供应商名称');
        render();
        return;
      }
      if (str === 's' || str === 'S') {  // s → 完成
        finishAddModel();
        if (state.initMode) completeInit();
        return;
      }
      return; // 其他键忽略
    }

    // 五个输入步骤
    if (key.name === 'return' || key.name === 'enter') {
      confirmAddStep(state.currentInput);
      return;
    }
    if (key.name === 'escape') {
      cancelAddModel();
      return;
    }
    if (key.name === 'backspace') {
      state.currentInput = state.currentInput.slice(0, -1);
      state.cursorPosition = state.currentInput.length;   // 追加型模式: 光标保持末端
      render();
      return;
    }
    if (str && !key.ctrl && !key.meta) {
      state.currentInput += str;   // 输入步骤允许空格 (如 "DeepSeek V3")
      state.cursorPosition = state.currentInput.length;   // 追加型模式: 光标保持末端
      render();
    }
    return;
  }

  // ---- 设置面板打开时 ----
  if (state.settingsOpen) {
    if (handleSettingsKey(str, key)) return;
    return;
  }

  // ---- 多会话快捷键 (仅空闲时) ----
  if (!state.running && !state.questionnaire && !state.modelsOpen && !state.addStep
      && !state.subSession && !state.pathMode && !state.needsInit) {
    if (key.ctrl && (key.name === 't' || key.name === 'n')) { newSession(); return; }
    if (key.ctrl && key.name === 'w') { closeSession(state.activeIndex); return; }
    if (key.ctrl && /^[1-9]$/.test(key.name)) {
      switchSession(parseInt(key.name, 10) - 1);
      return;
    }
  }

  // ---- ctrl+p 命令面板 (输入 /) ----
  if (key.ctrl && key.name === 'p' && !state.running) {
    setInput('/');                 // 光标落到 '/' 之后
    state.guideIndex = 0;
    state.waitingForTask = false;
    render();
    return;
  }

  // ---- ctrl+o 打开设置 (齿轮的键盘替代) ----
  if (key.ctrl && key.name === 'o') {
    state.settingsOpen = !state.settingsOpen;
    if (state.settingsOpen) {
      state.settingsPos = 0;
      state.addStep = null;
      state.settingsScroll = 0;
    }
    render();
    return;
  }

  // ---- Esc 清空输入 / 取消等待 ----
  if (key.name === 'escape') {
    setInput('');                  // 同时重置光标, 防止残留越位
    state.guideIndex = 0;
    state.waitingForTask = false;
    render();
    return;
  }

  // ---- 指令面板激活时的导航 ----
  if (state.guideActive && !state.running) {
    const filtered = state.filteredCommands();
    if (key.name === 'up') {
      state.guideIndex = Math.max(0, state.guideIndex - 1);
      render(); return;
    }
    if (key.name === 'down') {
      state.guideIndex = Math.min(filtered.length - 1, state.guideIndex + 1);
      render(); return;
    }
    if (key.name === 'pageup' || key.name === 'pagedown') {
      const vis = (state._guideGeom && state._guideGeom.visRows) || 8;
      state.guideIndex = key.name === 'pageup'
        ? Math.max(0, state.guideIndex - vis)
        : Math.min(filtered.length - 1, state.guideIndex + vis);
      render(); return;
    }
    if (key.name === 'return' || key.name === 'enter') {
      if (filtered.length > 0) {
        executeGuideCommand(filtered[state.guideIndex][0]);
      } else {
        setInput('');
        render();
      }
      return;
    }
  }

  // ---- tab 切换岗位 ----
  if (key.name === 'tab') {
    state.selectedIndex = (state.selectedIndex + 1) % POSITIONS.length;
    render();
    return;
  }

  // ---- 回车执行 ----
  if (key.name === 'return' || key.name === 'enter') {
    const input = state.currentInput.trim();

    // /hor-loop 待命状态: 输入任务即启动
    if (state.waitingForTask) {
      if (input && !input.startsWith('/')) {
        setInput('');
        logUserTurn(input);           // 分割线 + 用户输入入历史
        if (!state.running) await runHorLoop(input);
        return;
      }
      if (input.startsWith('/')) {
        state.waitingForTask = false;
      } else {
        return;
      }
    }

    // 空输入 + 选中非 director 岗位 → 进入该岗位子会话
    if (!input && !state.running) {
      const p = POSITIONS[state.selectedIndex];
      if (p && p.key !== 'director') {
        enterSubSession(p.key);
      } else if (p && p.key === 'director') {
        state.log('▸ Director 为主会话 — tab 切换到其他岗位后回车可进入子会话');
        render();
      }
      return;
    }

    if (input && !state.running) {
      if (input === 'exit' || input === 'quit') {
        process.stdout.write('\x1b[?25h\x1b[?1000l\x1b[?1003l\x1b[?1006l');
        console.log(`\n${c.sub}再见${c.reset}`);
        process.exit(0);
      } else if (input.startsWith('/')) {
        const match = GUIDE_COMMANDS.find(([cmd]) => cmd === input.split(' ')[0]);
        if (match) {
          logUserTurn(input);         // 分割线 + 用户输入入历史
          executeGuideCommand(input);
        } else {
          setInput('');
          state.log(`◍ 未知命令: ${input.split(' ')[0]} — 输入 / 查看命令面板`);
          render();
        }
      } else {
        // 普通文字: 单模型调用 (初始模型直接对话)
        setInput('');
        logUserTurn(input);           // 分割线 + 用户输入入历史
        if (!state.running) await runSingleModel(input);
      }
    }
    return;
  }

  // ---- 历史翻页: PgUp 向上(看更早) / PgDn 向下(回近期) ----
  if (key.name === 'pageup') {
    if (!state.running && !state.subSession) { scrollHistory(10); return; }
  }
  if (key.name === 'pagedown') {
    if (!state.running && !state.subSession) { scrollHistory(-10); return; }
  }

  // ---- 退格 ----
  if (key.name === 'backspace') {
    if (state.cursorPosition > 0) {
      state.currentInput = state.currentInput.slice(0, state.cursorPosition - 1) +
                           state.currentInput.slice(state.cursorPosition);
      state.cursorPosition--;
      if (state.cursorPosition >= state.currentInput.length) {
        state.cursorPosition = state.currentInput.length;
      }
    }
    state.guideIndex = 0;
    render();
    return;
  }

  // ---- 方向键移动光标（左右） ----
  if (!state.running && !state.guideActive && !state.modelsOpen && !state.questionnaire
      && !state.addStep && !state.subSession && !state.pathMode && !state.needsInit) {
    if (key.name === 'left') {
      if (state.cursorPosition > 0) {
        state.cursorPosition--;
        render();
      }
      return;
    }
    if (key.name === 'right') {
      if (state.cursorPosition < state.currentInput.length) {
        state.cursorPosition++;
        render();
      }
      return;
    }
  }

  // ---- 普通字符 (插入到光标处, 光标随后移 — 修复"光标不跟随/卡住") ----
  if (str && !key.ctrl && !key.meta && !state.running) {
    insertAtCursor(str);
    render();
  }
}

// ---------- 启动 ----------
async function startTUI() {
  state = new TUIState();

  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
  }

  // 初始化数据库 (静默, 避免干扰 TUI 渲染)
  dbManager.initialize(true);

  // 为首个会话生成快照 (state 已赋值)
  serializeSession(0);

  render();

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdout.write('\x1b[?25l');            // 隐藏光标
  // 启用鼠标: 1000 点击 + 1003 全移动(悬停跟踪) + 1006 SGR 编码
  process.stdout.write('\x1b[?1000h\x1b[?1003h\x1b[?1006h');

  // 原始输入监听: 自行解析, 鼠标序列优先吃掉, 不会泄漏到输入框
  process.stdin.on('data', (chunk) => {
    inputBuffer += chunk.toString('utf8');
    parseInput();
  });

  // 窗口大小变化重渲染
  process.stdout.on('resize', () => {
    state.terminalWidth = process.stdout.columns || 100;
    state.terminalHeight = process.stdout.rows || 30;
    render();
  });

  process.stdin.resume();
}

module.exports = {
  startTUI,
  getState: () => state,
  // 测试钩子 (仅供自动化测试, 正常使用不受影响)
  __test: {
    initState: () => { if (!state) state = new TUIState(); return state; },
    checkPathPermission,
    getPermission,
    isInsideWorkspace,
    normalizePath,
    requestPermission,
    resolvePermissionRequest,
    handlePermissionKey,
    grantPermission,
    showPermissionList,
    logUserTurn,
    scrollHistory,
    render: () => render(),
    setInput,
    insertAtCursor,
    clampCursor,
    cursorDisplayOffset,
    colToCursorIndex,
    buildModelContext,
    loadMemory,
    addMemory,
    removeMemory,
    searchMemories,
    wrapText,
    parseSearchResults,
    webSearch,
    extractFileOps,
    writeArchiveFile,
    listArchives,
    extractMemories,
    resolveModelPath,
    extractFileOps,
    executeFileOps,
    getMaxReadSize,
    getMaxReadChars,
    handleKey: (str, key) => handleKey(str, key),
    handleKeyPublic: (str, key) => handleKey(str, key),
    renderSettingsPanel: () => renderSettingsPanel(),
    handleSettingsKey: (str, key) => handleSettingsKey(str, key),
    handleSettingsButton: (action, arg) => handleSettingsButton(action, arg),
    handleMouseClick: (col, row) => handleMouseClick(col, row),
    handleMouseHover: (col, row) => handleMouseHover(col, row),
    renderPixelLogo,
    renderCommandGuide: () => renderCommandGuide(),
    executeGuideCommand: (cmd) => executeGuideCommand(cmd),
    cycleDefaultModel: () => cycleDefaultModel(),
    cyclePositionModel: (idx) => cyclePositionModel(idx),
    closeSession: (idx) => closeSession(idx)
  }
};
