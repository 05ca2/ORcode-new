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
  version: '0.2.0',
  workers: 2,
  verifyRounds: 1,
  defaultModel: null,
  models: [],
  positions: {},
  workspaceDir: homePath,
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
  cyan: '\x1b[38;5;115m',        // 青灰 (logo)
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
  for (const ch of 'ORCODE') {
    const glyph = PIXEL_FONT[ch] || PIXEL_FONT.O;
    for (let i = 0; i < 5; i++) {
      lines[i] += glyph[i] + ' ';
    }
  }
  return lines;
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
  ['/settings', 'Settings'],
  ['/add-model', 'Add a model'],
  ['/ask', 'Demo: agent asks a questionnaire'],
  ['/history', 'View session history'],
  ['/run', 'Run task (alias of /hor-loop)']
];

// ============ TUI 状态 ============
class TUIState {
  constructor() {
    this.config = loadConfig();
    this.positions = {};
    this.history = [];
    this.currentInput = '';
    this.selectedIndex = 0;
    this.guideIndex = 0;
    this.settingsOpen = false;
    this.settingsPos = 0;
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

    POSITIONS.forEach(p => {
      this.positions[p.key] = {
        ...p,
        status: 'idle',
        model: this.config.positions[p.key]?.name || '-',
        thought: [],
        output: null
      };
    });
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
    this.history.push(color ? { text, color } : text);
    if (this.history.length > 200) this.history.shift();
  }
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

// ============ 主渲染 ============
function render() {
  if (!state) return;
  clearScreen();

  const W = state.terminalWidth;
  const H = state.terminalHeight;
  const treeW = Math.max(30, Math.floor(W * 0.34));
  const mainW = W - treeW - 1;
  const divX = mainW + 1;
  const cfg = state.config;

  // ---------- 左上: 像素 ORCODE 标识 ----------
  renderPixelLogo().forEach((line, i) => {
    write(2, 2 + i, line, c.cyan);
  });

  // ---------- 左上: 路径与当前岗位 ----------
  const wsDir = cfg.workspaceDir || '~';
  write(2, 8, `${wsDir}`, c.text);
  write(2, 9, `当前岗位: ${POSITIONS[state.selectedIndex].label}`, c.sub);

  // ---------- 粉色分割线 (明显) ----------
  for (let y = 1; y <= H - 5; y++) {
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
  } else {
    const historyBottom = H - 4;
    const avail = historyBottom - historyTop;
    const start = Math.max(0, state.history.length - avail);
    for (let i = start; i < state.history.length; i++) {
      const line = state.history[i];
      // 显式指定颜色的行 (对象) 直接使用
      if (typeof line === 'object' && line.color) {
        write(2, historyTop + (i - start), truncateAnsi(line.text, mainW - 4), line.color);
        continue;
      }
      const text = typeof line === 'object' ? line.text : line;
      let color = c.text;
      if (text.includes('✓') || text.includes('完成') || text.includes('通过')) color = c.green;
      if (text.includes('✗') || text.includes('失败')) color = c.red;
      if (text.includes('思考') || text.includes('分析')) color = c.yellow;
      if (text.includes('OUTPUT') || text.includes('Pink')) color = c.pinkBright;
      if (text.includes('◍') || text.includes('请输入')) color = c.yellow;
      write(2, historyTop + (i - start), truncateAnsi(text, mainW - 4), color);
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
  else if (state.addStep === 'baseUrl') placeholder = '步骤 2/5 · 输入 Base URL (如 https://api.deepseek.com/v1，本地可 http://localhost:11434)';
  else if (state.addStep === 'apiKey') placeholder = '步骤 3/5 · 输入 API Key (可留空，直接回车跳过)';
  else if (state.addStep === 'modelId') placeholder = '步骤 4/5 · 输入模型 ID (如 deepseek-chat / qwen-max)';
  else if (state.addStep === 'displayName') placeholder = '步骤 5/5 · 输入显示名称 (如 DeepSeek V3)';
  else if (state.addStep === 'afterAdd') placeholder = '回车 = 继续添加同一供应商模型 · 空格 = 添加其他供应商模型 · s = 完成添加';
  else if (state.subSession) placeholder = `子会话 · ${POSITIONS.find(p => p.key === state.subSession)?.label || ''} — 直接输入用该岗位模型执行 · Esc 返回`;
  else if (state.modelsOpen) placeholder = '模型选择中 · ↑↓/鼠标悬停选择 · 输入字符过滤 · enter 确认 · esc 关闭';
  else if (state.questionnaire) placeholder = '问卷回答中 · ↑↓ 切换 · 空格 勾选/选择 · enter 提交 · esc 跳过';
  else if (state.waitingForTask) placeholder = '输入任务内容，回车启动 HOR-loop 多模型工作流';
  else if (state.currentInput) placeholder = '';

  if (state.currentInput || !placeholder) {
    write(2, inputY, `${prompt}${state.currentInput}`, c.text);
  } else {
    write(2, inputY, `${prompt}${placeholder}`, (state.waitingForTask || state.subSession) ? c.accent : c.faint);
  }
  const cursorX = 2 + prompt.length + state.currentInput.length;
  moveCursor(cursorX, inputY);
  process.stdout.write(`${c.text}█${c.reset}`);

  // ---------- 底部: 状态栏 ----------
  const barY = H - 1;
  moveCursor(1, barY);
  process.stdout.write(`${c.border}${'─'.repeat(W - 1)}${c.reset}`);
  const mode = state.running ? 'running' : (state.waitingForTask ? 'awaiting' : 'idle');
  const defaultName = cfg.defaultModel?.name || '未配置模型';
  const left = `${defaultName} · ${cfg.workspaceDir || '~'} · ${mode}`;
  const right = `tab for agent · ? for shortcuts`;
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

  // ---------- 设置面板 ----------
  if (state.settingsOpen) renderSettingsPanel();
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
  state.currentInput = '';
  state.waitingForTask = false;
  state.log(`▸ 进入子会话: ${POSITIONS.find(p => p.key === key)?.label || key}`);
  render();
}

// 退出子会话
function exitSubSession() {
  const key = state.subSession;
  state.subSession = null;
  state.subSessionLog = [];
  state.currentInput = '';
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
      result = await runModelWithQuestionnaire(key, instruction, singleCfg);
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
  state.currentInput = '';
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
  state.currentInput = '';
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
  const q = { title: raw.title || '需要你的确认', questions: [], qIndex: 0, optIndex: 0, selections: {} };
  (raw.questions || []).forEach((qu, i) => {
    if (!qu || !qu.prompt || !Array.isArray(qu.options) || qu.options.length === 0) return;
    q.questions.push({
      id: qu.id || ('q' + i),
      prompt: String(qu.prompt),
      multi: !!qu.multi,
      options: qu.options.map(String)
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
  render();
  return new Promise(res => { state.questionnaireResolve = res; });
}

function resolveQuestionnaire(answers) {
  const r = state.questionnaireResolve;
  state.questionnaire = null;
  state.questionnaireResolve = null;
  state._qGeom = null;
  render();
  if (r) r(answers);
}

function handleQuestionnaireKey(str, key) {
  const q = state.questionnaire;
  if (!q) return;
  if (key.name === 'escape') { resolveQuestionnaire(null); return; }       // 跳过
  if (key.name === 'return' || key.name === 'enter') { resolveQuestionnaire(collectAnswers(q)); return; }
  if (key.name === 'up') { moveQCursor(-1); render(); return; }
  if (key.name === 'down') { moveQCursor(1); render(); return; }
  if (key.name === 'left') {
    const qu = q.questions[q.qIndex];
    q.optIndex = Math.max(0, q.optIndex - 1); render(); return;
  }
  if (key.name === 'right') {
    const qu = q.questions[q.qIndex];
    q.optIndex = Math.min(qu.options.length - 1, q.optIndex + 1); render(); return;
  }
  if (str === ' ') { questionnaireToggle(); render(); return; }
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
  moveCursor(px + 2, ry);
  const multi = qn.some(x => x.multi);
  process.stdout.write(`${c.faint}↑↓ 切换 · 空格 ${multi ? '勾选' : '选择'} · enter 提交 · esc 跳过${c.reset}`);
  state._qGeom = { px, py, pw, ph, rows };
}

// 模型调用封装: 若回复含问卷则弹出, 收集答案后追加回指令继续 (最多 5 轮)
async function runModelWithQuestionnaire(role, instruction, cfg) {
  let currentInstruction = instruction;
  let finalResult = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    let result;
    try {
      result = await callModelSafe(role, currentInstruction, cfg);
    } catch (e) {
      return `[错误] ${e.message}`;
    }
    const { cleaned, q } = extractQuestionnaire(result);
    if (!q) {
      finalResult = (cleaned && cleaned.trim()) ? cleaned : result;
      break;
    }
    if (cleaned && cleaned.trim()) state.log(`  ${cleaned.trim()}`, c.sub);
    state.log(`◆ 需要向你确认 (${q.questions.length} 个问题)` + (q.title ? ` · ${q.title}` : ''), c.accent);
    const answers = await showQuestionnaire(q);
    if (!answers) {
      state.log(`  ↳ 你跳过了提问，继续`, c.faint);
      finalResult = (cleaned && cleaned.trim()) ? cleaned : result;
      break;
    }
    answers.forEach(a => {
      state.log(`  ↳ ${a.prompt}: ${a.answers.length ? a.answers.join('、') : '(未选择)'}`, c.green);
    });
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

// ---------- 指令面板 (参考 OpenCode 风格) ----------
function renderCommandGuide() {
  const W = state.terminalWidth;
  const H = state.terminalHeight;
  const filtered = state.filteredCommands();
  if (filtered.length === 0) {
    write(4, H - 6, `${c.faint}(无匹配命令)${c.reset}`, c.faint);
    return;
  }
  if (state.guideIndex >= filtered.length) state.guideIndex = filtered.length - 1;
  if (state.guideIndex < 0) state.guideIndex = 0;

  const panelH = filtered.length;
  const infoH = 4;
  let py = H - 5 - infoH - panelH;
  if (py < 2) py = 2;

  filtered.forEach(([cmd, desc], i) => {
    const selected = i === state.guideIndex;
    const label = `  ${cmd.padEnd(11)}${desc}`;
    const padded = label + ' '.repeat(Math.max(0, 46 - displayWidth(label)));
    moveCursor(4, py + i);
    if (selected) {
      process.stdout.write(`${c.reverse}${c.text}${padded}${c.reset}`);
    } else {
      process.stdout.write(`${c.sub}${cmd.padEnd(13)}${c.faint}${desc}${c.reset}`);
    }
  });

  let iy = py + panelH + 1;
  moveCursor(4, iy);
  process.stdout.write(`${c.accent}▎${c.reset}`);
  const agentInfo = `ORcode — HOR-loop · ${state.config.defaultModel?.name || '未配置模型'} · ${POSITIONS.length} 岗位`;
  moveCursor(6, iy);
  process.stdout.write(`${c.text}${truncateAnsi(agentInfo, W - 10)}${c.reset}`);
  iy++;
  moveCursor(6, iy);
  process.stdout.write(`${c.faint}tab agents   ctrl+p commands${c.reset}`);
  iy++;
  moveCursor(6, iy);
  process.stdout.write(`${c.yellow}●${c.reset} ${c.faint}Tip 直接输入文字 = 单模型调用 · /hor-loop = 多模型协作 · ↑↓ 选择${c.reset}`);
}

// ---------- 设置面板 (含五步添加模型) ----------
function renderSettingsPanel() {
  const W = state.terminalWidth;
  const H = state.terminalHeight;
  const cfg = state.config;
  const pw = 52;
  const adding = !!state.addStep;
  const ph = adding ? 24 : 17;
  const px = Math.max(4, Math.floor((W - Math.max(30, Math.floor(W * 0.34))) * 0.5) - Math.floor(pw / 2));
  const py = Math.max(1, Math.floor((H - ph) / 2));

  // 面板背景 + 边框
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

  let ry = py + 2;
  // 并行 Workers 数量
  moveCursor(px + 3, ry);
  process.stdout.write(`${c.text}并行 Workers 数量${c.reset}`);
  moveCursor(px + pw - 14, ry);
  process.stdout.write(`${c.faint}< ${c.accent}${cfg.workers}${c.faint} >${c.reset}`);
  ry++;
  // 验证轮数
  moveCursor(px + 3, ry);
  process.stdout.write(`${c.text}验证轮数${c.reset}`);
  moveCursor(px + pw - 14, ry);
  process.stdout.write(`${c.faint}< ${c.accent}${cfg.verifyRounds}${c.faint} >${c.reset}`);
  ry++;
  // 初始模型
  moveCursor(px + 3, ry);
  process.stdout.write(`${c.text}初始模型 (d 更换)${c.reset}`);
  moveCursor(px + pw - 20, ry);
  process.stdout.write(`${c.accent}${truncateAnsi(cfg.defaultModel?.name || '-', 14)}${c.reset}`);
  ry += 2;

  // 岗位模型
  moveCursor(px + 3, ry);
  process.stdout.write(`${c.sub}岗位模型 (tab 切换 · m 更换模型)${c.reset}`);
  ry++;
  POSITIONS.forEach((p, idx) => {
    const sel = state.settingsPos === idx;
    const marker = sel ? '▸' : ' ';
    // 显示内存中的实时值 (m 键切换后立即反映)
    const model = state.positions[p.key]?.model || cfg.positions[p.key]?.name || '-';
    moveCursor(px + 3, ry);
    if (sel) {
      process.stdout.write(`${c.accent}${marker} ${p.key.padEnd(10)}${c.text}${model}${c.reset}`);
    } else {
      process.stdout.write(`${c.faint}${marker} ${p.key.padEnd(10)}${c.sub}${model}${c.reset}`);
    }
    ry++;
  });

  ry++;
  // 可用模型列表
  moveCursor(px + 3, ry);
  process.stdout.write(`${c.sub}可用模型 (${cfg.models.length}) — a 添加新模型:${c.reset}`);
  ry++;
  if (cfg.models.length === 0) {
    moveCursor(px + 3, ry);
    process.stdout.write(`${c.yellow}(暂无模型 — 按 a 添加你的第一个模型)${c.reset}`);
  } else {
    const names = cfg.models.map(m => m.name).join(' · ');
    moveCursor(px + 3, ry);
    process.stdout.write(`${c.faint}${truncateAnsi(names, pw - 8)}${c.reset}`);
  }
  ry += 2;

  // ---------- 添加模型五步流程 ----------
  if (adding) {
    const d = state.addDraft;
    const steps = [
      ['1', '供应商名称', d.provider, state.addStep === 'provider'],
      ['2', 'Base URL', d.baseUrl, state.addStep === 'baseUrl'],
      ['3', 'API Key', d.apiKey ? '••••••••' : '(未设置)', state.addStep === 'apiKey'],
      ['4', '模型 ID', d.modelId, state.addStep === 'modelId'],
      ['5', '显示名称', d.displayName, state.addStep === 'displayName']
    ];
    moveCursor(px + 3, ry);
    process.stdout.write(`${c.sub}── 添加模型 ${'─'.repeat(pw - 16)}${c.reset}`);
    ry++;
    steps.forEach(([num, label, value, isCurrent]) => {
      moveCursor(px + 3, ry);
      const done = value && !isCurrent ? `${c.green}✓${c.reset}` : (isCurrent ? `${c.accent}▸${c.reset}` : `${c.faint}○${c.reset}`);
      const valColor = isCurrent ? c.accent : c.sub;
      const display = isCurrent ? `${value || ''}█` : (value || '—');
      process.stdout.write(`${done} ${c.faint}${num}.${c.reset} ${c.text}${label.padEnd(6)}${c.reset} ${valColor}${truncateAnsi(display, pw - 20)}${c.reset}`);
      ry++;
    });

    if (state.addStep === 'afterAdd') {
      moveCursor(px + 3, ry);
      process.stdout.write(`${c.green}✓ 已添加: ${c.text}${d.displayName}${c.reset} ${c.faint}(${d.provider} / ${d.modelId})${c.reset}`);
      ry++;
      moveCursor(px + 3, ry);
      process.stdout.write(`${c.yellow}回车${c.reset}=继续同一供应商  ${c.yellow}空格${c.reset}=其他供应商  ${c.yellow}s${c.reset}=完成添加`);
    } else {
      moveCursor(px + 3, ry);
      process.stdout.write(`${c.faint}Esc 取消添加${c.reset}`);
    }
    ry++;
  }

  // 底部操作提示
  moveCursor(px + 3, py + ph - 2);
  if (adding) {
    process.stdout.write(`${c.faint}每步输入后按回车确认${c.reset}`);
  } else {
    process.stdout.write(`${c.faint}-/+ 数量 · [ ] 轮数 · d 初始模型 · a 添加模型 · Esc 保存${c.reset}`);
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
    result = await runModelWithQuestionnaire('director', instruction, singleCfg);
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

// ---------- 斜杠命令执行 ----------
async function executeGuideCommand(cmd) {
  const parts = cmd.split(' ');
  const command = parts[0];
  state.currentInput = '';
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
      render();
      break;
    case '/add-model':
      state.settingsOpen = true;
      state.log('◆ 添加模型 — 步骤 1/5: 输入供应商名称');
      startAddModel();
      break;
    case '/ask':
    case '/questionnaire':
      state.currentInput = '';
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
        state.currentInput = '';
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
  state.currentInput = '';
  state.log('◆ 添加模型 — 步骤 1/5: 输入供应商名称');
  render();
}

function cancelAddModel() {
  state.addStep = null;
  state.addDraft = { provider: '', baseUrl: '', apiKey: '', modelId: '', displayName: '' };
  state.currentInput = '';
  state.log('◍ 已取消添加模型');
  render();
}

function finishAddModel() {
  state.addStep = null;
  state.addDraft = { provider: '', baseUrl: '', apiKey: '', modelId: '', displayName: '' };
  state.currentInput = '';
  state.log('✓ 模型添加完成 — 在设置中按 m 可分配给岗位');
  render();
}

// 确认当前步骤输入
function confirmAddStep(text) {
  const t = text.trim();
  const d = state.addDraft;

  switch (state.addStep) {
    case 'provider':
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
  state.currentInput = '';
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
  // 指令面板: 悬停移动选中命令
  if (state.guideActive && !state.running) {
    const filtered = state.filteredCommands();
    const panelH = filtered.length;
    if (panelH === 0) return;
    const infoH = 4;
    let py = state.terminalHeight - 5 - infoH - panelH;
    if (py < 2) py = 2;
    for (let i = 0; i < filtered.length; i++) {
      if (row === py + i && col >= 4 && col <= 50) {
        if (state.guideIndex !== i) {
          state.guideIndex = i;
          render();
        }
        return;
      }
    }
  }
}

// ---------- 鼠标点击处理 ----------
function handleMouseClick(col, row) {
  const W = state.terminalWidth;
  const H = state.terminalHeight;
  const treeW = Math.max(30, Math.floor(W * 0.34));
  const divX = W - treeW;
  const treeX = divX + 1;

  // 点击右下角 ⚙ → 切换设置
  if (row >= H - 1 && col >= W - 4) {
    state.settingsOpen = !state.settingsOpen;
    if (state.settingsOpen) {
      state.settingsPos = 0;
      state.addStep = null;
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

  // 设置面板打开时: 点击岗位行切换
  if (state.settingsOpen) {
    const pw = 52, ph = 24;
    const px = Math.max(4, Math.floor((W - treeW) * 0.5) - Math.floor(pw / 2));
    const py = Math.max(1, Math.floor((H - ph) / 2));
    const firstModelRow = py + 7;
    for (let i = 0; i < POSITIONS.length; i++) {
      if (row === firstModelRow + i && col >= px && col <= px + pw) {
        state.settingsPos = i;
        render();
        return;
      }
    }
    return;
  }

  // 指令面板激活时: 点击命令项执行
  if (state.guideActive) {
    const filtered = state.filteredCommands();
    const panelH = filtered.length;
    const infoH = 4;
    let py = H - 5 - infoH - panelH;
    if (py < 2) py = 2;
    for (let i = 0; i < filtered.length; i++) {
      if (row === py + i && col >= 4 && col <= 50) {
        executeGuideCommand(filtered[i][0]);
        return;
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

  // a: 添加模型 (五步流程)
  if (str === 'a' || str === 'A') {
    startAddModel();
    return true;
  }

  // d: 更换初始模型 (循环)
  if (str === 'd' || str === 'D') {
    if (cfg.models.length === 0) {
      state.log('◍ 暂无可用模型 — 先按 a 添加模型');
      render();
      return true;
    }
    const names = cfg.models.map(m => m.name);
    const cur = cfg.defaultModel?.name;
    const idx = names.indexOf(cur);
    const nextName = names[(idx + 1) % names.length];
    const next = cfg.models.find(m => m.name === nextName);
    cfg.defaultModel = { name: next.name, provider: next.provider };
    saveConfig(cfg);
    render();
    return true;
  }

  // 调整数量
  if (str === '-' || str === '_') {
    cfg.workers = Math.max(1, cfg.workers - 1);
    render(); return true;
  }
  if (str === '+' || str === '=') {
    cfg.workers = Math.min(8, cfg.workers + 1);
    render(); return true;
  }
  if (str === '[' || str === '{') {
    cfg.verifyRounds = Math.max(1, cfg.verifyRounds - 1);
    render(); return true;
  }
  if (str === ']' || str === '}') {
    cfg.verifyRounds = Math.min(5, cfg.verifyRounds + 1);
    render(); return true;
  }

  // tab 切换岗位
  if (key.name === 'tab') {
    state.settingsPos = (state.settingsPos + 1) % POSITIONS.length;
    render();
    return true;
  }

  // m 更换模型 (循环可选模型, 即时写入配置)
  if (str === 'm' || str === 'M') {
    if (cfg.models.length === 0) {
      state.log('◍ 暂无可用模型 — 先按 a 添加模型');
      render();
      return true;
    }
    const p = POSITIONS[state.settingsPos];
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
    render();
    return true;
  }

  return false;
}

// ---------- 自定义输入解析 (避免 readline 拆碎鼠标序列泄漏到输入框) ----------
let inputBuffer = '';
let escTimer = null;

function mapKey(ch) {
  if (ch === '\r' || ch === '\n') return { name: 'return', str: '', ctrl: false, meta: false };
  if (ch === '\x7f' || ch === '\x08') return { name: 'backspace', str: '', ctrl: false, meta: false };
  if (ch === '\t') return { name: 'tab', str: '', ctrl: false, meta: false };
  const code = ch.charCodeAt(0);
  // ctrl+字母: \x01-\x1a
  if (code >= 1 && code <= 26) {
    return { name: String.fromCharCode(code + 96), str: '', ctrl: true, meta: false };
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
        }
        // 64/65 滚轮、32-34 拖拽、m 释放: 忽略
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
        state.currentInput = '';
        await runSubSessionCall(input);
      }
      return;
    }
    // 退格
    if (key.name === 'backspace') {
      state.currentInput = state.currentInput.slice(0, -1);
      render();
      return;
    }
    // 普通字符输入
    if (str && !key.ctrl && !key.meta) {
      state.currentInput += str;
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
        state.currentInput = '';
        state.log('◆ 继续添加 — 步骤 4/5: 输入模型 ID (同一供应商)');
        render();
        return;
      }
      if (str === ' ') {                 // 空格 → 其他供应商
        state.addStep = 'provider';
        state.addDraft = { provider: '', baseUrl: '', apiKey: '', modelId: '', displayName: '' };
        state.currentInput = '';
        state.log('◆ 添加其他供应商模型 — 步骤 1/5: 输入供应商名称');
        render();
        return;
      }
      if (str === 's' || str === 'S') {  // s → 完成
        finishAddModel();
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
      render();
      return;
    }
    if (str && !key.ctrl && !key.meta) {
      state.currentInput += str;   // 输入步骤允许空格 (如 "DeepSeek V3")
      render();
    }
    return;
  }

  // ---- 设置面板打开时 ----
  if (state.settingsOpen) {
    if (handleSettingsKey(str, key)) return;
    return;
  }

  // ---- ctrl+p 命令面板 (输入 /) ----
  if (key.ctrl && key.name === 'p' && !state.running) {
    state.currentInput = '/';
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
    }
    render();
    return;
  }

  // ---- Esc 清空输入 / 取消等待 ----
  if (key.name === 'escape') {
    state.currentInput = '';
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
    if (key.name === 'return' || key.name === 'enter') {
      if (filtered.length > 0) {
        executeGuideCommand(filtered[state.guideIndex][0]);
      } else {
        state.currentInput = '';
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
        state.currentInput = '';
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
          executeGuideCommand(input);
        } else {
          state.currentInput = '';
          state.log(`◍ 未知命令: ${input.split(' ')[0]} — 输入 / 查看命令面板`);
          render();
        }
      } else {
        // 普通文字: 单模型调用 (初始模型直接对话)
        state.currentInput = '';
        if (!state.running) await runSingleModel(input);
      }
    }
    return;
  }

  // ---- 退格 ----
  if (key.name === 'backspace') {
    state.currentInput = state.currentInput.slice(0, -1);
    state.guideIndex = 0;
    render();
    return;
  }

  // ---- 普通字符 ----
  if (str && !key.ctrl && !key.meta && !state.running) {
    state.currentInput += str;
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

module.exports = { startTUI, getState: () => state };
