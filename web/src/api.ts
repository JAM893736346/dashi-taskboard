import type {
  ActorIdentity,
  AutomaticProcessingSettings,
  AutomaticProcessingStatus,
  AiChatCatalog,
  AiChatAttachmentInput,
  AiChatRun,
  AiChatSandbox,
  AiChatSyncResult,
  AiChatThread,
  AiChatThreadSnapshot,
  Attachment,
  AutomationClaim,
  Comment,
  CodexThreadActivity,
  CodexHistoryThread,
  CodexImportResult,
  CodexImportTaskInput,
  DevelopmentScan,
  IssueRelationType,
  Project,
  ProjectDeviceLink,
  ProjectWorkspaceCreateResult,
  ProjectWorkspacePreview,
  Task,
  TaskboardMetadata,
  TaskDraft,
  TaskStatus,
  IssueWorkflowSnapshot,
  WorkflowAmendmentInput,
  WorkflowCapabilities,
  WorkflowInboxMessage,
  WorkflowNodeControlAction,
  WorkflowRevision,
  WorkflowRunAmendment,
  WorkflowRunSnapshot,
  WorkflowWorkspaceRecord,
} from "./types";

const DEFAULT_USER_ACTOR: ActorIdentity = {
  type: "user",
  id: "local-user",
  name: "本地用户",
  avatarUrl: null,
};

let currentUserActor = DEFAULT_USER_ACTOR;

export function setCurrentUserActor(actor?: ActorIdentity) {
  currentUserActor = actor?.type === "user" ? actor : DEFAULT_USER_ACTOR;
}

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error?.message ?? `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = body.error?.code ?? "REQUEST_FAILED";
    this.details = body.error?.details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    headers.set("X-Taskboard-User-Id", currentUserActor.id);
    headers.set("X-Taskboard-User-Name", encodeURIComponent(currentUserActor.name));
    if (currentUserActor.avatarUrl) {
      headers.set("X-Taskboard-User-Avatar", currentUserActor.avatarUrl);
    }
  }

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ApiError(0, {
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "无法连接本地 Taskboard 服务，请重新通过 Taskboard 启动 Codex。",
      },
    });
  }
  const body = (await response.json().catch(() => ({}))) as T & ApiErrorBody;

  if (!response.ok) throw new ApiError(response.status, body);
  return body;
}

export async function listProjects(signal?: AbortSignal): Promise<Project[]> {
  const data = await request<{ projects: Project[] }>("/api/projects", { signal });
  return data.projects;
}

export async function listCodexHistory(signal?: AbortSignal): Promise<CodexHistoryThread[]> {
  const data = await request<{ threads: CodexHistoryThread[] }>(
    "/api/local/codex-history",
    { signal },
  );
  return data.threads;
}

export async function listCodexActivity(
  threadIds: string[],
  rangeStart: string,
  rangeEnd: string,
  signal?: AbortSignal,
): Promise<CodexThreadActivity[]> {
  const data = await request<{ threads: CodexThreadActivity[] }>(
    "/api/local/codex-activity",
    {
      method: "POST",
      body: JSON.stringify({ threadIds, rangeStart, rangeEnd }),
      signal,
    },
  );
  return data.threads;
}

export async function listImportedCodexThreadIds(signal?: AbortSignal): Promise<string[]> {
  const data = await request<{ threadIds: string[] }>("/api/codex-import", { signal });
  return data.threadIds;
}

export async function importCodexHistory(
  tasks: CodexImportTaskInput[],
): Promise<CodexImportResult> {
  return request<CodexImportResult>("/api/codex-import", {
    method: "POST",
    body: JSON.stringify({ tasks }),
  });
}

export async function getTaskboardMetadata(signal?: AbortSignal): Promise<TaskboardMetadata> {
  return request<TaskboardMetadata>("/api/meta", { signal });
}

export async function getTaskboardRevision(
  since: number,
  signal?: AbortSignal,
): Promise<{ changed: boolean; revision: number }> {
  const query = new URLSearchParams({ since: String(since) });
  return request<{ changed: boolean; revision: number }>(`/api/revisions?${query}`, { signal });
}

export async function getAiChatCatalog(
  projectId: string,
  signal?: AbortSignal,
): Promise<AiChatCatalog> {
  return request<AiChatCatalog>(
    `/api/local/ai/catalog?projectId=${encodeURIComponent(projectId)}`,
    { signal },
  );
}

export async function listAiChatThreads(signal?: AbortSignal): Promise<AiChatThread[]> {
  const data = await request<{ threads: AiChatThread[] }>("/api/local/ai/threads", { signal });
  return data.threads;
}

export async function createAiChatThread(input: {
  projectId: string;
  issueId?: string;
  title?: string;
  model?: string;
  reasoningEffort?: string;
  sandbox?: AiChatSandbox;
}): Promise<AiChatThread> {
  const data = await request<{ thread: AiChatThread }>("/api/local/ai/threads", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.thread;
}

export async function getAiChatThread(
  threadId: string,
  signal?: AbortSignal,
): Promise<AiChatThreadSnapshot> {
  return request<AiChatThreadSnapshot>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}`,
    { signal },
  );
}

