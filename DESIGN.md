# yu-agent 设计文档（v8）

> DeepSeek 原生编程代理——调度器 + 多子 agent + 团队模式
>
> **v8 更新 (2026-06-16): Pi SDK 已完全移除**

---

## 重要说明

本文档部分内容来自 v7（Pi SDK 时代）。以下变更已落地：

| 变化 | 旧 | 新 |
|------|----|----|
| 运行时依赖 | Pi SDK (`@tintinweb/pi-subagents`) | 零外部依赖 (Bun 原生) |
| Agent 调度 | `spawnAgent()` → Pi SessionPool | `runAgent()` → AgentLoop (`agent-loop.ts`) |
| CLI 入口 | Pi `beforeChat` hook | 独立 `bin/yu.ts` + Web UI (`yu ui`) |
| 上下文管理 | Pi Session 持久化 | 自有 `context-manager.ts` (LLM 压缩 + token 计数) |
| 测试框架 | vitest | bun:test |
| 构建工具 | tsc | `bun build` (单二进制, 52 模块 320ms) |

本文档正文尚未逐节更新。上表为 v8 架构变更的权威参考。

---

## 一、架构定位

### 1.1 与 Pi 的关系（已解除）

~~yu-agent 是 Pi 的一个 extension~~

**现状:** yu-agent 是完全独立的项目。所有原 Pi 能力已被自有实现替代：

| 能力 | 当前实现 |
|------|---------|
| Session 持久化 + 分支 | `db.ts` (bun:sqlite) |
| 斜杠命令、技能系统 | CLI 路由 + 命令分发 |
| 子 agent 生命周期管理 | `agent-loop.ts` + `spawn.ts` (AgentLoop 代理) |
| 子 agent 并发执行 | `executor.ts` + `Promise.all` + 并发控制 |
| 自定义 agent 类型 | `bootstrap.ts` 内联注册 |
| 工具权限控制 | 工具注册时声明 (`tools/registry.ts`) |
| **意图识别 + 路由** | **`classifier.ts` + `scheduler.ts`** |
| **子 agent 系统 prompt** | **`prompts/` 目录** |
| **Team mode 编排** | **`team-orchestrator.ts`** |
| **代码库搜索** | **`tools/grep.ts` (ripgrep + fallback)** |

### 1.2 整体流程 (v8)

```
用户输入（CLI: `yu "fix login bug"` 或 Web UI）
    │
    ▼
classifier.ts — 意图分类
    │  ├── fast path (>200字 / "你是"模式) → pass_through
    │  └── LLM 调度器 (v4-flash) → 输出 JSON 规划
    │
    ├── pass_through → deepseek.js (直接 API 调用)
    │
    └── 编程任务 → scheduler.ts::executePlan()
           │
           ▼
    executor.ts — 按 parallel_groups 分组并发
           │
           ├── spawn.ts (AgentLoop 代理)
           │     └── agent-loop.ts::runAgent()
           │           └── LLM + tool use 循环
           │
           ├── 全部完成 → 收集 files_modified
           ├── diff review (git diff → 用户确认)
           ├── LSP 验证 (verifier.ts)
           ├── 测试运行 (verifier.ts)
           └── 决策持久化 (tracker.ts)
```

> 调度器 agent 是 LLM，只负责分类和输出 JSON 规划。
> 实际的 spawn 执行由 `executor.ts` + `spawn.ts` 完成，通过 `agent-loop.ts` 的 `runAgent()` 实现。
> 所有子 agent 走同一套 tool registry (`tools/registry.ts`)，无 Pi SDK 依赖。

### 1.3 自定义 Agent 类型

通过 `bootstrap.ts` 内联注册 7 种类型（默认模型 spawn 时可覆写）：

