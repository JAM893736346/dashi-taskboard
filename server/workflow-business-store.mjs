import { ApiError } from "./database.mjs";

async function parseResponse(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(
      response.status,
      body.error?.code ?? "BUSINESS_REQUEST_FAILED",
      body.error?.message ?? `Business request failed (${response.status})`,
      body.error?.details,
    );
  }
  return body;
}

export function createWorkflowBusinessStore({ database, cloudConfig, cloudProxy }) {
  async function remote(pathname, { method = "GET", body, headers: inputHeaders } = {}) {
    const headers = new Headers(inputHeaders);
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

  return {
    async getTask(taskId) {
      if (await cloudEnabled()) {
        const body = await remote(`/api/tasks/${encodeURIComponent(taskId)}`);
        return body.task;
      }
      return database.getTask(taskId);
    },

    async setTaskStatus(taskId, status, threadId, idempotencyKey) {
      const task = await this.getTask(taskId);
      if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
      if (task.status === status) return { task, reconciled: true, idempotencyKey };

      if (await cloudEnabled()) {
        try {
          const body = await remote(`/api/tasks/${encodeURIComponent(taskId)}`, {
            method: "PATCH",
            body: { version: task.version, status, threadId },
            headers: { "x-taskboard-idempotency-key": idempotencyKey },
          });
          return { task: body.task, reconciled: false, idempotencyKey };
        } catch (error) {
          const current = await this.getTask(taskId);
          if (current?.status === status) {
            return { task: current, reconciled: true, idempotencyKey };
          }
          if (!(error instanceof ApiError)) {
            throw new ApiError(
              409,
              "WORKFLOW_ACTION_RECOVERY_REQUIRED",
              "The Issue status could not be reconciled after the remote response was lost",
              { taskId, expectedStatus: status, actualStatus: current?.status ?? null },
            );
          }
          throw error;
        }
      }

      return {
        task: database.updateTask(task.id, task.version, { status }, threadId),
        reconciled: false,
        idempotencyKey,
      };
    },

    async getTemplateWorkspace(projectId) {
      if (await cloudEnabled()) {
        const body = await remote(
          `/api/projects/${encodeURIComponent(projectId)}/workflow-workspace`,
        );
        return body.workflow;
      }
      return database.getWorkflowWorkspace(projectId);
    },
  };
}
