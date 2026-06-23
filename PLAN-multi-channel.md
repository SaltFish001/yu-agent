# Multi-Channel Architecture — yu-agent — ✅ Phase 0-4 已完成

## 状态

| Phase | 内容 | 状态 | Commit |
|-------|------|------|--------|
| P0 | Event Hub 内存 pub/sub（events.ts） | ✅ 已有 | 前置已有 |
| P1 | 多面板 Web UI（4 面板切换 + 侧栏） | ✅ | `25fd03b` |
| P2 | EventBus → WebSocket 事件桥 | ✅ | `264b806` |
| P3 | 定时器管道 + 状态拉取（心跳/降级/增量/字段过滤） | ✅ | `92b664f` |
| P4 | 面板拖拽/缩放/样式 | ✅ | `d152137` |
| P5 | 外部通道桥接 | ❌ 未做（不在需求内） | — |

## 现状分析

| 已有 | 缺失 |
|------|------|
| WebSocket 状态推送 (2s) | 无 channel 抽象层 |
| SSE 事件推送 | 无主动推送通道分级 |
| 事件表 (topics.db/events) | 无定时器 → 事件管道 |
| 单向聊天 UI | 无多面板/子窗口 |
| 独立 CLI 命令 | 无统一路由 |

## 推荐架构

```
┌──────────────────────────────────────────────────┐
│                  Event Hub                        │
│  (Memory pub/sub + SQLite 持久化)                  │
│  emit(topic, type, payload) → dispatch(channel)   │
└──────┬──────────┬──────────┬──────────┬──────────┘
       │          │          │          │
  ┌────▼───┐ ┌───▼────┐ ┌──▼────┐ ┌──▼──────┐
  │ Web UI │ │  CLI   │ │ Cron   │ │ Telegram│
  │ (CSR)  │ │ (term) │ │(定时器)│ │ (未来)  │
  └───┬────┘ └────────┘ └───────┘ └─────────┘
      │
  ┌───▼───────────────────────────────┐
  │  Multi-Panel Layout (CSR)         │
  │                                    │
  │  ┌─────────┐ ┌─────────┐          │
  │  │Dashboard│ │Topics   │          │
  │  │ (状态)  │ │ (列表)  │          │
  │  └─────────┘ └─────────┘          │
  │  ┌─────────┐ ┌─────────┐          │
  │  │Agent Log│ │Terminal │          │
  │  │ (实时)  │ │ (子进程)│          │
  │  └─────────┘ └─────────┘          │
  └────────────────────────────────────┘
```

## SSR vs CSR

**结论：CSR + SSR Shell（混合）**

| 维度 | SSR | CSR | 选择 |
|------|-----|-----|------|
| 首屏速度 | ✅ 快 | ❌ 需加载JS | SSR 首屏 |
| 实时更新 | ❌ 需刷新 | ✅ WebSocket直推 | CSR |
| 多面板独立状态 | ❌ 服务端维护 | ✅ 客户端维护 | CSR |
| 子窗口嵌入 | ❌ 服务端渲染复杂 | ✅ iframe/div嵌入 | CSR |
| 离线能力 | ❌ 全依赖服务器 | ✅ 部分缓存 | CSR |
| 开发复杂度 | ❌ 需JSX/Hono模板 | ✅ 纯JS | CSR |

**方案：**
1. SSR 渲染外壳（HTML布局 + CSS + WebSocket连接脚本）
2. CSR 渲染每个面板内容（通过 WebSocket 消息驱动）
3. 面板为独立组件，各自订阅不同事件类型
4. 无需前端框架，纯 WebSocket + DOM 操作

## Channel 设计

```typescript
enum Channel {
  WebUI   = 'webui',    // 浏览器界面
  CLI     = 'cli',      // 命令行输出
  Cron    = 'cron',     // 定时任务
  Telegram = 'telegram', // 外部推送
}

interface EventMessage {
  id: string
  channel: Channel | Channel[]  // 目标通道
  type: string                  // 'status' | 'agent:log' | 'topic:update' | ...
  payload: unknown
  timestamp: number
}
```

## 子窗口（Panel）设计

每个面板是一个独立的 CSR 组件：

| Panel | 数据源 | 更新频率 | 交互 |
|-------|--------|---------|------|
| Dashboard | WS channel:status | 2s | 展示 Uptime/RSS/规则数 |
| Topics | WS channel:topic | 事件驱动 | 列表/创建/切换 |
| Agent Log | WS channel:agent | 流式 | 实时输出 |
| Rules | WS channel:rule | 事件驱动 | 列表/触发 |
| Terminal | WS channel:terminal | 交互式 | 输入/输出 |

面板布局：可拖拽 Grid 或固定侧栏+主区（两栏或三栏）

## 定时器 → 事件管道

```
Cron Job ──emit──→ Event Hub ──dispatch──→ Channel WebUI
                                              ↓
                                        面板弹出通知
```

现有 cronjob 系统（Hermes 内置）+ 新增 `yu cron` 命令，事件写入 topics.db events 表，通过 WebSocket 推送到 UI 面板。

## 实现路径

```
Phase 0: Event Hub 抽象层（内存 pub/sub）
Phase 1: 多面板 Web UI 布局（Shell SSR + CSR Panels）
Phase 2: 面板内容绑定到事件通道
Phase 3: 定时器 → 事件管道
Phase 4: 子面板独立管理（拖拽/缩放/关闭）
Phase 5: 外部通道（Telegram 等）
```
