import { createHash } from "node:crypto";

import { GithubGatewayError, invariant } from "./errors.js";
import { type GithubHttpResponse, sendGithubRequest } from "./http.js";
import {
  assertBaseBranch,
  assertBaseRef,
  assertBody,
  assertCommitMessage,
  assertCommitParty,
  assertFileMode,
  assertIcarusRef,
  assertObjectSha,
  assertOwner,
  assertTitle,
  assertTreePath,
  branchNameForRef,
  type GithubCommitParty,
  MAX_PULL_REQUEST_BODY_BYTES,
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
  /**
   * Loopback origins exist for offline tests and the deterministic benchmark
   * transport, and they receive the credential in cleartext. They must be opted
   * into explicitly, so a misconfigured or environment-derived base URL pointing
   * at a local port cannot silently be handed the token.
   */
  readonly allowLoopback?: boolean;
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
  /** The exact object names the response reports for the head and base. */
  readonly headSha1: string;
  readonly baseSha1: string;
  /**
   * Digests of the reported title and body, plus the count of reserved landing
   * markers in the body. The coordinator's exact-proof needs these, and the
   * upstream text itself never leaves this package.
   */
  readonly titleSha256: string;
  readonly bodySha256: string;
  readonly markerCount: number;
  readonly maintainerCanModify: boolean;
  /** Reconstructed from validated components; never echoed from the response. */
  readonly htmlUrl: string;
}

export interface GithubTreeEntryInput {
  readonly path: string;
  readonly mode: string;
  /** The uploaded blob's object name, or null for a deletion entry. */
  readonly blobSha: string | null;
}

export interface GithubCommitInput {
  readonly message: string;
  readonly treeSha: string;
  readonly parentShas: readonly string[];
  readonly author: GithubCommitParty;
  readonly committer: GithubCommitParty;
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
    invariant(
      origin.locality === "remote" || options.allowLoopback === true,
      "GITHUB_LOOPBACK_NOT_ALLOWED",
      "A loopback GitHub origin requires an explicit allowLoopback opt-in",
    );
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
    // Throttling is carried as bounded integers beside the status. A secondary
    // rate limit arrives as 403 and an ordinary authorization failure arrives as
    // 403, so without these the coordinator cannot tell a wait-and-reconcile
    // refusal from a terminal one.
    throw new GithubGatewayError("GITHUB_HTTP_ERROR", `GitHub rejected the ${kind} operation`, {
      status: response.status,
      operation: kind,
      responseSha256: response.bodySha256,
      retryAfterSeconds: response.throttle.retryAfterSeconds,
      rateLimitRemaining: response.throttle.remaining,
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
      /^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64) && contentBase64.length % 4 === 0,
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

  /** Creates one tree. Every entry is a regular file blob or a deletion. */
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
    // Every body this gateway emits serializes with ascending-ASCII keys, so
    // the wire bytes are exactly the canonical bytes the landing ledger binds
    // with `bodySha256` — this includes each entry's own key order.
    const tree = entries.map((entry) => ({
      mode: assertFileMode(entry.mode),
      path: assertTreePath(entry.path),
      sha: entry.blobSha === null ? null : assertObjectSha(entry.blobSha, "Tree entry blob"),
      type: "blob",
    }));
    const response = await this.#call("create_tree", coordinates, {
      body: {
        ...(baseTreeSha === undefined
          ? {}
          : { base_tree: assertObjectSha(baseTreeSha, "Base tree") }),
        tree,
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

  /**
   * Creates one commit object. It is not referenced until a reference is
   * created. The author and committer are explicit: omitting them would let
   * GitHub substitute the token's user and the current time, and the returned
   * commit name could never equal the landing's locally computed identity.
   */
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
    const author = assertCommitParty(input.author, "Commit author");
    const committer = assertCommitParty(input.committer, "Commit committer");
    const response = await this.#call("create_commit", coordinates, {
      body: {
        author: { date: author.date, email: author.email, name: author.name },
        committer: { date: committer.date, email: committer.email, name: committer.name },
        message: assertCommitMessage(input.message),
        parents: input.parentShas.map((sha) => assertObjectSha(sha, "Commit parent")),
        tree: assertObjectSha(input.treeSha, "Commit tree"),
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
      // Ascending-ASCII key order: the wire bytes must equal the canonical
      // serialization the landing ledger binds with `bodySha256`. The head is
      // owner-qualified exactly as the record contract spells it.
      body: {
        base: baseBranch,
        body: assertBody(input.body),
        // A literal, never a parameter: this gateway cannot open a ready pull
        // request.
        draft: true,
        head: `${coordinates.owner}:${headBranch}`,
        maintainer_can_modify: false,
        title: assertTitle(input.title),
      },
      signal: options.signal,
    });
    if (response.status === 422) {
      // GitHub answers 422 here for a duplicate head, "no commits between",
      // an invalid base, and unsupported drafts alike. Report the refusal
      // without attributing a cause so the coordinator re-reads instead of
      // treating it as terminal.
      throw new GithubGatewayError(
        "GITHUB_PULL_REQUEST_CREATE_REFUSED",
        "GitHub refused to create the pull request; nothing was created",
        { status: response.status, responseSha256: response.bodySha256 },
      );
    }
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
   * Reads the base branch's current commit, which the candidate commit parents
   * from. Returns null when the base branch is absent.
   *
   * This is the only reference the gateway reads outside its own namespace, and
   * it is read-only: `assertBaseRef` refuses an Icarus-namespaced value, so this
   * path can never be used to observe or reach a reference the create path
   * owns.
   */
  async readBaseReference(
    coordinates: GithubRepositoryCoordinates,
    baseRef: string,
    options: GithubCallOptions = {},
  ): Promise<GithubReferenceReceipt | null> {
    const validatedRef = assertBaseRef(baseRef);
    const response = await this.#call("read_base_reference", coordinates, {
      trailingSegments: validatedRef.slice("refs/".length).split("/"),
      signal: options.signal,
    });
    if (response.status === 404) {
      return null;
    }
    this.#expectStatus(response, 200, "read_base_reference");
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
    // The real truncation signal is the Link header, not a full page: a page of
    // exactly PULL_REQUEST_PAGE_SIZE with no next link is complete.
    invariant(
      !response.hasNextPage,
      "GITHUB_RECONCILIATION_AMBIGUOUS",
      "GitHub signalled a further pull request page, so the result may be truncated",
      { status: response.status, responseSha256: response.bodySha256 },
    );
    // GitHub permits many pull requests on one head so long as at most one is
    // open, so "exactly one ever" would deadlock a run permanently after an
    // ordinary close-and-reopen. Prefer the open one, then a merged one, and
    // fail closed only when the choice is genuinely ambiguous.
    const first = selectReconciledPullRequest(response);
    if (first === null) {
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
    const head = asNestedObject(object.head, response, "GitHub pull request head");
    const base = asNestedObject(object.base, response, "GitHub pull request base");
    const title = object.title;
    invariant(
      typeof title === "string" && title.length <= 1024,
      "GITHUB_PROTOCOL_ERROR",
      "GitHub pull request response has an unreadable title",
      { status: response.status, number, responseSha256: response.bodySha256 },
    );
    const body = object.body;
    invariant(
      (typeof body === "string" || body === null) &&
        (body === null || Buffer.byteLength(body, "utf8") <= MAX_PULL_REQUEST_BODY_BYTES * 4),
      "GITHUB_PROTOCOL_ERROR",
      "GitHub pull request response has an unreadable body",
      { status: response.status, number, responseSha256: response.bodySha256 },
    );
    const maintainerCanModify = object.maintainer_can_modify;
    invariant(
      typeof maintainerCanModify === "boolean",
      "GITHUB_PROTOCOL_ERROR",
      "GitHub pull request response has no maintainer-modify flag",
      { status: response.status, number, responseSha256: response.bodySha256 },
    );
    const bodyText = body ?? "";
    return {
      number,
      isDraft,
      isMerged: typeof mergedAt === "string" && mergedAt.length > 0,
      state,
      headRef,
      baseBranch,
      headSha1: readSha(head, response, "GitHub pull request head"),
      baseSha1: readSha(base, response, "GitHub pull request base"),
      titleSha256: sha256Hex(title),
      bodySha256: sha256Hex(bodyText),
      markerCount: countLandingMarkers(bodyText),
      maintainerCanModify,
      // Reconstructed from validated inputs rather than echoed, so no upstream
      // byte reaches the receipt.
      htmlUrl: `https://github.com/${coordinates.owner}/${coordinates.repository}/pull/${number}`,
      responseSha256: response.bodySha256,
      latencyMs: response.latencyMs,
    };
  }
}

