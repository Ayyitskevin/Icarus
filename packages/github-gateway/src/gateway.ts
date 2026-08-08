import { GithubGatewayError, invariant } from "./errors.js";
import { type GithubHttpResponse, sendGithubRequest } from "./http.js";
import {
  assertBaseBranch,
  assertBody,
  assertCommitMessage,
  assertFileMode,
  assertIcarusRef,
  assertObjectSha,
  assertOwner,
  assertTitle,
  assertTreePath,
  branchNameForRef,
} from "./identifiers.js";
import {
  buildOperationUrl,
  type GithubOperationKind,
  GITHUB_OPERATIONS,
  type GithubRepositoryCoordinates,
} from "./operations.js";
import { type GithubOriginLocality, resolveGithubOrigin } from "./origin.js";

// Must equal `GITHUB_API_VERSION` in @icarus/core's landing-records.ts, which
// the ADR 0027 landing digest binds. A test asserts the two agree.
const GITHUB_API_VERSION = "2026-03-10";
const USER_AGENT = "icarus-github-gateway";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TREE_ENTRIES = 512;
const PULL_REQUEST_PAGE_SIZE = 100;

// biome-ignore lint/complexity/useRegexLiterals: constructors keep control bytes out of regex literals
const CONTROL_CHARACTER_PATTERN = new RegExp(String.raw`[\x00-\x1f\x7f]`);

export interface GithubGatewayOptions {
  /** `https://api.github.com` in production; a loopback origin in tests. */
  readonly baseUrl: string;
  /**
   * A GitHub token read from the process environment by the caller. It is held
   * in a private field, sent only to the pinned origin, and never returned,
   * logged, persisted, or placed in an error.
   */
  readonly token: string;
  readonly fetchImplementation?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface GithubCallOptions {
  readonly signal?: AbortSignal | undefined;
}

/** Every receipt carries the digest of the exact response bytes it came from. */
export interface GithubReceipt {
  readonly responseSha256: string;
  readonly latencyMs: number;
}

export interface GithubObjectReceipt extends GithubReceipt {
  readonly sha: string;
}

export interface GithubActorReceipt extends GithubReceipt {
  /** The expected login, echoed only after an exact match. */
  readonly login: string;
}

export interface GithubReferenceReceipt extends GithubReceipt {
  readonly ref: string;
  readonly sha: string;
}

export interface GithubPullRequestReceipt extends GithubReceipt {
  readonly number: number;
  /**
   * The draft state GitHub reports. Creation refuses anything but a draft; a
   * reconciliation read reports the observed value, because a human may mark an
   * Icarus pull request ready for review and the coordinator must still be able
   * to find it.
   */
  readonly isDraft: boolean;
  /** Derived from the merge timestamp: a merged pull request's state is "closed". */
  readonly isMerged: boolean;
  readonly state: string;
  readonly headRef: string;
  readonly baseBranch: string;
  /** Reconstructed from validated components; never echoed from the response. */
  readonly htmlUrl: string;
}

export interface GithubTreeEntryInput {
  readonly path: string;
  readonly mode: string;
  readonly blobSha: string;
}

export interface GithubCommitInput {
  readonly message: string;
  readonly treeSha: string;
  readonly parentShas: readonly string[];
}

export interface GithubDraftPullRequestInput {
  readonly title: string;
  readonly body: string;
  readonly headRef: string;
  readonly baseBranch: string;
}

function asObject(response: GithubHttpResponse, subject: string): Record<string, unknown> {
  invariant(
    typeof response.value === "object" && response.value !== null && !Array.isArray(response.value),
    "GITHUB_PROTOCOL_ERROR",
    `${subject} is not a JSON object`,
    { status: response.status, responseSha256: response.bodySha256 },
  );
  return response.value as Record<string, unknown>;
}

function asNestedObject(
  value: unknown,
  response: GithubHttpResponse,
  subject: string,
): Record<string, unknown> {
  invariant(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "GITHUB_PROTOCOL_ERROR",
    `${subject} is not a JSON object`,
    { status: response.status, responseSha256: response.bodySha256 },
  );
  return value as Record<string, unknown>;
}

function readSha(
  object: Record<string, unknown>,
  response: GithubHttpResponse,
  subject: string,
): string {
  const value = object.sha;
  invariant(typeof value === "string", "GITHUB_PROTOCOL_ERROR", `${subject} has no object name`, {
    status: response.status,
    responseSha256: response.bodySha256,
  });
  return assertObjectSha(value, subject);
}

/**
 * A bounded client for the exact GitHub effects Packet 4 authorizes: uploading
 * Git objects, creating one absent reference, opening one draft pull request,
 * and reading back the reference and pull request for idempotent
 * reconciliation after an interrupted attempt.
 *
 * This package performs no durability, no approval, and no state transition.
 * The landing coordinator in `@icarus/core` owns intent, settlement, and
 * recovery; this gateway only performs one validated call at a time.
 */
export class GithubGateway {
  readonly locality: GithubOriginLocality;
  readonly #baseUrl: URL;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: GithubGatewayOptions) {
    invariant(options.token.length > 0, "GITHUB_TOKEN_REQUIRED", "A GitHub token is required");
    invariant(
      options.token.length >= 8 &&
        options.token.length <= 512 &&
        !/[\s\0]/.test(options.token) &&
        !CONTROL_CHARACTER_PATTERN.test(options.token),
      "GITHUB_TOKEN_INVALID",
      "A GitHub token must contain 8 to 512 non-whitespace, non-control characters",
    );
    const origin = resolveGithubOrigin(options.baseUrl);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    invariant(
      Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120_000,
      "GITHUB_TIMEOUT_INVALID",
      "The GitHub request timeout must be a positive integer of at most 120000 ms",
    );
    this.locality = origin.locality;
    this.#baseUrl = origin.url;
    this.#token = options.token;
    this.#fetch = options.fetchImplementation ?? globalThis.fetch;
    this.#timeoutMs = timeoutMs;
  }

