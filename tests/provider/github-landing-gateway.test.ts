import { describe, expect, it } from "vitest";
import { sha256 } from "../../packages/core/src/digest.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import {
  assertNoLiveGitHubTransport,
  GITHUB_LANDING_REQUEST_TIMEOUT_MS,
  GITHUB_LANDING_RESPONSE_MAX_BYTES,
  GITHUB_LANDING_USER_AGENT,
  GitHubLandingGatewayV1,
  type GitHubLandingTransport,
  type GitHubLandingTransportOutcome,
  type GitHubLandingTransportRequest,
} from "../../packages/core/src/github-landing-gateway.js";
import {
  buildUnsignedCommitPayloadV1,
  canonicalGitHubPostBodyV1,
  commitEpochToGitInstant,
  DERIVATIVE_EFFECTS,
  DERIVATIVE_GITHUB_EVENTS,
  DIRECT_ICARUS_EFFECTS,
  digestLandingRecord,
  GITHUB_API_ORIGIN,
  GITHUB_API_VERSION,
  gitObjectSha1,
  renderPullRequestBodyV1,
  type CandidateObjectManifestV1,
  type GitHubLandingProfileV1,
  type LandingDigestV1,
  type LandingHttpRequestV1,
} from "../../packages/core/src/landing-records.js";
import type {
  LandingHttpKindV1,
  LandingOperationKindV1,
} from "../../packages/core/src/landing-state.js";

const LANDING_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const REVIEW_ID = "44444444-4444-4444-8444-444444444444";
const OPERATION_ID = "55555555-5555-4555-8555-555555555555";
const REQUEST_ID = "66666666-6666-4666-8666-666666666666";
const ACTOR_REQUEST_ID = "77777777-7777-4777-8777-777777777777";
const BASE_REQUEST_ID = "88888888-8888-4888-8888-888888888888";
const POST_READ_REQUEST_ID = "99999999-9999-4999-8999-999999999999";
const BASE_COMMIT = "a".repeat(40);
const BASE_TREE = "b".repeat(40);
const CANDIDATE_TREE = "c".repeat(40);
const COMMIT_EPOCH_SECONDS = 1_700_000_000;
const COMMIT_INSTANT = commitEpochToGitInstant(COMMIT_EPOCH_SECONDS);
const COMMIT_MESSAGE = "Land reviewed change\n";
const PULL_REQUEST_TITLE = "Land reviewed change";
const PULL_REQUEST_BODY_PREFIX = "Automated draft from reviewed evidence.";
const CHANGED_PATH = "src/a.ts";
const CHANGED_CONTENT = Buffer.from("export const answer = 42;\n", "utf8");
const CREDENTIAL = "fake-token-value-never-persist";

const PROFILE: GitHubLandingProfileV1 = {
  version: 1,
  provider: "github",
  owner: "octocat",
  repository: "icarus-target",
  baseBranch: "main",
  branchNamespace: "icarus/",
  credentialRef: { kind: "environment", name: "ICARUS_GITHUB_TOKEN_TEST" },
  expectedActor: "octocat",
  commitIdentity: { name: "Icarus Landing", email: "landing@example.invalid" },
  derivativeEffects: {
    version: 1,
    disposition: "inert-repository",
    evidenceSha256: sha256("inert-repository-assessment"),
  },
};

const COMMIT_PAYLOAD = buildUnsignedCommitPayloadV1({
  candidateTreeSha1: CANDIDATE_TREE,
  baseCommitSha1: BASE_COMMIT,
  commitIdentity: PROFILE.commitIdentity,
  commitEpochSeconds: COMMIT_EPOCH_SECONDS,
  commitMessage: COMMIT_MESSAGE,
});
const CANDIDATE_COMMIT = gitObjectSha1("commit", COMMIT_PAYLOAD);
const BLOB_SHA1 = gitObjectSha1("blob", CHANGED_CONTENT);

const OBJECT_MANIFEST: CandidateObjectManifestV1 = {
  schemaVersion: 1,
  baseCommitSha1: BASE_COMMIT,
  baseTreeSha1: BASE_TREE,
  candidateTreeSha1: CANDIDATE_TREE,
  candidateCommitSha1: CANDIDATE_COMMIT,
  candidateCommitPayloadSha256: sha256(COMMIT_PAYLOAD),
  entries: [
    {
      path: CHANGED_PATH,
      op: "modify",
      mode: "100644",
      blobSha1: BLOB_SHA1,
      contentBytes: CHANGED_CONTENT.byteLength,
      contentSha256: sha256(CHANGED_CONTENT),
    },
  ],
};

