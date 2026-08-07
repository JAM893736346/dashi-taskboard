import { randomUUID } from "node:crypto";

import {
  assertWorkflowRuntimeGraph,
  evaluateWorkflowCondition,
  settleWorkflowDependencies,
  WORKFLOW_EXECUTOR_VERSIONS,
  WORKFLOW_GRAPH_SCHEMA_VERSION,
  WORKFLOW_NODE_RESULT_SCHEMA,
} from "../shared/workflow-runtime.mjs";
import { ApiError } from "./database.mjs";

const DEFAULT_LEASE_MS = 2 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 30 * 1000;
const MAX_RECONNECT_MS = 30 * 1000;
const ACTIVE_RUN_STATUSES = new Set(["queued", "running"]);
const ACTIVE_NODE_STATUSES = new Set(["blocked", "ready", "running", "awaiting_confirmation"]);
const FAILURE_NODE_STATUSES = new Set([
  "rejected",
  "failed",
  "interrupted",
  "recovery_required",
  "migration_required",
]);
const TERMINAL_SUBAGENT_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled"]);
const ROLE_RECOMMENDATIONS = Object.freeze({
  planning: { effort: "high" },
  implementation: { effort: "high" },
  verification: { effort: "medium" },
  review: { effort: "high" },
});
const SANDBOX_MODES = Object.freeze({
  readOnly: "read-only",
  workspaceWrite: "workspace-write",
  dangerFullAccess: "danger-full-access",
});
const STRICT_NODE_RESULT_SCHEMA = Object.freeze({
  ...WORKFLOW_NODE_RESULT_SCHEMA,
  required: Object.freeze([...WORKFLOW_NODE_RESULT_SCHEMA.required, "planningDirectory"]),
});

