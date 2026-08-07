import type {
  AutomationModel,
  AutomationReasoningEffort,
} from "../../shared/taskboard-automation-options.mjs";

export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "canceled",
] as const;
export const TASK_PRIORITIES = ["none", "urgent", "high", "medium", "low"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type ActorType = "user" | "agent";
export type AssigneeTarget = "current-user" | "codex-agent";
export type IssueRelationType = "parent" | "blocks" | "blocked_by" | "related";

export interface ActorIdentity {
  type: ActorType;
  id: string;
  name: string;
  avatarUrl: string | null;
}

export type DevelopmentContext =
  | { type: "branch"; branch: string }
  | { type: "worktree"; path: string; branch: string | null };

export type Recurrence = {
  interval: number;
  unit: "day" | "week" | "month" | "year";
};

export interface DevelopmentScan {
  workspacePath: string | null;
  contexts: DevelopmentContext[];
}

export interface TaskboardMetadata {
  manageTaskboardSkillPath?: string;
  capabilities?: TaskboardCapabilities;
  mode?: "local" | "cloud";
  realtime?: {
    transport: "poll";
    intervalMs: number;
  };
  localCapabilities?: {
    available: boolean;
  };
}

export interface TaskboardCapabilities {
  localAiChat: boolean;
}

export type AutomaticProcessingProjectMode = "all" | "selected";
export type AutomaticProcessingClaimStrategy = "board-order" | "priority-first" | "due-date-first";
export type AutomaticProcessingState =
  | "disabled"
  | "idle"
  | "running"
  | "quota_paused"
  | "daily_limit"
  | "error";
export type AutomationClaimStatus =
  | "claimed"
  | "running"
  | "retry_wait"
  | "completed"
  | "failed"
  | "canceled";

export interface AutomaticProcessingSettings {
  version: 1;
  enabled: boolean;
  quickMode: boolean;
  projectMode: AutomaticProcessingProjectMode;
  projectIds: string[];
  claimStrategy: AutomaticProcessingClaimStrategy;
  executionModel: AutomationModel;
  reasoningEffort: AutomationReasoningEffort;
  maxConcurrency: number;
  fallbackIntervalMinutes: 1 | 5 | 15 | 30 | 60;
  quotaAware: boolean;
  dailyRunLimit: number | null;
  includeLabels: string[];
  excludeLabels: string[];
  minimumPriority: TaskPriority;
  requireDevelopmentContext: boolean;
  maxRetries: number;
  retryDelayMinutes: number;
}

export interface AutomationClaim {
  id: string;
  taskId: string;
  taskIdentifier?: string;
  projectId?: string;
  dispatcherId: string;
  status: AutomationClaimStatus;
  attempt: number;
  model: string;
  reasoningEffort: string;
  leaseExpiresAt: string | null;
  nextRetryAt: string | null;
  codexThreadId: string | null;
  inputTokens: number;
  outputTokens: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface AutomaticProcessingQuotaStatus {
  state: "available" | "blocked" | "unknown" | "unavailable";
  checkedAt: number;
  resetsAt?: number;
  reason?: "api-key";
}

export interface AutomaticProcessingStatus {
  state: AutomaticProcessingState;
  pauseReason: "quota" | "daily_limit" | null;
  lastReconciledAt: string | null;
  nextFallbackAt: string | null;
  candidateCount: number;
  activeCount: number;
  maxConcurrency: number;
  quota: AutomaticProcessingQuotaStatus | null;
  today: {
    started: number;
    completed: number;
    failed: number;
    inputTokens: number;
    outputTokens: number;
  };
  lastError: string | null;
  recentClaims: AutomationClaim[];
}

export type AiChatSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type AiChatThreadStatus = "idle" | "running" | "failed";
export type AiChatRunStatus = "running" | "completed" | "failed" | "interrupted";

export interface AiChatModel {
  slug: string;
  displayName: string;
  description: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: string[];
  serviceTiers: Array<{ id: string; name: string }>;
}

export interface AiChatSkill {
  id: string;
  label: string;
  description: string;
  path: string;
  scope: "user" | "repo" | "system" | "admin";
}

export interface AiChatAttachmentInput {
  filename: string;
  contentType: string;
  dataBase64: string;
}

export interface AiChatCatalog {
  models: AiChatModel[];
  skills: AiChatSkill[];
  sandboxes: string[];
}

export interface AiChatOrigin {
  projectId: string;
  projectName: string;
  workspacePath: string;
  issueId?: string;
  issueIdentifier?: string;
}

export interface AiChatRun {
  id: string;
  threadId: string;
  status: AiChatRunStatus;
  exitCode?: number | null;
  error?: string | null;
  startedAt?: string;
  finishedAt?: string | null;
}

export interface AiChatThread {
  id: string;
  title: string;
  status: AiChatThreadStatus;
  origin: AiChatOrigin;
  codexThreadId: string | null;
  model: string;
  reasoningEffort: string;
  sandbox: AiChatSandbox;
  createdAt: string;
  updatedAt: string;
  currentRun?: AiChatRun | null;
}

export interface AiChatEvent {
  id: string;
  threadId?: string;
  runId?: string | null;
  type: string;
  role: "user" | "assistant" | "activity" | "error";
  content: string;
  data?: Record<string, unknown> | null;
  createdAt?: string;
}

export interface AiChatThreadSnapshot {
  thread: AiChatThread;
  events: AiChatEvent[];
  runs: AiChatRun[];
}

export interface AiChatSyncResult {
  created: number;
  updated: number;
  skipped: number;
}

export interface WorkflowCapabilityOption {
  id: string;
  label: string;
  scope: "user" | "repo" | "system" | "admin";
}

export interface WorkflowMcpServerOption {
  id: string;
  label: string;
  transport: string;
}

export interface WorkflowCapabilities {
  skills: WorkflowCapabilityOption[];
  mcpServers: WorkflowMcpServerOption[];
}

export interface WorkflowOption {
  id: string;
  name: string;
}

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

export interface WorkflowValidationError {
  path: string;
  code: string;
  message: string;
}

export interface WorkflowReviewFinding {
  severity: string;
  nodeId: string | null;
  message: string;
}

export interface WorkflowReviewReport {
  verdict?: "pass" | "revise";
  stage?: string;
  summary: string;
  findings: Array<WorkflowReviewFinding | WorkflowValidationError>;
  generatorThreadId?: string;
}

export interface WorkflowTemplateRevision {
  id: string;
  projectId: string;
  templateId: string;
  revision: number;
  name: string;
  sourceWorkspaceVersion: number;
  sourceSnapshot: { tab: unknown; snapshot: unknown };
  sourceHash: string;
  createdAt: string;
}

export interface WorkflowTemplateSummary {
  id: string;
  name: string;
  workspaceVersion: number;
  templateRevision: WorkflowTemplateRevision | null;
}

export interface WorkflowRevision {
  id: string;
  taskId: string;
  projectId: string;
  templateId: string;
  templateRevisionId: string;
  templateRevision: number;
  revision: number;
  status: "draft" | "reviewing" | "ready";
  graphSnapshot: WorkflowRuntimeGraph | null;
  graphSchemaVersion: 1 | null;
  validationErrors: WorkflowValidationError[];
  reviewReport: WorkflowReviewReport | null;
  plannerThreadId: string | null;
  reviewerThreadId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  templateRevisionRecord?: WorkflowTemplateRevision | null;
}

export interface WorkflowRun {
  id: string;
  taskId: string;
  projectId: string;
  templateId: string;
  workflowRevisionId: string;
  workflowRevision: number;
  templateRevisionId: string;
  templateRevision: number;
  status: WorkflowRunStatus;
  graphSnapshot: WorkflowRuntimeGraph;
  graphSchemaVersion: 1;
  concurrencyLimit: number;
  failFast: boolean;
  amendmentRevision: number;
  planningPath: string;
  version: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface WorkflowNodeRun {
  id: string;
  runId: string;
  definitionId: string;
  type: WorkflowPrimitive;
  executorVersion: 1;
  status: WorkflowNodeStatus;
  approvalMode: "automatic" | "manual";
  config: Record<string, unknown>;
  resources: WorkflowRuntimeResource[];
  result: Record<string, unknown> | null;
  branchOutcome: "true" | "false" | null;
  activeAttemptId: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowNodeAttempt {
  id: string;
  nodeRunId: string;
  attemptNumber: number;
  idempotencyKey: string;
  status: "running" | "completed" | "failed" | "interrupted" | "recovery_required" | "cancelled";
  threadId: string | null;
  turnId: string | null;
  lastFinishedTurnId: string | null;
  lastFinishedStatus: string | null;
  lastFinishedCandidateResultPresent: boolean;
  lastFinishedCandidateResult: unknown;
  lastFinishedErrorPresent: boolean;
  lastFinishedError: unknown;
  candidateResult: unknown;
  error: unknown;
  startedAt: string;
  finishedAt: string | null;
}

export interface WorkflowInboxMessage {
  id: string;
  runId: string;
  targetNodeRunId: string;
  sourceType: "user" | "agent";
  sourceNodeRunId: string | null;
  mode: "steer" | "queued";
  status: "pending" | "delivered" | "fallback_queued" | "cancelled";
  sequence: number;
  content: string;
  expectedTurnId: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export interface WorkflowSubagent {
  id: string;
  nodeRunId: string;
  attemptId: string;
  threadId: string;
  parentThreadId: string;
  role: string | null;
  model: string | null;
  status: "running" | "completed" | "failed" | "interrupted" | "cancelled";
  activity: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowEvent {
  id: string;
  runId: string;
  nodeRunId: string | null;
  attemptId: string | null;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface WorkflowRunAmendment {
  id: string;
  runId: string;
  revision: number;
  source: "user_configured" | "codex_generated";
  status: "draft" | "reviewing" | "ready" | "applied" | "rejected";
  patch:
    | { node: WorkflowRuntimeNodeDefinition }
    | { prompt: string; dependsOn: string[] };
  reviewReport: WorkflowReviewReport | null;
  reviewerThreadId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IssueWorkflowSnapshot {
  templates: WorkflowTemplateSummary[];
  revisions: WorkflowRevision[];
  activeRun: WorkflowRunSnapshot | null;
  latestRun: WorkflowRunSnapshot | null;
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

export type WorkflowNodeControlAction = "approve" | "reject" | "interrupt" | "retry" | "cancel";
export type WorkflowAmendmentInput =
  | { source: "user_configured"; node: WorkflowRuntimeNodeDefinition }
  | { source: "codex_generated"; prompt: string; dependsOn: string[] };

export interface WorkflowWorkspaceRecord<T = unknown> {
  projectId: string;
  workspace: T | null;
  version: number;
  updatedAt: string | null;
}

export interface Project {
  id: string;
  name: string;
  workspacePath: string | null;
  issueCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDeviceLink {
  taskboardProjectId: string;
  codexProjectId: string | null;
  workspacePath: string;
  status: "pending" | "synced";
}

export interface ProjectWorkspacePreview {
  directoryName: string;
  workspacePath: string;
}

export interface ProjectWorkspaceCreateResult {
  project: Project;
  link: ProjectDeviceLink;
}

export interface CodexHistoryThread {
  threadId: string;
  title: string;
  description: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
}

export interface CodexActivitySegment {
  startAt: string;
  endAt: string;
}

export interface CodexThreadActivity {
  threadId: string;
  segments: CodexActivitySegment[];
}

export interface CodexImportTaskInput {
  threadId: string;
  projectId: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface CodexImportFailure {
  threadId: string | null;
  message: string;
}

export interface CodexImportResult {
  imported: number;
  skipped: number;
  failed: number;
  failures: CodexImportFailure[];
}

export interface TaskRelationSummary {
  id: string;
  identifier: string;
  projectId: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: ActorIdentity;
  archivedAt: string | null;
}

export interface TaskRelations {
  parent: TaskRelationSummary | null;
  subIssues: TaskRelationSummary[];
  blockedBy: TaskRelationSummary[];
  blocks: TaskRelationSummary[];
  related: TaskRelationSummary[];
}

export interface Task {
  id: string;
  identifier: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  labels: string[];
  sortOrder: number;
  threadId: string | null;
  creatorType: ActorType;
  creatorId: string;
  creatorName: string;
  creatorAvatarUrl: string | null;
  assignee: ActorIdentity;
  workflowId: string | null;
  developmentContext: DevelopmentContext | null;
  dueDate: string | null;
  recurrence: Recurrence | null;
  archivedAt: string | null;
  relations: TaskRelations;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: string;
  taskId: string;
  body: string;
  authorType: ActorType;
  authorId: string;
  authorName: string;
  authorAvatarUrl: string | null;
  threadId: string | null;
  attachments: Attachment[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Attachment {
  id: string;
  taskId: string;
  commentId: string | null;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
}

export interface HostContext {
  user?: ActorIdentity;
  workspacePath?: string;
  threadId?: string;
  theme?: "light" | "dark";
  projectId?: string;
  projects?: Array<{ id: string; name: string }>;
  titlebarLeftInset?: number;
  sidebarCollapsed?: boolean;
}

export interface TaskDraft {
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  labels: string[];
  assigneeTarget?: AssigneeTarget;
  workflowId: string | null;
  developmentContext: DevelopmentContext | null;
  dueDate: string | null;
  recurrence: Recurrence | null;
}

export interface TaskEvent {
  type: string;
  projectId?: string;
  taskId?: string;
  task?: Task;
  comment?: Comment;
  attachment?: Attachment;
  project?: Project;
  at: string;
}
