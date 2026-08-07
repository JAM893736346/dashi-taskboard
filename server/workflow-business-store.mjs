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
