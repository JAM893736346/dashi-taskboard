# Project Workspace And Codex Chat Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create Taskboard projects with a generated local workspace, register the same workspace in Codex through an explicit device link, and synchronize independent project Chats in both directions without automatically creating issues.

**Architecture:** A loopback-only workspace service owns the macOS parent picker, path validation, child-directory transaction, and device-local `taskboardProjectId -> { codexProjectId, workspacePath }` link. The React app consumes that link to merge Taskboard and native Codex projects and uses the existing local AI Chat runner for prompt-to-execution; Codex history reconciliation upserts local Chat threads by native thread ID and hydrates their visible messages.

**Tech Stack:** Node.js 22 local HTTP service, SQLite, JSON device configuration, React 19, TypeScript, Codex app-server JSON-RPC, Codex renderer `postMessage` bridge, macOS `osascript`

---

Project instructions explicitly replace test-first development for this feature. Do not add regression, mutation, compatibility, or speculative fallback tests before user confirmation; verify only the approved direct operation paths listed in Task 8.

## File Map

- Create `server/project-workspace.mjs`: native parent picker, generated directory and project ID, canonical path matching, empty-directory rollback.
- Modify `server/cloud-config.mjs`: persist the device-local Codex project ID beside the existing workspace mapping.
- Modify `server/app.mjs`: expose local picker/create/link/reconcile routes, resolve business projects in local or cloud mode, and dispatch Chat synchronization.
- Modify `server/database.mjs`: find and upsert AI Chat threads by `codexThreadId`, replace imported history events, and preserve native timestamps.
- Modify `server/ai-chat-catalog.mjs`: resolve a Taskboard project through an injected device-aware resolver when its Codex ID differs.
- Modify `server/ai-chat.mjs`: create prompt-titled threads, reconcile native titles, and import/resume Codex-originated threads.
- Modify `server/codex-history.mjs`: read visible turns/items and normalize them to the existing AI Chat event contract.
- Create `web/src/components/ProjectCreateDialog.tsx`: project name, parent chooser, final path preview, submit and inline error states.
- Modify `web/src/types.ts` and `web/src/api.ts`: workspace creation, project device link, registration, and Chat synchronization contracts.
- Modify `web/src/aiChatState.ts` and `web/src/components/AiChat.tsx`: derive the first Chat title from the submitted Prompt and refresh imported Chats.
- Modify `web/src/App.tsx`: open the create dialog, merge projects through device links, retry native registration, replace silent issue import with silent Chat synchronization, and resolve native operations through `codexProjectId`.
- Modify `web/src/styles.css`: focused dialog, generated path preview, and sync status presentation.
- Modify `inject/codex-taskboard.user.js`: allowlist workspace registration and return a narrow completion/error message.

### Task 1: Add The Device Link And Workspace Primitives

**Files:**
- Create: `server/project-workspace.mjs`
- Modify: `server/cloud-config.mjs`

- [x] **Step 1: Implement generated workspace names and canonical matching**

Export these concrete helpers from `server/project-workspace.mjs`:

```js
export function projectDirectoryName(name) {
  const normalized = name.normalize("NFKC").trim().replace(/\s+/g, " ");
  const safe = normalized.replace(/[\\/:\0]/g, "-").replace(/^\.+|[ .]+$/g, "").slice(0, 80);
  if (!safe) throw new ProjectWorkspaceError(400, "INVALID_PROJECT_NAME", "项目名称无法生成目录名");
  return safe;
}

export function projectIdFromName(name, nonce = randomUUID()) {
  const prefix = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  return `${prefix.slice(0, 54).replace(/-+$/g, "")}-${nonce.replace(/-/g, "").slice(0, 8)}`;
}

export async function canonicalWorkspacePath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) return null;
  try { return await realpath(value); } catch { return path.resolve(value); }
}

export async function matchCodexProjectByWorkspace(workspaces, workspacePath) {
  const expected = await canonicalWorkspacePath(workspacePath);
  for (const [codexProjectId, candidate] of Object.entries(workspaces)) {
    if (await canonicalWorkspacePath(candidate) === expected) return codexProjectId;
  }
  return null;
}
```

