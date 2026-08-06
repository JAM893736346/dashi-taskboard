# Today Synchronized Codex Gantt Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing same-day Gantt display synchronized Codex conversations after first load or explicit manual refresh.

**Architecture:** `TodayChatGantt` will load ordinary Taskboard tasks for the persisted projects, retain tasks with native Codex thread IDs, and derive reference intervals from imported timestamps. `App` will pass projects and its existing native `openThread` action; obsolete chart-specific AI Chat opening state will be removed.

**Tech Stack:** React 19, TypeScript, existing Taskboard HTTP client, existing CSS

---

### Task 1: Replace the chart data projection

**Files:**
- Modify: `web/src/components/TodayChatGantt.tsx`

- [x] **Step 1: Replace the AI Chat contract with synchronized task inputs**

Import `listTasks`, `Project`, and `Task`, then use:

```ts
interface TodayChatGanttProps {
  projects: Project[];
  onOpenThread: (threadId: string) => void;
}

interface LoadedTask {
  task: Task;
  threadId: string;
  projectName: string;
}
```

Remove AI Chat run/status imports, snapshot requests, current-run helpers, and the local running timer.

- [x] **Step 2: Load synchronized tasks only on mount and manual refresh**

Build a stable dependency from project IDs. In the shared refresh callback load every persisted project concurrently:

```ts
const taskGroups = await Promise.all(
  projects.map(async (project) => ({
    project,
    tasks: await listTasks(project.id, controller.signal),
  })),
);

const loaded = taskGroups.flatMap(({ project, tasks }) => tasks.flatMap((task) => {
  const threadId = task.threadId?.trim();
  return threadId ? [{ task, threadId, projectName: project.name }] : [];
}));
```

The component must not poll, call the Codex history scanner, or refresh when only project metadata/object identity changes.

- [x] **Step 3: Derive and render clipped reference intervals**

Parse `task.createdAt` and `task.updatedAt`. Omit invalid or zero-length intervals; include intervals intersecting today; clip displayed geometry to the day boundaries; sort by creation time and task ID. Reuse the existing summary and fixed timeline structure.

Update visible strings to `今日 Codex 任务`, `任务`, `Codex 对话`, `正在读取今日任务`, and `今天暂无已同步的 Codex 任务`. Row clicks call `onOpenThread(row.threadId)`.

### Task 2: Wire projects and native thread opening

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/AiChat.tsx`

- [x] **Step 1: Remove chart-specific local AI Chat opening state**

Remove the `AiChatOpenRequest` import, `aiChatOpenRequest` state, `openAiChatThread` callback, `openRequest` prop passed to `<AiChat>`, and the matching contract/effect in `AiChat.tsx`. Preserve all unrelated AI Chat behavior.

- [x] **Step 2: Render the chart with persisted projects**

After project loading completes, render:

```tsx
{!projectsLoading && (
  <TodayChatGantt projects={projects} onOpenThread={openThread} />
)}
```

Do not gate the chart on `localAiChatAvailable`. The existing `openThread` behavior remains the single native conversation-opening path.

### Task 3: Verify the corrected direct path

**Files:**
- Verify only; do not add tests before user confirmation.

- [x] **Step 1: Run static and production checks**

Run:

```bash
npm run typecheck
npm run build
git diff --check
```

Expected: all commands exit 0. The build may retain the repository's existing bundle-size warning.

- [ ] **Step 2: Verify real synchronized data in the browser**

Open `http://127.0.0.1:5174/`, return to the project home, and click the Gantt refresh button. Confirm synchronized rows appear, summaries and clipping are coherent, and clicking a row opens its native Codex conversation.

- [x] **Step 3: Confirm the request policy**

Observe that task-list requests occur on chart mount and manual refresh only. Leave the development server running for user confirmation.
