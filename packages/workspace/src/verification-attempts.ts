import type {
  RunView,
  VerificationAttemptCheckpointProvenance,
  VerificationAttemptStartProvenance,
  VerificationAttemptStatus,
  VerificationAttemptView,
  VerificationAttemptsView,
} from "./api.js";

export const VERIFICATION_ATTEMPT_EVENT_LIMIT = 200;
export const VERIFICATION_ATTEMPT_LIMIT = 8;

const RESPONSE_KEYS = [
  "runId",
  "snapshot",
  "coverage",
  "attemptLimit",
  "attemptAnchorsTruncatedWithinCoverage",
  "checkpoint",
  "attempts",
];
const COVERAGE_KEYS = [
  "firstSequence",
  "lastSequence",
  "eventCount",
  "eventLimit",
  "earlierEventsExcluded",
];
const ATTEMPT_KEYS = [
  "identity",
  "anchorSequence",
  "startSequence",
  "startedAt",
  "startProvenance",
  "status",
  "endSequence",
  "endedAt",
  "diffSha256",
  "checkpointSha256",
  "checkpointProvenance",
  "laterAttemptObservedWithinCoverage",
];
const CHECKPOINT_NOT_SAVED_KEYS = ["status"];
const CHECKPOINT_SAVED_KEYS = ["status", "sha256", "createdAt", "saveEvent"];
const CHECKPOINT_SAVE_EVENT_OBSERVED_KEYS = ["status", "sequence", "timestamp"];
const CHECKPOINT_SAVE_EVENT_NOT_OBSERVED_KEYS = ["status"];
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const TIMESTAMP_MAX_BYTES = 64;

const START_PROVENANCE = new Set<VerificationAttemptStartProvenance>([
  "observed_initial_edit",
  "observed_restore",
  "observed_resume",
  "outside_coverage",
]);
const ATTEMPT_STATUSES = new Set<VerificationAttemptStatus>([
  "passed",
  "failed",
  "unavailable",
  "cancelled",
  "incomplete_failed",
  "incomplete_at_snapshot",
]);
const CHECKPOINT_PROVENANCE = new Set<VerificationAttemptCheckpointProvenance>([
  "recorded_digest_match",
  "run_checkpoint_available",
  "not_available",
]);
const COMPLETED_STATUSES = new Set<VerificationAttemptStatus>(["passed", "failed", "unavailable"]);

export interface VerificationAttemptsRequest {
  readonly runId: string;
  readonly snapshot: number;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => actualKeys.includes(key));
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    utf8Length(value) > TIMESTAMP_MAX_BYTES ||
    !TIMESTAMP_PATTERN.test(value)
  ) {
    return false;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const canonical = new Date(parsed).toISOString();
  return (
    value === canonical ||
    (canonical.endsWith(".000Z") && value === canonical.replace(".000Z", "Z"))
  );
}

function isNullablePositiveSafeInteger(value: unknown): value is number | null {
  return value === null || isPositiveSafeInteger(value);
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isCanonicalTimestamp(value);
}

function isNullableDigest(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && DIGEST_PATTERN.test(value));
}

function validateCheckpoint(
  value: unknown,
  firstSequence: number,
  lastSequence: number,
  earlierEventsExcluded: boolean,
): asserts value is VerificationAttemptsView["checkpoint"] {
  if (isExactRecord(value, CHECKPOINT_NOT_SAVED_KEYS) && value.status === "not_saved") return;
  if (
    !isExactRecord(value, CHECKPOINT_SAVED_KEYS) ||
    value.status !== "saved" ||
    typeof value.sha256 !== "string" ||
    !DIGEST_PATTERN.test(value.sha256) ||
    !isCanonicalTimestamp(value.createdAt)
  ) {
    throw new Error("The verification checkpoint metadata was invalid.");
  }

  const saveEvent = value.saveEvent;
  if (
    isExactRecord(saveEvent, CHECKPOINT_SAVE_EVENT_OBSERVED_KEYS) &&
    saveEvent.status === "observed_in_coverage"
  ) {
    if (
      !isPositiveSafeInteger(saveEvent.sequence) ||
      saveEvent.sequence < firstSequence ||
      saveEvent.sequence > lastSequence ||
      !isCanonicalTimestamp(saveEvent.timestamp)
    ) {
      throw new Error("The verification checkpoint save event was invalid.");
    }
    return;
  }
  if (
    !isExactRecord(saveEvent, CHECKPOINT_SAVE_EVENT_NOT_OBSERVED_KEYS) ||
    saveEvent.status !== "not_observed_in_coverage" ||
    !earlierEventsExcluded
  ) {
    throw new Error("The verification checkpoint save-event coverage was inconsistent.");
  }
}

