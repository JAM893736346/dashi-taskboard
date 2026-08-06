# Silent Codex History Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import every new, automatically matchable Codex history thread whenever Taskboard opens, without showing the synchronization dialog.

**Architecture:** The Codex renderer injection emits one explicit open event after each successful iframe reveal, including retained-frame reuse. React turns that event, or the initial standalone load, into a background scan-and-import using the existing full-history, imported-thread, workspace-matching, and batch-import contracts, then refreshes only observable board data when imports occur.

**Tech Stack:** React 19, TypeScript, browser `postMessage`, existing Taskboard HTTP client, Codex renderer user-script injection

---

Project instructions explicitly replace test-first development for this feature. Do not add regression or mutation tests before user confirmation; verify the approved direct operation path only.

### Task 1: Signal Every Successful Embedded Open

**Files:**
- Modify: `inject/codex-taskboard.user.js:1073-1096`

- [ ] **Step 1: Emit the narrow iframe message**

In `prepareTaskboard(generation)`, send the open event only after the generation is still active, the frame is ready, and `showFrame()` has run:

```js
      showFrame();
      postHostContext();
      postToFrame({ type: "taskboard:opened" });
```

Do not send from `openTaskboard()` before readiness and do not reload the iframe. The existing generation checks ensure failed or superseded opens emit nothing.

- [ ] **Step 2: Check user-script syntax**

Run:

```bash
node --check inject/codex-taskboard.user.js
```

Expected: exit 0 with no output.

### Task 2: Run Silent Full-History Import In React

**Files:**
- Modify: `web/src/App.tsx:1-70`
- Modify: `web/src/App.tsx:380-430`
- Modify: `web/src/App.tsx:560-620`
- Modify: `web/src/App.tsx:690-750`

- [ ] **Step 1: Import the existing history primitives**

Add the HTTP calls to the current `./api` import:

```ts
  importCodexHistory,
  listCodexHistory,
  listImportedCodexThreadIds,
```

Import the existing workspace matcher beside other local helpers:

```ts
import { buildCodexHistoryPreview } from "../../shared/codex-history-import.mjs";
```

- [ ] **Step 2: Represent standalone and embedded open requests**

Initialize one request for standalone mode and wait for an explicit host event in embedded mode:

```ts
  const [codexHistorySyncRequest, setCodexHistorySyncRequest] = useState(embedded ? 0 : 1);
```

Track the latest started request beside the existing request refs so project refresh renders cannot rerun the same synchronization:

```ts
  const codexHistorySyncStartedRef = useRef(0);
```

- [ ] **Step 3: Accept the embedded open message from the existing trusted parent**

Inside the existing `receiveHostMessage()` handler, after its source/data validation and before unrelated message branches, queue the request:

```ts
      if (message.type === "taskboard:opened") {
        setCodexHistorySyncRequest((current) => current + 1);
        return;
      }
```

The surrounding effect already requires `host=codex`, rejects messages not sent by `window.parent`, registers before posting `taskboard:ready`, and removes the listener on cleanup.

- [ ] **Step 4: Scan and import every eligible thread after projects are ready**

After `refreshProjectList` and `refreshTasks` are defined, add an effect with this direct orchestration:

```ts
  useEffect(() => {
    if (
      projectsLoading
      || codexHistorySyncRequest === 0
      || codexHistorySyncStartedRef.current >= codexHistorySyncRequest
    ) return;

    codexHistorySyncStartedRef.current = codexHistorySyncRequest;
    void Promise.all([
      listCodexHistory(),
      listImportedCodexThreadIds(),
    ]).then(async ([threads, existingThreadIds]) => {
      const importTasks = buildCodexHistoryPreview(
        threads,
        codexImportProjects,
        existingThreadIds,
      ).flatMap((item) => (
        item.existing || !item.matchedProjectId
          ? []
          : [{
              threadId: item.threadId,
              projectId: item.matchedProjectId,
              title: item.title,
              description: item.description,
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
            }]
      ));
      if (importTasks.length === 0) return;

      const result = await importCodexHistory(importTasks);
      if (result.imported === 0) return;
      await refreshProjectList();
      const projectId = selectedProjectIdRef.current;
      if (projectId) await refreshTasks(projectId, { quiet: true });
    }).catch(() => {});
  }, [
    codexHistorySyncRequest,
    codexImportProjects,
    projectsLoading,
    refreshProjectList,
    refreshTasks,
  ]);
```

This deliberately keeps automatic failures out of `loadError`/`actionError`, sends no success announcement, leaves unmatched threads for the manual dialog, and skips the write request when no eligible history exists.

### Task 3: Verify The Direct Open-To-Import Path

**Files:**
- Verify: `inject/codex-taskboard.user.js`
- Verify: `web/src/App.tsx`
- Verify: `docs/superpowers/specs/2026-08-06-silent-codex-history-sync-design.md`
- Verify: `docs/superpowers/plans/2026-08-06-silent-codex-history-sync.md`

- [ ] **Step 1: Run static and production checks**

Run:

```bash
node --check inject/codex-taskboard.user.js
npm run typecheck
npm run build
git diff --check
```

Expected: every command exits 0. `npm run build` may print the existing bundle-size warning and automatically refresh an open iframe.

- [ ] **Step 2: Verify the standalone direct path**

Start the local development surface with `npm run dev`, open its reported localhost URL, and verify network activity follows this sequence after project loading:

```text
GET /api/local/codex-history
GET /api/codex-import
POST /api/codex-import            # only when eligible history exists
GET /api/projects                 # after at least one import
GET /api/tasks?projectId=...      # when a project is selected
```

Confirm no history dialog opens and an imported issue becomes visible in its project count or selected board. If current data has no eligible history, record the two scan requests and zero-write result as the available direct-path evidence rather than inventing fixture data.

- [ ] **Step 3: Reload and verify the embedded open signal**

Run:

```bash
npm run codex:reload
```

Expected: the resident injector is replaced and the managed frame is refreshed without restarting Codex. Open Taskboard, navigate to a native Codex page, then open Taskboard again. Confirm the second open reuses the iframe, sends another `taskboard:opened`, performs another silent scan, and does not open the manual dialog.

- [ ] **Step 4: Commit only the approved implementation**

Inspect status and diffs, then stage only:

```bash
git add inject/codex-taskboard.user.js web/src/App.tsx
git commit -m "feat: sync Codex history on taskboard open"
```

Leave `scripts/codex-injector-runtime.mjs`, `scripts/codex-injector.mjs`, `test/injector.test.mjs`, `.superpowers/`, and `test/injector-startup.test.mjs` untouched and unstaged.
