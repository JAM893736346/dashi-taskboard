# Codex Thread Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable Issue-owned Codex workflow runtime that turns reviewed templates into immutable runs, executes bounded Chats under dependencies and resource locks, and exposes steering, queued messages, formal follow-up tasks, recovery, and Subagent visibility.

**Architecture:** Keep the current React Flow workspace as the editable template library, then compile a selected template and Issue into a separate versioned runtime graph. A local SQLite-backed orchestrator owns revisions, run snapshots, scheduling, inboxes, attempts, locks, handoffs, events, and recovery; one resident Codex App Server client owns thread and turn transport. The Issue Workflow tab renders persisted state and sends narrow HTTP commands, while cloud-backed Issue mutations continue through the existing business proxy and never move local execution authority to D1.

**Tech Stack:** Node.js 22, `node:sqlite`, Codex App Server JSON-RPC over stdio, React 19, TypeScript 7, `@xyflow/react` 12, local HTTP/SSE, existing Taskboard cloud proxy

---

Project instructions explicitly replace test-first development for this feature. Implement and demonstrate the direct operation path first. Do not add new regression, mutation, compatibility, or speculative fallback tests before the user confirms the feature; use the existing focused checks and the real Issue path in Task 11.

## Operation Path To Preserve

Before changing code, re-state this path with the cited owners so implementation does not drift:

```text
TaskDetail Workflow tab
  -> web/src/api.ts local workflow request
  -> server/app.mjs validation and route
  -> WorkflowStore transaction / WorkflowOrchestrator wake
  -> resident Codex App Server thread and turn
  -> persisted workflow event
  -> existing /api/events SSE hub
  -> IssueWorkflowPanel refresh and WorkflowRunGraph projection
```

The editable source remains `WorkflowBoard -> /api/projects/:projectId/workflow-workspace -> workflow_workspaces`. Runtime state is a new local-only path and must not be written back into that workspace JSON.

There are two immutable version layers. Saving the editor updates the mutable tab draft; requesting generation snapshots only that tab as a project-level template revision when its content hash changes. Planner output is then stored as an Issue-specific workflow revision with `draft -> reviewing -> ready` lifecycle. A run records both revision IDs and the complete runtime graph.

## File Map

- Create `shared/workflow-runtime.mjs` and `shared/workflow-runtime.d.mts`: runtime graph schema, deterministic validation, dependency helpers, condition evaluation, and structured output schemas.
- Create `server/workflow-store.mjs`: local workflow schema, row mapping, immutable revision/run transactions, node attempts, inboxes, handoffs, locks, Subagents, events, and amendments.
- Create `server/codex-app-server.mjs`: resident JSON-RPC transport with request correlation, notifications, reconnect failure reporting, and thread/turn convenience methods.
- Modify `server/codex-history.mjs`: use the shared transport for short-lived history reads without changing its public history functions.
- Create `server/workflow-review.mjs`: Planner and independent Reviewer Chats, prompts, structured result collection, and revision transitions.
- Create `server/workflow-business-store.mjs`: active local/cloud Issue and template reads plus optimistic Issue Action mutations.
- Create `server/workflow-planning-projection.mjs`: database-derived shared planning projection under `.data`, written only by the orchestrator.
- Create `server/workflow-orchestrator.mjs`: scheduler, executors, App Server event ingestion, completion barrier, intervention, retry, amendment, and restart reconciliation.
- Modify `server/app.mjs`: construction/lifecycle, local workflow routes, request parsing, and SSE emission.
- Modify `cli/taskctl.mjs`, `skills/manage-taskboard/SKILL.md`, and `skills/manage-taskboard/references/cli.md`: one Agent-originated queued-message command.
- Modify `web/src/components/WorkflowBoard.tsx`, `WorkflowNode.tsx`, `WorkflowInspector.tsx`, and `workflowCatalog.ts`: first-version primitives, model/resource/approval settings, recommended default template, and template duplication.
- Modify `web/src/types.ts` and `web/src/api.ts`: runtime and mutation contracts.
- Create `web/src/components/IssueWorkflowPanel.tsx`: template/revision/run owner for one Issue.
- Create `web/src/components/WorkflowRunGraph.tsx`, `WorkflowRuntimeNode.tsx`, `WorkflowRunInspector.tsx`, and `workflow-runtime.css`: runtime graph, expanded Subagent children, inspector, controls, and the three composer modes.
- Modify `web/src/components/TaskDetail.tsx`, `web/src/App.tsx`, and `web/src/styles.css`: Issue tab entry, lazy loading, SSE refresh, and responsive layout.

### Task 1: Define The Runtime Graph Contract

**Files:**
- Create: `shared/workflow-runtime.mjs`
- Create: `shared/workflow-runtime.d.mts`

- [ ] **Step 1: Freeze the graph and executor versions**

Export these constants and exact serialized values:

```js
export const WORKFLOW_GRAPH_SCHEMA_VERSION = 1;
export const WORKFLOW_EXECUTOR_VERSIONS = Object.freeze({
  "codex-thread": 1,
  "human-gate": 1,
  condition: 1,
  "issue-action": 1,
});
export const WORKFLOW_PRIMITIVES = Object.freeze(Object.keys(WORKFLOW_EXECUTOR_VERSIONS));
export const WORKFLOW_RUN_STATUSES = Object.freeze([
  "queued", "running", "paused", "completed", "failed", "cancelled",
]);
export const WORKFLOW_NODE_STATUSES = Object.freeze([
  "blocked", "ready", "running", "awaiting_confirmation", "succeeded",
  "rejected", "failed", "interrupted", "recovery_required",
  "migration_required", "cancelled",
]);
```

Use one runtime graph shape throughout the server and browser:

```ts
export interface WorkflowRuntimeGraph {
  schemaVersion: 1;
  goal: string;
  defaults: {
    model: string;
    effort: string;
    concurrencyLimit: number;
    failFast: boolean;
  };
  nodes: WorkflowRuntimeNodeDefinition[];
}

export interface WorkflowRuntimeNodeDefinition {
  id: string;
  type: "codex-thread" | "human-gate" | "condition" | "issue-action";
  executorVersion: 1;
  title: string;
  objective: string;
  dependsOn: Array<{ nodeId: string; outcome?: "true" | "false" }>;
  approvalMode: "automatic" | "manual";
  config: Record<string, unknown>;
  resources: Array<{ key: string; mode: "shared" | "exclusive" }>;
}
```

`codex-thread.config` contains `rolePreset`, `model`, `effort`, `sandbox`, and `outputSchema`; `human-gate.config` contains `message`; `condition.config` contains `sourceNodeId`, `field`, `operator`, and `value`; `issue-action.config` is limited to `{ action: "set-status", status: TaskStatus }` in version 1.

- [ ] **Step 2: Add deterministic validation and normalization**

Implement `validateWorkflowRuntimeGraph(value, { allowedPrimitives, allowedNodeIds })` as this ordered validation pass:

```text
1. Reject a non-plain root object, unknown root keys, or a schemaVersion other than 1.
2. Validate goal and every defaults field, including concurrencyLimit as an integer from 1 through 16.
3. Reject more than 200 nodes; validate every common node field and collect duplicate IDs.
4. Validate each versioned config against the exact primitive-specific key allowlist and value types.
5. Validate executorVersion against WORKFLOW_EXECUTOR_VERSIONS and type against both primitive allowlists.
6. Validate resource keys/modes, dependency targets, optional outcomes, self-dependencies, and allowedNodeIds.
7. Require condition.sourceNodeId to name one of that condition node's dependencies.
8. Run Kahn's algorithm across dependsOn edges; report every node left after traversal as cyclic.
9. Return { valid: errors.length === 0, errors }, with each error shaped as { path, code, message }.
```

Add a throwing wrapper that returns a detached JSON value only after that complete pass succeeds:

