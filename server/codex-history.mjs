import { spawn } from "node:child_process";

const HISTORY_TIMEOUT_MS = 30_000;
const HISTORY_MAX_LINE_BYTES = 16 * 1024 * 1024;
const HISTORY_SOURCE_KINDS = ["cli", "vscode", "exec"];
const ACTIVITY_GAP_MS = 60 * 60 * 1000;
const ACTIVITY_READ_CONCURRENCY = 2;
const CHAT_READ_CONCURRENCY = 2;
const CHAT_MAX_LINE_BYTES = 128 * 1024 * 1024;
const CHAT_TIMEOUT_MS = 90_000;
const ACTIVITY_CACHE_LIMIT = 128;
const activityCache = new Map();

function timestampToMilliseconds(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Codex returned an invalid ${field} timestamp`);
  }
  const milliseconds = value * 1000;
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`Codex returned an invalid ${field} timestamp`);
  }
  return milliseconds;
}

function timestampToIso(value, field) {
  const date = new Date(timestampToMilliseconds(value, field));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Codex returned an invalid ${field} timestamp`);
  }
  return date.toISOString();
}

function historyThread(value) {
  if (!value || typeof value !== "object" || typeof value.id !== "string" || !value.id.trim()) {
    throw new Error("Codex returned an invalid thread list entry");
  }
  const title = value.name ?? value.preview;
  if (typeof title !== "string" || !title.trim()) {
    throw new Error(`Codex thread '${value.id}' has no usable title`);
  }
  return {
    threadId: value.id.trim(),
    title: title.trim(),
    description: typeof value.preview === "string" ? value.preview : "",
    cwd: typeof value.cwd === "string" ? value.cwd : "",
    createdAt: timestampToIso(value.createdAt, "createdAt"),
    updatedAt: timestampToIso(value.updatedAt, "updatedAt"),
  };
}

function chatHistoryThread(value) {
  return {
    ...historyThread(value),
    generatedTitle: typeof value.name === "string" && value.name.trim()
      ? value.name.trim()
      : null,
  };
}

function codexMessageText(item) {
  if (item?.type === "userMessage" && Array.isArray(item.content)) {
    const content = item.content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n")
      .trim();
    const wrappedMessage = /<user_message>\s*([\s\S]*?)\s*<\/user_message>/.exec(content);
    return wrappedMessage ? wrappedMessage[1].trim() : content;
  }
  if (item?.type === "agentMessage" && typeof item.text === "string") {
    return item.text.trim();
  }
  return "";
}

function codexChatEvents(threadId, thread) {
  if (!thread || typeof thread !== "object" || !Array.isArray(thread.turns)) {
    throw new Error(`Codex returned invalid history for thread '${threadId}'`);
  }
  let itemIndex = 0;
  const events = [];
  for (const turn of thread.turns) {
    if (!turn || typeof turn !== "object" || !Array.isArray(turn.items)) continue;
    const createdAt = typeof turn.startedAt === "number" && Number.isFinite(turn.startedAt)
      ? timestampToIso(turn.startedAt, "turn startedAt")
      : new Date(0).toISOString();
    for (const item of turn.items) {
      const index = itemIndex;
      itemIndex += 1;
      const content = codexMessageText(item);
      if (!content) continue;
      const role = item.type === "userMessage" ? "user" : "assistant";
      events.push({
        id: `codex-history:${threadId}:${typeof item.id === "string" ? item.id : index}`,
        type: role === "user" ? "user_message" : "agent_message",
        role,
        content,
        data: { source: "codex-history" },
        createdAt,
      });
    }
  }
  return events;
}

