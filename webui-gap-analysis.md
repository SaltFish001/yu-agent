# yu-agent Web UI — Gap Analysis Report

> Generated: analysis of `~/yu-agent/`  
> Files examined: `webui/server.ts`, `webui/demo.html`, `webui/assets/client.ts`, `webui/assets/client.js`, `webui/assets/style.css`, `extension/topic.ts`, `extension/types.ts`, `tests/webui-e2e.test.ts`

---

## 1. Current Web UI Features (What Exists)

### 1.1 Server Infrastructure (`webui/server.ts`)
| Endpoint | Method | Function |
|---|---|---|
| `/` | GET | Serves `demo.html` (chat interface) |
| `/assets/*` | GET | Static file serving (CSS, JS) |
| `/api/status` | GET | JSON snapshot: version, uptime, memory, tools, rules |
| `/api/chat` | POST | Sends message to AgentLoop, returns result |
| `/api/topics` | GET | Lists all topics + active topic name |
| `/api/topic/:name` | GET | Topic detail: info + file tree + git diff |
| `/events` | GET | SSE push for `agent_complete` events |
| `/ws` | GET (upgrade) | WebSocket push for status every 2s, ping/pong |

### 1.2 Frontend (`demo.html` + `client.ts` + `style.css`)
- **Chat interface** with message bubbles for user/assistant/system roles
- **Markdown renderer**: code blocks, inline code, bold, lists, links
- **Typing indicator**: animated dots during agent response
- **Empty state**: suggestions (help, doctor, topic list, status)
- **Sidebar** with:
  - Version label + connection status badge (online/offline)
  - System stats: uptime, RSS memory
  - **Topic list** (first 6 items, clickable to load detail into chat)
  - Topic count badge
  - Placeholder sections for Rules, Tools, Memories
  - Clear / New chat buttons
  - Request/iteration counter
- **WebSocket reconnection** (3s retry)
- **SSE connection** for `agent_complete` events
- **Topic list polling** every 10s
- **Responsive layout** (sidebar collapses at 720px)

### 1.3 Existing Topic Display
- Topic list rendered in sidebar with status icons (▶ active, ⏳ background, ○ idle) and turn counts
- Clicking a topic fetches detail from `/api/topic/:name` and **dumps it as a system message** in the chat pane — file tree, git status, and diff all rendered as markdown in a chat bubble

---

## 2. Topic System Capabilities (Available but Not Exposed in UI)

The topic backend (`extension/topic.ts`) is rich, but the Web UI only uses **read-only** endpoints:

| Feature | CLI available? | Web UI available? |
|---|---|---|
| List topics (with/without archived) | ✅ `yu topic list [-a]` | ✅ `GET /api/topics` |
| Get topic detail | ✅ `yu topic list <name>` | ✅ `GET /api/topic/:name` |
| Get active topic | ✅ via `list` | ✅ via `/api/topics` |
| **Create topic** | ✅ `yu topic new <name> <dir>` | ❌ No API endpoint |
| **Switch active topic** | ✅ `yu topic switch <name>` | ❌ No API endpoint |
| **Rename topic** | ✅ `yu topic rename <old> <new>` | ❌ No API endpoint |
| **Archive topic** | ✅ `yu topic archive <name>` | ❌ No API endpoint |
| **Start background task** | ✅ `yu topic bg <name> <prompt>` | ❌ No API endpoint |
| **View background status** | ✅ `yu topic status` | ❌ No API endpoint |
| **View events** | ✅ `yu topic events [name]` | ❌ No API endpoint |
| **Set summary** | ✅ (internal API) | ❌ No API endpoint |
| **Topic file tree** | N/A | ✅ `GET /api/topic/:name` |
| **Git diff per topic** | N/A | ✅ `GET /api/topic/:name` |

The `Topic` schema stores: `id`, `name`, `dir`, `summary`, `status` (ExtendedTopicStatus — idle/active/background/spawning/spawn_failed/restarting/degraded), `turns`, `lastActive`, `createdAt`, `archived`, `pid`, `cmd`, `startedAt`. The UI only renders `name`, `status`, `turns`, and `archived`.