export async function updateAiChatThread(
  threadId: string,
  input: {
    title?: string;
    model?: string;
    reasoningEffort?: string;
    sandbox?: AiChatSandbox;
  },
): Promise<AiChatThread> {
  const data = await request<{ thread: AiChatThread }>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
  return data.thread;
}

export async function deleteAiChatThread(threadId: string): Promise<void> {
  await request<void>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}`,
    { method: "DELETE" },
  );
}

export async function startAiChatTurn(
  threadId: string,
  input: {
    message: string;
    skillIds?: string[];
    attachments?: AiChatAttachmentInput[];
    dangerFullAccessConfirmed?: boolean;
  },
): Promise<AiChatRun> {
  const data = await request<{ run: AiChatRun }>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}/turns`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
  return data.run;
}

export async function interruptAiChatRun(runId: string): Promise<AiChatRun> {
  const data = await request<{ run: AiChatRun }>(
    `/api/local/ai/runs/${encodeURIComponent(runId)}/interrupt`,
    { method: "POST" },
  );
  return data.run;
}

export function subscribeAiChatThread(
  threadId: string,
  onHint: (type: "ai.event" | "ai.run") => void,
  onError?: () => void,
): () => void {
  const source = new EventSource(`/api/local/ai/threads/${encodeURIComponent(threadId)}/events`);
  source.addEventListener("ai.event", () => onHint("ai.event"));
  source.addEventListener("ai.run", () => onHint("ai.run"));
  if (onError) source.addEventListener("error", onError);
  return () => source.close();
}

export async function listDeviceWorkspaces(signal?: AbortSignal): Promise<Record<string, string>> {
  try {
    const data = await request<{ workspaces: Record<string, string> }>("/api/device-workspaces", { signal });
    return data.workspaces;
  } catch (error) {
    if (error instanceof ApiError && error.code === "LOCAL_COMPANION_REQUIRED") return {};
    throw error;
  }
}

export async function pickProjectParent(): Promise<string | null> {
  const data = await request<{ parentPath: string | null }>(
    "/api/local/project-parent-picker",
    { method: "POST" },
  );
  return data.parentPath;
}

export async function previewProjectWorkspace(
  name: string,
  parentPath: string,
  signal?: AbortSignal,
): Promise<ProjectWorkspacePreview> {
  return request<ProjectWorkspacePreview>("/api/local/project-workspaces/preview", {
    method: "POST",
    body: JSON.stringify({ name, parentPath }),
    signal,
  });
}

export async function createProjectWorkspace(
  name: string,
  parentPath: string,
): Promise<ProjectWorkspaceCreateResult> {
  return request<ProjectWorkspaceCreateResult>("/api/local/project-workspaces", {
    method: "POST",
    body: JSON.stringify({ name, parentPath }),
  });
}

export async function listProjectDeviceLinks(
  signal?: AbortSignal,
): Promise<ProjectDeviceLink[]> {
  const data = await request<{ links: ProjectDeviceLink[] }>(
    "/api/local/project-links",
    { signal },
  );
  return data.links;
}

export async function saveProjectDeviceLink(
  projectId: string,
  input: { workspacePath: string; codexProjectId: string | null },
): Promise<ProjectDeviceLink> {
  const data = await request<{ link: ProjectDeviceLink }>(
    `/api/local/project-links/${encodeURIComponent(projectId)}`,
    { method: "PUT", body: JSON.stringify(input) },
  );
  return data.link;
}

