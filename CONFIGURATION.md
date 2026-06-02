# yu-agent 配置文档

## 目录

- [概述](#概述)
- [数据目录结构](#数据目录结构)
- [主配置文件 (~/.yu/config.json)](#主配置文件-yuconfigjson)
- [MCP 配置 (~/.yu/mcp.config.json)](#mcp-配置-yumcpconfigjson)
- [身份与人格配置 (~/.yu/personality.json)](#身份与人格配置-yupersonalityjson)
- [Prompt 文件](#prompt-文件)
- [环境变量](#环境变量)
- [内存子系统配置](#内存子系统配置)
- [扩展与高级配置](#扩展与高级配置)

---

## 概述

yu-agent 的所有数据和配置统一存储在 `~/.yu/` 目录下。大部分配置通过 JSON 文件管理，无需修改代码。

---

## 数据目录结构

```
~/.yu/
├── config.json              # 主配置文件（可选）
├── mcp.config.json          # MCP 服务器配置
├── personality.json         # 身份与人格配置文件
├── prompts/                 # Agent 类型系统提示词
│   ├── scheduler.md
│   ├── coding.md
│   ├── review.md
│   ├── plan.md
│   ├── lsp.md
│   ├── commit.md
│   ├── doc.md
│   ├── search.md
│   └── team.md
├── sessions.db              # SQLite 会话数据库
├── ring_memory.db           # SQLite 环形缓冲区记忆
├── facts.json               # 长期记忆（键值存储）
├── scene_state.json         # 场景状态（位置、服装、心情等）
├── agent/                   # Pi 运行时配置（内部使用）
├── status/                  # 监控面板状态文件
├── pool-sessions/           # Agent session 磁盘缓存
├── runtime/{runId}/         # 团队模式运行数据
├── teams/{name}/            # 已保存的团队规格
└── data/                    # 持久化调度决策
    ├── decisions.json
    └── temp/
```

---

## 主配置文件 (~/.yu/config.json)

可选的顶层配置文件。如果文件不存在，所有选项使用默认值。

### 配置结构

```json
{
  "identity": {
    "personalityPath": "personality.json"
  },
  "memory": {
    "overflowStrategy": "delete_oldest",
    "ringMaxEntries": 5000,
    "autoSave": true,
    "sceneTracking": true
  }
}
```

### 字段说明

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `identity.personalityPath` | string | `"personality.json"` | 人格配置文件的路径（相对于 `~/.yu/`） |
| `memory.overflowStrategy` | string | `"delete_oldest"` | 环形缓冲区溢出策略：`"delete_oldest"`（批量删除最旧条目）或 `"sliding_window"`（逐条删除） |
| `memory.ringMaxEntries` | number | `5000` | 环形缓冲区最大条目数 |
| `memory.autoSave` | boolean | `true` | 是否自动保存用户/助手消息到环形缓冲区 |
| `memory.sceneTracking` | boolean | `true` | 是否启用场景追踪 |

---

## MCP 配置 (~/.yu/mcp.config.json)

定义 MCP (Model Context Protocol) 服务器。每个服务器是一个独立的子进程，提供工具和资源给 agent 使用。

### 配置结构

```json
{
  "servers": {
    "web-search": {
      "command": "node",
      "args": ["path/to/mcp-server.js"],
      "env": {
        "API_KEY": "your-api-key"
      }
    },
    "database": {
      "command": "python",
      "args": ["-m", "mcp_database_server"],
      "env": {}
    }
  }
}
```

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `servers` | object | 是 | 服务器名称到配置的映射 |
| `servers.<name>.command` | string | 是 | 启动命令 |
| `servers.<name>.args` | string[] | 否 | 命令行参数 |
| `servers.<name>.env` | object | 否 | 环境变量 |

配置在启动时通过 Zod schema 校验，校验失败会打印错误并退出。

---

## 身份与人格配置 (~/.yu/personality.json)

定义 agent 的身份、风格和行为规则，通过 `identity.ts` 注入到系统提示词中。

### 配置结构

```json
{
  "name": "予鱼",
  "aliases": ["yu", "yu-agent", "quite_fish", "咸鱼"],
  "identity": "你叫予鱼，一条小咸鱼变的编程助手。你不是Pi，你是yu-agent。",
  "style": {
    "tone": "慵懒从容、干脆不废话、偶尔毒舌但靠谱",
    "first_person": "本鱼",
    "second_person": "你",
    "rules": [
      "本鱼会说人话，不说套话。",
      "本鱼不列清单不复述。",
      "本鱼说得出做得到，做不到就说做不到。"
    ]
  },
  "capabilities": {
    "agent_types": ["coding", "review", "plan", "search", "commit", "lsp", "doc", "general-purpose"],
    "description": "你会写代码、改bug、审查代码、出方案、搜代码、生成文档，还能派单给专门的小agent干活。"
  },
  "memory": {
    "ring_cap": 5000,
    "auto_save": true,
    "scene_tracking": true
  }
}
```

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | Agent 名称，注入到系统提示词开头 |
| `aliases` | string[] | 别名列表 |
| `identity` | string | 身份描述 |
| `style.tone` | string | 语气描述 |
| `style.first_person` | string | 自称 |
| `style.second_person` | string | 对用户的称呼 |
| `style.rules` | string[] | 行为规则列表 |
| `capabilities.agent_types` | string[] | 支持的 agent 类型 |
| `capabilities.description` | string | 能力描述 |
| `memory.ring_cap` | number | 环形缓冲区容量 |
| `memory.auto_save` | boolean | 自动保存消息 |
| `memory.scene_tracking` | boolean | 场景追踪 |

如果文件不存在，使用硬编码的默认值。

---

## Prompt 文件

`~/.yu/prompts/` 目录下的 Markdown 文件定义了每个 agent 类型的系统提示词。

### 文件清单

| 文件 | Agent 类型 | 说明 |
|------|-----------|------|
| `scheduler.md` | general-purpose | 调度器提示词，负责意图识别与任务分发 |
| `coding.md` | coding | 编程 agent，支持 Flash/Pro 两种模式 |
| `review.md` | review | 代码审查 agent，只读不改 |
| `plan.md` | plan | 技术方案 agent，只读不改 |
| `lsp.md` | lsp | LSP 诊断与自动修复 |
| `commit.md` | commit | git commit 信息生成 |
| `doc.md` | doc | 文档生成 |
| `search.md` | search | 代码库搜索 + 网页搜索 |
| `team.md` | team | 团队模式角色提示词 |

### 自定义提示词

编辑对应的 `.md` 文件即可修改 agent 行为。修改后重启 yu-agent 生效。

---

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `YU_SESSION_ID` | 会话标签（手动设置可复用会话） | 自动生成 |
| `YU_PROJECT_DIR` | 项目目录 | `process.cwd()` |

---

## 内存子系统配置

内存子系统由三个组件构成：

| 组件 | 存储方式 | 位置 | 容量 |
|------|---------|------|------|
| Ring 缓冲 | SQLite | `~/.yu/ring_memory.db` | 默认 5000 条目 |
| Facts 存储 | JSON 文件 | `~/.yu/facts.json` | 无硬限制 |
| Scene 状态 | JSON 文件 | `~/.yu/scene_state.json` | 单文件 |

### 溢出策略

Ring 缓冲支持两种溢出策略：

- **`delete_oldest`**（默认）：当条目数超过上限时，批量删除最旧的超量条目。适合批量处理场景。
- **`sliding_window`**：每次插入前删除一条最旧条目，保持条目数恒定。适合实时性要求高的场景。

策略通过 `~/.yu/config.json` 的 `memory.overflowStrategy` 字段配置。

---

## 扩展与高级配置

### Pi 扩展列表

在 `package.json` 的 `pi.extensions` 中定义：

```json
{
  "pi": {
    "extensions": [
      "./extension/identity.ts",
      "./extension/session-store.ts",
      "./extension/resumer.ts",
      "./extension/session-cmd.ts",
      "./extension/monitor.ts",
      "./extension/memory-plugin.ts",
      "./extension/index.ts"
    ]
  }
}
```

### 健康诊断

运行 `yu doctor` 可一键检查所有子系统状态，包括：
- 数据目录完整性
- MCP 配置文件
- Prompt 文件
- 内存子系统（Ring / Facts / Scene）
- 会话数据库

---

> 最后更新：2026-06-02
