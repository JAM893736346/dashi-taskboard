# Project Workspace And Codex Chat Sync Design

## Status

Approved in conversation on 2026-08-07.

## Goal

Let a user create a Taskboard project and its local execution directory from the project home, register the same directory as a native Codex project, and keep independent project Chats discoverable and resumable whether they start in Taskboard or Codex.

## Confirmed Scope

- One execution root directory per Taskboard project.
- A required project name and a user-selected parent directory.
- A generated child directory based on the project name.
- A stable Taskboard project ID, a device-local Codex project ID, and a canonical workspace path.
- Taskboard-originated project Chats execute immediately when their first Prompt is submitted.
- Codex-originated project Chats synchronize into Taskboard Chat history.
- Chat titles start with a Prompt excerpt and later reconcile to the Codex-generated title.
- Project Chats remain independent and do not automatically create Taskboard issues.
- The existing manual Codex history import remains an explicit way to turn selected Codex Chats into issues.

## Non-Goals

- Do not create a Chat as a side effect of creating a project.
- Do not create per-issue directories or worktrees.
- Do not initialize Git repositories or create branches.
- Do not automatically turn every project Chat into an issue.
- Do not add the future Chat-to-issue action or relationship blueprint in this change.
- Do not put device paths or device-local Codex IDs into cloud business records.
- Do not write Codex state files directly.

## Existing Operation Paths

### Persist A Codex-Discovered Project

1. `inject/codex-taskboard.user.js` reads native Codex project rows and sends them in host context.
2. `web/src/App.tsx` merges those projects into the project home.
3. Selecting a project that Taskboard has not persisted calls `createProjectRequest()` with `workspacePath: null`.
4. `web/src/api.ts` sends `POST /api/projects`.
5. `server/app.mjs` validates the request and calls `TaskboardDatabase.createProject()`.
6. `server/database.mjs` inserts the project and the board becomes observable.

This path cannot create a local directory and assumes the project already exists in Codex.

### Start A Taskboard Chat

1. `web/src/App.tsx` mounts `AiChat` with the selected Taskboard project ID and optional issue ID.
2. The first submitted Prompt makes `web/src/components/AiChat.tsx` create a local Chat and immediately start its first turn.
3. `server/ai-chat.mjs` resolves the project workspace and launches `codex exec` in that directory.
4. The `thread.started` event supplies the native Codex thread ID, which is stored on the local Chat.
5. Later turns resume that native thread.

This path already provides the required submit-to-execute behavior. It lacks Prompt-derived titles, Codex-title reconciliation, and native-origin Chat import.

### Current Silent History Import

Commit `7df7708` added a `taskboard:opened` signal and a React effect that scans Codex history whenever Taskboard opens. It currently sends every automatically matched thread to `POST /api/codex-import`, which creates backlog issues.

The open/reopen trigger is retained. Its automatic destination changes from issue import to independent Chat synchronization so the latest approved Chat semantics are respected. The manual history dialog retains explicit Chat-to-issue import.

## Identity Model

The integration has three distinct identifiers:

| Value | Scope | Consumers |
| --- | --- | --- |
| `taskboardProjectId` | Stable business identity | Issues, workflows, CLI, Taskboard automatic processing, future relationship graph |
| `codexProjectId` | Device-local native identity | Native Codex project selection, host navigation, native scheduled automation |
| `workspacePath` | Device-local association and execution root | Codex execution cwd, history matching, development contexts, remapping |

The device link is:

```text
taskboardProjectId -> { codexProjectId, workspacePath }
```

`workspacePath` does not replace either ID. It is the recovery key when a Codex ID is missing, stale, or different on another device.

The path and Codex ID remain local companion data. Cloud business persistence keeps only the stable Taskboard project identity and ordinary project metadata. Each device establishes its own native mapping.

## Project Creation Experience

The project home gains a folder-plus action named `创建项目`. It opens a focused dialog with:

