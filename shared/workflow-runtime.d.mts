export type TaskStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "blocked"
  | "done"
  | "canceled";

export type WorkflowPrimitive = "codex-thread" | "human-gate" | "condition" | "issue-action";
export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";
export type WorkflowNodeStatus =
  | "blocked"
  | "ready"
  | "running"
  | "awaiting_confirmation"
  | "succeeded"
  | "rejected"
  | "failed"
  | "interrupted"
  | "recovery_required"
  | "migration_required"
  | "cancelled";

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

export interface WorkflowRuntimeDependency {
  nodeId: string;
  outcome?: "true" | "false";
}

export interface WorkflowRuntimeResource {
  key: string;
  mode: "shared" | "exclusive";
}

export interface WorkflowRuntimeNodeDefinition {
  id: string;
  type: WorkflowPrimitive;
  executorVersion: 1;
  title: string;
  objective: string;
  dependsOn: WorkflowRuntimeDependency[];
  approvalMode: "automatic" | "manual";
  config: Record<string, unknown>;
  resources: WorkflowRuntimeResource[];
}

export interface CodexThreadWorkflowConfig {
  rolePreset: string;
  model: string | null;
  effort: string | null;
  sandbox: "readOnly" | "workspaceWrite" | "dangerFullAccess";
  outputSchema: Record<string, unknown> | null;
}

export interface HumanGateWorkflowConfig {
  message: string;
}

export interface ConditionWorkflowConfig {
  sourceNodeId: string;
  field: string;
  operator: "equals" | "not-equals" | "contains" | "not-contains";
  value: unknown;
}

export interface IssueActionWorkflowConfig {
  action: "set-status";
  status: TaskStatus;
}

export interface WorkflowNodeResult {
  summary: string;
  conclusions: string[];
  changedFiles: string[];
  artifacts: string[];
  verification: string[];
  unresolved: string[];
  risks: string[];
  planningDirectory?: string;
}

export interface WorkflowValidationError {
  path: string;
  code: string;
  message: string;
}

export interface WorkflowValidationResult {
  valid: boolean;
  errors: WorkflowValidationError[];
}

export interface WorkflowValidationOptions {
  allowedPrimitives?: Iterable<WorkflowPrimitive>;
  allowedNodeIds?: Iterable<string>;
}

export interface WorkflowRuntimeNodeRun {
  definitionId: string;
  status: WorkflowNodeStatus;
  branchOutcome?: "true" | "false" | null;
  result?: Record<string, unknown> | null;
}

export interface WorkflowDependencyTransition {
  nodeId: string;
  status: "ready" | "cancelled";
  reason: "condition_not_selected" | null;
}

export const WORKFLOW_GRAPH_SCHEMA_VERSION: 1;
export const WORKFLOW_EXECUTOR_VERSIONS: Readonly<{
  "codex-thread": 1;
  "human-gate": 1;
  condition: 1;
  "issue-action": 1;
}>;
export const WORKFLOW_PRIMITIVES: readonly WorkflowPrimitive[];
export const WORKFLOW_RUN_STATUSES: readonly WorkflowRunStatus[];
export const WORKFLOW_NODE_STATUSES: readonly WorkflowNodeStatus[];
export const WORKFLOW_NODE_RESULT_SCHEMA: Readonly<Record<string, unknown>>;

export function validateWorkflowRuntimeGraph(
  value: unknown,
  options?: WorkflowValidationOptions,
): WorkflowValidationResult;
export function assertWorkflowRuntimeGraph(
  value: unknown,
  options?: WorkflowValidationOptions,
): WorkflowRuntimeGraph;
export function initialWorkflowNodeStatus(
  node: Pick<WorkflowRuntimeNodeDefinition, "dependsOn">,
): "ready" | "blocked";
export function dependencySatisfied(
  dependency: WorkflowRuntimeDependency,
  nodesByDefinitionId: Map<string, WorkflowRuntimeNodeRun>,
): boolean;
export function dependencyExcluded(
  dependency: WorkflowRuntimeDependency,
  nodesByDefinitionId: Map<string, WorkflowRuntimeNodeRun>,
): boolean;
export function settleWorkflowDependencies(
  graph: WorkflowRuntimeGraph,
  nodeRuns: WorkflowRuntimeNodeRun[],
): WorkflowDependencyTransition[];
export function evaluateWorkflowCondition(
  config: ConditionWorkflowConfig,
  predecessorResult: unknown,
): boolean;
