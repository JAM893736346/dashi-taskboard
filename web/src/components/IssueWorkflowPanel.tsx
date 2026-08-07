import { useEffect, useState } from "react";

import {
  ApiError,
  enqueueWorkflowRevision,
  generateWorkflowRevision,
  getIssueWorkflow,
} from "../api";
import type {
  IssueWorkflowSnapshot,
  Task,
  WorkflowNodeStatus,
  WorkflowOption,
  WorkflowReviewFinding,
  WorkflowRunStatus,
  WorkflowValidationError,
} from "../types";
import { LinearIcon } from "./LinearIcon";

interface IssueWorkflowPanelProps {
  task: Task;
  workflows: WorkflowOption[];
  revision: number;
  onOpenThread: (threadId: string) => void;
  onError: (message: string) => void;
  onAnnounce: (message: string) => void;
}

const REVISION_STATUS_LABELS = {
  draft: "草稿",
  reviewing: "正在审查",
  ready: "可运行",
} as const;

const RUN_STATUS_LABELS: Record<WorkflowRunStatus, string> = {
  queued: "待运行",
  running: "运行中",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const NODE_STATUS_LABELS: Record<WorkflowNodeStatus, string> = {
  blocked: "等待依赖",
  ready: "就绪",
  running: "运行中",
  awaiting_confirmation: "等待确认",
  succeeded: "已完成",
  rejected: "已拒绝",
  failed: "失败",
  interrupted: "已中断",
  recovery_required: "需要恢复",
  migration_required: "需要迁移",
  cancelled: "已取消",
};

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Workflow 操作未完成，请重试。";
}

function initialTemplateId(task: Task, workflows: WorkflowOption[]): string {
  if (task.workflowId && workflows.some((workflow) => workflow.id === task.workflowId)) {
    return task.workflowId;
  }
  return workflows[0]?.id ?? "";
}

function findingMeta(finding: WorkflowReviewFinding | WorkflowValidationError): string {
  if ("severity" in finding) {
    return [finding.severity, finding.nodeId].filter(Boolean).join(" · ");
  }
  return [finding.code, finding.path].filter(Boolean).join(" · ");
}

