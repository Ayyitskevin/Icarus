import type Database from "better-sqlite3";

import { invariant } from "./errors.js";
import type {
  RunState,
  RunVerificationAttemptsSnapshot,
  VerificationAttemptStartProvenance,
  VerificationAttemptStatus,
  VerificationAttemptSummary,
  VerificationCheckpointSummary,
} from "./types.js";

type Row = Record<string, unknown>;

export const RUN_VERIFICATION_ATTEMPT_EVENT_LIMIT = 200;
export const RUN_VERIFICATION_ATTEMPT_LIMIT = 8;

const COMPLETION_PAYLOAD_LIMIT = 8 * 1024 * 1024;
const TRANSITION_PAYLOAD_LIMIT = 16 * 1024;
const CHECKPOINT_EVENT_PAYLOAD_LIMIT = 1024;
const EVENT_TYPE_LIMIT = 128;
const TIMESTAMP_LIMIT = 64;
const RUN_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

const RUN_STATES: ReadonlySet<string> = new Set<RunState>([
  "preparing",
  "planned",
  "awaiting_egress_approval",
  "awaiting_approval",
  "running",
  "verifying",
  "awaiting_review",
  "completed",
  "rolling_back",
  "cancelling",
  "failed",
  "cancelled",
  "rolled_back",
  "restoring",
]);

const RESUMABLE_STATES: ReadonlySet<string> = new Set<RunState>([
  "preparing",
  "planned",
  "running",
  "verifying",
  "rolling_back",
  "restoring",
  "cancelling",
]);

interface EventMetadata {
  readonly sequence: number;
  readonly type: string;
  readonly createdAt: string;
}

interface AttemptStart {
  readonly sequence: number;
  readonly createdAt: string;
  readonly provenance: Exclude<VerificationAttemptStartProvenance, "outside_coverage">;
}

interface CompletionProjection {
  readonly outcome: "passed" | "failed" | "unavailable";
  readonly diffSha256: string;
  readonly checkpointSha256: string;
}

interface AttemptAnchor {
  readonly metadata: EventMetadata;
  readonly start: AttemptStart | null;
  readonly kind: "completed" | "cancelled" | "incomplete_failed" | "open";
}

interface TransitionProjection {
  readonly from: RunState;
  readonly to: RunState;
  readonly resumeState: RunState | null;
}

function databaseError(condition: unknown, runId: string, message: string): asserts condition {
  invariant(condition, "DATABASE_ERROR", message, { runId });
}

function row(value: unknown, runId: string, message: string): Row {
  databaseError(
    typeof value === "object" && value !== null && !Array.isArray(value),
    runId,
    message,
  );
  return value as Row;
}

function integer(value: unknown, runId: string, message: string): number {
  databaseError(typeof value === "number" && Number.isSafeInteger(value), runId, message);
  return value;
}

function boundedText(value: unknown, maximumBytes: number, runId: string, message: string): string {
  databaseError(
    typeof value === "string" && Buffer.byteLength(value, "utf8") <= maximumBytes,
    runId,
    message,
  );
  return value;
}

function canonicalTimestamp(value: unknown, runId: string, message: string): string {
  const timestamp = boundedText(value, TIMESTAMP_LIMIT, runId, message);
  databaseError(TIMESTAMP_PATTERN.test(timestamp), runId, message);
  const parsed = Date.parse(timestamp);
  databaseError(Number.isFinite(parsed), runId, message);
  const canonical = new Date(parsed).toISOString();
  databaseError(
    timestamp === canonical ||
      (canonical.endsWith(".000Z") && timestamp === canonical.replace(".000Z", "Z")),
    runId,
    message,
  );
  return timestamp;
}

function runState(value: unknown, runId: string, message: string): RunState {
  databaseError(typeof value === "string" && RUN_STATES.has(value), runId, message);
  return value as RunState;
}

function digest(value: unknown, runId: string, message: string): string {
  databaseError(typeof value === "string" && DIGEST_PATTERN.test(value), runId, message);
  return value;
}

