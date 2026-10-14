# ORcode 架构设计文档

## 🎯 设计目标

ORcode 采用 **HOR-loop 多模型工作流**，核心设计原则：

1. **Human-on-the-Loop (H)** - 人类在循环中监督
2. **On-demand Model Scheduling (O)** - 按需选择模型
3. **Reasoning & Reflection Loop (R)** - 持续推理与反思

## 🏗️ 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                     Orcli Interface                      │
│                  (CLI / TUI / API)                       │
└─────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────┐
│              HOR-loop Orchestrator                       │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐      │
│  │   H     │ │   O     │ │   R     │ │   L     │      │
│  │  Human  │ │On-demand│ │Reasoning│ │  Loop   │      │
│  │  Loop   │ │Model    │ │&Reflect │ │   Core  │      │
│  │         │ │Scheduler│ │   Loop  │ │         │      │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘      │
└─────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────┐
│                  Model Adapter Layer                     │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐        │
│  │GPT-4 │ │Claude│ │Ollama│ │Gemini│ │Local │        │
│  │      │ │      │ │      │ │      │ │Model │        │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘        │
└─────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────┐
│                  Tool & API Layer                      │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐        │
│  │ File │ │  DB  │ │  Cmd │ │ Net  │ │  IDE │        │
│  │      │ │      │ │      │ │      │ │      │        │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘        │
└─────────────────────────────────────────────────────────┘
```

## 🔄 HOR-loop 核心组件

### 1. H - Human-on-the-Loop (人类监督层)

#### 职责
- 提供人类监督接口
- 控制执行权限
- 管理确认阈值

#### 关键功能
```typescript
interface HumanLoopController {
  // 获取当前监督模式
  getMode(): 'hotl' | 'hitch' | 'autonomous'
  
  // 检查是否需要人类确认
  needsApproval(action: Action, confidence: number): boolean
  
  // 请求人类确认
  async requestApproval(action: Action): Promise<ApprovalResult>
  
  // 获取人类反馈
  async getFeedback(reflection: string): Promise<string>
}

// 监督模式枚举
enum SupervisionMode {
  // 热循环 - 每步都需要确认
  hotl = 'hotl',
  
  // 冷循环 - 仅在关键步骤确认
  hitch = 'hitch',
  
  // 自动 - 完全自主
  autonomous = 'autonomous'
}
```

### 2. O - On-demand Model Scheduler (按需模型调度)

#### 职责
- 模型路由和调度
- 性能监控和选择
- 成本优化

#### 路由策略
```typescript
interface ModelRouter {
  // 根据任务选择模型
  selectModel(task: Task): Promise<ModelInfo>
  
  // 获取可用的模型列表
  getAvailableModels(): ModelInfo[]
  
  // 执行模型调用
  async callModel(model: Model, prompt: string): Promise<string>
}

// 模型路由决策树
class ModelRouterImpl implements ModelRouter {
  async selectModel(task: Task): Promise<ModelInfo> {
    // 1. 分析任务类型
    const taskType = this.analyzeTaskType(task);
    
    // 2. 根据类型选择模型
    switch (taskType) {
      case 'creative-coding':
        return this.selectModelByType('GPT-4');
      case 'logical-reasoning':
        return this.selectModelByType('Claude');
      case 'math-calculation':
        return this.selectModelByType('Ollama/phi3');
      case 'text-summarization':
        return this.selectModelByType('OpenAI');
      default:
        return this.selectDefaultModel();
    }
  }
}
```

### 3. R - Reasoning & Reflection Loop (推理反思循环)

#### 职责
- 实现多轮推理和反思
- 检查错误和优化方案
- 自我改进

#### 反思循环机制
```typescript
interface ReflectionLoop {
  // 启动反思循环
  async run(initialThought: string, maxIterations: number): Promise<ReflectionResult>
  
  // 执行单轮反思
  async reflect(thought: string, feedback: string): Promise<string>
}

class ReflectionLoopImpl implements ReflectionLoop {
  async run(initialThought: string, maxIterations: number): Promise<ReflectionResult> {
    let currentThought = initialThought;
    const reflections = [];
    
    for (let i = 0; i < maxIterations; i++) {
      // 1. 分析当前思考
      const analysis = await this.analyze(currentThought);
      
      // 2. 获取反馈
      const feedback = await this.getFeedback(analysis);
      
      // 3. 反思和改进
      const improvedThought = await this.reflect(currentThought, feedback);
      
      // 4. 检查是否满意
      if (this.isSatisfactory(improvedThought)) {
        return { result: improvedThought, iterations: i + 1 };
      }
      
      reflections.push({ analysis, feedback, improvedThought });
      currentThought = improvedThought;
    }
    
    return { result: currentThought, iterations: maxIterations };
  }
}
```

## 📊 数据流设计

### 请求处理流程
```
用户命令 → CLI 解析 → HOR-loop 引擎 → 模型调用 → 工具执行 → 结果返回

详细流程:
1. 接收命令：orcode "创建上帝游戏"
2. 解析命令：提取意图、参数、模式
3. 选择模式：决定使用 HOR-loop 的哪个模式
4. 路由模型：选择最适合的模型
5. 执行任务：调用相应工具
6. 反思优化：多轮改进
7. 人类监督：按需确认
8. 返回结果
```

### 状态管理
```typescript
interface AgentState {
  sessionId: string;
  currentStep: number;
  totalSteps: number;
  humanLoopMode: SupervisionMode;
  selectedModel: ModelInfo;
  reflectionCount: number;
  lastAction: Action;
  confidenceScores: Map<string, number>;
}

