export function normalizeWorkspacePath(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const unified = value.trim().replace(/\\/g, "/");
  const driveMatch = /^([a-zA-Z]):(?:\/|$)/.exec(unified);
  const drive = driveMatch ? driveMatch[1].toUpperCase() : null;
  const absolute = drive !== null || unified.startsWith("/");
  if (!absolute) return null;

  const body = drive ? unified.slice(driveMatch[0].length) : unified.slice(1);
  const segments = [];
  for (const segment of body.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  if (drive) {
    return segments.length > 0
      ? `${drive}:/${segments.join("/").toLowerCase()}`
      : `${drive}:/`;
  }
  return `/${segments.join("/")}`.replace(/^\/$|\/$/g, "") || "/";
}

function workspaceContains(root, cwd) {
  return cwd === root || cwd.startsWith(root.endsWith("/") ? root : `${root}/`);
}

export function matchCodexThreadProject(cwd, projects) {
  const normalizedCwd = normalizeWorkspacePath(cwd);
  if (!normalizedCwd) return null;
  const candidates = projects.flatMap((project) => {
    const workspacePath = normalizeWorkspacePath(project.workspacePath);
    return workspacePath ? [{ id: project.id, workspacePath }] : [];
  });
  const exact = candidates.find((project) => project.workspacePath === normalizedCwd);
  if (exact) return exact.id;
  return candidates
    .filter((project) => workspaceContains(project.workspacePath, normalizedCwd))
    .sort((left, right) => right.workspacePath.length - left.workspacePath.length)[0]?.id ?? null;
}

export function buildCodexHistoryPreview(threads, projects, existingThreadIds) {
  const existing = new Set(existingThreadIds);
  return threads.map((thread) => ({
    ...thread,
    matchedProjectId: matchCodexThreadProject(thread.cwd, projects),
    existing: existing.has(thread.threadId),
  }));
}
