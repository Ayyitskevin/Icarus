import { IcarusError } from "@icarus/core";

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
const DIGEST_IMAGE_PATTERN = /^[a-z0-9][a-z0-9._/-]*(?::[a-zA-Z0-9._-]+)?@sha256:[a-f0-9]{64}$/;
const EVENT_CURSOR_PATTERN = /^(0|[1-9][0-9]*)$/;
const POSITIVE_EVENT_CURSOR_PATTERN = /^[1-9][0-9]*$/;
const SAFE_RUN_SNAPSHOT_MAX = Number.MAX_SAFE_INTEGER - 1;

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
  readonly target: string;
  readonly provider: { readonly model: string; readonly baseUrl: string };
}

export function runDraftRequest(value: unknown): RunDraftRequest {
  const body = objectValue(value, "request");
  exactKeys(body, ["projectId", "task", "target", "provider"], "request");
  const provider = objectValue(body.provider, "provider");
  exactKeys(provider, ["model", "baseUrl"], "provider");
  return {
    projectId: stringValue(body.projectId, "projectId", { maxBytes: 100 }),
    task: stringValue(body.task, "task", { maxBytes: 8 * 1024 }),
    target: stringValue(body.target, "target", { maxBytes: 1_024 }),
    provider: {
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