```js
export function assertWorkflowRuntimeGraph(value, options) {
  const result = validateWorkflowRuntimeGraph(value, options);
  if (!result.valid) {
    const error = new Error("Workflow graph is invalid");
    error.code = "INVALID_WORKFLOW_GRAPH";
    error.details = result.errors;
    throw error;
  }
  return JSON.parse(JSON.stringify(value));
}
```

Validation must reject unknown object keys inside versioned node configs, dependency cycles, self-dependencies, a condition whose `sourceNodeId` is not one of its dependencies, unsupported executor versions, and more than 200 formal nodes. It must not infer a graph from React Flow positions.

- [ ] **Step 3: Add pure scheduler and condition helpers**

Export concrete pure functions used by the store and orchestrator:

```js
export function initialWorkflowNodeStatus(node) {
  return node.dependsOn.length === 0 ? "ready" : "blocked";
}

export function dependencySatisfied(dependency, nodesByDefinitionId) {
  const upstream = nodesByDefinitionId.get(dependency.nodeId);
  return upstream?.status === "succeeded"
    && (dependency.outcome === undefined || upstream.branchOutcome === dependency.outcome);
}

export function dependencyExcluded(dependency, nodesByDefinitionId) {
  const upstream = nodesByDefinitionId.get(dependency.nodeId);
  return upstream?.result?.reason === "condition_not_selected"
    || (upstream?.status === "succeeded"
      && dependency.outcome !== undefined
      && upstream.branchOutcome !== dependency.outcome);
}

export function settleWorkflowDependencies(graph, nodeRuns) {
  const byDefinitionId = new Map(nodeRuns.map((node) => [node.definitionId, node]));
  return graph.nodes.flatMap((node) => {
    if (byDefinitionId.get(node.id)?.status !== "blocked") return [];
    const resolutions = node.dependsOn.map((edge) => dependencySatisfied(edge, byDefinitionId)
      ? "satisfied"
      : dependencyExcluded(edge, byDefinitionId) ? "excluded" : "pending");
    if (resolutions.includes("pending")) return [];
    return [{
      nodeId: node.id,
      status: resolutions.includes("satisfied") ? "ready" : "cancelled",
      reason: resolutions.includes("satisfied") ? null : "condition_not_selected",
    }];
  });
}

export function evaluateWorkflowCondition(config, predecessorResult) {
  const actual = config.field.split(".").reduce(
    (value, part) => value !== null && typeof value === "object" ? value[part] : undefined,
    predecessorResult,
  );
  if (config.operator === "equals") return String(actual) === String(config.value);
  if (config.operator === "not-equals") return String(actual) !== String(config.value);
  if (config.operator === "contains") return Array.isArray(actual)
    ? actual.includes(config.value)
    : String(actual ?? "").includes(String(config.value));
  return Array.isArray(actual)
    ? !actual.includes(config.value)
    : !String(actual ?? "").includes(String(config.value));
}
```

Also export `WORKFLOW_NODE_RESULT_SCHEMA`, requiring `summary`, `conclusions`, `changedFiles`, `artifacts`, `verification`, `unresolved`, `risks`, and optional `planningDirectory`. Every queued turn returns the same envelope; only the last valid envelope becomes the node candidate result. A node whose conditional path is not selected uses terminal status `cancelled` with the machine result `{ reason: "condition_not_selected" }`; user cancellation has a different event/reason. This lets a reconverging node run after at least one satisfied predecessor while recursively pruning a path whose predecessors are all excluded.

- [ ] **Step 4: Verify the pure contract directly**

Run:

```bash
node --input-type=module - <<'NODE'
import {
  assertWorkflowRuntimeGraph,
  settleWorkflowDependencies,
} from "./shared/workflow-runtime.mjs";
const graph = assertWorkflowRuntimeGraph({
  schemaVersion: 1,
  goal: "deliver issue",
  defaults: { model: "gpt-5.6-terra", effort: "medium", concurrencyLimit: 2, failFast: false },
  nodes: [
    { id: "plan", type: "codex-thread", executorVersion: 1, title: "Plan", objective: "Plan", dependsOn: [], approvalMode: "automatic", config: { rolePreset: "planning", model: null, effort: null, sandbox: "readOnly", outputSchema: null }, resources: [{ key: "workspace", mode: "shared" }] },
    { id: "gate", type: "human-gate", executorVersion: 1, title: "Gate", objective: "Approve", dependsOn: [{ nodeId: "plan" }], approvalMode: "automatic", config: { message: "Approve" }, resources: [] },
  ],
});
console.log(graph.schemaVersion, settleWorkflowDependencies(graph, [
  { definitionId: "plan", status: "succeeded" },
  { definitionId: "gate", status: "blocked" },
]));
NODE
```

Expected: `1 [{ nodeId: "gate", status: "ready", reason: null }]`. A graph with `plan -> gate -> plan` must throw `INVALID_WORKFLOW_GRAPH`. Then pass a true Condition with one true and one false successor; settling must ready the true successor, cancel the false successor with `condition_not_selected`, and ready a later merge only after the selected successor succeeds.

- [ ] **Step 5: Commit the runtime contract**

```bash
git add shared/workflow-runtime.mjs shared/workflow-runtime.d.mts
git commit -m "feat: define workflow runtime graph contract"
```

### Task 2: Persist Revisions, Runs, Attempts, Inboxes, And Locks

**Files:**
- Create: `server/workflow-store.mjs`
- Modify: `server/app.mjs`

- [ ] **Step 1: Create the local runtime schema**

`WorkflowStore` receives the existing `TaskboardDatabase`, uses its public `database` connection, and runs one idempotent migration in its constructor. Create these tables with the listed keys and checks:

