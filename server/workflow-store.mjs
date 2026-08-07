import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  assertWorkflowRuntimeGraph,
  initialWorkflowNodeStatus,
} from "../shared/workflow-runtime.mjs";
import { ApiError } from "./database.mjs";

const ACTIVE_RUN_STATUSES = ["queued", "running", "paused"];
const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled"];
const NONTERMINAL_NODE_STATUSES = ["blocked", "ready", "running", "awaiting_confirmation"];
const RETRYABLE_NODE_STATUSES = ["failed", "interrupted", "rejected", "recovery_required"];
const TERMINAL_SUBAGENT_STATUSES = ["completed", "failed", "interrupted", "cancelled"];

function now() {
  return new Date().toISOString();
}

function parseJson(value) {
  return value === null || value === undefined ? null : JSON.parse(value);
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function sameJsonValue(left, right) {
  return isDeepStrictEqual(parseJson(left), parseJson(right));
}

function templateRevisionFromRow(row) {
  return row ? {
    id: row.id,
    projectId: row.project_id,
    templateId: row.template_id,
    revision: row.revision,
    name: row.name,
    sourceWorkspaceVersion: row.source_workspace_version,
    sourceSnapshot: parseJson(row.source_snapshot),
    sourceHash: row.source_hash,
    createdAt: row.created_at,
  } : null;
}

function revisionFromRow(row) {
  return row ? {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    templateId: row.template_id,
    templateRevisionId: row.template_revision_id,
    templateRevision: row.template_revision,
    revision: row.revision,
    status: row.status,
    graphSnapshot: parseJson(row.graph_snapshot),
    graphSchemaVersion: row.graph_schema_version,
    validationErrors: parseJson(row.validation_errors),
    reviewReport: parseJson(row.review_report),
    plannerThreadId: row.planner_thread_id,
    reviewerThreadId: row.reviewer_thread_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } : null;
}

function runFromRow(row) {
  return row ? {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    templateId: row.template_id,
    workflowRevisionId: row.workflow_revision_id,
    workflowRevision: row.workflow_revision,
    templateRevisionId: row.template_revision_id,
    templateRevision: row.template_revision,
    status: row.status,
    graphSnapshot: parseJson(row.graph_snapshot),
    graphSchemaVersion: row.graph_schema_version,
    concurrencyLimit: row.concurrency_limit,
    failFast: Boolean(row.fail_fast),
    amendmentRevision: row.amendment_revision,
    planningPath: row.planning_path,
    version: row.version,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  } : null;
}

function nodeRunFromRow(row) {
  return row ? {
    id: row.id,
    runId: row.run_id,
    definitionId: row.definition_id,
    type: row.type,
    executorVersion: row.executor_version,
    status: row.status,
    approvalMode: row.approval_mode,
    config: parseJson(row.config),
    resources: parseJson(row.resources),
    result: parseJson(row.result),
    branchOutcome: row.branch_outcome,
    activeAttemptId: row.active_attempt_id,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } : null;
}

function attemptFromRow(row) {
  return row ? {
    id: row.id,
    nodeRunId: row.node_run_id,
    attemptNumber: row.attempt_number,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    threadId: row.thread_id,
    turnId: row.turn_id,
    lastFinishedTurnId: row.last_finished_turn_id,
    lastFinishedStatus: row.last_finished_status,
    lastFinishedCandidateResultPresent: Boolean(row.last_finished_candidate_result_present),
    lastFinishedCandidateResult: parseJson(row.last_finished_candidate_result),
    lastFinishedErrorPresent: Boolean(row.last_finished_error_present),
    lastFinishedError: parseJson(row.last_finished_error),
    candidateResult: parseJson(row.candidate_result),
    error: parseJson(row.error),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  } : null;
}

function inboxMessageFromRow(row) {
  return row ? {
    id: row.id,
    runId: row.run_id,
    targetNodeRunId: row.target_node_run_id,
    sourceType: row.source_type,
    sourceNodeRunId: row.source_node_run_id,
    mode: row.mode,
    status: row.status,
    sequence: row.sequence,
    content: row.content,
    expectedTurnId: row.expected_turn_id,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  } : null;
}

function handoffFromRow(row) {
  return row ? {
    id: row.id,
    runId: row.run_id,
    predecessorNodeRunId: row.predecessor_node_run_id,
    successorNodeRunId: row.successor_node_run_id,
    payload: parseJson(row.payload),
    createdAt: row.created_at,
  } : null;
}

function subagentFromRow(row) {
  return row ? {
    id: row.id,
    nodeRunId: row.node_run_id,
    attemptId: row.attempt_id,
    threadId: row.thread_id,
    parentThreadId: row.parent_thread_id,
    role: row.role,
    model: row.model,
    status: row.status,
    activity: parseJson(row.activity),
    result: parseJson(row.result),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } : null;
}

function eventFromRow(row) {
  return row ? {
    id: row.id,
    runId: row.run_id,
    nodeRunId: row.node_run_id,
    attemptId: row.attempt_id,
    type: row.type,
    data: parseJson(row.data),
    createdAt: row.created_at,
  } : null;
}

function amendmentFromRow(row) {
  return row ? {
    id: row.id,
    runId: row.run_id,
    revision: row.revision,
    source: row.source,
    status: row.status,
    patch: parseJson(row.patch),
    reviewReport: parseJson(row.review_report),
    reviewerThreadId: row.reviewer_thread_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } : null;
}

export class WorkflowStore {
  constructor(taskboardDatabase) {
    this.database = taskboardDatabase.database;
    this.closed = false;
    this.statements = new Map();
    this.#migrate();
  }

  #migrate() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS workflow_template_revisions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        template_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        name TEXT NOT NULL,
        source_workspace_version INTEGER NOT NULL CHECK (source_workspace_version >= 0),
        source_snapshot TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (project_id, template_id, revision),
        UNIQUE (project_id, template_id, source_hash)
      );

      CREATE TABLE IF NOT EXISTS workflow_revisions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        template_id TEXT NOT NULL,
        template_revision_id TEXT NOT NULL REFERENCES workflow_template_revisions(id),
        template_revision INTEGER NOT NULL CHECK (template_revision > 0),
        revision INTEGER NOT NULL CHECK (revision > 0),
        status TEXT NOT NULL CHECK (status IN ('draft', 'reviewing', 'ready')),
        graph_snapshot TEXT,
        graph_schema_version INTEGER,
        validation_errors TEXT NOT NULL DEFAULT '[]',
        review_report TEXT,
        planner_thread_id TEXT,
        reviewer_thread_id TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (task_id, template_id, revision)
      );

      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        template_id TEXT NOT NULL,
        workflow_revision_id TEXT NOT NULL REFERENCES workflow_revisions(id),
        workflow_revision INTEGER NOT NULL,
        template_revision_id TEXT NOT NULL REFERENCES workflow_template_revisions(id),
        template_revision INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued','running','paused','completed','failed','cancelled')),
        graph_snapshot TEXT NOT NULL,
        graph_schema_version INTEGER NOT NULL,
        concurrency_limit INTEGER NOT NULL CHECK (concurrency_limit BETWEEN 1 AND 16),
        fail_fast INTEGER NOT NULL CHECK (fail_fast IN (0,1)),
        amendment_revision INTEGER NOT NULL DEFAULT 0,
        planning_path TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_one_active
        ON workflow_runs(task_id)
        WHERE status IN ('queued','running','paused');

      CREATE TABLE IF NOT EXISTS workflow_node_runs (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        definition_id TEXT NOT NULL,
        type TEXT NOT NULL,
        executor_version INTEGER NOT NULL,
        status TEXT NOT NULL,
        approval_mode TEXT NOT NULL CHECK (approval_mode IN ('automatic','manual')),
        config TEXT NOT NULL,
        resources TEXT NOT NULL,
        result TEXT,
        branch_outcome TEXT CHECK (branch_outcome IN ('true','false') OR branch_outcome IS NULL),
        active_attempt_id TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (run_id, definition_id)
      );

      CREATE TABLE IF NOT EXISTS workflow_node_attempts (
        id TEXT PRIMARY KEY,
        node_run_id TEXT NOT NULL REFERENCES workflow_node_runs(id) ON DELETE CASCADE,
        attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('running','completed','failed','interrupted','recovery_required','cancelled')),
        thread_id TEXT,
        turn_id TEXT,
        last_finished_turn_id TEXT,
        last_finished_status TEXT,
        last_finished_candidate_result_present INTEGER NOT NULL DEFAULT 0 CHECK (last_finished_candidate_result_present IN (0,1)),
        last_finished_candidate_result TEXT,
        last_finished_error_present INTEGER NOT NULL DEFAULT 0 CHECK (last_finished_error_present IN (0,1)),
        last_finished_error TEXT,
        candidate_result TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE (node_run_id, attempt_number)
      );

      CREATE TABLE IF NOT EXISTS workflow_inbox_messages (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        target_node_run_id TEXT NOT NULL REFERENCES workflow_node_runs(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL CHECK (source_type IN ('user','agent')),
        source_node_run_id TEXT REFERENCES workflow_node_runs(id),
        mode TEXT NOT NULL CHECK (mode IN ('steer','queued')),
        status TEXT NOT NULL CHECK (status IN ('pending','delivered','fallback_queued','cancelled')),
        sequence INTEGER NOT NULL,
        content TEXT NOT NULL,
        expected_turn_id TEXT,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        UNIQUE (target_node_run_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS workflow_handoffs (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        predecessor_node_run_id TEXT NOT NULL REFERENCES workflow_node_runs(id),
        successor_node_run_id TEXT NOT NULL REFERENCES workflow_node_runs(id),
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (predecessor_node_run_id, successor_node_run_id)
      );

      CREATE TABLE IF NOT EXISTS workflow_resource_leases (
        resource_key TEXT NOT NULL,
        node_run_id TEXT NOT NULL REFERENCES workflow_node_runs(id) ON DELETE CASCADE,
        mode TEXT NOT NULL CHECK (mode IN ('shared','exclusive')),
        owner TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (resource_key, node_run_id)
      );

      CREATE TABLE IF NOT EXISTS workflow_subagents (
        id TEXT PRIMARY KEY,
        node_run_id TEXT NOT NULL REFERENCES workflow_node_runs(id) ON DELETE CASCADE,
        attempt_id TEXT NOT NULL REFERENCES workflow_node_attempts(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL UNIQUE,
        parent_thread_id TEXT NOT NULL,
        role TEXT,
        model TEXT,
        status TEXT NOT NULL,
        activity TEXT,
        result TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workflow_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        node_run_id TEXT REFERENCES workflow_node_runs(id),
        attempt_id TEXT REFERENCES workflow_node_attempts(id),
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workflow_run_amendments (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision > 0),
        source TEXT NOT NULL CHECK (source IN ('user_configured','codex_generated')),
        status TEXT NOT NULL CHECK (status IN ('draft','reviewing','ready','applied','rejected')),
        patch TEXT NOT NULL,
        review_report TEXT,
        reviewer_thread_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (run_id, revision)
      );

      CREATE INDEX IF NOT EXISTS workflow_template_revisions_project_template
        ON workflow_template_revisions(project_id, template_id, revision DESC);
      CREATE INDEX IF NOT EXISTS workflow_revisions_task_template
        ON workflow_revisions(task_id, template_id, revision DESC);
      CREATE INDEX IF NOT EXISTS workflow_node_runs_run_status
        ON workflow_node_runs(run_id, status);
      CREATE INDEX IF NOT EXISTS workflow_node_attempts_thread_turn
        ON workflow_node_attempts(thread_id, turn_id);
      CREATE INDEX IF NOT EXISTS workflow_inbox_pending_fifo
        ON workflow_inbox_messages(target_node_run_id, status, sequence);
      CREATE INDEX IF NOT EXISTS workflow_resource_leases_expiration
        ON workflow_resource_leases(expires_at);
      CREATE INDEX IF NOT EXISTS workflow_events_run_created
        ON workflow_events(run_id, created_at, id);
      CREATE INDEX IF NOT EXISTS workflow_subagents_parent_node
        ON workflow_subagents(node_run_id, created_at, id);
    `);

    const attemptColumns = new Set(
      this.database.prepare("PRAGMA table_info(workflow_node_attempts)").all().map((row) => row.name),
    );
    const addedAttemptColumns = [
      ["last_finished_turn_id", "TEXT"],
      ["last_finished_status", "TEXT"],
      ["last_finished_candidate_result_present", "INTEGER NOT NULL DEFAULT 0 CHECK (last_finished_candidate_result_present IN (0,1))"],
      ["last_finished_candidate_result", "TEXT"],
      ["last_finished_error_present", "INTEGER NOT NULL DEFAULT 0 CHECK (last_finished_error_present IN (0,1))"],
      ["last_finished_error", "TEXT"],
    ];
    for (const [column, definition] of addedAttemptColumns) {
      if (!attemptColumns.has(column)) {
        this.database.exec(`ALTER TABLE workflow_node_attempts ADD COLUMN ${column} ${definition}`);
      }
    }
  }

  #ensureOpen() {
    if (this.closed) throw new Error("WorkflowStore is closed");
  }

  #statement(sql) {
    this.#ensureOpen();
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.database.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  #transaction(operation) {
    this.#ensureOpen();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  snapshotTemplate({
    projectId,
    templateId,
    name,
    sourceHash,
    workspaceVersion,
    templateSnapshot,
  }) {
    return this.#transaction(() => {
      const existing = this.#statement(`
        SELECT * FROM workflow_template_revisions
        WHERE project_id = ? AND template_id = ? AND source_hash = ?
      `).get(projectId, templateId, sourceHash);
      if (existing) return templateRevisionFromRow(existing);

      const revision = this.#statement(`
        SELECT COALESCE(MAX(revision), 0) + 1 AS revision
        FROM workflow_template_revisions
        WHERE project_id = ? AND template_id = ?
      `).get(projectId, templateId).revision;
      const id = randomUUID();
      const createdAt = now();
      this.#statement(`
        INSERT INTO workflow_template_revisions (
          id, project_id, template_id, revision, name,
          source_workspace_version, source_snapshot, source_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        projectId,
        templateId,
        revision,
        name,
        workspaceVersion,
        json(templateSnapshot),
        sourceHash,
        createdAt,
      );
      return templateRevisionFromRow(this.#templateRevisionRow(id));
    });
  }

  createRevision({ taskId, projectId, templateRevisionId, graphSnapshot, status }) {
    return this.#transaction(() => {
      const template = this.#templateRevisionRow(templateRevisionId);
      if (!template) {
        throw new ApiError(
          404,
          "WORKFLOW_TEMPLATE_REVISION_NOT_FOUND",
          `Workflow template revision '${templateRevisionId}' does not exist`,
        );
      }
      const revision = this.#statement(`
        SELECT COALESCE(MAX(revision), 0) + 1 AS revision
        FROM workflow_revisions
        WHERE task_id = ? AND template_id = ?
      `).get(taskId, template.template_id).revision;
      const id = randomUUID();
      const timestamp = now();
      this.#statement(`
        INSERT INTO workflow_revisions (
          id, task_id, project_id, template_id, template_revision_id,
          template_revision, revision, status, graph_snapshot,
          graph_schema_version, validation_errors, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 1, ?, ?)
      `).run(
        id,
        taskId,
        projectId,
        template.template_id,
        templateRevisionId,
        template.revision,
        revision,
        status,
        graphSnapshot === null || graphSnapshot === undefined ? null : json(graphSnapshot),
        graphSnapshot?.schemaVersion ?? null,
        timestamp,
        timestamp,
      );
      return revisionFromRow(this.#revisionRow(id));
    });
  }

  getTemplateRevision(id) {
    this.#ensureOpen();
    return templateRevisionFromRow(this.#templateRevisionRow(id));
  }

  getRevision(id) {
    this.#ensureOpen();
    return revisionFromRow(this.#revisionRow(id));
  }

  listTaskRevisions(taskId) {
    return this.#statement(`
      SELECT * FROM workflow_revisions
      WHERE task_id = ?
      ORDER BY created_at DESC, id DESC
    `).all(taskId).map(revisionFromRow);
  }

  updateRevision(id, expectedVersion, changes) {
    this.#ensureOpen();
    const columns = {
      status: ["status", (value) => value],
      graphSnapshot: ["graph_snapshot", (value) => value === null ? null : json(value)],
      graphSchemaVersion: ["graph_schema_version", (value) => value],
      validationErrors: ["validation_errors", json],
      reviewReport: ["review_report", (value) => value === null ? null : json(value)],
      plannerThreadId: ["planner_thread_id", (value) => value],
      reviewerThreadId: ["reviewer_thread_id", (value) => value],
    };
    const assignments = [];
    const values = [];
    for (const [key, [column, serialize]] of Object.entries(columns)) {
      if (!Object.hasOwn(changes, key)) continue;
      assignments.push(`${column} = ?`);
      values.push(serialize(changes[key]));
    }
    if (Object.hasOwn(changes, "graphSnapshot") && !Object.hasOwn(changes, "graphSchemaVersion")) {
      assignments.push("graph_schema_version = ?");
      values.push(changes.graphSnapshot?.schemaVersion ?? null);
    }
    if (assignments.length === 0) {
      const current = this.getRevision(id);
      if (!current) this.#throwRevisionMissingOrConflict(id, expectedVersion);
      if (current.version !== expectedVersion) this.#throwRevisionMissingOrConflict(id, expectedVersion);
      return current;
    }

    assignments.push("version = version + 1", "updated_at = ?");
    values.push(now(), id, expectedVersion);
    const result = this.#statement(`
      UPDATE workflow_revisions
      SET ${assignments.join(", ")}
      WHERE id = ? AND version = ?
    `).run(...values);
    if (result.changes !== 1) this.#throwRevisionMissingOrConflict(id, expectedVersion);
    return this.getRevision(id);
  }

  getActiveRunForTask(taskId) {
    const placeholders = ACTIVE_RUN_STATUSES.map(() => "?").join(", ");
    return runFromRow(this.#statement(`
      SELECT * FROM workflow_runs
      WHERE task_id = ? AND status IN (${placeholders})
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(taskId, ...ACTIVE_RUN_STATUSES));
  }

  getRun(id) {
    return runFromRow(this.#runRow(id));
  }

  transitionRun(runId, expectedStatuses, nextStatus) {
    if (!Array.isArray(expectedStatuses) || expectedStatuses.length === 0) {
      throw new TypeError("expectedStatuses must contain at least one status");
    }
    return this.#transaction(() => {
      const current = this.#runRow(runId);
      if (!current) {
        throw new ApiError(404, "WORKFLOW_RUN_NOT_FOUND", `Workflow run '${runId}' does not exist`);
      }
      if (!expectedStatuses.includes(current.status)) {
        throw new ApiError(
          409,
          "WORKFLOW_RUN_STATE_CONFLICT",
          "Workflow run state changed before the transition",
          { expectedStatuses, actualStatus: current.status, actualVersion: current.version },
        );
      }

      if (TERMINAL_RUN_STATUSES.includes(nextStatus)) {
        const nodePlaceholders = NONTERMINAL_NODE_STATUSES.map(() => "?").join(", ");
        const subagentPlaceholders = TERMINAL_SUBAGENT_STATUSES.map(() => "?").join(", ");
        const unsettled = this.#statement(`
          SELECT
            (SELECT COUNT(*) FROM workflow_node_runs
              WHERE run_id = ? AND status IN (${nodePlaceholders})) AS nonterminal_node_count,
            (SELECT COUNT(*) FROM workflow_node_attempts
              JOIN workflow_node_runs ON workflow_node_runs.id = workflow_node_attempts.node_run_id
              WHERE workflow_node_runs.run_id = ? AND workflow_node_attempts.status = 'running') AS running_attempt_count,
            (SELECT COUNT(*) FROM workflow_subagents
              JOIN workflow_node_runs ON workflow_node_runs.id = workflow_subagents.node_run_id
              WHERE workflow_node_runs.run_id = ?
                AND workflow_subagents.status NOT IN (${subagentPlaceholders})) AS nonterminal_subagent_count,
            (SELECT COUNT(*) FROM workflow_resource_leases
              JOIN workflow_node_runs ON workflow_node_runs.id = workflow_resource_leases.node_run_id
              WHERE workflow_node_runs.run_id = ?) AS resource_lease_count
        `).get(
          runId,
          ...NONTERMINAL_NODE_STATUSES,
          runId,
          runId,
          ...TERMINAL_SUBAGENT_STATUSES,
          runId,
        );
        if (Object.values(unsettled).some((count) => count > 0)) {
          throw new ApiError(
            409,
            "WORKFLOW_RUN_STATE_CONFLICT",
            "Workflow run cannot become terminal until its aggregate is settled",
            {
              runId,
              nextStatus,
              nonterminalNodeCount: unsettled.nonterminal_node_count,
              runningAttemptCount: unsettled.running_attempt_count,
              nonterminalSubagentCount: unsettled.nonterminal_subagent_count,
              resourceLeaseCount: unsettled.resource_lease_count,
            },
          );
        }
      }

      const timestamp = now();
      const assignments = ["status = ?", "version = version + 1", "updated_at = ?"];
      const values = [nextStatus, timestamp];
      if (nextStatus === "running") {
        assignments.push("started_at = COALESCE(started_at, ?)", "finished_at = NULL");
        values.push(timestamp);
      } else if (TERMINAL_RUN_STATUSES.includes(nextStatus)) {
        assignments.push("finished_at = COALESCE(finished_at, ?)");
        values.push(timestamp);
      } else {
        assignments.push("finished_at = NULL");
      }
      values.push(runId, current.version);
      const result = this.#statement(`
        UPDATE workflow_runs SET ${assignments.join(", ")}
        WHERE id = ? AND version = ?
      `).run(...values);
      if (result.changes !== 1) {
        const actual = this.#runRow(runId);
        throw new ApiError(
          409,
          "WORKFLOW_RUN_STATE_CONFLICT",
          "Workflow run state changed before the transition",
          {
            expectedStatuses,
            expectedVersion: current.version,
            actualStatus: actual?.status ?? null,
            actualVersion: actual?.version ?? null,
          },
        );
      }
      return runFromRow(this.#runRow(runId));
    });
  }

  getRunSnapshot(id) {
    const run = this.getRun(id);
    if (!run) return null;
    return {
      run,
      nodes: this.#statement(`
        SELECT * FROM workflow_node_runs WHERE run_id = ? ORDER BY created_at, rowid
      `).all(id).map(nodeRunFromRow),
      attempts: this.#statement(`
        SELECT workflow_node_attempts.*
        FROM workflow_node_attempts
        JOIN workflow_node_runs ON workflow_node_runs.id = workflow_node_attempts.node_run_id
        WHERE workflow_node_runs.run_id = ?
        ORDER BY workflow_node_runs.created_at, workflow_node_runs.rowid, attempt_number
      `).all(id).map(attemptFromRow),
      inbox: this.#statement(`
        SELECT * FROM workflow_inbox_messages
        WHERE run_id = ? ORDER BY created_at, sequence, id
      `).all(id).map(inboxMessageFromRow),
      handoffs: this.#statement(`
        SELECT * FROM workflow_handoffs WHERE run_id = ? ORDER BY created_at, rowid
      `).all(id).map(handoffFromRow),
      subagents: this.#statement(`
        SELECT workflow_subagents.*
        FROM workflow_subagents
        JOIN workflow_node_runs ON workflow_node_runs.id = workflow_subagents.node_run_id
        WHERE workflow_node_runs.run_id = ?
        ORDER BY workflow_subagents.created_at, workflow_subagents.rowid
      `).all(id).map(subagentFromRow),
      amendments: this.#statement(`
        SELECT * FROM workflow_run_amendments
        WHERE run_id = ? ORDER BY revision
      `).all(id).map(amendmentFromRow),
      events: this.#statement(`
        SELECT * FROM workflow_events
        WHERE run_id = ? ORDER BY created_at, rowid
      `).all(id).map(eventFromRow),
    };
  }

  listNonterminalRuns() {
    const placeholders = ACTIVE_RUN_STATUSES.map(() => "?").join(", ");
    return this.#statement(`
      SELECT * FROM workflow_runs
      WHERE status IN (${placeholders})
      ORDER BY created_at, id
    `).all(...ACTIVE_RUN_STATUSES).map(runFromRow);
  }

  enqueueRevision({ runId, revisionId, planningPath }) {
    this.#transaction(() => {
      const revision = this.#revisionRow(revisionId);
      if (!revision) {
        throw new ApiError(
          404,
          "WORKFLOW_REVISION_NOT_FOUND",
          `Workflow revision '${revisionId}' does not exist`,
        );
      }
      if (revision.status !== "ready") {
        throw new ApiError(
          409,
          "WORKFLOW_REVISION_NOT_READY",
          "Only a ready workflow revision can be enqueued",
          { revisionId, status: revision.status },
        );
      }
      const active = this.#statement(`
        SELECT id, status FROM workflow_runs
        WHERE task_id = ? AND status IN ('queued', 'running', 'paused')
        ORDER BY created_at DESC, id DESC LIMIT 1
      `).get(revision.task_id);
      if (active) {
        throw new ApiError(
          409,
          "WORKFLOW_RUN_ACTIVE",
          "This Issue already has an active workflow run",
          { runId: active.id, status: active.status },
        );
      }
      if (revision.graph_snapshot === null) {
        throw new ApiError(
          409,
          "WORKFLOW_REVISION_NOT_READY",
          "Ready workflow revision has no graph snapshot",
          { revisionId },
        );
      }
      const graph = assertWorkflowRuntimeGraph(JSON.parse(revision.graph_snapshot));
      const timestamp = now();
      this.#statement(`
        INSERT INTO workflow_runs (
          id, task_id, project_id, template_id, workflow_revision_id,
          workflow_revision, template_revision_id, template_revision, status,
          graph_snapshot, graph_schema_version, concurrency_limit, fail_fast,
          amendment_revision, planning_path, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, 0, ?, 1, ?, ?)
      `).run(
        runId,
        revision.task_id,
        revision.project_id,
        revision.template_id,
        revision.id,
        revision.revision,
        revision.template_revision_id,
        revision.template_revision,
        revision.graph_snapshot,
        graph.schemaVersion,
        graph.defaults.concurrencyLimit,
        graph.defaults.failFast ? 1 : 0,
        planningPath,
        timestamp,
        timestamp,
      );

      const readyNodes = [];
      for (const node of graph.nodes) {
        const nodeRunId = randomUUID();
        const status = initialWorkflowNodeStatus(node);
        this.#statement(`
          INSERT INTO workflow_node_runs (
            id, run_id, definition_id, type, executor_version, status,
            approval_mode, config, resources, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `).run(
          nodeRunId,
          runId,
          node.id,
          node.type,
          node.executorVersion,
          status,
          node.approvalMode,
          json(node.config),
          json(node.resources),
          timestamp,
          timestamp,
        );
        if (status === "ready") readyNodes.push({ id: nodeRunId, definitionId: node.id });
      }

      this.#insertEvent({
        runId,
        type: "workflow.run.enqueued",
        data: { revisionId, workflowRevision: revision.revision },
        createdAt: timestamp,
      });
      for (const node of readyNodes) {
        this.#insertEvent({
          runId,
          nodeRunId: node.id,
          type: "workflow.node.ready",
          data: { definitionId: node.definitionId },
          createdAt: timestamp,
        });
      }
    });
    return this.getRunSnapshot(runId);
  }

  claimReadyNodes({ runId, owner, limit, leaseMs }) {
    if (!Number.isInteger(limit) || limit < 1) return [];
    if (typeof owner !== "string" || owner.length === 0 || !Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new ApiError(400, "INVALID_WORKFLOW_LEASE", "Workflow lease owner and duration are required");
    }
    return this.#transaction(() => {
      const run = this.#runRow(runId);
      if (!run) {
        throw new ApiError(404, "WORKFLOW_RUN_NOT_FOUND", `Workflow run '${runId}' does not exist`);
      }
      if (run.status !== "queued" && run.status !== "running") return [];

      const claimedAt = now();
      const expiresAt = new Date(Date.now() + leaseMs).toISOString();
      this.#statement(`
        DELETE FROM workflow_resource_leases
        WHERE expires_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM workflow_node_runs
            WHERE workflow_node_runs.id = workflow_resource_leases.node_run_id
              AND workflow_node_runs.status = 'running'
          )
      `).run(claimedAt);
      const activeCount = this.#statement(`
        SELECT COUNT(*) AS count
        FROM workflow_node_runs
        WHERE run_id = ?
          AND (
            status = 'running'
            OR (
              status = 'ready'
              AND lease_owner IS NOT NULL
              AND lease_expires_at > ?
            )
          )
      `).get(runId, claimedAt).count;
      const claimLimit = Math.min(limit, Math.max(0, run.concurrency_limit - activeCount));
      if (claimLimit === 0) return [];
      const candidates = this.#statement(`
        SELECT * FROM workflow_node_runs
        WHERE run_id = ? AND status = 'ready'
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        ORDER BY created_at, rowid
      `).all(runId, claimedAt);
      const claimed = [];
      for (const candidate of candidates) {
        if (claimed.length >= claimLimit) break;
        const resources = parseJson(candidate.resources) ?? [];
        const compatible = resources.every((resource) => {
          const held = this.#statement(`
            SELECT mode FROM workflow_resource_leases
            WHERE resource_key = ? AND node_run_id <> ?
          `).all(resource.key, candidate.id);
          return resource.mode === "shared"
            ? held.every((lease) => lease.mode === "shared")
            : held.length === 0;
        });
        if (!compatible) continue;

        const result = this.#statement(`
          UPDATE workflow_node_runs
          SET lease_owner = ?, lease_expires_at = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND status = 'ready'
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        `).run(owner, expiresAt, claimedAt, candidate.id, claimedAt);
        if (result.changes !== 1) continue;
        for (const resource of resources) {
          this.#statement(`
            INSERT INTO workflow_resource_leases (
              resource_key, node_run_id, mode, owner, expires_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(resource_key, node_run_id) DO UPDATE SET
              mode = excluded.mode,
              owner = excluded.owner,
              expires_at = excluded.expires_at
          `).run(resource.key, candidate.id, resource.mode, owner, expiresAt, claimedAt);
        }
        claimed.push(nodeRunFromRow(this.#nodeRunRow(candidate.id)));
      }
      return claimed;
    });
  }

  renewNodeLease({ nodeRunId, owner, leaseMs }) {
    if (typeof owner !== "string" || owner.length === 0 || !Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new ApiError(400, "INVALID_WORKFLOW_LEASE", "Workflow lease owner and duration are required");
    }
    return this.#transaction(() => {
      const node = this.#nodeRunRow(nodeRunId);
      if (!node) {
        throw new ApiError(404, "WORKFLOW_NODE_NOT_FOUND", `Workflow node run '${nodeRunId}' does not exist`);
      }
      if (node.status !== "running" || node.lease_owner !== owner) {
        throw new ApiError(
          409,
          "WORKFLOW_LEASE_LOST",
          "Workflow node lease is not owned by this scheduler",
          {
            nodeRunId,
            owner,
            actualOwner: node.lease_owner,
            nodeStatus: node.status,
          },
        );
      }

      const resources = parseJson(node.resources) ?? [];
      const leases = this.#statement(`
        SELECT resource_key, mode, owner
        FROM workflow_resource_leases WHERE node_run_id = ?
      `).all(nodeRunId);
      const leasesByKey = new Map(leases.map((lease) => [lease.resource_key, lease]));
      const resourcesOwned = leases.length === resources.length
        && resources.every((resource) => {
          const lease = leasesByKey.get(resource.key);
          return lease?.mode === resource.mode && lease.owner === owner;
        });
      if (!resourcesOwned) {
        throw new ApiError(
          409,
          "WORKFLOW_LEASE_LOST",
          "Workflow resource leases no longer match the node lease",
          { nodeRunId, owner },
        );
      }

      const timestamp = now();
      const expiresAt = new Date(Date.now() + leaseMs).toISOString();
      this.#statement(`
        UPDATE workflow_resource_leases SET expires_at = ?
        WHERE node_run_id = ? AND owner = ?
      `).run(expiresAt, nodeRunId, owner);
      const result = this.#statement(`
        UPDATE workflow_node_runs
        SET lease_expires_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND status = 'running' AND lease_owner = ?
      `).run(expiresAt, timestamp, nodeRunId, owner);
      if (result.changes !== 1) {
        throw new ApiError(
          409,
          "WORKFLOW_LEASE_LOST",
          "Workflow node lease changed before renewal",
          { nodeRunId, owner },
        );
      }
      return nodeRunFromRow(this.#nodeRunRow(nodeRunId));
    });
  }

  startAttempt({ nodeRunId, owner, threadId = null, turnId = null }) {
    if (typeof owner !== "string" || owner.length === 0) {
      throw new ApiError(400, "INVALID_WORKFLOW_LEASE", "Workflow lease owner is required");
    }
    return this.#transaction(() => {
      const node = this.#statement(`
        SELECT workflow_node_runs.*, workflow_runs.status AS run_status
        FROM workflow_node_runs
        JOIN workflow_runs ON workflow_runs.id = workflow_node_runs.run_id
        WHERE workflow_node_runs.id = ?
      `).get(nodeRunId);
      if (!node) {
        throw new ApiError(404, "WORKFLOW_NODE_NOT_FOUND", `Workflow node run '${nodeRunId}' does not exist`);
      }
      if (node.status !== "ready" || node.active_attempt_id !== null) {
        throw new ApiError(
          409,
          "WORKFLOW_NODE_NOT_READY",
          "Workflow node is not ready for a new attempt",
          { nodeRunId, status: node.status },
        );
      }
      if (node.run_status !== "queued" && node.run_status !== "running") {
        throw new ApiError(
          409,
          "WORKFLOW_RUN_STATE_CONFLICT",
          "Workflow run is not active for a new attempt",
          { nodeRunId, runId: node.run_id, runStatus: node.run_status },
        );
      }
      const timestamp = now();
      if (node.lease_owner !== owner || node.lease_expires_at === null || node.lease_expires_at <= timestamp) {
        throw new ApiError(
          409,
          "WORKFLOW_LEASE_LOST",
          "Workflow node lease is not live for this scheduler",
          {
            nodeRunId,
            owner,
            actualOwner: node.lease_owner,
            leaseExpiresAt: node.lease_expires_at,
          },
        );
      }
      const resources = parseJson(node.resources) ?? [];
      const leases = this.#statement(`
        SELECT resource_key, mode, owner, expires_at
        FROM workflow_resource_leases WHERE node_run_id = ?
      `).all(nodeRunId);
      const leasesByKey = new Map(leases.map((lease) => [lease.resource_key, lease]));
      const resourcesOwned = resources.every((resource) => {
        const lease = leasesByKey.get(resource.key);
        return lease?.mode === resource.mode
          && lease.owner === owner
          && lease.expires_at > timestamp;
      });
      if (!resourcesOwned) {
        throw new ApiError(
          409,
          "WORKFLOW_LEASE_LOST",
          "Workflow resource leases are not live for this scheduler",
          { nodeRunId, owner },
        );
      }
      const attemptNumber = this.#statement(`
        SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt_number
        FROM workflow_node_attempts WHERE node_run_id = ?
      `).get(nodeRunId).attempt_number;
      const id = randomUUID();
      const idempotencyKey = `${node.run_id}:${node.definition_id}:${attemptNumber}:${node.executor_version}`;
      this.#statement(`
        INSERT INTO workflow_node_attempts (
          id, node_run_id, attempt_number, idempotency_key, status,
          thread_id, turn_id, started_at
        ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)
      `).run(id, nodeRunId, attemptNumber, idempotencyKey, threadId, turnId, timestamp);
      this.#statement(`
        UPDATE workflow_node_runs
        SET status = 'running', active_attempt_id = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND status = 'ready' AND active_attempt_id IS NULL
          AND lease_owner = ? AND lease_expires_at > ?
      `).run(id, timestamp, nodeRunId, owner, timestamp);
      return attemptFromRow(this.#attemptRow(id));
    });
  }

  bindAttemptThread({ attemptId, threadId, turnId }) {
    return this.#transaction(() => {
      const attempt = this.#statement(`
        SELECT
          workflow_node_attempts.*,
          workflow_node_runs.status AS node_status,
          workflow_node_runs.active_attempt_id
        FROM workflow_node_attempts
        JOIN workflow_node_runs ON workflow_node_runs.id = workflow_node_attempts.node_run_id
        WHERE workflow_node_attempts.id = ?
      `).get(attemptId);
      if (!attempt) {
        throw new ApiError(404, "WORKFLOW_ATTEMPT_NOT_FOUND", `Workflow attempt '${attemptId}' does not exist`);
      }
      if (
        attempt.status !== "running"
        || attempt.node_status !== "running"
        || attempt.active_attempt_id !== attemptId
      ) {
        throw new ApiError(
          409,
          "WORKFLOW_ATTEMPT_STATE_CONFLICT",
          "Only the current active running attempt can bind a thread",
          {
            attemptId,
            attemptStatus: attempt.status,
            nodeStatus: attempt.node_status,
            activeAttemptId: attempt.active_attempt_id,
          },
        );
      }
      if (attempt.thread_id !== null && threadId !== null && attempt.thread_id !== threadId) {
        throw new ApiError(
          409,
          "WORKFLOW_ATTEMPT_BINDING_CONFLICT",
          "Workflow attempt is already bound to another thread",
          { attemptId, expectedThreadId: attempt.thread_id, actualThreadId: threadId },
        );
      }
      if (attempt.turn_id !== null && turnId !== null && attempt.turn_id !== turnId) {
        throw new ApiError(
          409,
          "WORKFLOW_ATTEMPT_BINDING_CONFLICT",
          "Workflow attempt is already bound to another turn",
          { attemptId, expectedTurnId: attempt.turn_id, actualTurnId: turnId },
        );
      }
      const nextThreadId = threadId ?? attempt.thread_id;
      const nextTurnId = turnId ?? attempt.turn_id;
      if (nextThreadId === attempt.thread_id && nextTurnId === attempt.turn_id) {
        return attemptFromRow(attempt);
      }
      this.#statement(`
        UPDATE workflow_node_attempts SET thread_id = ?, turn_id = ?
        WHERE id = ? AND status = 'running'
      `).run(nextThreadId, nextTurnId, attemptId);
      return attemptFromRow(this.#attemptRow(attemptId));
    });
  }

  appendEvent({ runId, nodeRunId = null, attemptId = null, type, data }) {
    this.#ensureOpen();
    return eventFromRow(this.#insertEvent({ runId, nodeRunId, attemptId, type, data }));
  }

  appendInboxMessage({
    targetNodeRunId,
    sourceType,
    sourceNodeRunId = null,
    mode,
    content,
    expectedTurnId = null,
  }) {
    return this.#transaction(() => {
      const node = this.#nodeRunRow(targetNodeRunId);
      if (!node) {
        throw new ApiError(
          404,
          "WORKFLOW_NODE_NOT_FOUND",
          `Workflow node run '${targetNodeRunId}' does not exist`,
        );
      }
      const sequence = this.#statement(`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
        FROM workflow_inbox_messages WHERE target_node_run_id = ?
      `).get(targetNodeRunId).sequence;
      const id = randomUUID();
      const createdAt = now();
      this.#statement(`
        INSERT INTO workflow_inbox_messages (
          id, run_id, target_node_run_id, source_type, source_node_run_id,
          mode, status, sequence, content, expected_turn_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
      `).run(
        id,
        node.run_id,
        targetNodeRunId,
        sourceType,
        sourceNodeRunId,
        mode,
        sequence,
        content,
        expectedTurnId,
        createdAt,
      );
      return inboxMessageFromRow(this.#inboxRow(id));
    });
  }

  markInboxMessage(id, status) {
    this.#ensureOpen();
    const deliveredAt = status === "delivered" ? now() : null;
    const result = status === "fallback_queued"
      ? this.#statement(`
          UPDATE workflow_inbox_messages
          SET mode = 'queued', status = 'fallback_queued', delivered_at = NULL
          WHERE id = ?
        `).run(id)
      : this.#statement(`
          UPDATE workflow_inbox_messages SET status = ?, delivered_at = ? WHERE id = ?
        `).run(status, deliveredAt, id);
    if (result.changes !== 1) {
      throw new ApiError(404, "WORKFLOW_INBOX_NOT_FOUND", `Workflow inbox message '${id}' does not exist`);
    }
    return inboxMessageFromRow(this.#inboxRow(id));
  }

  peekQueuedMessage(nodeRunId) {
    return inboxMessageFromRow(this.#statement(`
      SELECT * FROM workflow_inbox_messages
      WHERE target_node_run_id = ? AND mode = 'queued'
        AND status IN ('pending', 'fallback_queued')
      ORDER BY sequence LIMIT 1
    `).get(nodeRunId));
  }

  upsertSubagent(input) {
    if (typeof input.threadId !== "string" || input.threadId.length === 0) {
      throw new ApiError(
        400,
        "INVALID_WORKFLOW_SUBAGENT_IDENTITY",
        "Workflow Subagent identity fields are required",
      );
    }
    return this.#transaction(() => {
      const existing = this.#statement(`
        SELECT * FROM workflow_subagents WHERE thread_id = ?
      `).get(input.threadId);
      const timestamp = now();
      if (existing) {
        const identityFields = [
          ["nodeRunId", "node_run_id"],
          ["attemptId", "attempt_id"],
          ["parentThreadId", "parent_thread_id"],
        ];
        const changedIdentity = identityFields.find(
          ([inputKey, rowKey]) => Object.hasOwn(input, inputKey) && input[inputKey] !== existing[rowKey],
        );
        if (changedIdentity) {
          throw new ApiError(
            409,
            "WORKFLOW_SUBAGENT_IDENTITY_CONFLICT",
            "Workflow Subagent identity cannot be changed",
            {
              threadId: input.threadId,
              field: changedIdentity[0],
              expectedValue: existing[changedIdentity[1]],
              actualValue: input[changedIdentity[0]],
            },
          );
        }
        this.#statement(`
          UPDATE workflow_subagents
          SET role = ?, model = ?, status = ?, activity = ?, result = ?, updated_at = ?
          WHERE thread_id = ?
        `).run(
          input.role === undefined ? existing.role : input.role,
          input.model === undefined ? existing.model : input.model,
          input.status ?? existing.status,
          input.activity === undefined
            ? existing.activity
            : input.activity === null ? null : json(input.activity),
          input.result === undefined
            ? existing.result
            : input.result === null ? null : json(input.result),
          timestamp,
          input.threadId,
        );
      } else {
        const identity = [input.nodeRunId, input.attemptId, input.parentThreadId];
        if (identity.some((value) => typeof value !== "string" || value.length === 0)) {
          throw new ApiError(
            400,
            "INVALID_WORKFLOW_SUBAGENT_IDENTITY",
            "Workflow Subagent identity fields are required",
          );
        }
        const attempt = this.#attemptRow(input.attemptId);
        if (!attempt) {
          throw new ApiError(
            404,
            "WORKFLOW_ATTEMPT_NOT_FOUND",
            `Workflow attempt '${input.attemptId}' does not exist`,
          );
        }
        if (
          attempt.node_run_id !== input.nodeRunId
          || attempt.thread_id === null
          || attempt.thread_id !== input.parentThreadId
        ) {
          throw new ApiError(
            409,
            "WORKFLOW_SUBAGENT_IDENTITY_CONFLICT",
            "Workflow Subagent identity does not match its parent attempt",
            {
              nodeRunId: input.nodeRunId,
              attemptId: input.attemptId,
              parentThreadId: input.parentThreadId,
              attemptNodeRunId: attempt.node_run_id,
              attemptThreadId: attempt.thread_id,
            },
          );
        }
        this.#statement(`
          INSERT INTO workflow_subagents (
            id, node_run_id, attempt_id, thread_id, parent_thread_id,
            role, model, status, activity, result, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.id ?? randomUUID(),
          input.nodeRunId,
          input.attemptId,
          input.threadId,
          input.parentThreadId,
          input.role ?? null,
          input.model ?? null,
          input.status,
          input.activity === undefined || input.activity === null ? null : json(input.activity),
          input.result === undefined || input.result === null ? null : json(input.result),
          input.createdAt ?? timestamp,
          timestamp,
        );
      }
      return subagentFromRow(
        this.#statement("SELECT * FROM workflow_subagents WHERE thread_id = ?").get(input.threadId),
      );
    });
  }

  finishTurn({ attemptId, expectedTurnId, status, candidateResult, error }) {
    if (typeof expectedTurnId !== "string" || expectedTurnId.length === 0) {
      throw new ApiError(400, "INVALID_WORKFLOW_TURN", "Expected workflow turn ID is required");
    }
    return this.#transaction(() => {
      const attempt = this.#statement(`
        SELECT
          workflow_node_attempts.*,
          workflow_node_runs.status AS node_status,
          workflow_node_runs.active_attempt_id
        FROM workflow_node_attempts
        JOIN workflow_node_runs ON workflow_node_runs.id = workflow_node_attempts.node_run_id
        WHERE workflow_node_attempts.id = ?
      `).get(attemptId);
      if (!attempt) {
        throw new ApiError(404, "WORKFLOW_ATTEMPT_NOT_FOUND", `Workflow attempt '${attemptId}' does not exist`);
      }
      const candidateResultPresent = candidateResult !== undefined;
      const normalizedCandidateResult = candidateResultPresent ? json(candidateResult) : null;
      const errorPresent = error !== undefined;
      const normalizedError = errorPresent ? json(error) : null;
      if (attempt.turn_id !== null && attempt.turn_id !== expectedTurnId) {
        throw new ApiError(
          409,
          "WORKFLOW_ATTEMPT_TURN_CONFLICT",
          "Workflow turn changed before completion",
          { attemptId, expectedTurnId, actualTurnId: attempt.turn_id },
        );
      }
      if (attempt.last_finished_turn_id === expectedTurnId) {
        if (
          attempt.last_finished_status === status
          && Boolean(attempt.last_finished_candidate_result_present) === candidateResultPresent
          && sameJsonValue(attempt.last_finished_candidate_result, normalizedCandidateResult)
          && Boolean(attempt.last_finished_error_present) === errorPresent
          && sameJsonValue(attempt.last_finished_error, normalizedError)
        ) {
          return attemptFromRow(attempt);
        }
        throw new ApiError(
          409,
          "WORKFLOW_ATTEMPT_TURN_CONFLICT",
          "Workflow turn was already completed with another outcome",
          { attemptId, expectedTurnId, lastFinishedTurnId: attempt.last_finished_turn_id },
        );
      }
      if (attempt.status !== "running") {
        throw new ApiError(
          409,
          "WORKFLOW_ATTEMPT_STATE_CONFLICT",
          "Workflow attempt is already terminal or the completed turn is stale",
          {
            attemptId,
            expectedTurnId,
            lastFinishedTurnId: attempt.last_finished_turn_id,
            expectedStatus: status,
            actualStatus: attempt.status,
          },
        );
      }
      if (attempt.node_status !== "running" || attempt.active_attempt_id !== attemptId) {
        throw new ApiError(
          409,
          "WORKFLOW_ATTEMPT_STATE_CONFLICT",
          "Only the current active running attempt can finish a turn",
          {
            attemptId,
            nodeStatus: attempt.node_status,
            activeAttemptId: attempt.active_attempt_id,
          },
        );
      }
      if (attempt.turn_id !== expectedTurnId) {
        throw new ApiError(
          409,
          "WORKFLOW_ATTEMPT_TURN_CONFLICT",
          "Workflow turn changed before completion",
          { attemptId, expectedTurnId, actualTurnId: attempt.turn_id },
        );
      }

      const assignments = [
        "status = ?",
        "turn_id = NULL",
        "last_finished_turn_id = ?",
        "last_finished_status = ?",
        "last_finished_candidate_result_present = ?",
        "last_finished_candidate_result = ?",
        "last_finished_error_present = ?",
        "last_finished_error = ?",
        "finished_at = ?",
      ];
      const values = [
        status,
        expectedTurnId,
        status,
        candidateResultPresent ? 1 : 0,
        normalizedCandidateResult,
        errorPresent ? 1 : 0,
        normalizedError,
        status === "running" ? null : now(),
      ];
      if (candidateResultPresent) {
        assignments.push("candidate_result = ?");
        values.push(normalizedCandidateResult);
      }
      if (errorPresent) {
        assignments.push("error = ?");
        values.push(normalizedError);
      }
      values.push(attemptId, expectedTurnId);
      const result = this.#statement(`
        UPDATE workflow_node_attempts SET ${assignments.join(", ")}
        WHERE id = ? AND status = 'running' AND turn_id = ?
      `).run(...values);
      if (result.changes !== 1) {
        throw new ApiError(
          409,
          "WORKFLOW_ATTEMPT_TURN_CONFLICT",
          "Workflow turn changed before completion",
          { attemptId, expectedTurnId },
        );
      }
      return attemptFromRow(this.#attemptRow(attemptId));
    });
  }

  completeNodeIfBarrierSatisfied(nodeRunId) {
    return this.#transaction(() => {
      const node = this.#nodeRunRow(nodeRunId);
      if (!node) {
        throw new ApiError(404, "WORKFLOW_NODE_NOT_FOUND", `Workflow node run '${nodeRunId}' does not exist`);
      }
      if (node.status !== "running" || node.active_attempt_id === null) return null;
      const attempt = this.#attemptRow(node.active_attempt_id);
      if (!attempt || attempt.status !== "completed" || attempt.turn_id !== null) return null;
      if (attempt.candidate_result === null) return null;
      const pendingInbox = this.#statement(`
        SELECT 1 FROM workflow_inbox_messages
        WHERE target_node_run_id = ? AND status IN ('pending', 'fallback_queued') LIMIT 1
      `).get(nodeRunId);
      if (pendingInbox) return null;
      const terminalPlaceholders = TERMINAL_SUBAGENT_STATUSES.map(() => "?").join(", ");
      const activeSubagent = this.#statement(`
        SELECT 1 FROM workflow_subagents
        WHERE node_run_id = ? AND status NOT IN (${terminalPlaceholders}) LIMIT 1
      `).get(nodeRunId, ...TERMINAL_SUBAGENT_STATUSES);
      if (activeSubagent) return null;

      const timestamp = now();
      const nextStatus = node.approval_mode === "manual" ? "awaiting_confirmation" : "succeeded";
      this.#statement("DELETE FROM workflow_resource_leases WHERE node_run_id = ?").run(nodeRunId);
      this.#statement(`
        UPDATE workflow_node_runs
        SET status = ?, result = ?, lease_owner = NULL, lease_expires_at = NULL,
            version = version + 1, updated_at = ?
        WHERE id = ? AND status = 'running' AND active_attempt_id = ?
      `).run(nextStatus, attempt.candidate_result, timestamp, nodeRunId, attempt.id);
      return nodeRunFromRow(this.#nodeRunRow(nodeRunId));
    });
  }

  transitionNode(nodeRunId, expectedStatuses, nextStatus, changes = {}) {
    this.#ensureOpen();
    if (!Array.isArray(expectedStatuses) || expectedStatuses.length === 0) {
      throw new TypeError("expectedStatuses must contain at least one status");
    }
    const columns = {
      result: ["result", (value) => value === null ? null : json(value)],
      branchOutcome: ["branch_outcome", (value) => value],
      activeAttemptId: ["active_attempt_id", (value) => value],
    };
    const assignments = ["status = ?"];
    const values = [nextStatus];
    for (const [key, [column, serialize]] of Object.entries(columns)) {
      if (!Object.hasOwn(changes, key)) continue;
      assignments.push(`${column} = ?`);
      values.push(serialize(changes[key]));
    }
    assignments.push("version = version + 1", "updated_at = ?");
    values.push(now(), nodeRunId, ...expectedStatuses);
    const placeholders = expectedStatuses.map(() => "?").join(", ");
    const result = this.#statement(`
      UPDATE workflow_node_runs SET ${assignments.join(", ")}
      WHERE id = ? AND status IN (${placeholders})
    `).run(...values);
    if (result.changes !== 1) {
      const current = this.#nodeRunRow(nodeRunId);
      if (!current) {
        throw new ApiError(404, "WORKFLOW_NODE_NOT_FOUND", `Workflow node run '${nodeRunId}' does not exist`);
      }
      throw new ApiError(
        409,
        "WORKFLOW_NODE_STATE_CONFLICT",
        "Workflow node state changed before the transition",
        { expectedStatuses, actualStatus: current.status },
      );
    }
    return nodeRunFromRow(this.#nodeRunRow(nodeRunId));
  }

  createRetry(nodeRunId) {
    return this.#transaction(() => {
      const node = this.#nodeRunRow(nodeRunId);
      if (!node) {
        throw new ApiError(404, "WORKFLOW_NODE_NOT_FOUND", `Workflow node run '${nodeRunId}' does not exist`);
      }
      if (!RETRYABLE_NODE_STATUSES.includes(node.status)) {
        throw new ApiError(
          409,
          "WORKFLOW_NODE_NOT_RETRYABLE",
          "Workflow node cannot be retried from its current status",
          { nodeRunId, status: node.status },
        );
      }
      const timestamp = now();
      this.#statement("DELETE FROM workflow_resource_leases WHERE node_run_id = ?").run(nodeRunId);
      this.#statement(`
        UPDATE workflow_node_runs
        SET status = 'ready', result = NULL, branch_outcome = NULL,
            active_attempt_id = NULL, lease_owner = NULL, lease_expires_at = NULL,
            version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(timestamp, nodeRunId);
      return nodeRunFromRow(this.#nodeRunRow(nodeRunId));
    });
  }

  releaseNodeResources(nodeRunId, owner = null) {
    return this.#transaction(() => {
      const node = this.#nodeRunRow(nodeRunId);
      if (!node) {
        throw new ApiError(404, "WORKFLOW_NODE_NOT_FOUND", `Workflow node run '${nodeRunId}' does not exist`);
      }
      const leases = this.#statement(`
        SELECT owner FROM workflow_resource_leases WHERE node_run_id = ?
      `).all(nodeRunId);
      if (node.lease_owner === null && leases.length === 0) {
        return nodeRunFromRow(node);
      }
      if (
        typeof owner !== "string"
        || owner.length === 0
        || node.lease_owner !== owner
        || leases.some((lease) => lease.owner !== owner)
      ) {
        throw new ApiError(
          409,
          "WORKFLOW_LEASE_LOST",
          "Workflow node resources can only be released by their current owner",
          { nodeRunId, owner, actualOwner: node.lease_owner },
        );
      }
      const timestamp = now();
      this.#statement(`
        DELETE FROM workflow_resource_leases WHERE node_run_id = ? AND owner = ?
      `).run(nodeRunId, owner);
      const result = this.#statement(`
        UPDATE workflow_node_runs
        SET lease_owner = NULL, lease_expires_at = NULL,
            version = version + 1, updated_at = ?
        WHERE id = ? AND lease_owner = ?
      `).run(timestamp, nodeRunId, owner);
      if (result.changes !== 1) {
        throw new ApiError(
          409,
          "WORKFLOW_LEASE_LOST",
          "Workflow node lease changed before release",
          { nodeRunId, owner },
        );
      }
      return nodeRunFromRow(this.#nodeRunRow(nodeRunId));
    });
  }

  createAmendment(input) {
    return this.#transaction(() => {
      if (!this.#runRow(input.runId)) {
        throw new ApiError(404, "WORKFLOW_RUN_NOT_FOUND", `Workflow run '${input.runId}' does not exist`);
      }
      const revision = this.#statement(`
        SELECT COALESCE(MAX(revision), 0) + 1 AS revision
        FROM workflow_run_amendments WHERE run_id = ?
      `).get(input.runId).revision;
      const id = input.id ?? randomUUID();
      const timestamp = now();
      this.#statement(`
        INSERT INTO workflow_run_amendments (
          id, run_id, revision, source, status, patch, review_report,
          reviewer_thread_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.runId,
        revision,
        input.source,
        input.status ?? "draft",
        json(input.patch),
        input.reviewReport === undefined || input.reviewReport === null ? null : json(input.reviewReport),
        input.reviewerThreadId ?? null,
        timestamp,
        timestamp,
      );
      return amendmentFromRow(this.#amendmentRow(id));
    });
  }

  applyAmendment(amendmentId) {
    let runId;
    this.#transaction(() => {
      const amendment = this.#amendmentRow(amendmentId);
      if (!amendment) {
        throw new ApiError(
          404,
          "WORKFLOW_AMENDMENT_NOT_FOUND",
          `Workflow amendment '${amendmentId}' does not exist`,
        );
      }
      runId = amendment.run_id;
      if (amendment.status === "applied") return;
      if (amendment.status !== "ready") {
        throw new ApiError(
          409,
          "WORKFLOW_AMENDMENT_NOT_READY",
          "Only a ready workflow amendment can be applied",
          { amendmentId, status: amendment.status },
        );
      }
      const run = this.#runRow(runId);
      if (!ACTIVE_RUN_STATUSES.includes(run.status)) {
        throw new ApiError(
          409,
          "WORKFLOW_RUN_STATE_CONFLICT",
          "Workflow amendments can only be applied to an active run",
          { amendmentId, runId, runStatus: run.status },
        );
      }
      const graph = JSON.parse(run.graph_snapshot);
      const applied = this.#statement(`
        SELECT patch FROM workflow_run_amendments
        WHERE run_id = ? AND status = 'applied' ORDER BY revision
      `).all(runId);
      const patches = [...applied.map((row) => parseJson(row.patch)), parseJson(amendment.patch)];
      const nodes = patches.map((patch) => patch?.node ?? patch?.addNode ?? patch);
      const effectiveGraph = assertWorkflowRuntimeGraph({ ...graph, nodes: [...graph.nodes, ...nodes] });
      const node = nodes.at(-1);
      const timestamp = now();
      const nodeRunId = randomUUID();
      this.#statement(`
        INSERT INTO workflow_node_runs (
          id, run_id, definition_id, type, executor_version, status,
          approval_mode, config, resources, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        nodeRunId,
        runId,
        node.id,
        node.type,
        node.executorVersion,
        initialWorkflowNodeStatus(node),
        node.approvalMode,
        json(node.config),
        json(node.resources),
        timestamp,
        timestamp,
      );
      this.#statement(`
        UPDATE workflow_run_amendments SET status = 'applied', updated_at = ? WHERE id = ?
      `).run(timestamp, amendmentId);
      this.#statement(`
        UPDATE workflow_runs
        SET amendment_revision = amendment_revision + 1,
            version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(timestamp, runId);
      this.#insertEvent({
        runId,
        nodeRunId,
        type: "workflow.run.amended",
        data: {
          amendmentId,
          amendmentRevision: amendment.revision,
          definitionId: node.id,
          graphSchemaVersion: effectiveGraph.schemaVersion,
        },
        createdAt: timestamp,
      });
    });
    return this.getRunSnapshot(runId);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
  }

  #templateRevisionRow(id) {
    return this.#statement("SELECT * FROM workflow_template_revisions WHERE id = ?").get(id);
  }

  #revisionRow(id) {
    return this.#statement("SELECT * FROM workflow_revisions WHERE id = ?").get(id);
  }

  #runRow(id) {
    return this.#statement("SELECT * FROM workflow_runs WHERE id = ?").get(id);
  }

  #nodeRunRow(id) {
    return this.#statement("SELECT * FROM workflow_node_runs WHERE id = ?").get(id);
  }

  #attemptRow(id) {
    return this.#statement("SELECT * FROM workflow_node_attempts WHERE id = ?").get(id);
  }

  #inboxRow(id) {
    return this.#statement("SELECT * FROM workflow_inbox_messages WHERE id = ?").get(id);
  }

  #amendmentRow(id) {
    return this.#statement("SELECT * FROM workflow_run_amendments WHERE id = ?").get(id);
  }

  #insertEvent({
    runId,
    nodeRunId = null,
    attemptId = null,
    type,
    data,
    createdAt = now(),
  }) {
    const id = randomUUID();
    this.#statement(`
      INSERT INTO workflow_events (
        id, run_id, node_run_id, attempt_id, type, data, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, runId, nodeRunId, attemptId, type, json(data), createdAt);
    return this.#statement("SELECT * FROM workflow_events WHERE id = ?").get(id);
  }

  #throwRevisionMissingOrConflict(id, expectedVersion) {
    const current = this.#revisionRow(id);
    if (!current) {
      throw new ApiError(
        404,
        "WORKFLOW_REVISION_NOT_FOUND",
        `Workflow revision '${id}' does not exist`,
      );
    }
    throw new ApiError(
      409,
      "VERSION_CONFLICT",
      "Workflow revision was changed by another client",
      { expectedVersion, actualVersion: current.version },
    );
  }
}
