# yu-agent 四修计划: Skills / Tools / MCP / Roles — ✅ 已完成

## 状态
Phase 1-4 全部落地，对应 5 个 commit：

| Phase | 内容 | Commit |
|-------|------|--------|
| P1 Tools | `yu tool toggle` + enabled 状态 | `dac8ebd` |
| P2 MCP | 流式调用 + CLI add/rm/ls | `91a5b6d` |
| P3 Roles | Team 集成 (rules → agent type) | `a22f093` |
| P4 Skills | Store + CLI list/inspect/scan | `d7d7727` |

## 总估

| 模块 | 当前 | 目标 | 预估增量 | 优先级 |
|------|------|------|----------|--------|
| Tools | 🟡 | ✅ | ~400 LOC | P0 |
| MCP | 🟡 | ✅ | ~500 LOC | P0 |
| Roles | 🟡 | ✅ | ~600 LOC | P1 |
| Skills | ❌ | ✅ | ~500 LOC | P1 |

**总计增量:** ~2000 LOC | **测试增量:** ~300 expects

## Phase 0 — 基础类型 (预置)

单文件 `extension/types.ts` 定义四模块共享的类型：

```
SkillDef     (name/desc/prompt/tools/version)
RoleDef      (name/desc/extend/capabilities/systemPrompt)
ToolDef v2   (在原 ToolDef 上加 schema/auth/audit)
McpTransport (stdio | sse)
```

## Phase 1 — Tools 增强

| 任务 | 文件 | 说明 |
|------|------|------|
| 参数 Zod schema | tools/ 各文件 | 现有手写 → Zod 校验 |
| 动态加载 | tools/loader.ts | 扫描 ~/.yu/tools/*.ts |
| 审计钩子 | tools/audit.ts | before/after 调用日志 |
| 鉴权 | tools/auth.ts | role-based allow/deny |
| CLI | bin/yu.ts | `yu tool list/inspect/toggle` |

## Phase 2 — MCP 增强

| 任务 | 文件 | 说明 |
|------|------|------|
| SSE 传输层 | mcp-transport-sse.ts | fetch/EventSource 客户端 |
| Transport 抽象 | mcp-transport.ts | stdio/SSE 统一接口 |
| Resources | mcp-resources.ts | list/read + 注册 |
| Prompts | mcp-prompts.ts | list/get |
| 流式 call | mcp-stream.ts | ReadableStream 支持 |
| 协议握手补全 | mcp-manager.ts | notifications/initialized |
| CLI | bin/yu.ts | `yu mcp add/rm/ls` |

## Phase 3 — Roles

| 任务 | 文件 | 说明 |
|------|------|------|
| 角色注册 | roles/registry.ts | 文件扫描 ~/.yu/roles/*.yaml |
| 角色路由 | roles/router.ts | 根据 role 过滤可用工具 |
| 角色组合 | roles/compose.ts | extend 多角色 |
| Team 集成 | team/ | 角色挂载到 agent type |
| CLI | bin/yu.ts | `yu role list/create/edit` |

## Phase 4 — Skills

| 任务 | 文件 | 说明 |
|------|------|------|
| Skill 注册 | skills/registry.ts | 文件扫描 + 热加载 |
| Skill 定义 | skills/types.ts | name/desc/system/tools |
| Skill 执行 | skills/runner.ts | 挂载到 AgentLoop |
| Skill store | skills/store.ts | 本地索引 + 远程源 |
| CLI | bin/yu.ts | `yu skill list/install/create` |

## 实施顺序

```
Phase 0: 类型定义 → 基础骨架
Phase 1: Tools (动态加载 + 安全) → 最快可用
Phase 2: MCP (SSE + Resources + Prompts) → 扩展协议
Phase 3: Roles (依赖 Phase 1 的鉴权)
Phase 4: Skills (依赖全部上游)
```

## 不做

- ❌ Skill marketplace / 远程 store (Phase 4 后)
- ❌ MCP 全协议覆盖 (仅 tools/resources/prompts)
- ❌ 角色可视化编辑器 (仅 CLI)