| Type | 工具 | 默认模型 | 用途 |
|------|------|---------|------|
| `coding` | terminal, read_file, write_file, patch, search_files, glob, grep | v4-flash | 编码 |
| `review` | read_file, search_files, glob, grep | v4-flash | 审查 |
| `plan` | read_file, search_files, search, glob, grep | v4-flash | 规划 |
| `lsp` | terminal (LSP) | v4-flash | LSP 诊断 |
| `commit` | terminal (git) | v4-flash | 提交 |
| `doc` | read_file, write_file | v4-flash | 文档 |
| `search` | terminal (CLI) | v4-flash | 搜索 |

配置方式（`bootstrap.ts` 启动时注册）：

```typescript
// extension/bootstrap.ts
import { registerTool } from './tools/registry.js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

function loadPrompt(name: string): string {
  const path = resolve(PROMPTS_DIR, `${name}.md`);
  return readFileSync(path, 'utf-8');
}

// Agent 类型注册为 data-driven 配置对象
const AGENT_TYPES = {
  coding: { model: 'v4-flash', tools: ['Bash', 'Read', 'Edit', 'Glob', 'Grep'], prompt: 'coding' },
  review: { model: 'v4-flash', tools: ['Read', 'Glob', 'Grep'], prompt: 'review' },
  // ...
};
```

> Agent 类型不通过外部 SDK 注册。`bootstrap.ts` 在启动时加载 prompt 文件后，类型配置由 `spawn.ts` → `agent-loop.ts` 在 `runAgent()` 时按需使用。
> spawn 时通过 `config.type` 选择 system prompt，通过 `config.model` 覆写默认模型。

### 1.4 Prompt 组织（9 个文件）

```
`~/yu-agent/prompts/`
├── scheduler.md         # 调度器自身 prompt
├── coding.md            # # Flash / # Pro 分节
├── review.md
├── plan.md
├── lsp.md
├── commit.md
├── doc.md
├── search.md            # 代码库搜索 + 网页搜索
└── team.md              # # Architect / # Coder / # Reviewer / # Searcher
```

---

## 二、调度器设计

### 2.1 入口 (v8)

入口是 `bin/yu.ts` CLI（或 Web UI 服务器 `yu ui`），不再经过任何外部 hook。

```
用户输入 (CLI / Web UI)
    │
    ▼
bin/yu.ts 路由
    ├── doctor, team, topic, search, graph, context, chat, ui → 直接处理
    └── 默认 → classifier.ts
           │
           ├── 非编程 (pass_through) → deepseek.js 直接 API
           │
           └── 编程 → scheduler.ts::executePlan()
                  │
                  ▼
              executor.ts → spawn.ts → agent-loop.ts::runAgent() → tool use
```

> 调度器 agent 不做编码、不改文件。它只做分类和输出 JSON 规划。
> `spawn.ts` 是 AgentLoop 的薄代理层，接收 `SpawnConfig` 后调 `agent-loop.ts::runAgent()`。
> 这样做的好处：无外部依赖，所有逻辑在进程内完成。

### 2.2 意图判断

调度器收到用户输入后（已确认是编程任务），v4-flash + max thinking 做分类。输出结构化 JSON：

```json
{
  "intent": "fix|add|review|refactor|search|commit|lsp|doc|team",
  "reasoning": "判断理由",
  "agents": [
    {"type": "coding", "model": "v4-flash", "id": "coding-a", "files": ["src/auth/login.ts"]},
    {"type": "coding", "model": "v4-flash", "id": "coding-b", "files": ["src/auth/register.ts"]}
  ],
  "parallel_groups": [["coding-a", "coding-b"], ["review"]],
  "dependencies": {"review": ["coding-a", "coding-b"]}
}
```

`model` 字段由调度器按以下规则决定：

- 默认 v4-flash + max thinking
- 以下条件触发 pro（v4-pro + max thinking）：
  - 用户输入含"仔细""深度""pro""完全审查"等指示词
  - 涉及 5+ 文件或跨模块改动
  - 涉及安全、认证、加密、支付等敏感模块
  - intent 为 refactor 或 team
  - review 任务标记为深度审查

hook 代码收到 JSON 后，按 `parallel_groups` 分组并发 spawn。

### 2.3 子 agent 输出格式

每个子 agent 的输出必须是以下格式的 JSON，放在 markdown 代码块中供调度器解析：

