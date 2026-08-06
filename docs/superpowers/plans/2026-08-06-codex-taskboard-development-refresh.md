# Codex Taskboard Development Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ordinary production web builds refresh the open Codex Taskboard iframe without replacing the resident injector, while exposing explicit injector replacement for host-runtime changes.

**Architecture:** Add a best-effort iframe-only CLI mode beside the existing force-refresh and runtime-replacement modes. Route `npm run build` to the fast mode and expose the existing replacement mode as `npm run codex:reload`; keep the current CDP discovery, cache-busted iframe reload, and runtime reconciliation implementations unchanged.

**Tech Stack:** Node.js ESM, npm scripts, Chrome DevTools Protocol, Vite

---

### Task 1: Split Web Refresh From Runtime Reload

**Files:**
- Modify: `package.json`
- Modify: `scripts/codex-injector.mjs:50-75`
- Modify: `scripts/codex-injector.mjs:1240-1259`

- [x] **Step 1: Add the iframe-only best-effort CLI mode**

Add `refreshFrameIfRunning` to the parsed options and recognize `--refresh-frame-if-running`:

```js
const options = {
  // existing options
  refresh: false,
  refreshIfRunning: false,
  refreshFrameIfRunning: false,
  // existing options
};

// existing argument branches
else if (arg === "--refresh") options.refresh = true;
else if (arg === "--refresh-if-running") options.refreshIfRunning = true;
else if (arg === "--refresh-frame-if-running") options.refreshFrameIfRunning = true;
```

- [x] **Step 2: Share the refresh branch without rotating the resident on fast builds**

Expand the refresh branch to include the new mode. Keep resident replacement exclusive to `refreshIfRunning`, and treat either `if-running` mode as best effort when no renderer is available:

```js
if (options.refresh || options.refreshIfRunning || options.refreshFrameIfRunning) {
  const ports = options.portExplicit
    ? [options.port]
    : codexDebuggingPorts(options.port);
  const refreshed = [];
  for (const port of ports) {
    if (!(await isReachable(`http://127.0.0.1:${port}/json/version`))) continue;
    if (options.refreshIfRunning) await restartResidentInjectorForRefresh(port);
    const results = await refreshTaskboardFrames(port);
    refreshed.push(...results.map((result) => ({ port, ...result })));
  }
  if (refreshed.length === 0) {
    if (options.refreshIfRunning || options.refreshFrameIfRunning) {
      console.log(JSON.stringify({ refreshed: [], skipped: "No debuggable Codex window is running" }));
      return;
    }
    throw new Error(`No debuggable Codex window found on ports: ${ports.join(", ")}`);
  }
  console.log(JSON.stringify({ refreshed }, null, 2));
  return;
}
```

- [x] **Step 3: Route npm commands to their intended side effects**

Keep `codex:refresh` unchanged, add the explicit runtime reload command, and switch the build post-step to the fast mode:

```json
"codex:refresh": "node scripts/codex-injector.mjs --refresh",
"codex:reload": "node scripts/codex-injector.mjs --refresh-if-running",
"build": "vite build --config web/vite.config.ts && node scripts/codex-injector.mjs --refresh-frame-if-running"
```

- [x] **Step 4: Inspect the focused diff**

Run:

```bash
git diff -- package.json scripts/codex-injector.mjs
```

Expected: only the new CLI option, refresh-branch condition, best-effort condition, npm command, and build post-step appear in addition to clearly identified pre-existing worktree changes.

### Task 2: Verify The Live Development Paths

**Files:**
- Verify: `package.json`
- Verify: `scripts/codex-injector.mjs`

- [x] **Step 1: Record live process and iframe identity**

Run read-only process and CDP queries to capture the Codex application PID, resident injector PID, and current `127.0.0.1:47823` iframe URL.

Expected: one CDP-enabled Codex application, one resident injector for port 9229, and one mounted Taskboard iframe.

- [x] **Step 2: Verify the fast build path**

Run:

```bash
npm run build
```

Expected: Vite succeeds; refresh output reports the primary renderer as `refreshed: true`; the Codex and resident injector PIDs remain unchanged; the iframe refresh token changes.

- [x] **Step 3: Verify the explicit runtime reload path**

Run:

```bash
npm run codex:reload
```

Expected: refresh output reports the primary renderer as `refreshed: true`; the Codex application PID remains unchanged; the resident injector PID changes; the iframe refresh token changes.

- [x] **Step 4: Check patch integrity**

Run:

```bash
git diff --check
```

Expected: no whitespace errors.

### Task 3: Commit Only The Approved Refresh Change

**Files:**
- Add: `docs/superpowers/plans/2026-08-06-codex-taskboard-development-refresh.md`
- Modify: `package.json`
- Modify selected hunks only: `scripts/codex-injector.mjs`

- [x] **Step 1: Stage only this task's files and hunks**

Stage `package.json`, this plan, and only the two new refresh-mode hunks from `scripts/codex-injector.mjs`. Leave pre-existing renderer-readiness changes, `scripts/codex-injector-runtime.mjs`, `test/injector.test.mjs`, `.superpowers/`, and `test/injector-startup.test.mjs` unstaged.

- [x] **Step 2: Review the staged patch**

Run:

```bash
git diff --cached --check
git diff --cached --stat
git diff --cached
```

Expected: the staged patch contains only the implementation plan, npm script routing, and iframe-only CLI mode.

- [x] **Step 3: Create the focused implementation commit**

Run:

```bash
git commit -m "fix: refresh Codex board without injector restart"
```

Expected: one commit is created and unrelated worktree changes remain unstaged.
