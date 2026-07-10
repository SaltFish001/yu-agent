# yu-agent WebUI 优化计划

按优先级排列（P0=阻塞/错误，P1=功能缺失，P2=体验改进）。

## P0 — 必须修

### 1. 补 `--error` CSS 变量
- **文件**: `webui/frontend/src/styles/global.css`
- **位置**: `:root` 和 `[data-theme="light"]` 块中
- **改法**: 加 `--error: #ef4444;`（深色）和 `--error: #d32f2f;`（浅色）
- **涉及**: `.thinking-summary.tool-error`, `.thinking-step.tool-error` 使用了 `var(--error)` 但未定义

### 2. 浅色主题 `--accent` / `--accent-hover` 覆盖
- **文件**: `webui/frontend/src/styles/global.css`
- **位置**: `[data-theme="light"]` 块
- **改法**: 加 `--accent: #333; --accent-hover: #555;`
- **原因**: 浅色下沿用深色的 `--accent: #fff`，白底上不可见

### 3. 浅色主题 `--text-tertiary` 对比度
- **文件**: `webui/frontend/src/styles/global.css`
- **位置**: `[data-theme="light"]`
- **改法**: `--text-tertiary: #999` → `#777`（WCAG AA 3:1）
- **涉及**: placeholder、hint、label、status bar 等大量使用 `--text-tertiary` 的地方

### 4. `.topic-status` 重复定义修复
- **文件**: `webui/frontend/src/styles/global.css`
- **位置**: 113 行和 1510 行
- **改法**: 删除靠后的重复定义（1510-1515）
- **问题**: width 14px vs 16px，font-size 11px vs 10px 冲突

### 5. `.mention-pill` 重复定义修复
- **文件**: `webui/frontend/src/styles/global.css`
- **位置**: 296-310 行和 1004-1021 行
- **改法**: 合并为单一定义，删除重复
- **问题**: border-radius 3px vs 12px，background 不同

## P1 — 功能缺失

### 6. `:focus-visible` 样式
- **文件**: `webui/frontend/src/styles/global.css`
- **改法**: 在全局加 `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }`
- **涉及**: 所有 button 和 interactive 元素

### 7. Hover-only 控件键盘可访问
- **文件**: `webui/frontend/src/styles/global.css`
- **位置**: `.topic-term-btn` (138 行) 和 `.topic-hover-actions` (787 行)
- **改法**: 在 `.topic-item:focus-within` 时也显示这些控件

### 8. Settings Modal 死设置修复
- **文件**: `webui/frontend/src/components/SettingsModal.tsx`
- **问题**: 3 个设置不生效：模型选择器、最大迭代次数、Token 预算未发到服务端
- **改法**: 
  - 模型选择器: `defaultValue` → `value` + 状态绑定
  - 迭代次数: 写入 zustand store
  - Token 预算: 写 store 后发 API 到 `/api/config`

## P2 — 体验改进

### 9. i18n 覆盖管理面板
- **文件**: TopicsPanel.tsx, BgTasksPanel.tsx, RulesPanel.tsx, SkillsPanel.tsx, FileBrowserPanel.tsx
- **改法**: 把这些面板中的硬编码中文替换为 `t()` 调用，在 i18n.ts 中添加对应 key

### 10. 响应式基础
- **文件**: `webui/frontend/src/styles/global.css`
- **改法**: 加至少一个媒体查询 `< 768px` 时 sidebar 变为 `display: none` + hamburger 菜单

### 11. 首屏加载优化
- **状态**: 已有 loading overlay（`loading-overlay` + `loading-spinner`）
- **改法**: 确保所有异步面板都展示 loading 状态

---

**执行顺序**: 按 P0 → P1 → P2 依次执行。每个改动后运行 `bun run build` 验证编译。
