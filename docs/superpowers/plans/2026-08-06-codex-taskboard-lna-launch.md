# Codex Taskboard Local Network Access Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Launch Codex with a process-local Chromium compatibility flag so the embedded loopback Taskboard can reload after every web build without timing out.

**Architecture:** Keep the existing local HTTP service, iframe injection, cache-busted refresh, and `taskboard:ready` handshake unchanged. Add the verified Chromium feature-disable only to the repository-owned `launchCodex()` path, then document the one-time adoption restart and normal no-restart development cycle.

**Tech Stack:** Node.js ESM launcher, macOS `open --args`, Chromium/Electron command-line features, Markdown project guidance.

---

## File Structure

- `scripts/codex-injector.mjs`: owns Codex process launch arguments. Add one argument in `launchCodex()`; do not alter the pre-existing uncommitted renderer-readiness hunks elsewhere in this file.
- `AGENTS.md`: owns repository startup and verification guidance. Explain the process-local LNA compatibility flag and restart boundary.

No iframe, React, server, persistence, cloud, generated bundle, automated test, or system preference file changes are part of this plan.

### Task 1: Add the Codex Launch Compatibility Flag

**Files:**
- Modify: `scripts/codex-injector.mjs:194-206`

- [ ] **Step 1: Add the verified Chromium feature disable**

Append the following argument after the existing CDP origin argument in `launchCodex()`:

```js
      `--remote-debugging-port=${port}`,
      `--remote-allow-origins=http://127.0.0.1:${port}`,
      "--disable-features=LocalNetworkAccessChecks",
```

Do not add a global preference, mutate `ChatGPT.app`, terminate an existing Codex process, or change attach/refresh behavior.

- [ ] **Step 2: Verify launcher syntax and the exact diff**

Run:

```bash
node --check scripts/codex-injector.mjs
git diff -- scripts/codex-injector.mjs
```

Expected: `node --check` exits 0 with no output. The diff contains the new feature-disable line plus clearly separate pre-existing renderer-readiness hunks; only the new line belongs to this task.

### Task 2: Document the One-Time Restart Boundary

**Files:**
- Modify: `AGENTS.md:91-105`

- [ ] **Step 1: Extend the startup guidance**

Add this paragraph after the canonical launch command:

```markdown
The launcher also starts Codex with
`--disable-features=LocalNetworkAccessChecks`. This process-local compatibility
flag allows the `app://-` Codex renderer to embed the loopback Taskboard under
Chrome 151; it does not change system or Chrome policy.
```

- [ ] **Step 2: Clarify adoption versus normal iteration**

Replace the existing restart paragraph with wording equivalent to:

```markdown
A Codex window must be launched with its CDP and Taskboard compatibility flags
from the beginning. After first adopting or changing these launch flags, quit
Codex once and reopen it through the launcher. Once that window and the
resident injector exist, `npm run build` refreshes the iframe and
`npm run codex:reload` replaces injector/runtime code without restarting Codex.
```

- [ ] **Step 3: Check documentation formatting**

Run:

```bash
git diff --check -- AGENTS.md
git diff -- AGENTS.md
```

Expected: no whitespace errors; the diff describes only the LNA flag and restart boundary.

### Task 3: Verify and Commit the Direct Fix

**Files:**
- Modify: `scripts/codex-injector.mjs`
- Modify: `AGENTS.md`

- [ ] **Step 1: Confirm the static launch contract**

Run:

```bash
node --check scripts/codex-injector.mjs
rg -n --fixed-strings -- '--disable-features=LocalNetworkAccessChecks' scripts/codex-injector.mjs AGENTS.md
git diff --check -- scripts/codex-injector.mjs AGENTS.md
```

Expected: syntax and whitespace checks pass, and both the launch argument and its guidance are present.

- [ ] **Step 2: Perform the live direct-path check when the host can restart**

Complete one Codex restart through `Start Codex Taskboard.command`, then verify through CDP:

```text
browser command line contains --disable-features=LocalNetworkAccessChecks
-> embedded iframe document is http://127.0.0.1:47823, not chrome-error://chromewebdata/
-> React #root exists
-> taskboard:ready makes the iframe visible
-> npm run build changes the iframe refresh token without changing the Codex PID
```

Because this task is running inside the Codex process that must be restarted, record live verification as pending if terminating the host would interrupt the active task. The user can perform the one-time restart after delivery, and the next turn can inspect the resulting live state.

- [ ] **Step 3: Stage only this task's implementation**

Stage `AGENTS.md` normally. Stage only the following hunk from the dirty launcher file, leaving all pre-existing hunks unstaged:

```diff
@@
       `--remote-debugging-port=${port}`,
       `--remote-allow-origins=http://127.0.0.1:${port}`,
+      "--disable-features=LocalNetworkAccessChecks",
```

Inspect with:

```bash
git diff --cached --check
git diff --cached
git status --short
```

Expected: the staged diff contains only `AGENTS.md` and the one launcher argument. Existing work in `scripts/codex-injector-runtime.mjs`, the other launcher hunks, server/shared/web files, tests, and `.superpowers/` remains unstaged.

- [ ] **Step 4: Create the focused implementation commit**

Run:

```bash
git commit -m "fix: allow local Taskboard in Codex"
git log -1 --oneline
```

Expected: one focused Conventional Commit containing only the approved launch compatibility change and matching Agent guidance.

No new automated regression test is added before the user confirms the live direct path, per project instructions.