function errorPayload(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "WORKFLOW_EXECUTOR_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseNodeResult(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(value)) return null;
  const allowed = new Set([
    "summary",
    "conclusions",
    "changedFiles",
    "artifacts",
    "verification",
    "unresolved",
    "risks",
    "planningDirectory",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  if (typeof value.summary !== "string") return null;
  for (const key of [
    "conclusions",
    "changedFiles",
    "artifacts",
    "verification",
    "unresolved",
    "risks",
  ]) {
    if (!Array.isArray(value[key]) || value[key].some((entry) => typeof entry !== "string")) {
      return null;
    }
  }
  if (value.planningDirectory !== undefined && typeof value.planningDirectory !== "string") return null;
  return JSON.parse(JSON.stringify(value));
}

function normalizeSubagentStatus(status, fallback = "running") {
  if (status === "pendingInit" || status === "running") return "running";
  if (status === "completed") return "completed";
  if (status === "interrupted") return "interrupted";
  if (status === "shutdown") return "cancelled";
  if (status === "errored" || status === "notFound") return "failed";
  return fallback;
}

function normalizeThreadStatus(status, fallback = "running") {
  if (status?.type === "active") return "running";
  if (status?.type === "idle") return "completed";
  if (status?.type === "systemError") return "failed";
  return fallback;
}

function failureDescendants(graph, nodes) {
  const failed = new Set(
    nodes.filter((node) => FAILURE_NODE_STATUSES.has(node.status)).map((node) => node.definitionId),
  );
  const outgoing = new Map(graph.nodes.map((node) => [node.id, []]));
  for (const node of graph.nodes) {
    for (const dependency of node.dependsOn) outgoing.get(dependency.nodeId)?.push(node.id);
  }
  const descendants = new Set();
  const queue = [...failed];
  for (let index = 0; index < queue.length; index += 1) {
    for (const child of outgoing.get(queue[index]) ?? []) {
      if (descendants.has(child)) continue;
      descendants.add(child);
      queue.push(child);
    }
  }
  return descendants;
}

function amendmentNode(amendment) {
  return amendment.patch?.node ?? amendment.patch?.addNode ?? amendment.patch;
}

function effectiveGraph(snapshot) {
  const nodes = snapshot.amendments
    .filter((amendment) => amendment.status === "applied")
    .map(amendmentNode);
  const graph = {
    ...snapshot.run.graphSnapshot,
    nodes: [...snapshot.run.graphSnapshot.nodes, ...nodes],
  };
  if (
    snapshot.run.graphSchemaVersion !== WORKFLOW_GRAPH_SCHEMA_VERSION
    || graph.nodes.some((node) => WORKFLOW_EXECUTOR_VERSIONS[node.type] !== node.executorVersion)
  ) return graph;
  return assertWorkflowRuntimeGraph(graph);
}

export class WorkflowOrchestrator {
  constructor({
    store,
    codex,
    businessStore,
    planningProjection,
    events,
    resolveWorkspace,
    getCatalog,
    leaseMs = DEFAULT_LEASE_MS,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
  }) {
    this.store = store;
    this.codex = codex;
    this.businessStore = businessStore;
    this.planningProjection = planningProjection;
    this.events = events;
    this.resolveWorkspace = resolveWorkspace;
    this.getCatalog = getCatalog;
    this.leaseMs = leaseMs;
    this.heartbeatMs = heartbeatMs;
    this.orchestratorId = randomUUID();
    this.started = false;
    this.closed = false;
    this.connected = false;
    this.dirty = false;
    this.wakeReasons = new Set();
    this.reconcilePromise = null;
    this.activeExecutions = new Map();
    this.unsubscribeCodex = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.recovering = false;
    this.notificationQueue = Promise.resolve();
    this.executors = {
      "human-gate": (context) => this.#executeHumanGate(context),
      condition: (context) => this.#executeCondition(context),
      "issue-action": (context) => this.#executeIssueAction(context),
      "codex-thread": (context) => this.#executeCodexThread(context),
    };
  }

  async start() {
    if (this.closed) throw new Error("Workflow orchestrator is closed");
    if (this.started) return this;
    await this.codex.start();
    this.connected = true;
    this.unsubscribeCodex = this.codex.subscribe((notification) => {
      this.notificationQueue = this.notificationQueue
        .then(() => this.#handleNotification(notification))
        .catch((error) => console.error(error));
    });
    this.started = true;
    this.heartbeatTimer = setInterval(() => this.#heartbeat(), this.heartbeatMs);
    this.heartbeatTimer.unref?.();
    this.recovering = true;
    try {
      await this.#queueRecoveryReconciliation();
    } finally {
      this.recovering = false;
    }
    await this.wake("start");
    return this;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.reconcilePromise;
    await Promise.allSettled([...this.activeExecutions.values()]);
    await this.notificationQueue;
    this.unsubscribeCodex?.();
    this.unsubscribeCodex = null;
    await this.codex.close();
  }

  wake(reason) {
    if (this.closed) return Promise.resolve();
    this.wakeReasons.add(reason);
    this.dirty = true;
    if (this.recovering) return Promise.resolve();
    if (this.reconcilePromise) return this.reconcilePromise;
    const reconcile = this.#drainWakeLoop();
    const tracked = reconcile.finally(() => {
      if (this.reconcilePromise === tracked) this.reconcilePromise = null;
    });
    this.reconcilePromise = tracked;
    return this.reconcilePromise;
  }

  async enqueueRevision(revisionId) {
    if (this.closed) throw new Error("Workflow orchestrator is closed");
    const runId = randomUUID();
    const planningPath = this.planningProjection.pathFor(runId);
    const committed = this.store.enqueueRevision({ runId, revisionId, planningPath });
    const snapshot = { ...committed, effectiveGraph: effectiveGraph(committed) };
    await this.planningProjection.initialize(snapshot);
    this.#emitRun(snapshot.run);
    for (const event of snapshot.events) this.#emitEvent(snapshot.run, event);
    void this.wake("revision-enqueued").catch((error) => console.error(error));
    return snapshot;
  }

  async getTaskWorkflow(taskId) {
    const task = await this.businessStore.getTask(taskId);
    if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
    const workflow = await this.businessStore.getTemplateWorkspace(task.projectId);
    const tabs = Array.isArray(workflow?.workspace?.tabs) ? workflow.workspace.tabs : [];
    const templates = tabs.map((tab) => {
      const latest = this.store.database.prepare(`
        SELECT id FROM workflow_template_revisions
        WHERE project_id = ? AND template_id = ?
        ORDER BY revision DESC LIMIT 1
      `).get(task.projectId, tab.id);
      return {
        id: tab.id,
        name: tab.name,
        workspaceVersion: workflow.version,
        templateRevision: latest ? this.store.getTemplateRevision(latest.id) : null,
      };
    });
    const revisions = this.store.listTaskRevisions(task.id).map((revision) => ({
      ...revision,
      templateRevisionRecord: this.store.getTemplateRevision(revision.templateRevisionId),
    }));
    const activeRun = this.store.getActiveRunForTask(task.id);
    return {
      templates,
      revisions,
      activeRun: activeRun ? this.getRunSnapshot(activeRun.id) : null,
    };
  }

  getRunSnapshot(runId) {
    const snapshot = this.store.getRunSnapshot(runId);
    if (!snapshot) {
      throw new ApiError(404, "WORKFLOW_RUN_NOT_FOUND", `Workflow run '${runId}' does not exist`);
    }
    return { ...snapshot, effectiveGraph: effectiveGraph(snapshot) };
  }

  async controlNode(nodeRunId, action) {
    if (this.closed) throw new Error("Workflow orchestrator is closed");
    const context = this.#nodeContext(nodeRunId);
    let node = context.node;
    if (action === "approve") {
      node = this.store.transitionNode(node.id, ["awaiting_confirmation"], "succeeded");
    } else if (action === "reject") {
      node = this.store.transitionNode(node.id, ["awaiting_confirmation"], "rejected");
    } else {
      if (!["blocked", "ready", "awaiting_confirmation"].includes(node.status)) {
        throw new ApiError(
          409,
          "WORKFLOW_NODE_STATE_CONFLICT",
          "Workflow node cannot be cancelled from its current state",
          { nodeRunId, actualStatus: node.status },
        );
      }
      if (node.leaseOwner !== null) {
        node = this.store.releaseNodeResources(node.id, node.leaseOwner);
      }
      node = this.store.transitionNode(
        node.id,
        ["blocked", "ready", "awaiting_confirmation"],
        "cancelled",
        { result: { reason: "user_cancelled" } },
      );
    }
    const eventType = action === "approve"
      ? "workflow.node.approved"
      : action === "reject" ? "workflow.node.rejected" : "workflow.node.cancelled";
    const event = this.#recordEvent(
      context.run,
      node,
      null,
      eventType,
      { action },
    );
    this.#emitNode(context.run, node);
    this.#emitEvent(context.run, event);
    await this.wake(`node-${action}`);
    return this.getRunSnapshot(context.run.id);
  }

  async #handleNotification(notification) {
    if (notification.method === "client/closed") {
      if (this.closed) return;
      this.connected = false;
      this.#scheduleReconnect();
      return;
    }
    if (notification.id !== undefined) {
      this.#handleServerRequest(notification);
      return;
    }
    if (notification.method === "turn/started") {
      this.#handleTurnStarted(notification.params ?? {});
      return;
    }
    if (notification.method === "item/started" || notification.method === "item/completed") {
      this.#handleItemNotification(notification.method, notification.params ?? {});
      return;
    }
    if (notification.method === "thread/status/changed") {
      this.#handleThreadStatusChanged(notification.params ?? {});
      return;
    }
    if (notification.method === "turn/completed" || notification.method === "turn/failed") {
      await this.#handleTurnCompleted(notification.params ?? {});
    }
  }

  #handleServerRequest(notification) {
    const params = notification.params ?? {};
    const context = this.store.findAttemptContext({
      threadId: params.threadId,
      turnId: params.turnId ?? null,
    });
    if (context) {
      const type = notification.method === "item/tool/requestUserInput"
        ? "workflow.codex.unsupported_interaction"
        : "workflow.codex.unsupported_server_request";
      const event = this.#recordEvent(context.run, context.node, context.attempt, type, {
        method: notification.method,
        requestId: notification.id,
        params,
      });
      this.#emitEvent(context.run, event);
    }
    this.codex.respondToServerRequest(notification.id, {
      error: {
        code: -32601,
        message: "Interactive App Server requests are unsupported in formal workflow Chats",
      },
    });
  }

  #handleTurnStarted(params) {
    const threadId = params.threadId;
    const turnId = params.turn?.id ?? params.turnId;
    let context = this.store.findAttemptContext({ threadId, turnId });
    if (!context) context = this.store.findAttemptContext({ threadId });
    if (!context || typeof turnId !== "string" || turnId.length === 0) return;
    const attempt = this.store.bindAttemptThread({
      attemptId: context.attempt.id,
      threadId,
      turnId,
    });
    const event = this.#recordEvent(context.run, context.node, attempt, "workflow.codex.turn.started", {
      threadId,
      turnId,
      status: params.turn?.status ?? "inProgress",
    });
    this.#emitNode(context.run, this.#nodeContext(context.node.id).node);
    this.#emitEvent(context.run, event);
  }

  #handleItemNotification(method, params) {
    const turnId = params.turnId ?? params.turn?.id;
    const context = this.store.findAttemptContext({ threadId: params.threadId, turnId });
    if (!context) return;
    const item = params.item ?? null;
    let candidateValid = false;
    if (method === "item/completed" && item?.type === "agentMessage") {
      const candidate = parseNodeResult(item.text);
      if (candidate !== null) {
        this.store.setAttemptCandidateResult({
          attemptId: context.attempt.id,
          expectedTurnId: turnId,
          candidateResult: candidate,
        });
        candidateValid = true;
      }
    }
    const subagents = item?.type === "collabAgentToolCall"
      ? this.#persistCollabSubagents(context, item)
      : [];
    const eventType = method === "item/completed" && item?.type === "contextCompaction"
      ? "workflow.context.compacted"
      : "workflow.codex.item";
    const event = this.#recordEvent(context.run, context.node, context.attempt, eventType, {
      phase: method === "item/started" ? "started" : "completed",
      threadId: params.threadId,
      turnId,
      item,
      ...(item?.type === "agentMessage" ? { candidateValid } : {}),
    });
    if (subagents.length > 0) this.#emitNode(context.run, this.#nodeContext(context.node.id).node);
    this.#emitEvent(context.run, event);
    if (subagents.some((subagent) => TERMINAL_SUBAGENT_STATUSES.has(subagent.status))) {
      this.#completeNodeAfterBarrier(context);
    }
  }

  #persistCollabSubagents(context, item) {
    const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [];
    return receivers.flatMap((threadId) => {
      const existing = this.store.getSubagentByThread(threadId);
      if (!existing && item.tool !== "spawnAgent") return [];
      const state = item.agentsStates?.[threadId];
      const status = normalizeSubagentStatus(state?.status, existing?.status ?? "running");
      return [this.store.upsertSubagent({
        threadId,
        ...(existing ? {} : {
          nodeRunId: context.node.id,
          attemptId: context.attempt.id,
          parentThreadId: context.attempt.threadId,
          role: "subagent",
          model: item.model ?? null,
        }),
        status,
        activity: {
          tool: item.tool,
          toolCallStatus: item.status,
          prompt: item.prompt ?? null,
          message: state?.message ?? null,
        },
        ...(TERMINAL_SUBAGENT_STATUSES.has(status)
          ? { result: { message: state?.message ?? null } }
          : {}),
      })];
    });
  }

  #handleThreadStatusChanged(params) {
    const subagent = this.store.getSubagentByThread(params.threadId);
    if (!subagent) return;
    const status = normalizeThreadStatus(params.status, subagent.status);
    const updated = this.store.upsertSubagent({
      threadId: subagent.threadId,
      status,
      activity: { threadStatus: params.status },
    });
    const context = this.#nodeContext(updated.nodeRunId);
    const attempt = this.store.getRunSnapshot(context.run.id).attempts.find((candidate) => (
      candidate.id === updated.attemptId
    )) ?? null;
    const event = this.#recordEvent(context.run, context.node, attempt, "workflow.subagent.updated", {
      subagentId: updated.id,
      threadId: updated.threadId,
      status: updated.status,
      activity: updated.activity,
    });
    this.#emitNode(context.run, context.node);
    this.#emitEvent(context.run, event);
    if (TERMINAL_SUBAGENT_STATUSES.has(updated.status)) this.#completeNodeAfterBarrier({
      ...context,
      attempt,
    });
  }

  async #handleTurnCompleted(params) {
    const turn = params.turn ?? {};
    const turnId = turn.id ?? params.turnId;
    const context = this.store.findAttemptContext({ threadId: params.threadId, turnId });
    if (!context || typeof turnId !== "string" || turnId.length === 0) return;
    if (context.attempt.lastFinishedTurnId === turnId && context.node.status !== "running") return;

    if (turn.status === "completed") {
      const pending = this.store.peekQueuedMessage(context.node.id);
      if (pending) {
        const attempt = this.store.finishTurn({
          attemptId: context.attempt.id,
          expectedTurnId: turnId,
          status: "running",
        });
        const event = this.#recordEvent(context.run, context.node, attempt, "workflow.codex.turn.completed", {
          threadId: params.threadId,
          turnId,
          status: turn.status,
          queuedMessageId: pending.id,
        });
        this.#emitEvent(context.run, event);
        return;
      }
      if (context.attempt.candidateResult === null) {
        this.#settleNotificationFailure(context, turnId, "failed", {
          code: "INVALID_WORKFLOW_RESULT",
          message: "Formal Codex Chat completed without a schema-valid result envelope",
        });
      } else {
        const attempt = this.store.finishTurn({
          attemptId: context.attempt.id,
          expectedTurnId: turnId,
          status: "completed",
        });
        const event = this.#recordEvent(context.run, context.node, attempt, "workflow.codex.turn.completed", {
          threadId: params.threadId,
          turnId,
          status: turn.status,
        });
        this.#emitEvent(context.run, event);
        this.#completeNodeAfterBarrier({ ...context, attempt });
      }
    } else {
      const status = turn.status === "interrupted" ? "interrupted" : "failed";
      this.#settleNotificationFailure(context, turnId, status, {
        code: status === "interrupted" ? "WORKFLOW_TURN_INTERRUPTED" : "WORKFLOW_TURN_FAILED",
        message: turn.error?.message ?? `Formal Codex turn ended with status '${turn.status ?? "failed"}'`,
      });
    }
    await this.wake("codex-turn-completed");
  }

  #settleNotificationFailure(context, turnId, status, error) {
    const settled = this.store.settleAttemptFailure({
      attemptId: context.attempt.id,
      expectedTurnId: turnId,
      attemptStatus: status,
      nodeStatus: status,
      error,
    });
    const event = this.#recordEvent(
      context.run,
      settled.node,
      settled.attempt,
      `workflow.node.${status}`,
      { threadId: context.attempt.threadId, turnId, ...error },
    );
    this.#emitNode(context.run, settled.node);
    this.#emitEvent(context.run, event);
  }

  #completeNodeAfterBarrier(context) {
    const node = this.store.completeNodeIfBarrierSatisfied(context.node.id);
    if (!node) return null;
    const event = this.#recordEvent(
      context.run,
      node,
      context.attempt,
      `workflow.node.${node.status}`,
      { result: node.result },
    );
    this.#emitNode(context.run, node);
    this.#emitEvent(context.run, event);
    if (!this.closed) void this.wake("codex-completion-barrier").catch((error) => console.error(error));
    return node;
  }

  async #reconcilePersistedRuns() {
    for (const run of this.store.listNonterminalRuns()) {
      let snapshot = this.store.getRunSnapshot(run.id);
      if (!snapshot) continue;
      if (this.#markUnsupportedVersions(snapshot)) continue;
      for (const attempt of snapshot.attempts.filter((candidate) => candidate.status === "running")) {
        snapshot = this.store.getRunSnapshot(run.id);
        const current = snapshot.attempts.find((candidate) => candidate.id === attempt.id);
        if (current?.status === "running") await this.#reconcileAttempt(snapshot, current);
      }
    }
  }

  #queueRecoveryReconciliation() {
    const reconciliation = this.notificationQueue.then(() => this.#reconcilePersistedRuns());
    this.notificationQueue = reconciliation.catch((error) => console.error(error));
    return reconciliation;
  }

  #markUnsupportedVersions(snapshot) {
    const graphUnsupported = snapshot.run.graphSchemaVersion !== WORKFLOW_GRAPH_SCHEMA_VERSION;
    const migrationPresent = graphUnsupported || snapshot.nodes.some((node) => (
      node.status === "migration_required"
    ));
    const affected = snapshot.nodes.filter((node) => (
      ACTIVE_NODE_STATUSES.has(node.status)
      && (
        graphUnsupported
        || WORKFLOW_EXECUTOR_VERSIONS[node.type] !== node.executorVersion
      )
    ));
    if (affected.length === 0 && !migrationPresent) return false;

    for (const current of affected) {
      const details = {
        code: "WORKFLOW_MIGRATION_REQUIRED",
        message: graphUnsupported
          ? `Workflow graph schema ${snapshot.run.graphSchemaVersion} is unsupported`
          : `Executor ${current.type}@${current.executorVersion} is unsupported`,
        graphSchemaVersion: snapshot.run.graphSchemaVersion,
        supportedGraphSchemaVersion: WORKFLOW_GRAPH_SCHEMA_VERSION,
        executorVersion: current.executorVersion,
        supportedExecutorVersion: WORKFLOW_EXECUTOR_VERSIONS[current.type] ?? null,
      };
      const node = this.store.markNodeMigrationRequired(current.id, details);
      const event = this.#recordEvent(snapshot.run, node, null, "workflow.node.migration_required", details);
      this.#emitNode(snapshot.run, node);
      this.#emitEvent(snapshot.run, event);
    }
    if (snapshot.run.status !== "paused") {
      const run = this.store.transitionRun(snapshot.run.id, [snapshot.run.status], "paused");
      const event = this.#recordEvent(run, null, null, "workflow.run.paused", {
        reason: "migration_required",
      });
      this.#emitRun(run);
      this.#emitEvent(run, event);
    }
    return true;
  }

  async #reconcileAttempt(snapshot, attempt) {
    const node = snapshot.nodes.find((candidate) => candidate.id === attempt.nodeRunId);
    const context = { run: snapshot.run, node, attempt };
    if (!attempt.threadId) {
      this.#markAttemptRecoveryRequired(context, {
        code: "WORKFLOW_THREAD_MISSING",
        message: "Persisted workflow attempt has no formal thread ID",
      });
      return;
    }

    let thread;
    try {
      await this.codex.resumeThread(attempt.threadId);
      thread = (await this.codex.readThread(attempt.threadId, true))?.thread;
    } catch (error) {
      this.#markAttemptRecoveryRequired(context, {
        code: "WORKFLOW_THREAD_UNAVAILABLE",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    const turn = attempt.turnId
      ? turns.find((candidate) => candidate.id === attempt.turnId)
      : turns.at(-1);
    if (!turn) {
      this.#markAttemptRecoveryRequired(context, {
        code: "WORKFLOW_TURN_MISSING",
        message: "Codex could not prove the persisted attempt's turn state",
      });
      return;
    }

    if (attempt.turnId === null) {
      attempt = this.store.bindAttemptThread({
        attemptId: attempt.id,
        threadId: attempt.threadId,
        turnId: turn.id,
      });
      context.attempt = attempt;
    }
    const persistedItemIds = new Set(
      this.store.getRunSnapshot(snapshot.run.id).events
        .filter((event) => event.data?.phase === "completed" && event.data?.item?.id)
        .map((event) => event.data.item.id),
    );
    for (const item of Array.isArray(turn.items) ? turn.items : []) {
      if (persistedItemIds.has(item?.id)) continue;
      this.#handleItemNotification("item/completed", {
        threadId: attempt.threadId,
        turnId: turn.id,
        item,
      });
    }

    if (turn.status === "inProgress") {
      const recoveredNode = this.store.adoptAttemptLease({
        attemptId: attempt.id,
        owner: this.orchestratorId,
        leaseMs: this.leaseMs,
      });
      const event = this.#recordEvent(
        snapshot.run,
        recoveredNode,
        attempt,
        "workflow.codex.turn.reconciled",
        { threadId: attempt.threadId, turnId: turn.id, status: turn.status },
      );
      this.#emitNode(snapshot.run, recoveredNode);
      this.#emitEvent(snapshot.run, event);
      return;
    }
    await this.#handleTurnCompleted({ threadId: attempt.threadId, turn });
  }

  #markAttemptRecoveryRequired(context, error) {
    const settled = this.store.settleAttemptFailure({
      attemptId: context.attempt.id,
      attemptStatus: "recovery_required",
      nodeStatus: "recovery_required",
      error,
      retainResources: true,
    });
    const event = this.#recordEvent(
      context.run,
      settled.node,
      settled.attempt,
      "workflow.node.recovery_required",
      { threadId: context.attempt.threadId, turnId: context.attempt.turnId, ...error },
    );
    this.#emitNode(context.run, settled.node);
    this.#emitEvent(context.run, event);
  }

  async #drainWakeLoop() {
    while (this.dirty && !this.closed) {
      this.dirty = false;
      this.wakeReasons.clear();
      if (!this.connected) {
        this.#scheduleReconnect();
        return;
      }
      for (const run of this.store.listNonterminalRuns()) {
        await this.#reconcileRun(run.id);
      }
    }
  }

  async #reconcileRun(runId) {
    const persisted = this.store.getRunSnapshot(runId);
    if (!persisted || this.#markUnsupportedVersions(persisted)) return;
    let snapshot = { ...persisted, effectiveGraph: effectiveGraph(persisted) };
    while (true) {
      const transitions = settleWorkflowDependencies(snapshot.effectiveGraph, snapshot.nodes);
      if (transitions.length === 0) break;
      for (const transition of transitions) {
        const current = snapshot.nodes.find((node) => node.definitionId === transition.nodeId);
        const node = this.store.transitionNode(
          current.id,
          ["blocked"],
          transition.status,
          transition.reason === null ? {} : { result: { reason: transition.reason } },
        );
        const event = this.#recordEvent(
          snapshot.run,
          node,
          null,
          `workflow.node.${transition.status}`,
          { definitionId: node.definitionId, reason: transition.reason },
        );
        this.#emitNode(snapshot.run, node);
        this.#emitEvent(snapshot.run, event);
      }
      snapshot = this.getRunSnapshot(runId);
    }

    if (snapshot.nodes.some((node) => (
      node.status === "recovery_required" || node.status === "migration_required"
    ))) {
      await this.#recomputeRun(snapshot);
      await this.planningProjection.refresh(this.getRunSnapshot(runId));
      return;
    }

    if (snapshot.run.failFast && snapshot.nodes.some((node) => FAILURE_NODE_STATUSES.has(node.status))) {
      await this.#pauseFailFastRun(snapshot);
      await this.planningProjection.refresh(this.getRunSnapshot(runId));
      return;
    }

    if (ACTIVE_RUN_STATUSES.has(snapshot.run.status)) {
      const claimed = this.store.claimReadyNodes({
        runId,
        owner: this.orchestratorId,
        limit: snapshot.run.concurrencyLimit,
        leaseMs: this.leaseMs,
      });
      if (claimed.length > 0 && snapshot.run.status === "queued") {
        const run = this.store.transitionRun(runId, ["queued"], "running");
        this.#emitRun(run);
        snapshot = this.getRunSnapshot(runId);
      }
      for (const node of claimed) this.#launchNode(snapshot, node);
    }

    snapshot = this.getRunSnapshot(runId);
    await this.#recomputeRun(snapshot);
    await this.planningProjection.refresh(this.getRunSnapshot(runId));
  }

  #launchNode(snapshot, node) {
    if (this.activeExecutions.has(node.id)) return;
    const execution = this.#executeNode(snapshot, node)
      .catch((error) => this.#failClaimedNode(snapshot.run, node, error))
      .finally(() => {
        this.activeExecutions.delete(node.id);
        if (!this.closed) {
          void this.wake("node-settled").catch((error) => console.error(error));
        }
      });
    this.activeExecutions.set(node.id, execution);
  }

  async #executeNode(snapshot, node) {
    const executor = this.executors[node.type];
    if (!executor) {
      const error = new Error(`No executor is registered for '${node.type}'`);
      error.code = "WORKFLOW_EXECUTOR_NOT_FOUND";
      throw error;
    }
    await executor({ snapshot, run: snapshot.run, node });
  }

  #executeHumanGate({ run, node }) {
    this.store.releaseNodeResources(node.id, this.orchestratorId);
    const updated = this.store.transitionNode(
      node.id,
      ["ready"],
      "awaiting_confirmation",
      { result: { message: node.config.message } },
    );
    const event = this.#recordEvent(run, updated, null, "workflow.node.awaiting_confirmation", {
      message: node.config.message,
    });
    this.#emitNode(run, updated);
    this.#emitEvent(run, event);
  }

  #executeCondition({ snapshot, run, node }) {
    const source = snapshot.nodes.find((candidate) => (
      candidate.definitionId === node.config.sourceNodeId
    ));
    const outcome = evaluateWorkflowCondition(node.config, source?.result);
    this.store.releaseNodeResources(node.id, this.orchestratorId);
    const status = node.approvalMode === "manual" ? "awaiting_confirmation" : "succeeded";
    const updated = this.store.transitionNode(node.id, ["ready"], status, {
      result: { branchOutcome: outcome },
      branchOutcome: String(outcome),
    });
    const event = this.#recordEvent(run, updated, null, `workflow.node.${status}`, {
      branchOutcome: String(outcome),
    });
    this.#emitNode(run, updated);
    this.#emitEvent(run, event);
  }

  async #executeCodexThread({ snapshot, run, node }) {
    const context = await this.#buildCodexContext(snapshot, node);
    const attempt = this.store.startAttempt({
      nodeRunId: node.id,
      owner: this.orchestratorId,
    });
    let threadId = null;
    let turnStartDispatched = false;
    try {
      const started = await this.codex.startThread({
        cwd: context.workspacePath,
        approvalPolicy: "never",
        sandbox: context.sandbox,
        model: context.model,
        serviceName: "codex-taskboard-workflow",
      });
      threadId = started?.thread?.id;
      if (typeof threadId !== "string" || threadId.length === 0) {
        throw new Error("Codex returned an invalid formal thread response");
      }
      this.store.bindAttemptThread({ attemptId: attempt.id, threadId, turnId: null });
      let event = this.#recordEvent(run, node, attempt, "workflow.codex.thread.started", {
        threadId,
        model: context.model,
        effort: context.effort,
        sandbox: context.sandbox,
      });
      this.#emitEvent(run, event);

      const currentRun = this.store.getRun(run.id);
      if (currentRun.status !== "queued" && currentRun.status !== "running") {
        const failure = {
          code: "WORKFLOW_RUN_PAUSED_BEFORE_TURN",
          message: "Workflow run paused before the formal turn started",
        };
        const settled = this.store.settleAttemptFailure({
          attemptId: attempt.id,
          attemptStatus: "interrupted",
          nodeStatus: "interrupted",
          error: failure,
        });
        event = this.#recordEvent(
          currentRun,
          settled.node,
          settled.attempt,
          "workflow.node.interrupted",
          { threadId, turnId: null, ...failure },
        );
        this.#emitNode(currentRun, settled.node);
        this.#emitEvent(currentRun, event);
        return;
      }

      turnStartDispatched = true;
      const startedTurn = await this.codex.startTurn(threadId, {
        input: [{ type: "text", text: context.prompt }],
        outputSchema: STRICT_NODE_RESULT_SCHEMA,
        effort: context.effort,
      });
      const turnId = startedTurn?.turn?.id;
      if (typeof turnId !== "string" || turnId.length === 0) {
        throw new Error("Codex returned an invalid formal turn response");
      }
      const bound = this.store.bindAttemptThread({ attemptId: attempt.id, threadId, turnId });
      event = this.#recordEvent(run, node, bound, "workflow.codex.turn.bound", {
        threadId,
        turnId,
      });
      this.#emitNode(run, this.#nodeContext(node.id).node);
      this.#emitEvent(run, event);
    } catch (error) {
      if (threadId !== null && turnStartDispatched) {
        const latest = this.store.getRunSnapshot(run.id);
        const currentAttempt = latest?.attempts.find((candidate) => candidate.id === attempt.id);
        if (currentAttempt?.status === "running") {
          await this.#reconcileAttempt(latest, currentAttempt);
        }
        return;
      }
      const failure = errorPayload(error);
      const settled = this.store.settleAttemptFailure({
        attemptId: attempt.id,
        attemptStatus: "failed",
        nodeStatus: "failed",
        error: failure,
      });
      const event = this.#recordEvent(
        run,
        settled.node,
        settled.attempt,
        `workflow.node.${settled.node.status}`,
        failure,
      );
      this.#emitNode(run, settled.node);
      this.#emitEvent(run, event);
    }
  }

  async #buildCodexContext(snapshot, node) {
    const definition = snapshot.effectiveGraph.nodes.find((candidate) => (
      candidate.id === node.definitionId
    ));
    if (!definition) {
      throw new ApiError(
        409,
        "WORKFLOW_NODE_DEFINITION_MISSING",
        `Workflow definition '${node.definitionId}' is missing from the run graph`,
      );
    }
    const [task, workspace, catalog] = await Promise.all([
      this.businessStore.getTask(snapshot.run.taskId),
      this.resolveWorkspace(snapshot.run.projectId),
      this.getCatalog(snapshot.run.projectId),
    ]);
    if (!task) {
      throw new ApiError(404, "TASK_NOT_FOUND", `Task '${snapshot.run.taskId}' does not exist`);
    }

    const templateRevision = this.store.getTemplateRevision(snapshot.run.templateRevisionId);
    const templateNode = templateRevision?.sourceSnapshot?.snapshot?.nodes?.find((candidate) => (
      candidate?.id === definition.id
    ));
    const recommendation = ROLE_RECOMMENDATIONS[definition.config.rolePreset] ?? {};
    const model = templateNode?.data?.runtimeModel
      || definition.config.model
      || recommendation.model
      || snapshot.effectiveGraph.defaults.model;
    const catalogModel = catalog.models.find((candidate) => candidate.slug === model);
    if (!catalogModel) {
      throw new ApiError(400, "INVALID_MODEL", `Unknown model '${model}'`);
    }
    const effort = templateNode?.data?.runtimeEffort
      || definition.config.effort
      || recommendation.effort
      || snapshot.effectiveGraph.defaults.effort
      || catalogModel.defaultReasoningEffort;
    if (!catalogModel.supportedReasoningEfforts.includes(effort)) {
      throw new ApiError(
        400,
        "INVALID_REASONING_EFFORT",
        `Reasoning effort '${effort}' is not supported by model '${model}'`,
      );
    }

    const predecessors = [];
    const references = [];
    for (const dependency of definition.dependsOn) {
      const predecessor = snapshot.nodes.find((candidate) => (
        candidate.definitionId === dependency.nodeId
      ));
      const predecessorDefinition = snapshot.effectiveGraph.nodes.find((candidate) => (
        candidate.id === dependency.nodeId
      ));
      const predecessorAttempt = snapshot.attempts.find((candidate) => (
        candidate.id === predecessor?.activeAttemptId
      ));
      const eventIds = snapshot.events
        .filter((event) => event.nodeRunId === predecessor?.id)
        .map((event) => event.id);
      const result = predecessor?.result ?? {};
      const predecessorPayload = {
        nodeId: predecessorDefinition?.id ?? dependency.nodeId,
        summary: result.summary ?? "",
        conclusions: result.conclusions ?? [],
        changedFiles: result.changedFiles ?? [],
        artifacts: result.artifacts ?? [],
        verification: result.verification ?? [],
        unresolved: result.unresolved ?? [],
        risks: result.risks ?? [],
      };
      const reference = {
        runId: snapshot.run.id,
        nodeRunId: predecessor.id,
        attemptId: predecessorAttempt?.id ?? null,
        threadId: predecessorAttempt?.threadId ?? null,
        eventIds,
        planningPath: snapshot.run.planningPath,
      };
      this.store.createHandoff({
        runId: snapshot.run.id,
        predecessorNodeRunId: predecessor.id,
        successorNodeRunId: node.id,
        payload: { ...predecessorPayload, reference },
      });
      predecessors.push(predecessorPayload);
      references.push(reference);
    }

    const handoff = {
      primaryIssue: {
        id: task.id,
        identifier: task.identifier,
        title: task.title,
        description: task.description,
        status: task.status,
      },
      workflowGoal: snapshot.effectiveGraph.goal,
      node: {
        id: definition.id,
        title: definition.title,
        objective: definition.objective,
        rolePreset: definition.config.rolePreset,
      },
      predecessors,
      references,
    };
    const prompt = [
      "Execute this bounded formal workflow node from the structured handoff below.",
      "Do not invoke interactive user-input, approval, permission, or MCP elicitation tools. Return unresolved questions in the result envelope.",
      "Read original Chats, changed files, artifacts, and references[].planningPath only on demand. The shared planning projection is read-only; initialize and use your own task-isolated planning-with-files session.",
      "Do not assume predecessor transcripts were provided. Return only one JSON result matching the required schema, including planningDirectory.",
      JSON.stringify(handoff),
    ].join("\n\n");
    return {
      workspacePath: workspace.workspacePath,
      model,
      effort,
      sandbox: SANDBOX_MODES[definition.config.sandbox],
      prompt,
    };
  }

  async #executeIssueAction({ run, node }) {
    const primitiveTurnId = `primitive:${randomUUID()}`;
    const attempt = this.store.startAttempt({
      nodeRunId: node.id,
      owner: this.orchestratorId,
      turnId: primitiveTurnId,
    });
    let event = this.#recordEvent(run, node, attempt, "workflow.issue-action.started", {
      action: node.config.action,
      status: node.config.status,
      idempotencyKey: attempt.idempotencyKey,
    });
    this.#emitEvent(run, event);
    try {
      let outcome;
      try {
        outcome = await this.businessStore.setTaskStatus(
          run.taskId,
          node.config.status,
          undefined,
          attempt.idempotencyKey,
        );
      } catch (error) {
        if (error?.code !== "VERSION_CONFLICT") throw error;
        const current = await this.businessStore.getTask(run.taskId);
        if (current?.status !== node.config.status) throw error;
        outcome = { task: current, reconciled: true, idempotencyKey: attempt.idempotencyKey };
      }
      const result = {
        taskId: outcome.task.id,
        taskVersion: outcome.task.version,
        status: outcome.task.status,
        idempotencyKey: outcome.idempotencyKey,
        reconciled: outcome.reconciled,
      };
      this.store.finishTurn({
        attemptId: attempt.id,
        expectedTurnId: primitiveTurnId,
        status: "completed",
        candidateResult: result,
      });
      const updated = this.store.completeNodeIfBarrierSatisfied(node.id);
      event = this.#recordEvent(run, updated, attempt, "workflow.issue-action.completed", result);
      this.#emitNode(run, updated);
      this.#emitEvent(run, event);
      this.events.emit("task.updated", { task: outcome.task });
    } catch (error) {
      const failure = errorPayload(error);
      this.store.finishTurn({
        attemptId: attempt.id,
        expectedTurnId: primitiveTurnId,
        status: "failed",
        error: failure,
      });
      this.store.releaseNodeResources(node.id, this.orchestratorId);
      const updated = this.store.transitionNode(
        node.id,
        ["running"],
        error?.code === "VERSION_CONFLICT" || error?.code === "WORKFLOW_ACTION_RECOVERY_REQUIRED"
          ? "recovery_required"
          : "failed",
        { result: { ...failure, idempotencyKey: attempt.idempotencyKey } },
      );
      event = this.#recordEvent(run, updated, attempt, `workflow.node.${updated.status}`, {
        ...failure,
        idempotencyKey: attempt.idempotencyKey,
      });
      this.#emitNode(run, updated);
      this.#emitEvent(run, event);
    }
  }

  async #failClaimedNode(run, claimedNode, error) {
    const context = this.#nodeContext(claimedNode.id);
    if (context.node.status === "running" && context.node.activeAttemptId !== null) {
      const snapshot = this.store.getRunSnapshot(run.id);
      const attempt = snapshot.attempts.find((candidate) => (
        candidate.id === context.node.activeAttemptId && candidate.status === "running"
      ));
      if (!attempt) return;
      const settled = this.store.settleAttemptFailure({
        attemptId: attempt.id,
        attemptStatus: "recovery_required",
        nodeStatus: "recovery_required",
        error: errorPayload(error),
        retainResources: true,
      });
      const event = this.#recordEvent(
        run,
        settled.node,
        settled.attempt,
        "workflow.node.recovery_required",
        errorPayload(error),
      );
      this.#emitNode(run, settled.node);
      this.#emitEvent(run, event);
      return;
    }
    if (context.node.status !== "ready") return;
    this.store.releaseNodeResources(context.node.id, this.orchestratorId);
    const node = this.store.transitionNode(
      context.node.id,
      ["ready"],
      "failed",
      { result: errorPayload(error) },
    );
    const event = this.#recordEvent(run, node, null, "workflow.node.failed", errorPayload(error));
    this.#emitNode(run, node);
    this.#emitEvent(run, event);
  }

  async #pauseFailFastRun(snapshot) {
    let run = snapshot.run;
    if (run.status !== "paused") {
      run = this.store.transitionRun(run.id, [run.status], "paused");
      const event = this.#recordEvent(run, null, null, "workflow.run.paused", {
        reason: "fail_fast",
      });
      this.#emitRun(run);
      this.#emitEvent(run, event);
    }

    const requestedTurns = new Set(
      snapshot.events
        .filter((event) => event.type === "workflow.codex.turn.interrupt_requested")
        .map((event) => event.data?.turnId)
        .filter(Boolean),
    );
    for (const attempt of snapshot.attempts) {
      if (
        attempt.status !== "running"
        || !attempt.threadId
        || !attempt.turnId
        || requestedTurns.has(attempt.turnId)
      ) continue;
      try {
        await this.codex.interruptTurn(attempt.threadId, attempt.turnId);
        const node = snapshot.nodes.find((candidate) => candidate.id === attempt.nodeRunId);
        const event = this.#recordEvent(
          run,
          node,
          attempt,
          "workflow.codex.turn.interrupt_requested",
          { threadId: attempt.threadId, turnId: attempt.turnId, reason: "fail_fast" },
        );
        this.#emitEvent(run, event);
      } catch {}
    }
  }

  async #recomputeRun(snapshot) {
    const hasFailure = snapshot.nodes.some((node) => FAILURE_NODE_STATUSES.has(node.status));
    const hasActive = snapshot.nodes.some((node) => ACTIVE_NODE_STATUSES.has(node.status));
    let nextStatus = snapshot.run.status;
    const requiresRecovery = snapshot.nodes.some((node) => (
      node.status === "recovery_required" || node.status === "migration_required"
    ));
    if (requiresRecovery) nextStatus = "paused";
    else if (!hasActive) nextStatus = hasFailure ? "failed" : "completed";
    else if (hasFailure) {
      const descendants = failureDescendants(snapshot.effectiveGraph, snapshot.nodes);
      const hasIndependentWork = snapshot.nodes.some((node) => (
        ACTIVE_NODE_STATUSES.has(node.status) && !descendants.has(node.definitionId)
      ));
      nextStatus = snapshot.run.failFast || !hasIndependentWork ? "paused" : "running";
    }
    else if (snapshot.run.status === "queued" && snapshot.nodes.some((node) => (
      node.status === "running" || node.status === "awaiting_confirmation" || node.leaseOwner !== null
    ))) nextStatus = "running";
    if (nextStatus === snapshot.run.status) return;
    const run = this.store.transitionRun(snapshot.run.id, [snapshot.run.status], nextStatus);
    const event = this.#recordEvent(run, null, null, `workflow.run.${nextStatus}`, { status: nextStatus });
    this.#emitRun(run);
    this.#emitEvent(run, event);
    if (nextStatus === "running") this.dirty = true;
  }

  #nodeContext(nodeRunId) {
    const row = this.store.database.prepare(
      "SELECT run_id FROM workflow_node_runs WHERE id = ?",
    ).get(nodeRunId);
    if (!row) {
      throw new ApiError(404, "WORKFLOW_NODE_NOT_FOUND", `Workflow node run '${nodeRunId}' does not exist`);
    }
    const snapshot = this.getRunSnapshot(row.run_id);
    return {
      run: snapshot.run,
      node: snapshot.nodes.find((candidate) => candidate.id === nodeRunId),
    };
  }

  #recordEvent(run, node, attempt, type, data) {
    return this.store.appendEvent({
      runId: run.id,
      nodeRunId: node?.id ?? null,
      attemptId: attempt?.id ?? null,
      type,
      data,
    });
  }

  #emitRun(run) {
    this.events.emit("workflow.run.updated", {
      projectId: run.projectId,
      taskId: run.taskId,
      runId: run.id,
      run,
    });
  }

  #emitNode(run, node) {
    this.events.emit("workflow.node.updated", {
      projectId: run.projectId,
      taskId: run.taskId,
      runId: run.id,
      nodeRunId: node.id,
      node,
    });
  }

  #emitEvent(run, event) {
    this.events.emit("workflow.event.created", {
      projectId: run.projectId,
      taskId: run.taskId,
      runId: run.id,
      nodeRunId: event.nodeRunId,
      event,
    });
  }

  #heartbeat() {
    if (this.closed || !this.connected) return;
    for (const run of this.store.listNonterminalRuns()) {
      if (run.status !== "running") continue;
      const snapshot = this.store.getRunSnapshot(run.id);
      for (const node of snapshot.nodes) {
        if (node.status !== "running" || node.leaseOwner !== this.orchestratorId) continue;
        try {
          this.store.renewNodeLease({
            nodeRunId: node.id,
            owner: this.orchestratorId,
            leaseMs: this.leaseMs,
          });
        } catch {}
      }
    }
  }

  #scheduleReconnect() {
    if (this.closed || this.reconnectTimer || this.store.listNonterminalRuns().length === 0) return;
    const delay = Math.min(1000 * (2 ** this.reconnectAttempt), MAX_RECONNECT_MS);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.codex.start();
        this.connected = true;
        this.reconnectAttempt = 0;
        this.recovering = true;
        try {
          await this.#queueRecoveryReconciliation();
        } finally {
          this.recovering = false;
        }
        await this.wake("codex-reconnected");
      } catch {
        this.#scheduleReconnect();
      }
    }, delay);
    this.reconnectTimer.unref?.();
  }
}