---

## 3. Gap Analysis: Missing Features (Prioritized)

### 🔴 P0 — Must Have (Topic Management)

#### GAP-1: No Topic Management Panel
- **What exists**: Topics listed in sidebar (first 6); clicking one dumps a wall of text into chat
- **What's expected**: A dedicated panel/modal/drawer showing topic details in structured layout
- **User demand**: "open child windows to show topics" — users want a separate view, not chat-clutter
- **Impact**: High. Topic inspection currently pollutes the conversation history

#### GAP-2: No Topic CRUD from UI
- **What exists**: Topics are read-only in UI; all mutations require CLI
- **Expected**: Buttons/forms to create, switch, rename, archive topics directly from Web UI
- **Backend blocker**: Missing API endpoints for `POST /api/topics`, `POST /api/topics/:name/switch`, `POST /api/topics/:name/rename`, `POST /api/topics/:name/archive`
- **Impact**: High. Users cannot manage topics without dropping to terminal

#### GAP-3: No Active Topic Indicator in Header
- **What exists**: Active topic highlighted in sidebar list; separate "话题" section shows "已连接"
- **Expected**: Prominent active topic badge in the sidebar header or main toolbar, with the ability to switch quickly
- **Impact**: Medium. Hard to tell what context the agent is operating in

### 🟡 P1 — Should Have (Display/UX Improvements)

#### GAP-4: Topic Detail Dumped as Chat Noise
- **What exists**: `showTopicDetail()` fetches detail and pushes it as a `role: 'system'` message into the chat array, rendered as a markdown-formatted wall of text
- **Expected**: A modal overlay, slide-out drawer, or separate pane for topic inspection — leaving chat history clean
- **Impact**: High. In a multi-topic workflow the chat becomes unusable quickly

#### GAP-5: Topic List Truncated Without Expansion
- **What exists**: Only 6 topics shown; "+N more" text is non-interactive
- **Expected**: Expandable list, "show all" toggle, search/filter input
- **Impact**: Medium. Users with >6 topics cannot see them all

#### GAP-6: No Topic Status Visualization
- **What exists**: Simple text status icon (▶/⏳/○)
- **Expected**: Color-coded badges, progress spinners for background tasks, error states for spawn_failed/degraded/dead
- **Topic system supports**: `spawning`, `spawn_failed`, `running`, `degraded`, `disconnected`, `dead`, `restarting`, `stopped` — none visually differentiated in UI
- **Impact**: Medium. Users have no visibility into background task health

#### GAP-7: No Background Task UI
- **What exists**: CLI-only (`yu topic bg`, `yu topic status`)
- **Expected**: UI to start a background task on a topic, monitor progress, see logs, cancel running tasks
- **Backend has**: Full supervisor daemon, IPC events, child_processes table with pid/parent_pid/status/restart_count/last_heartbeat
- **Impact**: Medium. One of the key features of the topic system is invisible in Web UI

### 🟢 P2 — Nice to Have (Polish)

#### GAP-8: Topic Data Not Polled After Chat Completion
- **What exists**: `fetchTopics()` runs every 10s on a setInterval
- **Expected**: Refresh topic list (especially turn counts and status) after each `/api/chat` response
- **Impact**: Low. Current polling works but has stale windows

#### GAP-9: No Conversation Persistence
- **What exists**: Messages are in-memory only in `state.messages` array
- **Expected**: Session history backed to localStorage or server-side; survive page refresh
- **Impact**: Medium. Losing chat on refresh is frustrating

#### GAP-10: Sidebar Sections Are Empty (Rules, Tools, Memories)
- **What exists**: Sections labeled "规则", "工具", "记忆" with static placeholder text
- **Expected**: Live rendering with expand/collapse; tools get icons/descriptions; rules show trigger→action; memories show content previews
- **Note**: `/api/status` returns tools and rules data, but client only reads `version`, `uptime`, and `memory`
- **Impact**: Low. Sections exist but don't work — worse than not having them