```sql
CREATE TABLE IF NOT EXISTS workflow_template_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  name TEXT NOT NULL,
  source_workspace_version INTEGER NOT NULL CHECK (source_workspace_version >= 0),
  source_snapshot TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, template_id, revision),
  UNIQUE (project_id, template_id, source_hash)
);

CREATE TABLE IF NOT EXISTS workflow_revisions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_revision_id TEXT NOT NULL REFERENCES workflow_template_revisions(id),
  template_revision INTEGER NOT NULL CHECK (template_revision > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL CHECK (status IN ('draft', 'reviewing', 'ready')),
  graph_snapshot TEXT,
  graph_schema_version INTEGER,
  validation_errors TEXT NOT NULL DEFAULT '[]',
  review_report TEXT,
  planner_thread_id TEXT,
  reviewer_thread_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (task_id, template_id, revision)
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  workflow_revision_id TEXT NOT NULL REFERENCES workflow_revisions(id),
  workflow_revision INTEGER NOT NULL,
  template_revision_id TEXT NOT NULL REFERENCES workflow_template_revisions(id),
  template_revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','paused','completed','failed','cancelled')),
  graph_snapshot TEXT NOT NULL,
  graph_schema_version INTEGER NOT NULL,
  concurrency_limit INTEGER NOT NULL CHECK (concurrency_limit BETWEEN 1 AND 16),
  fail_fast INTEGER NOT NULL CHECK (fail_fast IN (0,1)),
  amendment_revision INTEGER NOT NULL DEFAULT 0,
  planning_path TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_one_active
  ON workflow_runs(task_id)
  WHERE status IN ('queued','running','paused');

CREATE TABLE IF NOT EXISTS workflow_node_runs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  definition_id TEXT NOT NULL,
  type TEXT NOT NULL,
  executor_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  approval_mode TEXT NOT NULL CHECK (approval_mode IN ('automatic','manual')),
  config TEXT NOT NULL,
  resources TEXT NOT NULL,
  result TEXT,
  branch_outcome TEXT CHECK (branch_outcome IN ('true','false') OR branch_outcome IS NULL),
  active_attempt_id TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, definition_id)
);

CREATE TABLE IF NOT EXISTS workflow_node_attempts (
  id TEXT PRIMARY KEY,
  node_run_id TEXT NOT NULL REFERENCES workflow_node_runs(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed','interrupted','recovery_required','cancelled')),
  thread_id TEXT,
  turn_id TEXT,
  candidate_result TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (node_run_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS workflow_inbox_messages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  target_node_run_id TEXT NOT NULL REFERENCES workflow_node_runs(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('user','agent')),
  source_node_run_id TEXT REFERENCES workflow_node_runs(id),
  mode TEXT NOT NULL CHECK (mode IN ('steer','queued')),
  status TEXT NOT NULL CHECK (status IN ('pending','delivered','fallback_queued','cancelled')),
  sequence INTEGER NOT NULL,
  content TEXT NOT NULL,
  expected_turn_id TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  UNIQUE (target_node_run_id, sequence)
);

CREATE TABLE IF NOT EXISTS workflow_handoffs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  predecessor_node_run_id TEXT NOT NULL REFERENCES workflow_node_runs(id),
  successor_node_run_id TEXT NOT NULL REFERENCES workflow_node_runs(id),
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (predecessor_node_run_id, successor_node_run_id)
);

CREATE TABLE IF NOT EXISTS workflow_resource_leases (
  resource_key TEXT NOT NULL,
  node_run_id TEXT NOT NULL REFERENCES workflow_node_runs(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('shared','exclusive')),
  owner TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (resource_key, node_run_id)
);

CREATE TABLE IF NOT EXISTS workflow_subagents (
  id TEXT PRIMARY KEY,
  node_run_id TEXT NOT NULL REFERENCES workflow_node_runs(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES workflow_node_attempts(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL UNIQUE,
  parent_thread_id TEXT NOT NULL,
  role TEXT,
  model TEXT,
  status TEXT NOT NULL,
  activity TEXT,
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_run_id TEXT REFERENCES workflow_node_runs(id),
  attempt_id TEXT REFERENCES workflow_node_attempts(id),
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_run_amendments (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  source TEXT NOT NULL CHECK (source IN ('user_configured','codex_generated')),
  status TEXT NOT NULL CHECK (status IN ('draft','reviewing','ready','applied','rejected')),
  patch TEXT NOT NULL,
  review_report TEXT,
  reviewer_thread_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, revision)
);
```

Add indexes for template revisions by project/template, workflow revisions by task/template, node runs by run/status, attempts by thread/turn, pending inbox FIFO, resource expiration, events by run/created time, and Subagents by parent node.

- [ ] **Step 2: Implement JSON row mappers and optimistic revision writes**

Keep snake_case in SQLite and return camelCase objects. Implement this stable public contract first:

```text
new WorkflowStore(taskboardDatabase)
  -> retain taskboardDatabase.database without opening a second SQLite connection; run the workflow migration once
snapshotTemplate({ projectId, templateId, name, sourceHash, workspaceVersion, templateSnapshot })
  -> return the existing matching project/template sourceHash row, or atomically insert the next revision
createRevision({ taskId, projectId, templateRevisionId, graphSnapshot, status })
  -> atomically insert the next Issue workflow revision at optimistic version 1
getTemplateRevision(id) -> mapped immutable template revision or null
getRevision(id) -> mapped Issue workflow revision or null
listTaskRevisions(taskId) -> mapped revisions ordered newest first
updateRevision(id, expectedVersion, changes) -> updated mapped row or VERSION_CONFLICT
getActiveRunForTask(taskId) -> newest nonterminal run or null
getRun(id) -> mapped run or null
getRunSnapshot(id) -> run plus ordered nodes, attempts, inbox, handoffs, Subagents, amendments, and events
listNonterminalRuns() -> queued/running/paused runs ordered oldest first
close() -> mark the store closed and drop workflow-owned statement references; do not close TaskboardDatabase.database
```

`updateRevision()` must use `WHERE id = ? AND version = ?`, increment `version`, and throw `ApiError(409, "VERSION_CONFLICT", ...)` with expected/actual values exactly like existing task and workflow workspace writes.

- [ ] **Step 3: Implement immutable enqueue in one transaction**

Implement `enqueueRevision({ runId, revisionId, planningPath })` in one `BEGIN IMMEDIATE` transaction, in this exact order:

```text
1. Load the Issue workflow revision; reject missing or non-ready revisions.
2. Reject when the same Issue already has a queued, running, or paused run.
3. Parse graph_snapshot and call assertWorkflowRuntimeGraph before any insert.
4. Insert workflow_runs using the caller-generated runId with workflow_revision_id, template_revision_id, both revision numbers,
   graph_schema_version, an unchanged JSON clone of graph_snapshot, planning_path, and queued status.
5. Insert one workflow_node_runs row per graph node, using initialWorkflowNodeStatus(node).
6. Insert workflow.run.enqueued plus workflow.node.ready events for every initially ready node.
7. Commit; on any error roll back; after commit return getRunSnapshot(runId).
```

Never read the current template workspace while creating the run. The revision's stored graph is the only enqueue source.

- [ ] **Step 4: Implement the atomic runtime operations used later**

Add methods with these exact responsibilities:

```js
claimReadyNodes({ runId, owner, limit, leaseMs })
startAttempt({ nodeRunId, threadId = null, turnId = null })
bindAttemptThread({ attemptId, threadId, turnId })
appendEvent({ runId, nodeRunId = null, attemptId = null, type, data })
appendInboxMessage({ targetNodeRunId, sourceType, sourceNodeRunId, mode, content, expectedTurnId })
markInboxMessage(id, status)
peekQueuedMessage(nodeRunId)
upsertSubagent(input)
finishTurn({ attemptId, status, candidateResult, error })
completeNodeIfBarrierSatisfied(nodeRunId)
transitionNode(nodeRunId, expectedStatuses, nextStatus, changes = {})
createRetry(nodeRunId)
releaseNodeResources(nodeRunId)
createAmendment(input)
applyAmendment(amendmentId)
```

`startAttempt()` derives `idempotencyKey` as `<runId>:<definitionId>:<attemptNumber>:<executorVersion>` and persists it before any external work. `claimReadyNodes()` must acquire the node lease and every declared resource in the same `BEGIN IMMEDIATE` transaction. A shared request is compatible only with existing live shared leases; an exclusive request requires no other live lease, and expired rows are removed in the same transaction. `completeNodeIfBarrierSatisfied()` must check the active attempt has no turn, no pending/fallback queued inbox row exists, every Subagent is terminal, and `candidate_result` is present before changing the node.

- [ ] **Step 5: Construct the store without exposing runtime routes yet**

In `createTaskboardServer()`:

```js
const workflowStore = options.workflowStore ?? new WorkflowStore(database);
```

Return it on the app object for direct inspection and call `workflowStore.close()` before `database.close()`.

- [ ] **Step 6: Verify schema and immutable enqueue directly**

Run a temporary-directory Node script that creates `TaskboardDatabase`, `WorkflowStore`, a local Issue, a template revision, and a ready Issue workflow revision with a two-node graph; enqueue it, edit the source workspace, and print both recorded revision numbers and the queued snapshot goal. Expected: all eleven runtime tables exist, the first node is `ready`, the second is `blocked`, and both recorded revisions plus the run snapshot remain unchanged after the workspace edit.

- [ ] **Step 7: Commit persistence**

```bash
git add server/workflow-store.mjs server/app.mjs
git commit -m "feat: persist workflow orchestration state"
```

### Task 3: Extract A Resident Codex App Server Client

**Files:**
- Create: `server/codex-app-server.mjs`
- Modify: `server/codex-history.mjs`

- [ ] **Step 1: Move JSON-RPC transport ownership into a reusable class**