export async function reconcileProjectDeviceLink(
  projectId: string,
  workspacePath: string,
): Promise<ProjectDeviceLink> {
  const data = await request<{ link: ProjectDeviceLink }>(
    `/api/local/project-links/${encodeURIComponent(projectId)}/reconcile`,
    { method: "POST", body: JSON.stringify({ workspacePath }) },
  );
  return data.link;
}

export async function syncAiChats(): Promise<AiChatSyncResult> {
  return request<AiChatSyncResult>("/api/local/ai/sync-codex-history", {
    method: "POST",
  });
}

export async function getAutomaticProcessingSettings(
  signal?: AbortSignal,
): Promise<AutomaticProcessingSettings> {
  const data = await request<{ settings: AutomaticProcessingSettings }>(
    "/api/local/automatic-processing/settings",
    { signal },
  );
  return data.settings;
}

export async function updateAutomaticProcessingSettings(
  settings: AutomaticProcessingSettings,
): Promise<AutomaticProcessingSettings> {
  const data = await request<{ settings: AutomaticProcessingSettings }>(
    "/api/local/automatic-processing/settings",
    { method: "PUT", body: JSON.stringify(settings) },
  );
  return data.settings;
}

export async function updateAutomaticProcessingQuickMode(
  quickMode: boolean,
): Promise<AutomaticProcessingSettings> {
  const data = await request<{ settings: AutomaticProcessingSettings }>(
    "/api/local/automatic-processing/settings",
    { method: "PATCH", body: JSON.stringify({ quickMode }) },
  );
  return data.settings;
}

export async function getAutomaticProcessingStatus(
  signal?: AbortSignal,
): Promise<AutomaticProcessingStatus> {
  const data = await request<{ status: AutomaticProcessingStatus }>(
    "/api/local/automatic-processing/status",
    { signal },
  );
  return data.status;
}

export async function listAutomaticProcessingHistory(
  limit = 20,
  signal?: AbortSignal,
): Promise<AutomationClaim[]> {
  const query = new URLSearchParams({ limit: String(limit) });
  const data = await request<{ claims: AutomationClaim[] }>(
    `/api/local/automatic-processing/history?${query}`,
    { signal },
  );
  return data.claims;
}

export async function reconcileAutomaticProcessing(): Promise<AutomaticProcessingStatus> {
  const data = await request<{ status: AutomaticProcessingStatus }>(
    "/api/local/automatic-processing/reconcile",
    { method: "POST" },
  );
  return data.status;
}

export async function saveAutomaticProcessingProjectMapping(
  projectId: string,
  workspacePath: string,
): Promise<void> {
  await request(`/api/local/project-mappings/${encodeURIComponent(projectId)}`, {
    method: "PUT",
    body: JSON.stringify({ workspacePath }),
  });
}

export async function listWorkflowCapabilities(
  workspacePath?: string,
  signal?: AbortSignal,
): Promise<WorkflowCapabilities> {
  const query = new URLSearchParams();
  if (workspacePath) query.set("workspacePath", workspacePath);
  const suffix = query.size > 0 ? `?${query}` : "";
  return request<WorkflowCapabilities>(`/api/workflow-capabilities${suffix}`, { signal });
}

export async function getWorkflowWorkspace<T>(
  projectId: string,
  signal?: AbortSignal,
): Promise<WorkflowWorkspaceRecord<T>> {
  const data = await request<{ workflow: WorkflowWorkspaceRecord<T> }>(
    `/api/projects/${encodeURIComponent(projectId)}/workflow-workspace`,
    { signal },
  );
  return data.workflow;
}

export async function saveWorkflowWorkspace<T>(
  projectId: string,
  workspace: T,
  version: number,
): Promise<WorkflowWorkspaceRecord<T>> {
  const data = await request<{ workflow: WorkflowWorkspaceRecord<T> }>(
    `/api/projects/${encodeURIComponent(projectId)}/workflow-workspace`,
    {
      method: "PUT",
      body: JSON.stringify({ version, workspace }),
    },
  );
  return data.workflow;
}

export async function getIssueWorkflow(
  taskId: string,
  signal?: AbortSignal,
): Promise<IssueWorkflowSnapshot> {
  return request<IssueWorkflowSnapshot>(
    `/api/local/tasks/${encodeURIComponent(taskId)}/workflow`,
    { signal },
  );
}

