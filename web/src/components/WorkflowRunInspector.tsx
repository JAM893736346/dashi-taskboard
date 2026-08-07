import { useEffect, useMemo, useState } from "react";

import {
  ApiError,
  applyWorkflowAmendment,
  controlWorkflowNode,
  createWorkflowAmendment,
  sendWorkflowNodeMessage,
} from "../api";
import type {
  WorkflowAmendmentInput,
  WorkflowNodeControlAction,
  WorkflowNodeRun,
  WorkflowRunSnapshot,
  WorkflowRuntimeNodeDefinition,
} from "../types";
import { LinearIcon } from "./LinearIcon";

type InspectorTab = "inbox" | "attempts" | "subagents" | "events";
type ComposerMode = "steer" | "queued" | "task";
type TaskMode = "direct" | "generated";
type ConditionField = "summary" | "conclusions" | "changedFiles" | "artifacts" | "verification" | "unresolved" | "risks";
type ConditionOperator = "equals" | "not-equals" | "contains" | "not-contains";

const CONDITION_FIELDS: Array<{ value: ConditionField; label: string }> = [
  { value: "summary", label: "摘要" },
  { value: "conclusions", label: "结论" },
  { value: "changedFiles", label: "变更文件" },
  { value: "artifacts", label: "产物" },
  { value: "verification", label: "验证" },
  { value: "unresolved", label: "未解决项" },
  { value: "risks", label: "风险" },
];

const CONDITION_OPERATORS: Array<{ value: ConditionOperator; label: string }> = [
  { value: "equals", label: "等于" },
  { value: "not-equals", label: "不等于" },
  { value: "contains", label: "包含" },
  { value: "not-contains", label: "不包含" },
];

interface WorkflowRunInspectorProps {
  snapshot: WorkflowRunSnapshot;
  selectedNodeRunId: string | null;
  initialTab?: InspectorTab;
  onSnapshotChange: (snapshot: WorkflowRunSnapshot) => void;
  onOpenThread: (threadId: string) => void;
  onError: (message: string) => void;
  onAnnounce: (message: string) => void;
}

const TABS: Array<{ id: InspectorTab; label: string }> = [
  { id: "inbox", label: "收件箱" },
  { id: "attempts", label: "尝试" },
  { id: "subagents", label: "Subagents" },
  { id: "events", label: "事件" },
];

function messageFor(error: unknown) {
  return error instanceof Error ? error.message : "Workflow 操作未完成，请重试。";
}

function initialNode(snapshot: WorkflowRunSnapshot, selectedNodeRunId: string | null) {
  return snapshot.nodes.find((node) => node.id === selectedNodeRunId) ?? snapshot.nodes[0] ?? null;
}

function directNode(input: {
  primitive: WorkflowRuntimeNodeDefinition["type"];
  objective: string;
  dependsOn: string[];
  model: string;
  effort: string;
  resourceMode: "shared" | "exclusive";
  approvalMode: "automatic" | "manual";
  conditionField: ConditionField;
  conditionOperator: ConditionOperator;
  conditionValue: string;
  conditionSourceNodeId: string;
}): WorkflowRuntimeNodeDefinition {
  const config = input.primitive === "codex-thread"
    ? { rolePreset: "custom", model: input.model || null, effort: input.effort || null, sandbox: "workspaceWrite", outputSchema: null }
    : input.primitive === "human-gate"
      ? { message: input.objective }
      : input.primitive === "condition"
        ? {
          sourceNodeId: input.conditionSourceNodeId || input.dependsOn[0],
          field: input.conditionField,
          operator: input.conditionOperator,
          value: input.conditionValue,
        }
        : { action: "set-status", status: "in_review" };
  return {
    id: `amendment-${crypto.randomUUID()}`,
    type: input.primitive,
    executorVersion: 1,
    title: input.objective.slice(0, 80) || "新增任务",
    objective: input.objective,
    dependsOn: input.dependsOn.map((nodeId) => ({ nodeId })),
    approvalMode: input.approvalMode,
    config,
    resources: [{ key: "workspace", mode: input.resourceMode }],
  };
}

