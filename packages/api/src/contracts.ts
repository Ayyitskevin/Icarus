import {
  BROWSER_ACTION_DESCRIPTOR_VERSION,
  BROWSER_ACTION_EXPECTED_STATES,
  browserActionRequiresSubject,
  CHANGE_CONTEXT_QUESTIONS,
  type BrowserActionIdentity,
  type ChangeContextQuestion,
  IcarusError,
  isBrowserActionKind,
} from "@icarus/core";

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
const DIGEST_IMAGE_PATTERN = /^[a-z0-9][a-z0-9._/-]*(?::[a-zA-Z0-9._-]+)?@sha256:[a-f0-9]{64}$/;
const EVENT_CURSOR_PATTERN = /^(0|[1-9][0-9]*)$/;
const POSITIVE_EVENT_CURSOR_PATTERN = /^[1-9][0-9]*$/;
const SAFE_RUN_SNAPSHOT_MAX = Number.MAX_SAFE_INTEGER - 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function invalid(message: string): never {
  throw new IcarusError("INVALID_REQUEST", message);
}

export function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
): void {
  const allowedSet = new Set(allowed);
  if (!Object.keys(value).every((key) => allowedSet.has(key))) {
    invalid(`${name} contains unknown fields`);
  }
}

export function stringValue(
  value: unknown,
  name: string,
  options: { readonly maxBytes?: number; readonly pattern?: RegExp } = {},
): string {
  const maxBytes = options.maxBytes ?? 8 * 1024;
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    (options.pattern !== undefined && !options.pattern.test(value))
  ) {
    invalid(`${name} is invalid`);
  }
  return value;
}

export function nameValue(value: unknown, name: string): string {
  return stringValue(value, name, { maxBytes: 100, pattern: NAME_PATTERN });
}

export interface ProjectRequest {
  readonly repository: { readonly name: string; readonly path: string };
  readonly project: {
    readonly name: string;
    readonly baseRef: string;
    readonly sandboxImage: string;
    readonly checks: readonly {
      readonly id: string;
      readonly name: string;
      readonly argv: readonly string[];
    }[];
  };
}

export function projectRequest(value: unknown): ProjectRequest {
  const body = objectValue(value, "request");
  exactKeys(body, ["repository", "project"], "request");
  const repository = objectValue(body.repository, "repository");
  exactKeys(repository, ["name", "path"], "repository");
  const project = objectValue(body.project, "project");
  exactKeys(project, ["name", "baseRef", "sandboxImage", "checks"], "project");
  if (!Array.isArray(project.checks) || project.checks.length < 1 || project.checks.length > 8) {
    invalid("project.checks must contain between one and eight checks");
  }
  const checks = project.checks.map((entry, index) => {
    const check = objectValue(entry, `project.checks[${index}]`);
    exactKeys(check, ["id", "name", "argv"], `project.checks[${index}]`);
    if (
      !Array.isArray(check.argv) ||
      check.argv.length < 1 ||
      check.argv.length > 32 ||
      !check.argv.every((part) => typeof part === "string")
    ) {
      invalid(`project.checks[${index}].argv is invalid`);
    }
    return {
      id: stringValue(check.id, `project.checks[${index}].id`, { maxBytes: 128 }),
      name: stringValue(check.name, `project.checks[${index}].name`, { maxBytes: 256 }),
      argv: check.argv.map((part, partIndex) =>
        stringValue(part, `project.checks[${index}].argv[${partIndex}]`, { maxBytes: 2_048 }),
      ),
    };
  });
  return {
    repository: {
      name: nameValue(repository.name, "repository.name"),
      path: stringValue(repository.path, "repository.path", { maxBytes: 4_096 }),
    },
    project: {
      name: nameValue(project.name, "project.name"),
      baseRef: stringValue(project.baseRef, "project.baseRef", { maxBytes: 256 }),
      sandboxImage: stringValue(project.sandboxImage, "project.sandboxImage", {
        maxBytes: 512,
        pattern: DIGEST_IMAGE_PATTERN,
      }),
      checks,
    },
  };
}

