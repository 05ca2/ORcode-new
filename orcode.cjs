#!/usr/bin/env node
// ORcode - 命令行智能体工具 (CJS)
// 无参数时直接进入 TUI 交互界面

// 抑制 Node 内置 SQLite 的实验性警告 (避免污染 TUI 渲染)
// Node 的默认警告打印机本身是一个 'warning' 监听器，必须移除后只保留自定义过滤器
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning && warning.name === 'ExperimentalWarning' && /SQLite/.test(warning.message || '')) {
    return; // 吞掉 SQLite 实验性警告
  }
  // 其它警告照常打印
  process.stderr.write(`Warning: ${warning.name}: ${warning.message}\n`);
});

const path = require('path');
const fs = require('fs');

// 获取 scripts 路径
const scriptsDir = path.resolve(__dirname, 'scripts');
const { init, run } = require(path.join(scriptsDir, 'start.js'));

// 解析命令行参数
const args = process.argv.slice(2);
const command = args[0];

// 无参数 → 进入 TUI 界面
if (args.length === 0) {
  const { startTUI } = require(path.join(scriptsDir, 'tui.js'));
  startTUI().catch(err => {
    console.error('❌ TUI 启动失败:', err.message);
    process.exit(1);
  });
} else if (command === 'init') {
  init();
} else if (command === 'run') {
  const instruction = args.slice(1);
  run(instruction).catch(err => {
    console.error('❌ 执行失败:', err.message);
    process.exit(1);
  });
} else if (command === 'start' || command === 'tui') {
  const { startTUI } = require(path.join(scriptsDir, 'tui.js'));
  startTUI().catch(err => {
    console.error('❌ TUI 启动失败:', err.message);
    process.exit(1);
  });
} else if (args.includes('--version') || args.includes('-v')) {
  console.log('orcode 0.2.11');
} else if (args.includes('--help') || args.includes('-h')) {
  console.log(`
ORcode - Holy Open Relay 命令行智能体

用法:
  orcode              进入交互式 TUI 界面
  orcode init         初始化配置
  orcode run <指令>   运行单个任务
  orcode start        进入 TUI 界面

选项:
  --version, -v       显示版本
  --help, -h          显示帮助

HOR-loop 工作流:
  director → planner → draft → [workers × N] → verifier × M → output

更多信息: https://github.com/orcode/orcode
`);
} else {
  console.error('❌ 未知命令:', command);
  console.error('运行 "orcode --help" 查看用法。');
  process.exit(1);
}