function withCodexAppServer({
  codexExecutable,
  cwd,
  processEnv,
  timeoutMs,
  timeoutMessage,
  exitAction,
  requestErrorMessage,
  maxLineBytes = HISTORY_MAX_LINE_BYTES,
}, operation) {
  return new Promise((resolve, reject) => {
    const child = spawn(codexExecutable, ["app-server", "--stdio"], {
      cwd,
      env: processEnv,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const pending = new Map();
    let nextId = 1;
    let buffer = "";
    let settled = false;
    const timeout = setTimeout(() => finish(new Error(timeoutMessage)), timeoutMs);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdin.end();
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(value);
    }

    function send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    function request(method, params) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolveRequest, rejectRequest) => {
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
        send({ id, method, ...(params === undefined ? {} : { params }) });
      });
    }

    function handleMessage(message) {
      const response = pending.get(message?.id);
      if (!response) return;
      pending.delete(message.id);
      if (message.error) {
        response.reject(new Error(
          typeof message.error.message === "string"
            ? message.error.message
            : requestErrorMessage,
        ));
      } else {
        response.resolve(message.result);
      }
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > maxLineBytes) {
        finish(new Error("Codex history response exceeded the line size limit"));
        return;
      }
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0 && !settled) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          try {
            handleMessage(JSON.parse(line));
          } catch {}
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
    child.stdin.on("error", (error) => finish(error));
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (!settled) {
        finish(new Error(`Codex app-server exited before ${exitAction} (${signal || code})`));
      }
    });
    child.once("spawn", async () => {
      try {
        await request("initialize", {
          clientInfo: { name: "codex-taskboard", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        });
        send({ method: "initialized" });
        finish(null, await operation(request));
      } catch (error) {
        finish(error);
      }
    });
  });
}