export async function generateWorkflowRevision(
  taskId: string,
  templateId: string,
): Promise<WorkflowRevision> {
  const data = await request<{ revision: WorkflowRevision }>(
    `/api/local/tasks/${encodeURIComponent(taskId)}/workflow/revisions`,
    {
      method: "POST",
      body: JSON.stringify({ templateId }),
    },
  );
  return data.revision;
}

export async function enqueueWorkflowRevision(
  revisionId: string,
): Promise<WorkflowRunSnapshot> {
  const data = await request<{ snapshot: WorkflowRunSnapshot }>(
    `/api/local/workflow/revisions/${encodeURIComponent(revisionId)}/enqueue`,
    { method: "POST" },
  );
  return data.snapshot;
}

export async function getWorkflowRun(
  runId: string,
  signal?: AbortSignal,
): Promise<WorkflowRunSnapshot> {
  const data = await request<{ snapshot: WorkflowRunSnapshot }>(
    `/api/local/workflow/runs/${encodeURIComponent(runId)}`,
    { signal },
  );
  return data.snapshot;
}

export async function sendWorkflowNodeMessage(
  nodeRunId: string,
  input: { mode: "steer" | "queued"; content: string },
): Promise<{ message: WorkflowInboxMessage; snapshot: WorkflowRunSnapshot }> {
  return request<{ message: WorkflowInboxMessage; snapshot: WorkflowRunSnapshot }>(
    `/api/local/workflow/nodes/${encodeURIComponent(nodeRunId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function controlWorkflowNode(
  nodeRunId: string,
  action: WorkflowNodeControlAction,
): Promise<WorkflowRunSnapshot> {
  const data = await request<{ snapshot: WorkflowRunSnapshot }>(
    `/api/local/workflow/nodes/${encodeURIComponent(nodeRunId)}/control`,
    {
      method: "POST",
      body: JSON.stringify({ action }),
    },
  );
  return data.snapshot;
}

export async function createWorkflowAmendment(
  runId: string,
  input: WorkflowAmendmentInput,
): Promise<WorkflowRunAmendment> {
  const data = await request<{ amendment: WorkflowRunAmendment }>(
    `/api/local/workflow/runs/${encodeURIComponent(runId)}/amendments`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
  return data.amendment;
}

export async function applyWorkflowAmendment(
  amendmentId: string,
): Promise<WorkflowRunSnapshot> {
  const data = await request<{ snapshot: WorkflowRunSnapshot }>(
    `/api/local/workflow/amendments/${encodeURIComponent(amendmentId)}/apply`,
    { method: "POST" },
  );
  return data.snapshot;
}

export async function createProject(input: {
  id: string;
  name: string;
  workspacePath: string | null;
}): Promise<Project> {
  const data = await request<{ project: Project }>("/api/projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.project;
}

export async function listDevelopmentContexts(
  projectId: string,
  codexProjectId?: string,
  codexThreadId?: string,
  signal?: AbortSignal,
  workspacePath?: string,
): Promise<DevelopmentScan> {
  const query = new URLSearchParams();
  if (codexProjectId) query.set("codexProjectId", codexProjectId);
  if (codexThreadId) query.set("codexThreadId", codexThreadId);
  if (workspacePath) query.set("workspacePath", workspacePath);
  const suffix = query.size > 0 ? `?${query}` : "";
  return request<DevelopmentScan>(
    `/api/projects/${encodeURIComponent(projectId)}/development-contexts${suffix}`,
    { signal },
  );
}

export async function listTasks(projectId: string, signal?: AbortSignal): Promise<Task[]> {
  const params = new URLSearchParams({ projectId, archived: "false" });
  const data = await request<{ tasks: Task[] }>(`/api/tasks?${params}`, { signal });
  return data.tasks;
}

export async function createTask(projectId: string, draft: TaskDraft, threadId?: string): Promise<Task> {
  const data = await request<{ task: Task }>("/api/tasks", {
    method: "POST",
    body: JSON.stringify({ projectId, ...draft, ...(threadId ? { threadId } : {}) }),
  });
  return data.task;
}

export async function updateTask(task: Task, draft: TaskDraft, threadId?: string): Promise<Task> {
  const data = await request<{ task: Task }>(`/api/tasks/${encodeURIComponent(task.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ version: task.version, ...draft, ...(threadId ? { threadId } : {}) }),
  });
  return data.task;
}

