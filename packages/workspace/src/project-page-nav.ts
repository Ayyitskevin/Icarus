import type {
  CheckConfiguration,
  ProjectCeilingView,
  ProjectPageView,
  ProjectSandboxView,
  ProjectView,
} from "./api.js";

export const PROJECT_PAGE_SIZE = 12;
export const PROJECT_PAGE_MAX_PAGES = 4;
export const PROJECT_PAGE_MAX_NEWER_CURSORS = PROJECT_PAGE_MAX_PAGES - 1;
export const PROJECT_CHECKS_MAX_BYTES = 1024 * 1024;

const PAGE_KEYS = ["before", "snapshot", "nextBefore", "hasMore", "projects"];
const PROJECT_KEYS = [
  "id",
  "name",
  "repository",
  "baseRef",
  "checks",
  "sandbox",
  "ceiling",
  "createdAt",
];
const REPOSITORY_KEYS = ["id", "name", "path"];
const CHECK_KEYS = ["id", "name", "argv"];
const SANDBOX_KEYS = ["image", "cpus", "memoryMb", "pids", "tmpfsMb"];
const CEILING_KEYS = [
  "maxToolCalls",
  "maxActiveRuntimeMs",
  "maxContextBytes",
  "maxOutputTokensPerCall",
  "maxTotalTokens",
  "maxCostUsd",
  "maxFilesChanged",
  "maxFileBytes",
  "maxDiffBytes",
  "maxCommandOutputBytes",
  "maxRawCommandOutputBytes",
  "providerTimeoutMs",
  "commandTimeoutMs",
] as const satisfies readonly (keyof ProjectCeilingView)[];
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const DIGEST_IMAGE_PATTERN = /^[a-z0-9][a-z0-9._/-]*(?::[a-zA-Z0-9._-]+)?@sha256:[a-f0-9]{64}$/;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type ProjectPageDirection = "older" | "newer";

export interface ProjectPageRequest {
  readonly before: number;
  readonly snapshot: number;
  readonly direction: ProjectPageDirection;
}

export interface ProjectPageSession {
  readonly snapshot: number;
  readonly initialBefore: number;
  readonly page: ProjectPageView;
  readonly newerBefore: readonly number[];
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonnegativeSafeInteger(value) && value > 0;
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || utf8Length(value) > 64 || !TIMESTAMP_PATTERN.test(value)) {
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

function validateChecks(value: unknown): asserts value is readonly CheckConfiguration[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("The workspace project checks were invalid.");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("The workspace project checks were invalid.");
  }
  if (utf8Length(serialized) > PROJECT_CHECKS_MAX_BYTES) {
    throw new Error("The workspace project checks exceeded their byte limit.");
  }
  const ids = new Set<string>();
  for (const entry of value) {
    if (!isExactRecord(entry, CHECK_KEYS)) {
      throw new Error("The workspace project check shape was invalid.");
    }
    if (
      typeof entry.id !== "string" ||
      entry.id.length === 0 ||
      ids.has(entry.id) ||
      typeof entry.name !== "string" ||
      entry.name.length === 0 ||
      !Array.isArray(entry.argv) ||
      entry.argv.length === 0 ||
      !entry.argv.every(
        (part) =>
          typeof part === "string" &&
          part.length > 0 &&
          !part.includes("\0") &&
          !/[\r\n]/.test(part),
      )
    ) {
      throw new Error("The workspace project check metadata was invalid.");
    }
    ids.add(entry.id);
  }
}

function validateSandbox(value: unknown): asserts value is ProjectSandboxView {
  if (!isExactRecord(value, SANDBOX_KEYS)) {
    throw new Error("The workspace project sandbox shape was invalid.");
  }
  if (
    typeof value.image !== "string" ||
    !DIGEST_IMAGE_PATTERN.test(value.image) ||
    typeof value.cpus !== "number" ||
    value.cpus <= 0 ||
    value.cpus > 4 ||
    typeof value.memoryMb !== "number" ||
    value.memoryMb < 128 ||
    value.memoryMb > 8_192 ||
    typeof value.pids !== "number" ||
    value.pids < 16 ||
    value.pids > 512 ||
    typeof value.tmpfsMb !== "number" ||
    value.tmpfsMb < 16 ||
    value.tmpfsMb > 2_048
  ) {
    throw new Error("The workspace project sandbox metadata was invalid.");
  }
}

function validateCeiling(value: unknown): asserts value is ProjectCeilingView {
  if (!isExactRecord(value, CEILING_KEYS)) {
    throw new Error("The workspace project ceiling shape was invalid.");
  }
  const integerKeys = CEILING_KEYS.filter((key) => key !== "maxCostUsd");
  if (
    !integerKeys.every((key) => Number.isSafeInteger(value[key]) && Number(value[key]) > 0) ||
    value.maxFilesChanged !== 1 ||
    typeof value.maxCostUsd !== "number" ||
    !Number.isFinite(value.maxCostUsd) ||
    value.maxCostUsd < 0 ||
    Number(value.maxActiveRuntimeMs) > MAX_TIMER_DELAY_MS ||
    Number(value.providerTimeoutMs) > MAX_TIMER_DELAY_MS ||
    Number(value.commandTimeoutMs) > MAX_TIMER_DELAY_MS ||
    Number(value.maxOutputTokensPerCall) > Number(value.maxTotalTokens) ||
    Number(value.maxCommandOutputBytes) > Number(value.maxRawCommandOutputBytes)
  ) {
    throw new Error("The workspace project ceiling metadata was invalid.");
  }
}