  async #call(
    kind: GithubOperationKind,
    coordinates: GithubRepositoryCoordinates | null,
    options: {
      readonly trailingSegments?: readonly string[];
      readonly query?: Readonly<Record<string, string>>;
      readonly body?: unknown;
      readonly signal?: AbortSignal | undefined;
    },
  ): Promise<GithubHttpResponse> {
    const descriptor = GITHUB_OPERATIONS[kind];
    const url = buildOperationUrl(
      this.#baseUrl,
      kind,
      coordinates,
      options.trailingSegments ?? [],
      options.query ?? {},
    );
    invariant(
      url.origin === this.#baseUrl.origin && url.protocol === this.#baseUrl.protocol,
      "GITHUB_ORIGIN_DENIED",
      "A built GitHub request URL left the pinned origin and was not sent",
      { operation: kind },
    );
    const serialized = options.body === undefined ? undefined : JSON.stringify(options.body);
    invariant(
      descriptor.mutating || serialized === undefined,
      "GITHUB_PROTOCOL_ERROR",
      "A read operation may not carry a request body",
    );
    if (serialized !== undefined) {
      invariant(
        !serialized.includes(this.#token),
        "GITHUB_SECRET_DETECTED",
        "A GitHub request body contained credential material and was discarded",
      );
    }
    return await sendGithubRequest(
      {
        method: descriptor.method,
        url,
        body: serialized,
        timeoutMs: this.#timeoutMs,
        signal: options.signal,
        mutating: descriptor.mutating,
      },
      {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.#token}`,
        "content-type": "application/json",
        "user-agent": USER_AGENT,
        "x-github-api-version": GITHUB_API_VERSION,
      },
      this.#fetch,
    );
  }

  #expectStatus(response: GithubHttpResponse, expected: number, kind: GithubOperationKind): void {
    if (response.status === expected) {
      return;
    }
    throw new GithubGatewayError("GITHUB_HTTP_ERROR", `GitHub rejected the ${kind} operation`, {
      status: response.status,
      operation: kind,
      responseSha256: response.bodySha256,
    });
  }

  /**
   * Verifies that the credential belongs to the exact login the landing profile
   * expects. ADR 0027 requires this as the first call of every HTTP sequence, so
   * a swapped or wrong-account token cannot silently act as another identity.
   * This is the one authorized endpoint outside a repository path.
   */
  async readActor(
    expectedActor: string,
    options: GithubCallOptions = {},
  ): Promise<GithubActorReceipt> {
    const expected = assertOwner(expectedActor);
    const response = await this.#call("read_actor", null, { signal: options.signal });
    this.#expectStatus(response, 200, "read_actor");
    const object = asObject(response, "GitHub actor response");
    const login = object.login;
    invariant(
      typeof login === "string" && login.length > 0 && login.length <= 39,
      "GITHUB_PROTOCOL_ERROR",
      "GitHub actor response has no login",
      { status: response.status, responseSha256: response.bodySha256 },
    );
    invariant(
      login.toLowerCase() === expected,
      "GITHUB_ACTOR_MISMATCH",
      "The GitHub credential does not belong to the expected actor",
      { status: response.status, responseSha256: response.bodySha256 },
    );
    return {
      login: expected,
      responseSha256: response.bodySha256,
      latencyMs: response.latencyMs,
    };
  }

  /** Uploads one file's bytes as a Git blob. */
  async createBlob(
    coordinates: GithubRepositoryCoordinates,
    contentBase64: string,
    options: GithubCallOptions = {},
  ): Promise<GithubObjectReceipt> {
    invariant(
      /^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64),
      "GITHUB_CONTENT_INVALID",
      "Blob content must be base64",
    );
    // Blob content is the one body field carrying arbitrary repository bytes,
    // and it is base64, so the plaintext scan in #call cannot see into it. A
    // staged fixture holding this gateway's own credential would otherwise be
    // committed and rendered in the draft pull request diff.
    invariant(
      !Buffer.from(contentBase64, "base64").includes(this.#token, 0, "utf8"),
      "GITHUB_SECRET_DETECTED",
      "Blob content contained this gateway's credential and was not uploaded",
    );
    const response = await this.#call("create_blob", coordinates, {
      body: { content: contentBase64, encoding: "base64" },
      signal: options.signal,
    });
    this.#expectStatus(response, 201, "create_blob");
    const object = asObject(response, "GitHub blob response");
    return {
      sha: readSha(object, response, "GitHub blob response"),
      responseSha256: response.bodySha256,
      latencyMs: response.latencyMs,
    };
  }

  /** Creates one tree. Every entry is a regular file blob. */
  async createTree(
    coordinates: GithubRepositoryCoordinates,
    entries: readonly GithubTreeEntryInput[],
    baseTreeSha: string | undefined,
    options: GithubCallOptions = {},
  ): Promise<GithubObjectReceipt> {
    invariant(
      entries.length > 0 && entries.length <= MAX_TREE_ENTRIES,
      "GITHUB_TREE_INVALID",
      "A tree must carry between one entry and the entry ceiling",
    );
    const tree = entries.map((entry) => ({
      path: assertTreePath(entry.path),
      mode: assertFileMode(entry.mode),
      type: "blob",
      sha: assertObjectSha(entry.blobSha, "Tree entry blob"),
    }));
    const response = await this.#call("create_tree", coordinates, {
      body: {
        tree,
        ...(baseTreeSha === undefined
          ? {}
          : { base_tree: assertObjectSha(baseTreeSha, "Base tree") }),
      },
      signal: options.signal,
    });
    this.#expectStatus(response, 201, "create_tree");
    const object = asObject(response, "GitHub tree response");
    return {
      sha: readSha(object, response, "GitHub tree response"),
      responseSha256: response.bodySha256,
      latencyMs: response.latencyMs,
    };
  }

  /** Creates one commit object. It is not referenced until a reference is created. */
  async createCommit(
    coordinates: GithubRepositoryCoordinates,
    input: GithubCommitInput,
    options: GithubCallOptions = {},
  ): Promise<GithubObjectReceipt> {
    invariant(
      input.parentShas.length <= 2,
      "GITHUB_COMMIT_PARENTS_INVALID",
      "A candidate commit may declare at most two parents",
    );
    const response = await this.#call("create_commit", coordinates, {
      body: {
        message: assertCommitMessage(input.message),
        tree: assertObjectSha(input.treeSha, "Commit tree"),
        parents: input.parentShas.map((sha) => assertObjectSha(sha, "Commit parent")),
      },
      signal: options.signal,
    });
    this.#expectStatus(response, 201, "create_commit");
    const object = asObject(response, "GitHub commit response");
    return {
      sha: readSha(object, response, "GitHub commit response"),
      responseSha256: response.bodySha256,
      latencyMs: response.latencyMs,
    };
  }

  /**
   * Creates a reference that must not already exist. GitHub's create-reference
   * endpoint refuses an existing reference, so this cannot overwrite or
   * fast-forward anything; an existing reference surfaces as
   * `GITHUB_REF_EXISTS` for the coordinator to reconcile.
   */
  async createAbsentRef(
    coordinates: GithubRepositoryCoordinates,
    ref: string,
    commitSha: string,
    options: GithubCallOptions = {},
  ): Promise<GithubReferenceReceipt> {
    const validatedRef = assertIcarusRef(ref);
    const validatedSha = assertObjectSha(commitSha, "Reference target");
    const response = await this.#call("create_absent_ref", coordinates, {
      body: { ref: validatedRef, sha: validatedSha },
      signal: options.signal,
    });
    if (response.status === 422) {
      // GitHub returns 422 for an existing reference, a missing object, an
      // unusable name, and a ruleset or branch-protection refusal alike. This
      // gateway reads no upstream bytes, so it cannot distinguish them and must
      // not claim the reference already exists — a protection refusal would
      // otherwise be recorded as benign idempotency. The coordinator
      // disambiguates with the read_reference it already owns.
      throw new GithubGatewayError(
        "GITHUB_REF_CREATE_REFUSED",
        "GitHub refused to create the Icarus reference; nothing was modified",
        { status: response.status, ref: validatedRef, responseSha256: response.bodySha256 },
      );
    }
    this.#expectStatus(response, 201, "create_absent_ref");
    const object = asObject(response, "GitHub reference response");
    invariant(
      object.ref === validatedRef,
      "GITHUB_PROTOCOL_ERROR",
      "GitHub returned a different reference than the one requested",
      { status: response.status, responseSha256: response.bodySha256 },
    );
    const target = asNestedObject(object.object, response, "GitHub reference target");
    return {
      ref: validatedRef,
      sha: readSha(target, response, "GitHub reference target"),
      responseSha256: response.bodySha256,
      latencyMs: response.latencyMs,
    };
  }

  /** Opens one pull request that is always a draft. */
  async createDraftPullRequest(
    coordinates: GithubRepositoryCoordinates,
    input: GithubDraftPullRequestInput,
    options: GithubCallOptions = {},
  ): Promise<GithubPullRequestReceipt> {
    const headBranch = branchNameForRef(input.headRef);
    const baseBranch = assertBaseBranch(input.baseBranch);
    const response = await this.#call("create_draft_pull_request", coordinates, {
      body: {
        title: assertTitle(input.title),
        body: assertBody(input.body),
        head: headBranch,
        base: baseBranch,
        // A literal, never a parameter: this gateway cannot open a ready pull
        // request.
        draft: true,
        maintainer_can_modify: false,
      },
      signal: options.signal,
    });
    this.#expectStatus(response, 201, "create_draft_pull_request");
    const receipt = this.#readPullRequest(response, coordinates, input.headRef, baseBranch);
    invariant(
      receipt.isDraft,
      "GITHUB_DRAFT_NOT_HONORED",
      "GitHub did not record the new pull request as a draft",
      { number: receipt.number, responseSha256: receipt.responseSha256 },
    );
    return receipt;
  }

  /** Reads one reference, returning null when it is absent. */
  async readReference(
    coordinates: GithubRepositoryCoordinates,
    ref: string,
    options: GithubCallOptions = {},
  ): Promise<GithubReferenceReceipt | null> {
    const validatedRef = assertIcarusRef(ref);
    const response = await this.#call("read_reference", coordinates, {
      trailingSegments: validatedRef.slice("refs/".length).split("/"),
      signal: options.signal,
    });
    if (response.status === 404) {
      return null;
    }
    this.#expectStatus(response, 200, "read_reference");
    const object = asObject(response, "GitHub reference response");
    invariant(
      object.ref === validatedRef,
      "GITHUB_PROTOCOL_ERROR",
      "GitHub returned a different reference than the one requested",
      { status: response.status, responseSha256: response.bodySha256 },
    );
    const target = asNestedObject(object.object, response, "GitHub reference target");
    return {
      ref: validatedRef,
      sha: readSha(target, response, "GitHub reference target"),
      responseSha256: response.bodySha256,
      latencyMs: response.latencyMs,
    };
  }

  /**
   * Finds an existing pull request for one Icarus head reference. The
   * coordinator uses this after an interrupted attempt so a retry reconciles
   * instead of opening a second pull request.
   */
  async readPullRequestByHead(
    coordinates: GithubRepositoryCoordinates,
    headRef: string,
    baseBranch: string,
    options: GithubCallOptions = {},
  ): Promise<GithubPullRequestReceipt | null> {
    const headBranch = branchNameForRef(headRef);
    const response = await this.#call("read_pull_requests", coordinates, {
      // ADR 0027 pins these exact parameters. A full page means the result may
      // be truncated, which is a bounded ambiguity that fails closed rather
      // than being read as "no pull request exists".
      query: {
        head: `${coordinates.owner}:${headBranch}`,
        base: assertBaseBranch(baseBranch),
        state: "all",
        page: "1",
        per_page: String(PULL_REQUEST_PAGE_SIZE),
      },
      signal: options.signal,
    });
    this.#expectStatus(response, 200, "read_pull_requests");
    invariant(
      Array.isArray(response.value),
      "GITHUB_PROTOCOL_ERROR",
      "GitHub pull request listing is not an array",
      { status: response.status, responseSha256: response.bodySha256 },
    );
    invariant(
      response.value.length < PULL_REQUEST_PAGE_SIZE,
      "GITHUB_RECONCILIATION_AMBIGUOUS",
      "GitHub returned a full pull request page, so absence cannot be established",
      { status: response.status, responseSha256: response.bodySha256 },
    );
    invariant(
      response.value.length <= 1,
      "GITHUB_RECONCILIATION_AMBIGUOUS",
      "GitHub returned more than one pull request for this exact head and base",
      { status: response.status, responseSha256: response.bodySha256 },
    );
    const first = response.value[0];
    if (first === undefined) {
      return null;
    }
    // The listing is filtered by head and base, but the receipt would otherwise
    // restate the caller's arguments as if the response had confirmed them.
    // Verify both, matching the equality checks the reference paths already make.
    invariant(
      readBaseBranch(first, response) === baseBranch,
      "GITHUB_PROTOCOL_ERROR",
      "GitHub returned a pull request whose base is not the requested base",
      { status: response.status, responseSha256: response.bodySha256 },
    );
    invariant(
      readHeadBranch(first, response) === headBranch,
      "GITHUB_PROTOCOL_ERROR",
      "GitHub returned a pull request whose head is not the requested head",
      { status: response.status, responseSha256: response.bodySha256 },
    );
    return this.#readPullRequest({ ...response, value: first }, coordinates, headRef, baseBranch);
  }

  #readPullRequest(
    response: GithubHttpResponse,
    coordinates: GithubRepositoryCoordinates,
    headRef: string,
    baseBranch: string,
  ): GithubPullRequestReceipt {
    const object = asObject(response, "GitHub pull request response");
    const number = object.number;
    invariant(
      typeof number === "number" && Number.isSafeInteger(number) && number > 0,
      "GITHUB_PROTOCOL_ERROR",
      "GitHub pull request response has no number",
      { status: response.status, responseSha256: response.bodySha256 },
    );
    const isDraft = object.draft;
    invariant(
      typeof isDraft === "boolean",
      "GITHUB_PROTOCOL_ERROR",
      "GitHub pull request response has no draft state",
      { status: response.status, number, responseSha256: response.bodySha256 },
    );
    const state = object.state;
    invariant(
      typeof state === "string" && /^[a-z]{1,16}$/.test(state),
      "GITHUB_PROTOCOL_ERROR",
      "GitHub pull request response has no state",
      { status: response.status, responseSha256: response.bodySha256 },
    );
    // The list schema carries merged_at but no merged boolean, and a merged
    // pull request's state is "closed" exactly like an abandoned one. Reduce it
    // to a boolean so the coordinator can tell whether the change actually
    // landed; a boolean is not upstream content.
    const mergedAt = object.merged_at;
    invariant(
      mergedAt === null || mergedAt === undefined || typeof mergedAt === "string",
      "GITHUB_PROTOCOL_ERROR",
      "GitHub pull request response has an unreadable merge timestamp",
      { status: response.status, responseSha256: response.bodySha256 },
    );
    return {
      number,
      isDraft,
      isMerged: typeof mergedAt === "string" && mergedAt.length > 0,
      state,
      headRef,
      baseBranch,
      // Reconstructed from validated inputs rather than echoed, so no upstream
      // byte reaches the receipt.
      htmlUrl: `https://github.com/${coordinates.owner}/${coordinates.repository}/pull/${number}`,
      responseSha256: response.bodySha256,
      latencyMs: response.latencyMs,
    };
  }
}

