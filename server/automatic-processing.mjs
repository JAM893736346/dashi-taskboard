import { randomUUID } from "node:crypto";

import { rankAutomaticProcessingCandidates } from "../shared/automatic-processing.mjs";

const ACTIVE_STATUSES = new Set(["claimed", "running", "retry_wait"]);

function localDayStart(date = new Date()) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start.toISOString();
}

function signalProcessGroup(child, signal) {
  if (Number.isInteger(child?.pid)) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  try {
    child?.kill(signal);
  } catch {}
}

function messageFrom(error) {
  return error instanceof Error ? error.message : String(error ?? "Automatic processing failed");
}

export class AutomaticProcessingDispatcher {
  constructor({
    configStore,
    businessStore,
    runner,
    quotaReader,
    codexExecutable,
    manageTaskboardSkillPath,
    leaseMs = 120_000,
    heartbeatMs = 30_000,
  }) {
    this.configStore = configStore;
    this.businessStore = businessStore;
    this.runner = runner;
    this.quotaReader = quotaReader;
    this.codexExecutable = codexExecutable;
    this.manageTaskboardSkillPath = manageTaskboardSkillPath;
    this.leaseMs = leaseMs;
    this.heartbeatMs = heartbeatMs;
    this.dispatcherId = randomUUID();
    this.settings = null;
    this.companionUrl = null;
    this.started = false;
    this.requested = false;
    this.reconcilePromise = null;
    this.fallbackTimer = null;
    this.activeRuns = new Map();
    this.leaseTokens = new Map();
    this.lastProjectId = null;
    this.lastReconciledAt = null;
    this.nextFallbackAt = null;
    this.lastCandidateCount = 0;
    this.lastError = null;
    this.quota = null;
    this.quotaCheckedAt = 0;
    this.pauseReason = null;
  }

  async start({ companionUrl }) {
    if (this.started) return;
    this.companionUrl = companionUrl;
    this.settings = await this.configStore.read();
    await this.businessStore.reconcileExpired({
      maxRetries: this.settings.maxRetries,
      retryDelayMinutes: this.settings.retryDelayMinutes,
    });
    this.started = true;
    this.#scheduleFallback();
    await this.reconcile("startup");
  }

  async updateSettings(value) {
    this.settings = await this.configStore.write(value);
    this.lastError = null;
    this.#scheduleFallback();
    if (this.started) await this.reconcile("settings");
    return this.settings;
  }

  getSettings() {
    return this.settings;
  }

  wake() {
    if (!this.started) return;
    this.requested = true;
    void this.reconcile("event").catch((error) => {
      this.lastError = messageFrom(error);
    });
  }

  async reconcile() {
    if (!this.started) return;
    this.requested = true;
    if (this.reconcilePromise) return this.reconcilePromise;
    this.reconcilePromise = (async () => {
      do {
        this.requested = false;
        await this.#reconcileOnce();
      } while (this.requested && this.started);
    })().finally(() => {
      this.reconcilePromise = null;
    });
    return this.reconcilePromise;
  }

  async getStatus() {
    const snapshot = await this.businessStore.snapshot();
    const today = localDayStart();
    const todayClaims = snapshot.claims.filter((claim) => (
      claim.startedAt !== null && claim.startedAt >= today
    ));
    const totals = {
      started: todayClaims.reduce((sum, claim) => sum + claim.attempt, 0),
      completed: todayClaims.filter((claim) => claim.status === "completed").length,
      failed: todayClaims.filter((claim) => claim.status === "failed").length,
      inputTokens: todayClaims.reduce((sum, claim) => sum + claim.inputTokens, 0),
      outputTokens: todayClaims.reduce((sum, claim) => sum + claim.outputTokens, 0),
    };
    let state = "idle";
    if (!this.settings?.enabled) state = "disabled";
    else if (this.lastError) state = "error";
    else if (this.pauseReason === "quota") state = "quota_paused";
    else if (this.pauseReason === "daily_limit") state = "daily_limit";
    else if (this.activeRuns.size > 0) state = "running";
    return {
      state,
      pauseReason: this.pauseReason,
      lastReconciledAt: this.lastReconciledAt,
      nextFallbackAt: this.nextFallbackAt,
      candidateCount: this.lastCandidateCount,
      activeCount: this.activeRuns.size,
      maxConcurrency: this.settings?.maxConcurrency ?? 1,
      quota: this.quota,
      today: totals,
      lastError: this.lastError,
      recentClaims: snapshot.claims.slice(0, 20),
    };
  }

