import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import { listCodexHistory } from "../server/codex-history.mjs";
import {
  buildCodexHistoryPreview,
  matchCodexThreadProject,
  normalizeWorkspacePath,
} from "../shared/codex-history-import.mjs";

const fixtures = [];

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    await fixture.app?.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function startServer(options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-history-server-"));
  const app = createTaskboardServer({ dataDirectory: directory, ...options });
  const address = await app.listen({ port: 0 });
  fixtures.push({ app, directory });
  return { app, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, body: await response.json() };
}

test("Codex App Server history uses every opaque cursor and reads active metadata only", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-history-app-server-"));
  fixtures.push({ directory });
  const executable = path.join(directory, "fake-codex.mjs");
  const logPath = path.join(directory, "requests.jsonl");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
let buffer = "";
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      appendFileSync(process.env.CODEX_HISTORY_LOG, line + "\\n");
      const message = JSON.parse(line);
      if (message.method === "initialize") send({ id: message.id, result: {} });
      if (message.method === "thread/list" && message.params.cursor === undefined) {
        send({ id: message.id, result: { data: [{
          id: "thread-1", name: null, preview: "First preview", cwd: "/work/one",
          createdAt: 1704164645, updatedAt: 1706933106
        }], nextCursor: "opaque+cursor/one" } });
      }
      if (message.method === "thread/list" && message.params.cursor === "opaque+cursor/one") {
        send({ id: message.id, result: { data: [{
          id: "thread-2", name: "Named task", preview: "Second preview", cwd: "/work/two",
          createdAt: 1709251200, updatedAt: 1711929600
        }], nextCursor: null } });
      }
    }
    newline = buffer.indexOf("\\n");
  }
});
`, "utf8");
  await chmod(executable, 0o755);

  const threads = await listCodexHistory({
    codexExecutable: executable,
    cwd: directory,
    processEnv: { ...process.env, CODEX_HISTORY_LOG: logPath },
  });
  assert.deepEqual(threads, [
    {
      threadId: "thread-1",
      title: "First preview",
      description: "First preview",
      cwd: "/work/one",
      createdAt: "2024-01-02T03:04:05.000Z",
      updatedAt: "2024-02-03T04:05:06.000Z",
    },
    {
      threadId: "thread-2",
      title: "Named task",
      description: "Second preview",
      cwd: "/work/two",
      createdAt: "2024-03-01T00:00:00.000Z",
      updatedAt: "2024-04-01T00:00:00.000Z",
    },
  ]);

  const requests = (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const lists = requests.filter((entry) => entry.method === "thread/list");
  assert.equal(lists.length, 2);
  assert.equal(lists[0].params.cursor, undefined);
  assert.equal(lists[1].params.cursor, "opaque+cursor/one");
  assert.ok(lists.every((entry) => entry.params.archived === undefined));
  assert.ok(lists.every((entry) => entry.params.useStateDbOnly === true));
  assert.ok(requests.every((entry) => entry.method !== "thread/read"));
});

test("workspace matching prefers normalized exact and most-specific project roots", () => {
  const projects = [
    { id: "root", workspacePath: "/Users/dev/work" },
    { id: "nested", workspacePath: "/Users/dev/work/nested/" },
    { id: "windows", workspacePath: "c:\\Work\\Repo" },
  ];
  assert.equal(normalizeWorkspacePath("C:\\"), "C:/");
  assert.equal(matchCodexThreadProject("/Users/dev/work", projects), "root");
  assert.equal(matchCodexThreadProject("/Users/dev/work/nested/src", projects), "nested");
  assert.equal(matchCodexThreadProject("C:\\work\\repo\\src", projects), "windows");
  assert.equal(matchCodexThreadProject("/Users/dev/other", projects), null);

  const preview = buildCodexHistoryPreview([
    {
      threadId: "existing",
      title: "Existing",
      description: "",
      cwd: "/Users/dev/work",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    },
    {
      threadId: "unmatched",
      title: "Unmatched",
      description: "",
      cwd: "/Users/dev/other",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    },
  ], projects, ["existing"]);
  assert.equal(preview[0].matchedProjectId, "root");
  assert.equal(preview[0].existing, true);
  assert.equal(preview[1].matchedProjectId, null);
  assert.equal(preview[1].existing, false);
});

test("local import is idempotent, preserves source time, and isolates partial failures", async () => {
  const { app, baseUrl } = await startServer();
  app.database.database.exec(`
    CREATE TRIGGER fail_codex_history_import
    BEFORE INSERT ON tasks
    WHEN NEW.title = 'Intentional failure'
    BEGIN SELECT RAISE(ABORT, 'intentional import failure'); END;
  `);
  const first = {
    threadId: "local-thread-1",
    projectId: "local",
    title: "Original title",
    description: "Original preview",
    createdAt: "2023-01-02T03:04:05.000Z",
    updatedAt: "2023-02-03T04:05:06.000Z",
  };
  const third = {
    ...first,
    threadId: "local-thread-3",
    title: "Third task",
  };
  const imported = await request(baseUrl, "/api/codex-import", {
    method: "POST",
    body: {
      tasks: [
        first,
        { ...first, threadId: "local-thread-2", title: "Intentional failure" },
        third,
      ],
    },
  });
  assert.equal(imported.response.status, 200);
  assert.deepEqual(
    { imported: imported.body.imported, skipped: imported.body.skipped, failed: imported.body.failed },
    { imported: 2, skipped: 0, failed: 1 },
  );
  assert.equal(imported.body.failures[0].threadId, "local-thread-2");

  const repeated = await request(baseUrl, "/api/codex-import", {
    method: "POST",
    body: { tasks: [{ ...first, title: "Must not overwrite", description: "Changed" }] },
  });
  assert.deepEqual(
    { imported: repeated.body.imported, skipped: repeated.body.skipped, failed: repeated.body.failed },
    { imported: 0, skipped: 1, failed: 0 },
  );

  const listed = await request(baseUrl, "/api/tasks?projectId=local&archived=false");
  assert.deepEqual(listed.body.tasks.map((task) => task.identifier), ["LOCAL-1", "LOCAL-2"]);
  assert.equal(listed.body.tasks[0].title, "Original title");
  assert.equal(listed.body.tasks[0].description, "Original preview");
  assert.equal(listed.body.tasks[0].status, "backlog");
  assert.equal(listed.body.tasks[0].threadId, first.threadId);
  assert.equal(listed.body.tasks[0].createdAt, first.createdAt);
  assert.equal(listed.body.tasks[0].updatedAt, first.updatedAt);
  assert.equal(
    app.database.database.prepare("SELECT next_task_number FROM projects WHERE id = 'local'").get().next_task_number,
    3,
  );

  const ids = await request(baseUrl, "/api/codex-import");
  assert.deepEqual(ids.body.threadIds, ["local-thread-1", "local-thread-3"]);
});
