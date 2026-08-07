import { isTaskStatus } from "./domain.mjs";

export const WORKFLOW_GRAPH_SCHEMA_VERSION = 1;
export const WORKFLOW_EXECUTOR_VERSIONS = Object.freeze({
  "codex-thread": 1,
  "human-gate": 1,
  condition: 1,
  "issue-action": 1,
});
export const WORKFLOW_PRIMITIVES = Object.freeze(Object.keys(WORKFLOW_EXECUTOR_VERSIONS));
export const WORKFLOW_RUN_STATUSES = Object.freeze([
  "queued",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
export const WORKFLOW_NODE_STATUSES = Object.freeze([
  "blocked",
  "ready",
  "running",
  "awaiting_confirmation",
  "succeeded",
  "rejected",
  "failed",
  "interrupted",
  "recovery_required",
  "migration_required",
  "cancelled",
]);

const ROOT_KEYS = new Set(["schemaVersion", "goal", "defaults", "nodes"]);
const DEFAULT_KEYS = new Set(["model", "effort", "concurrencyLimit", "failFast"]);
const NODE_KEYS = new Set([
  "id",
  "type",
  "executorVersion",
  "title",
  "objective",
  "dependsOn",
  "approvalMode",
  "config",
  "resources",
]);
const DEPENDENCY_KEYS = new Set(["nodeId", "outcome"]);
const RESOURCE_KEYS = new Set(["key", "mode"]);
const CONFIG_KEYS = Object.freeze({
  "codex-thread": new Set(["rolePreset", "model", "effort", "sandbox", "outputSchema"]),
  "human-gate": new Set(["message"]),
  condition: new Set(["sourceNodeId", "field", "operator", "value"]),
  "issue-action": new Set(["action", "status"]),
});
const APPROVAL_MODES = new Set(["automatic", "manual"]);
const RESOURCE_MODES = new Set(["shared", "exclusive"]);
const DEPENDENCY_OUTCOMES = new Set(["true", "false"]);
const SANDBOXES = new Set(["readOnly", "workspaceWrite", "dangerFullAccess"]);
const CONDITION_OPERATORS = new Set(["equals", "not-equals", "contains", "not-contains"]);

const STRING_ARRAY_SCHEMA = Object.freeze({
  type: "array",
  items: Object.freeze({ type: "string" }),
});

export const WORKFLOW_NODE_RESULT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: Object.freeze({
    summary: Object.freeze({ type: "string" }),
    conclusions: STRING_ARRAY_SCHEMA,
    changedFiles: STRING_ARRAY_SCHEMA,
    artifacts: STRING_ARRAY_SCHEMA,
    verification: STRING_ARRAY_SCHEMA,
    unresolved: STRING_ARRAY_SCHEMA,
    risks: STRING_ARRAY_SCHEMA,
    planningDirectory: Object.freeze({ type: "string" }),
  }),
  required: Object.freeze([
    "summary",
    "conclusions",
    "changedFiles",
    "artifacts",
    "verification",
    "unresolved",
    "risks",
  ]),
});

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value, ancestors = new Set()) {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (typeof value !== "object" || value === null || ancestors.has(value)) return false;
  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry, nextAncestors));
  }
  return isPlainObject(value)
    && Object.values(value).every((entry) => isJsonValue(entry, nextAncestors));
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function addError(errors, path, code, message) {
  errors.push({ path, code, message });
}

function rejectUnknownKeys(errors, value, allowedKeys, path) {
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      addError(
        errors,
        path ? `${path}.${key}` : key,
        "UNKNOWN_KEY",
        `Unknown field '${key}'`,
      );
    }
  }
}

function requireString(errors, value, path, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || value.trim() === "") {
    addError(errors, path, "INVALID_STRING", `${path} must be a non-empty string`);
  }
}

function allowedSet(value, fallback) {
  if (value === undefined) return new Set(fallback);
  if (
    value !== null
    && typeof value !== "string"
    && typeof value[Symbol.iterator] === "function"
  ) {
    return new Set(value);
  }
  return new Set();
}

function validateCodexThreadConfig(errors, config, path) {
  requireString(errors, config.rolePreset, `${path}.rolePreset`);
  requireString(errors, config.model, `${path}.model`, { nullable: true });
  requireString(errors, config.effort, `${path}.effort`, { nullable: true });
  if (!SANDBOXES.has(config.sandbox)) {
    addError(
      errors,
      `${path}.sandbox`,
      "INVALID_SANDBOX",
      `${path}.sandbox must be readOnly, workspaceWrite, or dangerFullAccess`,
    );
  }
  if (
    config.outputSchema !== null
    && (!isPlainObject(config.outputSchema) || !isJsonValue(config.outputSchema))
  ) {
    addError(
      errors,
      `${path}.outputSchema`,
      "INVALID_OUTPUT_SCHEMA",
      `${path}.outputSchema must be a JSON object or null`,
    );
  }
}

