# Codex Taskboard Project Guide

## Scope and Purpose

This repository builds Codex Taskboard, a local-first issue board that can run
as a normal web app or inside the Codex desktop app. These instructions apply
to this repository and its descendants; do not require the user to repeat this
project context in each task.

The project has two integration surfaces that must not be confused:

- The Taskboard product surface is the React UI backed by the shared HTTP API.
- The Codex host surface injects a sidebar entry and iframe into a CDP-enabled
  Codex renderer and bridges a small set of native Codex actions.

Most product features should work in the standalone localhost UI first. Only
host-specific behavior should depend on the Codex injection layer.

## Canonical Architecture

| Area | Primary files | Ownership |
| --- | --- | --- |
| Web UI | `web/src/App.tsx`, `web/src/components/`, `web/src/styles.css` | React state, interactions, and presentation |
| Frontend contract | `web/src/types.ts`, `web/src/api.ts` | Browser types and HTTP calls |
| Local HTTP service | `server/index.mjs`, `server/app.mjs` | Routing, validation, static serving, SSE, local/cloud dispatch |
| Local persistence | `server/database.mjs`, `.data/taskboard.sqlite` | SQLite schema access, transactions, optimistic versions |
| Codex launcher | `scripts/codex-injector.mjs`, `scripts/codex-injector-runtime.mjs` | Service supervision, CDP lifecycle, host bindings, renderer refresh |
| Renderer injection | `inject/codex-taskboard.user.js` | Sidebar entry, iframe, host context, native-page restoration |
| Agent client | `cli/taskctl.mjs`, `skills/manage-taskboard/` | CLI protocol and Codex issue workflow |
| Shared logic | `shared/` | Pure workflow and automation logic used across runtimes |
| Cloud mode | `cloud/src/index.mjs`, `cloud/migrations/`, `server/cloud-proxy.mjs` | Worker API, D1/R2 persistence, local-companion split |

`dist/web` is generated output. Change source under `web/` and rebuild; do not
hand-edit built assets.

## Real Operation Path

The normal embedded create-issue path is:

1. `npm run codex` enters `scripts/codex-injector.mjs`.
2. The injector starts or reuses the local service, launches or attaches to a
   loopback CDP-enabled Codex process, and registers
   `inject/codex-taskboard.user.js` for renderer documents.
3. The user script adds the Taskboard sidebar entry. Clicking it mounts an
   iframe whose managed URL is `http://127.0.0.1:47823/?host=codex`.
4. `web/src/components/TaskEditor.tsx` submits a draft through the handler in
   `web/src/App.tsx` and `web/src/api.ts` sends `POST /api/tasks`.
5. `server/app.mjs` validates the request and calls
   `TaskboardDatabase.createTask()` in `server/database.mjs`.
6. SQLite commits the task, the server emits `task.created`, and open local
   clients receive the SSE event and refresh the visible board.

The CLI and bundled Skill use the same API rather than a separate data path.
Cloud mode replaces local business persistence with Worker/D1/R2; it must not
fall back to or double-write local SQLite.

## How to Extend the Project

Follow the narrowest applicable path:

1. For a UI-only change, start in the owning component and `styles.css`. Update
   `web/src/types.ts` only when the UI contract changes.
2. For a new task field or mutation, trace the complete contract: shared domain
   constants if applicable -> SQLite read/write -> `server/app.mjs` validation
   and route -> `web/src/api.ts` and `web/src/types.ts` -> owning UI. Update
   `taskctl` and the Skill only when agents must read or mutate it.
3. For a Codex-native action, keep the iframe unprivileged. Send a narrow
   message through `web/src/App.tsx` and `inject/codex-taskboard.user.js`, parse
   and allowlist it in `scripts/codex-injector-runtime.mjs`, and keep the actual
   CDP operation in `scripts/codex-injector.mjs`.
4. For shared cloud business behavior, implement the corresponding Worker/D1
   path in `cloud/src/index.mjs` and add a numbered D1 migration when storage
   changes. Keep device paths, Git/worktree scans, local AI, Skill/MCP discovery,
   and Codex host actions in the local companion.
5. For workflow or automation behavior, prefer the pure modules under `shared/`
   so Node and browser consumers do not acquire divergent rules.

Do not patch Codex React internals, replace its global `fetch`, load private
chunks, modify `ChatGPT.app`/`app.asar`, or edit Codex data files. The supported
integration points are the documented DOM markers, iframe messaging, native
route markers, and explicit CDP host bindings.

## Starting Codex Taskboard

The normal one-click entry is the repository-root macOS launcher:

```text
Start Codex Taskboard.command
```

It resolves this repository as its working directory, binds the local service
to `127.0.0.1`, and delegates to the canonical command:

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 npm run codex
```

Keep its Terminal window running; it owns the resident injector and shows
service/CDP errors. Stop it with `Ctrl-C` when finished. The launcher must not
silently terminate an existing Codex process.

A Codex window must be launched with its CDP port from the beginning. If Codex
is already running without CDP, quit it once before using the launcher. After a
CDP-enabled window and resident injector exist, normal edit/verify cycles do
not require restarting Codex.

## Verification Without Restarting Codex

Choose verification by the behavior being changed:

| Change | Fast verification path | What it proves |
| --- | --- | --- |
| React UI or ordinary HTTP behavior | Run `npm run dev`; use the Browser control plugin at `http://127.0.0.1:5173` | UI interaction, API request, data change, visible result with Vite HMR |
| Built iframe content | Run `npm run build`; inspect `http://127.0.0.1:47823/?host=codex` or the open embedded page | Production bundle and local-service behavior |
| Manual iframe refresh | Run `npm run codex:refresh -- --port <cdp-port>` | Reload of an already injected Taskboard frame |
| Sidebar/native route/composer/automation bridge | Keep the launcher running and verify inside the CDP-enabled Codex window | Actual Codex host integration |
| Cloud business behavior | Run `npm run dev:cloud` against local Wrangler state | Worker route and D1/R2 behavior, not local SQLite |

`npm run build` already calls the injector's `--refresh-if-running` path, so a
successful build refreshes an open injected iframe when a debuggable Codex
window is available. The Browser control plugin can verify localhost pages,
HTTP behavior, state, and visual output, but it cannot by itself prove native
Codex sidebar or composer integration.

For direct-path verification, demonstrate: entry point -> user or agent action
-> API/host side effect -> persisted or native state change -> observable UI
result. Use `npm run typecheck`, focused Node tests, or the full `npm run check`
only when the task's approved verification scope calls for them.

## Data and Integration Invariants

- Node.js 22.5 or newer is required.
- Local business data lives in `.data/taskboard.sqlite`; attachments and local
  companion configuration also stay under `.data`.
- Task, comment, and workflow writes use optimistic versions. Carry the latest
  `version` through update requests and surface `VERSION_CONFLICT` rather than
  overwriting concurrent changes.
- Browser mutations carry the current user actor headers. Agent task/comment
  mutations carry the Codex conversation through `CODEX_THREAD_ID` or an
  explicit `--thread-id`.
- The UI says "issue" while the current HTTP and database implementation uses
  `task` naming. Follow the existing layer's vocabulary instead of performing
  incidental renames.
- Local mode broadcasts changes with SSE. Cloud mode exposes revision polling;
  do not assume the realtime transports are identical.
- `CODEX_TASKBOARD_HOST=127.0.0.1` is the preferred single-device setting. LAN
  mode has no account authentication, and a CDP port is unauthenticated to
  other local processes, so use both only in a trusted environment.
- Never put shared passwords, API tokens, Cloudflare credentials, or device-
  specific absolute paths into committed source or cloud business records.

# Project Development Rules

For feature work in this repository, use this order:

1. Before implementation, prove the real operation path to the user: entry point → user or agent action → data change or other side effect → observable result. Cite the actual component, API, and file involved, or demonstrate the path in the product. This proof is not a test.
2. Implement the requested main path with the smallest direct change that makes it work.
3. After implementation, demonstrate or verify only that direct operation path and give the result to the user for confirmation.
4. Before the user confirms the feature works, do not proactively add guardrails, mutation or regression tests, legacy compatibility protection, defensive extensions, or speculative fallback behavior.
5. User confirmation does not automatically authorize that follow-up work. Add targeted protection or tests only when the user explicitly asks for them, or when the user reports a concrete failure scenario that requires them.
6. After completing and verifying each user request, automatically create a focused Git commit containing only that request's changes. Do not ask for confirmation. Keep unrelated worktree changes unstaged and use an imperative Conventional Commit message.

The primary objective is to make the requested function work. Focus on the feature implementation itself and avoid over-design; safety, guardrails, and testing must not dominate the work or turn the feature into a surrounding engineering project. This rule supersedes the earlier standing instruction that every feature must be developed test-first. Test-first language in older issues does not apply unless the user restates it for that issue after this rule.

This ordering does not waive higher-priority safety or security requirements. Keep validation that is necessary at real external boundaries, such as user input or external APIs, but do not expand it into hypothetical protection beyond the requested path.