- required project name;
- parent-directory selector;
- read-only final directory preview;
- primary `创建项目` command.

The parent-directory selector is a local companion operation because browser directory handles do not expose an absolute filesystem path. On the supported macOS launcher path, the companion opens the native folder chooser and returns the selected absolute path. Canceling the chooser changes no state.

The child directory name is generated from the project name and shown before submission. Project creation is one loopback-only local companion operation. The server validates the parent and final path, rejects an existing target, creates only the new child directory, creates the business project through the current local-or-cloud dispatch, stores the device path locally, and returns the project with its canonical absolute path. If business project creation fails, the server removes only the empty child directory created by that same request.

## Project Creation Data Flow

1. The user enters a project name and selects a parent directory.
2. The browser sends one local project-create request containing the project name and selected parent path.
3. The local companion derives the stable Taskboard project ID and generated child path, validates both, and rejects an existing target before writing.
4. The companion creates the child directory and creates the business project through the current local database or cloud proxy path.
5. Local mode stores the path with the project. Cloud mode excludes the device path from the upstream business record and stores it in local companion mapping, following the existing cloud proxy pattern.
6. If business creation fails, the companion removes the empty child directory created by this request and returns the error. Otherwise, the new project opens immediately in Taskboard.
7. When embedded in Codex, the iframe sends a narrow registration message containing the Taskboard project ID and workspace path.
8. The renderer injection calls the existing `electron-set-active-workspace-root` bridge action. It does not edit Codex state files.
9. The local companion reads Codex device workspaces, finds the native project whose canonical root equals the new workspace path, and obtains its opaque Codex project ID.
10. The companion saves the complete device link and the browser refreshes project choices.
11. Native and persisted project lists merge through the explicit device link, so the same directory is not shown twice when the IDs differ.

Standalone localhost creation completes steps 1-6. Native registration is marked pending and automatically completes the next time the project is opened in the embedded Codex surface.

## Device Mapping Contract

The local companion owns the mapping contract. The existing device-local project mapping storage is extended to keep the Codex project ID beside the workspace path.

The browser can:

- list Taskboard-to-Codex device links;
- save or refresh a link after native registration;
- distinguish `synced` from `pending` for project-card presentation.

Native operations always resolve both IDs from this contract. They never assume that `taskboardProjectId === codexProjectId`. Workspace matching repairs a missing or stale native ID before the operation continues.

## Taskboard-Originated Chat Flow

1. The user enters a project and opens the existing Chat panel.
2. Clicking `新建对话` opens an empty composer and has no side effect.
3. Submitting the first Prompt creates a local Chat and immediately starts a Codex turn in the mapped workspace.
4. The initial title is the first non-empty Prompt line, normalized and capped at 32 display characters.
5. `thread.started` stores the native Codex thread ID on the same local Chat.
6. The thread appears in native Codex history under the mapped project workspace.
7. A later history reconciliation matches the native thread by ID and replaces the temporary title when Codex exposes a generated name.

Issue-linked Chats continue to carry their issue origin and follow the same Prompt/Codex title sequence. The issue identifier remains visible as association metadata rather than being used as the Chat title.

## Codex-Originated Chat Flow

1. The retained `taskboard:opened` signal requests a silent Chat synchronization each time Taskboard opens. Standalone starts one request after initial project loading.
2. The local service reads Codex thread history.
3. Each native thread is matched to a Taskboard project by canonical `cwd` containment against device project workspace paths.
4. Threads with no matched project remain untouched.
5. A matched thread is upserted into local Chat storage by native Codex thread ID, with the Taskboard project origin, native title, timestamps, and device workspace association.
6. New or updated native threads hydrate their visible user and assistant message history from Codex thread data.
7. Selecting an imported Chat in Taskboard can continue it through `codex exec resume <threadId>`.
8. Repeated scans update the existing Chat instead of creating duplicates.

Automatic Chat synchronization never calls the issue-import endpoint and never changes project issue counts.

## Manual Chat-To-Issue Import

