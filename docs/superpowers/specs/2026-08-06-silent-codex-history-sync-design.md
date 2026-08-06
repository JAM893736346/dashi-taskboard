# Silent Codex History Sync Design

## Status

Approved in conversation on 2026-08-06. The user selected silent synchronization whenever the Taskboard opens, with all automatically matchable history included by default.

## Goal

Synchronize new Codex history into Taskboard every time the Taskboard opens without showing the history dialog or requiring confirmation. Newly imported issues must become visible in project counts and the currently selected board.

## Confirmed Operation Path

1. The Codex renderer injection opens the Taskboard from its sidebar entry and mounts or reveals the managed iframe.
2. The React application loads Taskboard projects and their device workspace paths.
3. The existing `GET /api/local/codex-history` route reads every Codex history page until its cursor is exhausted.
4. The browser compares those threads with `GET /api/codex-import`, matches each thread workspace to a Taskboard project, and selects every matched thread that is not already imported.
5. The existing `POST /api/codex-import` route creates ordinary backlog issues, skips existing thread IDs idempotently, emits local task events, and returns aggregate results.
6. The browser refreshes project counts and the currently selected project's tasks so imported issues become observable.

The retained embedded iframe is hidden rather than destroyed when users navigate back to native Codex pages. Therefore React mount alone cannot represent every Taskboard open.

## Trigger Design

### Embedded Codex Surface

After `openTaskboard()` has prepared and shown the managed iframe, the renderer injection sends one narrow `taskboard:opened` message to that iframe. This occurs on the first open and every later open that reuses the same iframe.

The React application accepts this message only from its current parent while running with `host=codex`, then queues one silent history synchronization. Host context remains a separate message and existing native integration behavior stays unchanged.

### Standalone Web Surface

The React application queues one silent history synchronization after its initial project load. There is no recurring poll and ordinary in-page project navigation does not count as reopening the Taskboard.

## Synchronization Semantics

For each requested synchronization:

1. Wait until the initial project list and device workspace paths are available.
2. Load the complete Codex history and the set of already imported thread IDs through the existing API calls.
3. Use the existing workspace matching rule to resolve threads to projects.
4. Build one import request containing all matched, not-yet-imported threads.
5. Leave unmatched threads untouched because assigning them requires a user project choice.
6. Skip the import request when there is nothing eligible to import.
7. After a successful non-empty import, refresh project counts and the currently selected project's task list.

The existing manual `同步 Codex 历史` dialog remains available for review, manual project assignment, and explicit retry. Its behavior and selection rules do not change.

## User Experience And Failure Behavior

- Do not open a dialog or show a success notice during automatic synchronization.
- Do not delay or block the visible Taskboard while synchronization runs.
- An automatic scan or import failure does not replace the board with an error state. The existing manual synchronization action remains the visible recovery path.
- Existing imported threads remain unchanged because the import endpoint is idempotent by native Codex thread ID.

## Components

### `inject/codex-taskboard.user.js`

Emit the allowlisted `taskboard:opened` message once after each successful embedded open, including iframe reuse.

### `web/src/App.tsx`

Receive the embedded open signal, create the one initial standalone request, wait for project readiness, run the silent synchronization, and refresh observable board data after imports.

### Existing History Modules

Reuse `web/src/api.ts`, `shared/codex-history-import.mjs`, `server/codex-history.mjs`, and the existing `/api/codex-import` route without changing their contracts or persistence behavior.

## Non-Goals

- No new setting, toggle, interval, date range, polling, retry loop, or success notification.
- No automatic project assignment for unmatched workspaces.
- No update of already imported issue titles, descriptions, status, or timestamps.
- No SQLite, D1, cloud business contract, or Codex App Server protocol change.
- No iframe reload on every open and no unrelated injector refactor.
- No new regression or mutation tests before user confirmation of the direct path.

## Direct-Path Verification

1. Start the local Taskboard path with at least one Codex thread that matches a project and has not been imported.
2. Open the standalone Taskboard and confirm the issue is imported without a dialog and appears in the project count or selected board.
3. In the Codex host, open Taskboard, return to a native page, create or expose another importable history thread, and open Taskboard again.
4. Confirm the retained iframe receives a new open signal and the new issue becomes visible without reloading the iframe or showing the dialog.
5. Confirm the manual synchronization button still opens the existing dialog for unmatched history and explicit review.
6. Run `npm run typecheck`, `npm run build`, and `git diff --check` for the changed source.
7. Create one focused implementation commit without staging unrelated worktree changes.