Implement this public surface and its stated return behavior:

```text
new CodexAppServerClient({ codexExecutable, cwd, processEnv, requestTimeoutMs })
start() -> spawn once, complete initialize/initialized, then resolve this client
close() -> stop new requests, reject pending requests, terminate the owned child, and await exit
request(method, params, { timeoutMs }) -> Promise for the correlated JSON-RPC result
subscribe(listener) -> unsubscribe function; listener receives { id?, method, params }
respondToServerRequest(id, { result, error }) -> write exactly one JSON-RPC response
```

Add these convenience methods without changing their App Server payloads:

```js
export class CodexAppServerClient {
  startThread(input) { return this.request("thread/start", input); }
  resumeThread(threadId, input = {}) { return this.request("thread/resume", { threadId, ...input }); }
  readThread(threadId, includeTurns = true) { return this.request("thread/read", { threadId, includeTurns }); }
  startTurn(threadId, input) { return this.request("turn/start", { threadId, ...input }); }
  steerTurn(threadId, expectedTurnId, text) {
    return this.request("turn/steer", {
      threadId,
      expectedTurnId,
      input: [{ type: "text", text }],
    });
  }
  interruptTurn(threadId, turnId) {
    return this.request("turn/interrupt", { threadId, turnId });
  }
}
```

On `start()`, spawn `codex app-server --stdio`, send `initialize` with `{ clientInfo: { name: "codex-taskboard", version: "0.1.0" }, capabilities: { experimentalApi: true } }`, then send `initialized`. Parse newline-delimited JSON with the current maximum-line protection. Responses resolve/reject `pending` requests; every message with `method` goes to listeners, including server requests that also carry an ID. `respondToServerRequest()` sends either `{ id, result }` or `{ id, error }`. Process exit rejects every pending request and notifies listeners with `{ method: "client/closed", params: { error } }`. After an unexpected exit, `start()` may spawn a replacement connection; after explicit `close()`, it rejects restart.

- [ ] **Step 2: Keep one-shot history behavior on the shared transport**

Replace `withCodexAppServer()` internals in `server/codex-history.mjs` with:

```js
async function withCodexAppServer(options, operation) {
  const client = new CodexAppServerClient(options);
  await client.start();
  try {
    return await operation((method, params) => client.request(method, params));
  } finally {
    await client.close();
  }
}
```

Keep `listCodexHistory`, `listCodexChatMetadata`, `readCodexChatThreads`, and activity normalization signatures unchanged.

- [ ] **Step 3: Verify the transport against the installed Codex binary**

Run a read-only script that starts the client, requests `thread/list` with `{ limit: 1, useStateDbOnly: true }`, prints whether `result.data` is an array, and closes. Expected: `true` and no surviving `codex app-server` child owned by the script.

- [ ] **Step 4: Verify the existing history path still parses**

Run:

```bash
node --test test/codex-history-import.test.mjs
```

Expected: existing history import tests pass; no new test file is added.

- [ ] **Step 5: Commit the shared transport**

```bash
git add server/codex-app-server.mjs server/codex-history.mjs
git commit -m "feat: add resident Codex app server client"
```

### Task 4: Generate, Validate, And Independently Review Revisions

**Files:**
- Create: `server/workflow-business-store.mjs`
- Create: `server/workflow-review.mjs`
- Modify: `server/app.mjs`

- [ ] **Step 1: Read Issues and templates through the active business path**

Follow `automatic-processing-business.mjs`: reuse its `remote(pathname, options)` pattern so a non-2xx cloud response becomes the same structured business error and never falls through to SQLite. Export `createWorkflowBusinessStore({ database, cloudConfig, cloudProxy })` with these exact branches and response projections:

```text
getTask(taskId):
  cloud enabled -> remote GET /api/tasks/<encoded taskId> -> body.task
  local         -> database.getTask(taskId)

getTemplateWorkspace(projectId):
  cloud enabled -> remote GET /api/projects/<encoded projectId>/workflow-workspace -> body.workflow
  local         -> database.getWorkflowWorkspace(projectId)
```

Never fall back to local business data after a cloud request fails. Device paths remain resolved through the current device-link configuration and are not returned by the cloud template API.

- [ ] **Step 2: Build the Planner input from authoritative records**

`WorkflowReviewService.generateAndReview({ taskId, templateId })` must read the Issue and current workflow workspace through `WorkflowBusinessStore`, then select the exact tab snapshot on the server. Hash the normalized selected tab, call `snapshotTemplate()` to reuse or create its immutable project-level template revision, and create the Issue workflow revision before starting Codex. The Planner prompt includes the Issue goal, immutable template revision, allowed primitives, available models, executor versions, graph limits, and this rule:

```text
Return only the schema-constrained runtime graph. The template is a constrained skeleton:
you may configure, insert, remove, reorder, or add condition branches, but you may not add
unknown primitives, cycles, external waits, Feishu nodes, or cross-Chat steer edges.
```

Treat the template's root Issue trigger as ownership metadata for the primary Issue; it is not emitted as a runtime node. Reject a source template that does not contain exactly one root-first Issue trigger.

Start a fresh Planner thread with `cwd` resolved from the project's device link, `approvalPolicy: "never"`, `sandbox: "readOnly"`, the selected model, and `serviceName: "codex-taskboard-workflow-planner"`.

- [ ] **Step 3: Collect one structured turn without trusting streamed text**

Implement `runStructuredTurn({ client, threadId, prompt, outputSchema, turnOptions })` with a subscription installed before `turn/start`:

```text
1. Subscribe first and buffer notifications by threadId plus turnId, retaining completed items in arrival order.
2. Start the turn with text input, outputSchema, and turnOptions; bind the returned turn.id to the buffer.
3. Ignore notifications for other threads or turns. Record completed agentMessage text for the bound turn.
4. On bound turn/completed, unsubscribe, reject unless a completed agentMessage exists, JSON.parse its text,
   and return { turnId: turn.id, value, items }.
5. On bound turn/failed, client/closed, parse failure, or timeout, unsubscribe and reject with the terminal
   event details; settle once so late notifications cannot change the result.
```

If the connection closes or the terminal event is ambiguous, retain the revision as `draft` with a review report explaining that generation needs retry. Do not enqueue or auto-retry it.

- [ ] **Step 4: Run deterministic validation before review**

Call `validateWorkflowRuntimeGraph()` with the template's allowed primitives. Persist `graphSnapshot`, `graphSchemaVersion`, `plannerThreadId`, and validation errors. Invalid output returns to `draft` and never starts a Reviewer Chat.

- [ ] **Step 5: Run an independent Reviewer Chat**

Create a second thread, not a resumed Planner thread, with service name `codex-taskboard-workflow-reviewer`. Give it the Issue, selected template constraints, and validated runtime graph. Require this output:

```json
{
  "verdict": "pass",
  "summary": "The graph covers planning, implementation, verification, confirmation, and Issue state change.",
  "findings": []
}
```

The JSON schema permits `verdict: "pass" | "revise"`, a non-empty summary, and findings with `severity`, `nodeId`, and `message`. A pass transitions the same revision from `reviewing` to `ready`; revise transitions it to `draft`. Persist `reviewerThreadId` and the complete report. The Reviewer cannot edit `graphSnapshot`.

- [ ] **Step 6: Add loopback-only snapshot and generation routes**

Add strict parsers and these routes before cloud forwarding:

```text
GET  /api/local/tasks/:taskId/workflow
POST /api/local/tasks/:taskId/workflow/revisions   { templateId }
```

GET returns `{ templates, revisions, activeRun }`. `templates` comes from the current workspace tabs, and each item includes `id`, `name`, `workspaceVersion`, and the latest immutable `templateRevision`. `revisions` are the Issue-specific Planner/Reviewer records and each exposes its referenced template revision. POST returns `202 { revision }` immediately after the Issue workflow revision enters `reviewing`; background completion emits `workflow.revision.updated` with `projectId`, `taskId`, and `revisionId` through the existing EventHub.

