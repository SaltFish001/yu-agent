# Anchored Summary — yu-agent Web UI optimization

## Objective
- Optimize UI/UX of yu-agent Web UI (React SPA at `webui/frontend`). All phases 0–3 + two-window unification done. LATEST: homepage shows only 对话+主题; the other 6 panels (系统状态/后台/终端/文件/规则/技能) are **floating sub-windows**; the Dashboard overlap fixed + verified via Playwright. **ALL DONE & VERIFIED.**

## Important Details
- User directives: "不要在主页展示所有东西，展示对话和topic即可" + "系统状态子窗口部分组件重叠，使用playwright验证并修改"; earlier: "更换E2E方案，使用Playwright".
- Servers: backend `bun dist/yu.js ui` on **:9876** (serves `webui/frontend/dist`, restarted ~this session, has all fixes); Vite dev on **:5173** (proxies to :9876).
- E2E: **Playwright 1.61.1** at `/tmp/e2e/` (`e2e.mjs` legacy 21chk; `e2e2.mjs` new-arch 17chk; `diag.mjs`/`diagwin.mjs` overlap diagnostics; `smoke.mjs` 6-window smoke; `dbg*.mjs`). Chromium 1228. Both `:5173` and `:9876` pass.
- `mainView` state narrowed to `'chat' | 'topics'`. New `windows: SubWindow[]` + actions in store for floating sub-windows.
- User has NOT requested git commit; changes uncommitted.
- Test artifacts: `e2e-test-topic` + many `pw-<ts>` topics persist in `~/.yu/topics.db`; no `DELETE /api/topics/:name` route.

## Work State — ALL COMPLETE
- **Homepage = 对话 + 主题 only.** `App.tsx` NAV reduced to 2 items; added a "窗口" dropdown (portaled to `document.body`, `position:fixed`, right-anchored so it stays on-screen) listing the 6 window types → `openWindow(type)`.
- **Floating sub-window system.** New `components/SubWindow.tsx`: draggable (header mousedown), resizable (bottom-right handle, min 320×240), closable (✕), focus-on-click (z-index raise); renders the right panel by `type`. `store.ts`: `SubWindow` interface + `windows`/`windowSeq` + `openWindow` (dedupes by type, cascades position, sets z)/`closeWindow`/`focusWindow`/`moveWindow`/`resizeWindow`. `App.tsx` renders `{windows.map(w => <SubWindow .../>)}`. `CommandPalette.tsx`: replaced `setMainView('status')` with `openWindow('status')` + added a "窗口" group (6 launch entries). `Sidebar.tsx` footer 状态 button → `openWindow('status')`. `i18n.ts`: added `nav.windows`.
- **Dashboard overlap fix.** Root cause: ECharts gauge (`radius:'70%'`, `center:['50%','60%']` in an 80px box) drew a ring wider/taller than the box → ECharts clipped it (looked like it overlapped the card edge). Fixed gauge to `radius:'48%'`, `center:['50%','50%']`, smaller detail font; added `overflow:hidden` to `.card` (defensive — charts can never bleed into neighbors). Verified via Playwright: 0 overlapping components, 0 gauge-canvas overflow.
- **Window-menu clipping bug (found+fixed).** `.main-nav { overflow-x:auto }` clipped the dropdown; the `win-menu-backdrop` then intercepted all clicks. Fixed by rendering the menu in a React portal to `document.body` with `position:fixed` and anchoring its right edge to the button (clamped on-screen).
- **Stale `setMainView('status')` in Sidebar** → changed to `openWindow('status')` (would have been a TS error after narrowing `mainView`).
- **Earlier (prior sessions):** Sidebar TDZ + onMouseMove null-currentTarget fixes; SettingsModal Escape; `webui/server.ts` `getStatus()` fix; two-window unification.

## Verified (last run)
- `bun run build:ui` → `tsc -b` + vite build succeed (no type errors).
- `e2e2.mjs` (new architecture): **17/17 PASS** on both `:5173` and `:9876` (homepage nav=对话+主题; status opens as floating `position:absolute` sub-window; main view unchanged; no overlap; gauge fits; draggable; reopen dedupes; second window; resizable; closable; no console errors).
- `smoke.mjs`: all **6 window types open, 0 overlap, 0 errors** on `:5173`.
- Production `:9876` restarted with rebuilt bundle; `:9876/api/status` returns topics.

## No Pending/Blocked Items
- (none)

## Relevant Files
- `webui/frontend/src/components/SubWindow.tsx` — NEW floating draggable/resizable/closable window host.
- `webui/frontend/src/App.tsx` — NAV=对话/主题; 窗口 portal menu; renders `windows`.
- `webui/frontend/src/lib/store.ts` — `mainView:'chat'|'topics'`; `SubWindow`/`WindowType`; windows state + actions.
- `webui/frontend/src/components/CommandPalette.tsx` — `openWindow` + 窗口 group.
- `webui/frontend/src/components/Sidebar.tsx` — footer 状态 → `openWindow('status')`.
- `webui/frontend/src/components/Dashboard.tsx` — gauge fit fix.
- `webui/frontend/src/lib/i18n.ts` — `nav.windows`.
- `webui/frontend/src/styles/global.css` — `.win-menu*` (fixed/portal), `.sub-window*`, `.card{overflow:hidden}`.
- `/tmp/e2e/{e2e2,smoke,diagwin,diag,dbg}.mjs` — Playwright E2E/diagnostics.
- `webui/frontend/dist/` — rebuilt bundle served by `:9876`.
