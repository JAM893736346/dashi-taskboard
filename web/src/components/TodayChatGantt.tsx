import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { listCodexActivity, listTasks } from "../api";
import type { CodexActivitySegment, Project, Task } from "../types";
import { LinearIcon } from "./LinearIcon";

interface TodayChatGanttProps {
  projects: Project[];
  onOpenThread: (threadId: string) => void;
}

interface LoadedTask {
  task: Task;
  threadId: string;
  projectName: string;
  activitySegments: CodexActivitySegment[];
}

interface DayWindow {
  start: number;
  end: number;
}

interface GanttSegment {
  start: number;
  end: number;
  offsetPercent: number;
  widthPercent: number;
}

interface GanttRow extends LoadedTask {
  segments: GanttSegment[];
  firstStart: number;
  durationMs: number;
}

const TICKS = ["00", "04", "08", "12", "16", "20", "24"] as const;

function localDayWindow(reference: number): DayWindow {
  const date = new Date(reference);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
  return { start, end };
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function durationLabel(durationMs: number): string {
  const totalMinutes = Math.floor(durationMs / 60_000);
  if (totalMinutes < 1) return `${Math.max(0, Math.floor(durationMs / 1_000))}秒`;
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}天 ${hours}小时`;
  if (hours > 0) return `${hours}小时 ${minutes}分`;
  return `${minutes}分`;
}

function timeLabel(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(timestamp);
}

function dateLabel(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(timestamp);
}

function errorLabel(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "无法加载今日 Codex 活跃时长";
}

export function TodayChatGantt({ projects, onOpenThread }: TodayChatGanttProps) {
  const [day, setDay] = useState<DayWindow>(() => localDayWindow(Date.now()));
  const [loadedTasks, setLoadedTasks] = useState<LoadedTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const activeRequestRef = useRef<AbortController | null>(null);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const projectIdsKey = projects.map((project) => project.id).sort().join("\u001f");

  const refresh = useCallback(async () => {
    activeRequestRef.current?.abort();
    const controller = new AbortController();
    activeRequestRef.current = controller;
    const requestDay = localDayWindow(Date.now());

    setDay(requestDay);
    setLoading(true);
    setError(null);

    try {
      const taskGroups = await Promise.all(
        projectsRef.current.map(async (project) => ({
          project,
          tasks: await listTasks(project.id, controller.signal),
        })),
      );
      if (controller.signal.aborted) return;
      const synchronizedTasks = taskGroups.flatMap(({ project, tasks }) => tasks.flatMap((task) => {
        const threadId = task.threadId?.trim();
        return threadId ? [{ task, threadId, projectName: project.name }] : [];
      }));
      const threadIds = [...new Set(synchronizedTasks.map((task) => task.threadId))];
      const activity = threadIds.length > 0
        ? await listCodexActivity(
          threadIds,
          new Date(requestDay.start).toISOString(),
          new Date(requestDay.end).toISOString(),
          controller.signal,
        )
        : [];
      if (controller.signal.aborted) return;
      const activityByThreadId = new Map(activity.map((entry) => [entry.threadId, entry.segments]));
      setLoadedTasks(synchronizedTasks.flatMap((task) => {
        const activitySegments = activityByThreadId.get(task.threadId);
        return activitySegments?.length ? [{ ...task, activitySegments }] : [];
      }));
    } catch (nextError) {
      if (controller.signal.aborted) return;
      setLoadedTasks([]);
      setError(errorLabel(nextError));
    } finally {
      if (activeRequestRef.current === controller) {
        activeRequestRef.current = null;
        setLoading(false);
      }
    }
  }, [projectIdsKey]);

  useEffect(() => {
    void refresh();
    return () => activeRequestRef.current?.abort();
  }, [refresh]);

  const rows = useMemo(() => {
    const dayLength = day.end - day.start;
    return loadedTasks.flatMap<GanttRow>((loadedTask) => {
      const segments = loadedTask.activitySegments.flatMap<GanttSegment>((segment) => {
        const realStart = parseTimestamp(segment.startAt);
        const realEnd = parseTimestamp(segment.endAt);
        if (
          realStart === null
          || realEnd === null
          || realEnd <= realStart
          || realStart >= day.end
          || realEnd <= day.start
        ) {
          return [];
        }
        const start = Math.max(realStart, day.start);
        const end = Math.min(realEnd, day.end);
        return [{
          start,
          end,
          offsetPercent: ((start - day.start) / dayLength) * 100,
          widthPercent: ((end - start) / dayLength) * 100,
        }];
      }).sort((left, right) => left.start - right.start || left.end - right.end);
      if (segments.length === 0) return [];
      return [{
        ...loadedTask,
        segments,
        firstStart: segments[0].start,
        durationMs: segments.reduce((total, segment) => total + segment.end - segment.start, 0),
      }];
    }).sort((left, right) => (
      left.firstStart - right.firstStart || left.task.id.localeCompare(right.task.id)
    ));
  }, [day.end, day.start, loadedTasks]);

  const totalDuration = rows.reduce((total, row) => total + row.durationMs, 0);
  const longestDuration = rows.reduce((longest, row) => Math.max(longest, row.durationMs), 0);

  return (
    <section className="today-chat-gantt" aria-labelledby="today-chat-gantt-title">
      <header className="today-chat-gantt-header">
        <div className="today-chat-gantt-heading">
          <span>时间分布</span>
          <div>
            <h2 id="today-chat-gantt-title">今日 Codex 任务</h2>
            <time dateTime={new Date(day.start).toISOString()}>{dateLabel(day.start)}</time>
          </div>
        </div>
        <div className="today-chat-gantt-actions">
          <dl className="today-chat-gantt-summary">
            <div><dt>任务</dt><dd>{rows.length}</dd></div>
            <div><dt>累计活跃</dt><dd>{durationLabel(totalDuration)}</dd></div>
            <div><dt>最长活跃</dt><dd>{durationLabel(longestDuration)}</dd></div>
          </dl>
          <button
            className="today-chat-gantt-refresh"
            type="button"
            aria-label="刷新今日 Codex 任务"
            title="刷新"
            disabled={loading}
            onClick={() => void refresh()}
          >
            {loading ? <span className="ai-chat-spinner" /> : <LinearIcon name="recurrence" />}
          </button>
        </div>
      </header>

      {loading ? (
        <div className="today-chat-gantt-state" aria-live="polite">
          <span className="ai-chat-spinner" />
          正在估算今日活跃时长
        </div>
      ) : error ? (
        <div className="today-chat-gantt-state is-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void refresh()}>重试</button>
        </div>
      ) : rows.length === 0 ? (
        <div className="today-chat-gantt-state">今天暂无已同步的 Codex 活跃记录</div>
      ) : (
        <div className="today-chat-gantt-scroll">
          <div className="today-chat-gantt-chart">
            <div className="today-chat-gantt-axis" aria-hidden="true">
              <span>任务</span>
              <div className="today-chat-gantt-ticks">
                {TICKS.map((tick, index) => (
                  <i
                    key={tick}
                    style={{ left: `${(index / (TICKS.length - 1)) * 100}%` }}
                  >
                    {tick}
                  </i>
                ))}
              </div>
              <span>活跃</span>
            </div>
            {rows.map((row) => (
              <button
                className="today-chat-gantt-row"
                type="button"
                key={row.task.id}
                aria-label={`打开 ${row.task.title}，Codex 对话，估算活跃 ${durationLabel(row.durationMs)}`}
                onClick={() => onOpenThread(row.threadId)}
              >
                <span className="today-chat-gantt-label">
                  <strong>{row.task.title}</strong>
                  <small>
                    {row.projectName} · 估算活跃 · {timeLabel(row.firstStart)}
                  </small>
                </span>
                <span
                  className="today-chat-gantt-timeline"
                  aria-label={`${row.segments.length} 段估算活跃，累计 ${durationLabel(row.durationMs)}`}
                >
                  <span className="today-chat-gantt-grid" aria-hidden="true">
                    {TICKS.map((tick, index) => (
                      <i
                        key={tick}
                        style={{ left: `${(index / (TICKS.length - 1)) * 100}%` }}
                      />
                    ))}
                  </span>
                  {row.segments.map((segment) => (
                    <span
                      className="today-chat-gantt-bar"
                      key={`${segment.start}-${segment.end}`}
                      style={{
                        left: `${segment.offsetPercent}%`,
                        width: `${segment.widthPercent}%`,
                      } as CSSProperties}
                    />
                  ))}
                </span>
                <span className="today-chat-gantt-duration">{durationLabel(row.durationMs)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
