import { createHash } from "node:crypto";

import { TASK_STATUSES } from "../shared/domain.mjs";
import { normalizeWorkflowSnapshot } from "../shared/workflow-control-flow.mjs";
import {
  WORKFLOW_EXECUTOR_VERSIONS,
  WORKFLOW_GRAPH_SCHEMA_VERSION,
  WORKFLOW_PRIMITIVES,
  validateWorkflowRuntimeGraph,
} from "../shared/workflow-runtime.mjs";
import { ApiError } from "./database.mjs";

const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;
const PLANNER_RULE = `Return only the schema-constrained runtime graph. The template is a constrained skeleton:
you may configure, insert, remove, reorder, or add condition branches, but you may not add
unknown primitives, cycles, external waits, Feishu nodes, or cross-Chat steer edges.
Every condition config.sourceNodeId must also appear directly in that node's dependsOn array.`;

const NULLABLE_STRING_SCHEMA = {
  anyOf: [{ type: "string" }, { type: "null" }],
};

const DEPENDENCY_OUTPUT_SCHEMA = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: { nodeId: { type: "string", minLength: 1 } },
      required: ["nodeId"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        nodeId: { type: "string", minLength: 1 },
        outcome: { type: "string", enum: ["true", "false"] },
      },
      required: ["nodeId", "outcome"],
    },
  ],
};

const RESOURCE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    key: { type: "string", minLength: 1 },
    mode: { type: "string", enum: ["shared", "exclusive"] },
  },
  required: ["key", "mode"],
};

const NODE_CONFIG_OUTPUT_SCHEMAS = {
  "codex-thread": {
    type: "object",
    additionalProperties: false,
    properties: {
      rolePreset: { type: "string", minLength: 1 },
      model: NULLABLE_STRING_SCHEMA,
      effort: NULLABLE_STRING_SCHEMA,
      sandbox: { type: "string", enum: ["readOnly", "workspaceWrite", "dangerFullAccess"] },
      outputSchema: { type: "null" },
    },
    required: ["rolePreset", "model", "effort", "sandbox", "outputSchema"],
  },
  "human-gate": {
    type: "object",
    additionalProperties: false,
    properties: { message: { type: "string", minLength: 1 } },
    required: ["message"],
  },
  condition: {
    type: "object",
    additionalProperties: false,
    properties: {
      sourceNodeId: { type: "string", minLength: 1 },
      field: { type: "string", minLength: 1 },
      operator: {
        type: "string",
        enum: ["equals", "not-equals", "contains", "not-contains"],
      },
      value: {
        anyOf: [
          { type: "string" },
          { type: "number" },
          { type: "boolean" },
          { type: "null" },
        ],
      },
    },
    required: ["sourceNodeId", "field", "operator", "value"],
  },
  "issue-action": {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["set-status"] },
      status: { type: "string", enum: TASK_STATUSES },
    },
    required: ["action", "status"],
  },
};

function workflowNodeOutputSchema(type) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string", minLength: 1 },
      type: { type: "string", enum: [type] },
      executorVersion: { type: "integer", enum: [WORKFLOW_EXECUTOR_VERSIONS[type]] },
      title: { type: "string", minLength: 1 },
      objective: { type: "string", minLength: 1 },
      dependsOn: { type: "array", items: DEPENDENCY_OUTPUT_SCHEMA },
      approvalMode: { type: "string", enum: ["automatic", "manual"] },
      config: NODE_CONFIG_OUTPUT_SCHEMAS[type],
      resources: { type: "array", items: RESOURCE_OUTPUT_SCHEMA },
    },
    required: [
      "id",
      "type",
      "executorVersion",
      "title",
      "objective",
      "dependsOn",
      "approvalMode",
      "config",
      "resources",
    ],
  };
}

export const WORKFLOW_RUNTIME_GRAPH_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { type: "integer", enum: [WORKFLOW_GRAPH_SCHEMA_VERSION] },
    goal: { type: "string", minLength: 1 },
    defaults: {
      type: "object",
      additionalProperties: false,
      properties: {
        model: { type: "string", minLength: 1 },
        effort: { type: "string", minLength: 1 },
        concurrencyLimit: { type: "integer", minimum: 1, maximum: 16 },
        failFast: { type: "boolean" },
      },
      required: ["model", "effort", "concurrencyLimit", "failFast"],
    },
    nodes: {
      type: "array",
      maxItems: 200,
      items: { anyOf: WORKFLOW_PRIMITIVES.map(workflowNodeOutputSchema) },
    },
  },
  required: ["schemaVersion", "goal", "defaults", "nodes"],
};