export function contextPreviewRequest(value: unknown): { readonly target: string } {
  const body = objectValue(value, "request");
  exactKeys(body, ["target"], "request");
  return { target: stringValue(body.target, "target", { maxBytes: 1_024 }) };
}

export interface RunDraftRequest {
  readonly projectId: string;
  readonly task: string;
  readonly targets: readonly string[];
  readonly provider: {
    readonly kind: "ollama" | "vulcan";
    readonly model: string;
    readonly baseUrl: string;
  };
}

/** ADR 0023 bounds the browser's candidate selection to the host file ceiling. */
const MAX_REQUEST_TARGETS = 64;

export function runDraftRequest(value: unknown): RunDraftRequest {
  const body = objectValue(value, "request");
  exactKeys(body, ["projectId", "task", "targets", "provider"], "request");
  const provider = objectValue(body.provider, "provider");
  exactKeys(provider, ["kind", "model", "baseUrl"], "provider");
  // The workspace slice admits only credential-free loopback providers; the
  // route re-checks loopback on the parsed URL before a draft is persisted.
  if (provider.kind !== undefined && provider.kind !== "ollama" && provider.kind !== "vulcan") {
    invalid("provider.kind must be ollama or vulcan");
  }
  const kind = provider.kind === "ollama" || provider.kind === "vulcan" ? provider.kind : "ollama";
  if (!Array.isArray(body.targets)) {
    throw new IcarusError("INVALID_REQUEST", "targets must be an array");
  }
  if (body.targets.length < 1 || body.targets.length > MAX_REQUEST_TARGETS) {
    throw new IcarusError("INVALID_REQUEST", "targets has an invalid length");
  }
  const targets = body.targets.map((entry, index) =>
    stringValue(entry, `targets[${index}]`, { maxBytes: 1_024 }),
  );
  if (new Set(targets).size !== targets.length) {
    throw new IcarusError("INVALID_REQUEST", "targets must be unique");
  }
  return {
    projectId: stringValue(body.projectId, "projectId", { maxBytes: 100 }),
    task: stringValue(body.task, "task", { maxBytes: 8 * 1024 }),
    targets,
    provider: {
      kind,
      model: stringValue(provider.model, "provider.model", { maxBytes: 256 }),
      baseUrl: stringValue(provider.baseUrl, "provider.baseUrl", { maxBytes: 2_048 }),
    },
  };
}

export type WorkspaceRunPageQuery =
  | { readonly kind: "new" }
  | { readonly kind: "continuation"; readonly before: number; readonly snapshot: number };

export function workspaceRunPageQuery(searchParams: URLSearchParams): WorkspaceRunPageQuery {
  const keys = Array.from(searchParams.keys());
  if (keys.length === 0) return { kind: "new" };
  const beforeValues = searchParams.getAll("before");
  const snapshotValues = searchParams.getAll("snapshot");
  if (
    keys.length !== 2 ||
    new Set(keys).size !== 2 ||
    !keys.includes("before") ||
    !keys.includes("snapshot") ||
    beforeValues.length !== 1 ||
    snapshotValues.length !== 1
  ) {
    invalid("Run page requests require exactly one before and snapshot query parameter");
  }
  const rawBefore = beforeValues[0] ?? "";
  const rawSnapshot = snapshotValues[0] ?? "";
  if (!POSITIVE_EVENT_CURSOR_PATTERN.test(rawBefore) || !EVENT_CURSOR_PATTERN.test(rawSnapshot)) {
    invalid("before and snapshot must be canonical safe integers");
  }
  const before = Number(rawBefore);
  const snapshot = Number(rawSnapshot);
  if (
    !Number.isSafeInteger(before) ||
    before <= 0 ||
    !Number.isSafeInteger(snapshot) ||
    snapshot < 0 ||
    snapshot > SAFE_RUN_SNAPSHOT_MAX
  ) {
    invalid("before and snapshot must be canonical safe integers");
  }
  return { kind: "continuation", before, snapshot };
}