Before dispatching either route, call `assertLoopbackRequest(request)`. Apply the same guard to every `/api/local/workflow/*` route added later; `isLocalCompanionRoute()` prevents cloud forwarding but does not itself reject private-LAN callers.

- [ ] **Step 7: Verify generation and independent review through HTTP**

Run the dev server, create or use a real local Issue, PUT one temporary workspace snapshot containing only the four allowed runtime primitives, call the POST route, then poll GET. Expected: the revision visibly moves `reviewing -> ready` or `reviewing -> draft`; Planner and Reviewer thread IDs are both present and different; a revision still in `reviewing` has no enqueue route yet. Repeat GET with a private-LAN source when available and expect `403 LOCAL_ONLY`.

- [ ] **Step 8: Commit revision review**

```bash
git add server/workflow-business-store.mjs server/workflow-review.mjs server/app.mjs
git commit -m "feat: review generated workflow revisions"
```

### Task 5: Enqueue Runs And Schedule Safe Primitive Nodes

**Files:**
- Modify: `server/workflow-business-store.mjs`
- Create: `server/workflow-planning-projection.mjs`
- Create: `server/workflow-orchestrator.mjs`
- Modify: `server/app.mjs`

- [ ] **Step 1: Add optimistic Issue mutation to the business adapter**

Extend the Task 4 adapter with `setTaskStatus(taskId, status, threadId, idempotencyKey)`. It first calls `getTask(taskId)` and throws `ApiError(404, "TASK_NOT_FOUND", ...)` for a missing Issue. If the current status already equals the target, return `{ task, reconciled: true, idempotencyKey }` without another write. Otherwise take exactly one optimistic mutation path:

```text
cloud enabled -> remote PATCH /api/tasks/<encoded taskId>
                 body { version: task.version, changes: { status }, threadId }
                 header x-taskboard-idempotency-key: idempotencyKey
                 return { task: body.task, reconciled: false, idempotencyKey }
local         -> database.updateTask(task.id, task.version, { status }, threadId)
                 return { task, reconciled: false, idempotencyKey }
```

The first executor version changes status only. Persist the attempt's derived key before the call and include it in the action event/result. If a remote response is lost, reconcile the current Issue: matching target status is success for that attempt; a different status becomes `recovery_required`. Do not add comments or other repeatable side effects in executor version 1.

- [ ] **Step 2: Create the single-writer shared planning projection**

`WorkflowPlanningProjection` writes to `.data/workflow-runs/<runId>/planning-with-files/` using same-directory temporary files followed by atomic rename. Its contract is:

```text
pathFor(runId)              -> deterministically return the absolute directory path without creating files
initialize(runSnapshot)     -> create the run directory, render all three files, and return its absolute path
refresh(runSnapshot)        -> render all three files from the supplied authoritative snapshot, rename each into place,
                               and return the same absolute path
```

`task_plan.md` contains the run goal and formal-node states; `findings.md` contains immutable handoff conclusions and risks; `progress.md` contains attempt and event summaries. Every generated file states that SQLite is authoritative and Agents have read-only access. Formal Chat prompts must still instruct each Chat to initialize its own task-isolated `planning-with-files` session.

- [ ] **Step 3: Implement the orchestrator lifecycle and wake loop**

Construct `WorkflowOrchestrator` with `{ store, codex, businessStore, planningProjection, events, resolveWorkspace, getCatalog }` and this lifecycle contract:

```text
start() -> start the resident App Server client, subscribe once, reconcile persisted runs, start heartbeats, wake scheduler
close() -> reject new commands, stop heartbeats, await the active reconcile promise, unsubscribe, close App Server client
wake(reason) -> record reason and coalesce all calls onto one reconcile promise; rerun once if dirtied during reconcile
enqueueRevision(revisionId) -> generate runId, compute pathFor(runId), atomically enqueue ready revision,
                               initialize projection from the committed snapshot, emit SSE state, wake, return snapshot
getTaskWorkflow(taskId) -> return current templates, Issue revisions, and active run through authoritative stores
getRunSnapshot(runId) -> return store snapshot plus effectiveGraph derived from ready/applied amendments
```

The reconcile loop reads nonterminal runs, applies every `settleWorkflowDependencies()` transition until stable, asks `claimReadyNodes()` for up to the remaining run concurrency, and launches claimed nodes without awaiting siblings. Recompute run status after each batch: any active node makes it `running`; explicit failure policy makes it `paused` or `failed`; all nodes terminal makes it `completed`. Use one `orchestratorId` UUID and a two-minute lease with a 30-second heartbeat. On `client/closed`, stop claims, retry `codex.start()` with capped exponential backoff while nonterminal runs exist, then reconcile every active attempt before scheduling new work.

- [ ] **Step 4: Execute Human Gate, Condition, and Issue Action nodes**

Implement a primitive dispatch table:

```js
const executors = {
  "human-gate": executeHumanGate,
  condition: executeCondition,
  "issue-action": executeIssueAction,
  "codex-thread": executeCodexThread,
};
```

For this task, `executeCodexThread` throws an internal `CODEX_EXECUTOR_NOT_READY` and is not included in the default runnable template until Task 6. The other behavior is exact:

- Human Gate: release any acquired resources and transition directly to `awaiting_confirmation`.
- Condition: read the persisted predecessor result, evaluate with `evaluateWorkflowCondition()`, store `branchOutcome`, and succeed.
- Issue Action: create an attempt first, call `businessStore.setTaskStatus()` with the persisted attempt idempotency key, store the returned Issue version/key/reconciliation flag in the result, and succeed. On a version conflict, re-read once: matching target status succeeds as reconciled; any other status pauses the node without retrying.
- Any manual `approvalMode` on a completed executor stores the result, releases resources, and moves to `awaiting_confirmation` before successors can become ready.

- [ ] **Step 5: Add enqueue, read, and node-control routes**

Add:

```text
POST /api/local/workflow/revisions/:revisionId/enqueue
GET  /api/local/workflow/runs/:runId
POST /api/local/workflow/nodes/:nodeRunId/control
```

For this milestone, control accepts `approve`, `reject`, and `cancel`. Enqueue returns `201 { snapshot }` and is the only action that creates a run. Emit `workflow.run.updated`, `workflow.node.updated`, and `workflow.event.created` with task/project/run identifiers.

- [ ] **Step 6: Verify queue authorization and safe synchronous execution**

Through HTTP, prove a `reviewing` revision returns `409 WORKFLOW_REVISION_NOT_READY`; a `ready` revision enqueues; two independent shared-resource conditions can finish; two exclusive nodes on the same resource never hold leases simultaneously; a Human Gate releases its resource before waiting; approving it releases its successor.

- [ ] **Step 7: Commit the scheduler foundation**

```bash
git add server/workflow-business-store.mjs server/workflow-planning-projection.mjs server/workflow-orchestrator.mjs server/app.mjs
git commit -m "feat: schedule durable workflow runs"
```

### Task 6: Execute Formal Chats, Handoffs, Subagents, And Recovery

**Files:**
- Modify: `server/workflow-orchestrator.mjs`
- Modify: `server/workflow-store.mjs`
- Modify: `server/app.mjs`

- [ ] **Step 1: Build the minimal structured handoff**

For each ready Codex node, persist one `workflow_handoffs` row per predecessor and build a prompt containing only:

```js
{
  primaryIssue: { id, identifier, title, description, status },
  workflowGoal,
  node: { id, title, objective, rolePreset },
  predecessors: [{ nodeId, summary, conclusions, changedFiles, artifacts, verification, unresolved, risks }],
  references: [{ runId, nodeRunId, attemptId, threadId, eventIds, planningPath }],
}
```

