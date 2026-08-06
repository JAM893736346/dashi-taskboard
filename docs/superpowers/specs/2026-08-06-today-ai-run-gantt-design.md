# Today Synchronized Codex Gantt Design

## Status

Approved in conversation on 2026-08-06. This revision corrects the chart to use the data produced by the existing Codex history synchronization workflow.

## Goal

Show synchronized Codex conversations in a same-day Gantt below the project cards so the user can compare their distribution and reference duration. Each row represents one synchronized conversation whose saved interval intersects today.

## Confirmed Operation Path

1. `CodexHistorySyncDialog` submits selected history through the existing Codex import API.
2. `/api/codex-import` calls `TaskboardDatabase.importCodexTask()`.
3. The imported Taskboard task preserves the Codex `threadId`, `createdAt`, and `updatedAt` values.
4. `listTasks(projectId)` returns those persisted tasks through the ordinary product API.
5. `TodayChatGantt` projects tasks with a `threadId` onto today's timeline.
6. Clicking a row calls the existing `App.openThread(threadId)` action, which opens the native Codex conversation in both embedded and standalone modes.

The reported empty state occurred because the first implementation read the separate local AI Chat tables. Those tables contain no records for synchronized Codex history and are not part of this workflow.

## Scope

- Load persisted tasks for all projects once when the project-home chart mounts and on explicit manual refresh.
- Keep only tasks with a non-empty native Codex `threadId`.
- Use the saved `createdAt` to `updatedAt` interval as reference duration.
- Display the browser-local day from `00:00` inclusive to the next `00:00` exclusive.
- Include tasks whose saved interval intersects the day and clip bars to the visible day.
- Order rows chronologically by saved creation time, then task ID.
- Open the corresponding native Codex conversation when a row is clicked.
- Preserve the existing summary, fixed time ticks, responsive scrolling, loading, empty, and failure states.

## Non-Goals

- No claim that `createdAt` to `updatedAt` is precise active execution time; it is reference-only elapsed time.
- No direct Codex history scan during chart refresh.
- No new HTTP route, database query, cloud contract, CLI behavior, or host bridge.
- No automatic network polling or refresh immediately after history synchronization.
- No AI Chat panel integration, live running-state timer, numeric benefit score, date picker, or configurable time range.
- No new automated regression tests before the user confirms the corrected direct path works.

## Component Design

### `TodayChatGantt`

The component receives persisted projects and the existing native-thread opener:

```ts
interface TodayChatGanttProps {
  projects: Project[];
  onOpenThread: (threadId: string) => void;
}
```

On mount or manual refresh it calls `listTasks(project.id)` concurrently for each project. It flattens the responses, keeps tasks with `threadId`, associates each task with its project name, and derives clipped bar geometry from `createdAt` and `updatedAt`.

The refresh effect depends on a stable project-ID key rather than the `projects` array identity. Ordinary project-count updates therefore do not trigger extra task fan-out requests; the refresh button remains the explicit synchronization point.

### `App`

Render the chart after project loading completes, regardless of local AI Chat capability. Pass persisted projects and the existing `openThread` callback. Remove the chart-specific AI Chat open-request state and props because synchronized rows open native Codex conversations, not the local AI Chat panel.

### `AiChat`

Remove the chart-only `AiChatOpenRequest` contract and effect. No local AI Chat behavior is needed for the corrected data path.

## Time Semantics

For each synchronized task:

- `realStart = Date.parse(task.createdAt)`
- `realEnd = max(realStart, Date.parse(task.updatedAt))`
- include when `realStart < dayEnd && realEnd > dayStart`
- `displayStart = max(realStart, dayStart)`
- `displayEnd = min(realEnd, dayEnd)`
- displayed duration is `realEnd - realStart`

Bars crossing midnight are clipped at the chart boundary while the duration label keeps the complete saved elapsed interval. Zero-length or invalid intervals are omitted because they cannot form a visible bar.

## Presentation And States

Keep the existing unframed chart layout and time axis. Rename AI-run-specific text to task-oriented language: `今日 Codex 任务`, count label `任务`, status `Codex 对话`, loading `正在读取今日任务`, and empty state `今天暂无已同步的 Codex 任务`.

One refresh makes one task-list request per persisted project. Requests run concurrently and are made only on first chart mount or explicit refresh. Any request failure produces the existing chart-local failure state without affecting project cards.

## Direct-Path Verification

1. Run `npm run typecheck`.
2. Run `npm run build`.
3. Open the project home against the existing local database.
4. Confirm synchronized tasks with native thread IDs render after first load or manual refresh.
5. Confirm rows are chronologically ordered and clipped to the local day.
6. Click a row and confirm the corresponding native Codex conversation opens.
7. Confirm project cards remain usable and no periodic task requests occur.

This verifies the requested sync-to-refresh-to-chart path. Additional protection remains deferred until the user confirms the corrected behavior.
