import { IcarusError } from "@icarus/core";

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
const DIGEST_IMAGE_PATTERN = /^[a-z0-9][a-z0-9._/-]*(?::[a-zA-Z0-9._-]+)?@sha256:[a-f0-9]{64}$/;

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