const LANDING: LandingDigestV1 = {
  schemaVersion: 1,
  policyVersion: 1,
  githubApiVersion: GITHUB_API_VERSION,
  landingId: LANDING_ID,
  runId: RUN_ID,
  projectId: PROJECT_ID,
  baseCommitSha1: BASE_COMMIT,
  baseTreeSha1: BASE_TREE,
  planSha256: sha256("plan"),
  diffSha256: sha256("diff"),
  checkpointSha256: sha256("checkpoint"),
  verificationSha256: sha256("verification"),
  reviewDecisionId: REVIEW_ID,
  reviewDecisionSha256: sha256("review"),
  changedPaths: [CHANGED_PATH],
  changedPathsSha256: digestLandingRecord({ schemaVersion: 1, paths: [CHANGED_PATH] }),
  candidateCredentialAuditSha256: sha256("credential-audit"),
  profileVersion: 1,
  profileSha256: digestLandingRecord(PROFILE),
  profile: PROFILE,
  objectFormat: "sha1",
  candidateParentSha1: BASE_COMMIT,
  candidateTreeSha1: CANDIDATE_TREE,
  candidateCommitSha1: CANDIDATE_COMMIT,
  candidateCommitPayloadSha256: sha256(COMMIT_PAYLOAD),
  candidateObjectManifestSha256: digestLandingRecord(OBJECT_MANIFEST),
  commitMessageSha256: sha256(COMMIT_MESSAGE),
  commitAuthor: PROFILE.commitIdentity,
  commitCommitter: PROFILE.commitIdentity,
  commitEpochSeconds: COMMIT_EPOCH_SECONDS,
  commitIso8601: COMMIT_INSTANT,
  baseRef: "refs/heads/main",
  expectedRemoteBaseSha1: BASE_COMMIT,
  headRef: `refs/heads/icarus/${RUN_ID}`,
  pullRequestTitleSha256: sha256(PULL_REQUEST_TITLE),
  pullRequestBodyPrefixSha256: sha256(PULL_REQUEST_BODY_PREFIX),
  pullRequestMarkerVersion: 1,
  draft: true,
  maintainerCanModify: false,
  directIcarusEffects: DIRECT_ICARUS_EFFECTS,
  derivativeEffectDisclosure: {
    version: 1,
    githubEvents: DERIVATIVE_GITHUB_EVENTS,
    mayTrigger: DERIVATIVE_EFFECTS,
    disposition: PROFILE.derivativeEffects.disposition,
    evidenceSha256: PROFILE.derivativeEffects.evidenceSha256,
  },
};

const TEXT = {
  commitMessage: COMMIT_MESSAGE,
  pullRequestTitle: PULL_REQUEST_TITLE,
  pullRequestBodyPrefix: PULL_REQUEST_BODY_PREFIX,
};

const MATERIAL = {
  landing: LANDING,
  profile: PROFILE,
  objectManifest: OBJECT_MANIFEST,
  text: TEXT,
  changedBlobs: [{ path: CHANGED_PATH, content: CHANGED_CONTENT }],
};

const TREE_BODY = {
  base_tree: BASE_TREE,
  tree: [{ path: CHANGED_PATH, mode: "100644" as const, type: "blob" as const, sha: BLOB_SHA1 }],
};
const COMMIT_BODY = {
  message: COMMIT_MESSAGE,
  tree: CANDIDATE_TREE,
  parents: [BASE_COMMIT] as const,
  author: { ...PROFILE.commitIdentity, date: COMMIT_INSTANT },
  committer: { ...PROFILE.commitIdentity, date: COMMIT_INSTANT },
};
const PULL_REQUEST_BODY = renderPullRequestBodyV1({
  landing: LANDING,
  landingSha256: digestLandingRecord(LANDING),
  bodyPrefix: PULL_REQUEST_BODY_PREFIX,
});
const PULL_REQUEST_POST_BODY = {
  title: PULL_REQUEST_TITLE,
  head: `${PROFILE.owner}:icarus/${RUN_ID}`,
  base: PROFILE.baseBranch,
  body: PULL_REQUEST_BODY,
  draft: true as const,
  maintainer_can_modify: false as const,
};

function operationKindFor(kind: LandingHttpKindV1): LandingOperationKindV1 {
  if (kind === "github.blob.post" || kind === "github.tree.post" || kind === "github.commit.post") {
    return "github.objects.upload";
  }
  if (kind === "github.ref.post") return "github.ref.create";
  if (kind === "github.pull_request.post") return "github.pull_request.create";
  return "github.preflight";
}

