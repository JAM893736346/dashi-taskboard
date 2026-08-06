import {
  isAutomationModel,
  isAutomationReasoningEffort,
  isSupportedModelEffort,
} from "./taskboard-automation-options.mjs";
import { isTaskPriority } from "./domain.mjs";

const SETTING_KEYS = new Set([
  "version",
  "enabled",
  "quickMode",
  "projectMode",
  "projectIds",
  "claimStrategy",
  "executionModel",
  "reasoningEffort",
  "maxConcurrency",
  "fallbackIntervalMinutes",
  "quotaAware",
  "dailyRunLimit",
  "includeLabels",
  "excludeLabels",
  "minimumPriority",
  "requireDevelopmentContext",
  "maxRetries",
  "retryDelayMinutes",
]);
const PROJECT_MODES = new Set(["all", "selected"]);
const CLAIM_STRATEGIES = new Set(["board-order", "priority-first", "due-date-first"]);
const FALLBACK_INTERVALS = new Set([1, 5, 15, 30, 60]);
const PRIORITY_RANK = new Map([
  ["urgent", 0],
  ["high", 1],
  ["medium", 2],
  ["low", 3],
  ["none", 4],
]);

export const DEFAULT_AUTOMATIC_PROCESSING_SETTINGS = Object.freeze({
  version: 1,
  enabled: false,
  quickMode: true,
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

export const QUICK_VALIDATION_EXECUTION_SETTINGS = Object.freeze({
  executionModel: "gpt-5.6-terra",
  reasoningEffort: "low",
});

export function resolveAutomaticProcessingExecutionSettings(settings) {
  return settings.quickMode
    ? QUICK_VALIDATION_EXECUTION_SETTINGS
    : {
        executionModel: settings.executionModel,
        reasoningEffort: settings.reasoningEffort,
      };
}

function fail(message) {
  throw new TypeError(message);
}

function stringList(value, name, { maxItems, maxLength }) {
  if (!Array.isArray(value) || value.length > maxItems) {
    fail(`'${name}' must be an array with at most ${maxItems} entries`);
  }
  const result = value.map((entry) => {
    if (typeof entry !== "string") fail(`Every '${name}' entry must be a string`);
    const normalized = entry.trim();
    if (!normalized || normalized.length > maxLength || normalized.includes("\0")) {
      fail(`Every '${name}' entry must contain 1 to ${maxLength} characters`);
    }
    return normalized;
  });
  if (new Set(result).size !== result.length) fail(`'${name}' entries must be unique`);
  return result;
}

function integer(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`'${name}' must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function normalizeAutomaticProcessingSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("Automatic processing settings must be a JSON object");
  }
  const unknown = Object.keys(value).filter((key) => !SETTING_KEYS.has(key));
  if (unknown.length > 0) fail(`Unknown automatic processing setting: ${unknown[0]}`);
  if (value.version !== 1) fail("'version' must be 1");
  if (typeof value.enabled !== "boolean") fail("'enabled' must be a boolean");
  const quickMode = value.quickMode ?? true;
  if (typeof quickMode !== "boolean") fail("'quickMode' must be a boolean");
  if (!PROJECT_MODES.has(value.projectMode)) fail("'projectMode' must be all or selected");
  if (!CLAIM_STRATEGIES.has(value.claimStrategy)) {
    fail("'claimStrategy' must be board-order, priority-first, or due-date-first");
  }
  if (!isAutomationModel(value.executionModel)) fail("'executionModel' is not supported");
  if (!isAutomationReasoningEffort(value.reasoningEffort)) {
    fail("'reasoningEffort' is not supported");
  }
  if (!isSupportedModelEffort(value.executionModel, value.reasoningEffort)) {
    fail("'reasoningEffort' is not supported by 'executionModel'");
  }
  if (typeof value.quotaAware !== "boolean") fail("'quotaAware' must be a boolean");
  if (typeof value.requireDevelopmentContext !== "boolean") {
    fail("'requireDevelopmentContext' must be a boolean");
  }
  if (!FALLBACK_INTERVALS.has(value.fallbackIntervalMinutes)) {
    fail("'fallbackIntervalMinutes' must be 1, 5, 15, 30, or 60");
  }
  if (value.dailyRunLimit !== null) integer(value.dailyRunLimit, "dailyRunLimit", 1, 10_000);
  if (!isTaskPriority(value.minimumPriority)) fail("'minimumPriority' is not supported");

  return {
    version: 1,
    enabled: value.enabled,
    quickMode,
    projectMode: value.projectMode,
    projectIds: stringList(value.projectIds, "projectIds", { maxItems: 200, maxLength: 128 }),
    claimStrategy: value.claimStrategy,
    executionModel: value.executionModel,
    reasoningEffort: value.reasoningEffort,
    maxConcurrency: integer(value.maxConcurrency, "maxConcurrency", 1, 4),
    fallbackIntervalMinutes: value.fallbackIntervalMinutes,
    quotaAware: value.quotaAware,
    dailyRunLimit: value.dailyRunLimit,
    includeLabels: stringList(value.includeLabels, "includeLabels", { maxItems: 20, maxLength: 64 }),
    excludeLabels: stringList(value.excludeLabels, "excludeLabels", { maxItems: 20, maxLength: 64 }),
    minimumPriority: value.minimumPriority,
    requireDevelopmentContext: value.requireDevelopmentContext,
    maxRetries: integer(value.maxRetries, "maxRetries", 0, 5),
    retryDelayMinutes: integer(value.retryDelayMinutes, "retryDelayMinutes", 1, 1_440),
  };
}

function stableText(left, right) {
  return String(left ?? "").localeCompare(String(right ?? ""));
}

function boardOrder(left, right) {
  return left.sortOrder - right.sortOrder
    || stableText(left.createdAt, right.createdAt)
    || stableText(left.id, right.id);
}

function priorityOrder(left, right) {
  return PRIORITY_RANK.get(left.priority) - PRIORITY_RANK.get(right.priority)
    || boardOrder(left, right);
}

function dueDateOrder(left, right) {
  if (left.dueDate === null && right.dueDate !== null) return 1;
  if (left.dueDate !== null && right.dueDate === null) return -1;
  return stableText(left.dueDate, right.dueDate) || priorityOrder(left, right);
}

function labelsPass(taskLabels, includeLabels, excludeLabels) {
  const labels = new Set(taskLabels);
  return includeLabels.every((label) => labels.has(label))
    && excludeLabels.every((label) => !labels.has(label));
}

function priorityPass(priority, minimumPriority) {
  if (minimumPriority === "none") return true;
  return PRIORITY_RANK.get(priority) <= PRIORITY_RANK.get(minimumPriority);
}

export function mappedAutomaticProcessingProjectIds(projects, settings) {
  const selected = new Set(settings.projectIds);
  return new Set(projects.filter((project) => (
    typeof project.workspacePath === "string"
    && project.workspacePath.trim() !== ""
    && (settings.projectMode === "all" || selected.has(project.id))
  )).map((project) => project.id));
}

export function isAutomaticProcessingTaskEligible(
  task,
  { enabledProjectIds, activeTaskIds = new Set(), settings },
) {
  return task.status === "todo"
    && task.archivedAt === null
    && task.assignee?.type === "agent"
    && String(task.assignee?.id ?? "").endsWith("codex-agent")
    && enabledProjectIds.has(task.projectId)
    && !activeTaskIds.has(task.id)
    && (task.relations?.blockedBy ?? []).every(
      (blocker) => blocker.status === "done" || blocker.status === "canceled",
    )
    && labelsPass(task.labels ?? [], settings.includeLabels, settings.excludeLabels)
    && priorityPass(task.priority, settings.minimumPriority)
    && (!settings.requireDevelopmentContext || task.developmentContext !== null)
    && !(settings.maxConcurrency > 1 && task.developmentContext?.type === "branch");
}

export function rankAutomaticProcessingCandidates({
  tasks,
  projects,
  activeTaskIds = new Set(),
  settings,
  lastProjectId = null,
}) {
  const enabledProjectIds = mappedAutomaticProcessingProjectIds(projects, settings);
  const eligible = tasks.filter((task) => isAutomaticProcessingTaskEligible(task, {
    enabledProjectIds,
    activeTaskIds,
    settings,
  }));
  if (eligible.length === 0) return [];

  const eligibleProjectIds = projects
    .map((project) => project.id)
    .filter((projectId) => eligible.some((task) => task.projectId === projectId));
  const previousIndex = eligibleProjectIds.indexOf(lastProjectId);
  const projectId = eligibleProjectIds[(previousIndex + 1) % eligibleProjectIds.length];
  const compare = settings.claimStrategy === "priority-first"
    ? priorityOrder
    : settings.claimStrategy === "due-date-first"
      ? dueDateOrder
      : boardOrder;
  return eligible.filter((task) => task.projectId === projectId).sort(compare);
}