async function listCodexThreadEntries(request) {
  const entries = [];
  let cursor;
  do {
    const result = await request("thread/list", {
      limit: 100,
      sortKey: "created_at",
      sortDirection: "desc",
      sourceKinds: HISTORY_SOURCE_KINDS,
      useStateDbOnly: true,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (!Array.isArray(result?.data)) {
      throw new Error("Codex returned an invalid thread list response");
    }
    entries.push(...result.data);
    if (result.nextCursor !== null && typeof result.nextCursor !== "string") {
      throw new Error("Codex returned an invalid history cursor");
    }
    cursor = result.nextCursor ?? null;
  } while (cursor !== null);
  return entries;
}

export function listCodexHistory({
  codexExecutable,
  cwd,
  processEnv = process.env,
  timeoutMs = HISTORY_TIMEOUT_MS,
}) {
  return withCodexAppServer({
    codexExecutable,
    cwd,
    processEnv,
    timeoutMs,
    timeoutMessage: "Timed out while reading Codex history",
    exitAction: "listing history",
    requestErrorMessage: "Codex app-server rejected a history request",
  }, async (request) => {
    const threads = new Map();
    for (const value of await listCodexThreadEntries(request)) {
      const thread = historyThread(value);
      if (!threads.has(thread.threadId)) threads.set(thread.threadId, thread);
    }
    return [...threads.values()];
  });
}

export function listCodexChatMetadata({
  codexExecutable,
  cwd,
  processEnv = process.env,
  timeoutMs = HISTORY_TIMEOUT_MS,
}) {
  return withCodexAppServer({
    codexExecutable,
    cwd,
    processEnv,
    timeoutMs,
    timeoutMessage: "Timed out while reading Codex chat metadata",
    exitAction: "listing chat metadata",
    requestErrorMessage: "Codex app-server rejected a chat metadata request",
  }, async (request) => {
    const threads = new Map();
    for (const value of await listCodexThreadEntries(request)) {
      const thread = chatHistoryThread(value);
      if (!threads.has(thread.threadId)) threads.set(thread.threadId, thread);
    }
    return [...threads.values()];
  });
}

export function readCodexChatThreads({
  codexExecutable,
  cwd,
  threadIds,
  processEnv = process.env,
  timeoutMs = CHAT_TIMEOUT_MS,
}) {
  return withCodexAppServer({
    codexExecutable,
    cwd,
    processEnv,
    timeoutMs,
    timeoutMessage: "Timed out while reading Codex chat history",
    exitAction: "reading chat history",
    requestErrorMessage: "Codex app-server rejected a chat history request",
    maxLineBytes: CHAT_MAX_LINE_BYTES,
  }, async (request) => {
    const uniqueThreadIds = [...new Set(threadIds)];
    const results = new Array(uniqueThreadIds.length);
    let nextThread = 0;
    async function worker() {
      while (nextThread < uniqueThreadIds.length) {
        const index = nextThread;
        nextThread += 1;
        const threadId = uniqueThreadIds[index];
        const result = await request("thread/read", { threadId, includeTurns: true });
        results[index] = {
          threadId,
          events: codexChatEvents(threadId, result?.thread),
        };
      }
    }
    await Promise.all(Array.from(
      { length: Math.min(CHAT_READ_CONCURRENCY, uniqueThreadIds.length) },
      () => worker(),
    ));
    return results;
  });
}

export function buildCodexActivitySegments(thread) {
  if (!thread || typeof thread !== "object" || !Array.isArray(thread.turns)) {
    throw new Error("Codex returned an invalid thread read response");
  }
  const threadUpdatedAt = typeof thread.updatedAt === "number" && Number.isFinite(thread.updatedAt)
    ? thread.updatedAt * 1000
    : null;
  const intervals = thread.turns.flatMap((turn) => {
    if (!turn || typeof turn !== "object") return [];
    if (typeof turn.startedAt !== "number" || !Number.isFinite(turn.startedAt)) return [];
    const start = turn.startedAt * 1000;
    const completedAt = typeof turn.completedAt === "number" && Number.isFinite(turn.completedAt)
      ? turn.completedAt * 1000
      : null;
    const end = completedAt ?? threadUpdatedAt;
    return end !== null && end > start ? [{ start, end }] : [];
  }).sort((left, right) => left.start - right.start || left.end - right.end);

  const merged = [];
  for (const interval of intervals) {
    const current = merged.at(-1);
    if (!current || interval.start - current.end > ACTIVITY_GAP_MS) {
      merged.push({ ...interval });
    } else {
      current.end = Math.max(current.end, interval.end);
    }
  }
  return merged.map((segment) => ({
    startAt: new Date(segment.start).toISOString(),
    endAt: new Date(segment.end).toISOString(),
  }));
}

function cacheActivity(key, segments) {
  if (activityCache.has(key)) activityCache.delete(key);
  activityCache.set(key, segments);
  while (activityCache.size > ACTIVITY_CACHE_LIMIT) {
    activityCache.delete(activityCache.keys().next().value);
  }
}

function segmentsInRange(segments, rangeStart, rangeEnd) {
  return segments.filter((segment) => (
    Date.parse(segment.startAt) < rangeEnd && Date.parse(segment.endAt) > rangeStart
  ));
}

export function listCodexActivity({
  codexExecutable,
  cwd,
  threadIds,
  rangeStart,
  rangeEnd,
  processEnv = process.env,
  timeoutMs = HISTORY_TIMEOUT_MS,
}) {
  const requestedThreadIds = new Set(threadIds);
  const rangeStartMs = Date.parse(rangeStart);
  const rangeEndMs = Date.parse(rangeEnd);
  if (!Number.isFinite(rangeStartMs) || !Number.isFinite(rangeEndMs) || rangeEndMs <= rangeStartMs) {
    throw new Error("Codex activity range is invalid");
  }

  return withCodexAppServer({
    codexExecutable,
    cwd,
    processEnv,
    timeoutMs,
    timeoutMessage: "Timed out while reading Codex activity",
    exitAction: "reading activity",
    requestErrorMessage: "Codex app-server rejected an activity request",
  }, async (request) => {
    const candidates = [];
    const seenThreadIds = new Set();
    for (const value of await listCodexThreadEntries(request)) {
      if (!value || typeof value !== "object" || typeof value.id !== "string") {
        throw new Error("Codex returned an invalid thread list entry");
      }
      const threadId = value.id.trim();
      if (!threadId || seenThreadIds.has(threadId) || !requestedThreadIds.has(threadId)) continue;
      seenThreadIds.add(threadId);
      const createdAt = timestampToMilliseconds(value.createdAt, "createdAt");
      const updatedAt = timestampToMilliseconds(value.updatedAt, "updatedAt");
      if (createdAt < rangeEndMs && updatedAt > rangeStartMs) {
        candidates.push({ threadId, updatedAt: value.updatedAt });
      }
    }

    const results = new Array(candidates.length);
    let nextCandidate = 0;
    async function worker() {
      while (nextCandidate < candidates.length) {
        const index = nextCandidate;
        nextCandidate += 1;
        const candidate = candidates[index];
        const cacheKey = JSON.stringify([
          codexExecutable,
          candidate.threadId,
          candidate.updatedAt,
        ]);
        let segments = activityCache.get(cacheKey);
        if (!segments) {
          const result = await request("thread/read", {
            threadId: candidate.threadId,
            includeTurns: true,
          });
          segments = buildCodexActivitySegments(result?.thread);
          cacheActivity(cacheKey, segments);
        }
        const visibleSegments = segmentsInRange(segments, rangeStartMs, rangeEndMs);
        if (visibleSegments.length > 0) {
          results[index] = { threadId: candidate.threadId, segments: visibleSegments };
        }
      }
    }
    await Promise.all(Array.from(
      { length: Math.min(ACTIVITY_READ_CONCURRENCY, candidates.length) },
      () => worker(),
    ));
    return results.filter(Boolean);
  });
}