**coding agent 输出：**

```json
{
  "status": "success|partial|failed",
  "files_modified": ["src/auth/login.ts", "src/auth/types.ts"],
  "summary": "修复了 login 函数的类型错误，更新了对应的类型定义",
  "details": [
    {"file": "src/auth/login.ts", "change": "将 any 类型替换为 UserCredentials"},
    {"file": "src/auth/types.ts", "change": "新增 UserCredentials 接口"}
  ]
}
```

**review agent 输出：**

```json
{
  "status": "approved|changes_requested",
  "findings": [
    {"severity": "high", "file": "src/auth/login.ts", "line": 42, "message": "密码未加密传输"},
    {"severity": "low", "file": "src/auth/login.ts", "line": 15, "message": "变量命名不一致"}
  ]
}
```

**search agent 输出：**

```json
{
  "results": [
    {"source": "codebase|web", "path": "src/auth/login.ts", "line": 42, "snippet": "...", "title": "login() 定义位置"}
  ]
}
```

**lsp agent 输出：**

```json
{
  "status": "clean|fixed|unresolved",
  "errors_fixed": [{"file": "src/auth/login.ts", "error": "类型不匹配", "line": 42}],
  "errors_remaining": [{"file": "src/auth/login.ts", "error": "未使用的变量", "line": 10, "level": "warning"}]
}
```

**commit agent 输出：**

```json
{
  "status": "committed|nothing_to_commit",
  "hash": "abc123",
  "message": "fix(auth): 修复登录模块类型错误"
}
```

**doc agent 输出：**

```json
{
  "status": "success",
  "files_written": ["docs/auth.md", "src/auth/README.md"]
}
```

**team mode 每个角色输出同上。**

> 调度器根据 `status` 字段决定下一步：
> - review 的 `changes_requested` → 打回 coding
> - coding 的 `failed` → 报告用户
> - lsp 的 `unresolved` → 报告剩余 error

### 2.4 并行规则

**可并行：**
- 多文件独立修改 → 多个 coding agent（`Promise.all`）
- coding + search（边改边查）
- Architect + Searcher
- LSP 多文件验证
- 多模块并行 Coder
- 多模块并行 Reviewer

**串行：**
- Coder 必须等 Architect 出方案
- Reviewer 必须等 Coder 完成
- LSP 报错 → 串行修复（最多 2 轮）
- 测试失败 → 串行修复（最多 2 轮）

**依赖判定：** 调度器 agent 在 JSON 中用 `dependencies` 标明依赖关系，hook 代码据此确定执行顺序。

**并发上限：**
- 默认最多同时 4 个并发 sub-agent
- 可通过配置调整
- API 返回 429 时自动退避并降低并发数

### 2.5 派发与验证管线

```
Scheduler JSON 规划
    │
    ▼
hook 代码执行：
    │
    ├── 1. 按 parallel_groups 分组
    │      每组内 Promise.all 并发 spawn
    │
    ├── 2. 等所有 agent 返回 → 解析 JSON 输出 → 收集 files_modified
    │
    ├── 3. 对每个改动文件 spawn LSP agent（并行）
    │      error → 打回 coding 修复（最多 2 轮）
    │      传递上下文：上一轮的 files_modified + lsp 错误详情
    │
    ├── 4. 跑相关测试
    │      根据项目文件自动推导测试命令：
    │      - package.json + vitest → npx vitest run --changed
    │      - package.json + jest → npx jest --findRelatedTests
    │      - package.json + mocha → npx mocha (需指定测试文件)
    │      - pyproject.toml + pytest → poetry run pytest -x 或 uv run pytest -x
    │      - requirements.txt + pytest → pytest -x
    │      - 无法推导 → 跳过测试步骤，报告用户
    │      失败 → 打回修复（最多 2 轮）
    │
    ├── 5. 写 decisions.json
    │
    ├── 6. 汇总结果
    │      按子 agent 返回的 JSON 组装最终回复
    │
    └── 错误处理：
         - 任何子 agent 超时（maxTurns 耗尽）→ 标记为 failed，继续其他
         - spawn 失败 → 重试 1 次，仍然失败则降级
         - 调度器 agent 输出非法 JSON → 重试调度器（最多 2 次），仍失败报用户
         - 打回 coding 修复时，把上一轮的 lsp 错误详情传入 context.errors 字段
         - opencode-codebase-index 不可用 → 降级到 ripgrep（grep -r）
         - LSP 工具不存在 → 跳过 LSP 步骤，警告用户
```