export const WORKFLOW_REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["pass", "revise"] },
    summary: { type: "string", minLength: 1 },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          severity: { type: "string", minLength: 1 },
          nodeId: NULLABLE_STRING_SCHEMA,
          message: { type: "string", minLength: 1 },
        },
        required: ["severity", "nodeId", "message"],
      },
    },
  },
  required: ["verdict", "summary", "findings"],
};

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function revisionFailureReport(stage, error) {
  return {
    stage,
    summary: error instanceof Error ? error.message : String(error),
    findings: [],
  };
}

function normalizeReviewReport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Reviewer returned an invalid report");
  }
  if (!new Set(["pass", "revise"]).has(value.verdict)) {
    throw new Error("Reviewer returned an invalid verdict");
  }
  if (typeof value.summary !== "string" || !value.summary.trim()) {
    throw new Error("Reviewer returned an empty summary");
  }
  if (!Array.isArray(value.findings)) {
    throw new Error("Reviewer returned invalid findings");
  }
  const findings = value.findings.map((finding) => {
    if (
      !finding
      || typeof finding !== "object"
      || Array.isArray(finding)
      || typeof finding.severity !== "string"
      || !finding.severity.trim()
      || (finding.nodeId !== null && typeof finding.nodeId !== "string")
      || typeof finding.message !== "string"
      || !finding.message.trim()
    ) {
      throw new Error("Reviewer returned an invalid finding");
    }
    return {
      severity: finding.severity.trim(),
      nodeId: finding.nodeId,
      message: finding.message.trim(),
    };
  });
  return { verdict: value.verdict, summary: value.summary.trim(), findings };
}

function selectTemplate(workflow, templateId) {
  const workspace = workflow?.workspace;
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) {
    throw new ApiError(409, "WORKFLOW_TEMPLATE_UNAVAILABLE", "This project has no workflow templates");
  }
  const tab = workspace.tabs?.find((candidate) => candidate?.id === templateId);
  if (!tab) {
    throw new ApiError(404, "WORKFLOW_TEMPLATE_NOT_FOUND", `Workflow template '${templateId}' does not exist`);
  }
  const rawSnapshot = workspace.snapshots?.[templateId];
  let snapshot;
  try {
    snapshot = normalizeWorkflowSnapshot(rawSnapshot);
  } catch (error) {
    throw new ApiError(
      409,
      "WORKFLOW_TEMPLATE_INVALID",
      error instanceof Error ? error.message : "Workflow template is invalid",
    );
  }
  const issueTriggers = snapshot.nodes.filter((node) => node?.data?.kind === "issue-trigger");
  const firstItem = snapshot.flow?.root?.items?.[0];
  if (
    issueTriggers.length !== 1
    || firstItem?.type !== "step"
    || firstItem.nodeId !== issueTriggers[0].id
  ) {
    throw new ApiError(
      409,
      "WORKFLOW_TEMPLATE_INVALID_TRIGGER",
      "Workflow template must contain exactly one root-first Issue trigger",
    );
  }
  const runtimeNodes = snapshot.nodes.filter((node) => node.id !== issueTriggers[0].id);
  const allowed = new Set(WORKFLOW_PRIMITIVES);
  if (
    runtimeNodes.length === 0
    || runtimeNodes.some((node) => !allowed.has(node?.data?.runtimePrimitive))
  ) {
    throw new ApiError(
      409,
      "WORKFLOW_TEMPLATE_NOT_EXECUTABLE",
      "Every non-trigger template node must configure a supported runtime primitive",
    );
  }
  const allowedPrimitives = [...new Set(runtimeNodes.map((node) => node.data.runtimePrimitive))];
  return {
    tab: { id: tab.id, name: tab.name },
    snapshot,
    allowedPrimitives,
    configuredModels: runtimeNodes
      .map((node) => node.data.runtimeModel)
      .filter((model) => typeof model === "string" && model.trim()),
    configuredEfforts: runtimeNodes
      .map((node) => node.data.runtimeEffort)
      .filter((effort) => typeof effort === "string" && effort.trim()),
  };
}

function plannerPrompt({ task, templateRevision, selectedTemplate, catalog }) {
  return [
    "Build a runtime workflow graph for this Issue from the immutable constrained template.",
    PLANNER_RULE,
    "The Issue trigger is ownership metadata and must not appear as a runtime node.",
    "Use only the listed primitives and executor versions. Return the final JSON object only.",
    stableJson({
      issue: {
        id: task.id,
        identifier: task.identifier,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
      },
      immutableTemplateRevision: templateRevision,
      selectedTemplate: selectedTemplate.snapshot,
      allowedPrimitives: selectedTemplate.allowedPrimitives,
      availableModels: catalog.models,
      executorVersions: WORKFLOW_EXECUTOR_VERSIONS,
      graphLimits: { maxNodes: 200, concurrencyLimit: { minimum: 1, maximum: 16 } },
    }),
  ].join("\n\n");
}