#### GAP-11: Input Area Lacks Topic Context
- **What exists**: Plain text input with placeholder "输入消息..."
- **Expected**: Show active topic name in input bar or as a badge; maybe a topic selector dropdown
- **Impact**: Low. Nice polish for multi-topic workflows

#### GAP-12: No Keyboard Shortcuts
- **What exists**: Only Enter to send
- **Expected**: `Ctrl/Cmd+N` for new chat, `Ctrl/Cmd+K` for command palette, `Ctrl/Cmd+.` to toggle sidebar, `Escape` to close modals
- **Impact**: Low. Power-user quality-of-life

#### GAP-13: "New Chat" and "Clear" Do the Same Thing
- **What exists**: Both buttons call `clearChat()` with different confirmation text
- **Expected**: "New Chat" could start a fresh session (eventually persisted), "Clear" just wipes the current display
- **Impact**: Low. Confusing but functionally identical

#### GAP-14: Mixed Language Labels
- **What exists**: Sidebar mixes English ("Uptime", "RSS") with Chinese ("主题", "话题", "工具", "记忆") and the 404 page uses Chinese
- **Expected**: Consistent language choice or i18n support
- **Impact**: Low. Cosmetic

#### GAP-15: No Error Retry on Topic Fetch
- **What exists**: `fetchTopics()` silently catches all errors and leaves stale data
- **Expected**: Retry logic with exponential backoff, toast notification on failure
- **Impact**: Low. Silent failures hide network issues

#### GAP-16: No Responsive Topic Support
- **What exists**: At <720px, the entire sidebar collapses to 48px (hidden content)
- **Expected**: A hamburger menu or slide-out drawer for topic access on mobile
- **Impact**: Low. Mobile is secondary

---

## 4. Topic Display Design Suggestions

### 4.1 Topic List Sidebar Enhancements
```
┌─────────────────────────────────────┐
│ 主题  [▼]                    [3]    │  ← collapsible, shows count
├─────────────────────────────────────┤
│ ▶ my-coding-project    [12t]   📦   │  ← active, turn count, archived icon
│ ○ new-feature          [3t]         │  ← idle
│ ⏳ long-task           [--]    ⟳    │  ← background (spinner)
│ 🔴 crashed-task        [0t]    ⚠    │  ← error status (degraded/dead)
│ ... 3 more (+ show all)             │  ← expandable
└─────────────────────────────────────┘
```

Features:
- Color-coded status badges (green=active, blue=background, gray=idle, red=error)
- Expandable list with "Show all" link
- Right-click context menu or inline action icons (switch, rename, archive)
- Archived topics in a separate collapsed subgroup
- Hover tooltip showing summary + last active timestamp

### 4.2 Topic Detail "Child Window" / Slide-Out Panel

```
┌─────────────────────────────────────────────────────┐
│  📁 topic-name                           [✕]      │  ← close button
│  ───────────────────────────────────────────────── │
│  Status: ▶ active                                    │
│  Created: 2024-06-15 · 12 turns · last active: 2h ago│
│  Dir: ~/projects/my-app                              │
│  Summary: Working on the new auth feature             │
│  ───────────────────────────────────────────────── │
│  📄 Files (23)                                       │
│  ┌──────────────────────────────────────┐            │
│  │ 📁 src/                              │            │
│  │   📁 components/                     │            │
│  │     📄 App.tsx        (2.3 KB)       │            │
│  │     📄 Header.tsx     (1.1 KB)       │            │
│  │   📄 main.tsx         (0.8 KB)       │            │
│  │ 📄 package.json       (0.5 KB)       │            │
│  └──────────────────────────────────────┘            │
│  🔄 Git: a1b2c3d "feat: add auth"                    │
│     ↓ 3 uncommitted files                            │
│  ───────────────────────────────────────────────── │
│  [Switch to this topic] [Rename] [Archive]          │
│  [Run background task...]                            │
└─────────────────────────────────────────────────────┘
```