export type WorkspaceProjectPageQuery =
  | { readonly kind: "new" }
  | { readonly kind: "continuation"; readonly before: number; readonly snapshot: number };

export function workspaceProjectPageQuery(
  searchParams: URLSearchParams,
): WorkspaceProjectPageQuery {
  const keys = Array.from(searchParams.keys());
  if (keys.length === 0) return { kind: "new" };
  const beforeValues = searchParams.getAll("before");
  const snapshotValues = searchParams.getAll("snapshot");
  if (
    keys.length !== 2 ||
    new Set(keys).size !== 2 ||
    !keys.includes("before") ||
    !keys.includes("snapshot") ||
    beforeValues.length !== 1 ||
    snapshotValues.length !== 1
  ) {
    invalid("Project page requests require exactly one before and snapshot query parameter");
  }
  const rawBefore = beforeValues[0] ?? "";
  const rawSnapshot = snapshotValues[0] ?? "";
  if (!POSITIVE_EVENT_CURSOR_PATTERN.test(rawBefore) || !EVENT_CURSOR_PATTERN.test(rawSnapshot)) {
    invalid("before and snapshot must be canonical safe integers");
  }
  const before = Number(rawBefore);
  const snapshot = Number(rawSnapshot);
  if (
    !Number.isSafeInteger(before) ||
    before <= 0 ||
    !Number.isSafeInteger(snapshot) ||
    snapshot < 0 ||
    snapshot > SAFE_RUN_SNAPSHOT_MAX
  ) {
    invalid("before and snapshot must be canonical safe integers");
  }
  return { kind: "continuation", before, snapshot };
}

export function runEventsQuery(searchParams: URLSearchParams): { readonly after: number } {
  const keys = Array.from(searchParams.keys());
  const values = searchParams.getAll("after");
  if (keys.length !== 1 || keys[0] !== "after" || values.length !== 1) {
    invalid("Event requests require exactly one after query parameter");
  }
  const raw = values[0] ?? "";
  if (!EVENT_CURSOR_PATTERN.test(raw)) {
    invalid("after must be a canonical nonnegative safe integer");
  }
  const after = Number(raw);
  if (!Number.isSafeInteger(after)) {
    invalid("after must be a canonical nonnegative safe integer");
  }
  return { after };
}

export function runVerificationAttemptsQuery(searchParams: URLSearchParams): {
  readonly snapshot: number;
} {
  const keys = Array.from(searchParams.keys());
  const values = searchParams.getAll("snapshot");
  if (keys.length !== 1 || keys[0] !== "snapshot" || values.length !== 1) {
    invalid("Verification attempt requests require exactly one snapshot query parameter");
  }
  const raw = values[0] ?? "";
  if (!POSITIVE_EVENT_CURSOR_PATTERN.test(raw)) {
    invalid("snapshot must be a canonical positive safe integer");
  }
  const snapshot = Number(raw);
  if (!Number.isSafeInteger(snapshot)) {
    invalid("snapshot must be a canonical positive safe integer");
  }
  return { snapshot };
}

export function runEventHistoryQuery(searchParams: URLSearchParams): {
  readonly before: number;
  readonly snapshot: number;
} {
  const keys = Array.from(searchParams.keys());
  const beforeValues = searchParams.getAll("before");
  const snapshotValues = searchParams.getAll("snapshot");
  if (
    keys.length !== 2 ||
    new Set(keys).size !== 2 ||
    !keys.includes("before") ||
    !keys.includes("snapshot") ||
    beforeValues.length !== 1 ||
    snapshotValues.length !== 1
  ) {
    invalid("Historical event requests require exactly one before and snapshot query parameter");
  }
  const rawBefore = beforeValues[0] ?? "";
  const rawSnapshot = snapshotValues[0] ?? "";
  if (
    !POSITIVE_EVENT_CURSOR_PATTERN.test(rawBefore) ||
    !POSITIVE_EVENT_CURSOR_PATTERN.test(rawSnapshot)
  ) {
    invalid("before and snapshot must be canonical positive safe integers");
  }
  const before = Number(rawBefore);
  const snapshot = Number(rawSnapshot);
  if (!Number.isSafeInteger(before) || !Number.isSafeInteger(snapshot)) {
    invalid("before and snapshot must be canonical positive safe integers");
  }
  return { before, snapshot };
}

