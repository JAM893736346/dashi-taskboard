# Today AI Run Gantt Design

## Status

Approved in conversation on 2026-08-06. This document defines the first, reference-only version.

## Goal

Add a same-day Gantt view below the project cards on the project home. Each row represents one local Taskboard AI Chat run so the user can see the day's distribution, identify long-running work, and compare the task context and result with its time cost.

## Scope

- Use local AI Chat runs, not native Codex sidebar tasks and not Taskboard issue timestamps.
- Display the browser's local calendar day from `00:00` inclusive to the next `00:00` exclusive.
- Include every run whose real interval intersects the visible day.
- Order rows by real start time across projects.
- Open the owning AI Chat thread when a row is clicked.
- Load once when the project-home chart mounts and reload only on explicit manual refresh.
- Keep the feature on the React/API product surface and reuse existing local AI Chat endpoints.

## Non-Goals

- No numeric benefit score or benefit-editing workflow.
- No project grouping, duration-based row sorting, date picker, or configurable time window.
- No dedicated run-detail view.
- No new HTTP route, SQLite query, cloud behavior, CLI behavior, or Codex host bridge.
- No partial-success merge when one thread snapshot fails.
- No automatic network polling, background synchronization, or speculative caching.
- No regression or mutation tests before the user confirms the direct feature path works.

## Existing Operation Path

The existing local AI Chat execution path is:

1. `AiChat` starts a turn through `startAiChatTurn()`.
2. `POST /api/local/ai/threads/:id/turns` creates an `ai_chat_runs` record.
3. The record contains `startedAt`, optional `finishedAt`, status, and its owning `threadId`.
4. `listAiChatThreads()` returns thread metadata and `getAiChatThread()` returns a thread snapshot with historical runs.
5. The AI Chat panel renders the selected thread and its events.

The Gantt reuses steps 4 and 5. It adds a read-only projection on the project home and does not change run persistence.

## Architecture

### `TodayChatGantt`

Add a focused React component under `web/src/components/`. It owns:

- initial and manual loading;
- local-day boundary calculation;
- candidate-thread snapshot loading;
- run intersection, clipping, sorting, and summary derivation;
- loading, empty, failure, and chart rendering;
- a local `now` value used only to advance running bars without network I/O.

The component receives an `onOpenThread(threadId)` callback. It does not own AI Chat panel state.

### `App`

Render `TodayChatGantt` after the project groups in the `!selectedProjectId` project-home branch when local AI Chat is available.

`App` provides the callback that opens the existing AI Chat panel and requests selection of the supplied thread. The same selection path remains responsible for loading conversation events.

### `AiChat`

Extend the existing component's public props only as far as needed to accept an external open/select request. Do not create a second chat viewer or duplicate its snapshot/event logic in the Gantt.

## Data Flow

On chart mount or manual refresh:

1. Calculate `dayStart` and `dayEnd` with local `Date` construction.
2. Call `listAiChatThreads()` once.
3. Limit snapshot requests to candidate threads whose `updatedAt` is within the current day or whose `currentRun` intersects the day. This avoids loading every historical thread while retaining active cross-midnight work.
4. Fetch candidate snapshots concurrently with `getAiChatThread()`.
5. Flatten each snapshot's runs with its thread title and project origin.
6. Keep a run when `startedAt < dayEnd` and `(finishedAt ?? now) > dayStart`.
7. Sort retained rows by real `startedAt`, then use run ID as the stable tie-breaker.

If any list or snapshot request fails, the chart enters its failure state. It does not render stale or partial rows.

## Time Semantics

For each retained run:

- `realStart = startedAt`
- `realEnd = finishedAt ?? now`
- `displayStart = max(realStart, dayStart)`
- `displayEnd = min(realEnd, dayEnd)`
- horizontal offset is `(displayStart - dayStart) / (dayEnd - dayStart)`
- horizontal width is `(displayEnd - displayStart) / (dayEnd - dayStart)`
- displayed duration uses `realEnd - realStart`, not the clipped interval

Cross-day bars are visually clipped at the chart boundary while their right-side duration remains the real elapsed duration. A minute-level local timer updates `now` only while at least one loaded run is still running. It does not refetch data; completion status appears after manual refresh or remount.

## Presentation

Place an unframed full-width chart section below the existing project groups.

The header contains:

- title: `今日 AI 运行`;
- local date;
- summary values: run count, cumulative elapsed time, and longest run;
- an icon-only refresh button with an accessible label and tooltip.

The timeline uses fixed ticks at `00`, `04`, `08`, `12`, `16`, `20`, and `24`. Each row displays:

- thread/task title;
- project name;
- run status;
- full elapsed duration;
- a positioned bar colored by completed, running, or failed/interrupted state.

Bar length and the longest-run summary identify expensive work; the first version does not classify runs with an arbitrary "long" threshold. Clicking any row opens its owning AI Chat thread.

Use stable label, timeline, and duration columns. On narrow viewports, keep a minimum timeline width inside a horizontal scrolling region so labels and bars do not overlap.

## States

- **Loading:** only the chart region shows a lightweight loading state; project cards remain usable.
- **Empty:** show `今天暂无 AI 运行` with the refresh button still available.
- **Failure:** show a compact chart-local error and retry action; project selection and AI Chat remain usable.
- **Unavailable:** omit the chart when the local AI Chat capability is unavailable.
- **Refreshing:** disable the refresh button and show its busy state until the same initial-load path completes.

## Performance Trade-Off

The fastest implementation reuses the existing list and snapshot APIs, so one refresh makes one list request plus one request per candidate thread. Candidate filtering avoids loading old inactive threads. There is no periodic network polling; the only periodic work is a local minute tick while a loaded run is active.

This is an intentional reference-view trade-off. A dedicated date-range endpoint remains out of scope unless real usage later shows the fan-out cost is unacceptable.

## Direct-Path Verification

After implementation:

1. Run `npm run typecheck`.
2. Run `npm run build`.
3. Start the normal localhost development path.
4. Enter the project home and observe the initial thread/snapshot read.
5. Confirm today's intersecting runs appear in chronological rows with correct positions and elapsed durations.
6. Use the refresh button and confirm the chart reloads without affecting project cards.
7. Click a row and confirm the existing AI Chat panel opens on the owning thread.

This verification proves the requested direct operation path. Additional automated protection or optimization is deferred until the user confirms the feature works or reports a concrete failure.