function requestFor(
  kind: LandingHttpKindV1,
  options: {
    readonly requestId?: string;
    readonly operationKind?: LandingOperationKindV1;
    readonly requestOrdinal?: number;
  } = {},
): LandingHttpRequestV1 {
  let subject: LandingHttpRequestV1["subject"];
  let bodySha256: string | null = null;
  switch (kind) {
    case "github.actor.get":
      subject = { expectedActor: PROFILE.expectedActor };
      break;
    case "github.base_ref.get":
      subject = {
        owner: PROFILE.owner,
        repository: PROFILE.repository,
        baseRef: LANDING.baseRef,
        expectedSha1: BASE_COMMIT,
      };
      break;
    case "github.head_ref.get":
      subject = {
        owner: PROFILE.owner,
        repository: PROFILE.repository,
        headRef: LANDING.headRef,
        expectedSha1: CANDIDATE_COMMIT,
      };
      break;
    case "github.pull_requests.get":
      subject = {
        owner: PROFILE.owner,
        repository: PROFILE.repository,
        headOwner: PROFILE.owner,
        headRef: `icarus/${RUN_ID}`,
        baseBranch: PROFILE.baseBranch,
        state: "all",
        page: 1,
        perPage: 100,
      };
      break;
    case "github.blob.post": {
      const body = { content: CHANGED_CONTENT.toString("base64"), encoding: "base64" as const };
      bodySha256 = canonicalGitHubPostBodyV1(kind, body).sha256;
      subject = {
        pathSha256: sha256(CHANGED_PATH),
        contentBytes: CHANGED_CONTENT.byteLength,
        contentSha256: sha256(CHANGED_CONTENT),
        expectedBlobSha1: BLOB_SHA1,
      };
      break;
    }
    case "github.tree.post":
      bodySha256 = canonicalGitHubPostBodyV1(kind, TREE_BODY).sha256;
      subject = {
        baseTreeSha1: BASE_TREE,
        entriesSha256: digestLandingRecord(TREE_BODY.tree),
        expectedTreeSha1: CANDIDATE_TREE,
      };
      break;
    case "github.commit.post":
      bodySha256 = canonicalGitHubPostBodyV1(kind, COMMIT_BODY).sha256;
      subject = {
        candidateTreeSha1: CANDIDATE_TREE,
        baseCommitSha1: BASE_COMMIT,
        candidateCommitPayloadSha256: sha256(COMMIT_PAYLOAD),
        expectedCommitSha1: CANDIDATE_COMMIT,
        commitIso8601: COMMIT_INSTANT,
      };
      break;
    case "github.ref.post": {
      const body = { ref: LANDING.headRef, sha: CANDIDATE_COMMIT };
      bodySha256 = canonicalGitHubPostBodyV1(kind, body).sha256;
      subject = {
        baseRef: LANDING.baseRef,
        expectedRemoteBaseSha1: BASE_COMMIT,
        headRef: LANDING.headRef,
        candidateCommitSha1: CANDIDATE_COMMIT,
      };
      break;
    }
    case "github.pull_request.post":
      bodySha256 = canonicalGitHubPostBodyV1(kind, PULL_REQUEST_POST_BODY).sha256;
      subject = {
        baseRef: LANDING.baseRef,
        expectedRemoteBaseSha1: BASE_COMMIT,
        headRef: LANDING.headRef,
        candidateCommitSha1: CANDIDATE_COMMIT,
        pullRequestTitleSha256: sha256(PULL_REQUEST_TITLE),
        pullRequestBodySha256: sha256(PULL_REQUEST_BODY),
        draft: true,
        maintainerCanModify: false,
      };
      break;
  }
  return {
    schemaVersion: 1,
    requestId: options.requestId ?? REQUEST_ID,
    landingId: LANDING_ID,
    operationId: OPERATION_ID,
    coordinatorAttempt: 1,
    operationKind: options.operationKind ?? operationKindFor(kind),
    requestOrdinal: options.requestOrdinal ?? 1,
    kind,
    method: kind.endsWith(".get") ? "GET" : "POST",
    profileSha256: LANDING.profileSha256,
    bodySha256,
    subject,
  };
}

function admitted(request: LandingHttpRequestV1) {
  return { request, landingSha256: digestLandingRecord(LANDING) };
}

function jsonResponse(
  status: number,
  value: unknown,
  extraHeaders: readonly (readonly [string, string])[] = [],
): GitHubLandingTransportOutcome {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  return {
    kind: "response",
    status,
    headers: [
      ["content-type", "application/json; charset=utf-8"],
      ["content-length", String(body.byteLength)],
      ...extraHeaders,
    ],
    body,
  };
}

function pullRequestResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 17,
    state: "open",
    draft: true,
    title: PULL_REQUEST_TITLE,
    body: PULL_REQUEST_BODY,
    maintainer_can_modify: false,
    head: {
      ref: `icarus/${RUN_ID}`,
      sha: CANDIDATE_COMMIT,
      repo: { name: "ICARUS-TARGET", owner: { login: "OctoCat" } },
    },
    base: {
      ref: "main",
      sha: BASE_COMMIT,
      repo: { name: "Icarus-Target", owner: { login: "OCTOCAT" } },
    },
    ...overrides,
  };
}

class FakeTransport implements GitHubLandingTransport {
  readonly calls: GitHubLandingTransportRequest[] = [];
  readonly #outcomes: GitHubLandingTransportOutcome[];

  constructor(...outcomes: GitHubLandingTransportOutcome[]) {
    this.#outcomes = outcomes;
  }

