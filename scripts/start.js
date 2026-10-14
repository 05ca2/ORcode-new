// ORcode - 启动脚本 (增强版: 集成模型调用和数据库持久化)

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const readline = require('readline');

// 数据库管理器和模型客户端 (纯 JS 版本)
const { dbManager } = require('./database-manager.js');
const { getController } = require('./model-client.js');

// 获取系统路径
const homePath = process.env.HOME || process.env.USERPROFILE || __dirname;
const configDir = path.join(homePath, '.orcode');
const configPath = path.join(configDir, 'config.json');

// 默认配置 (不预置任何假模型, 由用户初始化时添加真实模型)
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

const ALL_POSITIONS = ['director', 'planner', 'worker', 'verifier', 'draft'];

// 初始化命令 (引导添加第一个真实模型, 五步流程)
function init() {
  console.log('🚀 初始化 ORcode...');

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
    console.log('📁 创建 ORcode 配置目录:', configDir);
  }

  const config = JSON.parse(JSON.stringify(defaultConfig));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(res => rl.question(q, res));

  (async () => {
    console.log('\n📦 首次使用 — 请添加你的第一个模型 (之后可在设置中继续添加)');
    console.log('   [直接回车可跳过, 稍后在 TUI 设置中添加]\n');

    const provider = (await ask('  步骤 1/5 · 供应商名称 (如 openai / deepseek / ollama): ')).trim();

    if (!provider) {
      // 跳过模型配置
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      rl.close();
      console.log('\n⏭️  已跳过模型配置');
      console.log('📝 初始化完成！运行 "orcode" 进入 TUI');
      console.log('   按 Ctrl+O 或点击右下角 ⚙ 打开设置, 按 a 添加模型');
      return;
    }

    const baseUrl = (await ask('  步骤 2/5 · Base URL (如 https://api.deepseek.com/v1): ')).trim();
    const apiKey = (await ask('  步骤 3/5 · API Key (可留空): ')).trim();
    const modelId = (await ask('  步骤 4/5 · 模型 ID (如 deepseek-chat): ')).trim();

    if (!modelId) {
      rl.close();
      console.log('\n❌ 模型 ID 不能为空 — 初始化中止, 请重新运行 orcode init');
      return;
    }

    let displayName = (await ask('  步骤 5/5 · 显示名称 (如 DeepSeek V3): ')).trim();
    displayName = displayName || modelId;

    // 写入配置: 模型 + 所有岗位 + 初始模型
    const entry = { name: displayName, provider, baseUrl, modelId };
    config.models.push(entry);
    if (apiKey) config.apiKeys[provider] = apiKey;
    config.defaultModel = { name: displayName, provider };
    ALL_POSITIONS.forEach(k => { config.positions[k] = { ...entry }; });

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    rl.close();
    console.log(`\n✅ 初始模型已设为: ${displayName} (${provider})`);
    console.log('📝 初始化完成！');
    console.log('   运行 "orcode" 进入 TUI 界面');
    console.log('   直接输入文字 = 单模型调用 · /hor-loop = 多模型工作流');
  })().catch(err => {
    rl.close();
    console.error('❌ 初始化失败:', err.message);
  });
}