class StateManager {
  private state: Map<string, AgentState> = new Map();
  
  async saveState(sessionId: string, state: Partial<AgentState>) {
    // 保存到 SQLite 数据库
  }
  
  async loadState(sessionId: string): Promise<AgentState> {
    // 从数据库加载
  }
  
  async clearState(sessionId: string) {
    // 清理状态
  }
}
```

## 🛠️ 工具层设计

### 工具抽象接口
```typescript
interface Tool {
  name: string;
  description: string;
  parameters: ZodSchema;
  
  // 执行工具
  execute(args: any): Promise<any>;
  
  // 检查权限
  checkPermission(): boolean;
}

// 文件工具
class FileTool implements Tool {
  name = 'file';
  description = '文件读写工具';
  
  async execute(args: { path: string, operation: 'read'|'write', content?: string }) {
    // 实现文件操作
  }
}

// 命令行工具
class CommandTool implements Tool {
  name = 'command';
  description = '执行系统命令';
  
  async execute(args: { cmd: string, sandbox?: boolean }) {
    // 实现命令执行（沙盒）
  }
}
```

## 🗄️ 数据存储设计

### SQLite 表结构
```sql
-- 会话表
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  human_loop_mode TEXT DEFAULT 'hotl',
  current_model TEXT
);

-- 任务表
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  instruction TEXT,
  result TEXT,
  model_used TEXT,
  reflection_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- 反思记录表
CREATE TABLE reflections (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  iteration INTEGER,
  thought TEXT,
  feedback TEXT,
  improved_thought TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

-- 权限配置表
CREATE TABLE permissions (
  id TEXT PRIMARY KEY,
  tool_name TEXT,
  permission_level TEXT DEFAULT 'ask',
  allow_list TEXT,  -- JSON array
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## 🎯 配置管理

### 配置文件结构
```json
{
  "horl_loop": {
    "mode": "hotl",
    "reflection_depth": 3,
    "approval_threshold": 0.7
  },
  "models": {
    "default": "ollama/phi3",
    "providers": {
      "openai": "sk-...",
      "claude": "...",
      "ollama": "http://localhost:11434"
    },
    "routing": {
      "creative-coding": "openai/gpt-4",
      "logical-reasoning": "claude-3",
      "math-calculation": "ollama/phi3"
    }
  },
  "permissions": {
    "file_write": "ask",
    "command_exec": "sandbox",
    "network_access": "ask"
  },
  "education": {
    "bilingual_terms": true,
    "favorite_subjects": ["Physics", "Economics"]
  }
}
```

## 🔐 安全设计

### 权限检查流程
```typescript
class PermissionChecker {
  async canExecute(action: Action): Promise<boolean> {
    const permission = await this.getPermission(action.tool);
    
    switch (permission.level) {
      case 'always':
        return true;
      case 'never':
        return false;
      case 'ask':
        return await this.requestUserApproval(action);
      case 'sandbox':
        return await this.checkSandboxSafety(action);
    }
  }
}

// 沙盒安全检查
class SandboxChecker {
  async isSafe(command: string): Promise<boolean> {
    const dangerous_patterns = [
      /rm\s+-rf\s+/,
      /format\s+c:\/\s*/,
      /dd\s+if=\/dev\/random/
    ];
    
    return !dangerous_patterns.some(pattern => pattern.test(command));
  }
}
```

## 📈 性能优化策略

### 1. 模型缓存
```typescript
class ModelCache {
  private cache = new Map<string, any>();
  
  async getOrCompute(key: string, compute: () => Promise<any>): Promise<any> {
    if (this.cache.has(key)) {
      return this.cache.get(key);
    }
    
    const result = await compute();
    this.cache.set(key, result);
    return result;
  }
}
```

### 2. 批处理
```typescript
class BatchProcessor {
  async processBatch(actions: Action[]): Promise<Result[]> {
    // 类似的操作批量处理
    // 减少网络开销
  }
}
```

### 3. 增量更新
```typescript
class IncrementalUpdater {
  async updateFile(path: string, changes: Change[]): Promise<void> {
    // 只更新变化的部分
  }
}
```

## 🚀 实现路线图

### Phase 1 - 核心框架 (Week 1-2)
- [ ] 基础 CLI 框架
- [ ] HOR-loop 主引擎
- [ ] 模型适配层基础
- [ ] 权限系统

### Phase 2 - 高级功能 (Week 3-4)
- [ ] 完整反思循环
- [ ] 多模型路由
- [ ] TUI 界面
- [ ] 数据库持久化

### Phase 3 - 教育集成 (Week 5-6)
- [ ] IGCSE 学科工具
- [ ] 双语术语系统
- [ ] 学习模式

### Phase 4 - 游戏开发 (Week 7-8)
- [ ] Godot 集成
- [ ] 游戏模板
- [ ] 出版社工具

## 📝 开发规范

### 代码风格
- 使用 TypeScript
- 遵循 ESLint 配置
- 保持函数简短（< 50 行）
- 充分的错误处理

### 单元测试
- 每个工具函数至少 2 个测试用例
- HOR-loop 引擎需要模拟测试
- 权限检查需要边界测试

### 文档
- 所有公开函数必须有 JSDoc
- 维护 CHANGELOG.md
- 更新使用示例

---
**版本**: 0.1.0  
**作者**: ORcode Team  
**更新日期**: 2026-10-12
