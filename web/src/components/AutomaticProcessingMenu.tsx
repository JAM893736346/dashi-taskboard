import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AUTOMATION_MODELS,
  getAutomationModel,
  withAutomationModel,
  type AutomationModel,
  type AutomationReasoningEffort,
} from "../../../shared/taskboard-automation-options.mjs";
import {
  getAutomaticProcessingSettings,
  getAutomaticProcessingStatus,
  listAutomaticProcessingHistory,
  reconcileAutomaticProcessing,
  saveAutomaticProcessingProjectMapping,
  updateAutomaticProcessingSettings,
} from "../api";
import type {
  AutomaticProcessingSettings,
  AutomaticProcessingState,
  AutomationClaim,
  Project,
  TaskPriority,
} from "../types";
import { LinearIcon } from "./LinearIcon";

interface AutomaticProcessingMenuProps {
  projects: Project[];
  workspacePaths: Record<string, string>;
  available: boolean;
}

const STATE_LABELS: Record<AutomaticProcessingState, string> = {
  disabled: "未启用",
  idle: "等待议题",
  running: "处理中",
  quota_paused: "额度暂停",
  daily_limit: "今日已达上限",
  error: "运行异常",
};

const CLAIM_LABELS: Record<AutomationClaim["status"], string> = {
  claimed: "已认领",
  running: "处理中",
  retry_wait: "等待重试",
  completed: "已完成",
  failed: "失败",
  canceled: "已取消",
};

const EFFORT_LABELS: Record<AutomationReasoningEffort, string> = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最大",
  ultra: "极致",
};

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  none: "不限",
  urgent: "紧急",
  high: "高",
  medium: "中",
  low: "低",
};

const NUMBER_FORMAT = new Intl.NumberFormat("zh-CN");

function listFromText(value: string) {
  return [...new Set(value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean))];
}