function preflightPayload(
  database: Database.Database,
  runId: string,
  sequence: number,
  maximumBytes: number,
): void {
  const value = row(
    database
      .prepare(
        `SELECT sequence,
                typeof(payload_json) AS storage_type,
                octet_length(payload_json) AS payload_bytes
         FROM run_events
         WHERE run_id = ? AND sequence = ?`,
      )
      .get(runId, sequence),
    runId,
    "Verification evidence preflight row is missing",
  );
  databaseError(value.sequence === sequence, runId, "Verification evidence sequence is invalid");
  databaseError(value.storage_type === "text", runId, "Verification evidence storage is invalid");
  const payloadBytes = integer(
    value.payload_bytes,
    runId,
    "Verification evidence byte length is invalid",
  );
  databaseError(
    payloadBytes >= 0 && payloadBytes <= maximumBytes,
    runId,
    "Verification evidence exceeds its browser projection ceiling",
  );

  const validity = row(
    database
      .prepare(
        `SELECT json_valid(payload_json, 1) AS valid
         FROM run_events
         WHERE run_id = ? AND sequence = ?`,
      )
      .get(runId, sequence),
    runId,
    "Verification evidence validity row is missing",
  );
  databaseError(validity.valid === 1, runId, "Verification evidence JSON is invalid");
}

function transitionProjection(
  database: Database.Database,
  runId: string,
  event: EventMetadata,
): TransitionProjection {
  preflightPayload(database, runId, event.sequence, TRANSITION_PAYLOAD_LIMIT);
  const value = row(
    database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM json_each(payload_json)) AS root_count,
           (SELECT COUNT(*) FROM json_each(payload_json) WHERE key = 'from') AS from_count,
           (SELECT COUNT(*) FROM json_each(payload_json) WHERE key = 'to') AS to_count,
           (SELECT COUNT(*) FROM json_each(payload_json) WHERE key = 'resumeState') AS resume_count,
           (SELECT COUNT(*) FROM json_each(payload_json) WHERE key = 'detail') AS detail_count,
           (SELECT COUNT(*) FROM json_each(payload_json) WHERE key = 'code') AS code_count,
           (SELECT COUNT(*) FROM json_each(payload_json) WHERE key = 'message') AS message_count,
           json_extract(payload_json, '$.from') AS from_state,
           json_extract(payload_json, '$.to') AS to_state,
           json_extract(payload_json, '$.resumeState') AS resume_state,
           json_type(payload_json, '$.from') AS from_type,
           json_type(payload_json, '$.to') AS to_type,
           json_type(payload_json, '$.resumeState') AS resume_type,
           json_type(payload_json, '$.detail') AS detail_type,
           json_type(payload_json, '$.code') AS code_type,
           json_type(payload_json, '$.message') AS message_type,
           octet_length(json_extract(payload_json, '$.code')) AS code_bytes,
           octet_length(json_extract(payload_json, '$.message')) AS message_bytes
         FROM run_events
         WHERE run_id = ? AND sequence = ?
           AND json_type(payload_json, '$') = 'object'
           AND json_type(payload_json, '$.from') = 'text'
           AND json_type(payload_json, '$.to') = 'text'
           AND octet_length(json_extract(payload_json, '$.from')) <= 32
           AND octet_length(json_extract(payload_json, '$.to')) <= 32`,
      )
      .get(runId, event.sequence),
    runId,
    "Verification lifecycle transition is invalid",
  );
  const from = runState(value.from_state, runId, "Verification lifecycle source state is invalid");
  const to = runState(value.to_state, runId, "Verification lifecycle target state is invalid");
  const rootCount = integer(value.root_count, runId, "Verification lifecycle shape is invalid");
  databaseError(
    value.from_count === 1 &&
      value.to_count === 1 &&
      value.from_type === "text" &&
      value.to_type === "text",
    runId,
    "Verification lifecycle keys are invalid",
  );

  if (event.type === "edit.materialized" || event.type === "cancellation.requested") {
    databaseError(
      rootCount === 3 &&
        value.detail_count === 1 &&
        value.detail_type === "object" &&
        value.resume_count === 0 &&
        value.code_count === 0 &&
        value.message_count === 0,
      runId,
      "Verification lifecycle detail shape is invalid",
    );
  } else if (event.type === "run.failed") {
    databaseError(
      rootCount === 5 &&
        value.resume_count === 1 &&
        value.code_count === 1 &&
        value.message_count === 1 &&
        value.detail_count === 0 &&
        value.resume_type === "text" &&
        value.code_type === "text" &&
        value.message_type === "text" &&
        typeof value.code_bytes === "number" &&
        value.code_bytes <= 128 &&
        typeof value.message_bytes === "number" &&
        value.message_bytes <= 8 * 1024,
      runId,
      "Verification failure transition shape is invalid",
    );
  } else {
    databaseError(
      rootCount === 2 &&
        value.resume_count === 0 &&
        value.detail_count === 0 &&
        value.code_count === 0 &&
        value.message_count === 0,
      runId,
      "Verification lifecycle shape is invalid",
    );
  }

  const resumeState =
    event.type === "run.failed"
      ? runState(value.resume_state, runId, "Verification failure resume state is invalid")
      : null;

  if (event.type === "edit.materialized") {
    databaseError(from === "running" && to === "verifying", runId, "Edit transition is invalid");
  } else if (event.type === "restore.completed") {
    databaseError(
      from === "restoring" && to === "verifying",
      runId,
      "Restore transition is invalid",
    );
  } else if (event.type === "run.resumed") {
    databaseError(
      from === "failed" && RESUMABLE_STATES.has(to),
      runId,
      "Resume transition is invalid",
    );
  } else if (event.type === "cancellation.requested") {
    databaseError(to === "cancelling", runId, "Cancellation transition is invalid");
  } else {
    databaseError(
      event.type === "run.failed" && to === "failed" && resumeState !== null,
      runId,
      "Failure transition is invalid",
    );
  }
  return { from, to, resumeState };
}

function checkpointSaveDigest(
  database: Database.Database,
  runId: string,
  event: EventMetadata,
): string {
  preflightPayload(database, runId, event.sequence, CHECKPOINT_EVENT_PAYLOAD_LIMIT);
  const counts = row(
    database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM json_each(payload_json)) AS root_count,
           (SELECT COUNT(*) FROM json_each(payload_json)
              WHERE key = 'checkpointSha256') AS digest_count
         FROM run_events
         WHERE run_id = ? AND sequence = ?
           AND json_type(payload_json, '$') = 'object'`,
      )
      .get(runId, event.sequence),
    runId,
    "Checkpoint save evidence shape is invalid",
  );
  databaseError(
    counts.root_count === 1 && counts.digest_count === 1,
    runId,
    "Checkpoint save evidence keys are invalid",
  );
  const projected = row(
    database
      .prepare(
        `SELECT json_extract(payload_json, '$.checkpointSha256') AS checkpoint_sha256
         FROM run_events
         WHERE run_id = ? AND sequence = ?
           AND json_type(payload_json, '$.checkpointSha256') = 'text'
           AND octet_length(json_extract(payload_json, '$.checkpointSha256')) = 64
           AND json_extract(payload_json, '$.checkpointSha256') NOT GLOB '*[^0-9a-f]*'`,
      )
      .get(runId, event.sequence),
    runId,
    "Checkpoint save digest is invalid",
  );
  return digest(projected.checkpoint_sha256, runId, "Checkpoint save digest is invalid");
}

