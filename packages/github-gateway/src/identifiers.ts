import { invariant } from "./errors.js";

/**
 * Every value that reaches a request path or a mutating request body is
 * validated here first. Validation is allowlist-shaped: a value is rejected
 * unless it matches an exact pattern. Nothing in this module accepts a caller
 * supplied URL, path, method, or Git argument.
 *
 * The patterns and ceilings below deliberately mirror the accepted ADR 0027
 * record contract as implemented in `@icarus/core`'s `landing-records.ts`. This
 * package cannot import them without inverting the dependency direction, so
 * `tests/unit/github-gateway-record-contract.test.ts` asserts the two agree and
 * fails the build if either side drifts.
 */

const OWNER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const REPOSITORY_PATTERN = /^[a-z0-9._-]{1,100}$/;
const OBJECT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TREE_PATH_PATTERN = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
const FILE_MODE_PATTERN = /^100(?:644|755)$/;

/**
 * Icarus may only create references beneath its own reserved namespace. This
 * matches the private local namespace Packet 3 already writes
 * (`refs/heads/icarus/<run-id>`), so a remote reference can never collide with
 * an operator branch, a default branch, or a protected branch.
 */
export const ICARUS_REF_NAMESPACE = "refs/heads/icarus/";

/** UTF-8 byte ceilings from the ADR 0027 record contract. */
export const MAX_COMMIT_MESSAGE_BYTES = 4 * 1024;
export const MAX_PULL_REQUEST_TITLE_BYTES = 256;
export const MAX_PULL_REQUEST_BODY_BYTES = 40 * 1024;

const MAX_TREE_PATH_LENGTH = 512;

/**
 * Directories and files a continuous-integration system executes on push.
 *
 * Creating `refs/heads/icarus/<run-id>` fires GitHub's `create` and `push`
 * events, and opening a pull request from a same-repository branch fires
 * `pull_request`. In each case the *head* branch's own automation definitions
 * run, with repository secrets, before a human has reviewed the draft. Uploading
 * such a file would therefore turn this gateway's authorized sequence into
 * arbitrary remote code execution — the effect the operation table declares is
 * not expressible.
 *
 * `@icarus/core`'s path policy is the authoritative layer and denies
 * `.github/workflows/`; this is an independent second layer covering the same
 * class, because the two packages cannot import each other.
 */
const AUTOMATION_ROOTS = new Set([
  ".github",
  ".circleci",
  ".buildkite",
  ".gitlab",
  ".woodpecker",
  ".teamcity",
]);

const AUTOMATION_FILES = new Set([
  ".gitlab-ci.yml",
  ".gitlab-ci.yaml",
  ".travis.yml",
  ".drone.yml",
  "jenkinsfile",
  "azure-pipelines.yml",
  "azure-pipelines.yaml",
  "appveyor.yml",
  "cloudbuild.yaml",
  "bitbucket-pipelines.yml",
]);

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function assertOwner(value: string): string {
  invariant(
    OWNER_PATTERN.test(value) && !value.includes("--"),
    "GITHUB_OWNER_INVALID",
    "Repository owner must be an exact lowercase GitHub login",
  );
  return value;
}

export function assertRepository(value: string): string {
  invariant(
    REPOSITORY_PATTERN.test(value) && value !== "." && value !== "..",
    "GITHUB_REPOSITORY_INVALID",
    "Repository name must be an exact lowercase GitHub repository name",
  );
  return value;
}

export function assertObjectSha(value: string, subject: string): string {
  invariant(
    OBJECT_SHA_PATTERN.test(value),
    "GITHUB_OBJECT_SHA_INVALID",
    `${subject} must be a 40-character lowercase hexadecimal object name`,
  );
  return value;
}

/**
 * The only reference this gateway can name. The run id is bound into the
 * reference so one landing decision maps to exactly one remote reference.
 */
export function assertIcarusRef(value: string): string {
  invariant(
    value.startsWith(ICARUS_REF_NAMESPACE),
    "GITHUB_REF_DENIED",
    "Icarus may only create references beneath refs/heads/icarus/",
  );
  const runId = value.slice(ICARUS_REF_NAMESPACE.length);
  invariant(
    RUN_ID_PATTERN.test(runId),
    "GITHUB_REF_DENIED",
    "An Icarus reference must end with an exact run identifier",
  );
  return value;
}

export function icarusRefForRun(runId: string): string {
  invariant(
    RUN_ID_PATTERN.test(runId),
    "GITHUB_REF_DENIED",
    "An Icarus reference must end with an exact run identifier",
  );
  return `${ICARUS_REF_NAMESPACE}${runId}`;
}

/** The branch name a pull request head refers to, derived from the reference. */
export function branchNameForRef(ref: string): string {
  return assertIcarusRef(ref).slice("refs/heads/".length);
}

export function assertTreePath(value: string): string {
  invariant(
    value.length <= MAX_TREE_PATH_LENGTH &&
      TREE_PATH_PATTERN.test(value) &&
      !value.split("/").some((segment) => segment === "." || segment === ".."),
    "GITHUB_PATH_INVALID",
    "A tree path must be a relative, traversal-free repository path",
  );
  const segments = value.split("/");
  const root = (segments[0] ?? "").toLowerCase();
  invariant(
    !AUTOMATION_ROOTS.has(root) && !(segments.length === 1 && AUTOMATION_FILES.has(root)),
    "GITHUB_AUTOMATION_PATH_DENIED",
    "Icarus may not upload continuous-integration configuration, which the push would execute",
  );
  return value;
}

export function assertFileMode(value: string): string {
  invariant(
    FILE_MODE_PATTERN.test(value),
    "GITHUB_FILE_MODE_DENIED",
    "Only regular file modes 100644 and 100755 may be uploaded",
  );
  return value;
}

/**
 * The base branch a pull request targets. Creating a pull request does not
 * mutate the base, but the value still reaches a request body, so it is
 * validated against Git's reference-name rules rather than trusted.
 */
export function assertBaseBranch(value: string): string {
  invariant(
    value.length > 0 &&
      value.length <= 255 &&
      /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
      !value.includes("..") &&
      !value.includes("//") &&
      !value.endsWith("/") &&
      !value.endsWith(".lock"),
    "GITHUB_BASE_BRANCH_INVALID",
    "A pull request base branch must be an ordinary Git branch name",
  );
  return value;
}

export function assertCommitMessage(value: string): string {
  invariant(
    value.length > 0 && utf8Bytes(value) <= MAX_COMMIT_MESSAGE_BYTES,
    "GITHUB_COMMIT_MESSAGE_INVALID",
    "A commit message must be non-empty and within the record-contract byte ceiling",
  );
  return value;
}

export function assertTitle(value: string): string {
  invariant(
    value.length > 0 && utf8Bytes(value) <= MAX_PULL_REQUEST_TITLE_BYTES && !/[\r\n\0]/.test(value),
    "GITHUB_TITLE_INVALID",
    "A pull request title must be single-line and within the record-contract byte ceiling",
  );
  return value;
}

export function assertBody(value: string): string {
  invariant(
    utf8Bytes(value) <= MAX_PULL_REQUEST_BODY_BYTES && !value.includes("\0"),
    "GITHUB_BODY_INVALID",
    "A pull request body must be within the record-contract byte ceiling and contain no NUL",
  );
  return value;
}
