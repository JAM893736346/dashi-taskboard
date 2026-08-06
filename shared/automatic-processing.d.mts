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
  projectMode: AutomaticProcessingProjectMode;
  projectIds: string[];
  claimStrategy: AutomaticProcessingClaimStrategy;
  executionModel: string;
  reasoningEffort: string;
  maxConcurrency: number;
  fallbackIntervalMinutes: 1 | 5 | 15 | 30 | 60;
  quotaAware: boolean;
  dailyRunLimit: number | null;
  includeLabels: string[];
  excludeLabels: string[];
  minimumPriority: "none" | "urgent" | "high" | "medium" | "low";
  requireDevelopmentContext: boolean;
  maxRetries: number;
  retryDelayMinutes: number;
}

export interface AutomaticProcessingProject {
  id: string;
  workspacePath: string | null;
}

export interface AutomaticProcessingTask {
  id: string;
  projectId: string;
  status: string;
  archivedAt: string | null;
  assignee: { type: string; id: string };
  labels: string[];
  priority: AutomaticProcessingSettings["minimumPriority"];
  sortOrder: number;
  dueDate: string | null;
  developmentContext: { type: "branch" | "worktree" } | null;
  relations: { blockedBy: Array<{ status: string }> };
  createdAt: string;
}

export const DEFAULT_AUTOMATIC_PROCESSING_SETTINGS: Readonly<AutomaticProcessingSettings>;
export function normalizeAutomaticProcessingSettings(value: unknown): AutomaticProcessingSettings;
export function mappedAutomaticProcessingProjectIds(
  projects: AutomaticProcessingProject[],
  settings: AutomaticProcessingSettings,
): Set<string>;
export function isAutomaticProcessingTaskEligible(
  task: AutomaticProcessingTask,
  context: {
    enabledProjectIds: Set<string>;
    activeTaskIds?: Set<string>;
    settings: AutomaticProcessingSettings;
  },
): boolean;
export function rankAutomaticProcessingCandidates(input: {
  tasks: AutomaticProcessingTask[];
  projects: AutomaticProcessingProject[];
  activeTaskIds?: Set<string>;
  settings: AutomaticProcessingSettings;
  lastProjectId?: string | null;
}): AutomaticProcessingTask[];