function validateHumanGateConfig(errors, config, path) {
  requireString(errors, config.message, `${path}.message`);
}

function validateConditionConfig(errors, config, path) {
  requireString(errors, config.sourceNodeId, `${path}.sourceNodeId`);
  requireString(errors, config.field, `${path}.field`);
  if (!CONDITION_OPERATORS.has(config.operator)) {
    addError(
      errors,
      `${path}.operator`,
      "INVALID_CONDITION_OPERATOR",
      `${path}.operator must be equals, not-equals, contains, or not-contains`,
    );
  }
  if (!hasOwn(config, "value") || !isJsonValue(config.value)) {
    addError(
      errors,
      `${path}.value`,
      "INVALID_CONDITION_VALUE",
      `${path}.value must be a JSON value`,
    );
  }
}

function validateIssueActionConfig(errors, config, path) {
  if (config.action !== "set-status") {
    addError(
      errors,
      `${path}.action`,
      "INVALID_ISSUE_ACTION",
      `${path}.action must be set-status`,
    );
  }
  if (!isTaskStatus(config.status)) {
    addError(
      errors,
      `${path}.status`,
      "INVALID_TASK_STATUS",
      `${path}.status is not a supported Task status`,
    );
  }
}

function validatePrimitiveConfig(errors, node, index) {
  const path = `nodes[${index}].config`;
  if (!isPlainObject(node.config)) return;
  const keys = hasOwn(CONFIG_KEYS, node.type) ? CONFIG_KEYS[node.type] : null;
  if (!keys) return;
  rejectUnknownKeys(errors, node.config, keys, path);
  if (node.type === "codex-thread") validateCodexThreadConfig(errors, node.config, path);
  if (node.type === "human-gate") validateHumanGateConfig(errors, node.config, path);
  if (node.type === "condition") validateConditionConfig(errors, node.config, path);
  if (node.type === "issue-action") validateIssueActionConfig(errors, node.config, path);
}

