import {
  buildCodexArgs,
  buildCodexPrompt,
  normalizeCodexEvent,
  spawnCodexTurn,
} from "./ai-chat-process.mjs";

function executionWorkspace(task, project) {
  if (
    task.developmentContext?.type === "worktree"
    && typeof task.developmentContext.path === "string"
    && task.developmentContext.path
  ) {
    return task.developmentContext.path;
  }
  if (typeof project.workspacePath === "string" && project.workspacePath) {
    return project.workspacePath;
  }
  throw new Error(`Project '${project.id}' does not have a mapped workspace`);
}

export function buildAutomaticProcessingExecution({
  task,
  project,
  settings,
  manageTaskboardSkillPath,
}) {
  const workspacePath = executionWorkspace(task, project);
  const thread = {
    origin: {
      projectId: project.id,
      projectName: project.name,
      workspacePath,
      issueId: task.id,
      issueIdentifier: task.identifier,
    },
    model: settings.executionModel,
    reasoningEffort: settings.reasoningEffort,
    sandbox: "workspace-write",
    codexThreadId: null,
  };
  const message = [
    `Issue ${task.identifier} is already atomically claimed and is in progress.`,
    "Work only on this exact issue; do not select or claim another issue.",
    "Read the issue and all comments with taskctl, respect its branch or worktree,",
    "implement and verify the request, add a result comment, and move it only to in_review.",
    "Never move it directly to done.",
  ].join("\n");
  return {
    args: buildCodexArgs(thread, [], []),
    prompt: buildCodexPrompt(
      thread,
      { message, skills: [], attachmentPaths: [] },
      manageTaskboardSkillPath,
    ),
    workspacePath,
  };
}

export async function runAutomaticProcessingIssue({
  task,
  project,
  settings,
  codexExecutable,
  manageTaskboardSkillPath,
  companionUrl,
  processEnv = process.env,
  onStarted = () => {},
  onThreadId = () => {},
}) {
  const execution = buildAutomaticProcessingExecution({
    task,
    project,
    settings,
    manageTaskboardSkillPath,
  });
  let codexThreadId = null;
  let terminalOutcome = null;
  let terminalError = "";
  let inputTokens = 0;
  let outputTokens = 0;
  const { child, completion } = spawnCodexTurn({
    executable: codexExecutable,
    args: execution.args,
    prompt: execution.prompt,
    env: {
      ...processEnv,
      CODEX_TASKBOARD_URL: companionUrl,
      CODEX_TASKBOARD_COMPANION_URL: companionUrl,
    },
    onRawEvent(raw) {
      const normalized = normalizeCodexEvent(raw);
      if (!normalized) return;
      if (normalized.kind === "thread.started") {
        if (codexThreadId && codexThreadId !== normalized.threadId) {
          throw new Error("Codex returned an unexpected thread id");
        }
        codexThreadId = normalized.threadId;
        onThreadId(codexThreadId);
        return;
      }
      if (raw.type === "turn.completed") {
        terminalOutcome = "completed";
        inputTokens = Math.max(0, Math.floor(Number(raw.usage?.input_tokens) || 0));
        outputTokens = Math.max(0, Math.floor(Number(raw.usage?.output_tokens) || 0));
      } else if (raw.type === "turn.failed" || raw.type === "error") {
        terminalOutcome = "failed";
        terminalError ||= normalized.content;
      }
    },
  });

  try {
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } catch (error) {
    await completion.catch(() => {});
    throw error;
  }
  await onStarted(child);
  const result = await completion;
  if (terminalOutcome === "failed") {
    throw new Error(terminalError || "Codex reported a failed turn");
  }
  if (result.exitCode !== 0) {
    throw new Error(result.exitCode === null
      ? `Codex exited due to signal ${result.signal ?? "unknown"}`
      : `Codex exited with code ${result.exitCode}`);
  }
  if (terminalOutcome !== "completed") {
    throw new Error("Codex exited without reporting turn completion");
  }
  if (!codexThreadId) throw new Error("Codex did not provide a thread id");
  return { codexThreadId, inputTokens, outputTokens };
}
