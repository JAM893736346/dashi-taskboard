# Token-Efficient Automatic Claiming Design

## Status

Approved in conversation on 2026-08-06. The user selected a deterministic, no-AI claimant with a configurable strong model used only after an issue has been atomically claimed. Configuration is global to the current device rather than repeated per project.

## Goal

Replace AI-powered empty polling with a local deterministic dispatcher. When no eligible issue exists, the system must not start Codex and must consume no model tokens. When an issue is eligible, the dispatcher atomically claims one exact issue and starts a one-shot Codex execution in the correct project context.

## Confirmed Operation Path

1. The user enables global automatic processing and selects participating mapped projects.
2. A task mutation or fallback reconciliation wakes the local dispatcher without starting AI.
3. A pure claim policy filters and ranks eligible `todo` issues.
4. The business store atomically rechecks and claims one issue, moves it to `in_progress`, and creates a durable claim record.
5. The dispatcher resolves the issue's branch or worktree and starts one `codex exec` run with the configured execution model and exact issue identifier.
6. `$manage-taskboard` reads that issue and all comments, performs and verifies the work, adds a result comment, and moves the issue to `in_review`.
7. The dispatcher records run outcome and token usage. Only explicit user acceptance may move the issue to `done`.

An empty queue ends at step 3. It performs only local or HTTP data reads and never creates a Codex run.

## Architecture

### Claim Policy

Add a pure shared module that accepts tasks, relations, current claims, global settings, and the last-served project. It returns ranked candidate IDs without reading storage or calling Codex.

The fixed eligibility rules are:

- status is `todo` and the issue is not archived;
- assignee is Codex Agent;
- the issue belongs to an enabled, locally mapped project;
- no active claim exists for the issue;
- no `blocked_by` relation points to an issue outside `done` or `canceled`;
- configured label, minimum-priority, and development-context requirements pass;
- the global concurrency and daily-run limits have capacity;
- quota is available when quota-aware mode is enabled.

Projects with eligible work are served round-robin so one project cannot monopolize a global queue. Within the selected project, the configured policy applies:

- `board-order`: `sortOrder`, then creation time and ID;
- `priority-first`: urgent, high, medium, low, none, then board order;
- `due-date-first`: earliest non-null due date, then priority and board order; undated issues sort last.

### Dispatcher

Add one local dispatcher owned by the resident Taskboard service. It is the only component that schedules Codex execution. It wakes on:

- local task creation, update, move, restore, relation, or settings events;
- service startup;
- completion, cancellation, or retry of a previous run;
- the configured fallback reconciliation interval.

Wake requests are coalesced. One reconciliation loop fills available global concurrency slots and then stops. It never maintains an AI polling conversation.

Local mode uses internal business events for immediate wake-up. Cloud mode keeps settings and execution on the device and uses cheap revision polling plus the same fallback reconciliation; the cloud Worker remains authoritative for shared claims.

### Atomic Claim Store

Local SQLite and cloud D1 receive equivalent `automation_claims` storage. A claim contains:

```text
id
task_id
dispatcher_id
status: claimed | running | retry_wait | completed | failed | canceled
attempt
model
reasoning_effort
lease_token_hash
lease_expires_at
next_retry_at
codex_thread_id
input_tokens
output_tokens
error
created_at
started_at
finished_at
updated_at
```

The active-claim constraint allows at most one `claimed`, `running`, or `retry_wait` record per task. The claim transaction:

1. reads the ranked candidate;
2. rechecks status, version, eligibility, active claim, concurrency, and daily limit;
3. inserts the claim;
4. moves the task to `in_progress` using its current version;
5. returns the claimed task and an opaque lease token.

If any condition changes, the transaction makes no mutation and the dispatcher tries the next candidate. The dispatcher claim does not replace the issue's existing Codex `threadId`; the actual Codex conversation is recorded when the run or subsequent `taskctl` mutation supplies it.

Cloud D1 performs the task update and claim insert atomically. This prevents two collaborators' dispatchers from executing the same shared issue.

### Codex Execution

Reuse the existing `codex exec --json` process and event normalization used by local AI chat rather than creating a second process protocol. The runner receives:

- the exact issue identifier and project ID;
- the configured model and reasoning effort;
- the mapped project workspace, or the bound worktree path when present;
- the bundled `$manage-taskboard` Skill path;
- a prompt stating that the issue is already claimed and no other issue may be selected.

The execution prompt requires the Agent to reread the issue and all comments, respect its branch or worktree, verify the result, add a summary comment, and move only to `in_review`.

Branch-bound work may run only when global concurrency is one. When concurrency is greater than one, every simultaneously running issue must use a distinct worktree path.

## Global Settings

The local service exposes versioned read and update endpoints for one device-local settings object. Store it under `.data` with mode `0600`; do not store it in browser `localStorage`, D1, or shared project records.