Implementation approach:
- **Modal overlay** that appears on topic click (simple, works everywhere)
- **Slide-in drawer** from right side (more modern, keeps chat visible)
- Content rendered as structured HTML/CSS, NOT injected into chat
- File tree should be expandable/collapsible, not a flat list

### 4.3 Background Task Dashboard
```
┌─────────────────────────────────────────────────────┐
│  ⏳ Background Tasks (2/3 max)              [✕]   │
│  ───────────────────────────────────────────────── │
│  ○ my-project  [running 5m] ⟳  SpawnController    │
│    └─ Prompt: "Implement login flow"                │
│  ○ api-server  [running 12m] ⟳  SpawnController    │
│    └─ Prompt: "Build API endpoints"                 │
│  ───────────────────────────────────────────────── │
│  [New Background Task]                              │
└─────────────────────────────────────────────────────┘
```

### 4.4 Active Topic Badge in Main Toolbar
```
┌─────────────────────────────────────────────────────┐
│  yu-agent  v0.1.0  [● Online]                       │
│  ───────────────────────────────────────────────── │
│                        ▶ active: my-project [✕]    │  ← pill badge with quick-switch
└─────────────────────────────────────────────────────┘
```

---

## 5. Summary of API Changes Needed on Server

| New Endpoint | Method | Purpose |
|---|---|---|
| `/api/topics` | POST | Create a new topic |
| `/api/topics/:name/switch` | POST | Switch active topic |
| `/api/topics/:name/rename` | POST | Rename a topic |
| `/api/topics/:name/archive` | POST | Archive a topic |
| `/api/topics/:name/bg` | POST | Start background task |
| `/api/topics/:name/status` | GET | Get background task status |
| `/api/topics/:name/logs` | GET | Get background task logs |
| `/api/topics/:name/kill` | POST | Kill background task |
| `/api/topics/:name/events` | GET | Get topic events |

Each maps to existing functions in `extension/topic.ts`:
- `create(name, dir)` → `POST /api/topics`
- `switchTopic(name)` → `POST /api/topics/:name/switch`
- `rename(oldName, newName)` → `POST /api/topics/:name/rename`
- `archive(name)` → `POST /api/topics/:name/archive`

Plus new endpoints for supervisor integration (bg/kill/logs) would require importing from `extension/supervisor.ts` or `extension/topic.ts`'s `cmdBg` logic.

---

## 6. Quick-Win Improvements (Estimated Effort)

| # | Task | Effort | Impact |
|---|---|---|---|
| 1 | Add CRUD API endpoints to server.ts | 1-2 hrs | 🔴 High — unlocks all topic mutations from UI |
| 2 | Render topic detail in a CSS modal instead of chat | 3-4 hrs | 🔴 High — fixes the biggest UX pain |
| 3 | Add expand/collapse to topic list | 30 min | 🟡 Medium — removes N-item cap |
| 4 | Color-code topic status badges | 30 min | 🟡 Medium — better at-a-glance status |
| 5 | Refresh topics after chat completes | 15 min | 🟢 Low — reduces stale data window |
| 6 | Wire up tool/rule/memory sections from status data | 1-2 hrs | 🟢 Low — removes dead UI sections |
| 7 | Add background status section to sidebar | 2-3 hrs | 🟡 Medium — exposes supervisor features |

---

## 7. Conclusion

The Web UI has a solid foundation — real-time communication via WS+SSE, a clean visual style, and a working chat interface. The topic backend is **feature-complete** with full CRUD, events, supervisor integration, and background tasks. The disconnect is severe: **the Web UI only exposes read-only topic access, and even that is done poorly (detail dumped into chat).**

The user's expectation of "open child windows to show topics" maps directly to the need for a modal/slide-out topic detail panel and proper topic management controls. The top-3 priorities are:

1. **Add CRUD API endpoints** so the UI can create/switch/rename/archive topics
2. **Build a dedicated topic detail panel** (modal or drawer) instead of chat-injection
3. **Surface background task status** and provide task management from the UI

These three changes would transform the Web UI from "chat with basic topic awareness" to "full topic management interface" matching a user's reasonable expectations.