function validateAttempt(
  value: unknown,
  index: number,
  attemptCount: number,
  request: VerificationAttemptsRequest,
  response: VerificationAttemptsView,
  previousAnchor: number,
): asserts value is VerificationAttemptView {
  if (!isExactRecord(value, ATTEMPT_KEYS)) {
    throw new Error("The verification attempt shape was invalid.");
  }
  if (
    !isPositiveSafeInteger(value.anchorSequence) ||
    value.anchorSequence < response.coverage.firstSequence ||
    value.anchorSequence > response.coverage.lastSequence ||
    value.anchorSequence <= previousAnchor ||
    value.identity !== `verification-anchor-${value.anchorSequence}` ||
    !isNullablePositiveSafeInteger(value.startSequence) ||
    !isNullableTimestamp(value.startedAt) ||
    typeof value.startProvenance !== "string" ||
    !START_PROVENANCE.has(value.startProvenance as VerificationAttemptStartProvenance) ||
    typeof value.status !== "string" ||
    !ATTEMPT_STATUSES.has(value.status as VerificationAttemptStatus) ||
    !isNullablePositiveSafeInteger(value.endSequence) ||
    !isNullableTimestamp(value.endedAt) ||
    !isNullableDigest(value.diffSha256) ||
    !isNullableDigest(value.checkpointSha256) ||
    typeof value.checkpointProvenance !== "string" ||
    !CHECKPOINT_PROVENANCE.has(
      value.checkpointProvenance as VerificationAttemptCheckpointProvenance,
    ) ||
    typeof value.laterAttemptObservedWithinCoverage !== "boolean" ||
    value.laterAttemptObservedWithinCoverage !== index < attemptCount - 1
  ) {
    throw new Error("The verification attempt metadata was invalid.");
  }

  const startProvenance = value.startProvenance as VerificationAttemptStartProvenance;
  const status = value.status as VerificationAttemptStatus;
  const checkpointProvenance =
    value.checkpointProvenance as VerificationAttemptCheckpointProvenance;
  if (startProvenance === "outside_coverage") {
    if (
      value.startSequence !== null ||
      value.startedAt !== null ||
      !response.coverage.earlierEventsExcluded
    ) {
      throw new Error("The verification attempt start coverage was inconsistent.");
    }
  } else if (
    value.startSequence === null ||
    value.startedAt === null ||
    value.startSequence < response.coverage.firstSequence ||
    value.startSequence > response.coverage.lastSequence
  ) {
    throw new Error("The verification attempt start metadata was inconsistent.");
  }

  if (status === "incomplete_at_snapshot") {
    if (
      value.endSequence !== null ||
      value.endedAt !== null ||
      value.diffSha256 !== null ||
      value.anchorSequence !==
        (value.startSequence === null ? request.snapshot : value.startSequence)
    ) {
      throw new Error("The open verification attempt metadata was inconsistent.");
    }
  } else if (
    value.endSequence === null ||
    value.endedAt === null ||
    value.endSequence !== value.anchorSequence ||
    (value.startSequence !== null && value.startSequence >= value.endSequence)
  ) {
    throw new Error("The terminal verification attempt metadata was inconsistent.");
  }

  const completed = COMPLETED_STATUSES.has(status);
  if (
    completed &&
    (value.diffSha256 === null ||
      value.checkpointSha256 === null ||
      checkpointProvenance !== "recorded_digest_match")
  ) {
    throw new Error("The completed verification attempt digest metadata was inconsistent.");
  }
  if (!completed && value.diffSha256 !== null) {
    throw new Error("The incomplete verification attempt exposed an unexpected diff digest.");
  }

  if (response.checkpoint.status === "not_saved") {
    if (value.checkpointSha256 !== null || checkpointProvenance !== "not_available" || completed) {
      throw new Error("The verification attempt checkpoint state was inconsistent.");
    }
  } else if (
    value.checkpointSha256 !== response.checkpoint.sha256 ||
    checkpointProvenance !== (completed ? "recorded_digest_match" : "run_checkpoint_available")
  ) {
    throw new Error("The verification attempt checkpoint provenance was inconsistent.");
  }
}