```json
{
  "version": 1,
  "enabled": false,
  "projectMode": "selected",
  "projectIds": [],
  "claimStrategy": "board-order",
  "executionModel": "gpt-5.6-sol",
  "reasoningEffort": "high",
  "maxConcurrency": 1,
  "fallbackIntervalMinutes": 5,
  "quotaAware": true,
  "dailyRunLimit": 10,
  "includeLabels": [],
  "excludeLabels": ["manual", "no-auto"],
  "minimumPriority": "none",
  "requireDevelopmentContext": false,
  "maxRetries": 1,
  "retryDelayMinutes": 15
}
```

Supported fallback intervals are 1, 5, 15, 30, and 60 minutes. `dailyRunLimit` may be null for unlimited. Daily accounting uses the device's local calendar day and counts runs that reached `running`, not empty scans or failed process spawns.

The UI replaces the per-project `ProjectAutomationMenu` behavior with one global automatic-processing panel available from project home and project headers. Its primary controls are:

- master enable switch;
- all mapped projects or a selected-project checklist;
- claim strategy;
- execution model and reasoning effort;
- maximum concurrency;
- fallback scan interval;
- quota-aware pause;
- daily run limit.

An advanced section contains label filters, minimum priority, development-context requirement, retry count, and retry delay. Status text distinguishes `idle`, `running N/M`, `quota paused`, `daily limit reached`, and `error`, and shows the last run plus next fallback scan. The interval label is `兜底扫描间隔`, and the model label is `执行模型`, making clear that neither performs AI polling.

## Failure And Recovery

- **No candidate:** stop reconciliation immediately; no Codex process is created.
- **Quota unavailable:** do not claim new work. Recheck at quota reset or the fallback interval.
- **Codex spawn failure:** keep the claim, record the error, and enter `retry_wait`; this does not consume a daily run slot unless the process reached `running`.
- **Run failure or interruption:** add a dispatcher-authored error comment, wait for the configured delay, and retry the same claimed issue without selecting another issue.
- **Retries exhausted:** add a final error comment, move the issue to `blocked`, and mark the claim `failed`.
- **Service restart:** reconcile expired leases. Claims whose issue is already `in_review`, `done`, or `canceled` become terminal; remaining interrupted claims enter retry or fail according to their attempt count.
- **Manual status change:** cancel the claim when the issue leaves `in_progress` outside the owning run. No retry follows.
- **Long execution:** renew the lease while the child process is alive. Expired leases are never executed concurrently without the business store first reconciling ownership.

Automatic processing never moves an issue directly to `done`.

## Legacy Automation Migration

Existing native Cron automations named `Taskboard 自动认领 · <project>` remain untouched while the new global dispatcher is disabled. The first successful enable operation:

1. validates and persists the global settings;
2. pauses every matching legacy Taskboard auto-claim Cron through the existing host bridge;
3. starts deterministic reconciliation only after those pause requests succeed.

If a legacy Cron cannot be paused, enabling fails visibly and the dispatcher stays disabled, preventing duplicate execution. Per-project browser settings are no longer authoritative and may be removed only after the global settings are persisted successfully.

## API And Attribution

The local settings, status, and history endpoints remain local-companion capabilities. Claim mutation endpoints are implemented in both the local server and cloud Worker because claims coordinate shared business state.

Claim and recovery mutations use a dedicated Agent actor named `Codex Dispatcher`. They do not invent a Codex thread ID. Result comments and final task mutations made inside Codex continue to carry the actual conversation ID through `taskctl`.

Lease tokens are random, returned only to the claiming companion, stored as hashes, and required for heartbeat and terminal claim updates. Cloud requests continue to use the existing authenticated companion path.

## Observability

Persist and display:

- dispatcher state and pause reason;
- last and next reconciliation times;
- candidate count from the last scan;
- active run count;
- today's started, completed, failed, input-token, and output-token totals;
- recent claim/run records with issue identifier, attempt, duration, and error.

Token totals come from Codex JSON completion events. They are informational; the first version does not attempt an unreliable mid-run token hard stop.

## Direct-Path Verification

Before user confirmation, verify only the requested main path:

1. Enable global automation for one mapped test project with concurrency one.
2. Leave the project without eligible `todo` issues and confirm repeated fallback scans create no `codex exec` process and no Claim.
3. Move one Codex-assigned issue to `todo` and confirm the event wakes the dispatcher.
4. Confirm one atomic Claim moves that exact issue to `in_progress` and one strong-model Codex process starts in the expected workspace or worktree.
5. Confirm the Agent reads the exact issue, writes its result comment, and moves it to `in_review`.
6. Confirm the Claim becomes `completed`, usage appears in global status, and no second run starts for the same issue.
7. Run `npm run typecheck`, `npm run build`, and `git diff --check`.

Do not add speculative mutation, recovery, or legacy-compatibility tests before the user confirms this direct path works. Targeted protection may be added later only when explicitly requested or when a concrete failure requires it.

## Non-Goals

- No lightweight claimant model or AI-based task selection.
- No per-project policy overrides.
- No automatic transition to `done`.
- No arbitrary user-authored claim scripts in the first version.
- No workflow-node runtime integration.
- No exact monetary cost calculation or mid-run Token termination.
- No unattended execution for issues assigned to the current user.
