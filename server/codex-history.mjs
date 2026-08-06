import { spawn } from "node:child_process";

const HISTORY_TIMEOUT_MS = 30_000;
const HISTORY_MAX_LINE_BYTES = 16 * 1024 * 1024;

function timestampToIso(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Codex returned an invalid ${field} timestamp`);
  }
  const date = new Date(value * 1000);
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

export function listCodexHistory({
  codexExecutable,
  cwd,
  processEnv = process.env,
  timeoutMs = HISTORY_TIMEOUT_MS,
}) {
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
    const timeout = setTimeout(
      () => finish(new Error("Timed out while reading Codex history")),
      timeoutMs,
    );

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
            : "Codex app-server rejected a history request",
        ));
      } else {
        response.resolve(message.result);
      }
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > HISTORY_MAX_LINE_BYTES) {
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
        finish(new Error(`Codex app-server exited before listing history (${signal || code})`));
      }
    });
    child.once("spawn", async () => {
      try {
        await request("initialize", {
          clientInfo: { name: "codex-taskboard", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        });
        send({ method: "initialized" });

        const threads = new Map();
        let cursor;
        do {
          const result = await request("thread/list", {
            limit: 100,
            sortKey: "created_at",
            sortDirection: "desc",
            useStateDbOnly: true,
            ...(cursor === undefined ? {} : { cursor }),
          });
          if (!Array.isArray(result?.data)) {
            throw new Error("Codex returned an invalid thread list response");
          }
          for (const value of result.data) {
            const thread = historyThread(value);
            if (!threads.has(thread.threadId)) threads.set(thread.threadId, thread);
          }
          if (result.nextCursor !== null && typeof result.nextCursor !== "string") {
            throw new Error("Codex returned an invalid history cursor");
          }
          cursor = result.nextCursor ?? null;
        } while (cursor !== null);

        finish(null, [...threads.values()]);
      } catch (error) {
        finish(error);
      }
    });
  });
}