  async dispatch(request: GitHubLandingTransportRequest): Promise<GitHubLandingTransportOutcome> {
    this.calls.push(request);
    const outcome = this.#outcomes.shift();
    if (outcome === undefined) throw new Error("unexpected transport call");
    return outcome;
  }
}

function harness(
  request: LandingHttpRequestV1,
  ...outcomes: GitHubLandingTransportOutcome[]
): {
  readonly gateway: GitHubLandingGatewayV1;
  readonly transport: FakeTransport;
  readonly reads: { request: number; material: number; credential: number };
} {
  const proofOutcomes: GitHubLandingTransportOutcome[] = [];
  if (request.kind !== "github.actor.get") {
    proofOutcomes.push(jsonResponse(200, { login: "OcToCaT" }));
  }
  if (request.kind === "github.head_ref.get") {
    proofOutcomes.push(
      jsonResponse(200, {
        ref: LANDING.baseRef,
        object: { type: "commit", sha: BASE_COMMIT },
      }),
    );
  }
  const transport = new FakeTransport(...proofOutcomes, ...outcomes);
  const reads = { request: 0, material: 0, credential: 0 };
  const gateway = new GitHubLandingGatewayV1({
    transport,
    requestClaimer: {
      async claimAdmitted(requestId) {
        reads.request += 1;
        if (requestId === request.requestId) {
          return admitted(request);
        }
        if (requestId === ACTOR_REQUEST_ID) {
          return admitted(
            requestFor("github.actor.get", {
              requestId: ACTOR_REQUEST_ID,
              operationKind: request.operationKind,
              requestOrdinal: 1,
            }),
          );
        }
        if (requestId === BASE_REQUEST_ID) {
          return admitted(
            requestFor("github.base_ref.get", {
              requestId: BASE_REQUEST_ID,
              operationKind: request.operationKind,
              requestOrdinal: 2,
            }),
          );
        }
        throw new Error("unexpected admitted request ID");
      },
    },
    materialReader: {
      async read(landingId) {
        reads.material += 1;
        expect(landingId).toBe(LANDING_ID);
        return MATERIAL;
      },
    },
    credentialResolver: {
      async resolve(reference) {
        reads.credential += 1;
        expect(reference).toEqual(PROFILE.credentialRef);
        return CREDENTIAL;
      },
    },
  });
  return { gateway, transport, reads };
}

async function proveActor(gateway: GitHubLandingGatewayV1): Promise<void> {
  const exchange = await gateway.executeAdmitted({ requestId: ACTOR_REQUEST_ID });
  expect(exchange.result).toMatchObject({
    kind: "github.actor.get",
    outcome: "succeeded",
    projection: { type: "actor", login: "octocat" },
  });
}

async function proveActorAndBase(gateway: GitHubLandingGatewayV1): Promise<void> {
  await proveActor(gateway);
  const exchange = await gateway.executeAdmitted({ requestId: BASE_REQUEST_ID });
  expect(exchange.result).toMatchObject({
    kind: "github.base_ref.get",
    outcome: "succeeded",
    projection: { type: "ref", state: "direct", sha1: BASE_COMMIT },
  });
}

async function executeTarget(gateway: GitHubLandingGatewayV1, request: LandingHttpRequestV1) {
  if (request.kind === "github.head_ref.get") {
    await proveActorAndBase(gateway);
  } else if (request.kind !== "github.actor.get") {
    await proveActor(gateway);
  }
  return gateway.executeAdmitted({ requestId: request.requestId });
}

