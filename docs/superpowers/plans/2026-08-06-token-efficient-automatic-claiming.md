# Token-Efficient Automatic Claiming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one device-global automatic-processing dispatcher that deterministically claims eligible issues without AI polling and starts the configured Codex model only for an exact claimed issue.

**Architecture:** A pure shared policy ranks tasks, while SQLite or D1 performs the atomic claim and `todo` to `in_progress` transition. A resident local dispatcher owns event/fallback reconciliation, quota and daily-capacity checks, one-shot Codex execution, retries, leases, and local status; a React popover reads and updates one mode-0600 settings file through local-only HTTP endpoints.

**Tech Stack:** Node.js 22, `node:sqlite`, Cloudflare Worker/D1, React 19, TypeScript, Vite, Codex `exec --json`

---

## File Map

- Create `shared/automatic-processing.mjs`: defaults, settings normalization, eligibility, project fairness, and candidate ranking.
- Create `shared/automatic-processing.d.mts`: browser-facing settings, status, and Claim declarations.
- Create `server/automatic-processing-config.mjs`: atomic mode-0600 device settings persistence.
- Create `server/automatic-processing-business.mjs`: local SQLite versus authenticated cloud-API adapter.
- Create `server/automatic-processing-runner.mjs`: exact-issue one-shot Codex process using the existing JSONL protocol.
- Create `server/automatic-processing.mjs`: event-coalesced dispatcher, fallback timer, quota/daily capacity, leases, retries, status, and history.
- Modify `server/database.mjs`: local Claim schema and atomic Claim lifecycle methods.
- Modify `server/app.mjs`: local settings/status routes, dispatcher lifecycle, and business-event wake-up.
- Modify `scripts/codex-rate-limits.mjs`: allow the configured Codex executable to be used by the dispatcher.
- Create `cloud/migrations/0002_automation_claims.sql`: shared D1 Claim table, active uniqueness, and revision triggers.
- Modify `cloud/src/index.mjs`: authenticated Claim acquisition/list/lifecycle endpoints with D1 atomic batches.
- Modify `test/helpers/cloud-worker-harness.mjs`: apply both numbered migrations so existing cloud verification can boot the current schema.
- Modify `web/src/types.ts` and `web/src/api.ts`: global settings/status/history contracts and local-only API calls.
- Create `web/src/components/AutomaticProcessingMenu.tsx`: complete global settings and observability popover.
- Modify `web/src/App.tsx` and `web/src/styles.css`: replace per-project browser automation state with the global server-backed menu on home and project headers.
- Preserve without editing: `scripts/codex-injector.mjs`, `scripts/codex-injector-runtime.mjs`, `test/injector.test.mjs`, and `test/injector-startup.test.mjs`.

## Pre-Confirmation Scope Boundary

The repository's development rules require the direct path to work and be shown to the user before adding compatibility and defensive branches. Therefore this first implementation persists retry/lease states and exposes every approved setting, but intentionally defers two design sections until the user confirms the direct path: pausing pre-existing native Cron automations, and dispatcher-authored error comments plus automatic movement to `blocked` after exhausted retries. Automatic processing never moves an issue to `done`.

### Task 1: Pure Settings And Claim Policy

**Files:**
- Create: `shared/automatic-processing.mjs`
- Create: `shared/automatic-processing.d.mts`

- [ ] **Step 1: Define the complete global defaults and strict normalization**

Export this settings shape and reject unknown, missing, or out-of-range values at the HTTP boundary:

```js
export const DEFAULT_AUTOMATIC_PROCESSING_SETTINGS = Object.freeze({
  version: 1,
  enabled: false,
  projectMode: "selected",
  projectIds: [],
  claimStrategy: "board-order",
  executionModel: "gpt-5.6-sol",
  reasoningEffort: "high",
  maxConcurrency: 1,
  fallbackIntervalMinutes: 5,
  quotaAware: true,
  dailyRunLimit: 10,
  includeLabels: [],
  excludeLabels: ["manual", "no-auto"],
  minimumPriority: "none",
  requireDevelopmentContext: false,
  maxRetries: 1,
  retryDelayMinutes: 15,
});
```

- [ ] **Step 2: Implement fixed eligibility and deterministic ranking**

`rankAutomaticProcessingCandidates({ tasks, projects, activeTaskIds, settings, lastProjectId })` must:

```js
// Filter before sorting.
task.status === "todo"
&& task.archivedAt === null
&& task.assignee?.type === "agent"
&& String(task.assignee?.id).endsWith("codex-agent")
&& mappedAndEnabledProjectIds.has(task.projectId)
&& !activeTaskIds.has(task.id)
&& task.relations.blockedBy.every((blocker) => ["done", "canceled"].includes(blocker.status))
&& labelsPass(task.labels, settings.includeLabels, settings.excludeLabels)
&& priorityPass(task.priority, settings.minimumPriority)
&& (!settings.requireDevelopmentContext || task.developmentContext !== null)
```

Choose the next project after `lastProjectId` in stable project order, then sort only that project's tasks by `board-order`, `priority-first`, or `due-date-first`, always ending with `sortOrder`, `createdAt`, and `id` tie breakers.

- [ ] **Step 3: Verify the module can be imported and the empty list stays empty**

Run:

```bash
node --input-type=module -e 'import {DEFAULT_AUTOMATIC_PROCESSING_SETTINGS,rankAutomaticProcessingCandidates} from "./shared/automatic-processing.mjs"; const result=rankAutomaticProcessingCandidates({tasks:[],projects:[],activeTaskIds:new Set(),settings:DEFAULT_AUTOMATIC_PROCESSING_SETTINGS,lastProjectId:null}); if(result.length!==0) process.exit(1)'
```

Expected: exit 0 with no output.

### Task 2: Device Settings And Local Atomic Claims

**Files:**
- Create: `server/automatic-processing-config.mjs`
- Modify: `server/database.mjs`

- [ ] **Step 1: Add atomic device-local settings persistence**

Implement `createAutomaticProcessingConfigStore({ configPath })` with serialized updates, `read()` returning defaults on `ENOENT`, and `write(settings)` using a sibling temporary file, mode `0600`, and atomic rename.

- [ ] **Step 2: Add the local Claim schema and row mapper**