export async function moveTask(
  task: Task,
  status: TaskStatus,
  sortOrder: number,
  threadId?: string,
): Promise<Task> {
  const data = await request<{ task: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/move`,
    {
      method: "POST",
      body: JSON.stringify({ version: task.version, status, sortOrder, ...(threadId ? { threadId } : {}) }),
    },
  );
  return data.task;
}

export async function archiveTask(task: Task, threadId?: string): Promise<Task> {
  const data = await request<{ task: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/archive`,
    {
      method: "POST",
      body: JSON.stringify({ version: task.version, ...(threadId ? { threadId } : {}) }),
    },
  );
  return data.task;
}

export async function restoreTask(task: Task, threadId?: string): Promise<Task> {
  const data = await request<{ task: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/restore`,
    {
      method: "POST",
      body: JSON.stringify({ version: task.version, ...(threadId ? { threadId } : {}) }),
    },
  );
  return data.task;
}

export async function addTaskRelation(
  task: Task,
  type: IssueRelationType,
  relatedTaskId: string,
  threadId?: string,
): Promise<{ task: Task; relatedTask: Task }> {
  return request<{ task: Task; relatedTask: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/relations/${type}/${encodeURIComponent(relatedTaskId)}`,
    {
      method: "POST",
      body: JSON.stringify({ version: task.version, ...(threadId ? { threadId } : {}) }),
    },
  );
}

export async function removeTaskRelation(
  task: Task,
  type: IssueRelationType,
  relatedTaskId: string,
  threadId?: string,
): Promise<{ task: Task; relatedTask: Task }> {
  return request<{ task: Task; relatedTask: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/relations/${type}/${encodeURIComponent(relatedTaskId)}`,
    {
      method: "DELETE",
      body: JSON.stringify({ version: task.version, ...(threadId ? { threadId } : {}) }),
    },
  );
}

export async function listComments(taskId: string, signal?: AbortSignal): Promise<Comment[]> {
  const data = await request<{ comments: Comment[] }>(
    `/api/tasks/${encodeURIComponent(taskId)}/comments`,
    { signal },
  );
  return data.comments;
}

export async function createComment(taskId: string, body: string, threadId?: string): Promise<Comment> {
  const data = await request<{ comment: Comment }>(
    `/api/tasks/${encodeURIComponent(taskId)}/comments`,
    {
      method: "POST",
      body: JSON.stringify({ body, ...(threadId ? { threadId } : {}) }),
    },
  );
  return data.comment;
}

export async function updateComment(comment: Comment, body: string, threadId?: string): Promise<Comment> {
  const data = await request<{ comment: Comment }>(
    `/api/comments/${encodeURIComponent(comment.id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ version: comment.version, body, ...(threadId ? { threadId } : {}) }),
    },
  );
  return data.comment;
}

export async function deleteComment(comment: Comment, threadId?: string): Promise<void> {
  await request(`/api/comments/${encodeURIComponent(comment.id)}`, {
    method: "DELETE",
    body: JSON.stringify({ version: comment.version, ...(threadId ? { threadId } : {}) }),
  });
}

export async function listAttachments(taskId: string, signal?: AbortSignal): Promise<Attachment[]> {
  const data = await request<{ attachments: Attachment[] }>(
    `/api/tasks/${encodeURIComponent(taskId)}/attachments`,
    { signal },
  );
  return data.attachments;
}

export async function uploadAttachment(taskId: string, file: File): Promise<Attachment> {
  const data = await request<{ attachment: Attachment }>(
    `/api/tasks/${encodeURIComponent(taskId)}/attachments`,
    {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Taskboard-Filename": encodeURIComponent(file.name),
      },
      body: file,
    },
  );
  return data.attachment;
}

export async function uploadCommentAttachment(commentId: string, file: File): Promise<Attachment> {
  const data = await request<{ attachment: Attachment }>(
    `/api/comments/${encodeURIComponent(commentId)}/attachments`,
    {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Taskboard-Filename": encodeURIComponent(file.name),
      },
      body: file,
    },
  );
  return data.attachment;
}

export async function deleteAttachment(attachment: Attachment): Promise<void> {
  await request(`/api/attachments/${encodeURIComponent(attachment.id)}`, {
    method: "DELETE",
  });
}

export function attachmentContentUrl(attachment: Attachment): string {
  return `/api/attachments/${encodeURIComponent(attachment.id)}/content`;
}