function formatTime(value: string | null) {
  if (!value) return "尚未";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDuration(claim: AutomationClaim) {
  if (!claim.startedAt) return null;
  const end = claim.finishedAt ? new Date(claim.finishedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - new Date(claim.startedAt).getTime()) / 1_000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function SettingSwitch({
  checked,
  disabled = false,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={`automatic-processing-switch${checked ? " is-on" : ""}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span aria-hidden="true" />
    </button>
  );
}

export function AutomaticProcessingMenu({
  projects,
  workspacePaths,
  available,
}: AutomaticProcessingMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8, ready: false });
  const [settings, setSettings] = useState<AutomaticProcessingSettings | null>(null);
  const [draft, setDraft] = useState<AutomaticProcessingSettings | null>(null);
  const [history, setHistory] = useState<AutomationClaim[]>([]);
  const [status, setStatus] = useState<Awaited<ReturnType<typeof getAutomaticProcessingStatus>> | null>(null);
  const [includeLabelsText, setIncludeLabelsText] = useState("");
  const [excludeLabelsText, setExcludeLabelsText] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const mappedProjects = useMemo(() => projects.flatMap((project) => {
    const workspacePath = workspacePaths[project.id] ?? project.workspacePath;
    return workspacePath ? [{ ...project, workspacePath }] : [];
  }), [projects, workspacePaths]);

  const applySettings = useCallback((next: AutomaticProcessingSettings) => {
    setSettings(next);
    setDraft({ ...next, projectIds: [...next.projectIds] });
    setIncludeLabelsText(next.includeLabels.join(", "));
    setExcludeLabelsText(next.excludeLabels.join(", "));
  }, []);

  const refreshStatus = useCallback(async (signal?: AbortSignal) => {
    const [nextStatus, nextHistory] = await Promise.all([
      getAutomaticProcessingStatus(signal),
      listAutomaticProcessingHistory(20, signal),
    ]);
    setStatus(nextStatus);
    setHistory(nextHistory);
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!available) return;
    setLoading(true);
    setError(null);
    try {
      const [nextSettings, nextStatus, nextHistory] = await Promise.all([
        getAutomaticProcessingSettings(signal),
        getAutomaticProcessingStatus(signal),
        listAutomaticProcessingHistory(20, signal),
      ]);
      applySettings(nextSettings);
      setStatus(nextStatus);
      setHistory(nextHistory);
    } catch (loadError) {
      if ((loadError as Error).name !== "AbortError") {
        setError(loadError instanceof Error ? loadError.message : "无法读取自动处理设置");
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [applySettings, available]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (!available || !settings?.enabled) return;
    const timer = window.setInterval(() => {
      void refreshStatus().catch((refreshError) => {
        setError(refreshError instanceof Error ? refreshError.message : "无法刷新自动处理状态");
      });
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [available, refreshStatus, settings?.enabled]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    const updatePosition = () => {
      const triggerRect = trigger.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const left = Math.max(8, Math.min(triggerRect.right - menuRect.width, window.innerWidth - menuRect.width - 8));
      const below = triggerRect.bottom + 8;
      const top = below + menuRect.height <= window.innerHeight - 8
        ? below
        : Math.max(8, triggerRect.top - menuRect.height - 8);
      setPosition({ left, top, ready: true });
    };
    const observer = new ResizeObserver(updatePosition);
    observer.observe(menu);
    updatePosition();
    return () => observer.disconnect();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function closeFromOutside(event: PointerEvent) {
      if (
        !menuRef.current?.contains(event.target as Node)
        && !triggerRef.current?.contains(event.target as Node)
      ) setOpen(false);
    }
    function closeFromEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    }
    function closeFromViewportChange() {
      setOpen(false);
    }
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    window.addEventListener("blur", closeFromViewportChange);
    window.addEventListener("resize", closeFromViewportChange);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
      window.removeEventListener("blur", closeFromViewportChange);
      window.removeEventListener("resize", closeFromViewportChange);
    };
  }, [open]);

  async function save() {
    if (!draft || saving) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await Promise.all(mappedProjects.map((project) => (
        saveAutomaticProcessingProjectMapping(project.id, project.workspacePath)
      )));
      const mappedIds = new Set(mappedProjects.map((project) => project.id));
      const next = await updateAutomaticProcessingSettings({
        ...draft,
        projectIds: draft.projectIds.filter((projectId) => mappedIds.has(projectId)),
        includeLabels: listFromText(includeLabelsText),
        excludeLabels: listFromText(excludeLabelsText),
      });
      applySettings(next);
      await refreshStatus();
      setSaved(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "无法保存自动处理设置");
    } finally {
      setSaving(false);
    }
  }

  async function reconcile() {
    if (reconciling) return;
    setReconciling(true);
    setError(null);
    try {
      setStatus(await reconcileAutomaticProcessing());
      setHistory(await listAutomaticProcessingHistory(20));
    } catch (reconcileError) {
      setError(reconcileError instanceof Error ? reconcileError.message : "无法执行扫描");
    } finally {
      setReconciling(false);
    }
  }

  const enabled = settings?.enabled === true;
  const state = status?.state ?? (enabled ? "idle" : "disabled");
  const stateLabel = state === "running" && status
    ? `${STATE_LABELS[state]} ${status.activeCount}/${status.maxConcurrency}`
    : STATE_LABELS[state];

  const menu = open ? createPortal(
    <div
      ref={menuRef}
      className="automatic-processing-menu no-drag"
      role="dialog"
      aria-label="自动处理设置"
      style={{
        left: position.left,
        top: position.top,
        visibility: position.ready ? "visible" : "hidden",
      }}
    >
      <div className="automatic-processing-menu-header">
        <div>
          <strong>自动处理</strong>
          <span className={`automatic-processing-state is-${state}`}>{stateLabel}</span>
        </div>
        <SettingSwitch
          checked={draft?.enabled ?? false}
          disabled={!draft || saving}
          label="自动处理"
          onChange={(checked) => setDraft((current) => current && ({ ...current, enabled: checked }))}
        />
      </div>

      {loading && !draft ? (
        <div className="automatic-processing-loading" aria-busy="true">正在读取设置…</div>
      ) : draft ? (
        <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <section className="automatic-processing-section" aria-labelledby="automatic-projects-heading">
            <div className="automatic-processing-section-heading">
              <h2 id="automatic-projects-heading">参与项目</h2>
              <span>{mappedProjects.length} 个已映射</span>
            </div>
            <div className="automatic-processing-segmented" role="group" aria-label="参与项目范围">
              <button
                type="button"
                className={draft.projectMode === "all" ? "is-selected" : ""}
                aria-pressed={draft.projectMode === "all"}
                onClick={() => setDraft((current) => current && ({ ...current, projectMode: "all" }))}
              >全部已映射</button>
              <button
                type="button"
                className={draft.projectMode === "selected" ? "is-selected" : ""}
                aria-pressed={draft.projectMode === "selected"}
                onClick={() => setDraft((current) => current && ({ ...current, projectMode: "selected" }))}
              >指定项目</button>
            </div>
            {draft.projectMode === "selected" && (
              <div className="automatic-processing-projects">
                {mappedProjects.length === 0 && <span>暂无已映射项目</span>}
                {mappedProjects.map((project) => {
                  const checked = draft.projectIds.includes(project.id);
                  return (
                    <label key={project.id}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => setDraft((current) => current && ({
                          ...current,
                          projectIds: checked
                            ? current.projectIds.filter((id) => id !== project.id)
                            : [...current.projectIds, project.id],
                        }))}
                      />
                      <span>{project.name}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </section>

          <section className="automatic-processing-section automatic-processing-grid" aria-label="执行设置">
            <label className="automatic-processing-field">
              <span>认领策略</span>
              <select
                value={draft.claimStrategy}
                onChange={(event) => setDraft({ ...draft, claimStrategy: event.target.value as AutomaticProcessingSettings["claimStrategy"] })}
              >
                <option value="board-order">看板顺序</option>
                <option value="priority-first">优先级优先</option>
                <option value="due-date-first">截止日期优先</option>
              </select>
            </label>
            <label className="automatic-processing-field">
              <span>执行模型</span>
              <select
                value={draft.executionModel}
                onChange={(event) => {
                  const model = event.target.value as AutomationModel;
                  const next = withAutomationModel({
                    model: draft.executionModel,
                    reasoningEffort: draft.reasoningEffort,
                  }, model);
                  setDraft({ ...draft, executionModel: next.model, reasoningEffort: next.reasoningEffort });
                }}
              >
                {AUTOMATION_MODELS.map((model) => <option value={model.slug} key={model.slug}>{model.label}</option>)}
              </select>
            </label>
            <label className="automatic-processing-field">
              <span>推理强度</span>
              <select
                value={draft.reasoningEffort}
                onChange={(event) => setDraft({ ...draft, reasoningEffort: event.target.value as AutomationReasoningEffort })}
              >
                {getAutomationModel(draft.executionModel).efforts.map((effort) => (
                  <option value={effort} key={effort}>{EFFORT_LABELS[effort]}</option>
                ))}
              </select>
            </label>
            <label className="automatic-processing-field">
              <span>最大并发</span>
              <input
                type="number"
                min="1"
                max="4"
                value={draft.maxConcurrency}
                onChange={(event) => setDraft({ ...draft, maxConcurrency: Number(event.target.value) })}
              />
            </label>
            <label className="automatic-processing-field">
              <span>兜底扫描间隔</span>
              <select
                value={draft.fallbackIntervalMinutes}
                onChange={(event) => setDraft({
                  ...draft,
                  fallbackIntervalMinutes: Number(event.target.value) as AutomaticProcessingSettings["fallbackIntervalMinutes"],
                })}
              >
                {[1, 5, 15, 30, 60].map((minutes) => <option value={minutes} key={minutes}>{minutes} 分钟</option>)}
              </select>
            </label>
            <label className="automatic-processing-field">
              <span>每日运行上限</span>
              <input
                type="number"
                min="1"
                max="10000"
                disabled={draft.dailyRunLimit === null}
                value={draft.dailyRunLimit ?? 10}
                onChange={(event) => setDraft({ ...draft, dailyRunLimit: Number(event.target.value) })}
              />
            </label>
            <div className="automatic-processing-toggle-row">
              <span>额度感知暂停</span>
              <SettingSwitch
                checked={draft.quotaAware}
                label="额度感知暂停"
                onChange={(checked) => setDraft({ ...draft, quotaAware: checked })}
              />
            </div>
            <div className="automatic-processing-toggle-row">
              <span>每日不限次数</span>
              <SettingSwitch
                checked={draft.dailyRunLimit === null}
                label="每日不限次数"
                onChange={(checked) => setDraft({ ...draft, dailyRunLimit: checked ? null : 10 })}
              />
            </div>
          </section>

          <details className="automatic-processing-advanced">
            <summary>高级条件</summary>
            <div className="automatic-processing-grid">
              <label className="automatic-processing-field is-wide">
                <span>必须包含标签</span>
                <input value={includeLabelsText} onChange={(event) => setIncludeLabelsText(event.target.value)} />
              </label>
              <label className="automatic-processing-field is-wide">
                <span>排除标签</span>
                <input value={excludeLabelsText} onChange={(event) => setExcludeLabelsText(event.target.value)} />
              </label>
              <label className="automatic-processing-field">
                <span>最低优先级</span>
                <select
                  value={draft.minimumPriority}
                  onChange={(event) => setDraft({ ...draft, minimumPriority: event.target.value as TaskPriority })}
                >
                  {(["none", "urgent", "high", "medium", "low"] as TaskPriority[]).map((priority) => (
                    <option value={priority} key={priority}>{PRIORITY_LABELS[priority]}</option>
                  ))}
                </select>
              </label>
              <div className="automatic-processing-toggle-row">
                <span>要求开发上下文</span>
                <SettingSwitch
                  checked={draft.requireDevelopmentContext}
                  label="要求开发上下文"
                  onChange={(checked) => setDraft({ ...draft, requireDevelopmentContext: checked })}
                />
              </div>
              <label className="automatic-processing-field">
                <span>最大重试次数</span>
                <input
                  type="number"
                  min="0"
                  max="5"
                  value={draft.maxRetries}
                  onChange={(event) => setDraft({ ...draft, maxRetries: Number(event.target.value) })}
                />
              </label>
              <label className="automatic-processing-field">
                <span>重试等待</span>
                <div className="automatic-processing-input-suffix">
                  <input
                    type="number"
                    min="1"
                    max="1440"
                    value={draft.retryDelayMinutes}
                    onChange={(event) => setDraft({ ...draft, retryDelayMinutes: Number(event.target.value) })}
                  />
                  <span>分钟</span>
                </div>
              </label>
            </div>
          </details>

          <section className="automatic-processing-status" aria-label="运行状态">
            <div className="automatic-processing-status-line">
              <span>今日启动 <strong>{status?.today.started ?? 0}</strong></span>
              <span>完成 <strong>{status?.today.completed ?? 0}</strong></span>
              <span>失败 <strong>{status?.today.failed ?? 0}</strong></span>
              <span>候选 <strong>{status?.candidateCount ?? 0}</strong></span>
            </div>
            <div className="automatic-processing-status-line is-muted">
              <span>输入 {NUMBER_FORMAT.format(status?.today.inputTokens ?? 0)}</span>
              <span>输出 {NUMBER_FORMAT.format(status?.today.outputTokens ?? 0)}</span>
              <span>上次扫描 {formatTime(status?.lastReconciledAt ?? null)}</span>
              <span>下次 {formatTime(status?.nextFallbackAt ?? null)}</span>
            </div>
            {status?.quota && (
              <div className={`automatic-processing-quota is-${status.quota.state}`}>
                {status.quota.state === "available" && "当前额度可用"}
                {status.quota.state === "blocked" && `额度已用尽${status.quota.resetsAt ? `，${formatTime(new Date(status.quota.resetsAt * 1_000).toISOString())} 恢复` : ""}`}
                {status.quota.state === "unknown" && "额度状态未知"}
                {status.quota.state === "unavailable" && "当前账户不提供额度状态"}
              </div>
            )}
          </section>

          <section className="automatic-processing-history" aria-labelledby="automatic-history-heading">
            <div className="automatic-processing-section-heading">
              <h2 id="automatic-history-heading">最近执行</h2>
              <button
                type="button"
                className="automatic-processing-scan"
                disabled={reconciling || saving}
                onClick={() => void reconcile()}
              >
                <LinearIcon name="recurrence" />
                {reconciling ? "扫描中" : "立即扫描"}
              </button>
            </div>
            {history.length === 0 ? (
              <div className="automatic-processing-history-empty">暂无执行记录</div>
            ) : (
              <div className="automatic-processing-history-list">
                {history.slice(0, 8).map((claim) => {
                  const duration = formatDuration(claim);
                  return (
                    <div className="automatic-processing-history-row" key={claim.id}>
                      <span className={`automatic-processing-claim-dot is-${claim.status}`} aria-hidden="true" />
                      <div>
                        <strong>{claim.taskIdentifier ?? claim.taskId}</strong>
                        <span>{CLAIM_LABELS[claim.status]} · {formatTime(claim.finishedAt ?? claim.updatedAt)} · 第 {Math.max(1, claim.attempt)} 次 · {NUMBER_FORMAT.format(claim.inputTokens + claim.outputTokens)} Token{duration ? ` · ${duration}` : ""}</span>
                        {claim.error && <span className="automatic-processing-claim-error">{claim.error}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {(error || status?.lastError) && <p className="automatic-processing-error" role="alert">{error ?? status?.lastError}</p>}
          {saved && !error && <p className="automatic-processing-saved" role="status">设置已保存</p>}
          <div className="automatic-processing-actions">
            <button type="submit" className="button primary" disabled={saving}>
              <LinearIcon name="check" />
              {saving ? "保存中" : "保存设置"}
            </button>
          </div>
        </form>
      ) : (
        <p className="automatic-processing-error" role="alert">{error ?? "自动处理设置不可用"}</p>
      )}
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`automatic-processing-trigger no-drag${enabled ? " is-active" : ""}`}
        aria-label="自动处理设置"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={!available}
        title={available ? "自动处理设置" : "需要本地 Taskboard 服务"}
        onClick={() => {
          if (!open) {
            setPosition((current) => ({ ...current, ready: false }));
            setSaved(false);
            void load();
          }
          setOpen((current) => !current);
        }}
      >
        <LinearIcon name={enabled ? "play" : "pause"} />
        <span>{enabled ? "自动处理" : "未自动处理"}</span>
      </button>
      {menu}
    </>
  );
}
