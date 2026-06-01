╔══════════════════════════════════════╗
║          yu-agent 快速上手           ║
╚══════════════════════════════════════╝

📁 代码：~/yu-agent/
📖 文档：~/yu-agent/README.md
🌐 仓库：https://github.com/SaltFish001/yu-agent

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 一、基础用法
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  yu <prompt>              # 一站式编程任务
  yu review <路径>          # 审查代码
  yu plan <任务描述>        # 生成实现计划
  yu chat                   # 交互式 REPL
  yu run <prompt>           # 直接调度器调用

  例：
    yu "给这个 README 加个中文版"
    yu review src/index.ts
    yu plan "给 scheduler 加重试机制"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 二、团队模式
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  yu team create <名称> 成员1:角色 成员2:角色 ...
  yu team list                              # 列出活跃团队
  yu team status <runId>                    # 查看团队状态
  yu team send <runId> <成员> <消息>         # 发送消息
  yu team task <runId> create <标题>         # 创建任务
  yu team shutdown <runId>                  # 结束团队

  例：
    yu team create my-team lead:architect coder:coding reviewer:review

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 三、快速示例
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  # 审查整个目录
  yu review ~/yu-agent/extension/scheduler.ts

  # 生成实现计划
  yu plan "用 Rust 写个 CLI 工具"

  # 团队审查
  yu team create review-team lead:architect security:security codequality:review
  yu team send review-team security "审查 extension/mcp-manager.ts 的安全性"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 四、项目结构
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  extension/
  ├── classifier.ts        # 意图分类
  ├── executor.ts          # agent 派发 + 并发控制
  ├── tracker.ts           # 状态追踪 + 决策
  ├── verifier.ts          # LSP 校验 + 测试
  ├── team-orchestrator.ts # 团队编排
  ├── scheduler.ts         # 主调度器 (143 行)
  ├── spawn.ts             # SessionPool
  ├── mcp-manager.ts       # MCP 管理
  ├── template.ts          # LLM 输出解析
  └── team/                # 团队子系统

  总代码量：~3500 行 TypeScript
  编译：npm run build
  类型检查：npm run typecheck
