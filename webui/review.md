# yu-agent WebUI 审查报告

审查日期: 2026-07-10
方法: 代码审查 + 浏览器交互测试 + 截图分析

## 布局一致性
- ✅ 聊天区所有水平组件（messages/input/status/quick-ref/topic-hint）均统一 680px max-width 居中
- ❌ Admin 面板内容区无 max-width 限制，拉伸至全宽

## 主题完整性
- ✅ `:root` 深色主题变量完整
- ❌ `[data-theme="light"]` 缺 `--accent` / `--accent-hover` 覆盖（浅色下白底白字不可见）
- ❌ `--text-tertiary: #999` 在浅色下对比度仅 2.8:1，不达标 WCAG AA
- ❌ `--error` CSS 变量被引用但从未定义（line 1283-1287）
- ❌ `#777` 硬编码在 reasoning 内容上（line 1257），浅色下仅 2.5:1

## 代码质量
- ❌ `.topic-status` 重复定义：line 113 vs line 1510，width 14px vs 16px 冲突
- ❌ `.mention-pill` 重复定义：line 296 vs line 1004，border-radius 3px vs 12px 冲突
- ❌ `.mention-pills` 重复定义：line 290 vs line 998
- ⚠️ `var(--error)` 未定义（line 1283, 1286）
- ❌ 零个 `:focus-visible` 样式
- ⚠️ 多处内联样式替代 CSS class（TerminalPanel/FileBrowserPanel/BgTasksPanel/SkillsPanel）

## 交互反馈
- ✅ 所有输入框有 `:focus` 样式（border-color 变亮）
- ✅ 所有按钮有 `:hover` 样式
- ❌ `.topic-term-btn` 和 `.topic-hover-actions` 默认 opacity:0/display:none，仅 hover 可见——键盘完全不可达
- ❌ 无 `:focus-visible` → 键盘用户无法感知焦点位置

## 响应式
- ❌ 零个 @media query。固定 260px sidebar + 680px content = 940px 最小宽度
- ❌ 无移动端触控适配

## i18n 覆盖
- ✅ Sidebar 按钮、搜索、settings modal、input placeholder、terminal panel 已 i18n
- ❌ 5/11 组件零 i18n 覆盖：TopicsPanel/BgTasksPanel/RulesPanel/SkillsPanel/FileBrowserPanel（全部硬编码中文）
- ❌ ChatPanel 状态栏（已连接/Token/迭代）硬编码

## Settings Modal
- ❌ 模型选择器 `defaultValue` 不受控，改了啥也不发生
- ❌ 最大迭代次数死输入，写了不存
- ❌ Token 预算只写 store 不发服务端
- ✅ 主题/语言/重启/版本 正常工作

## 可访问性
- ❌ 零个 `aria-label` 在 topic action 按钮和 quick-topic 按钮
- ❌ 无 focus trap（settings modal tab 会逃到浏览器 chrome）
- ❌ 颜色独占指示器（连接状态仅靠绿/红点，无文字/图标辅助）
- ⚠️ z-index 冲突：tooltip z-index 1000，modal overlay 200