The prompt names allowed on-demand paths and explicitly forbids assuming that the planning projection is writable. Do not inject predecessor transcripts.

- [ ] **Step 2: Start one formal thread and one attempt**

`executeCodexThread()` resolves model/effort in this order: graph default, role recommendation, generated node setting, user template override. Start the thread with the node workspace, configured sandbox, `approvalPolicy: "never"`, and `serviceName: "codex-taskboard-workflow"`; then persist `threadId` before `turn/start`. Start the turn with the handoff prompt and `WORKFLOW_NODE_RESULT_SCHEMA`, and persist `turnId` before returning control to the scheduler.

The node keeps its lease and resources while its active turn or queued inbox work exists.

- [ ] **Step 3: Persist App Server notifications before broadcasting**

Subscribe once in `start()` and route notifications by persisted attempt `threadId`/`turnId`. Handle:

```text
turn/started                  -> bind the active turn
item/started|item/completed   -> append workflow.codex.item event
item/completed agentMessage   -> retain the latest schema-valid candidate result
item/* collabToolCall         -> create/update visible workflow_subagents rows
item/completed contextCompaction -> append workflow.context.compacted
item/tool/requestUserInput    -> persist unsupported-interaction event and return JSON-RPC error
other message with id+method  -> persist unsupported-server-request event and return JSON-RPC error
thread/status/changed         -> update matching Subagent status/activity
turn/completed completed      -> clear turn, then drain inbox or evaluate barrier
turn/completed interrupted    -> attempt/node interrupted
turn/completed failed         -> attempt/node failed and propagate pause
client/closed                 -> stop scheduling and begin recovery reconciliation
```

Only after the database transaction commits may `events.emit()` notify the UI.

Every formal Chat prompt says not to invoke interactive user-input tools and to return unresolved questions in its result envelope. The server-request response is the non-hanging fallback if a model still requests one. This includes approval, permission, and MCP elicitation requests even though `approvalPolicy: "never"` should prevent normal command/file approvals; Taskboard-local Human Gate remains the only first-version approval channel.

- [ ] **Step 4: Enforce the completion barrier and failure policy**

On a completed turn, check queued messages before node completion. If none exist, require all Subagents terminal and the latest result valid. Automatic nodes become `succeeded`; manual nodes become `awaiting_confirmation` after resources are released. Then promote dependency-satisfied successors.

A failed node pauses its dependent descendants while independent branches continue. If `run.failFast` is true, pause every nonterminal node and the run. Retry remains explicit.

- [ ] **Step 5: Reconcile persisted attempts on restart**

For every nonterminal attempt:

1. Call `thread/resume` to subscribe and `thread/read(includeTurns: true)` to inspect stored state.
2. Before execution, compare `graphSchemaVersion` and every node `executorVersion` with the supported constants; set affected nodes to `migration_required` and pause the run when they are unsupported.
3. If the last turn is active, rebind it and renew the existing resources.
4. If terminal state was missed, persist it and run the normal completion path.
5. If the thread is missing or the side-effect outcome is ambiguous, set `recovery_required`.
6. Never turn an expired lease into a new attempt without this reconciliation.

Completed node runs are never selected by `claimReadyNodes()` after restart.

- [ ] **Step 6: Verify the real Chat path before adding intervention**

Use a two-Chat graph: planning (`readOnly`, shared workspace resource) then implementation (`workspaceWrite`, exclusive resource). Enqueue it and confirm two different thread IDs, the second prompt contains the structured planning result but not the full transcript, App Server events appear in `workflow_events`, and a spawned read-only Subagent appears under the planning node and prevents parent completion until terminal.

- [ ] **Step 7: Restart during the implementation turn**

Stop and restart the local service while the formal Chat is active. Expected: the same thread/turn is reconciled, completed predecessors remain succeeded, and no duplicate attempt is created. If the real App Server cannot prove state, expected state is `recovery_required`, not automatic retry.

- [ ] **Step 8: Commit Chat execution and recovery**

```bash
git add server/workflow-orchestrator.mjs server/workflow-store.mjs server/app.mjs
git commit -m "feat: execute and recover workflow chats"
```

### Task 7: Add Steer, Queued Messages, Retry, And Formal Amendments

**Files:**
- Modify: `server/workflow-orchestrator.mjs`
- Modify: `server/workflow-store.mjs`
- Modify: `server/app.mjs`
- Modify: `cli/taskctl.mjs`
- Modify: `skills/manage-taskboard/SKILL.md`
- Modify: `skills/manage-taskboard/references/cli.md`

- [ ] **Step 1: Implement user-only immediate steering**

Expose:

```js
async submitNodeInput(nodeRunId, { mode, content, actor, sourceThreadId })
```

Persist the inbox row first. For `mode: "steer"`, require `actor.type === "user"`, the node and attempt running, and an active `turnId`; then call `turn/steer` with that expected turn. If App Server reports no matching active turn, atomically change the row to `mode: "queued", status: "fallback_queued"` and wake the drain loop. Never drop the message.

- [ ] **Step 2: Drain queued messages FIFO in the same Chat**

When a turn completes, read the lowest pending/fallback sequence. Start another turn on the same persisted `threadId`, with the message source attribution and the same output schema/model/cwd/sandbox. Mark delivered only after `turn/start` returns a `turnId`. The attempt number does not change, the node stays `running`, and resources remain held.

A message arriving after the node is terminal returns `409 WORKFLOW_NODE_TERMINAL` with `formalTaskRequired: true`.

- [ ] **Step 3: Implement interrupt and retry without overwriting history**

Extend node control:

- `interrupt`: call `turn/interrupt`, then let the terminal notification set attempt/node `interrupted`.
- `retry`: allowed from `failed`, `interrupted`, `rejected`, or `recovery_required`; clear candidate node result, increment attempt number through `createRetry()`, set node `ready`, and reacquire capacity/resources normally.
- `cancel`: end an active turn first, then set node `cancelled` without releasing successors.

Old attempts, thread IDs, events, and artifacts remain queryable in the run snapshot.

- [ ] **Step 4: Implement append-only formal-task amendments**

Accept either:

```js
{ source: "user_configured", node: WorkflowRuntimeNodeDefinition }
{ source: "codex_generated", prompt: string, dependsOn: string[] }
```

Validate that dependencies refer to existing nodes, the new node ID is unique, and no running/completed node or consumed dependency changes. User-configured amendments become `ready` after deterministic validation; generated amendments run the same independent Reviewer policy as Task 4 and become `ready` only on pass. Applying a ready amendment requires a separate user request, increments `run.amendmentRevision`, inserts its node-run row, and records an event. It never updates `workflow_runs.graph_snapshot`; `getRunSnapshot()` derives `effectiveGraph` by applying ordered `applied` amendments to the immutable base snapshot. No existing graph or node row is deleted or rewritten.

- [ ] **Step 5: Add exact local routes**

```text
POST /api/local/workflow/nodes/:nodeRunId/messages      { mode, content, sourceThreadId? }
POST /api/local/workflow/nodes/:nodeRunId/control       { action }
POST /api/local/workflow/runs/:runId/amendments         configured node or generation prompt
POST /api/local/workflow/amendments/:amendmentId/apply  empty body
```

Browser requests derive the user actor through existing actor headers. `x-taskboard-client: taskctl` requests require `sourceThreadId`, resolve it to a node attempt in the same run, and force `mode: "queued"`.

- [ ] **Step 6: Add the narrow Agent queued-message command**

Add `workflow message` to `COMMAND_OPTIONS`, usage text, and dispatch:

```bash
taskctl workflow message NODE_RUN_ID --body TEXT [--thread-id ID] [--json]
```

The request is:

```js
return api.request(
  "POST",
  `/api/local/workflow/nodes/${encodeURIComponent(nodeRunId)}/messages`,
  { mode: "queued", content: requiredOption(options, "body"), sourceThreadId: resolveThreadId(options, overrides) },
);
```

Document in the Skill that Agents may queue messages only when the target node/run is explicitly provided in their handoff; they may not use it to steer another active Chat or create a formal node.

- [ ] **Step 7: Verify all three intervention semantics**

During one real implementation Chat, send a browser steer and observe the same `turnId`; enqueue a browser next-turn message and observe a new turn on the same `threadId`; use `taskctl workflow message` from a different formal Chat and verify source attribution and FIFO order. Then interrupt and retry, confirming attempt 1 remains visible and attempt 2 gets a new thread. Finally apply one formal amendment and confirm it creates a new formal node/Chat instead of an inbox message.

- [ ] **Step 8: Commit intervention and amendments**

```bash
git add server/workflow-orchestrator.mjs server/workflow-store.mjs server/app.mjs cli/taskctl.mjs skills/manage-taskboard/SKILL.md skills/manage-taskboard/references/cli.md
git commit -m "feat: add workflow intervention controls"
```

### Task 8: Make The Template Editor Produce Executable Primitives

**Files:**
- Modify: `web/src/components/WorkflowBoard.tsx`
- Modify: `web/src/components/WorkflowNode.tsx`
- Modify: `web/src/components/WorkflowInspector.tsx`
- Modify: `web/src/components/workflowCatalog.ts`
- Modify: `web/src/components/workflow.css`

- [ ] **Step 1: Add runtime configuration fields to template nodes**

Extend `WorkflowNodeData` with:

```ts
runtimePrimitive?: "codex-thread" | "human-gate" | "condition" | "issue-action";
rolePreset?: "planning" | "implementation" | "verification" | "review" | "custom";
runtimeObjective?: string;
runtimeModel?: string;
runtimeEffort?: string;
runtimeSandbox?: "readOnly" | "workspaceWrite" | "dangerFullAccess";
runtimeApprovalMode?: "automatic" | "manual";
runtimeResourceMode?: "workspace-read" | "workspace-write" | "isolated-worktree";
humanGateMessage?: string;
issueActionStatus?: TaskStatus;
```

Add palette entries for `codex-thread`, `human-gate`, and `issue-action`; reuse the existing `condition` visual node but set `runtimePrimitive: "condition"`. Keep Feishu nodes visible as non-runtime catalog items marked “后续版本”; the server rejects them from generated runtime graphs.

- [ ] **Step 2: Add focused inspector controls**

For Codex Thread, render role preset, objective, model, effort, sandbox, resource mode, and automatic/manual approval controls. Use selects or segmented controls, not free-text values for enumerations. Human Gate edits its message. Issue Action selects one target status. Condition keeps the current field/operator/value controls.

Fetch model choices through existing `getAiChatCatalog(projectId)` and show the resolved recommendation without storing quota assumptions.

- [ ] **Step 3: Replace the initial example with the approved pipeline**

The default template is:

```text
Issue trigger
  -> Planning Chat (read-only)
  -> Implementation Chat (workspace-write)
  -> Verification Chat (read-only)
  -> Taskboard confirmation
  -> Issue Action (in_review)
```

Give every node a stable ID and runtime configuration. `createWorkflow()` uses this complete template, not an empty generic canvas. Existing saved workspaces remain readable by the current parser; unsupported old catalog nodes simply cannot generate a ready runtime revision.

- [ ] **Step 4: Add independent template duplication**

Add `duplicateWorkflow(workflowId)` to the tab context menu. Clone the selected snapshot through JSON serialization into a new `workflow-${crypto.randomUUID()}` tab named `${source.name} 副本`, set it active, and persist through the existing optimistic workspace save. Do not retain a source-template link.

- [ ] **Step 5: Verify editor persistence**

In the running UI, create two templates, duplicate one, edit only the copy's model and Human Gate message, refresh, and confirm both versions persist independently. Confirm the server workspace record contains only draft template state and no run status, attempt, inbox, or thread ID.

- [ ] **Step 6: Commit executable template editing**

```bash
git add web/src/components/WorkflowBoard.tsx web/src/components/WorkflowNode.tsx web/src/components/WorkflowInspector.tsx web/src/components/workflowCatalog.ts web/src/components/workflow.css
git commit -m "feat: configure executable workflow templates"
```

### Task 9: Add The Issue Workflow Tab And Browser Contract

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`
- Create: `web/src/components/IssueWorkflowPanel.tsx`
- Modify: `web/src/components/TaskDetail.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`

- [ ] **Step 1: Mirror the runtime contract in browser types**

Add exact interfaces for `WorkflowTemplateSummary`, `WorkflowTemplateRevision`, `WorkflowRevision`, `WorkflowRun`, `WorkflowNodeRun`, `WorkflowNodeAttempt`, `WorkflowInboxMessage`, `WorkflowSubagent`, `WorkflowEvent`, `WorkflowRunAmendment`, and:

```ts
export interface IssueWorkflowSnapshot {
  templates: WorkflowTemplateSummary[];
  revisions: WorkflowRevision[];
  activeRun: WorkflowRunSnapshot | null;
}

export interface WorkflowRunSnapshot {
  run: WorkflowRun;
  effectiveGraph: WorkflowRuntimeGraph;
  nodes: WorkflowNodeRun[];
  attempts: WorkflowNodeAttempt[];
  inbox: WorkflowInboxMessage[];
  subagents: WorkflowSubagent[];
  amendments: WorkflowRunAmendment[];
  events: WorkflowEvent[];
}
```

Use the same serialized status and primitive unions as `shared/workflow-runtime.d.mts`; do not invent display-only states in the API type.

- [ ] **Step 2: Add narrow API functions**

Implement:

```ts
getIssueWorkflow(taskId, signal?)
generateWorkflowRevision(taskId, templateId)
enqueueWorkflowRevision(revisionId)
getWorkflowRun(runId, signal?)
sendWorkflowNodeMessage(nodeRunId, { mode, content })
controlWorkflowNode(nodeRunId, action)
createWorkflowAmendment(runId, input)
applyWorkflowAmendment(amendmentId)
```

All paths are `/api/local/...`; ordinary `request()` actor headers and `ApiError` behavior remain unchanged.

- [ ] **Step 3: Create the Issue-owned panel state machine**

`IssueWorkflowPanel` receives:

```ts
interface IssueWorkflowPanelProps {
  task: Task;
  workflows: WorkflowOption[];
  revision: number;
  onOpenThread: (threadId: string) => void;
  onError: (message: string) => void;
  onAnnounce: (message: string) => void;
}
```

On load/revision change it fetches `getIssueWorkflow(task.id)`. Render the template selector, selected revision number/status, Planner and Reviewer Chat links, review summary/findings, `生成并审查`, and `放入待办队列`. Disable enqueue unless the selected revision is `ready`; label `reviewing` as active review rather than queued work. Once a run exists, render a compact persisted node-status summary; Task 10 replaces that summary with the full interactive graph.

- [ ] **Step 4: Add Details and Workflow tabs to TaskDetail**

Keep title and Issue identity visible, then add a compact two-tab control: `详情` renders the current editor/attachments/activity layout unchanged; `Workflow` lazy-renders `IssueWorkflowPanel`. Store the active tab per mounted Issue and default to Details. Pass `onOpenThread` through the existing host bridge so embedded “open Chat” remains the already allowlisted `taskboard:open-thread` message.

- [ ] **Step 5: Refresh the open Issue from existing SSE**

Add these names to `EVENT_NAMES`:

```ts
"workflow.revision.updated",
"workflow.run.updated",
"workflow.node.updated",
"workflow.event.created",
```

Add `workflowRuntimeRevision` state in `App`, increment it only when the event `taskId` matches the open Issue, and pass it into `TaskDetail`. Do not add a second EventSource.

- [ ] **Step 6: Verify the review-to-enqueue UI path**

At `http://127.0.0.1:5173`, open a real Issue, select Workflow, generate a revision, observe live review completion, confirm enqueue is disabled during review and enabled only at ready, enqueue manually, and refresh. Expected: the same run returns after refresh and the Issue Details tab remains unchanged.