### 2.6 Team mode 编排

```
Scheduler 输出 team JSON 规划
    │
    ▼
hook 代码执行：
    │
    ├── 创建共享目录 ~/yu-agent/data/temp/{task_id}/
    │      路径注入到每个 agent 的 context 中
    │
    ├── 并行 spawn Architect + Searcher
    │      ├── Architect → 写 plan.md（含模块分组）
    │      └── Searcher → 写 context.md
    │      超时时间：120 秒
    │
    ├── fs.watch 监听 plan.md 写入事件
    │      超时 → 标记失败，报告用户
    │
    ├── 读取 plan.md → 解析模块分组 → 按分组并发 spawn Coder
    │      每个 Coder 注入：plan.md 内容 + context.md 内容 + snapshot.json
    │
    ├── 全部 Coder 完成后，并发 spawn Reviewer
    │      每个 Reviewer 注入对应模块的改动
    │
    ├── Reviewer 返回 changes_requested
    │      → 打回对应 Coder 修改 → 对应 Reviewer 重审（最多 2 轮）
    │
    └── 汇总 → git diff 冲突检测 → 清理 temp
```

**冲突检测规则：**
- 同一文件被多个 Coder 修改不同区域 → git 自动合并
- 同一文件同一区域被多个 Coder 修改 → 标记冲突，由用户决策
- 无冲突 → 自动合并改动

**decisions.json 读写：**
- hook 代码启动时加载 decisions.json，注入到调度器和子 agent 上下文中
- 每次完成方向性决策后追加写入
- 同 session 同类请求先查 decisions，不重复决策

---

## 三、Agent 配置

### 3.1 AgentConfig 注册

在 `bootstrap.ts` 中以 data-driven 对象注册：

```typescript
// extension/bootstrap.ts
const AGENT_TYPE_CONFIGS: Record<string, AgentTypeConfig> = {
  coding: { model: 'v4-flash', tools: ['Bash', 'Read', 'Edit', 'Glob', 'Grep'], prompt: 'coding' },
  review: { model: 'v4-flash', tools: ['Read', 'Glob', 'Grep'], prompt: 'review' },
  plan:   { model: 'v4-flash', tools: ['Read', 'Glob', 'Grep', 'Web'], prompt: 'plan' },
  lsp:    { model: 'v4-flash', tools: ['Bash'], prompt: 'lsp' },
  commit: { model: 'v4-flash', tools: ['Bash'], prompt: 'commit' },
  doc:    { model: 'v4-flash', tools: ['Read', 'Edit'], prompt: 'doc' },
  search: { model: 'v4-flash', tools: ['Bash'], prompt: 'search' },
};
```

每种 type 的 systemPrompt 从 `prompts/` 对应文件加载。

### 3.2 spawn 接口

通过 `spawn.ts` 调 `agent-loop.ts::runAgent()`：

```typescript
// spawn.ts
import { runAgent } from './agent-loop.js';

const result = await runAgent(config.task, {
  systemPrompt: loadPrompt(config.type),
  maxIterations: Math.min(config.maxTurns ?? 30, 50),
  maxTokens: 8192,
});

// 返回 SpawnResult
return {
  response: result.output,
  totalTokens: result.totalTokens,
  cacheHitTokens: result.cacheStats?.cacheHitTokens,
  durationMs: Date.now() - startTime,
};
```

**关键约定：**
- 不走外部 SDK，没有 SessionPool
- 每次 spawn 新建 `runAgent()` 调用，用完即释放
- 上下文管理由 `context-manager.ts` 负责（LLM 压缩 + token 计数）
- 超时在 `spawn.ts` 外层控制，超时后 Promise reject