export function WorkflowRunInspector({
  snapshot,
  selectedNodeRunId,
  initialTab,
  onSnapshotChange,
  onOpenThread,
  onError,
  onAnnounce,
}: WorkflowRunInspectorProps) {
  const [tab, setTab] = useState<InspectorTab>(initialTab ?? "inbox");
  const [composerMode, setComposerMode] = useState<ComposerMode>("steer");
  const [taskMode, setTaskMode] = useState<TaskMode>("direct");
  const [message, setMessage] = useState("");
  const [objective, setObjective] = useState("");
  const [prompt, setPrompt] = useState("");
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [primitive, setPrimitive] = useState<WorkflowRuntimeNodeDefinition["type"]>("codex-thread");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [resourceMode, setResourceMode] = useState<"shared" | "exclusive">("exclusive");
  const [approvalMode, setApprovalMode] = useState<"automatic" | "manual">("automatic");
  const [conditionField, setConditionField] = useState<ConditionField>("summary");
  const [conditionOperator, setConditionOperator] = useState<ConditionOperator>("contains");
  const [conditionValue, setConditionValue] = useState("");
  const [conditionSourceNodeId, setConditionSourceNodeId] = useState("");
  const [pending, setPending] = useState(false);
  const node = initialNode(snapshot, selectedNodeRunId);
  const definitions = useMemo(() => new Map(snapshot.effectiveGraph.nodes.map((definition) => [definition.id, definition])), [snapshot]);
  const attempts = node ? snapshot.attempts.filter((attempt) => attempt.nodeRunId === node.id) : [];
  const activeAttempt = node?.activeAttemptId ? snapshot.attempts.find((attempt) => attempt.id === node.activeAttemptId) ?? null : null;
  const threadId = activeAttempt?.threadId ?? null;
  const canInterrupt = activeAttempt?.status === "running" && Boolean(activeAttempt.turnId);
  const retryable = node?.status === "rejected" || node?.status === "failed" || node?.status === "interrupted" || node?.status === "recovery_required";
  const nonterminal = node && !["succeeded", "rejected", "failed", "interrupted", "recovery_required", "migration_required", "cancelled"].includes(node.status);

  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);

  async function control(action: WorkflowNodeControlAction) {
    if (!node) return;
    setPending(true);
    try {
      onSnapshotChange(await controlWorkflowNode(node.id, action));
      onAnnounce(`已请求 ${action}。`);
    } catch (error) {
      onError(messageFor(error));
    } finally {
      setPending(false);
    }
  }

  async function submitMessage() {
    if (!node || !message.trim() || composerMode === "task") return;
    setPending(true);
    try {
      const result = await sendWorkflowNodeMessage(node.id, { mode: composerMode, content: message.trim() });
      onSnapshotChange(result.snapshot);
      setMessage("");
      onAnnounce(composerMode === "steer" ? "引导已发送。" : "消息已加入收件箱。");
    } catch (error) {
      if (error instanceof ApiError && Boolean((error.details as { formalTaskRequired?: boolean } | undefined)?.formalTaskRequired)) {
        setComposerMode("task");
        setObjective(message);
      }
      onError(messageFor(error));
    } finally {
      setPending(false);
    }
  }

  async function submitAmendment() {
    const requiresConditionDependency = primitive === "condition" && dependsOn.length === 0;
    const input: WorkflowAmendmentInput = taskMode === "direct"
      ? {
        source: "user_configured",
        node: directNode({
          primitive,
          objective: objective.trim(),
          dependsOn,
          model,
          effort,
          resourceMode,
          approvalMode,
          conditionField,
          conditionOperator,
          conditionValue,
          conditionSourceNodeId,
        }),
      }
      : { source: "codex_generated", prompt: prompt.trim(), dependsOn };
    if (
      (taskMode === "direct" && (!objective.trim() || requiresConditionDependency))
      || (taskMode === "generated" && !prompt.trim())
    ) return;
    setPending(true);
    try {
      const amendment = await createWorkflowAmendment(snapshot.run.id, input);
      onSnapshotChange({ ...snapshot, amendments: [amendment, ...snapshot.amendments] });
      setObjective("");
      setPrompt("");
      onAnnounce("新增任务已提交审查。");
    } catch (error) {
      onError(messageFor(error));
    } finally {
      setPending(false);
    }
  }

  async function apply(amendmentId: string) {
    setPending(true);
    try {
      onSnapshotChange(await applyWorkflowAmendment(amendmentId));
      onAnnounce("修订已应用到运行流程。");
    } catch (error) {
      onError(messageFor(error));
    } finally {
      setPending(false);
    }
  }

  if (!node) return <aside className="workflow-runtime-inspector">没有可检查的运行节点。</aside>;
  const definition = definitions.get(node.definitionId);
  const inbox = snapshot.inbox.filter((entry) => entry.targetNodeRunId === node.id).sort((a, b) => a.sequence - b.sequence);
  const subagents = snapshot.subagents.filter((subagent) => subagent.nodeRunId === node.id);
  const events = snapshot.events.filter((event) => event.nodeRunId === node.id);

  return (
    <aside className="workflow-runtime-inspector" aria-label="运行检查器">
      <header className="workflow-runtime-inspector-header">
        <div>
          <span>{node.status}</span>
          <h3>{definition?.title ?? node.definitionId}</h3>
          <p>{typeof node.config.model === "string" ? node.config.model : snapshot.effectiveGraph.defaults.model} · {typeof node.config.effort === "string" ? node.config.effort : snapshot.effectiveGraph.defaults.effort}</p>
        </div>
        <button className="workflow-runtime-icon-button" type="button" disabled={!threadId} title={threadId ? "打开 Chat" : "此节点尚未创建 Chat"} onClick={() => threadId && onOpenThread(threadId)}>
          <LinearIcon name="conversation" />
        </button>
      </header>
      <div className="workflow-runtime-controls-row">
        {node.status === "awaiting_confirmation" && <><button type="button" disabled={pending} onClick={() => void control("approve")}>批准</button><button type="button" disabled={pending} onClick={() => void control("reject")}>拒绝</button></>}
        {canInterrupt && <button type="button" disabled={pending} onClick={() => void control("interrupt")}>中断</button>}
        {retryable && <button type="button" disabled={pending} onClick={() => void control("retry")}>重试</button>}
        {nonterminal && <button type="button" disabled={pending} onClick={() => void control("cancel")}>取消</button>}
      </div>
      <div className="workflow-runtime-tabs" role="tablist">
        {TABS.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? "is-active" : ""} onClick={() => setTab(item.id)}>{item.label}</button>)}
      </div>
      <div className="workflow-runtime-tab-content">
        {tab === "inbox" && <ul>{inbox.map((entry) => <li key={entry.id}><strong>#{entry.sequence} · {entry.mode}</strong><p>{entry.content}</p><span>{entry.status}</span></li>)}{inbox.length === 0 && <li>暂无消息。</li>}</ul>}
        {tab === "attempts" && <ul>{attempts.map((attempt) => <li key={attempt.id}><strong>尝试 {attempt.attemptNumber} · {attempt.status}</strong><p title={attempt.threadId ?? ""}>{attempt.threadId ?? "未绑定 Chat"}</p></li>)}</ul>}
        {tab === "subagents" && <ul>{subagents.map((subagent) => <li key={subagent.id}><strong>{subagent.role ?? "Subagent"} · {subagent.status}</strong><button type="button" onClick={() => onOpenThread(subagent.threadId)}>{subagent.threadId}</button></li>)}{subagents.length === 0 && <li>暂无 Subagent。</li>}</ul>}
        {tab === "events" && <ul>{events.map((event) => <li key={event.id}><strong>{event.type}</strong><p>{event.createdAt}</p></li>)}{events.length === 0 && <li>暂无事件。</li>}</ul>}
      </div>
      <section className="workflow-runtime-composer" aria-label="运行输入">
        <div className="workflow-runtime-segmented" role="tablist" aria-label="输入模式">
          <button type="button" className={composerMode === "steer" ? "is-active" : ""} onClick={() => setComposerMode("steer")}>立即引导</button>
          <button type="button" className={composerMode === "queued" ? "is-active" : ""} onClick={() => setComposerMode("queued")}>下一轮消息</button>
          <button type="button" className={composerMode === "task" ? "is-active" : ""} onClick={() => setComposerMode("task")}>新增任务</button>
        </div>
        {composerMode !== "task" ? <><textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder={composerMode === "steer" ? "发送即时引导" : "加入下一轮消息"} /><button type="button" disabled={pending || !message.trim()} onClick={() => void submitMessage()}>{composerMode === "steer" ? "发送引导" : "加入队列"}</button></> : <>
          <div className="workflow-runtime-task-mode"><button type="button" className={taskMode === "direct" ? "is-active" : ""} onClick={() => setTaskMode("direct")}>直接配置</button><button type="button" className={taskMode === "generated" ? "is-active" : ""} onClick={() => setTaskMode("generated")}>Codex 生成</button></div>
          {taskMode === "direct" ? <>
            <label>原语<select value={primitive} onChange={(event) => setPrimitive(event.target.value as WorkflowRuntimeNodeDefinition["type"])}><option value="codex-thread">Codex Chat</option><option value="human-gate">人工确认</option><option value="condition">条件</option><option value="issue-action">Issue 操作</option></select></label>
            <textarea value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="任务目标" />
            <div className="workflow-runtime-direct-fields"><label>模型<input value={model} onChange={(event) => setModel(event.target.value)} placeholder="默认" /></label><label>推理<input value={effort} onChange={(event) => setEffort(event.target.value)} placeholder="默认" /></label><label>资源<select value={resourceMode} onChange={(event) => setResourceMode(event.target.value as "shared" | "exclusive")}><option value="exclusive">独占</option><option value="shared">共享</option></select></label><label>审批<select value={approvalMode} onChange={(event) => setApprovalMode(event.target.value as "automatic" | "manual")}><option value="automatic">自动</option><option value="manual">手动</option></select></label></div>
          </> : <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="描述要生成的任务" />}
          <label>依赖<select multiple value={dependsOn} onChange={(event) => {
            const nextDependsOn = Array.from(event.target.selectedOptions, (option) => option.value);
            setDependsOn(nextDependsOn);
            setConditionSourceNodeId((current) => nextDependsOn.includes(current) ? current : nextDependsOn[0] ?? "");
          }}>{snapshot.effectiveGraph.nodes.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}</select></label>
          {taskMode === "direct" && primitive === "condition" && <div className="workflow-runtime-condition-fields"><label>来源<select value={conditionSourceNodeId} onChange={(event) => setConditionSourceNodeId(event.target.value)}>{dependsOn.map((dependencyId) => <option key={dependencyId} value={dependencyId}>{definitions.get(dependencyId)?.title ?? dependencyId}</option>)}</select></label><label>字段<select value={conditionField} onChange={(event) => setConditionField(event.target.value as ConditionField)}>{CONDITION_FIELDS.map((field) => <option key={field.value} value={field.value}>{field.label}</option>)}</select></label><label>运算符<select value={conditionOperator} onChange={(event) => setConditionOperator(event.target.value as ConditionOperator)}>{CONDITION_OPERATORS.map((operator) => <option key={operator.value} value={operator.value}>{operator.label}</option>)}</select></label><label>值<input value={conditionValue} onChange={(event) => setConditionValue(event.target.value)} /></label></div>}
          <button type="button" disabled={pending || (taskMode === "direct" ? (!objective.trim() || (primitive === "condition" && dependsOn.length === 0)) : !prompt.trim())} onClick={() => void submitAmendment()}>提交审查</button>
        </>}
      </section>
      {snapshot.amendments.filter((amendment) => amendment.status === "ready").map((amendment) => <button className="workflow-runtime-apply" type="button" disabled={pending} key={amendment.id} onClick={() => void apply(amendment.id)}>应用到流程 · 修订 {amendment.revision}</button>)}
    </aside>
  );
}