describe("deterministic fake GitHub landing gateway", () => {
  it("derives the fixed actor request from a durable admitted row and redacts its digest", async () => {
    const request = requestFor("github.actor.get");
    const fixture = harness(request, jsonResponse(200, { login: "OcToCaT" }));

    const exchange = await executeTarget(fixture.gateway, request);

    expect(exchange.result).toEqual({
      schemaVersion: 1,
      requestId: REQUEST_ID,
      kind: "github.actor.get",
      outcome: "succeeded",
      httpStatus: 200,
      projection: { type: "actor", login: "octocat" },
      errorCode: null,
    });
    expect(fixture.reads).toEqual({ request: 1, material: 1, credential: 1 });
    expect(fixture.transport.calls).toHaveLength(1);
    const wire = fixture.transport.calls.at(-1);
    expect(wire).toMatchObject({
      origin: GITHUB_API_ORIGIN,
      method: "GET",
      path: "/user",
      query: "",
      timeoutMs: GITHUB_LANDING_REQUEST_TIMEOUT_MS,
      responseMaxBytes: GITHUB_LANDING_RESPONSE_MAX_BYTES,
      redirect: "error",
      body: null,
      headers: {
        accept: "application/vnd.github+json",
        contentType: null,
        userAgent: GITHUB_LANDING_USER_AGENT,
        xGitHubApiVersion: GITHUB_API_VERSION,
      },
    });
    expect(wire?.headers.authorization).toBe(`Bearer ${CREDENTIAL}`);
    expect(JSON.stringify(exchange)).not.toContain(CREDENTIAL);

    await expect(fixture.gateway.executeAdmitted({ requestId: REQUEST_ID })).rejects.toMatchObject({
      code: "GITHUB_REQUEST_ALREADY_CLAIMED",
    });
    expect(fixture.transport.calls).toHaveLength(1);

    await expect(
      fixture.gateway.executeAdmitted({ requestId: REQUEST_ID, url: GITHUB_API_ORIGIN } as never),
    ).rejects.toMatchObject({ code: "GITHUB_GATEWAY_ARGUMENT_INVALID" });
    expect(fixture.transport.calls).toHaveLength(1);
  });

  it("claims a request before awaiting storage so concurrent duplicate delivery cannot dispatch", async () => {
    const request = requestFor("github.actor.get");
    const fixture = harness(request, jsonResponse(200, { login: "octocat" }));

    const first = fixture.gateway.executeAdmitted({ requestId: REQUEST_ID });
    await expect(fixture.gateway.executeAdmitted({ requestId: REQUEST_ID })).rejects.toMatchObject({
      code: "GITHUB_REQUEST_ALREADY_CLAIMED",
    });
    expect((await first).result.outcome).toBe("succeeded");
    expect(fixture.transport.calls).toHaveLength(1);
    expect(fixture.reads.request).toBe(1);
  });

  it.each([
    {
      kind: "github.blob.post" as const,
      expectedPath: "/repos/octocat/icarus-target/git/blobs",
      expectedBody: { content: CHANGED_CONTENT.toString("base64"), encoding: "base64" },
      response: { sha: BLOB_SHA1 },
      objectKind: "blob",
      sha1: BLOB_SHA1,
    },
    {
      kind: "github.tree.post" as const,
      expectedPath: "/repos/octocat/icarus-target/git/trees",
      expectedBody: TREE_BODY,
      response: { sha: CANDIDATE_TREE },
      objectKind: "tree",
      sha1: CANDIDATE_TREE,
    },
    {
      kind: "github.commit.post" as const,
      expectedPath: "/repos/octocat/icarus-target/git/commits",
      expectedBody: COMMIT_BODY,
      response: { sha: CANDIDATE_COMMIT },
      objectKind: "commit",
      sha1: CANDIDATE_COMMIT,
    },
    {
      kind: "github.ref.post" as const,
      expectedPath: "/repos/octocat/icarus-target/git/refs",
      expectedBody: { ref: LANDING.headRef, sha: CANDIDATE_COMMIT },
      response: {
        ref: LANDING.headRef,
        object: { type: "commit", sha: CANDIDATE_COMMIT },
      },
      objectKind: "ref",
      sha1: CANDIDATE_COMMIT,
    },
  ])("reconstructs the $kind body only from immutable evidence", async (entry) => {
    const request = requestFor(entry.kind);
    const fixture = harness(request, jsonResponse(201, entry.response));

    const exchange = await executeTarget(fixture.gateway, request);

    expect(exchange.result.projection).toEqual({
      type: "object",
      objectKind: entry.objectKind,
      sha1: entry.sha1,
    });
    const wire = fixture.transport.calls.at(-1);
    expect(wire?.path).toBe(entry.expectedPath);
    expect(wire?.query).toBe("");
    expect(wire?.headers.contentType).toBe("application/json");
    expect(Buffer.from(wire?.body ?? []).toString("utf8")).toBe(
      canonicalGitHubPostBodyV1(entry.kind, entry.expectedBody).body,
    );
  });

  it("reconstructs and verifies the exact draft pull request", async () => {
    const request = requestFor("github.pull_request.post");
    const fixture = harness(request, jsonResponse(201, pullRequestResponse()));

    const exchange = await executeTarget(fixture.gateway, request);

    expect(exchange.result.outcome).toBe("succeeded");
    expect(exchange.result.projection).toMatchObject({
      type: "pull_request",
      number: 17,
      owner: "octocat",
      repository: "icarus-target",
      headOwner: "octocat",
      headRef: `icarus/${RUN_ID}`,
      markerCount: 1,
    });
    expect(Buffer.from(fixture.transport.calls.at(-1)?.body ?? []).toString("utf8")).toBe(
      canonicalGitHubPostBodyV1("github.pull_request.post", PULL_REQUEST_POST_BODY).body,
    );
  });

  it.each([
    {
      name: "server uncertainty",
      request: requestFor("github.blob.post"),
      response: jsonResponse(503, { message: "unavailable" }),
      outcome: "ambiguous",
      errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
    },
    {
      name: "unverifiable success projection",
      request: requestFor("github.blob.post"),
      response: jsonResponse(201, { sha: "e".repeat(40) }),
      outcome: "ambiguous",
      errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
    },
    {
      name: "ref conflict",
      request: requestFor("github.ref.post"),
      response: jsonResponse(409, { message: "Reference already exists" }),
      outcome: "failed",
      errorCode: "GITHUB_REF_CONFLICT",
    },
    {
      name: "pull-request conflict",
      request: requestFor("github.pull_request.post"),
      response: jsonResponse(422, { message: "Validation Failed" }),
      outcome: "failed",
      errorCode: "GITHUB_PULL_REQUEST_CONFLICT",
    },
  ])("maps mutating $name without granting an automatic retry", async (entry) => {
    const fixture = harness(entry.request, entry.response);

    const exchange = await executeTarget(fixture.gateway, entry.request);

    expect(exchange.result).toMatchObject({
      outcome: entry.outcome,
      projection: null,
      errorCode: entry.errorCode,
    });
    if (entry.outcome === "ambiguous") {
      expect(exchange.result.httpStatus).toBeNull();
    } else {
      expect(exchange.result.httpStatus).toBeGreaterThanOrEqual(400);
    }
    expect(fixture.transport.calls).toHaveLength(2);
  });

  it("treats only the accepted exact head-ref 404 as semantic absence", async () => {
    const notFound = {
      message: "Not Found",
      documentation_url: "https://docs.github.com/rest/git/refs#get-a-reference",
      status: "404",
    };
    const head = harness(requestFor("github.head_ref.get"), jsonResponse(404, notFound));
    const headRequest = requestFor("github.head_ref.get");
    const headResult = await executeTarget(head.gateway, headRequest);
    expect(headResult.result).toMatchObject({
      outcome: "succeeded",
      httpStatus: 404,
      projection: { type: "ref", state: "absent", ref: LANDING.headRef, sha1: null },
      errorCode: null,
    });
    expect(head.transport.calls.at(-1)?.path).toBe(
      `/repos/octocat/icarus-target/git/ref/heads/icarus/${RUN_ID}`,
    );

    const base = harness(requestFor("github.base_ref.get"), jsonResponse(404, notFound));
    const baseRequest = requestFor("github.base_ref.get");
    expect((await executeTarget(base.gateway, baseRequest)).result).toMatchObject({
      outcome: "failed",
      httpStatus: 404,
      projection: null,
      errorCode: "GITHUB_NOT_FOUND_OR_PERMISSION_DENIED",
    });

    const malformed = harness(
      requestFor("github.head_ref.get"),
      jsonResponse(404, { ...notFound, repository: PROFILE.repository }),
    );
    expect((await executeTarget(malformed.gateway, headRequest)).result.outcome).toBe("failed");
  });

  it("normalizes owner identities but keeps refs case-sensitive and fails the whole list", async () => {
    const request = requestFor("github.pull_requests.get");
    const exact = harness(request, jsonResponse(200, [pullRequestResponse()]));
    const exactResult = await executeTarget(exact.gateway, request);
    expect(exactResult.result.projection).toMatchObject({
      type: "pull_request_list",
      complete: true,
      count: 1,
      objects: [{ owner: "octocat", repository: "icarus-target" }],
    });
    expect(exact.transport.calls.at(-1)).toMatchObject({
      path: "/repos/octocat/icarus-target/pulls",
      query: `state=all&head=octocat%3Aicarus%2F${RUN_ID}&base=main&page=1&per_page=100`,
    });

    const drifted = pullRequestResponse({
      head: {
        ref: `Icarus/${RUN_ID}`,
        sha: CANDIDATE_COMMIT,
        repo: { name: "icarus-target", owner: { login: "octocat" } },
      },
    });
    const mismatch = harness(request, jsonResponse(200, [pullRequestResponse(), drifted]));
    expect((await executeTarget(mismatch.gateway, request)).result).toMatchObject({
      outcome: "failed",
      projection: null,
      errorCode: "GITHUB_IDENTITY_MISMATCH",
    });

    const paged = harness(
      request,
      jsonResponse(
        200,
        [],
        [["link", '<https://api.github.com/repositories/1/pulls?page=2>; rel="next"']],
      ),
    );
    expect((await executeTarget(paged.gateway, request)).result.projection).toEqual({
      type: "pull_request_list",
      complete: false,
      count: 0,
      objects: [],
    });
  });

  it("pins one actor-proved credential through ambiguous mutation post-reads, then drops it", async () => {
    const operationKind = "github.pull_request.create" as const;
    const actorRequest = requestFor("github.actor.get", {
      requestId: ACTOR_REQUEST_ID,
      operationKind,
      requestOrdinal: 1,
    });
    const baseRequest = requestFor("github.base_ref.get", {
      requestId: BASE_REQUEST_ID,
      operationKind,
      requestOrdinal: 2,
    });
    const postRequest = requestFor("github.pull_request.post", {
      operationKind,
      requestOrdinal: 5,
    });
    const postReadRequest = requestFor("github.head_ref.get", {
      requestId: POST_READ_REQUEST_ID,
      operationKind,
      requestOrdinal: 6,
    });
    const requests = new Map(
      [actorRequest, baseRequest, postRequest, postReadRequest].map((request) => [
        request.requestId,
        admitted(request),
      ]),
    );
    const transport = new FakeTransport(
      jsonResponse(200, { login: "OctoCat" }),
      jsonResponse(200, {
        ref: LANDING.baseRef,
        object: { type: "commit", sha: BASE_COMMIT },
      }),
      { kind: "failure", phase: "after_dispatch", reason: "timeout" },
      jsonResponse(200, {
        ref: LANDING.headRef,
        object: { type: "commit", sha: CANDIDATE_COMMIT },
      }),
    );
    let credentialReads = 0;
    const gateway = new GitHubLandingGatewayV1({
      transport,
      requestClaimer: {
        async claimAdmitted(requestId) {
          const request = requests.get(requestId);
          if (request === undefined) throw new Error("unknown admitted request");
          return request;
        },
      },
      materialReader: {
        async read() {
          return MATERIAL;
        },
      },
      credentialResolver: {
        async resolve() {
          credentialReads += 1;
          return credentialReads === 1 ? CREDENTIAL : "rotated-token-that-must-not-be-used";
        },
      },
    });

    await gateway.executeAdmitted({ requestId: ACTOR_REQUEST_ID });
    await gateway.executeAdmitted({ requestId: BASE_REQUEST_ID });
    const ambiguous = await gateway.executeAdmitted({ requestId: REQUEST_ID });
    expect(ambiguous.result).toMatchObject({
      outcome: "ambiguous",
      errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
    });
    const postRead = await gateway.executeAdmitted({ requestId: POST_READ_REQUEST_ID });
    expect(postRead.result).toMatchObject({
      outcome: "succeeded",
      projection: { type: "ref", state: "direct", sha1: CANDIDATE_COMMIT },
    });
    expect(credentialReads).toBe(1);
    expect(
      transport.calls.every((request) => request.headers.authorization === `Bearer ${CREDENTIAL}`),
    ).toBe(true);

    gateway.closeOperation();
    await expect(gateway.executeAdmitted({ requestId: ACTOR_REQUEST_ID })).rejects.toMatchObject({
      code: "GITHUB_OPERATION_SESSION_CLOSED",
    });
  });

  it("requires same-operation actor and exact-base proof before head-ref absence", async () => {
    const actorRequest = requestFor("github.actor.get", {
      requestId: ACTOR_REQUEST_ID,
      operationKind: "github.preflight",
    });
    const headRequest = requestFor("github.head_ref.get");
    const transport = new FakeTransport(
      jsonResponse(200, { login: "octocat" }),
      jsonResponse(404, {
        message: "Not Found",
        documentation_url: "https://docs.github.com/rest/git/refs#get-a-reference",
        status: "404",
      }),
    );
    const gateway = new GitHubLandingGatewayV1({
      transport,
      requestClaimer: {
        async claimAdmitted(requestId) {
          if (requestId === ACTOR_REQUEST_ID) return admitted(actorRequest);
          if (requestId === REQUEST_ID) return admitted(headRequest);
          throw new Error("unknown admitted request");
        },
      },
      materialReader: {
        async read() {
          return MATERIAL;
        },
      },
      credentialResolver: {
        async resolve() {
          return CREDENTIAL;
        },
      },
    });

    await gateway.executeAdmitted({ requestId: ACTOR_REQUEST_ID });
    await expect(gateway.executeAdmitted({ requestId: REQUEST_ID })).rejects.toMatchObject({
      code: "GITHUB_BASE_PROOF_REQUIRED",
    });
    expect(transport.calls).toHaveLength(1);
    gateway.closeOperation();
  });

  it("rejects a corrupt immutable POST binding before credential resolution", async () => {
    const request = { ...requestFor("github.blob.post"), bodySha256: sha256("corrupt") };
    const transport = new FakeTransport(jsonResponse(201, { sha: BLOB_SHA1 }));
    let credentialReads = 0;
    const gateway = new GitHubLandingGatewayV1({
      transport,
      requestClaimer: {
        async claimAdmitted() {
          return admitted(request);
        },
      },
      materialReader: {
        async read() {
          return MATERIAL;
        },
      },
      credentialResolver: {
        async resolve() {
          credentialReads += 1;
          return CREDENTIAL;
        },
      },
    });

    await expect(gateway.executeAdmitted({ requestId: REQUEST_ID })).rejects.toMatchObject({
      code: "GITHUB_GATEWAY_ARGUMENT_INVALID",
    });
    expect(credentialReads).toBe(0);
    expect(transport.calls).toHaveLength(0);
  });

  it("maps timeout phase without retrying an uncertain mutation", async () => {
    const request = requestFor("github.pull_request.post");
    const before = harness(request, {
      kind: "failure",
      phase: "before_dispatch",
      reason: "timeout",
    });
    expect((await executeTarget(before.gateway, request)).result).toMatchObject({
      outcome: "failed",
      httpStatus: null,
      errorCode: "GITHUB_REQUEST_TIMEOUT",
    });
    expect(before.transport.calls).toHaveLength(2);

    const after = harness(request, {
      kind: "failure",
      phase: "after_dispatch",
      reason: "timeout",
    });
    expect((await executeTarget(after.gateway, request)).result).toMatchObject({
      outcome: "ambiguous",
      httpStatus: null,
      errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
    });
    expect(after.transport.calls).toHaveLength(2);
  });

  it("uses status-only v1 rate classification and ignores retry headers as authority", async () => {
    const permission = harness(
      requestFor("github.actor.get"),
      jsonResponse(403, { message: "forbidden" }, [
        ["x-ratelimit-remaining", "0"],
        ["retry-after", "1"],
        ["retry-after", "999999"],
      ]),
    );
    expect(
      (await permission.gateway.executeAdmitted({ requestId: REQUEST_ID })).result.errorCode,
    ).toBe("GITHUB_PERMISSION_DENIED");
    expect(permission.transport.calls).toHaveLength(1);

    const limited = harness(
      requestFor("github.actor.get"),
      jsonResponse(429, { message: "slow down" }, [["retry-after", "3600"]]),
    );
    expect(
      (await limited.gateway.executeAdmitted({ requestId: REQUEST_ID })).result.errorCode,
    ).toBe("GITHUB_RATE_LIMITED");
    expect(limited.transport.calls).toHaveLength(1);
  });

  it("settles malformed, duplicate, and oversized provider responses as bounded failures", async () => {
    const duplicateBody = Buffer.from('{"login":"octocat","login":"attacker"}', "utf8");
    const duplicate = harness(requestFor("github.actor.get"), {
      kind: "response",
      status: 200,
      headers: [
        ["content-type", "application/json"],
        ["content-length", String(duplicateBody.byteLength)],
      ],
      body: duplicateBody,
    });
    expect(
      (await duplicate.gateway.executeAdmitted({ requestId: REQUEST_ID })).result,
    ).toMatchObject({
      outcome: "failed",
      errorCode: "GITHUB_PROTOCOL_ERROR",
    });

    const wrongLength = harness(requestFor("github.actor.get"), {
      kind: "response",
      status: 200,
      headers: [
        ["content-type", "application/json"],
        ["content-length", "1"],
      ],
      body: Buffer.from('{"login":"octocat"}', "utf8"),
    });
    expect(
      (await wrongLength.gateway.executeAdmitted({ requestId: REQUEST_ID })).result.errorCode,
    ).toBe("GITHUB_PROTOCOL_ERROR");

    const oversized = harness(requestFor("github.actor.get"), {
      kind: "response",
      status: 200,
      headers: [["content-type", "application/json"]],
      body: new Uint8Array(GITHUB_LANDING_RESPONSE_MAX_BYTES + 1),
    });
    const oversizedExchange = await oversized.gateway.executeAdmitted({ requestId: REQUEST_ID });
    expect(oversizedExchange.responseBodySha256).toBeNull();
    expect(oversizedExchange.result.errorCode).toBe("GITHUB_RESPONSE_TOO_LARGE");
  });

  it("fails closed before transport on missing durable authority or invalid material", async () => {
    const request = requestFor("github.actor.get");
    const transport = new FakeTransport(jsonResponse(200, { login: "octocat" }));
    const unavailable = new GitHubLandingGatewayV1({
      transport,
      requestClaimer: {
        async claimAdmitted() {
          throw new Error("missing");
        },
      },
      materialReader: {
        async read() {
          return MATERIAL;
        },
      },
      credentialResolver: {
        async resolve() {
          return CREDENTIAL;
        },
      },
    });
    await expect(unavailable.executeAdmitted({ requestId: REQUEST_ID })).rejects.toMatchObject({
      code: "GITHUB_ADMITTED_REQUEST_UNAVAILABLE",
    });
    expect(transport.calls).toHaveLength(0);

    const invalidMaterial = new GitHubLandingGatewayV1({
      transport,
      requestClaimer: {
        async claimAdmitted() {
          return { request, landingSha256: digestLandingRecord(LANDING) };
        },
      },
      materialReader: {
        async read() {
          return { ...MATERIAL, landing: { ...LANDING, diffSha256: sha256("changed") } };
        },
      },
      credentialResolver: {
        async resolve() {
          return CREDENTIAL;
        },
      },
    });
    await expect(invalidMaterial.executeAdmitted({ requestId: REQUEST_ID })).rejects.toMatchObject({
      code: "GITHUB_GATEWAY_MATERIAL_INVALID",
    });
    expect(transport.calls).toHaveLength(0);
  });

  it("does not expose a live GitHub transport", () => {
    expect(() => assertNoLiveGitHubTransport()).toThrowError(IcarusError);
    expect(() => assertNoLiveGitHubTransport()).toThrow(/no live GitHub transport/i);
  });
});
