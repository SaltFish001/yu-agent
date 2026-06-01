# yu-agent

> DeepSeek 原生编程代理——调度器 + 多子 agent + 团队模式  
> 基于 Pi + pi-subagents 构建

## 概述

yu-agent 是 Pi 的一个扩展，为 DeepSeek 系列模型提供**意图识别 → 子 agent 调度 → 并行执行 → LSP 校验 → 测试运行**的全链路编程代理能力。

### 核心能力

| 能力 | 说明 |
|------|------|
| **意图识别** | 调度器 agent 分类用户输入，自动判断编程/搜索/对话/团队等场景 |
| **并行子 agent** | 按依赖关系分组，最多 4 路并发执行 coding/review/search 等子 agent |
| **LSP 校验** | 自动对修改的文件做类型检查，最多 2 轮修复循环 |
| **测试运行** | 自动检测项目测试框架（vitest/jest/mocha/pytest）并执行 |
| **团队模式** | 4 阶段多 agent 协作：架构师+搜索 → 编码 → 审查 → 冲突检测 |
| **MCP 管理** | 子 agent 的 MCP server 生命周期管理（stdio JSON-RPC） |
| **状态追踪** | 实时写入 agent 状态到 JSON 文件，供外部监控读取 |
| **决策持久化** | 跨 session 的决策缓存，避免重复 LLM 调用 |

## 安装

```bash
# 作为 Pi 扩展安装
pi install yu-agent

# 或本地开发
git clone https://github.com/SaltFish001/yu-agent.git
cd yu-agent
npm install
npm run build
```

## 使用

### CLI

```bash
yu <prompt>                  # 一站式编程任务
yu review <path>             # 审查代码
yu plan <task>               # 生成实现计划
yu chat                      # 交互式 REPL
yu run <prompt>              # 直接调度器调用（绕过 Pi hooks）

# 团队模式
yu team create <name> <member:role...>
yu team list
yu team status <runId>
yu team send <runId> <to> <message>
yu team task <runId> <action> [...]
yu team shutdown <runId>
```

### 作为 Pi 扩展

在 Pi 的 `package.json` 中声明：

```json
{
  "pi": {
    "extensions": ["./node_modules/yu-agent/extension/index.ts"]
  }
}
```

## 架构

```
用户输入
    │
    ▼
Pi beforeChat hook 拦截
    │
    ├── spawn 调度器 agent（v4-flash）
    │      输出 JSON 规划 → hook 代码解析
    │
    ├── 非编程 → 放行给 Pi 原生
    │
    └── 编程 → hook 代码根据 JSON 调 SDK spawn 子 agent
                 按 parallel_groups 分组并发
                 → LSP 校验 → 测试运行 → 汇总 → 回用户
```

### 模块结构

```
extension/
├── index.ts         # Pi hook 入口，注册 scheduler + team mailbox hooks
├── scheduler.ts     # 核心调度器：意图分类、子 agent 派发、LSP、测试、团队模式
├── spawn.ts         # SessionPool 管理 + spawnAgent 入口
├── template.ts      # LLM 输出解析器（JSON/XML/代码块）
├── config.ts        # 8 种 agent 类型配置
├── status.ts        # JSON 文件状态写入器
├── mcp-manager.ts   # MCP server 进程生命周期管理
├── monitor.ts       # 轮询状态文件 → 写聚合快照
├── types.ts         # 公共类型定义
└── team/            # 团队模式子系统
    ├── types.ts     # Zod schema（TeamSpec/Message/Task/RuntimeState）
    ├── mailbox.ts   # 文件式异步消息队列
    ├── tasklist.ts  # 共享任务板
    ├── runtime.ts   # 运行时生命周期 + 状态机
    ├── registry.ts  # 团队规格持久化
    ├── session.ts   # TeamSession（mailbox poll + inject）
    ├── integration.ts # Pi hook 胶水
    └── index.ts     # CLI 命令分发
```

## 团队模式

yu-agent 支持完整的 4 阶段团队协作流程：

1. **Phase 1** — 架构师 + 搜索 agent 并行，输出 plan.md + context.md
2. **Phase 2** — 按模块并行创建 Coder agent，各自实现指定模块
3. **Phase 3** — Reviewer agent 并行审查，最多 2 轮修复循环
4. **Phase 4** — Git conflict 检测

团队成员通过文件式 mailbox 异步通信，运行时状态持久化到磁盘。

## 依赖

- [@earendil-works/pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) — 底层 AI agent runtime
- [@tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) — 子 agent 生命周期管理
- [zod](https://zod.dev) — 运行时类型校验

## License

MIT