### 3.3 工具权限

| Agent Type | 可用的内置工具 |
|-----------|---------------|
| coding | Bash, Read, Edit, Glob, Grep |
| review | Read, Glob, Grep |
| plan | Read, Glob, Grep |
| lsp | Bash |
| commit | Bash |
| doc | Read, Edit |
| search | Bash |

权限在 AgentConfig 的 `builtinToolNames` 中控制。

---

## 四、Prompt 文件内容

### 4.1 Scheduler Prompt

```markdown
# Scheduler

你是 yu-agent 的调度器。v4-flash + max thinking，不做编码。不自称 AI。

## 第一阶段：判断是否为编程任务

判断用户输入是否为编程相关任务。

- 编程任务：修复 bug、添加功能、重构、审查代码、搜索代码、提交、文档、架构设计
- 非编程任务：聊天、日常问答、浏览、与编程无关的讨论

## 输出格式（非编程）

{"pass_through": true, "reasoning": "..."}

## 第二阶段：意图判断

如果判断为编程任务，继续分类意图和分配 agent。

## 意图 → Agent Type

- fix/add/refactor → coding
- review → review
- search → search
- commit → commit
- lsp → lsp
- doc → doc
- 多角色协作 → team

## 模式选择

默认 v4-flash + max thinking。以下条件使用 v4-pro + max：

- 用户说"仔细""深度""pro""完全审查"
- 涉及 5+ 文件或跨模块
- 涉及安全/认证/加密/支付
- intent 为 refactor 或 team
- review 需要深度审查

## 输出格式（编程）

{
  "intent": "...",
  "reasoning": "...",
  "agents": [{"type": "...", "model": "v4-flash|v4-pro", "id": "...", "files": [...]}],
  "parallel_groups": [["id-a", "id-b"], ["id-c"]],
  "dependencies": {"id-c": ["id-a", "id-b"]}
}

每个 agent 必须有唯一 id，parallel_groups 和 dependencies 用 id 引用。
```

### 4.2 coding.md

```markdown
# Coding Agent

你负责编写和修改代码。不自称 AI。

## 通用规则

- 读文件后再改，不凭空写
- 改完立即验证（跑 LSP 或终端检查）
- 删代码前确认调用者不受影响

## Flash（v4-flash + max thinking，单文件 / 小改动）

- 每次只改一个文件
- 用 patch 做精确替换
- 不改文件结构、不重构
- 改完立刻验证

## Pro（v4-pro + max thinking，多步 / 跨文件 / 重构）

- 先读所有相关文件，理解现有结构
- 出方案（几步，每步改什么）
- 按步骤执行，每步后验证
- 可能被 LSP 或 Reviewer 打回修改（最多 2 轮）
- 打回时优先修 error，不改逻辑范围
- 不自作主张增加方案外的功能

## 输出格式

将以下 JSON 放在 markdown 代码块中作为最后输出：

{"status": "success|partial|failed", "files_modified": [...], "summary": "...", "details": [...]}
```

### 4.3 review.md

```markdown
# Review Agent

你负责审查代码，只读不改。不自称 AI。

## Flash（v4-flash + max thinking，快速扫描）
- 逻辑正确性
- 边界情况
- 明显安全漏洞

## Pro（v4-pro + max thinking，深度审查）
- 安全、性能、兼容性、可维护性
- 每条问题附严重等级（high/medium/low）

## 输出格式

{"status": "approved|changes_requested", "findings": [{"severity": "...", "file": "...", "line": N, "message": "..."}]}
status 为 approved 时 findings 可为空。
```

### 4.4 search.md

