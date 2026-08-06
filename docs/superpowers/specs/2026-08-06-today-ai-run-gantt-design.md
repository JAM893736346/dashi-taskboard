# Today Codex Active-Time Gantt Design

## Status

Approved in conversation on 2026-08-06. The user selected activity rule A: gaps of one hour or less remain part of the same estimated active session; gaps greater than one hour split the bar.

## Goal

Show the estimated active time of synchronized Codex conversations on today's Gantt. Each task remains one row, but the timeline contains one or more activity fragments instead of a single `createdAt` to `updatedAt` span.

## Confirmed Operation Path

1. Codex history synchronization creates ordinary Taskboard tasks carrying native `threadId` values.
2. `TodayChatGantt` loads those tasks once on project-home mount or explicit refresh.
3. The component sends only the unique synchronized thread IDs and the local-day range to `POST /api/local/codex-activity`.
4. The local service performs one Codex App Server `thread/list`, intersects it with the supplied IDs and today's update range, then reads only those candidate threads with `thread/read(includeTurns: true)`.
5. The service converts turn `startedAt`/`completedAt` values into merged one-hour activity sessions and returns compact segments only.
6. The chart clips each segment to today, renders every segment in the owning task row, and sums the visible segments as estimated active time.

The route remains a local-companion capability in local and cloud modes. It does not mutate Taskboard business data or read Codex JSONL files directly.

## Activity Semantics

For each thread:

1. Keep valid turn intervals with a numeric `startedAt` and an end later than the start.
2. Use `completedAt` for completed turns. For an incomplete or interrupted turn, use the thread's last `updatedAt` only when it is later than the turn start.
3. Sort intervals by start time.
4. Merge an interval into the current segment when `next.start - current.end <= 60 minutes`. Overlapping intervals also merge.
5. Start a new segment when the gap is greater than 60 minutes.
6. Keep only merged segments intersecting the requested local-day range; the browser performs final clipping to its exact day boundaries.

Because short gaps are included, the UI labels the result `估算活跃`, not exact compute time. The row duration and summary values use the sum of today's clipped merged segments.

## Performance Design

### Candidate Filtering

The browser sends all synchronized task thread IDs, but the local service does not read every thread. One inexpensive `thread/list` supplies current thread metadata. A thread becomes a read candidate only when:

- its ID is in the supplied set;
- `createdAt < rangeEnd`; and
- `updatedAt > rangeStart`.

This catches conversations that were imported earlier and became active today without requiring their Taskboard task timestamp to be updated.

### Bounded Reads

Candidate `thread/read` calls run with concurrency two. This avoids a memory spike from parsing several large conversation snapshots at once while retaining useful latency for the normal small candidate set.

### Compact Cache

The local service keeps at most 128 compressed activity entries in memory. The key includes Codex executable, thread ID, and thread `updatedAt`; unchanged threads reuse their compressed segments without another `thread/read`. The cache stores no conversation content and is naturally cleared when the service exits.

### Request Policy

There is no polling. The chart performs its task-list fan-out and one batched activity request only on first mount, when the persisted project-ID set changes, or when the user clicks refresh.

Measured discovery evidence on the current machine is informational, not a guarantee: listing 65 threads took about 0.129 seconds, and a fresh process plus one 17-turn/350-item thread read took about 0.135 seconds. Raw session files total about 607 MB, which is why this design never scans them during board rendering.

## Components

### `server/codex-history.mjs`

Share the existing Codex App Server lifecycle between history listing and activity loading. Add the turn-to-segment projection, bounded concurrent reads, and bounded cache while preserving the current `listCodexHistory()` contract.

### `server/app.mjs`

Add `POST /api/local/codex-activity`. Validate a JSON object containing:

```json
{
  "threadIds": ["native-thread-id"],
  "rangeStart": "2026-08-05T16:00:00.000Z",
  "rangeEnd": "2026-08-06T16:00:00.000Z"
}
```

Accept no more than 512 unique non-empty thread IDs and a positive range no longer than 48 hours. Map App Server failures to `CODEX_ACTIVITY_UNAVAILABLE` without affecting other board routes.

### `web/src/api.ts` And `web/src/types.ts`

Expose a typed `listCodexActivity()` request returning thread IDs with compact ISO activity segments.

### `TodayChatGantt`

Load synchronized tasks, call the batch activity API, join results by `threadId`, clip segments, and render multiple `.today-chat-gantt-bar` elements per row. Sort rows by the first visible activity segment. Keep row click behavior unchanged.

Update visible metrics to `累计活跃` and `最长活跃`; the right column shows each row's visible estimated active duration. The task metadata line includes `估算活跃` and the first visible activity time.

## States

- **Loading/refreshing:** disable refresh and keep loading local to the Gantt.
- **Empty:** show no synchronized Codex activity for today when no returned segment intersects the day.
- **Failure:** show the existing chart-local error/retry state. Project cards remain usable.
- **Partial source set:** threads not returned by the activity route simply have no row; this is expected for synchronized conversations with no activity today.

## Non-Goals

- No SQLite/D1 schema, task mutation, history-import mutation, cloud business contract, raw JSONL scan, or Codex host bridge change.
- No exact CPU/token billing time claim.
- No configurable idle threshold, date picker, polling, or background synchronization.
- No new automated regression tests before the user confirms the direct feature path works.

## Direct-Path Verification

1. Query the local activity route with real synchronized IDs and today's range.
2. Confirm only today's candidate threads are returned and the known long idle gap produces multiple segments.
3. Load the project home and verify fragmented bars, `累计活跃`, `最长活跃`, and row active durations.
4. Refresh and confirm unchanged rows reuse cached compressed activity while the UI remains responsive.
5. Run `npm run typecheck`, `npm run build`, and `git diff --check`.
6. Create one focused commit containing only the active-fragment request changes.
