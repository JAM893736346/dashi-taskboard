import { useEffect, useMemo, useRef, useState } from "react";

import {
  buildCodexHistoryPreview,
  type CodexHistoryPreviewItem,
} from "../../../shared/codex-history-import.mjs";
import {
  importCodexHistory,
  listCodexHistory,
  listImportedCodexThreadIds,
} from "../api";
import type { CodexHistoryThread, CodexImportResult, Project } from "../types";
import { LinearIcon } from "./LinearIcon";

interface CodexHistorySyncDialogProps {
  projects: Project[];
  onClose: () => void;
  onImported: () => Promise<void>;
}

const DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatTimestamp(value: string): string {
  return DATE_FORMATTER.format(new Date(value));
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : "无法读取 Codex 历史";
}

export function CodexHistorySyncDialog({
  projects,
  onClose,
  onImported,
}: CodexHistorySyncDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [threads, setThreads] = useState<CodexHistoryThread[]>([]);
  const [existingThreadIds, setExistingThreadIds] = useState<string[]>([]);
  const [manualProjects, setManualProjects] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CodexImportResult | null>(null);

  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const items = useMemo(
    () => buildCodexHistoryPreview(threads, projects, existingThreadIds),
    [existingThreadIds, projects, threads],
  );
  const selectedProjectId = (item: CodexHistoryPreviewItem) => (
    manualProjects[item.threadId] ?? item.matchedProjectId
  );
  const available = items.filter((item) => !item.existing && selectedProjectId(item)).length;
  const existing = items.filter((item) => item.existing).length;
  const unmatched = items.filter((item) => !item.existing && !selectedProjectId(item)).length;

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    Promise.all([
      listCodexHistory(controller.signal),
      listImportedCodexThreadIds(controller.signal),
    ]).then(
      ([threads, threadIds]) => {
        setThreads(threads);
        setExistingThreadIds(threadIds);
        setLoading(false);
      },
      (scanError) => {
        if ((scanError as Error).name !== "AbortError") {
          setError(messageFromError(scanError));
          setLoading(false);
        }
      },
    );
    return () => controller.abort();
  }, []);

  async function confirmImport() {
    const tasks = items.flatMap((item) => {
      const projectId = selectedProjectId(item);
      if (item.existing || !projectId) return [];
      return [{
        threadId: item.threadId,
        projectId,
        title: item.title,
        description: item.description,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      }];
    });
    setImporting(true);
    setError(null);
    try {
      const nextResult = await importCodexHistory(tasks);
      setResult(nextResult);
      await onImported();
    } catch (importError) {
      setError(messageFromError(importError));
    } finally {
      setImporting(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="codex-history-dialog"
      aria-labelledby="codex-history-title"
      onCancel={(event) => {
        if (importing) event.preventDefault();
        else onClose();
      }}
      onClose={onClose}
    >
      <header className="codex-history-header">
        <div>
          <strong id="codex-history-title">将 Codex Chat 导入议题</strong>
          <span>手动转换</span>
        </div>
        <button
          type="button"
          className="icon-button dialog-close"
          aria-label="关闭"
          disabled={importing}
          onClick={onClose}
        >
          <LinearIcon name="close" />
        </button>
      </header>

      {result ? (
        <div className="codex-history-complete">
          <span className="codex-history-complete-icon" aria-hidden="true">
            <LinearIcon name="check" />
          </span>
          <strong>同步完成</strong>
          <div className="codex-history-summary" aria-label="同步结果">
            <span><strong>{result.imported}</strong> 已导入</span>
            <span><strong>{result.skipped}</strong> 已跳过</span>
            <span><strong>{result.failed}</strong> 失败</span>
          </div>
          {result.failures.length > 0 && (
            <ul className="codex-history-failures">
              {result.failures.map((failure, index) => (
                <li key={`${failure.threadId ?? "unknown"}-${index}`}>
                  <span>{failure.threadId ?? "未知 Chat"}</span>
                  <strong>{failure.message}</strong>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <>
          <div className="codex-history-summary" aria-label="扫描结果">
            <span><strong>{items.length}</strong> 已扫描</span>
            <span><strong>{available}</strong> 可导入</span>
            <span><strong>{existing}</strong> 已存在</span>
            <span><strong>{unmatched}</strong> 未匹配</span>
          </div>

          <div className="codex-history-body">
            {loading ? (
              <div className="codex-history-state" aria-busy="true">
                <span className="ai-chat-spinner" />正在扫描…
              </div>
            ) : error ? (
              <div className="codex-history-state is-error">{error}</div>
            ) : items.length === 0 ? (
              <div className="codex-history-state">没有可导入的 Codex Chat</div>
            ) : (
              <ul className="codex-history-list">
                {items.map((item) => {
                  const projectId = selectedProjectId(item);
                  const project = projectId ? projectById.get(projectId) : null;
                  return (
                    <li key={item.threadId} className={item.existing ? "is-existing" : ""}>
                      <div className="codex-history-item-main">
                        <strong title={item.title}>{item.title}</strong>
                        <span>{formatTimestamp(item.createdAt)} · 更新 {formatTimestamp(item.updatedAt)}</span>
                        <code title={item.cwd}>{item.cwd || "未提供工作目录"}</code>
                      </div>
                      <div className="codex-history-item-project">
                        {item.existing ? (
                          <span className="codex-history-badge">已存在</span>
                        ) : item.matchedProjectId ? (
                          <span title={project?.name}>{project?.name ?? item.matchedProjectId}</span>
                        ) : (
                          <select
                            value={manualProjects[item.threadId] ?? ""}
                            aria-label={`为 ${item.title} 选择项目`}
                            onChange={(event) => setManualProjects((current) => ({
                              ...current,
                              [item.threadId]: event.target.value,
                            }))}
                          >
                            <option value="">选择项目</option>
                            {projects.map((candidate) => (
                              <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
                            ))}
                          </select>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}

      {error && result && <div className="codex-history-error">{error}</div>}
      <footer className="codex-history-footer">
        <button type="button" className="button secondary" disabled={importing} onClick={onClose}>
          {result ? "完成" : "取消"}
        </button>
        {!result && (
          <button
            type="button"
            className="button primary"
            disabled={loading || importing || available === 0}
            onClick={() => void confirmImport()}
          >
            {importing ? "正在导入…" : `将 ${available} 个 Chat 导入议题`}
          </button>
        )}
      </footer>
    </dialog>
  );
}