```markdown
# Search Agent

你负责搜索信息。不做修改。不自称 AI。v4-flash + flash 思考等级。

## 代码库搜索（本地）
- opencode-codebase-index：语义搜索、符号定义/引用、全文搜索
  - 用法：`npx opencode-codebase-index search "用户认证逻辑"`
  - 索引：`npx opencode-codebase-index index`
- CodeGraph：call graph、影响分析、模块依赖
  - 用法：`npx @colbymchenry/codegraph callers src/auth/login.ts`
  - 影响分析：`npx @colbymchenry/codegraph impact src/auth/login.ts`
- 不可用时降级到 ripgrep：`rg "关键字" src/`

## 网页搜索（MCP）
- 通过 MCP web search server 搜索外部资料

## 初始化
- opencode-codebase-index：首次使用自动 npx 拉取
- CodeGraph：初次运行 npx @colbymchenry/codegraph install

## 输出格式

{"results": [{"source": "codebase|web", "path": "...", "line": N, "snippet": "...", "title": "..."}]}
```

### 4.5 lsp.md

```markdown
# LSP Agent

你使用 LSP 工具检查代码错误并自动修复。不自称 AI。

## 流程

1. 检测项目语言（tsconfig.json → tsc --noEmit / pyproject.toml → pyright）
2. 对目标文件跑 LSP 诊断
3. 只拦截 error 级别，不修 warning
4. 用 patch 修复，修完重跑确认
5. 如果 error 需要改其他文件，报告调度器处理

## 规则

- 不修 warning / style
- 没有 LSP server 时报错并跳过

## 输出格式

{"status": "clean|fixed|unresolved", "errors_fixed": [{"file": "...", "error": "...", "line": N}], "errors_remaining": [...]}
```

### 4.6 team.md

```markdown
# Team Mode

多角色协作，通过共享目录交换文件。不自称 AI。

## Architect
- 分析现有代码结构
- 出方案，在 {shared_dir}/plan.md 中标明模块分组
- 评估影响范围和风险

## Coder
- 从 {shared_dir}/plan.md 读取方案
- 按方案实现，不改范围
- 发现问题则暂停并报告

## Reviewer
- 审查方案和代码
- 每条审查至少找 3 个问题
- 对 high 等级必须给出证据

## Searcher
- 独立于其他角色运行
- 结果写 {shared_dir}/context.md

## 输出格式

各角色使用对应独立 agent 的输出格式（coding 输出 / review 输出）。
```

### 4.7 plan.md

```markdown
# Plan Agent

你负责出技术方案。只读不改。不自称 AI。

## Flash（v4-flash + max thinking，小改动）

方案控制在 200 字以内，包含：
- 改动范围（文件列表）
- 方案要点（2-5 条）
- 风险（如果有）

## Pro（v4-pro + max thinking，多方案对比）

- 需求理解（一句话）
- 方案对比（2-3 个方案，各含优缺点）
- 推荐方案及理由
- 改动清单（文件路径 + 改动类型）
- 影响范围（被影响的模块）
- 风险 & 回退方案

涉及模块分组的，在方案中标明独立 / 依赖关系。

## 输出格式

{"status": "complete", "summary": "...", "modules": [{"name": "...", "files": [...], "independent": true}], "risks": [...]}
```

### 4.8 commit.md

```markdown
# Commit Agent

你负责 git commit。不自称 AI。

## 流程

1. git diff --staged 或 git diff
2. 分析改动性质
3. 按 conventional commits 生成 message
4. git add → git commit

## 规则

- 不改代码、不 review
- 分支名含 issue 号则自动追加到 message 末尾

## 输出格式

{"status": "committed|nothing_to_commit", "hash": "...", "message": "..."}
```

### 4.9 doc.md

```markdown
# Doc Agent

你负责生成文档。不自称 AI。

## 任务

- 补 docstring / JSDoc
- 生成 Markdown 文档
- 更新 README

## 规则

- 写 What 和 Why，不写 How
- 保持已有风格
- 不改代码逻辑

## 输出格式

{"status": "success", "files_written": [...]}
```

---

## 五、项目结构

