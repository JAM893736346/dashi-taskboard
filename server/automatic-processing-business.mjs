export class AutomaticProcessingBusinessError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "AutomaticProcessingBusinessError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function parseResponse(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new AutomaticProcessingBusinessError(
      response.status,
      body.error?.code ?? "BUSINESS_REQUEST_FAILED",
      body.error?.message ?? `Business request failed (${response.status})`,
      body.error?.details,
    );
  }
  return body;
}

export function createAutomaticProcessingBusinessStore({
  database,
  cloudConfig,
  cloudProxy,
}) {
  async function remote(pathname, { method = "GET", body } = {}) {
    const headers = new Headers();
    if (body !== undefined) headers.set("content-type", "application/json");
    const request = new Request(`http://127.0.0.1${pathname}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return parseResponse(await cloudProxy.forward(request));
  }

  async function cloudEnabled() {
    return Boolean((await cloudConfig.read()).remoteUrl);
  }

  async function withDeviceMappings(projects) {
    const { projectMappings } = await cloudConfig.read();
    return projects.map((project) => ({
      ...project,
      workspacePath: projectMappings[project.id] ?? project.workspacePath,
    }));
  }

  return {
    async snapshot() {
      if (await cloudEnabled()) {
        const [projects, tasks, claims] = await Promise.all([
          remote("/api/projects"),
          remote("/api/tasks?archived=false"),
          remote("/api/automation/claims?active=false&limit=200"),
        ]);
        return {
          projects: await withDeviceMappings(projects.projects),
          tasks: tasks.tasks,
          claims: claims.claims,
        };
      }
      return {
        projects: await withDeviceMappings(database.listProjects()),
        tasks: database.listTasks({ archived: "false" }),
        claims: database.listAutomationClaims({ limit: 200 }),
      };
    },
    async acquire(input) {
      if (await cloudEnabled()) {
        return remote("/api/automation/claims/acquire", { method: "POST", body: input });
      }
      const { projectMappings } = await cloudConfig.read();
      return database.claimAutomaticTask({ ...input, projectMappings });
    },
    async markRunning(id, leaseToken, input) {
      if (await cloudEnabled()) {
        const data = await remote(`/api/automation/claims/${encodeURIComponent(id)}/lifecycle`, {
          method: "POST",
          body: { action: "running", leaseToken, ...input },
        });
        return data.claim;
      }
      return database.markAutomationClaimRunning(id, leaseToken, input);
    },
    async heartbeat(id, leaseToken, leaseMs) {
      if (await cloudEnabled()) {
        const data = await remote(`/api/automation/claims/${encodeURIComponent(id)}/lifecycle`, {
          method: "POST",
          body: { action: "heartbeat", leaseToken, leaseMs },
        });
        return data.claim;
      }
      return database.heartbeatAutomationClaim(id, leaseToken, leaseMs);
    },
    async finish(id, leaseToken, input) {
      if (await cloudEnabled()) {
        const data = await remote(`/api/automation/claims/${encodeURIComponent(id)}/lifecycle`, {
          method: "POST",
          body: { action: input.status, leaseToken, ...input, status: undefined },
        });
        return data.claim;
      }
      return database.finishAutomationClaim(id, leaseToken, input);
    },
    async reconcileExpired(input) {
      if (await cloudEnabled()) {
        return remote("/api/automation/claims/reconcile-expired", {
          method: "POST",
          body: input,
        });
      }
      return database.reconcileExpiredAutomationClaims(input);
    },
  };
}