export function validateWorkflowRuntimeGraph(value, options = {}) {
  const errors = [];

  // Phase 1: root shape and schema version.
  if (!isPlainObject(value)) {
    addError(errors, "", "INVALID_ROOT", "Workflow graph must be a plain object");
    return { valid: false, errors };
  }
  rejectUnknownKeys(errors, value, ROOT_KEYS, "");
  if (value.schemaVersion !== WORKFLOW_GRAPH_SCHEMA_VERSION) {
    addError(
      errors,
      "schemaVersion",
      "UNSUPPORTED_SCHEMA_VERSION",
      `schemaVersion must be ${WORKFLOW_GRAPH_SCHEMA_VERSION}`,
    );
  }

  // Phase 2: graph goal and defaults.
  requireString(errors, value.goal, "goal");
  if (!isPlainObject(value.defaults)) {
    addError(errors, "defaults", "INVALID_DEFAULTS", "defaults must be a plain object");
  } else {
    rejectUnknownKeys(errors, value.defaults, DEFAULT_KEYS, "defaults");
    requireString(errors, value.defaults.model, "defaults.model");
    requireString(errors, value.defaults.effort, "defaults.effort");
    if (
      !Number.isInteger(value.defaults.concurrencyLimit)
      || value.defaults.concurrencyLimit < 1
      || value.defaults.concurrencyLimit > 16
    ) {
      addError(
        errors,
        "defaults.concurrencyLimit",
        "INVALID_CONCURRENCY_LIMIT",
        "defaults.concurrencyLimit must be an integer from 1 through 16",
      );
    }
    if (typeof value.defaults.failFast !== "boolean") {
      addError(
        errors,
        "defaults.failFast",
        "INVALID_BOOLEAN",
        "defaults.failFast must be a boolean",
      );
    }
  }

  // Phase 3: common node fields and duplicate ids.
  const nodes = Array.isArray(value.nodes) ? value.nodes : [];
  if (!Array.isArray(value.nodes)) {
    addError(errors, "nodes", "INVALID_NODES", "nodes must be an array");
  } else if (nodes.length > 200) {
    addError(errors, "nodes", "TOO_MANY_NODES", "nodes must contain at most 200 entries");
  }
  const nodeIds = new Set();
  nodes.forEach((node, index) => {
    const path = `nodes[${index}]`;
    if (!isPlainObject(node)) {
      addError(errors, path, "INVALID_NODE", `${path} must be a plain object`);
      return;
    }
    rejectUnknownKeys(errors, node, NODE_KEYS, path);
    requireString(errors, node.id, `${path}.id`);
    requireString(errors, node.title, `${path}.title`);
    requireString(errors, node.objective, `${path}.objective`);
    if (!Array.isArray(node.dependsOn)) {
      addError(errors, `${path}.dependsOn`, "INVALID_DEPENDENCIES", `${path}.dependsOn must be an array`);
    }
    if (!APPROVAL_MODES.has(node.approvalMode)) {
      addError(
        errors,
        `${path}.approvalMode`,
        "INVALID_APPROVAL_MODE",
        `${path}.approvalMode must be automatic or manual`,
      );
    }
    if (!isPlainObject(node.config)) {
      addError(errors, `${path}.config`, "INVALID_CONFIG", `${path}.config must be a plain object`);
    }
    if (!Array.isArray(node.resources)) {
      addError(errors, `${path}.resources`, "INVALID_RESOURCES", `${path}.resources must be an array`);
    }
    if (typeof node.id === "string" && node.id.trim() !== "") {
      if (nodeIds.has(node.id)) {
        addError(errors, `${path}.id`, "DUPLICATE_NODE_ID", `Duplicate node id '${node.id}'`);
      }
      nodeIds.add(node.id);
    }
  });

  // Phase 4: exact versioned primitive configs.
  nodes.forEach((node, index) => {
    if (isPlainObject(node)) validatePrimitiveConfig(errors, node, index);
  });

  // Phase 5: primitive and executor allowlists.
  const allowedPrimitives = allowedSet(options.allowedPrimitives, WORKFLOW_PRIMITIVES);
  nodes.forEach((node, index) => {
    if (!isPlainObject(node)) return;
    const path = `nodes[${index}]`;
    if (!hasOwn(WORKFLOW_EXECUTOR_VERSIONS, node.type)) {
      addError(
        errors,
        `${path}.type`,
        "UNSUPPORTED_PRIMITIVE",
        `${path}.type must name a supported workflow primitive`,
      );
    } else {
      if (!allowedPrimitives.has(node.type)) {
        addError(
          errors,
          `${path}.type`,
          "PRIMITIVE_NOT_ALLOWED",
          `Workflow primitive '${node.type}' is not allowed`,
        );
      }
      if (node.executorVersion !== WORKFLOW_EXECUTOR_VERSIONS[node.type]) {
        addError(
          errors,
          `${path}.executorVersion`,
          "UNSUPPORTED_EXECUTOR_VERSION",
          `${path}.executorVersion is not supported for ${node.type}`,
        );
      }
    }
  });

  // Phase 6: resources, dependency references, and node allowlist.
  const allowedNodeIds = options.allowedNodeIds === undefined
    ? null
    : allowedSet(options.allowedNodeIds, []);
  nodes.forEach((node, index) => {
    if (!isPlainObject(node)) return;
    const path = `nodes[${index}]`;
    if (allowedNodeIds && typeof node.id === "string" && !allowedNodeIds.has(node.id)) {
      addError(
        errors,
        `${path}.id`,
        "NODE_NOT_ALLOWED",
        `Workflow node '${node.id}' is not allowed`,
      );
    }

    const resourceKeys = new Set();
    if (Array.isArray(node.resources)) {
      node.resources.forEach((resource, resourceIndex) => {
        const resourcePath = `${path}.resources[${resourceIndex}]`;
        if (!isPlainObject(resource)) {
          addError(errors, resourcePath, "INVALID_RESOURCE", `${resourcePath} must be a plain object`);
          return;
        }
        rejectUnknownKeys(errors, resource, RESOURCE_KEYS, resourcePath);
        requireString(errors, resource.key, `${resourcePath}.key`);
        if (!RESOURCE_MODES.has(resource.mode)) {
          addError(
            errors,
            `${resourcePath}.mode`,
            "INVALID_RESOURCE_MODE",
            `${resourcePath}.mode must be shared or exclusive`,
          );
        }
        if (typeof resource.key === "string" && resource.key.trim() !== "") {
          if (resourceKeys.has(resource.key)) {
            addError(
              errors,
              `${resourcePath}.key`,
              "DUPLICATE_RESOURCE_KEY",
              `Duplicate resource key '${resource.key}'`,
            );
          }
          resourceKeys.add(resource.key);
        }
      });
    }

    const dependencyKeys = new Set();
    if (Array.isArray(node.dependsOn)) {
      node.dependsOn.forEach((dependency, dependencyIndex) => {
        const dependencyPath = `${path}.dependsOn[${dependencyIndex}]`;
        if (!isPlainObject(dependency)) {
          addError(
            errors,
            dependencyPath,
            "INVALID_DEPENDENCY",
            `${dependencyPath} must be a plain object`,
          );
          return;
        }
        rejectUnknownKeys(errors, dependency, DEPENDENCY_KEYS, dependencyPath);
        requireString(errors, dependency.nodeId, `${dependencyPath}.nodeId`);
        if (hasOwn(dependency, "outcome") && !DEPENDENCY_OUTCOMES.has(dependency.outcome)) {
          addError(
            errors,
            `${dependencyPath}.outcome`,
            "INVALID_DEPENDENCY_OUTCOME",
            `${dependencyPath}.outcome must be true or false`,
          );
        }
        if (typeof dependency.nodeId !== "string" || dependency.nodeId.trim() === "") return;
        const dependencyKey = `${dependency.nodeId}:${String(dependency.outcome ?? "")}`;
        if (dependencyKeys.has(dependencyKey)) {
          addError(
            errors,
            dependencyPath,
            "DUPLICATE_DEPENDENCY",
            `Duplicate dependency on '${dependency.nodeId}'`,
          );
        }
        dependencyKeys.add(dependencyKey);
        if (dependency.nodeId === node.id) {
          addError(
            errors,
            `${dependencyPath}.nodeId`,
            "SELF_DEPENDENCY",
            `Workflow node '${node.id}' cannot depend on itself`,
          );
        } else if (!nodeIds.has(dependency.nodeId)) {
          addError(
            errors,
            `${dependencyPath}.nodeId`,
            "UNKNOWN_DEPENDENCY",
            `Dependency target '${dependency.nodeId}' does not exist`,
          );
        }
        if (allowedNodeIds && !allowedNodeIds.has(dependency.nodeId)) {
          addError(
            errors,
            `${dependencyPath}.nodeId`,
            "NODE_NOT_ALLOWED",
            `Dependency target '${dependency.nodeId}' is not allowed`,
          );
        }
      });
    }
  });

  // Phase 7: a condition may only read its declared predecessor.
  nodes.forEach((node, index) => {
    if (
      !isPlainObject(node)
      || node.type !== "condition"
      || !isPlainObject(node.config)
      || typeof node.config.sourceNodeId !== "string"
    ) {
      return;
    }
    const dependencyIds = new Set(
      Array.isArray(node.dependsOn)
        ? node.dependsOn
          .filter((dependency) => isPlainObject(dependency))
          .map((dependency) => dependency.nodeId)
        : [],
    );
    if (!dependencyIds.has(node.config.sourceNodeId)) {
      addError(
        errors,
        `nodes[${index}].config.sourceNodeId`,
        "INVALID_CONDITION_SOURCE",
        "condition.sourceNodeId must name one of the condition node's dependencies",
      );
    }
  });

  // Phase 8: Kahn traversal reports every node that remains behind a cycle.
  const incoming = new Map([...nodeIds].map((nodeId) => [nodeId, 0]));
  const outgoing = new Map([...nodeIds].map((nodeId) => [nodeId, new Set()]));
  nodes.forEach((node) => {
    if (!isPlainObject(node) || !incoming.has(node.id) || !Array.isArray(node.dependsOn)) return;
    node.dependsOn.forEach((dependency) => {
      if (
        !isPlainObject(dependency)
        || !incoming.has(dependency.nodeId)
        || outgoing.get(dependency.nodeId).has(node.id)
      ) {
        return;
      }
      outgoing.get(dependency.nodeId).add(node.id);
      incoming.set(node.id, incoming.get(node.id) + 1);
    });
  });
  const ready = [...incoming]
    .filter(([, count]) => count === 0)
    .map(([nodeId]) => nodeId);
  let cursor = 0;
  while (cursor < ready.length) {
    const nodeId = ready[cursor];
    cursor += 1;
    for (const targetId of outgoing.get(nodeId)) {
      const remaining = incoming.get(targetId) - 1;
      incoming.set(targetId, remaining);
      if (remaining === 0) ready.push(targetId);
    }
  }
  const cyclicNodeIds = new Set(
    [...incoming].filter(([, count]) => count > 0).map(([nodeId]) => nodeId),
  );
  nodes.forEach((node, index) => {
    if (isPlainObject(node) && cyclicNodeIds.has(node.id)) {
      addError(
        errors,
        `nodes[${index}].dependsOn`,
        "CYCLIC_DEPENDENCY",
        `Workflow node '${node.id}' is part of or blocked behind a dependency cycle`,
      );
    }
  });

  return { valid: errors.length === 0, errors };
}

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
    const resolutions = node.dependsOn.map((edge) => (
      dependencySatisfied(edge, byDefinitionId)
        ? "satisfied"
        : dependencyExcluded(edge, byDefinitionId) ? "excluded" : "pending"
    ));
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
  if (config.operator === "contains") {
    return Array.isArray(actual)
      ? actual.includes(config.value)
      : String(actual ?? "").includes(String(config.value));
  }
  return Array.isArray(actual)
    ? !actual.includes(config.value)
    : !String(actual ?? "").includes(String(config.value));
}