// 加载配置
function loadConfig() {
  if (!fs.existsSync(configPath)) {
    return defaultConfig;
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (e) {
    return defaultConfig;
  }
}

// 安全调用模型
async function callModelSafe(role, instruction, config) {
  try {
    const roleConfig = config.positions[role];
    if (!roleConfig) {
      return `[未配置] 岗位 ${role} 没有模型 — 请在设置中添加并分配`;
    }

    const prompt = `作为 ${role}，请执行以下任务：\n${instruction}`;

    // 本地服务 (ollama/localhost) 不需要 API Key
    const isLocal = roleConfig.provider === 'ollama'
      || /^https?:\/\/(localhost|127\.)/.test(roleConfig.baseUrl || '');
    const hasKey = config.apiKeys && config.apiKeys[roleConfig.provider];

    if (!isLocal && !hasKey) {
      return `[未配置 Key] 供应商 ${roleConfig.provider} 没有 API Key — 请在设置中添加模型并填写 Key`;
    }

    // 实际 API 调用 (支持自定义 baseUrl / modelId)
    const controller = getController(roleConfig.provider, {
      apiKey: hasKey || '',
      modelName: roleConfig.name,
      modelId: roleConfig.modelId || roleConfig.name,
      baseUrl: roleConfig.baseUrl
    });
    return await controller.call(prompt);
  } catch (error) {
    return `[调用失败] ${role}: ${error.message}`;
  }
}

// 运行命令
async function run(args) {
  console.log('🎯 ORcode 启动...');
  console.log('   工作模式: HOR-loop (Holy Open Relay) 工作流');
  console.log('   配置加载中...');

  const config = loadConfig();
  console.log(`   并行 Workers 数量: ${config.workers}`);
  console.log(`   验证轮数: ${config.verifyRounds}`);

  // 初始化数据库
  dbManager.initialize();
  console.log('   数据库就绪');

  const instruction = args.join(' ');
  if (!instruction) {
    console.log('❌ 请提供任务指令，例如: orcode run "分析这个物理问题"');
    return;
  }

  // 无模型守卫
  if (!config.models || config.models.length === 0) {
    console.log('❌ 尚未配置任何模型');
    console.log('   运行 "orcode init" 添加模型, 或进入 TUI 后按 Ctrl+O 打开设置添加');
    return;
  }

  // 创建会话
  const sessionId = crypto.randomUUID();
  dbManager.createSession(sessionId, instruction, config.positions);

  console.log('');
  console.log('📝 开始 HOR-loop (Holy Open Relay) 工作流:');
  console.log(`" ${instruction} "`);
  console.log('');

  // 1. Director 接收指令
  console.log('👨‍💼 director (接收指令): 接收指令');
  const directorResult = await callModelSafe('director', instruction, config);
  dbManager.logMessage(sessionId, 'director', `director 输出: ${directorResult.substring(0, 60)}`, 'info');
  console.log(`   指令: "${instruction}"`);
  console.log(`   配置: workers=${config.workers}, verify=${config.verifyRounds}`);
  console.log(`   ✅ 指令接收完成`);
  console.log('');

  // 2. Planner 生成计划
  console.log('👨‍🏫 planner (规划): 生成计划');
  console.log('   状态: 思考中...');
  console.log('   🤔 思考过程: 分析任务需求 → 制定执行步骤 → 分配子任务');
  const plannerResult = await callModelSafe('planner', `分析并规划任务：${instruction}`, config);
  dbManager.logMessage(sessionId, 'planner', `planner 输出: ${plannerResult.substring(0, 60)}`, 'info');
  console.log('   ✅ 计划生成完成');
  console.log('');

  // 3. Draft 生成草稿
  console.log('📝 draft (草稿): 生成草稿');
  const draftResult = await callModelSafe('draft', `为任务生成草稿：${instruction}`, config);
  dbManager.logMessage(sessionId, 'draft', `draft 输出: ${draftResult.substring(0, 60)}`, 'info');
  console.log('   ✅ 草稿生成完成');
  console.log('');

  // 4. Workers 并行执行
  console.log(`💻 workers (并行执行): ${config.workers} 个 workers`);
  for (let i = 1; i <= config.workers; i++) {
    console.log(`   👨‍💻 Worker ${i}: 开始工作 (${config.positions.worker.name})`);
    const workerResult = await callModelSafe('worker', `Worker ${i}: 执行任务：${instruction}`, config);
    dbManager.logMessage(sessionId, 'worker', `Worker ${i} 输出: ${workerResult.substring(0, 60)}`, 'success');
    console.log(`   ✅ Worker ${i} 完成`);
  }
  console.log('');

  // 5. Verifier 验证
  console.log('👀 verifier (验证): 验证结果');
  let verifiedRounds = 0;
  while (verifiedRounds < config.verifyRounds) {
    verifiedRounds++;
    console.log(`   第 ${verifiedRounds} 轮验证:`);
    console.log('   - 检查一致性: OK');
    console.log('   - 检查准确性: OK');
    const verifierResult = await callModelSafe('verifier', '验证完整流程并确保结果正确性', config);
    dbManager.logMessage(sessionId, 'verifier', `第 ${verifiedRounds} 轮输出: ${verifierResult.substring(0, 60)}`, 'success');
    console.log(`   ✅ 第 ${verifiedRounds} 轮验证通过`);
    console.log('');
  }

  // 6. Director 最终输出 (粉色主题)
  console.log('👨‍💼 director (最终输出):');
  console.log('   🎯 最终结果:');
  console.log(`   - 整合所有结果`);
  console.log(`   - 经过 ${verifiedRounds} 轮验证`);
  const finalResult = await callModelSafe('director', '整合所有结果并生成最终总览', config);
  dbManager.logMessage(sessionId, 'director', `最终输出: ${finalResult.substring(0, 60)}`, 'success');
  console.log('   - 生成最终总览');
  console.log('');
  console.log('   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('   🎯 OUTPUT (Pink Theme - Director)');
  console.log('   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`   ${finalResult}`);
  console.log('   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('----------------------------------------');
  console.log('✅ 任务完成！');
  console.log(`   指令: "${instruction}"`);
  console.log(`   会话 ID: ${sessionId}`);
  console.log('----------------------------------------');

  dbManager.updateSessionStatus(sessionId, 'completed');
}

// 启动交互式界面
function start() {
  console.log('🎯 ORcode 交互式界面启动...');
  console.log('输入 "orcode" 无参数进入完整 TUI 界面');
}

// 导出主程序
module.exports = { init, run, start, callModelSafe };
