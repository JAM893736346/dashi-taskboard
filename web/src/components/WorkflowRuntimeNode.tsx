import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

import type {
  WorkflowNodeAttempt,
  WorkflowNodeRun,
  WorkflowNodeStatus,
  WorkflowRuntimeNodeDefinition,
  WorkflowSubagent,
} from "../types";
import { LinearIcon } from "./LinearIcon";

export interface WorkflowRuntimeNodeData extends Record<string, unknown> {
  kind: "formal" | "subagent";
  definition?: WorkflowRuntimeNodeDefinition;
  node?: WorkflowNodeRun;
  attempt?: WorkflowNodeAttempt | null;
  subagent?: WorkflowSubagent;
  model?: string;
  effort?: string;
  inboxCount?: number;
  subagents?: WorkflowSubagent[];
  expanded?: boolean;
  onToggleSubagents?: () => void;
}

export type WorkflowRuntimeFlowNode = Node<WorkflowRuntimeNodeData, "workflowRuntime">;

const STATUS_LABELS: Record<WorkflowNodeStatus, string> = {
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

const PRIMITIVE_LABELS = {
  "codex-thread": "Codex Chat",
  "human-gate": "人工确认",
  condition: "条件",
  "issue-action": "Issue 操作",
} as const;

function shortId(value: string | null | undefined) {
  if (!value) return "未绑定";
  return value.length > 14 ? `${value.slice(0, 7)}…${value.slice(-5)}` : value;
}

function resourceSummary(resources: WorkflowNodeRun["resources"]) {
  if (resources.length === 0) return "无资源锁";
  return resources.map((resource) => `${resource.key} · ${resource.mode === "exclusive" ? "独占" : "共享"}`).join("，");
}

function statusIcon(status: WorkflowNodeStatus) {
  if (status === "succeeded") return "check" as const;
  if (status === "failed" || status === "rejected" || status === "recovery_required") return "alert" as const;
  if (status === "cancelled" || status === "interrupted") return "close" as const;
  return "status" as const;
}

export function WorkflowRuntimeNode({ data, selected }: NodeProps<WorkflowRuntimeFlowNode>) {
  if (data.kind === "subagent" && data.subagent) {
    const subagent = data.subagent;
    const summary = typeof subagent.result?.summary === "string" ? subagent.result.summary : "等待结果";
    const activity = typeof subagent.activity?.message === "string" ? subagent.activity.message : subagent.status;
    return (
      <article className={`workflow-runtime-subagent is-${subagent.status}${selected ? " is-selected" : ""}`} title={subagent.threadId}>
        <LinearIcon name="conversation" />
        <div>
          <strong>{subagent.role ?? "Subagent"}</strong>
          <span>{shortId(subagent.threadId)} · {subagent.model ?? "默认模型"} · {subagent.status}</span>
          <p title={`${activity} · ${summary}`}>{activity} · {summary}</p>
        </div>
      </article>
    );
  }

  const { definition, node, attempt, subagents = [], expanded = false } = data;
  if (!definition || !node) return null;
  const signal = node.status === "awaiting_confirmation"
    ? "等待确认"
    : node.status === "failed" || node.status === "recovery_required"
      ? "需要处理"
      : null;
  const activeTurn = attempt?.status === "running" && attempt.turnId ? "回合进行中" : null;

  return (
    <article className={`workflow-runtime-node is-${node.status}${selected ? " is-selected" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <header>
        <span className="workflow-runtime-node-kind">{PRIMITIVE_LABELS[definition.type]}</span>
        <span className={`workflow-runtime-status is-${node.status}`} title={STATUS_LABELS[node.status]}>
          <LinearIcon name={statusIcon(node.status)} />
          {STATUS_LABELS[node.status]}
        </span>
      </header>
      <strong title={definition.title}>{definition.title}</strong>
      <div className="workflow-runtime-node-meta">
        <span title={`模型：${data.model ?? "默认"}`}>{data.model ?? "默认模型"}</span>
        <span title={`推理：${data.effort ?? "默认"}`}>{data.effort ?? "默认推理"}</span>
      </div>
      <div className="workflow-runtime-node-signals">
        <span title={`尝试 ${attempt?.attemptNumber ?? 0}`}>尝试 {attempt?.attemptNumber ?? 0}</span>
        <span title={attempt?.threadId ?? "尚未创建 Chat"}>{shortId(attempt?.threadId)}</span>
        <span title={resourceSummary(node.resources)}>{node.resources.length} 资源</span>
        <span title={`${data.inboxCount ?? 0} 条排队消息`}>{data.inboxCount ?? 0} 消息</span>
      </div>
      {(signal || activeTurn) && <p className="workflow-runtime-node-alert">{signal ?? activeTurn}</p>}
      {subagents.length > 0 && (
        <button
          type="button"
          className="workflow-runtime-subagent-toggle nodrag nopan"
          onClick={data.onToggleSubagents}
          title={expanded ? "收起 Subagents" : "展开 Subagents"}
        >
          <LinearIcon name="conversation" />
          {subagents.length} 个 Subagents {expanded ? "收起" : "展开"}
        </button>
      )}
      <Handle type="source" position={Position.Right} />
    </article>
  );
}