function validateProject(value: unknown): asserts value is ProjectView {
  if (!isExactRecord(value, PROJECT_KEYS)) {
    throw new Error("The workspace project shape was invalid.");
  }
  if (
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    typeof value.name !== "string" ||
    !NAME_PATTERN.test(value.name) ||
    !isExactRecord(value.repository, REPOSITORY_KEYS) ||
    typeof value.repository.id !== "string" ||
    !UUID_PATTERN.test(value.repository.id) ||
    typeof value.repository.name !== "string" ||
    !NAME_PATTERN.test(value.repository.name) ||
    typeof value.repository.path !== "string" ||
    value.repository.path.trim().length === 0 ||
    value.repository.path.includes("\0") ||
    utf8Length(value.repository.path) > 4_096 ||
    typeof value.baseRef !== "string" ||
    value.baseRef.length === 0 ||
    value.baseRef.startsWith("-") ||
    /[\r\n\0]/.test(value.baseRef) ||
    utf8Length(value.baseRef) > 256 ||
    !isCanonicalTimestamp(value.createdAt)
  ) {
    throw new Error("The workspace project metadata was invalid.");
  }
  validateChecks(value.checks);
  validateSandbox(value.sandbox);
  validateCeiling(value.ceiling);
}

export function validateProjectPage(
  page: unknown,
  expected?: Pick<ProjectPageRequest, "before" | "snapshot">,
): asserts page is ProjectPageView {
  if (!isExactRecord(page, PAGE_KEYS)) {
    throw new Error("The workspace project page shape was invalid.");
  }
  if (
    (expected !== undefined &&
      (page.before !== expected.before || page.snapshot !== expected.snapshot)) ||
    !isPositiveSafeInteger(page.before) ||
    !isNonnegativeSafeInteger(page.snapshot) ||
    page.snapshot > Number.MAX_SAFE_INTEGER - 1 ||
    page.before > page.snapshot + 1 ||
    !isPositiveSafeInteger(page.nextBefore) ||
    typeof page.hasMore !== "boolean" ||
    !Array.isArray(page.projects) ||
    page.projects.length > PROJECT_PAGE_SIZE
  ) {
    throw new Error("The workspace project page metadata was invalid.");
  }

  const ids = new Set<string>();
  for (const project of page.projects) {
    validateProject(project);
    if (ids.has(project.id)) {
      throw new Error("The workspace project page repeated a project.");
    }
    ids.add(project.id);
  }

  if (page.projects.length === 0) {
    if (page.before !== 1 || page.snapshot !== 0 || page.nextBefore !== 1 || page.hasMore) {
      throw new Error("The empty workspace project page cursor was inconsistent.");
    }
    return;
  }

  if (
    page.snapshot === 0 ||
    page.nextBefore >= page.before ||
    page.nextBefore > page.snapshot ||
    (page.hasMore && page.projects.length !== PROJECT_PAGE_SIZE)
  ) {
    throw new Error("The workspace project page boundary was inconsistent.");
  }
}

export function createProjectPageSession(page: unknown): ProjectPageSession {
  validateProjectPage(page);
  if (page.before !== page.snapshot + 1) {
    throw new Error("The newest workspace project page did not start a pinned session.");
  }
  return {
    snapshot: page.snapshot,
    initialBefore: page.before,
    page,
    newerBefore: [],
  };
}

export function canNavigateToOlderProjects(session: ProjectPageSession): boolean {
  return session.page.hasMore && session.newerBefore.length < PROJECT_PAGE_MAX_NEWER_CURSORS;
}

export function canNavigateToNewerProjects(session: ProjectPageSession): boolean {
  return session.newerBefore.length > 0;
}

export function projectPageDepth(session: ProjectPageSession): number {
  return session.newerBefore.length + 1;
}

export function projectPageRequest(
  session: ProjectPageSession,
  direction: ProjectPageDirection,
): ProjectPageRequest {
  if (direction === "older") {
    if (!canNavigateToOlderProjects(session)) {
      throw new Error("The bounded workspace project window cannot navigate farther back.");
    }
    return { before: session.page.nextBefore, snapshot: session.snapshot, direction };
  }
  if (!canNavigateToNewerProjects(session)) {
    throw new Error("The workspace project page has no newer page in this session.");
  }
  const before = session.newerBefore.at(-1);
  if (before === undefined) {
    throw new Error("The workspace newer-project-page cursor is missing.");
  }
  return { before, snapshot: session.snapshot, direction };
}

export function acceptProjectPage(
  session: ProjectPageSession,
  request: ProjectPageRequest,
  page: unknown,
): ProjectPageSession {
  if (request.snapshot !== session.snapshot) {
    throw new Error("The workspace project request no longer belongs to this page session.");
  }
  const expected = projectPageRequest(session, request.direction);
  if (expected.before !== request.before) {
    throw new Error("The workspace project request cursor is stale.");
  }
  validateProjectPage(page, request);
  const newerBefore =
    request.direction === "older"
      ? [...session.newerBefore, session.page.before]
      : session.newerBefore.slice(0, -1);
  if (newerBefore.length > PROJECT_PAGE_MAX_NEWER_CURSORS) {
    throw new Error("The workspace project page window exceeded its bounded depth.");
  }
  return { ...session, page, newerBefore };
}
