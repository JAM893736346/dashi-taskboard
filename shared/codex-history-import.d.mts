export interface CodexHistoryThread {
  threadId: string;
  title: string;
  description: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
}

export interface CodexImportProject {
  id: string;
  workspacePath: string | null;
}

export interface CodexHistoryPreviewItem extends CodexHistoryThread {
  matchedProjectId: string | null;
  existing: boolean;
}

export function normalizeWorkspacePath(value: unknown): string | null;
export function matchCodexThreadProject(
  cwd: unknown,
  projects: CodexImportProject[],
): string | null;
export function buildCodexHistoryPreview(
  threads: CodexHistoryThread[],
  projects: CodexImportProject[],
  existingThreadIds: string[],
): CodexHistoryPreviewItem[];