const LANDING_MARKER_PREFIX = "<!-- icarus-landing:";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Counts the reserved landing-marker occurrences in a pull-request body. */
function countLandingMarkers(body: string): number {
  let count = 0;
  let index = body.indexOf(LANDING_MARKER_PREFIX);
  while (index !== -1) {
    count += 1;
    index = body.indexOf(LANDING_MARKER_PREFIX, index + LANDING_MARKER_PREFIX.length);
  }
  return count;
}

/**
 * Chooses the pull request a reconciliation read should report. At most one
 * pull request may be open on a head, so an open one is the answer whenever it
 * exists; otherwise a single merged or single closed record still identifies
 * the run's pull request. Anything else is genuinely ambiguous and fails closed.
 */
function selectReconciledPullRequest(response: GithubHttpResponse): unknown {
  const entries = response.value as readonly unknown[];
  const ambiguous = (subject: string): never => {
    throw new GithubGatewayError("GITHUB_RECONCILIATION_AMBIGUOUS", subject, {
      status: response.status,
      responseSha256: response.bodySha256,
    });
  };
  const open = entries.filter((entry) => readStringMember(entry, "state") === "open");
  if (open.length === 1) {
    return open[0];
  }
  if (open.length > 1) {
    return ambiguous("GitHub reported more than one open pull request for this head and base");
  }
  // A non-empty timestamp, matching the `isMerged` reduction the receipt
  // reports. Treating `""` as merged here while the receipt reported it as not
  // merged would let one response produce two contradictory verdicts.
  const merged = entries.filter((entry) => (readStringMember(entry, "merged_at") ?? "").length > 0);
  if (merged.length === 1) {
    return merged[0];
  }
  if (merged.length > 1) {
    return ambiguous("GitHub reported more than one merged pull request for this head and base");
  }
  if (entries.length === 1) {
    return entries[0];
  }
  if (entries.length > 1) {
    return ambiguous("GitHub reported several closed pull requests for this head and base");
  }
  return null;
}

function readStringMember(entry: unknown, member: string): string | null {
  if (typeof entry !== "object" || entry === null) {
    return null;
  }
  const value = (entry as Record<string, unknown>)[member];
  return typeof value === "string" ? value : null;
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