export function IssueWorkflowPanel({
  task,
  workflows,
  revision,
  onOpenThread,
  onError,
  onAnnounce,
}: IssueWorkflowPanelProps) {
  const [snapshot, setSnapshot] = useState<IssueWorkflowSnapshot | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState(
    () => initialTemplateId(task, workflows),
  );
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<"generate" | "enqueue" | null>(null);

  useEffect(() => {
    if (workflows.some((workflow) => workflow.id === selectedTemplateId)) return;
    setSelectedTemplateId(initialTemplateId(task, workflows));
  }, [selectedTemplateId, task, workflows]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void getIssueWorkflow(task.id, controller.signal).then(
      (nextSnapshot) => {
        setSnapshot(nextSnapshot);
        setLoading(false);
      },
      (error) => {
        if ((error as Error).name === "AbortError") return;
        onError(messageFor(error));
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [onError, revision, task.id]);

  const selectedRevision = snapshot?.revisions.find(
    (candidate) => candidate.templateId === selectedTemplateId,
  ) ?? null;
  const reviewFindings = selectedRevision?.reviewReport?.findings
    ?? selectedRevision?.validationErrors
    ?? [];
  const activeRun = snapshot?.activeRun ?? null;
  const nodeDefinitions = new Map(
    activeRun?.effectiveGraph.nodes.map((node) => [node.id, node]) ?? [],
  );

  async function generateRevision() {
    if (!selectedTemplateId) return;
    setPendingAction("generate");
    try {
      const nextRevision = await generateWorkflowRevision(task.id, selectedTemplateId);
      setSnapshot((current) => current ? {
        ...current,
        revisions: [
          nextRevision,
          ...current.revisions.filter((candidate) => candidate.id !== nextRevision.id),
        ],
      } : current);
      onAnnounce(`Workflow 修订版 ${nextRevision.revision} 正在审查。`);
    } catch (error) {
      onError(messageFor(error));
    } finally {
      setPendingAction(null);
    }
  }

  async function enqueueRevision() {
    if (!selectedRevision || selectedRevision.status !== "ready") return;
    setPendingAction("enqueue");
    try {
      const run = await enqueueWorkflowRevision(selectedRevision.id);
      setSnapshot((current) => current ? { ...current, activeRun: run } : current);
      onAnnounce(`Workflow 修订版 ${selectedRevision.revision} 已放入待办队列。`);
    } catch (error) {
      onError(messageFor(error));
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <section className="issue-workflow-panel" aria-label={`${task.identifier} Workflow`}>
      <div className="issue-workflow-controls">
        <label className="issue-workflow-template-field">
          <span>Workflow 模板</span>
          <select
            value={selectedTemplateId}
            disabled={workflows.length === 0 || pendingAction !== null}
            onChange={(event) => setSelectedTemplateId(event.target.value)}
          >
            {workflows.map((workflow) => (
              <option value={workflow.id} key={workflow.id}>{workflow.name}</option>
            ))}
          </select>
        </label>
        <div className="issue-workflow-actions">
          <button
            className="button secondary"
            type="button"
            disabled={(
              !selectedTemplateId
              || pendingAction !== null
              || selectedRevision?.status === "reviewing"
            )}
            onClick={() => void generateRevision()}
          >
            <LinearIcon name="write" />
            {pendingAction === "generate" ? "正在生成…" : "生成并审查"}
          </button>
          <button
            className="button primary"
            type="button"
            disabled={(
              selectedRevision?.status !== "ready"
              || pendingAction !== null
              || activeRun !== null
            )}
            onClick={() => void enqueueRevision()}
          >
            <LinearIcon name="play" />
            {pendingAction === "enqueue" ? "正在放入…" : "放入待办队列"}
          </button>
        </div>
      </div>

      {loading && !snapshot ? (
        <div className="issue-workflow-loading" aria-live="polite">正在加载 Workflow…</div>
      ) : workflows.length === 0 ? (
        <div className="issue-workflow-empty">当前项目没有 Workflow 模板。</div>
      ) : (
        <>
          <section className="issue-workflow-revision" aria-labelledby="workflow-revision-heading">
            <header>
              <div>
                <span>当前修订版</span>
                <h2 id="workflow-revision-heading">
                  {selectedRevision ? `修订版 ${selectedRevision.revision}` : "尚未生成"}
                </h2>
              </div>
              {selectedRevision && (
                <span className={`workflow-state is-${selectedRevision.status}`}>
                  {REVISION_STATUS_LABELS[selectedRevision.status]}
                </span>
              )}
            </header>

            {selectedRevision ? (
              <>
                <div className="issue-workflow-chat-links" aria-label="审查 Chat">
                  <button
                    type="button"
                    disabled={!selectedRevision.plannerThreadId}
                    title={selectedRevision.plannerThreadId ?? "Planner Chat 尚未创建"}
                    onClick={() => selectedRevision.plannerThreadId
                      && onOpenThread(selectedRevision.plannerThreadId)}
                  >
                    <LinearIcon name="conversation" />
                    Planner Chat
                  </button>
                  <button
                    type="button"
                    disabled={!selectedRevision.reviewerThreadId}
                    title={selectedRevision.reviewerThreadId ?? "Reviewer Chat 尚未创建"}
                    onClick={() => selectedRevision.reviewerThreadId
                      && onOpenThread(selectedRevision.reviewerThreadId)}
                  >
                    <LinearIcon name="conversation" />
                    Reviewer Chat
                  </button>
                </div>

                {selectedRevision.reviewReport && (
                  <div className="issue-workflow-review">
                    <h3>审查结果</h3>
                    <p>{selectedRevision.reviewReport.summary}</p>
                    {reviewFindings.length > 0 && (
                      <ul>
                        {reviewFindings.map((finding, index) => (
                          <li key={`${findingMeta(finding)}-${index}`}>
                            <span>{findingMeta(finding)}</span>
                            <p>{finding.message}</p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </>
            ) : (
              <p className="issue-workflow-empty-copy">此模板尚无 Issue 修订版。</p>
            )}
          </section>

          {activeRun && (
            <section className="issue-workflow-run-summary" aria-labelledby="workflow-run-heading">
              <header>
                <div>
                  <span>持久化运行</span>
                  <h2 id="workflow-run-heading">运行修订版 {activeRun.run.workflowRevision}</h2>
                </div>
                <span className={`workflow-state is-${activeRun.run.status}`}>
                  {RUN_STATUS_LABELS[activeRun.run.status]}
                </span>
              </header>
              <ul>
                {activeRun.nodes.map((node) => (
                  <li key={node.id}>
                    <span className={`workflow-node-status is-${node.status}`} aria-hidden="true" />
                    <strong>{nodeDefinitions.get(node.definitionId)?.title ?? node.definitionId}</strong>
                    <span>{NODE_STATUS_LABELS[node.status]}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </section>
  );
}
