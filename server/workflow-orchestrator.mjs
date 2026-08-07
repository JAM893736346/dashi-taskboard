import { randomUUID } from "node:crypto";

import {
  assertWorkflowRuntimeGraph,
  evaluateWorkflowCondition,
  settleWorkflowDependencies,
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

function errorPayload(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "WORKFLOW_EXECUTOR_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

function amendmentNode(amendment) {
  return amendment.patch?.node ?? amendment.patch?.addNode ?? amendment.patch;
}

function effectiveGraph(snapshot) {
  const nodes = snapshot.amendments
    .filter((amendment) => amendment.status === "applied")
    .map(amendmentNode);
  return assertWorkflowRuntimeGraph({
    ...snapshot.run.graphSnapshot,
    nodes: [...snapshot.run.graphSnapshot.nodes, ...nodes],
  });
}

function executeCodexThread() {
  const error = new Error("Codex thread execution is not available until Task 6");
  error.code = "CODEX_EXECUTOR_NOT_READY";
  throw error;
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
    this.executors = {
      "human-gate": (context) => this.#executeHumanGate(context),
      condition: (context) => this.#executeCondition(context),
      "issue-action": (context) => this.#executeIssueAction(context),
      "codex-thread": executeCodexThread,
    };
  }

  async start() {
    if (this.closed) throw new Error("Workflow orchestrator is closed");
    if (this.started) return this;
    await this.codex.start();
    this.connected = true;
    this.unsubscribeCodex = this.codex.subscribe((notification) => {
      if (notification.method !== "client/closed" || this.closed) return;
      this.connected = false;
      this.#scheduleReconnect();
    });
    this.started = true;
    this.heartbeatTimer = setInterval(() => this.#heartbeat(), this.heartbeatMs);
    this.heartbeatTimer.unref?.();
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
    this.unsubscribeCodex?.();
    this.unsubscribeCodex = null;
    await this.codex.close();
  }

  wake(reason) {
    if (this.closed) return Promise.resolve();
    this.wakeReasons.add(reason);
    this.dirty = true;
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
    let snapshot = this.getRunSnapshot(runId);
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

  async #recomputeRun(snapshot) {
    const hasFailure = snapshot.nodes.some((node) => FAILURE_NODE_STATUSES.has(node.status));
    const hasActive = snapshot.nodes.some((node) => ACTIVE_NODE_STATUSES.has(node.status));
    let nextStatus = snapshot.run.status;
    if (!hasActive) nextStatus = hasFailure ? "failed" : "completed";
    else if (hasFailure) nextStatus = "paused";
    else if (snapshot.run.status === "queued" && snapshot.nodes.some((node) => (
      node.status === "running" || node.status === "awaiting_confirmation" || node.leaseOwner !== null
    ))) nextStatus = "running";
    if (nextStatus === snapshot.run.status) return;
    const run = this.store.transitionRun(snapshot.run.id, [snapshot.run.status], nextStatus);
    const event = this.#recordEvent(run, null, null, `workflow.run.${nextStatus}`, { status: nextStatus });
    this.#emitRun(run);
    this.#emitEvent(run, event);
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
    for (const nodeRunId of this.activeExecutions.keys()) {
      try {
        const { node } = this.#nodeContext(nodeRunId);
        if (node.status === "running" && node.leaseOwner === this.orchestratorId) {
          this.store.renewNodeLease({
            nodeRunId,
            owner: this.orchestratorId,
            leaseMs: this.leaseMs,
          });
        }
      } catch {}
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
        await this.wake("codex-reconnected");
      } catch {
        this.#scheduleReconnect();
      }
    }, delay);
    this.reconnectTimer.unref?.();
  }
}
