import { spawn } from "node:child_process";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;

function requestKey(id) {
  return `${typeof id}:${String(id)}`;
}

function responseError(value, fallback) {
  const error = new Error(
    typeof value?.message === "string" && value.message ? value.message : fallback,
  );
  if (value && typeof value === "object") {
    if (value.code !== undefined) error.code = value.code;
    if (value.data !== undefined) error.data = value.data;
  }
  return error;
}

export class CodexAppServerClient {
  constructor({
    codexExecutable = "codex",
    cwd = process.cwd(),
    processEnv = process.env,
    requestTimeoutMs,
    timeoutMs,
    maxLineBytes = DEFAULT_MAX_LINE_BYTES,
  } = {}) {
    this.codexExecutable = codexExecutable;
    this.cwd = cwd;
    this.processEnv = processEnv;
    this.requestTimeoutMs = requestTimeoutMs ?? timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxLineBytes = maxLineBytes;
    this.child = null;
    this.starting = null;
    this.closePromise = null;
    this.started = false;
    this.explicitlyClosed = false;
    this.sequence = 0;
    this.buffer = "";
    this.pending = new Map();
    this.listeners = new Set();
    this.serverRequests = new Set();
    this.handledChildren = new WeakSet();
  }

  async start() {
    if (this.explicitlyClosed) {
      throw new Error("Codex App Server client is closed");
    }
    if (this.started && this.child?.exitCode === null) return this;
    if (this.starting) return this.starting;

    this.starting = this.#spawnAndInitialize();
    try {
      await this.starting;
      return this;
    } finally {
      this.starting = null;
    }
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.explicitlyClosed = true;
    this.started = false;
    const error = new Error("Codex App Server client closed");
    this.#rejectPending(error);
    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.child = null;
      return;
    }

    this.closePromise = new Promise((resolve) => {
      child.once("exit", resolve);
      child.stdin.end();
      child.kill("SIGTERM");
    });
    try {
      await this.closePromise;
    } finally {
      this.closePromise = null;
    }
  }

  request(method, params, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this.started || !this.child || this.child.exitCode !== null) {
      return Promise.reject(new Error("Codex App Server client is not started"));
    }
    return this.#request(method, params, timeoutMs);
  }

  subscribe(listener) {
    if (typeof listener !== "function") {
      throw new TypeError("Codex App Server listener must be a function");
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  respondToServerRequest(id, response = {}) {
    const hasResult = Object.prototype.hasOwnProperty.call(response, "result");
    const hasError = Object.prototype.hasOwnProperty.call(response, "error");
    if (hasResult === hasError) {
      throw new Error("Codex App Server response must contain either result or error");
    }
    const key = requestKey(id);
    if (!this.serverRequests.delete(key)) {
      throw new Error(`Codex App Server request '${String(id)}' is not pending`);
    }
    this.#write(hasResult ? { id, result: response.result } : { id, error: response.error });
  }

  startThread(input) {
    return this.request("thread/start", input);
  }

  resumeThread(threadId, input = {}) {
    return this.request("thread/resume", { threadId, ...input });
  }

  readThread(threadId, includeTurns = true) {
    return this.request("thread/read", { threadId, includeTurns });
  }

  startTurn(threadId, input) {
    return this.request("turn/start", { threadId, ...input });
  }

  steerTurn(threadId, expectedTurnId, text) {
    return this.request("turn/steer", {
      threadId,
      expectedTurnId,
      input: [{ type: "text", text }],
    });
  }

  interruptTurn(threadId, turnId) {
    return this.request("turn/interrupt", { threadId, turnId });
  }

  async #spawnAndInitialize() {
    const child = spawn(this.codexExecutable, ["app-server", "--stdio"], {
      cwd: this.cwd,
      env: this.processEnv,
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.child = child;
    this.buffer = "";
    this.serverRequests.clear();
    this.#attach(child);

    try {
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      await this.#request("initialize", {
        clientInfo: { name: "codex-taskboard", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      }, this.requestTimeoutMs);
      if (this.child !== child || child.exitCode !== null || this.explicitlyClosed) {
        throw new Error("Codex App Server closed during initialization");
      }
      this.#write({ method: "initialized" });
      this.started = true;
    } catch (error) {
      this.#disconnect(child, error);
      if (child.exitCode === null) child.kill("SIGTERM");
      throw error;
    }
  }

  #attach(child) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#handleData(child, chunk));
    child.stdin.on("error", (error) => this.#disconnect(child, error));
    child.once("error", (error) => this.#disconnect(child, error));
    child.once("exit", (code, signal) => {
      const suffix = signal || code;
      const error = this.explicitlyClosed
        ? new Error("Codex App Server client closed")
        : new Error(`Codex App Server exited (${suffix})`);
      this.#disconnect(child, error);
    });
  }

  #handleData(child, chunk) {
    if (child !== this.child || this.handledChildren.has(child)) return;
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const rawLine = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (Buffer.byteLength(rawLine) > this.maxLineBytes) {
        this.#disconnect(child, new Error("Codex App Server response exceeded the line size limit"));
        child.kill("SIGTERM");
        return;
      }
      const line = rawLine.trim();
      if (line) {
        try {
          this.#handleMessage(JSON.parse(line));
        } catch {}
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.buffer) > this.maxLineBytes) {
      this.#disconnect(child, new Error("Codex App Server response exceeded the line size limit"));
      child.kill("SIGTERM");
    }
  }

  #handleMessage(message) {
    if (message && typeof message.method === "string") {
      const notification = {
        ...(message.id === undefined ? {} : { id: message.id }),
        method: message.method,
        params: message.params,
      };
      if (message.id !== undefined) this.serverRequests.add(requestKey(message.id));
      this.#notify(notification);
      return;
    }

    const request = this.pending.get(message?.id);
    if (!request) return;
    this.pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.error) {
      request.reject(responseError(message.error, "Codex App Server request failed"));
    } else {
      request.resolve(message.result);
    }
  }

  #request(method, params, timeoutMs) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.#write({ id, method, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  #write(message) {
    if (!this.child || this.child.exitCode !== null || !this.child.stdin.writable) {
      throw new Error("Codex App Server connection is not writable");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #disconnect(child, error) {
    if (this.handledChildren.has(child)) return;
    this.handledChildren.add(child);
    if (this.child === child) this.child = null;
    this.started = false;
    this.buffer = "";
    this.serverRequests.clear();
    this.#rejectPending(error);
    this.#notify({ method: "client/closed", params: { error } });
  }

  #rejectPending(error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
  }

  #notify(notification) {
    for (const listener of [...this.listeners]) {
      try {
        listener(notification);
      } catch {}
    }
  }
}