function completionProjection(
  database: Database.Database,
  runId: string,
  event: EventMetadata,
): CompletionProjection {
  preflightPayload(database, runId, event.sequence, COMPLETION_PAYLOAD_LIMIT);
  const counts = row(
    database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM json_each(payload_json) WHERE key = 'from') AS from_count,
           (SELECT COUNT(*) FROM json_each(payload_json) WHERE key = 'to') AS to_count,
           (SELECT COUNT(*) FROM json_each(payload_json) WHERE key = 'outcome') AS outcome_count,
           (SELECT COUNT(*) FROM json_each(payload_json) WHERE key = 'diffSha256') AS diff_count,
           (SELECT COUNT(*) FROM json_each(payload_json) WHERE key = 'verification') AS verification_count,
           (SELECT COUNT(*) FROM json_each(payload_json, '$.verification')
              WHERE key = 'outcome') AS nested_outcome_count,
           (SELECT COUNT(*) FROM json_each(payload_json, '$.verification')
              WHERE key = 'diffSha256') AS nested_diff_count,
           (SELECT COUNT(*) FROM json_each(payload_json, '$.verification')
              WHERE key = 'checkpointSha256') AS nested_checkpoint_count
         FROM run_events
         WHERE run_id = ? AND sequence = ?
           AND json_type(payload_json, '$') = 'object'
           AND json_type(payload_json, '$.verification') = 'object'`,
      )
      .get(runId, event.sequence),
    runId,
    "Completed verification evidence shape is invalid",
  );
  databaseError(
    counts.from_count === 1 &&
      counts.to_count === 1 &&
      counts.outcome_count === 1 &&
      counts.diff_count === 1 &&
      counts.verification_count === 1 &&
      counts.nested_outcome_count === 1 &&
      counts.nested_diff_count === 1 &&
      counts.nested_checkpoint_count === 1,
    runId,
    "Completed verification evidence keys are invalid",
  );
  const projected = row(
    database
      .prepare(
        `SELECT
           json_extract(payload_json, '$.outcome') AS outcome,
           json_extract(payload_json, '$.diffSha256') AS diff_sha256,
           json_extract(payload_json, '$.verification.checkpointSha256') AS checkpoint_sha256
         FROM run_events
         WHERE run_id = ? AND sequence = ?
           AND json_type(payload_json, '$.from') = 'text'
           AND json_extract(payload_json, '$.from') = 'verifying'
           AND json_type(payload_json, '$.to') = 'text'
           AND json_extract(payload_json, '$.to') = 'awaiting_review'
           AND json_type(payload_json, '$.outcome') = 'text'
           AND json_extract(payload_json, '$.outcome') IN ('passed', 'failed', 'unavailable')
           AND json_type(payload_json, '$.verification.outcome') = 'text'
           AND json_extract(payload_json, '$.verification.outcome') =
               json_extract(payload_json, '$.outcome')
           AND json_type(payload_json, '$.diffSha256') = 'text'
           AND json_type(payload_json, '$.verification.diffSha256') = 'text'
           AND json_extract(payload_json, '$.verification.diffSha256') =
               json_extract(payload_json, '$.diffSha256')
           AND octet_length(json_extract(payload_json, '$.diffSha256')) = 64
           AND json_extract(payload_json, '$.diffSha256') NOT GLOB '*[^0-9a-f]*'
           AND json_type(payload_json, '$.verification.checkpointSha256') = 'text'
           AND octet_length(json_extract(payload_json, '$.verification.checkpointSha256')) = 64
           AND json_extract(payload_json, '$.verification.checkpointSha256')
               NOT GLOB '*[^0-9a-f]*'`,
      )
      .get(runId, event.sequence),
    runId,
    "Completed verification evidence scalars are invalid",
  );
  const outcome = projected.outcome;
  databaseError(
    outcome === "passed" || outcome === "failed" || outcome === "unavailable",
    runId,
    "Completed verification outcome is invalid",
  );
  return {
    outcome,
    diffSha256: digest(
      projected.diff_sha256,
      runId,
      "Completed verification diff digest is invalid",
    ),
    checkpointSha256: digest(
      projected.checkpoint_sha256,
      runId,
      "Completed verification checkpoint digest is invalid",
    ),
  };
}

function metadataWindow(
  database: Database.Database,
  runId: string,
  firstSequence: number,
  snapshot: number,
): readonly EventMetadata[] {
  const expectedCount = snapshot - firstSequence + 1;
  const preflight = database
    .prepare(
      `SELECT sequence,
              typeof(run_id) AS run_id_type,
              octet_length(run_id) AS run_id_bytes,
              typeof(type) AS type_type,
              octet_length(type) AS type_bytes,
              typeof(created_at) AS timestamp_type,
              octet_length(created_at) AS timestamp_bytes
       FROM run_events
       WHERE run_id = ? AND sequence >= ? AND sequence <= ?
       ORDER BY sequence
       LIMIT 200`,
    )
    .all(runId, firstSequence, snapshot) as unknown[];
  databaseError(preflight.length === expectedCount, runId, "Verification event sequence has a gap");
  for (const [index, entry] of preflight.entries()) {
    const value = row(entry, runId, "Verification event preflight row is invalid");
    databaseError(
      value.sequence === firstSequence + index &&
        value.run_id_type === "text" &&
        value.run_id_bytes === 36 &&
        value.type_type === "text" &&
        typeof value.type_bytes === "number" &&
        value.type_bytes > 0 &&
        value.type_bytes <= EVENT_TYPE_LIMIT &&
        value.timestamp_type === "text" &&
        typeof value.timestamp_bytes === "number" &&
        value.timestamp_bytes > 0 &&
        value.timestamp_bytes <= TIMESTAMP_LIMIT,
      runId,
      "Verification event metadata preflight is invalid",
    );
  }
  const values = database
    .prepare(
      `SELECT sequence, run_id, type, created_at
       FROM run_events
       WHERE run_id = ? AND sequence >= ? AND sequence <= ?
       ORDER BY sequence
       LIMIT 200`,
    )
    .all(runId, firstSequence, snapshot) as unknown[];
  databaseError(values.length === expectedCount, runId, "Verification event sequence changed");
  return values.map((entry, index) => {
    const value = row(entry, runId, "Verification event metadata row is invalid");
    const sequence = integer(value.sequence, runId, "Verification event sequence is invalid");
    const type = boundedText(
      value.type,
      EVENT_TYPE_LIMIT,
      runId,
      "Verification event type is invalid",
    );
    databaseError(
      sequence === firstSequence + index && value.run_id === runId && EVENT_TYPE_PATTERN.test(type),
      runId,
      "Verification event metadata is invalid",
    );
    return {
      sequence,
      type,
      createdAt: canonicalTimestamp(
        value.created_at,
        runId,
        "Verification event timestamp is invalid",
      ),
    };
  });
}

function startFor(event: EventMetadata, provenance: AttemptStart["provenance"]): AttemptStart {
  return { sequence: event.sequence, createdAt: event.createdAt, provenance };
}

function attemptSummary(
  anchor: AttemptAnchor,
  completion: CompletionProjection | null,
  checkpoint: VerificationCheckpointSummary,
  laterAttemptObservedWithinCoverage: boolean,
): VerificationAttemptSummary {
  const status: VerificationAttemptStatus =
    anchor.kind === "completed"
      ? (completion?.outcome ?? "unavailable")
      : anchor.kind === "open"
        ? "incomplete_at_snapshot"
        : anchor.kind;
  const completed = anchor.kind === "completed";
  const checkpointSha256 =
    checkpoint.status === "saved"
      ? completed
        ? (completion?.checkpointSha256 ?? null)
        : checkpoint.sha256
      : null;
  return {
    identity: `verification-anchor-${anchor.metadata.sequence}`,
    anchorSequence: anchor.metadata.sequence,
    startSequence: anchor.start?.sequence ?? null,
    startedAt: anchor.start?.createdAt ?? null,
    startProvenance: anchor.start?.provenance ?? "outside_coverage",
    status,
    endSequence: anchor.kind === "open" ? null : anchor.metadata.sequence,
    endedAt: anchor.kind === "open" ? null : anchor.metadata.createdAt,
    diffSha256: completed ? (completion?.diffSha256 ?? null) : null,
    checkpointSha256,
    checkpointProvenance:
      checkpoint.status === "not_saved"
        ? "not_available"
        : completed
          ? "recorded_digest_match"
          : "run_checkpoint_available",
    laterAttemptObservedWithinCoverage,
  };
}

export function readRunVerificationAttempts(
  database: Database.Database,
  runId: string,
  snapshot: number,
): RunVerificationAttemptsSnapshot {
  invariant(RUN_ID_PATTERN.test(runId), "INVALID_RUN_ID", "Run ID is invalid");
  invariant(
    Number.isSafeInteger(snapshot) && snapshot > 0,
    "INVALID_EVENT_CURSOR",
    "Verification snapshot must be a positive safe integer",
  );

  const transaction = database.transaction((): RunVerificationAttemptsSnapshot => {
    const exists = database.prepare("SELECT 1 FROM runs WHERE id = ?").get(runId);
    invariant(exists !== undefined, "NOT_FOUND", "Run was not found", { runId });
    const safeRun = row(
      database
        .prepare(
          `SELECT id,
                  CASE WHEN typeof(state) = 'text' AND octet_length(state) <= 32
                    THEN state ELSE NULL END AS state,
                  CASE WHEN resume_state IS NULL THEN NULL
                    WHEN typeof(resume_state) = 'text' AND octet_length(resume_state) <= 32
                    THEN resume_state ELSE 1 END AS resume_state
           FROM runs WHERE id = ?`,
        )
        .get(runId),
      runId,
      "Verification run metadata is missing",
    );
    databaseError(safeRun.id === runId, runId, "Verification run identity is invalid");
    const currentState = runState(safeRun.state, runId, "Verification run state is invalid");
    if (safeRun.resume_state !== null) {
      runState(safeRun.resume_state, runId, "Verification run resume state is invalid");
    }

    const revisionRow = row(
      database
        .prepare("SELECT COALESCE(MAX(sequence), 0) AS revision FROM run_events WHERE run_id = ?")
        .get(runId),
      runId,
      "Verification event revision is missing",
    );
    const revision = integer(revisionRow.revision, runId, "Verification event revision is invalid");
    databaseError(revision > 0, runId, "Verification event revision is invalid");
    invariant(
      revision === snapshot,
      "EVENT_SNAPSHOT_CONFLICT",
      "The run advanced beyond the requested verification snapshot",
      { runId },
    );

    const firstSequence = Math.max(1, snapshot - RUN_VERIFICATION_ATTEMPT_EVENT_LIMIT + 1);
    const events = metadataWindow(database, runId, firstSequence, snapshot);
    const earlierEventsExcluded = firstSequence > 1;

    const checkpointExists =
      database.prepare("SELECT 1 FROM checkpoints WHERE run_id = ?").get(runId) !== undefined;
    let checkpointRow: { readonly sha256: string; readonly createdAt: string } | null = null;
    if (checkpointExists) {
      const checkpointValue = row(
        database
          .prepare(
            `SELECT run_id, checkpoint_sha256, created_at
             FROM checkpoints
             WHERE run_id = ?
               AND typeof(checkpoint_sha256) = 'text'
               AND octet_length(checkpoint_sha256) = 64
               AND checkpoint_sha256 NOT GLOB '*[^0-9a-f]*'
               AND typeof(created_at) = 'text'
               AND octet_length(created_at) <= 64`,
          )
          .get(runId),
        runId,
        "Checkpoint metadata is invalid",
      );
      databaseError(checkpointValue.run_id === runId, runId, "Checkpoint identity is invalid");
      checkpointRow = {
        sha256: digest(checkpointValue.checkpoint_sha256, runId, "Checkpoint digest is invalid"),
        createdAt: canonicalTimestamp(
          checkpointValue.created_at,
          runId,
          "Checkpoint timestamp is invalid",
        ),
      };
    }

    const transitionBySequence = new Map<number, TransitionProjection>();
    const saveEvents = events.filter((event) => event.type === "checkpoint.saved");
    databaseError(saveEvents.length <= 1, runId, "Checkpoint save evidence is duplicated");
    let observedSave: { readonly event: EventMetadata; readonly sha256: string } | null = null;
    if (saveEvents[0] !== undefined) {
      observedSave = {
        event: saveEvents[0],
        sha256: checkpointSaveDigest(database, runId, saveEvents[0]),
      };
      databaseError(checkpointRow !== null, runId, "Checkpoint save event has no checkpoint row");
      databaseError(
        observedSave.sha256 === checkpointRow.sha256,
        runId,
        "Checkpoint save digest does not match the checkpoint row",
      );
    } else if (checkpointRow !== null) {
      databaseError(earlierEventsExcluded, runId, "Checkpoint row has no save event");
    }

    for (const event of events) {
      if (
        event.type === "edit.materialized" ||
        event.type === "restore.completed" ||
        event.type === "run.resumed" ||
        event.type === "cancellation.requested" ||
        event.type === "run.failed"
      ) {
        transitionBySequence.set(event.sequence, transitionProjection(database, runId, event));
      }
    }

    const anchors: AttemptAnchor[] = [];
    let pendingStart: AttemptStart | null = null;
    let terminalWithoutStartSeen = false;
    for (const event of events) {
      const transition = transitionBySequence.get(event.sequence);
      let start: AttemptStart | null = null;
      if (event.type === "edit.materialized") {
        start = startFor(event, "observed_initial_edit");
      } else if (event.type === "restore.completed") {
        databaseError(checkpointRow !== null, runId, "Restore has no recorded checkpoint");
        start = startFor(event, "observed_restore");
      } else if (event.type === "run.resumed" && transition?.to === "verifying") {
        start = startFor(event, "observed_resume");
      }
      if (start !== null) {
        databaseError(pendingStart === null, runId, "Verification intervals overlap");
        pendingStart = start;
      }

      let kind: AttemptAnchor["kind"] | null = null;
      if (event.type === "verification.completed") kind = "completed";
      if (
        event.type === "cancellation.requested" &&
        transition?.from === "verifying" &&
        transition.to === "cancelling"
      ) {
        kind = "cancelled";
      }
      if (
        event.type === "run.failed" &&
        transition?.from === "verifying" &&
        transition.to === "failed" &&
        transition.resumeState === "verifying"
      ) {
        kind = "incomplete_failed";
      }
      if (pendingStart !== null && transition !== undefined && start === null && kind === null) {
        databaseError(
          false,
          runId,
          "Verification interval contains a contradictory lifecycle transition",
        );
      }
      if (kind !== null) {
        if (pendingStart === null) {
          databaseError(
            earlierEventsExcluded && !terminalWithoutStartSeen && anchors.length === 0,
            runId,
            "Verification attempt start evidence is inconsistent",
          );
          terminalWithoutStartSeen = true;
        }
        anchors.push({ metadata: event, start: pendingStart, kind });
        pendingStart = null;
      }
    }

    if (pendingStart !== null) {
      databaseError(currentState === "verifying", runId, "Open verification state is inconsistent");
      anchors.push({
        metadata: {
          sequence: pendingStart.sequence,
          type: "verification.open",
          createdAt: pendingStart.createdAt,
        },
        start: pendingStart,
        kind: "open",
      });
    } else if (currentState === "verifying") {
      databaseError(
        earlierEventsExcluded && anchors.length === 0,
        runId,
        "Open verification start evidence is inconsistent",
      );
      const boundary = events.at(-1);
      databaseError(boundary !== undefined, runId, "Open verification boundary is missing");
      anchors.push({
        metadata: { ...boundary, sequence: snapshot },
        start: null,
        kind: "open",
      });
    }

    if (observedSave !== null) {
      for (const anchor of anchors) {
        if (
          anchor.start?.provenance === "observed_restore" ||
          anchor.start?.provenance === "observed_resume"
        ) {
          databaseError(
            observedSave.event.sequence < anchor.start.sequence,
            runId,
            "Checkpoint save event follows a recovery verification start",
          );
        }
        if (anchor.kind === "completed") {
          databaseError(
            observedSave.event.sequence < anchor.metadata.sequence,
            runId,
            "Checkpoint save event follows completed verification",
          );
        }
      }
    }

    const checkpoint: VerificationCheckpointSummary =
      checkpointRow === null
        ? { status: "not_saved" }
        : {
            status: "saved",
            sha256: checkpointRow.sha256,
            createdAt: checkpointRow.createdAt,
            saveEvent:
              observedSave === null
                ? { status: "not_observed_in_coverage" }
                : {
                    status: "observed_in_coverage",
                    sequence: observedSave.event.sequence,
                    timestamp: observedSave.event.createdAt,
                  },
          };

    const retained = anchors.slice(-RUN_VERIFICATION_ATTEMPT_LIMIT);
    const attempts = retained.map((anchor, index) => {
      const completion =
        anchor.kind === "completed" ? completionProjection(database, runId, anchor.metadata) : null;
      if (completion !== null) {
        databaseError(checkpointRow !== null, runId, "Completed verification has no checkpoint");
        databaseError(
          completion.checkpointSha256 === checkpointRow.sha256,
          runId,
          "Completed verification checkpoint digest is inconsistent",
        );
      }
      return attemptSummary(anchor, completion, checkpoint, index < retained.length - 1);
    });

    return {
      runId,
      snapshot,
      coverage: {
        firstSequence,
        lastSequence: snapshot,
        eventCount: events.length,
        eventLimit: RUN_VERIFICATION_ATTEMPT_EVENT_LIMIT,
        earlierEventsExcluded,
      },
      attemptLimit: RUN_VERIFICATION_ATTEMPT_LIMIT,
      attemptAnchorsTruncatedWithinCoverage: anchors.length > RUN_VERIFICATION_ATTEMPT_LIMIT,
      checkpoint,
      attempts,
    };
  });
  return transaction();
}