export function verificationAttemptsRequest(
  run: Pick<RunView, "id" | "eventCursor">,
): VerificationAttemptsRequest {
  if (!UUID_PATTERN.test(run.id) || !isPositiveSafeInteger(run.eventCursor)) {
    throw new Error("The selected run cannot seed a pinned verification-attempt request.");
  }
  return { runId: run.id, snapshot: run.eventCursor };
}

export function validateVerificationAttempts(
  request: VerificationAttemptsRequest,
  value: unknown,
): asserts value is VerificationAttemptsView {
  if (!isExactRecord(value, RESPONSE_KEYS)) {
    throw new Error("The verification-attempt response shape was invalid.");
  }
  if (
    value.runId !== request.runId ||
    value.snapshot !== request.snapshot ||
    !UUID_PATTERN.test(request.runId) ||
    !isPositiveSafeInteger(request.snapshot) ||
    !isExactRecord(value.coverage, COVERAGE_KEYS) ||
    value.attemptLimit !== VERIFICATION_ATTEMPT_LIMIT ||
    typeof value.attemptAnchorsTruncatedWithinCoverage !== "boolean" ||
    !Array.isArray(value.attempts) ||
    value.attempts.length > VERIFICATION_ATTEMPT_LIMIT
  ) {
    throw new Error("The verification-attempt response metadata was invalid.");
  }

  const firstSequence = Math.max(1, request.snapshot - VERIFICATION_ATTEMPT_EVENT_LIMIT + 1);
  const eventCount = request.snapshot - firstSequence + 1;
  if (
    value.coverage.firstSequence !== firstSequence ||
    value.coverage.lastSequence !== request.snapshot ||
    value.coverage.eventCount !== eventCount ||
    value.coverage.eventLimit !== VERIFICATION_ATTEMPT_EVENT_LIMIT ||
    value.coverage.earlierEventsExcluded !== firstSequence > 1
  ) {
    throw new Error("The verification-attempt coverage was inconsistent.");
  }
  if (
    value.attemptAnchorsTruncatedWithinCoverage &&
    value.attempts.length !== VERIFICATION_ATTEMPT_LIMIT
  ) {
    throw new Error("The verification-attempt truncation state was inconsistent.");
  }

  const response = value as unknown as VerificationAttemptsView;
  validateCheckpoint(value.checkpoint, firstSequence, request.snapshot, firstSequence > 1);
  let previousAnchor = firstSequence - 1;
  for (const [index, attempt] of value.attempts.entries()) {
    validateAttempt(attempt, index, value.attempts.length, request, response, previousAnchor);
    previousAnchor = attempt.anchorSequence;
  }
  if (
    response.checkpoint.status === "saved" &&
    response.checkpoint.saveEvent.status === "observed_in_coverage"
  ) {
    for (const attempt of response.attempts) {
      if (
        COMPLETED_STATUSES.has(attempt.status) &&
        response.checkpoint.saveEvent.sequence >= attempt.anchorSequence
      ) {
        throw new Error("The verification checkpoint save sequence was inconsistent.");
      }
    }
  }
}

export function acceptVerificationAttempts(
  request: VerificationAttemptsRequest,
  value: unknown,
): VerificationAttemptsView {
  validateVerificationAttempts(request, value);
  return value;
}

export function verificationAttemptsAreStale(
  run: Pick<RunView, "id" | "eventCursor">,
  view: VerificationAttemptsView,
): boolean {
  return run.id === view.runId && isPositiveSafeInteger(run.eventCursor)
    ? run.eventCursor > view.snapshot
    : false;
}
