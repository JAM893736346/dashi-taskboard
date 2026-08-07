import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const AUTHORITY_NOTICE = [
  "> SQLite is authoritative for workflow state.",
  "> Agents have read-only access to this shared projection.",
  "",
].join("\n");

function renderTaskPlan(snapshot) {
  const graph = snapshot.effectiveGraph ?? snapshot.run.graphSnapshot;
  const nodes = snapshot.nodes.map((node) => (
    `- ${node.definitionId} (${node.type}): ${node.status}`
  ));
  return [
    "# Workflow Run Plan",
    "",
    AUTHORITY_NOTICE,
    "## Goal",
    "",
    graph.goal,
    "",
    "## Formal Nodes",
    "",
    ...(nodes.length > 0 ? nodes : ["- None"]),
    "",
  ].join("\n");
}

function renderFindings(snapshot) {
  const findings = snapshot.handoffs.flatMap((handoff) => {
    const payload = handoff.payload ?? {};
    const conclusions = Array.isArray(payload.conclusions) ? payload.conclusions : [];
    const risks = Array.isArray(payload.risks) ? payload.risks : [];
    return [
      ...conclusions.map((value) => `- Conclusion: ${String(value)}`),
      ...risks.map((value) => `- Risk: ${String(value)}`),
    ];
  });
  return [
    "# Workflow Findings",
    "",
    AUTHORITY_NOTICE,
    "## Immutable Handoff Conclusions And Risks",
    "",
    ...(findings.length > 0 ? findings : ["- None"]),
    "",
  ].join("\n");
}

function renderProgress(snapshot) {
  const attempts = snapshot.attempts.map((attempt) => (
    `- Attempt ${attempt.id}: node ${attempt.nodeRunId}, #${attempt.attemptNumber}, ${attempt.status}`
  ));
  const events = snapshot.events.map((event) => (
    `- ${event.createdAt} ${event.type}${event.nodeRunId ? ` (${event.nodeRunId})` : ""}`
  ));
  return [
    "# Workflow Progress",
    "",
    AUTHORITY_NOTICE,
    "## Attempts",
    "",
    ...(attempts.length > 0 ? attempts : ["- None"]),
    "",
    "## Events",
    "",
    ...(events.length > 0 ? events : ["- None"]),
    "",
  ].join("\n");
}

export class WorkflowPlanningProjection {
  constructor(dataDirectory) {
    this.rootDirectory = path.resolve(dataDirectory, "workflow-runs");
  }

  pathFor(runId) {
    return path.join(this.rootDirectory, runId, "planning-with-files");
  }

  async initialize(runSnapshot) {
    return this.refresh(runSnapshot);
  }

  async refresh(runSnapshot) {
    const directory = this.pathFor(runSnapshot.run.id);
    await mkdir(directory, { recursive: true });
    const files = [
      ["task_plan.md", renderTaskPlan(runSnapshot)],
      ["findings.md", renderFindings(runSnapshot)],
      ["progress.md", renderProgress(runSnapshot)],
    ];
    await Promise.all(files.map(async ([name, contents]) => {
      const temporaryPath = path.join(directory, `.${name}.${randomUUID()}.tmp`);
      await writeFile(temporaryPath, contents, "utf8");
      await rename(temporaryPath, path.join(directory, name));
    }));
    return directory;
  }
}