Create `automation_claims` with the approved columns and this active constraint:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS automation_claims_one_active_per_task
ON automation_claims(task_id)
WHERE status IN ('claimed', 'running', 'retry_wait');
```

Store only `lease_token_hash`; return a raw random lease token only from acquisition.

- [ ] **Step 3: Add local Claim lifecycle methods**

Implement these `TaskboardDatabase` methods:

```js
listAutomationClaims({ activeOnly = false, limit = 50 } = {})
claimAutomaticTask({ candidateIds, settings, dispatcherId, model, reasoningEffort, leaseMs })
markAutomationClaimRunning(id, leaseToken, { leaseMs, codexThreadId })
heartbeatAutomationClaim(id, leaseToken, leaseMs)
finishAutomationClaim(id, leaseToken, { status, error, nextRetryAt, codexThreadId, inputTokens, outputTokens })
reconcileExpiredAutomationClaims({ maxRetries, retryDelayMinutes })
```

`claimAutomaticTask` must use `BEGIN IMMEDIATE`, re-read each candidate by ID/version, re-run shared eligibility against its hydrated relations, insert one Claim, update that exact task from `todo` to `in_progress` with `version = version + 1`, and commit both changes together. A changed candidate produces no mutation and tries the next ID.

- [ ] **Step 4: Verify schema initialization and empty Claim history**

Run a Node one-liner that creates a temporary `TaskboardDatabase`, asserts `listAutomationClaims()` returns `[]`, closes it, and removes the temporary directory.

Expected: exit 0.

### Task 3: Cloud D1 Claim Authority

**Files:**
- Create: `cloud/migrations/0002_automation_claims.sql`
- Modify: `cloud/src/index.mjs`
- Modify: `test/helpers/cloud-worker-harness.mjs`

- [ ] **Step 1: Add equivalent D1 storage**

The migration must create `automation_claims`, its task/history indexes, its partial active unique index, and insert/update/delete revision triggers.

- [ ] **Step 2: Add strict Claim request parsers and hashing**

Accept only:

```json
{
  "candidateIds": ["task-id"],
  "settings": { "version": 1 },
  "dispatcherId": "device-id",
  "model": "gpt-5.6-sol",
  "reasoningEffort": "high",
  "leaseMs": 120000
}
```

Lifecycle updates accept `leaseToken` plus one exact action: `running`, `heartbeat`, `completed`, `retry_wait`, `failed`, or `canceled`. Hash raw tokens with SHA-256 before comparison and never serialize the stored hash.

- [ ] **Step 3: Implement authenticated Claim routes**

Add:

```text
GET  /api/automation/claims?active=true|false&limit=50
POST /api/automation/claims/acquire
POST /api/automation/claims/:id/lifecycle
POST /api/automation/claims/reconcile-expired
```

For each ranked candidate, hydrate and recheck eligibility, then use one D1 batch to conditionally insert the Claim and conditionally move the exact `todo` task to `in_progress`. Unique/contention failures try the next candidate; success returns `{ claim, task, leaseToken }`; no candidate returns `{ claim: null, task: null }`.

- [ ] **Step 4: Update the harness migration loader and boot the Worker**

Read every sorted `cloud/migrations/*.sql` file and execute it in order. Run:

```bash
node --test test/cloud-shared-worker.test.mjs
```

Expected: the existing cloud suite boots with both migrations and reports zero failures. This is schema compatibility verification, not a new speculative automation test suite.

### Task 4: Business Adapter And Exact-Issue Runner

**Files:**
- Create: `server/automatic-processing-business.mjs`
- Create: `server/automatic-processing-runner.mjs`
- Modify: `scripts/codex-rate-limits.mjs`

- [ ] **Step 1: Route business reads and Claim mutations to the active authority**

`createAutomaticProcessingBusinessStore({ database, cloudConfig, cloudProxy })` must call SQLite directly in local mode and `cloudProxy.forward(new Request(...))` in cloud mode. Expose `snapshot()`, `acquire()`, `markRunning()`, `heartbeat()`, `finish()`, and `reconcileExpired()`; parse non-2xx JSON into an error with the remote code.

- [ ] **Step 2: Build a one-shot exact-issue Codex runner**

Reuse `buildCodexArgs`, `buildCodexPrompt`, `normalizeCodexEvent`, and `spawnCodexTurn` from `server/ai-chat-process.mjs`. The prompt must contain:

```text
Issue <identifier> is already atomically claimed and is in progress.
Work only on this exact issue; do not select or claim another issue.
Read the issue and all comments with taskctl, respect its branch/worktree,
implement and verify the request, add a result comment, and move it only to in_review.
Never move it directly to done.
```

Resolve execution cwd to the issue worktree when present, otherwise the mapped project workspace. Return `{ codexThreadId, inputTokens, outputTokens }` only after `turn.completed` and exit code 0; expose the spawned child for dispatcher shutdown and emit a started callback only after the child `spawn` event.

- [ ] **Step 3: Make quota reads use the configured executable**

Change `readCodexQuotaStatus(model)` to `readCodexQuotaStatus(model, { codexExecutable = "codex" } = {})` and pass that executable into the app-server spawn.

- [ ] **Step 4: Verify the runner argument/prompt construction without starting real Codex**

Run a Node import check over the new runner and existing process helper.

Expected: exit 0; no Codex process is started.

### Task 5: Resident Dispatcher And Local HTTP Surface

**Files:**
- Create: `server/automatic-processing.mjs`
- Modify: `server/app.mjs`

- [ ] **Step 1: Implement event-coalesced reconciliation**

`AutomaticProcessingDispatcher` owns one stable dispatcher UUID, `wake()` coalescing, a fallback timer, active runs, last-served project, last/next scan times, candidate count, quota state, and last error. `reconcile()` must stop before acquisition when disabled, quota-paused, daily-limited, concurrency-full, or candidate-empty.

- [ ] **Step 2: Implement Claim execution and retry lifecycle**

After acquisition, call the runner with the exact task and configured model/effort, mark the Claim `running` after spawn, heartbeat while alive, and finish it with usage. A failed run becomes `retry_wait` until the configured delay while retries remain; exhausted retries become `failed`. A manual task transition away from `in_progress` cancels the active Claim. Startup reconciles expired leases; shutdown interrupts owned children and clears timers.

- [ ] **Step 3: Wire the dispatcher to real service events and cloud proxy mutations**

Add `EventHub.subscribe(listener)`. Subscribe the dispatcher to local `task.created`, `task.updated`, `task.moved`, `task.restored`, and `task.relation.updated`; after a successful proxied cloud mutation, call `wake("cloud-mutation")`. Start the dispatcher only after `listen()` knows the local companion URL and close it before the database.

- [ ] **Step 4: Add local-only settings and status endpoints**

Add strict routes:

```text
GET /api/local/automatic-processing/settings
PUT /api/local/automatic-processing/settings
GET /api/local/automatic-processing/status
GET /api/local/automatic-processing/history?limit=20
POST /api/local/automatic-processing/reconcile
```

Saving settings persists first, reconfigures the fallback timer, and wakes the dispatcher. The status response distinguishes `disabled`, `idle`, `running`, `quota_paused`, `daily_limit`, and `error` and includes last/next scan, candidate count, active count, daily totals, quota, and recent Claims.

- [ ] **Step 5: Prove empty reconciliation does not invoke the runner**

Start a temporary server with an injected runner that increments a counter, enable settings for the mapped local project, call the reconcile endpoint with no eligible tasks, and inspect `app.dispatcher.getStatus()` plus `app.database.listAutomationClaims()`.

Expected: runner count 0, Claim count 0, candidate count 0.

### Task 6: Complete Global Settings UI

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`
- Create: `web/src/components/AutomaticProcessingMenu.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`

- [ ] **Step 1: Add typed API contracts**

Define `AutomaticProcessingSettings`, `AutomaticProcessingStatus`, `AutomationClaim`, strategy/state unions, and API functions for settings, status, history, and manual reconciliation.

- [ ] **Step 2: Replace per-project localStorage/host state with one server-backed state**

Remove `PROJECT_AUTOMATIONS_KEY`, `readProjectAutomations()`, host request maps, per-project reconcile/save callbacks, and the `taskboard:automation-response` handler from `App.tsx`. Load global settings/status from the local companion, refresh status on open and every five seconds while enabled, and surface API errors without hiding the rest of the board.

- [ ] **Step 3: Build the global popover**

The trigger uses the existing play/pause icons and appears on project home and project headers. The popover contains the master switch, all-mapped/selected segmented mode, mapped-project checkboxes, claim strategy, execution model, reasoning effort, concurrency, `兜底扫描间隔`, quota switch, daily limit, an advanced disclosure for label/priority/development-context/retry settings, current state/totals, and recent runs. Save the complete draft with one clear `保存设置` command.

- [ ] **Step 4: Add responsive styling**

Use the existing quiet surface colors, 5-6px controls, a maximum popover height with scrolling, two-column fields only where they remain readable, and a single-column mobile layout. Do not nest cards or use decorative gradients.

- [ ] **Step 5: Run static frontend verification**

Run:

```bash
npm run typecheck
npm run build
```

Expected: both commands exit 0.

### Task 7: Direct-Path Runtime Verification And Focused Commit

**Files:**
- Modify only implementation files listed above if verification reveals a direct-path defect.

- [ ] **Step 1: Re-read the approved design and this plan**

Confirm the empty path, exact-issue execution path, settings fields, no-`done` rule, local/cloud ownership, and unrelated-file exclusions are all represented in the diff.

- [ ] **Step 2: Verify one eligible issue end to end with a fake Codex executable**

Start a temporary server with a fake executable that emits `thread.started`, `turn.started`, and `turn.completed` usage and uses the existing HTTP task/comment endpoints to emulate the Agent's result comment plus move to `in_review`. Enable the mapped project and trigger reconciliation.

Expected: exactly one process spawn; task transitions `todo -> in_progress -> in_review`; one result comment exists; Claim is `completed`; usage totals are visible; a second reconciliation starts no duplicate run.

- [ ] **Step 3: Run final required checks**

Run:

```bash
npm run typecheck
npm run build
git diff --check
git status --short
```

Expected: typecheck/build/diff checks exit 0; status contains only the implementation plan and implementation-owned files.

- [ ] **Step 4: Commit only this request's files**

Stage the exact implementation-owned paths and commit with:

```bash
git commit -m "feat: add token-efficient automatic processing"
```

Do not stage or alter the user-owned injector/runtime/startup changes in the original workspace.

## Self-Review

- Spec coverage: deterministic ranking, global settings, local/D1 atomic Claims, event/fallback dispatch, exact-model execution, leases, retries, recovery state, quota/daily capacity, usage/history, and the no-`done` rule all map to tasks above.
- Intentional pre-confirmation omissions: legacy Cron migration and failure-side task/comment mutations are explicitly deferred by the repository's direct-path-first rule.
- Placeholder scan: no `TBD`, `TODO`, or undefined follow-up step remains.
- Type consistency: the settings names match the approved JSON object; Claim lifecycle names are identical in SQLite, D1, the business adapter, dispatcher, TypeScript declarations, and UI/API contracts.