```
~/yu-agent/
├── extension/
│   ├── index.ts           # Pi extension 入口 → 注册 beforeChat hook
│   ├── scheduler.ts       # hook 处理函数 → JSON 解析 + spawn 编排 + 错误处理
│   ├── config.ts          # AgentConfig 定义（7 种类型注册）
│   └── template.ts        # 输出格式校验（校验各 agent 返回的 JSON）
├── prompts/
│   ├── scheduler.md
│   ├── coding.md
│   ├── review.md
│   ├── plan.md
│   ├── lsp.md
│   ├── commit.md
│   ├── doc.md
│   ├── search.md
│   └── team.md
├── data/
│   ├── decisions.json
│   └── temp/
└── package.json
```

**职责划分：**

| 文件 | 职责 |
|------|------|
| `index.ts` | 调用 `pi.registerHook('beforeChat', handler)` 注册 hook。入口文件 |
| `scheduler.ts` | 导出 `handler(userInput)`。内部逻辑：spawn 调度器 agent → 解析 JSON → spawn 子 agent → 处理结果 → 错误处理 |
| `config.ts` | 启动时加载 prompt 文件 → 注册 7 种 AgentConfig |
| `template.ts` | 校验各 agent 返回 JSON 是否符合格式定义，失败则要求重试 |

### package.json

```json
{
  "name": "yu-agent",
  "description": "Yu-agent programming agent dispatching for Pi",
  "pi": { "extensions": ["./extension/index.ts"] },
  "dependencies": {
    "@tintinweb/pi-subagents": "latest",
    "opencode-codebase-index": "latest",
    "@colbymchenry/codegraph": "latest"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": ">=0.74.0"
  }
}
```

安装方式：`pi install ~/yu-agent`（本地目录）或 `pi install npm:@scope/yu-agent`（npm 发布后）。
需在项目根目录创建 `.gitignore`，忽略 `data/` 目录。

---

## 九、监控面板

### 9.1 架构

```
yu-agent（独立 agent）
  │
  ├─ extension/status.ts  →  写入 ~/yu-agent/status/*.json
  │     （agents.json / mcp.json / lsp.json / team.json / summary.json）
  │
  └─ scripts/monitor.mjs  →  读取 status/*.json，终端实时仪表盘
       
       使用方式：
         node scripts/monitor.mjs          # 实时仪表盘（自动刷新）
         node scripts/monitor.mjs --once   # 单次快照
```

### 9.2 状态文件格式

每个文件都是独立的 JSON，按需写入。路径统一在 `~/yu-agent/status/`。

**agents.json**
```json
{
  "updatedAt": 1717000000000,
  "agents": [
    {
      "id": "scheduler",
      "type": "scheduler",
      "model": "v4-flash",
      "status": "completed",
      "goal": "classify intent & generate plan",
      "startedAt": 1716999900000,
      "durationMs": 3200
    }
  ]
}
```

其他文件格式见 `extension/status.ts` 的类型定义。

### 9.3 写入点

在 scheduler.ts 的关键生命周期调用 status 模块：

| 时机 | 调用 |
|------|------|
| handler 入口 | `resetTracker()` |
| scheduler agent 开始 | `trackAgent('scheduler', 'running')` |
| 每个 sub-agent 开始 | `trackAgent(id, 'running', { type, model, goal })` |
| sub-agent 完成/失败 | `trackAgent(id, 'completed'/'failed')` |
| LSP 验证开始/完成 | `trackAgent('lsp-verify', ...)` |
| 团队模式状态变化 | `writeTeamStatus({...})` |
| handler 结束 | `flushFinalStatus()` |

### 9.4 Todo

- [ ] MCP 服务器状态写入（需要从 MCP 子系统获取连接状态）
- [ ] LSP 服务器状态写入（需要从 LSP 子系统获取运行状态）
- [ ] 子 agent 实时进度条（近似 ETA）
- [ ] 历史快照对比


## 附录：近期变更

### 2026-06-01
- **修复**: scheduler.ts 调度器超时从 30s 改为 120s（`timeout: 30_000` → `AGENT_TIMEOUT_MS`），解决 `thinking: 'max'` + 30s 导致调度器频繁超时的问题
- **文档**: 新增 README.md
- **仓库**: 推送到 GitHub（SaltFish001/yu-agent）
