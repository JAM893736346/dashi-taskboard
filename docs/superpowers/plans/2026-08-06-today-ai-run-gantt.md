# Today Codex Active-Time Gantt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace solid synchronized-thread spans with estimated active-time fragments split by idle gaps greater than one hour.

**Architecture:** A local-only batch endpoint uses one Codex App Server session to list current metadata, reads only synchronized threads active in the requested day, merges turn intervals into compact one-hour sessions, and caches compressed results by thread update version. The React chart makes one batch request on first mount/manual refresh and renders returned fragments without polling or persistence changes.

**Tech Stack:** Node.js 22, Codex App Server JSON-RPC, React 19, TypeScript, existing Taskboard HTTP client and CSS

---

### Task 1: Build the compact Codex activity projection

**Files:**
- Modify: `server/codex-history.mjs`

- [x] **Step 1: Share the App Server request lifecycle**

Extract the current spawn/initialize/pending-request lifecycle into an internal helper used by `listCodexHistory()` and the new activity reader. Preserve the existing timeout, maximum line size, process cleanup, pagination parameters, and public history-list result.

- [x] **Step 2: Merge turn intervals using the approved one-hour rule**

Add an exported pure projection with this contract:

```js
export function buildCodexActivitySegments(thread) {
  // Returns [{ startAt: ISO string, endAt: ISO string }].
}
```

Convert numeric second timestamps to milliseconds. Use `completedAt`, or the thread `updatedAt` for incomplete turns when it is later than the start. Sort intervals and merge when the next gap is at most `60 * 60 * 1000` milliseconds.

- [x] **Step 3: Read only current-day candidates with bounded concurrency and cache**

Add:

```js
export function listCodexActivity({
  codexExecutable,
  cwd,
  threadIds,
  rangeStart,
  rangeEnd,
  processEnv = process.env,
  timeoutMs,
})
```

Within one App Server session, paginate `thread/list`, intersect it with `threadIds`, filter by the requested range, then process candidates with two workers. Cache at most 128 compressed entries using `codexExecutable`, thread ID, and `updatedAt`; evict the oldest entry when over capacity. Return only segments intersecting the range.

### Task 2: Expose the local batch endpoint

**Files:**
- Modify: `server/app.mjs`

- [x] **Step 1: Validate the request contract**

Add a parser for `{ threadIds, rangeStart, rangeEnd }`. Require an array of at most 512 unique strings of 1-256 characters, valid timestamps, `rangeEnd > rangeStart`, and a range no longer than 48 hours.

- [x] **Step 2: Add `POST /api/local/codex-activity`**

Import `listCodexActivity`, allow dependency injection as `options.codexActivityList`, enforce loopback through the existing `/api/local/` handling, reject query parameters and non-POST methods, and return:

```json
{
  "threads": [
    {
      "threadId": "native-thread-id",
      "segments": [{ "startAt": "...", "endAt": "..." }]
    }
  ]
}
```

Map reader failures to HTTP 502 with code `CODEX_ACTIVITY_UNAVAILABLE`.

### Task 3: Render activity fragments and active summaries

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`
- Modify: `web/src/components/TodayChatGantt.tsx`

- [x] **Step 1: Add the typed batch client**

Define `CodexActivitySegment` and `CodexThreadActivity`, then add:

```ts
export async function listCodexActivity(
  threadIds: string[],
  rangeStart: string,
  rangeEnd: string,
  signal?: AbortSignal,
): Promise<CodexThreadActivity[]>
```

Send one JSON POST to `/api/local/codex-activity`.

- [x] **Step 2: Join returned activity to synchronized tasks**

Keep the existing concurrent project task loads. Collect unique `threadId` values, request activity for the local day, and store only tasks whose returned segments intersect today. Abort both task and activity requests through the existing controller.

- [x] **Step 3: Render one bar per clipped segment**

Replace the row's single geometry with:

```ts
interface GanttSegment {
  start: number;
  end: number;
  offsetPercent: number;
  widthPercent: number;
}
```

Sort rows by their first visible segment. Sum clipped segment spans into the row, total, and longest active duration values. Render one `.today-chat-gantt-bar` per segment and change labels to `累计活跃`, `最长活跃`, and `估算活跃`.

### Task 4: Verify the direct path and create the focused commit

**Files:**
- Verify changed source and documentation only; do not add tests before user confirmation.

- [x] **Step 1: Verify the real local activity response**

Call the new endpoint with synchronized thread IDs and today's ISO range. Confirm the known Gantt conversation returns multiple segments and no unrelated historical thread is returned. Record response time and segment count as local evidence, not a general guarantee.

- [x] **Step 2: Verify the browser result**

At the current standalone verification URL (`http://127.0.0.1:47824/` for this run), verify multiple separated bars in one task row, active summaries, chronological order, manual refresh, horizontal scrolling, and no new console error.

- [x] **Step 3: Run static and production checks**

Run:

```bash
npm run typecheck
npm run build
git diff --check
```

Expected: exit 0 for all commands; the existing bundle-size warning may remain.

- [x] **Step 4: Commit only this request**

Stage the updated design/plan, `server/codex-history.mjs`, `server/app.mjs`, `web/src/types.ts`, `web/src/api.ts`, and `TodayChatGantt.tsx`. Leave injector and unrelated test changes unstaged. Commit with:

```bash
git commit -m "feat: show estimated Codex active time"
```