- [ ] **Step 7: Commit the Issue entry path**

```bash
git add web/src/types.ts web/src/api.ts web/src/components/IssueWorkflowPanel.tsx web/src/components/TaskDetail.tsx web/src/App.tsx web/src/styles.css
git commit -m "feat: add Issue workflow execution tab"
```

### Task 10: Render Runtime State, Subagents, Attempts, And Three Input Modes

**Files:**
- Create: `web/src/components/WorkflowRunGraph.tsx`
- Create: `web/src/components/WorkflowRuntimeNode.tsx`
- Create: `web/src/components/WorkflowRunInspector.tsx`
- Create: `web/src/components/workflow-runtime.css`
- Modify: `web/src/components/IssueWorkflowPanel.tsx`

- [ ] **Step 1: Derive a stable graph projection from the run snapshot**

`WorkflowRunGraph` maps formal graph nodes and dependencies from `snapshot.effectiveGraph`, then joins persisted node status. Use deterministic topological levels for x/y placement with fixed formal-node width and minimum height. Edges come only from `dependsOn`; condition edges carry true/false labels. The canvas is read-only and uses existing React Flow controls/background conventions.

- [ ] **Step 2: Render the required formal-node signals**

`WorkflowRuntimeNode` displays primitive/role, title, resolved model/effort, status, attempt number, shortened thread ID, active turn state, queued-message count, resource summary, Subagent count, and confirmation/failure/recovery signal. Use status icons and short labels with tooltips; keep cards at 8px radius or less and fixed dimensions so live counters cannot shift the layout.

- [ ] **Step 3: Expand Subagents as child nodes**

Keep expanded node IDs in `WorkflowRunGraph`. When expanded, increase the formal node's fixed height and add each Subagent as a React Flow child node with `parentId`, stable vertical slots, thread ID, model, status, activity, and result summary. Collapsed parents show an aggregate count/status. Selecting a child opens the inspector's Subagents tab; promotion is implemented through a formal amendment, never by changing only its visual parent.

- [ ] **Step 4: Build the inspector tabs and controls**

`WorkflowRunInspector` has `Inbox`, `Attempts`, `Subagents`, and `Events` tabs. The header shows runtime state, model, effort, thread ID, and an icon button with tooltip for `onOpenThread`. Render approve/reject only for `awaiting_confirmation`, interrupt only for an active turn, retry only for retryable terminal states, and cancel only for nonterminal states.

- [ ] **Step 5: Implement three visibly distinct composer modes**

Use a segmented control:

```text
立即引导 | 下一轮消息 | 新增任务
```

- Immediate calls `sendWorkflowNodeMessage(..., { mode: "steer" })` and explains failure only through returned state, not instructional page copy.
- Next message calls mode `queued` and immediately appears in FIFO inbox history.
- New task shows `直接配置 | Codex 生成`; direct configuration exposes primitive, objective, dependencies, model/effort, resource mode, and approval; generated mode sends a prompt plus dependencies. Ready amendments show an explicit `应用到流程` action.

Never relabel a queued message as a task. When the server returns `formalTaskRequired`, switch the composer to New Task while retaining the text.

- [ ] **Step 6: Add quiet operational styling and responsive behavior**

Use one unframed split layout: graph plus inspector, no card nested inside another card. At narrow widths, stack inspector below the graph. Set `min-width: 0`, fixed node dimensions, overflow wrapping for IDs/messages, and a minimum canvas height. Reuse current neutral palette with distinct success/warning/error colors; avoid a single-hue or decorative gradient treatment.

- [ ] **Step 7: Verify desktop and mobile visual behavior**

Use Browser control at 1440x900 and 390x844. Capture the main run, expanded Subagents, each inspector tab, all three composer modes, a failed branch, and awaiting confirmation. Expected: no overlapping controls/text, no layout shift when counts change, the longest ID wraps or truncates with tooltip, and the graph remains navigable on mobile.

- [ ] **Step 8: Commit the runtime graph and inspector**

```bash
git add web/src/components/WorkflowRunGraph.tsx web/src/components/WorkflowRuntimeNode.tsx web/src/components/WorkflowRunInspector.tsx web/src/components/workflow-runtime.css web/src/components/IssueWorkflowPanel.tsx
git commit -m "feat: visualize workflow execution state"
```

### Task 11: Prove The Complete Direct Operation Path

**Files:**
- Verify all files from Tasks 1-10
- Modify only files required by a failure observed in this task

- [ ] **Step 1: Re-read the approved specification and this plan**

Confirm every first-version requirement in `docs/superpowers/specs/2026-08-07-codex-thread-orchestrator-design.md` maps to an implemented task. Confirm Feishu, external waits/webhooks, Agent cross-Chat steer, automatic rollover, and cloud execution takeover remain absent.

- [ ] **Step 2: Run static and production checks**

Run:

```bash
node --check shared/workflow-runtime.mjs
node --check server/codex-app-server.mjs
node --check server/workflow-store.mjs
node --check server/workflow-review.mjs
node --check server/workflow-business-store.mjs
node --check server/workflow-planning-projection.mjs
node --check server/workflow-orchestrator.mjs
node --check cli/taskctl.mjs
npm run typecheck
npm run build
git diff --check
```

Expected: every command exits 0. `npm run build` may report that no debuggable Codex window is available; that skip is acceptable only for the iframe refresh post-step, not for the build.

- [ ] **Step 3: Demonstrate the full real-Issue workflow**

Start `npm run dev` and use the Browser control skill at `http://127.0.0.1:5173`:

1. Select and duplicate the recommended template.
2. Generate a graph for a real Issue and observe deterministic plus independent review.
3. Prove reviewing cannot enqueue, then manually enqueue ready.
4. Observe separate planning, implementation, and verification thread IDs.
5. Send one user steer, one queued message, and one Agent queued cross-Chat message.
6. Expand two read-only Subagents and confirm they block parent completion.
7. Observe independent shared work overlap and same-workspace writes serialize.
8. Interrupt and retry one attempt without losing attempt 1.
9. Fail one branch and confirm only dependent descendants pause with fail-fast off.
10. Restart the service during a running node and confirm reconciliation without duplicate completed work.
11. Approve the local Human Gate and observe the explicit Issue Action change the Issue to `in_review`.

Record actual run ID, node IDs, thread IDs, attempt numbers, relevant event IDs, and before/after Issue versions in the task progress log.

- [ ] **Step 4: Verify embedded open-Chat behavior**

Run `npm run build`, open the built iframe or existing Codex Taskboard, and click Open Chat on a formal node and one Subagent. Expected: embedded mode navigates through the existing `taskboard:open-thread` bridge; standalone mode keeps usable persisted activity even if the custom URL cannot be opened.

- [ ] **Step 5: Inspect the final change boundary**

Run `git status --short`, `git diff --stat`, and `git log --oneline --max-count=15`. Confirm no `.data` database, planning projection, user-level planning file, `.superpowers`, generated `dist/web`, unrelated injector edits, secrets, or absolute device path is staged.

- [ ] **Step 6: Commit only fixes produced by verification**

If Task 11 required source fixes, stage those exact files and create a focused Conventional Commit describing the observed path failure. Do not create an empty integration commit. Report the final commit series and the exact direct-path evidence to the user for confirmation; wait for explicit authorization before adding targeted regression protection.