export function changeContextQuery(searchParams: URLSearchParams): {
  readonly question: ChangeContextQuestion;
} {
  const keys = Array.from(searchParams.keys());
  const values = searchParams.getAll("question");
  if (keys.length !== 1 || keys[0] !== "question" || values.length !== 1) {
    invalid("Change-context requests require exactly one question query parameter");
  }
  const question = values[0] ?? "";
  if (!CHANGE_CONTEXT_QUESTIONS.includes(question as ChangeContextQuestion)) {
    invalid(
      "question must be one of why_blocked, what_changed, what_passed, what_remains_before_review, why_rolled_back",
    );
  }
  return { question: question as ChangeContextQuestion };
}

function nullableDigest(value: unknown, name: string): string | null {
  if (value === null) return null;
  return stringValue(value, name, { maxBytes: 64, pattern: SHA256_PATTERN });
}

function nullableUuid(value: unknown, name: string): string | null {
  if (value === null) return null;
  return stringValue(value, name, { maxBytes: 36, pattern: UUID_PATTERN });
}

/** Parse the exact ten-field browser action identity from ADR 0029. */
export function browserActionRequest(value: unknown): BrowserActionIdentity {
  const body = objectValue(value, "request");
  exactKeys(
    body,
    [
      "actionId",
      "version",
      "kind",
      "runId",
      "expectedState",
      "eventRevision",
      "subjectDigest",
      "activeActionId",
      "activeActionDigest",
      "actionDigest",
    ],
    "request",
  );

  const actionId = stringValue(body.actionId, "actionId", {
    maxBytes: 36,
    pattern: UUID_PATTERN,
  });
  if (body.version !== BROWSER_ACTION_DESCRIPTOR_VERSION) {
    invalid("version is invalid");
  }
  if (!isBrowserActionKind(body.kind)) {
    invalid("kind is invalid");
  }
  const kind = body.kind;
  const runId = stringValue(body.runId, "runId", {
    maxBytes: 36,
    pattern: UUID_PATTERN,
  });
  const expectedState = stringValue(body.expectedState, "expectedState", { maxBytes: 64 });
  if (!(BROWSER_ACTION_EXPECTED_STATES[kind] as readonly string[]).includes(expectedState)) {
    invalid("expectedState is invalid for kind");
  }
  if (
    typeof body.eventRevision !== "number" ||
    !Number.isSafeInteger(body.eventRevision) ||
    body.eventRevision < 1
  ) {
    invalid("eventRevision must be a positive safe integer");
  }
  const subjectDigest = nullableDigest(body.subjectDigest, "subjectDigest");
  if (browserActionRequiresSubject(kind) !== (subjectDigest !== null)) {
    invalid("subjectDigest is invalid for kind");
  }
  const activeActionId = nullableUuid(body.activeActionId, "activeActionId");
  const activeActionDigest = nullableDigest(body.activeActionDigest, "activeActionDigest");
  if ((activeActionId === null) !== (activeActionDigest === null)) {
    invalid("active action identity is incomplete");
  }
  if (kind !== "run.cancel" && activeActionId !== null) {
    invalid("active action identity is invalid for kind");
  }
  const actionDigest = stringValue(body.actionDigest, "actionDigest", {
    maxBytes: 64,
    pattern: SHA256_PATTERN,
  });

  return {
    actionId,
    version: BROWSER_ACTION_DESCRIPTOR_VERSION,
    kind,
    runId,
    expectedState: expectedState as BrowserActionIdentity["expectedState"],
    eventRevision: body.eventRevision,
    subjectDigest,
    activeActionId,
    activeActionDigest,
    actionDigest,
  };
}