function readHeadBranch(value: unknown, response: GithubHttpResponse): string {
  const head = nestedMember(value, "head", response);
  const ref = (head as Record<string, unknown>).ref;
  invariant(
    typeof ref === "string",
    "GITHUB_PROTOCOL_ERROR",
    "GitHub pull request entry has no head reference",
    { status: response.status, responseSha256: response.bodySha256 },
  );
  return ref;
}

function nestedMember(
  value: unknown,
  member: string,
  response: GithubHttpResponse,
): Record<string, unknown> {
  invariant(
    typeof value === "object" && value !== null,
    "GITHUB_PROTOCOL_ERROR",
    "GitHub pull request entry is not an object",
    { status: response.status, responseSha256: response.bodySha256 },
  );
  const nested = (value as Record<string, unknown>)[member];
  invariant(
    typeof nested === "object" && nested !== null,
    "GITHUB_PROTOCOL_ERROR",
    `GitHub pull request entry has no ${member}`,
    { status: response.status, responseSha256: response.bodySha256 },
  );
  return nested as Record<string, unknown>;
}

function readBaseBranch(value: unknown, response: GithubHttpResponse): string {
  invariant(
    typeof value === "object" && value !== null,
    "GITHUB_PROTOCOL_ERROR",
    "GitHub pull request entry is not an object",
    { status: response.status, responseSha256: response.bodySha256 },
  );
  const base = (value as Record<string, unknown>).base;
  invariant(
    typeof base === "object" && base !== null,
    "GITHUB_PROTOCOL_ERROR",
    "GitHub pull request entry has no base",
    { status: response.status, responseSha256: response.bodySha256 },
  );
  const ref = (base as Record<string, unknown>).ref;
  invariant(
    typeof ref === "string",
    "GITHUB_PROTOCOL_ERROR",
    "GitHub pull request entry has no base reference",
    { status: response.status, responseSha256: response.bodySha256 },
  );
  return assertBaseBranch(ref);
}
