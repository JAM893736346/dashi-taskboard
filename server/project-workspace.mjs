import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, realpath, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class ProjectWorkspaceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ProjectWorkspaceError";
    this.status = status;
    this.code = code;
  }
}

export function projectDirectoryName(name) {
  if (typeof name !== "string") {
    throw new ProjectWorkspaceError(400, "INVALID_PROJECT_NAME", "Project name is required");
  }
  const normalized = name.normalize("NFKC").trim().replace(/\s+/g, " ");
  const safe = normalized
    .replace(/[\\/:\0]/g, "-")
    .replace(/^\.+|[ .]+$/g, "")
    .slice(0, 80);
  if (!safe) {
    throw new ProjectWorkspaceError(
      400,
      "INVALID_PROJECT_NAME",
      "Project name cannot be converted to a directory name",
    );
  }
  return safe;
}

export function projectIdFromName(name, nonce = randomUUID()) {
  const prefix = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "project";
  const suffix = String(nonce).replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 8);
  return `${prefix.slice(0, 54).replace(/-+$/g, "")}-${suffix || randomUUID().slice(0, 8)}`;
}

export async function canonicalWorkspacePath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) return null;
  try {
    return await realpath(value);
  } catch {
    return path.resolve(value);
  }
}

export async function matchCodexProjectByWorkspace(workspaces, workspacePath) {
  const expected = await canonicalWorkspacePath(workspacePath);
  if (!expected) return null;
  for (const [codexProjectId, candidate] of Object.entries(workspaces)) {
    if (await canonicalWorkspacePath(candidate) === expected) return codexProjectId;
  }
  return null;
}

export async function chooseProjectParent({
  platform = process.platform,
  run = execFileAsync,
} = {}) {
  if (platform !== "darwin") {
    throw new ProjectWorkspaceError(
      501,
      "DIRECTORY_PICKER_UNAVAILABLE",
      "The native directory picker is currently available only on macOS",
    );
  }
  try {
    const { stdout } = await run("/usr/bin/osascript", [
      "-e",
      'POSIX path of (choose folder with prompt "Choose a parent directory for the project")',
    ]);
    return (await canonicalWorkspacePath(stdout.trim())) ?? null;
  } catch (error) {
    if (error?.code === 1 && String(error.stderr ?? "").includes("-128")) return null;
    throw new ProjectWorkspaceError(
      502,
      "DIRECTORY_PICKER_FAILED",
      "Unable to open the native directory picker",
    );
  }
}

export async function previewProjectWorkspace({ name, parentPath }) {
  const parent = await canonicalWorkspacePath(parentPath);
  if (!parent) {
    throw new ProjectWorkspaceError(
      400,
      "INVALID_PARENT_DIRECTORY",
      "Parent directory must be an absolute path",
    );
  }
  let parentStats;
  try {
    parentStats = await stat(parent);
  } catch {
    throw new ProjectWorkspaceError(
      400,
      "INVALID_PARENT_DIRECTORY",
      "Parent directory does not exist",
    );
  }
  if (!parentStats.isDirectory()) {
    throw new ProjectWorkspaceError(
      400,
      "INVALID_PARENT_DIRECTORY",
      "Parent path must be a directory",
    );
  }
  const directoryName = projectDirectoryName(name);
  return { directoryName, workspacePath: path.join(parent, directoryName) };
}

export async function createProjectWorkspace({
  name,
  parentPath,
  createBusinessProject,
  saveDeviceLink,
}) {
  const preview = await previewProjectWorkspace({ name, parentPath });
  const id = projectIdFromName(name);
  try {
    await mkdir(preview.workspacePath, { recursive: false });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new ProjectWorkspaceError(
        409,
        "PROJECT_DIRECTORY_EXISTS",
        "The generated project directory already exists",
      );
    }
    if (error?.code === "EACCES" || error?.code === "EPERM") {
      throw new ProjectWorkspaceError(
        403,
        "PROJECT_DIRECTORY_PERMISSION_DENIED",
        "The project directory cannot be created in the selected parent",
      );
    }
    throw error;
  }

  let project;
  try {
    project = await createBusinessProject({
      id,
      name: name.trim(),
      workspacePath: preview.workspacePath,
    });
  } catch (error) {
    await rmdir(preview.workspacePath).catch(() => {});
    throw error;
  }

  const link = await saveDeviceLink(id, {
    workspacePath: preview.workspacePath,
    codexProjectId: null,
  });
  return { project, link };
}