The existing `同步 Codex 历史` dialog remains available as an explicit conversion path. Its copy should make clear that the selected Chat history will be imported into the issue board. This preserves the current manual capability while keeping automatic synchronization Chat-only.

The future direct `建立议题` action from a Chat and the blueprint-like relationship view are separate deliverables. They will use the stable Taskboard project ID, issue ID, and Chat thread ID established by this design.

## Title Reconciliation

Local Chat creation must not wait for title generation. The first Prompt excerpt is immediately visible. Codex history remains the authoritative source for a later generated title:

- match by native thread ID;
- replace the temporary title only when Codex exposes a non-empty generated `name`;
- otherwise retain the Prompt excerpt;
- use the same upsert path for native-origin title changes.

Title synchronization does not rename the Taskboard project or its directory.

## User-Visible States And Errors

- Canceling parent selection performs no write.
- An existing target directory or insufficient permission produces an inline creation error and never overwrites content.
- If business project creation fails after directory creation, only the empty directory created by that request is removed; pre-existing paths are never removed.
- A successful Taskboard project whose native registration is unavailable remains usable and displays `等待 Codex 同步`.
- Successful registration displays `已同步到 Codex`.
- The next embedded open retries pending registration.
- A stale Codex ID is rediscovered by canonical workspace path and the device link is refreshed.
- Silent Chat synchronization failures do not replace the board with an error state. The manual synchronization action remains the visible recovery path.
- Automatic synchronization never creates issues.

## Ownership Boundaries

### Web UI

- `web/src/App.tsx`: project-create orchestration, pending registration retry, open-triggered Chat synchronization, device-link consumption.
- New focused project-create dialog component: project name, parent picker, directory preview, submission state.
- `web/src/components/AiChat.tsx`: Prompt-derived initial title and display of synchronized independent Chats.
- `web/src/api.ts` and `web/src/types.ts`: local directory, device-link, and Chat synchronization contracts.
- `web/src/styles.css`: project dialog and synchronization status presentation.

### Local Service

- `server/app.mjs`: loopback-only routes for parent selection, transactional local project creation, device links, and Chat synchronization dispatch.
- A focused local project-workspace helper: native picker, child-directory creation, canonicalization, and Codex-root matching.
- Device-local configuration: workspace and native Codex ID mapping.
- `server/ai-chat.mjs`: native-thread upsert, history hydration, resume, and title reconciliation.
- `server/codex-history.mjs`: reusable native thread metadata and visible-history reads.

### Codex Host

- `inject/codex-taskboard.user.js`: one allowlisted workspace-registration message using `electron-set-active-workspace-root`, followed by a narrow completion/error response.

The iframe remains unprivileged. Filesystem writes occur in the local service, and native Codex actions occur in the renderer injection.

## Direct-Path Verification

1. In standalone localhost, choose a parent directory and create a project.
2. Confirm the generated child directory exists, the Taskboard project opens, and its native state is pending.
3. Open Taskboard inside the CDP-enabled Codex window and confirm the same root appears as one native project, the device link contains both IDs, and the project card shows synchronized.
4. Start a project Chat in Taskboard. Confirm the first Prompt immediately starts execution, the temporary title is a Prompt excerpt, and the same native thread appears under the correct Codex project.
5. Reopen Taskboard after Codex generates a title. Confirm the local title updates without creating an issue.
6. Start a Chat directly inside that Codex project. Reopen Taskboard and confirm it appears once in Chat history with visible messages and does not change issue count.
7. Continue the imported Chat from Taskboard and confirm Codex resumes the same native thread ID.
8. Confirm the manual history-import dialog still supports explicit import into issues.
9. Run type checking, the production build, user-script syntax checking, and diff whitespace checking.

## Follow-Up Deliverables

1. Add an explicit `建立议题` command to a project Chat, preserving its thread association.
2. Design a relationship graph that can connect Chats, issues, and workflow/process nodes without conflating it with the existing workflow-definition board.