  async getHistory(limit = 20) {
    const snapshot = await this.businessStore.snapshot();
    return snapshot.claims.slice(0, Math.max(1, Math.min(limit, 100)));
  }

  async close() {
    this.started = false;
    this.requested = false;
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    this.fallbackTimer = null;
    this.nextFallbackAt = null;
    for (const record of this.activeRuns.values()) signalProcessGroup(record.child, "SIGTERM");
    await Promise.allSettled([...this.activeRuns.values()].map((record) => record.promise));
  }

  #scheduleFallback() {
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    this.fallbackTimer = null;
    this.nextFallbackAt = null;
    if (!this.started || !this.settings?.enabled) return;
    const intervalMs = this.settings.fallbackIntervalMinutes * 60_000;
    this.nextFallbackAt = new Date(Date.now() + intervalMs).toISOString();
    this.fallbackTimer = setInterval(() => {
      this.nextFallbackAt = new Date(Date.now() + intervalMs).toISOString();
      this.wake("fallback");
    }, intervalMs);
    this.fallbackTimer.unref();
  }

  async #readQuota() {
    if (!this.settings.quotaAware) {
      this.quota = null;
      return true;
    }
    if (Date.now() - this.quotaCheckedAt >= 60_000 || !this.quota) {
      this.quota = await this.quotaReader(this.settings.executionModel, {
        codexExecutable: this.codexExecutable,
      });
      this.quotaCheckedAt = Date.now();
    }
    return this.quota?.state === "available";
  }

  async #reconcileOnce() {
    this.lastReconciledAt = new Date().toISOString();
    this.lastCandidateCount = 0;
    this.pauseReason = null;
    if (!this.settings?.enabled) return;
    if (!(await this.#readQuota())) {
      this.pauseReason = "quota";
      return;
    }

    let snapshot = await this.businessStore.snapshot();
    const today = localDayStart();
    const startedToday = snapshot.claims
      .filter((claim) => claim.startedAt !== null && claim.startedAt >= today)
      .reduce((sum, claim) => sum + claim.attempt, 0);
    if (this.settings.dailyRunLimit !== null && startedToday >= this.settings.dailyRunLimit) {
      this.pauseReason = "daily_limit";
      return;
    }

    await this.#cancelManuallyMovedClaims(snapshot);
    while (this.started && this.activeRuns.size < this.settings.maxConcurrency) {
      snapshot = await this.businessStore.snapshot();
      const retry = snapshot.claims.find((claim) => (
        claim.status === "retry_wait"
        && claim.nextRetryAt !== null
        && claim.nextRetryAt <= new Date().toISOString()
        && this.leaseTokens.has(claim.id)
        && !this.activeRuns.has(claim.id)
      ));
      if (retry) {
        const task = snapshot.tasks.find((candidate) => candidate.id === retry.taskId);
        const project = snapshot.projects.find((candidate) => candidate.id === retry.projectId);
        if (!task || !project || task.status !== "in_progress") {
          const leaseToken = this.leaseTokens.get(retry.id);
          await this.businessStore.finish(retry.id, leaseToken, { status: "canceled" });
          this.leaseTokens.delete(retry.id);
          continue;
        }
        this.#launch(retry, task, project, this.leaseTokens.get(retry.id));
        continue;
      }

      const activeTaskIds = new Set(
        snapshot.claims.filter((claim) => ACTIVE_STATUSES.has(claim.status)).map((claim) => claim.taskId),
      );
      const candidates = rankAutomaticProcessingCandidates({
        tasks: snapshot.tasks,
        projects: snapshot.projects,
        activeTaskIds,
        settings: this.settings,
        lastProjectId: this.lastProjectId,
      });
      this.lastCandidateCount = candidates.length;
      if (candidates.length === 0) break;
      const acquired = await this.businessStore.acquire({
        candidateIds: candidates.map((task) => task.id),
        settings: this.settings,
        dispatcherId: this.dispatcherId,
        model: this.settings.executionModel,
        reasoningEffort: this.settings.reasoningEffort,
        leaseMs: this.leaseMs,
        dayStart: today,
      });
      if (!acquired.claim || !acquired.task || !acquired.leaseToken) break;
      const project = snapshot.projects.find((candidate) => candidate.id === acquired.task.projectId);
      if (!project) throw new Error(`Claimed project '${acquired.task.projectId}' is unavailable`);
      this.lastProjectId = acquired.task.projectId;
      this.leaseTokens.set(acquired.claim.id, acquired.leaseToken);
      this.#launch(acquired.claim, acquired.task, project, acquired.leaseToken);
    }
    this.lastError = null;
  }

  async #cancelManuallyMovedClaims(snapshot) {
    for (const claim of snapshot.claims) {
      if (!ACTIVE_STATUSES.has(claim.status) || this.activeRuns.has(claim.id)) continue;
      const leaseToken = this.leaseTokens.get(claim.id);
      if (!leaseToken) continue;
      const task = snapshot.tasks.find((candidate) => candidate.id === claim.taskId);
      if (task && task.status === "in_progress") continue;
      await this.businessStore.finish(claim.id, leaseToken, { status: "canceled" });
      this.leaseTokens.delete(claim.id);
    }
  }

  #launch(claim, task, project, leaseToken) {
    const record = { child: null, promise: null };
    const runSettings = {
      ...this.settings,
      executionModel: claim.model,
      reasoningEffort: claim.reasoningEffort,
    };
    const promise = (async () => {
      let heartbeat = null;
      let currentClaim = claim;
      let codexThreadId = claim.codexThreadId;
      try {
        const result = await this.runner({
          task,
          project,
          settings: runSettings,
          codexExecutable: this.codexExecutable,
          manageTaskboardSkillPath: this.manageTaskboardSkillPath,
          companionUrl: this.companionUrl,
          onStarted: async (child) => {
            record.child = child;
            currentClaim = await this.businessStore.markRunning(claim.id, leaseToken, {
              leaseMs: this.leaseMs,
              codexThreadId,
            });
            heartbeat = setInterval(() => {
              void this.businessStore.heartbeat(claim.id, leaseToken, this.leaseMs).catch(
                (error) => { this.lastError = messageFrom(error); },
              );
            }, this.heartbeatMs);
            heartbeat.unref();
          },
          onThreadId: (value) => { codexThreadId = value; },
        });
        await this.businessStore.finish(claim.id, leaseToken, {
          status: "completed",
          codexThreadId: result.codexThreadId,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        });
        this.leaseTokens.delete(claim.id);
      } catch (error) {
        const errorMessage = messageFrom(error).slice(0, 65_536);
        if (currentClaim.attempt <= this.settings.maxRetries) {
          await this.businessStore.finish(claim.id, leaseToken, {
            status: "retry_wait",
            error: errorMessage,
            codexThreadId,
            nextRetryAt: new Date(
              Date.now() + this.settings.retryDelayMinutes * 60_000,
            ).toISOString(),
          });
        } else {
          await this.businessStore.finish(claim.id, leaseToken, {
            status: "failed",
            error: errorMessage,
            codexThreadId,
          });
          this.leaseTokens.delete(claim.id);
        }
        this.lastError = errorMessage;
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        this.activeRuns.delete(claim.id);
        this.wake("completion");
      }
    })();
    record.promise = promise;
    this.activeRuns.set(claim.id, record);
    void promise.catch((error) => { this.lastError = messageFrom(error); });
  }
}
