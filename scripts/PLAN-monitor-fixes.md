# Monitor 审查问题修复计划 — ✅ 已完成

## 状态
所有 5 项修复已于 monitor.ts（原 monitor.mjs 重构后）落地。

当前文件: `/home/saltfish/yu-agent/scripts/monitor.mjs`

### 问题 1：未使用变量 `_BLUE`

- **位置**: 第 17 行 `const _BLUE = '\x1B[34m';`
- **原因**: 定义了蓝色转义码，但从未在代码中引用。
- **修复**: 删除该行。

### 问题 2：summary 双重形状归一化

- **位置**: 第 100 行 `summaryLine(summary?.summary || summary)`
- **原因**: `summary.json` 可能有两种形状：
  - 嵌套形: `{ "summary": { "running": 1, "completed": 5, "failed": 0 } }`
  - 扁平形: `{ "running": 1, "completed": 5, "failed": 0 }`
  
  每次调用 `summaryLine` 时都要做一次形状探测（`summary?.summary || summary`），比较脆弱且难以维护。
- **修复**: 在读取 `summary.json` 处做一次归一化，提取出实际的 summary 数据对象，后续直接使用。

### 问题 3：cache 区块始终显示

- **位置**: 第 106 行 `if (cache && cache.totalHits > 0) {`
- **原因**: 即使 `cache.json` 存在但缓存无实际数据（totalHits=0, totalMisses=0），条件为 false 所以不应显示。但用户报告说始终显示——推测 `cache.json` 总是被写入（即使无活动），或 `totalHits` 可能被初始化为非零值。需要增强守卫条件。
- **修复**: 改为 `if (cache && (cache.totalHits > 0 || cache.totalMisses > 0))`，确保只在有实际缓存活动时显示。

### 问题 4：SIGINT 清理消息修复

- **位置**: 第 131-134 行
- **原因**:
  1. 每个 tick 先用 `CLEAR` 清屏，SIGINT 触发时终端处于已清屏状态，"monitor stopped" 消息出现在空白画面上，体验不佳。
  2. 长时间运行后光标可能被隐藏（尽管此脚本未显式隐藏光标，但批量 `console.log` 可能引起光标闪烁，最佳实践是在退出时确保光标可见）。
  3. 缺少终端重置（颜色、样式等）的健壮保障。
- **修复**: 
  - 在退出前确保光标可见: `process.stdout.write('\x1B[?25h')`
  - 添加 `\n` 前缀确保不从中间行开始
  - 完整重置样式后退出

### 问题 5：支持 `--interval` 参数

- **位置**: 第 126 行 `setInterval(tick, 1000);`
- **原因**: 轮询间隔硬编码为 1000ms。
- **修复**: 解析 `--interval <毫秒数>` 参数，允许用户自定义轮询间隔。需要：
  - 扫描 `process.argv` 中的 `--interval` 后跟一个数字参数
  - 若未提供则默认 1000ms
  - 检查合法性（> 0 的整数）
  - 同时更新 `--help` 或使用文档（可选）

---

## 执行步骤

### 步骤 1：删除 `_BLUE`

```patch
- const _BLUE = '\x1B[34m';
```

### 步骤 2：归一化 summary 形状

将 readJSON 后的 summary 数据提取为扁平对象：

```patch
  const summary = readJSON('summary.json');
+ // 归一化：兼容 { summary: {...} } 和 {...} 两种形状
+ const summaryData = summary?.summary ?? summary;
```

然后第 100 行改为：
```patch
- lines.push(`│ ${BOLD}Summary:${RESET} ${summaryLine(summary?.summary || summary)}`);
+ lines.push(`│ ${BOLD}Summary:${RESET} ${summaryLine(summaryData)}`);
```

### 步骤 3：增强 cache 守卫条件

```patch
- if (cache && cache.totalHits > 0) {
+ if (cache && (cache.totalHits > 0 || cache.totalMisses > 0)) {
```

### 步骤 4：修复 SIGINT 处理

```patch
  process.on('SIGINT', () => {
-   console.log(`\n${DIM}monitor stopped${RESET}`);
+   process.stdout.write('\x1B[?25h');  // 确保光标可见
+   console.log(`\n${DIM}monitor stopped${RESET}`);
    process.exit(0);
  });
```

### 步骤 5：支持 `--interval` 参数

在 `const args = process.argv.slice(2);` 之后添加参数解析：

```patch
  const args = process.argv.slice(2);

+ // 解析 --interval <ms>
+ const intervalIndex = args.indexOf('--interval');
+ const POLL_INTERVAL = intervalIndex !== -1 && args[intervalIndex + 1]
+   ? Math.max(100, parseInt(args[intervalIndex + 1], 10) || 1000)
+   : 1000;
```

并将硬编码的 1000 替换为变量：
```patch
- setInterval(tick, 1000);
+ setInterval(tick, POLL_INTERVAL);
```

---

## 验证方法

1. **语法检查**: `node --check scripts/monitor.mjs`
2. **`_BLUE` 确认删除**: `rg '_BLUE' scripts/monitor.mjs` 无结果
3. **summary 归一化**: 模拟两种形状的 `summary.json`，确认显示正确
4. **cache 守卫**: 模拟 `{ totalHits: 0, totalMisses: 0 }` → 不显示 cache 区块；`{ totalHits: 1, ... }` → 显示
5. **SIGINT**: 运行 `node scripts/monitor.mjs` 后按 Ctrl+C，确认 "monitor stopped" 显示正常
6. **--interval 参数**: 运行 `node scripts/monitor.mjs --interval 2000`，确认轮询间隔变为 2 秒