Define `ProjectWorkspaceError` with `status`, `code`, and `message` so `server/app.mjs` can translate failures without string matching.

- [x] **Step 2: Implement the macOS parent picker and preview**

Use `/usr/bin/osascript` only on Darwin and make cancel return `null`:

```js
export async function chooseProjectParent({ platform = process.platform, run = execFileAsync } = {}) {
  if (platform !== "darwin") {
    throw new ProjectWorkspaceError(501, "DIRECTORY_PICKER_UNAVAILABLE", "当前系统暂不支持原生目录选择器");
  }
  try {
    const { stdout } = await run("/usr/bin/osascript", [
      "-e",
      'POSIX path of (choose folder with prompt "选择项目父目录")',
    ]);
    return (await canonicalWorkspacePath(stdout.trim())) ?? null;
  } catch (error) {
    if (error?.code === 1 && String(error.stderr ?? "").includes("-128")) return null;
    throw new ProjectWorkspaceError(502, "DIRECTORY_PICKER_FAILED", "无法打开目录选择器");
  }
}

export async function previewProjectWorkspace({ name, parentPath }) {
  const parent = await canonicalWorkspacePath(parentPath);
  if (!parent || !(await stat(parent)).isDirectory()) {
    throw new ProjectWorkspaceError(400, "INVALID_PARENT_DIRECTORY", "请选择存在的父目录");
  }
  const directoryName = projectDirectoryName(name);
  return { directoryName, workspacePath: path.join(parent, directoryName) };
}
```

- [x] **Step 3: Implement the single-directory transaction**

Add a callback-based operation that owns only the child directory it creates:

```js
export async function createProjectWorkspace({ name, parentPath, createBusinessProject, saveDeviceLink }) {
  const preview = await previewProjectWorkspace({ name, parentPath });
  const id = projectIdFromName(name);
  try {
    await mkdir(preview.workspacePath, { recursive: false });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new ProjectWorkspaceError(409, "PROJECT_DIRECTORY_EXISTS", "目标项目目录已存在");
    }
    throw error;
  }
  try {
    const project = await createBusinessProject({ id, name: name.trim(), workspacePath: preview.workspacePath });
    return {
      project,
      link: await saveDeviceLink(id, { workspacePath: preview.workspacePath, codexProjectId: null }),
    };
  } catch (error) {
    await rmdir(preview.workspacePath).catch(() => {});
    throw error;
  }
}
```

Do not use recursive removal; rollback succeeds only while the request-created directory remains empty. `saveDeviceLink` must be part of the same successful local operation and return the normalized `ProjectDeviceLink` rather than the entire config object.

- [x] **Step 4: Extend local companion configuration without replacing existing workspace consumers**

Keep `projectMappings` as the canonical Taskboard-to-workspace map and add `codexProjectMappings`:

```js
function emptyConfig() {
  return {
    version: CONFIG_VERSION,
    remoteUrl: null,
    actorName: null,
    sharedKey: null,
    projectMappings: {},
    codexProjectMappings: {},
  };
}
```

Allow an absent `codexProjectMappings` in existing version-1 files, validate every value as a non-empty string, and expose:

