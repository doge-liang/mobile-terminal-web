# Session List + Per-Tab Sessions + Copy/Paste Cleanup — Design

Date: 2026-07-07
Component: mobile-terminal-web (frontend `public/app.js`, `public/index.html`, `public/style.css`; backend `server.js`)

## Motivation

Three related issues surfaced during desktop use:

1. **Copy/paste handlers conflict.** Layered clipboard code (custom `Ctrl+C`/`Ctrl+Shift+C`/`Ctrl+V` interception, OSC 52, buttons, native paste, desktop image-paste) fight each other: intercepting `Ctrl+V` suppresses the browser `paste` event (breaking image paste), and copy-on-selection `Ctrl+C` shadows the terminal interrupt.
2. **No session list.** Switching sessions is a bare `prompt()`; the user cannot see which tmux sessions exist on the server.
3. **Sessions are globally shared across tabs.** The current session name lives in `localStorage`, so every browser tab shares one session and a refresh cannot restore a tab's own session independently.

## Goals

- Remove clipboard conflicts; keep a single, predictable model.
- Add a session panel listing live server-side tmux sessions, with switch/create.
- Make each browser tab remember its own current session across refresh, plus a per-tab most-recently-used (MRU) quick-switch queue.

## Non-Goals

- Renaming/killing tmux sessions from the UI (YAGNI for now).
- Cross-device session sync.
- Changing the transport chain or auth.

## Design

### 1. Copy/paste cleanup (`public/app.js`)

- **Remove** the `term.attachCustomKeyEventHandler(...)` block that intercepts `Ctrl+C` / `Ctrl+Shift+C` / `Ctrl+V`.
- Result: `Ctrl+C` = terminal interrupt (native); `Ctrl+V` = native xterm paste; the document-level `paste` handler still fires for image paste.
- **Keep**: OSC 52 handler (select-to-copy in TUIs → system clipboard), the `⎘` copy button (selection or whole visible screen), the `⇥` paste button (Clipboard API), the `onSelectionChange` → `lastSelection` capture, and `clipWrite`/`clipRead`/`readVisible`/`doCopy`/`doPaste` helpers.

Copy paths after cleanup: (a) select text in a TUI → OSC 52 auto-copies; (b) `⎘` button → copy selection or whole screen. Paste paths: (a) native `Ctrl+V`; (b) `⇥` button.

### 2. Server: session list endpoint (`server.js`)

`GET /t/sessions` (behind existing `verifyAuth`):

- Runs `tmux list-sessions -F '#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_activity}'` via `child_process.execFile('tmux', [...])`.
- Returns `200 {sessions: [{name, windows, attached, activity}]}` where `windows`/`attached` are integers and `activity` is the tmux epoch (seconds).
- If tmux exits non-zero with "no server running" (or any error), return `200 {sessions: []}` — an empty list is a valid state, not an error.
- Fixed argv, no shell, no user input in the command → no injection surface.
- `Cache-Control: no-store`.

### 3. Per-tab persistence + MRU (`public/app.js`)

- **Current session** moves from `localStorage['session']` to `sessionStorage['session']` (per-tab, survives refresh).
- **Startup resolution order** for `sessionName`:
  1. `?session=` URL param (explicit wins)
  2. `sessionStorage['session']` (this tab's own last session)
  3. `localStorage['session']` (global "last used" — seeds a brand-new tab)
  4. `'mobile'` (default)
  Then immediately persist the resolved name to `sessionStorage` and record it in the MRU.
- **MRU queue**: `sessionStorage['sessionMRU']` = JSON array, most-recent-first, deduped, capped at 8. Updated on every session switch/connect.
- On switch, also write `localStorage['session']` so future new tabs start from the most-recent globally-used session, while existing tabs stay independent.

### 4. Session panel UI (`public/index.html`, `style.css`, `app.js`)

The `⇄` button opens a modal overlay panel (replaces `prompt()`):

- **服务器会话**: live list from `GET /t/sessions`; each row shows name, window count, and a `●` marker when `attached > 0`; current session highlighted; click a row to switch. Empty → "暂无活跃会话（新建一个）". Fetch failure → inline error note, create still available.
- **本标签最近**: MRU chips (excluding the current session); click to quick-switch.
- **新建 / 切换**: text input + button; sanitized `[^\w-]`, non-existent name auto-creates on attach (tmux `new-session -A`).
- Dismiss: close button or click on the backdrop.

**Unified switch** — `switchSession(name)`:
1. sanitize; ignore if empty or unchanged.
2. `sessionName = name`; write `sessionStorage['session']`, update MRU, write `localStorage['session']`.
3. tear down current transport, `term.reset()`, `connect()`.
4. close the panel.

## Data Flow

```
open panel → GET /t/sessions → render server list + MRU chips
click row / chip / create → switchSession(name) → reconnect → panel closes
page refresh → sessionName from sessionStorage → same tab, same session
```

## Error Handling

- `/t/sessions` tmux error/no-server → `{sessions: []}` (200).
- Client fetch failure → note "无法获取会话列表"; manual create still works.
- Session name sanitized client-side (`[^\w-]`, ≤32) and server-side (`sanitizeSession`, already present).
- Malformed `sessionStorage['sessionMRU']` JSON → treat as `[]`.

## Testing

- **Server**: `curl` `GET /t/sessions` (authorized) returns JSON; create 2 tmux sessions and confirm both appear with correct window counts; kill the tmux server and confirm `{sessions: []}`.
- **Client (manual)**:
  - Open two tabs on different sessions; refresh each; confirm each returns to its own session.
  - Open panel: server sessions listed, current highlighted, `●` on attached; switch via row; create a new session; MRU chips appear and quick-switch works.
  - Copy/paste: select in a TUI → auto-copy (OSC 52 note); `⎘` copies screen; native `Ctrl+V` and `⇥` paste; `Ctrl+C` interrupts; desktop image paste still uploads.

## Files Touched

- `server.js` — add `GET /t/sessions` route + `execFile` helper.
- `public/app.js` — remove key-handler block; add `switchSession`, MRU helpers, session-panel logic; change storage to sessionStorage.
- `public/index.html` — session panel markup.
- `public/style.css` — panel/overlay/chip styles.