function reviewerPrompt({ task, templateRevision, selectedTemplate, graph }) {
  return [
    "Independently review the generated runtime graph. Do not edit it.",
    "Check Issue-goal alignment, omissions, dependency correctness, allowed primitive use, and risk.",
    "Return only a report matching the required JSON schema.",
    'A passing example is {"verdict":"pass","summary":"The graph covers the required work.","findings":[]}.',
    stableJson({
      issue: {
        id: task.id,
        identifier: task.identifier,
        title: task.title,
        description: task.description,
        status: task.status,
      },
      immutableTemplateRevision: templateRevision,
      templateConstraints: {
        allowedPrimitives: selectedTemplate.allowedPrimitives,
        snapshot: selectedTemplate.snapshot,
      },
      runtimeGraph: graph,
    }),
  ].join("\n\n");
}

export function runStructuredTurn({
  client,
  threadId,
  prompt,
  outputSchema,
  turnOptions = {},
  timeoutMs = DEFAULT_TURN_TIMEOUT_MS,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let boundTurnId = null;
    const buffered = [];
    const items = [];

    const unsubscribe = client.subscribe((notification) => {
      if (settled) return;
      if (notification.method === "client/closed") {
        settleReject(notification.params?.error ?? new Error("Codex App Server connection closed"));
        return;
      }
      if (notification.params?.threadId !== threadId) return;
      if (!boundTurnId) {
        buffered.push(notification);
        return;
      }
      handle(notification);
    });
    const timeout = setTimeout(() => {
      settleReject(new Error(`Timed out waiting for structured turn in thread '${threadId}'`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      unsubscribe();
    }

    function settleReject(error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    }

    function settleCompleted() {
      if (settled) return;
      const agentMessages = items.filter((item) => item?.type === "agentMessage");
      if (agentMessages.length === 0) {
        settleReject(new Error("Structured turn completed without an agent message"));
        return;
      }
      let value;
      try {
        value = JSON.parse(agentMessages.at(-1).text);
      } catch (error) {
        settleReject(error);
        return;
      }
      settled = true;
      cleanup();
      resolve({ turnId: boundTurnId, value, items });
    }

    function handle(notification) {
      const params = notification.params ?? {};
      const notificationTurnId = params.turnId ?? params.turn?.id;
      if (notificationTurnId !== boundTurnId) return;
      if (notification.method === "item/completed") {
        items.push(params.item);
        return;
      }
      if (notification.method === "turn/failed") {
        settleReject(new Error(`Codex turn '${boundTurnId}' failed`));
        return;
      }
      if (notification.method !== "turn/completed") return;
      if (params.turn?.status === "completed") {
        settleCompleted();
      } else {
        settleReject(new Error(
          `Codex turn '${boundTurnId}' ended with status '${params.turn?.status ?? "unknown"}'`,
        ));
      }
    }

    client.startTurn(threadId, {
      input: [{ type: "text", text: prompt }],
      outputSchema,
      ...turnOptions,
    }).then((result) => {
      if (settled) return;
      if (typeof result?.turn?.id !== "string" || !result.turn.id) {
        settleReject(new Error("Codex returned an invalid turn start response"));
        return;
      }
      boundTurnId = result.turn.id;
      for (const notification of buffered) handle(notification);
      buffered.length = 0;
    }, settleReject);
  });
}

export class WorkflowReviewService {
  constructor({
    store,
    businessStore,
    codex,
    resolveWorkspace,
    getCatalog,
    events,
    turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  }) {
    this.store = store;
    this.businessStore = businessStore;
    this.codex = codex;
    this.resolveWorkspace = resolveWorkspace;
    this.getCatalog = getCatalog;
    this.events = events;
    this.turnTimeoutMs = turnTimeoutMs;
    this.jobs = new Set();
    this.closed = false;
  }

  async generateAndReview({ taskId, templateId }) {
    if (this.closed) throw new Error("Workflow review service is closed");
    const task = await this.businessStore.getTask(taskId);
    if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
    const workflow = await this.businessStore.getTemplateWorkspace(task.projectId);
    const selectedTemplate = selectTemplate(workflow, templateId);
    const immutableSource = {
      tab: selectedTemplate.tab,
      snapshot: selectedTemplate.snapshot,
    };
    const templateRevision = this.store.snapshotTemplate({
      projectId: task.projectId,
      templateId,
      name: selectedTemplate.tab.name,
      sourceHash: createHash("sha256").update(stableJson(immutableSource)).digest("hex"),
      workspaceVersion: workflow.version,
      templateSnapshot: immutableSource,
    });
    const revision = this.store.createRevision({
      taskId: task.id,
      projectId: task.projectId,
      templateRevisionId: templateRevision.id,
      graphSnapshot: null,
      status: "reviewing",
    });
    const job = this.#complete({ task, revision, templateRevision, selectedTemplate })
      .catch((error) => this.#markDraft(revision.id, "generation", error))
      .finally(() => this.jobs.delete(job));
    this.jobs.add(job);
    return revision;
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
    return {
      templates,
      revisions,
      activeRun: this.store.getActiveRunForTask(task.id),
    };
  }

  async close() {
    this.closed = true;
    await Promise.allSettled([...this.jobs]);
    await this.codex.close();
  }

  async #complete({ task, revision, templateRevision, selectedTemplate }) {
    const [{ workspacePath }, catalog] = await Promise.all([
      this.resolveWorkspace(task.projectId),
      this.getCatalog(task.projectId),
      this.codex.start(),
    ]);
    const configuredModel = selectedTemplate.configuredModels.find((slug) => (
      catalog.models.some((model) => model.slug === slug)
    ));
    const model = configuredModel ?? catalog.models[0]?.slug;
    if (!model) throw new ApiError(503, "AI_MODEL_UNAVAILABLE", "Codex did not provide an available model");
    const effort = selectedTemplate.configuredEfforts[0]
      ?? catalog.models.find((candidate) => candidate.slug === model)?.defaultReasoningEffort
      ?? undefined;
    const threadOptions = {
      cwd: workspacePath,
      approvalPolicy: "never",
      sandbox: "read-only",
      model,
    };

    const planner = await this.codex.startThread({
      ...threadOptions,
      serviceName: "codex-taskboard-workflow-planner",
    });
    revision = this.store.updateRevision(revision.id, revision.version, {
      plannerThreadId: planner.thread.id,
    });
    const planned = await runStructuredTurn({
      client: this.codex,
      threadId: planner.thread.id,
      prompt: plannerPrompt({ task, templateRevision, selectedTemplate, catalog }),
      outputSchema: WORKFLOW_RUNTIME_GRAPH_OUTPUT_SCHEMA,
      turnOptions: effort ? { effort } : {},
      timeoutMs: this.turnTimeoutMs,
    });
    const validation = validateWorkflowRuntimeGraph(planned.value, {
      allowedPrimitives: selectedTemplate.allowedPrimitives,
    });
    revision = this.store.updateRevision(revision.id, revision.version, {
      graphSnapshot: planned.value,
      graphSchemaVersion: planned.value?.schemaVersion ?? null,
      validationErrors: validation.errors,
      plannerThreadId: planner.thread.id,
      ...(validation.valid ? {} : {
        status: "draft",
        reviewReport: {
          stage: "validation",
          summary: "Deterministic runtime graph validation failed",
          findings: validation.errors,
        },
      }),
    });
    if (!validation.valid) {
      this.#emitRevision(task, revision);
      return revision;
    }

    const reviewer = await this.codex.startThread({
      ...threadOptions,
      serviceName: "codex-taskboard-workflow-reviewer",
    });
    revision = this.store.updateRevision(revision.id, revision.version, {
      reviewerThreadId: reviewer.thread.id,
    });
    const reviewed = await runStructuredTurn({
      client: this.codex,
      threadId: reviewer.thread.id,
      prompt: reviewerPrompt({
        task,
        templateRevision,
        selectedTemplate,
        graph: planned.value,
      }),
      outputSchema: WORKFLOW_REVIEW_OUTPUT_SCHEMA,
      turnOptions: effort ? { effort } : {},
      timeoutMs: this.turnTimeoutMs,
    });
    const report = normalizeReviewReport(reviewed.value);
    revision = this.store.updateRevision(revision.id, revision.version, {
      status: report.verdict === "pass" ? "ready" : "draft",
      reviewerThreadId: reviewer.thread.id,
      reviewReport: report,
    });
    this.#emitRevision(task, revision);
    return revision;
  }

  async #markDraft(revisionId, stage, error) {
    const current = this.store.getRevision(revisionId);
    if (!current || current.status !== "reviewing") return current;
    const revision = this.store.updateRevision(current.id, current.version, {
      status: "draft",
      reviewReport: revisionFailureReport(stage, error),
    });
    this.#emitRevision({ id: revision.taskId, projectId: revision.projectId }, revision);
    return revision;
  }

  #emitRevision(task, revision) {
    this.events?.emit("workflow.revision.updated", {
      projectId: task.projectId,
      taskId: task.id,
      revisionId: revision.id,
    });
  }
}