```js
function projectLinkFromConfig(config, taskboardProjectId) {
  const workspacePath = config.projectMappings[taskboardProjectId];
  if (!workspacePath) return null;
  const codexProjectId = config.codexProjectMappings[taskboardProjectId] ?? null;
  return {
    taskboardProjectId,
    workspacePath,
    codexProjectId,
    status: codexProjectId ? "synced" : "pending",
  };
}

async setProjectLink(projectId, { workspacePath, codexProjectId }) {
  if (typeof projectId !== "string" || !projectId.trim()) {
    throw new CloudConfigError("INVALID_PROJECT_MAPPING", "projectId is required");
  }
  if (typeof workspacePath !== "string" || !path.isAbsolute(workspacePath)) {
    throw new CloudConfigError("INVALID_PROJECT_MAPPING", "workspacePath must be absolute");
  }
  if (codexProjectId !== null && (typeof codexProjectId !== "string" || !codexProjectId.trim())) {
    throw new CloudConfigError("INVALID_PROJECT_MAPPING", "codexProjectId must be null or non-empty");
  }
  const config = await update((config) => {
    const codexProjectMappings = { ...config.codexProjectMappings };
    if (codexProjectId === null) delete codexProjectMappings[projectId];
    else codexProjectMappings[projectId] = codexProjectId.trim();
    return {
      ...config,
      projectMappings: { ...config.projectMappings, [projectId]: workspacePath },
      codexProjectMappings,
    };
  });
  return projectLinkFromConfig(config, projectId);
}
async listProjectLinks() {
  await pendingWrite;
  const config = await readFromDisk();
  return Object.keys(config.projectMappings).map((taskboardProjectId) => ({
    taskboardProjectId,
    workspacePath: config.projectMappings[taskboardProjectId],
    codexProjectId: config.codexProjectMappings[taskboardProjectId] ?? null,
    status: config.codexProjectMappings[taskboardProjectId] ? "synced" : "pending",
  }));
}
```

Retain `setProjectWorkspace()` as an atomic update of only `projectMappings[projectId]`, leaving `codexProjectMappings[projectId]` unchanged, because automatic processing and cloud localization already call it.

### Task 2: Expose Transactional Project Creation And Link Reconciliation

**Files:**
- Modify: `server/app.mjs`

- [x] **Step 1: Wire the workspace service into server construction**

Import the Task 1 helpers, add `projectParentPicker` and `projectWorkspaceCreator` injectable options, and keep the real operation as the defaults:

```js
const projectParentPicker = options.projectParentPicker ?? chooseProjectParent;
const projectWorkspaceCreator = options.projectWorkspaceCreator ?? createProjectWorkspace;
```

Add this local `remoteBusiness()` helper, which calls `cloudProxy.forward()` with a JSON `Request` and translates a non-2xx response into `ApiError`:

```js
async function remoteBusiness(pathname, { method = "GET", body } = {}) {
  const headers = new Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  const upstream = await cloudProxy.forward(new Request(`http://127.0.0.1${pathname}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const payload = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    throw new ApiError(
      upstream.status,
      payload.error?.code ?? "BUSINESS_REQUEST_FAILED",
      payload.error?.message ?? `Business request failed (${upstream.status})`,
    );
  }
  return payload;
}
```

- [x] **Step 2: Create business projects through the active local/cloud path**

Inside `createTaskboardServer()`, define:

```js
async function createBusinessProject(input) {
  const config = await cloudConfig.read();
  if (config.remoteUrl) {
    const payload = await remoteBusiness("/api/projects", { method: "POST", body: {
      id: input.id,
      name: input.name,
      workspacePath: input.workspacePath,
    }});
    return payload.project;
  }
  const project = database.createProject(input);
  events.emit("project.created", { project });
  return project;
}
```

Cloud forwarding strips `workspacePath` before the business write and stores it in local config through the existing proxy localization path. Local mode stores it in SQLite.

- [x] **Step 3: Add loopback-only picker, preview, create, list, save, and reconcile routes**

Add these routes before the generic cloud forwarding block; `/api/local/*` already requires loopback:

```text
POST /api/local/project-parent-picker
POST /api/local/project-workspaces/preview     { name, parentPath }
POST /api/local/project-workspaces             { name, parentPath }
GET  /api/local/project-links
PUT  /api/local/project-links/:projectId       { workspacePath, codexProjectId }
POST /api/local/project-links/:projectId/reconcile { workspacePath }
```

The create route calls:

```js
const result = await projectWorkspaceCreator({
  ...parseProjectWorkspaceInput(await readJson(request)),
  createBusinessProject,
  saveDeviceLink: (projectId, link) => cloudConfig.setProjectLink(projectId, link),
});
return sendJson(response, 201, result);
```

The reconcile route calls `readCodexProjectWorkspaces()`, matches by canonical workspace path, saves the opaque native ID when found, and returns a `pending` link otherwise. It must never derive the native ID from the Taskboard ID.

- [x] **Step 4: Keep all new routes local in cloud mode**

Confirm `isLocalCompanionRoute()` continues to match the new `/api/local/*` routes. Do not add filesystem paths or `codexProjectId` to `cloud/src/index.mjs`, D1 migrations, or remote business records.

### Task 3: Add The Browser Contract And Project Create Dialog

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`
- Create: `web/src/components/ProjectCreateDialog.tsx`
- Modify: `web/src/styles.css`

- [x] **Step 1: Define one typed device-link contract**

Add:

```ts
export interface ProjectDeviceLink {
  taskboardProjectId: string;
  codexProjectId: string | null;
  workspacePath: string;
  status: "pending" | "synced";
}

export interface ProjectWorkspacePreview {
  directoryName: string;
  workspacePath: string;
}

export interface ProjectWorkspaceCreateResult {
  project: Project;
  link: ProjectDeviceLink;
}

export interface AiChatSyncResult {
  created: number;
  updated: number;
  skipped: number;
}
```

- [x] **Step 2: Add exact local HTTP functions**

Add `pickProjectParent()`, `previewProjectWorkspace(name, parentPath)`, `createProjectWorkspace(name, parentPath)`, `listProjectDeviceLinks()`, `saveProjectDeviceLink(projectId, input)`, `reconcileProjectDeviceLink(projectId, workspacePath)`, and `syncAiChats()` to `web/src/api.ts`. Return `null` when the picker responds with `{ parentPath: null }`; let ordinary `ApiError` handling surface all other failures.

- [x] **Step 3: Build the focused dialog**

`ProjectCreateDialog` receives:

```ts
interface ProjectCreateDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (result: ProjectWorkspaceCreateResult) => void;
}
```

Use a native `<dialog>` with a required name input, a folder icon button for `pickProjectParent()`, a read-only path preview returned by `previewProjectWorkspace()`, and one primary `创建项目` button. Picker cancellation must leave prior form state unchanged; submitting calls `createProjectWorkspace()` exactly once and reports the server message inline.

- [x] **Step 4: Style only the dialog and sync label**

Add compact `.project-create-dialog`, `.project-create-directory`, `.project-sync-status.is-pending`, and `.project-sync-status.is-synced` rules. Reuse existing colors, dialog shadow, button classes, 8px-or-smaller radii, and responsive breakpoints; do not add cards inside the dialog.

### Task 4: Merge Projects Through Device Links And Register Pending Workspaces

**Files:**
- Modify: `web/src/App.tsx`

- [x] **Step 1: Load business projects, native workspaces, and links together**

Replace browser-local `deviceWorkspacePaths` as the authoritative source with `ProjectDeviceLink[]` loaded by `listProjectDeviceLinks()`. Build maps by Taskboard ID and native Codex ID; migrate an existing typed path only by calling `saveProjectDeviceLink()` when the server has no link, then read the server result back.

- [x] **Step 2: Merge host projects by native ID and expose sync state**

For each `hostContext.projects` item, resolve `linkByCodexProjectId.get(project.id)?.taskboardProjectId` before checking `persistedById`. For each persisted project, set `inCodex` from its link's native ID or direct native ID match. `ProjectChoice.id` remains the stable Taskboard ID and gains `codexProjectId`, `workspacePath`, and `syncStatus` fields.

- [x] **Step 3: Create and open the project from the home action**

Add a folder-plus `创建项目` button beside the manual history action and mount `ProjectCreateDialog` once near the other top-level dialogs. On `onCreated`:

```ts
setProjects((current) => [...current.filter((item) => item.id !== result.project.id), result.project]);
upsertProjectDeviceLink(result.link);
changeProject(result.project.id);
if (embedded) registerWorkspace(result.link);
```

Update the empty state copy so project creation is available directly from Taskboard.

- [x] **Step 4: Register and reconcile a pending workspace**

In embedded mode, post:

```ts
window.parent.postMessage({
  type: "taskboard:register-workspace",
  payload: {
    taskboardProjectId: link.taskboardProjectId,
    workspacePath: link.workspacePath,
  },
}, "*");
```

Handle `taskboard:workspace-registered` by calling `reconcileProjectDeviceLink()`, upserting the returned link, refreshing the project list, and announcing `已同步到 Codex` only when the returned status is `synced`. Retry any pending selected-project link after `taskboard:opened` or host context refresh.

- [x] **Step 5: Resolve every native operation through the device link**

Replace the current `selectedProject.id` fallback in `openTaskInThread()` and development-context calls with:

```ts
const selectedProjectLink = projectLinkByTaskboardId.get(selectedProjectId);
const codexProjectId = selectedProjectLink?.codexProjectId ?? null;
const workspacePath = worktreePath ?? selectedProjectLink?.workspacePath ?? selectedProject?.workspacePath ?? null;
```

Pass the real `codexProjectId` only when available. Do not assume equal IDs for automation, project selection, or composer preparation.

### Task 5: Allowlist Native Workspace Registration

**Files:**
- Modify: `inject/codex-taskboard.user.js`

- [x] **Step 1: Implement the narrow bridge operation**

Add:

```js
async function registerProjectWorkspace(payload) {
  const taskboardProjectId = typeof payload?.taskboardProjectId === "string" ? payload.taskboardProjectId.trim() : "";
  const workspacePath = typeof payload?.workspacePath === "string" ? payload.workspacePath.trim() : "";
  if (!taskboardProjectId || !workspacePath) return;
  try {
    const bridge = window.electronBridge;
    if (!bridge || typeof bridge.sendMessageFromView !== "function") {
      throw new Error("当前 Codex 版本没有提供项目注册能力");
    }
    await bridge.sendMessageFromView({ type: "electron-set-active-workspace-root", root: workspacePath });
    postHostContext();
    postToFrame({ type: "taskboard:workspace-registered", payload: { taskboardProjectId, workspacePath } });
  } catch (error) {
    postToFrame({ type: "taskboard:workspace-registration-failed", payload: {
      taskboardProjectId,
      message: error instanceof Error ? error.message : "项目注册失败",
    }});
  }
}
```

- [x] **Step 2: Add exactly one message branch**

Handle only `taskboard:register-workspace` in the existing frame-message listener and call `registerProjectWorkspace(message.payload)`. Do not expose arbitrary Electron messages or filesystem operations to the iframe.

### Task 6: Derive The Initial Chat Title From The First Prompt

**Files:**
- Modify: `web/src/aiChatState.ts`
- Modify: `web/src/components/AiChat.tsx`

- [x] **Step 1: Add the 32-character display title helper**

```ts
export function promptChatTitle(message: string): string | undefined {
  const firstLine = message.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!firstLine) return undefined;
  return Array.from(firstLine.replace(/\s+/g, " ")).slice(0, 32).join("");
}
```

- [x] **Step 2: Freeze that title when the first Prompt creates the Chat**

Change `createThreadForDraftOrigin()` to accept `title?: string`, pass it to `createAiChatThread()`, and call it from `startMessage()` as:

```ts
if (!thread) thread = await createThreadForDraftOrigin(promptChatTitle(trimmed));
```

Opening `新建对话` remains side-effect free; only the first submitted Prompt creates the local Chat and immediately starts its Codex turn.

### Task 7: Upsert And Hydrate Codex-Originated Chats

**Files:**
- Modify: `server/codex-history.mjs`
- Modify: `server/database.mjs`
- Modify: `server/ai-chat-catalog.mjs`
- Modify: `server/ai-chat.mjs`
- Modify: `server/app.mjs`
- Modify: `web/src/api.ts`
- Modify: `web/src/components/AiChat.tsx`
- Modify: `web/src/App.tsx`

- [x] **Step 1: Normalize visible Codex thread history**

Add `generatedTitle: typeof value.name === "string" && value.name.trim() ? value.name.trim() : null` to `historyThread()`, while keeping its existing `title` fallback for the manual issue-import UI. Add `readCodexChatThreads({ codexExecutable, cwd, threadIds })` using the existing `withCodexAppServer()` and `thread/read` with `{ threadId, includeTurns: true }`. Flatten turn items in order and emit only visible messages:

```js
function codexChatEvent(item, threadId, index) {
  const content = item?.type === "userMessage"
    ? (Array.isArray(item.content)
      ? item.content.filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text).join("\n")
      : "")
    : item?.type === "agentMessage" && typeof item.text === "string"
      ? item.text
      : "";
  if (!content.trim()) return null;
  if (item.type === "userMessage") {
    return { id: `${threadId}:history:${index}`, type: "user_message", role: "user", content };
  }
  if (item.type === "agentMessage") {
    return { id: `${threadId}:history:${index}`, type: "agent_message", role: "assistant", content };
  }
  return null;
}
```

The observed Codex app-server schema uses `userMessage.content[]` text blocks and `agentMessage.text`; ignore reasoning, file change, command, tool, and other activity records in this change.

- [x] **Step 2: Add idempotent native-thread upsert storage**

Add `getAiChatThreadByCodexThreadId(codexThreadId)` and `upsertCodexAiChatThread(input)` to `TaskboardDatabase`. The transaction must:

```text
find existing ai_chat_threads row by codex_thread_id
create it when absent, otherwise update origin/timestamps and update title only when generatedTitle is non-null
delete only events whose data contains { source: "codex-history" }
insert normalized history events with data { source: "codex-history" }
commit and return the one local Chat thread
```

Preserve locally produced run events and active thread status. Repeated scans update the same row and never create a second Chat for the same native thread ID.

- [x] **Step 3: Make AI workspace resolution device-link aware**

Allow `resolveAiWorkspace()` and `discoverAiCatalog()` to receive an optional project/device resolver. When present, resolve the stable Taskboard project metadata, workspace path, and native Codex ID from the device link; still return `addDirectories` from all available device workspaces. This lets local Chat execution work when `taskboardProjectId !== codexProjectId` and in local-companion cloud mode.

- [x] **Step 4: Add Chat reconciliation to `AiChatService`**

Inject `listCodexHistory`, `readCodexChatThreads`, and a `listProjectsWithDeviceLinks` callback. Implement `syncCodexHistory()` as:

```text
list Codex thread metadata
match cwd to Taskboard projects through canonical workspace paths
read visible history for matched native thread IDs
obtain each project's current default model/reasoning effort once
upsert by codexThreadId with project origin, native title, timestamps, and hydrated events
return { created, updated, skipped }
```

For Taskboard-originated Chats, match by `codexThreadId` and replace the prompt title only when Codex supplies a non-empty generated `name`; retain the prompt excerpt when history has only `preview`.

- [x] **Step 5: Expose one silent Chat synchronization route**

Add loopback-only:

```text
POST /api/local/ai/sync-codex-history
```

It accepts an empty body, calls `aiChat.syncCodexHistory()`, and returns the counts. It never calls `/api/codex-import`, `database.importCodexTask()`, or emits `task.created`.

- [x] **Step 6: Refresh the Chat list after synchronization**

Add an optional numeric `syncRevision` prop to `AiChat`. Include it in the effect that calls `loadThreads()`, preserving the selected local thread when it still exists.

- [x] **Step 7: Replace the current automatic issue import**

In the existing `codexHistorySyncRequest` effect in `App.tsx`, replace `listCodexHistory() + listImportedCodexThreadIds() + importCodexHistory()` with one silent `syncAiChats()` call. Increment `aiChatSyncRevision` when `created > 0 || updated > 0`; do not refresh project issue counts and do not show the manual history dialog.

Keep `CodexHistorySyncDialog` and `/api/codex-import` unchanged as the explicit Chat-to-issue conversion path; adjust its visible copy only if it currently implies automatic import.

### Task 8: Verify The Approved Direct Paths And Commit

**Files:**
- Verify: all files listed above
- Do not stage: `scripts/codex-injector-runtime.mjs`, `scripts/codex-injector.mjs`, `test/injector.test.mjs`, `.superpowers/`, `test/injector-startup.test.mjs`

- [x] **Step 1: Run static and production checks**

Run:

```bash
node --check server/project-workspace.mjs
node --check server/app.mjs
node --check server/ai-chat.mjs
node --check server/codex-history.mjs
node --check inject/codex-taskboard.user.js
npm run typecheck
npm run build
git diff --check
```

Expected: every command exits 0. `npm run build` may report the existing bundle-size warning and may refresh an already open embedded frame.

- [x] **Step 2: Verify standalone project creation**

Run `npm run dev`, open the reported localhost URL, choose a disposable parent directory, create a named project, and record:

```text
POST /api/local/project-parent-picker -> absolute parent path
POST /api/local/project-workspaces/preview -> generated child path
POST /api/local/project-workspaces -> 201 with project + pending device link
filesystem child directory exists
Taskboard opens the stable Taskboard project ID
project card shows 等待 Codex 同步
```

- [x] **Step 3: Verify embedded native registration and double-ID merging**

Run `npm run codex:reload`, open Taskboard in the CDP-enabled Codex window, and confirm the child root is activated through `electron-set-active-workspace-root`. Read `GET /api/local/project-links` and confirm one link contains the stable Taskboard ID, opaque Codex ID, and canonical workspace path; the project home shows one merged project with `已同步到 Codex`.

- [ ] **Step 4: Verify Taskboard-originated Chat execution and title reconciliation**

Inside the new project, click `新建对话` and confirm no Chat is created yet. Submit a multi-line Prompt and confirm the first non-empty line is immediately shown, capped at 32 display characters, execution starts in the linked workspace, and the saved `codexThreadId` appears under the same native Codex project. Reopen Taskboard after Codex names the thread and confirm the title reconciles without changing the issue count.

Verified the side-effect-free composer, prompt title, immediate execution, saved native thread ID, Taskboard reconciliation, and unchanged issue count. Codex persists Taskboard-created runs with `source: "exec"`; its default desktop history filter only lists `cli`/`vscode`, so native project-list visibility remains a host-surface limitation.

- [ ] **Step 5: Verify Codex-originated Chat import and resume**

Create a Chat directly inside the native Codex project, reopen Taskboard, and confirm it appears exactly once with visible user/assistant history. Continue it from Taskboard and confirm the run resumes the same native thread ID. Compare project issue count before and after; it must remain unchanged. Open the manual `同步 Codex 历史` dialog and confirm explicit issue import remains available.

- [x] **Step 6: Inspect and commit only this implementation**

Review `git diff --stat`, `git diff --check`, and the complete staged diff. Stage only the implementation files from Tasks 1-7 and create one focused commit:

```bash
git commit -m "feat: sync project workspaces and Codex chats"
```

Leave all pre-existing injector-runtime and test changes unstaged.
