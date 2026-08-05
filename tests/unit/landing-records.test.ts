import { describe, expect, it } from "vitest";
import { sha256 } from "../../packages/core/src/digest.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import {
  assertGitBranchName,
  assertLandingCredentialEnvironmentAllowed,
  assertLandingCredentialEnvironmentName,
  assertLandingDigestTextBindingsV1,
  buildUnsignedCommitPayloadV1,
  buildVerificationDigestV1,
  type CandidateCredentialAuditV1,
  type CandidateObjectManifestV1,
  type ChangedPathsDigestV1,
  canonicalGitHubPostBodyV1,
  canonicalizeCommitMessage,
  canonicalizePullRequestBodyPrefix,
  canonicalizePullRequestTitle,
  canonicalLandingJson,
  commitEpochToGitInstant,
  DERIVATIVE_EFFECTS,
  DERIVATIVE_GITHUB_EVENTS,
  DIRECT_ICARUS_EFFECTS,
  decodeCandidateCredentialAuditV1,
  decodeCandidateObjectManifestV1,
  decodeCanonicalLandingEventPayloadJsonV1,
  decodeCanonicalLandingJson,
  decodeCanonicalLandingOperationObservationJsonV1,
  decodeCanonicalLandingOperationResultJsonV1,
  decodeCanonicalLocalRefFactJsonV1,
  decodeChangedPathsDigestV1,
  decodeGitHubLandingProfileV1,
  decodeGitHubPostBodyV1,
  decodeLandingDecisionV1,
  decodeLandingDigestV1,
  decodeLandingEventPayloadV1,
  decodeLandingHttpRequestV1,
  decodeLandingOperationObservationV1,
  decodeLandingOperationRequestV1,
  decodeLandingOperationResultV1,
  decodeLocalRefFactV1,
  decodePullRequestProjectionV1,
  decodeReviewDecisionDigestV1,
  decodeVerificationDigestV1,
  digestLandingRecord,
  type GitHubLandingProfileV1,
  gitObjectSha1,
  type LandingDigestV1,
  landingPullRequestMarkerV1,
  reconstructPullRequestUrlV1,
  renderPullRequestBodyV1,
} from "../../packages/core/src/landing-records.js";
import type { CheckProfile, VerificationEvidence } from "../../packages/core/src/types.js";

const LANDING_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const REVIEW_ID = "44444444-4444-4444-8444-444444444444";
const OPERATION_ID = "55555555-5555-4555-8555-555555555555";
const REQUEST_ID = "66666666-6666-4666-8666-666666666666";
const BASE_COMMIT = "a".repeat(40);
const BASE_TREE = "b".repeat(40);
const CANDIDATE_TREE = "c".repeat(40);
const CANDIDATE_COMMIT = "d".repeat(40);
const COMMIT_EPOCH_SECONDS = 1_700_000_000;
const COMMIT_INSTANT = commitEpochToGitInstant(COMMIT_EPOCH_SECONDS);
const CHANGED_PATHS = ["src/a.ts", "src/b.ts"] as const;
const COMMIT_MESSAGE = "Land reviewed change\n";
const PULL_REQUEST_TITLE = "Land reviewed change";
const PULL_REQUEST_BODY_PREFIX = "Automated draft from reviewed evidence.";

const PROFILE: GitHubLandingProfileV1 = {
  version: 1,
  provider: "github",
  owner: "octocat",
  repository: "icarus-target",
  baseBranch: "main",
  branchNamespace: "icarus/",
  credentialRef: {
    kind: "environment",
    name: "ICARUS_GITHUB_TOKEN_TEST",
  },
  expectedActor: "octocat",
  commitIdentity: {
    name: "Icarus Landing",
    email: "landing@example.invalid",
  },
  derivativeEffects: {
    version: 1,
    disposition: "inert-repository",
    evidenceSha256: sha256("inert-repository-assessment"),
  },
};

const CHANGED_PATHS_RECORD: ChangedPathsDigestV1 = {
  schemaVersion: 1,
  paths: CHANGED_PATHS,
};

const LANDING: LandingDigestV1 = {
  schemaVersion: 1,
  policyVersion: 1,
  githubApiVersion: "2026-03-10",
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
  changedPaths: CHANGED_PATHS,
  changedPathsSha256: digestLandingRecord(CHANGED_PATHS_RECORD),
  candidateCredentialAuditSha256: sha256("credential-audit"),
  profileVersion: 1,
  profileSha256: digestLandingRecord(PROFILE),
  profile: PROFILE,
  objectFormat: "sha1",
  candidateParentSha1: BASE_COMMIT,
  candidateTreeSha1: CANDIDATE_TREE,
  candidateCommitSha1: CANDIDATE_COMMIT,
  candidateCommitPayloadSha256: sha256("commit-payload"),
  candidateObjectManifestSha256: sha256("object-manifest"),
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

function expectIcarusCode(action: () => unknown, code = "LANDING_RECORD_INVALID"): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(IcarusError);
    expect((error as IcarusError).code).toBe(code);
  }
}

type MutableJson =
  | null
  | boolean
  | number
  | string
  | MutableJson[]
  | { [key: string]: MutableJson };

function mutateEveryLeaf(
  value: MutableJson,
  path = "$",
): readonly { readonly path: string; readonly value: MutableJson }[] {
  if (value === null) return [{ path, value: "mutated-null" }];
  if (typeof value === "boolean") return [{ path, value: !value }];
  if (typeof value === "number") return [{ path, value: value + 1 }];
  if (typeof value === "string") return [{ path, value: `${value}#` }];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      mutateEveryLeaf(entry, `${path}[${index}]`).map((mutation) => {
        const changed = [...value];
        changed[index] = mutation.value;
        return { path: mutation.path, value: changed };
      }),
    );
  }
  return Object.entries(value).flatMap(([key, entry]) =>
    mutateEveryLeaf(entry, `${path}.${key}`).map((mutation) => ({
      path: mutation.path,
      value: { ...value, [key]: mutation.value },
    })),
  );
}

describe("landing v1 canonical records", () => {
  it("serializes ASCII-sorted exact JSON and hashes those exact bytes", () => {
    const value = { z: 1, A: 2, nested: [null, true, "é"] };
    const encoded = '{"A":2,"nested":[null,true,"é"],"z":1}';

    expect(canonicalLandingJson(value)).toBe(encoded);
    expect(digestLandingRecord(value)).toBe(sha256(encoded));
    expect(decodeCanonicalLandingJson(encoded, (decoded) => decoded)).toEqual(value);
  });

  it("rejects noncanonical persisted bytes and non-JSON values", () => {
    for (const encoded of [
      '{"z":1,"A":2,"nested":[null,true,"é"]}',
      '{ "A":2,"nested":[null,true,"é"],"z":1}',
      '{"A":2,"A":2,"nested":[null,true,"é"],"z":1}',
      '{"A":2,"nested":[null,true,"é"],"z":1}\n',
      '\uFEFF{"A":2,"nested":[null,true,"é"],"z":1}',
      '{"value":-0}',
    ]) {
      expectIcarusCode(() => decodeCanonicalLandingJson(encoded, (decoded) => decoded));
    }
    expectIcarusCode(() => canonicalLandingJson({ unsafe: Number.MAX_SAFE_INTEGER + 1 }));
    expectIcarusCode(() => canonicalLandingJson({ malformed: "\ud800" }));
    expectIcarusCode(() => canonicalLandingJson({ missing: undefined }));
  });

  it("strictly decodes the persisted profile and applies the startup allowlist separately", () => {
    expect(decodeGitHubLandingProfileV1(PROFILE)).toEqual(PROFILE);
    expect(() =>
      assertLandingCredentialEnvironmentAllowed(PROFILE, new Set(["ICARUS_GITHUB_TOKEN_TEST"])),
    ).not.toThrow();
    expectIcarusCode(
      () => assertLandingCredentialEnvironmentAllowed(PROFILE, new Set()),
      "LANDING_CREDENTIAL_NOT_ALLOWED",
    );

    expectIcarusCode(() => decodeGitHubLandingProfileV1({ ...PROFILE, owner: "Octocat" }));
    expectIcarusCode(() =>
      decodeGitHubLandingProfileV1({ ...PROFILE, credentialRef: { kind: "environment" } }),
    );
    for (const name of [
      "GITHUB_TOKEN",
      "ICARUS_GITHUB_TOKEN",
      "ICARUS_GITHUB_TOKEN_",
      "ICARUS_GITHUB_TOKEN_test",
      "ICARUS_GITHUB_TOKEN_TEST_",
    ]) {
      expectIcarusCode(() =>
        decodeGitHubLandingProfileV1({
          ...PROFILE,
          credentialRef: { kind: "environment", name },
        }),
      );
    }
    expectIcarusCode(() => decodeGitHubLandingProfileV1({ ...PROFILE, origin: "github.com" }));
  });

  it("validates canonical branch names and rejects Git ref ambiguity", () => {
    expect(assertGitBranchName("feature/landing-v1")).toBe("feature/landing-v1");
    for (const value of [
      "/main",
      "main/",
      "main..next",
      "main@{1}",
      "main.lock",
      ".hidden/main",
      "main branch",
    ]) {
      expectIcarusCode(() => assertGitBranchName(value));
    }
  });

  it("applies URL and credential bans to profiles without narrowing provider-derived refs", () => {
    const providerDerivedRef = "release#provider-observed";
    const secret = `sk-${"a".repeat(32)}`;

    expect(assertGitBranchName(providerDerivedRef)).toBe(providerDerivedRef);
    expect(assertGitBranchName(secret)).toBe(secret);

    for (const baseBranch of [
      "https://github.com/octocat/icarus-target",
      "//github.com/octocat/icarus-target",
      "main?owner=octocat",
      providerDerivedRef,
      secret,
    ]) {
      expectIcarusCode(() => decodeGitHubLandingProfileV1({ ...PROFILE, baseBranch }));
    }

    for (const commitIdentity of [
      { ...PROFILE.commitIdentity, name: secret },
      { ...PROFILE.commitIdentity, email: `${secret}@example.invalid` },
    ]) {
      expectIcarusCode(() => decodeGitHubLandingProfileV1({ ...PROFILE, commitIdentity }));
    }
  });

  it("canonicalizes bounded approved text and rejects controls or marker injection", () => {
    expect(canonicalizeCommitMessage("Cafe\u0301\r\nbody")).toBe("Café\nbody\n");
    expect(canonicalizeCommitMessage("one\rtwo\r\nthree\n")).toBe("one\ntwo\nthree\n");
    expect(canonicalizeCommitMessage("message")).toBe("message\n");
    expect(canonicalizeCommitMessage("message\n")).toBe("message\n");
    expect(canonicalizeCommitMessage("message\n\n")).toBe("message\n\n");
    expect(canonicalizePullRequestTitle("Cafe\u0301")).toBe("Café");
    expect(canonicalizePullRequestBodyPrefix("one\r\ntwo")).toBe("one\ntwo");

    expectIcarusCode(() => canonicalizeCommitMessage(" \n "));
    expectIcarusCode(() => canonicalizePullRequestTitle("bad\nheadline"));
    expectIcarusCode(() => canonicalizePullRequestTitle("a".repeat(257)));
    expectIcarusCode(() =>
      canonicalizePullRequestBodyPrefix("operator\n<!-- icarus-landing:v1:forged -->"),
    );
  });

  it("builds the exact unsigned Git commit payload and object identity", () => {
    const payload = buildUnsignedCommitPayloadV1({
      candidateTreeSha1: CANDIDATE_TREE,
      baseCommitSha1: BASE_COMMIT,
      commitIdentity: PROFILE.commitIdentity,
      commitEpochSeconds: COMMIT_EPOCH_SECONDS,
      commitMessage: COMMIT_MESSAGE,
    });

    expect(Buffer.from(payload).toString("utf8")).toBe(
      `tree ${CANDIDATE_TREE}\n` +
        `parent ${BASE_COMMIT}\n` +
        `author Icarus Landing <landing@example.invalid> ${COMMIT_EPOCH_SECONDS} +0000\n` +
        `committer Icarus Landing <landing@example.invalid> ${COMMIT_EPOCH_SECONDS} +0000\n` +
        `\n${COMMIT_MESSAGE}`,
    );
    expect(gitObjectSha1("blob", Buffer.from("hello\n"))).toBe(
      "ce013625030ba8dba906f756967f9e9ca394464a",
    );
    expect(gitObjectSha1("blob", Buffer.from(""))).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(gitObjectSha1("blob", Buffer.from("\n"))).toBe(
      "8b137891791fe96927ad78e64b0aad7bded08bdc",
    );
    expect(sha256(payload)).toBe(
      "622563e7a2a3a90837657c9b1e3a8fea847415a2c3d21009b1305dda22382ead",
    );
    expect(gitObjectSha1("commit", payload)).toBe("314f0aa20d5d793e0a6e5352a182a6d216c17558");
  });

  it("pins the complete landing timestamp domain to exact UTC seconds", () => {
    expect(commitEpochToGitInstant(0)).toBe("1970-01-01T00:00:00Z");
    expect(commitEpochToGitInstant(253_402_300_799)).toBe("9999-12-31T23:59:59Z");
    expectIcarusCode(() => commitEpochToGitInstant(-1));
    expectIcarusCode(() => commitEpochToGitInstant(253_402_300_800));
  });

  it("strictly binds changed paths, review approval, and verification evidence", () => {
    expect(decodeChangedPathsDigestV1(CHANGED_PATHS_RECORD)).toEqual(CHANGED_PATHS_RECORD);
    expectIcarusCode(() =>
      decodeChangedPathsDigestV1({
        schemaVersion: 1,
        paths: [...CHANGED_PATHS].reverse(),
      }),
    );
    expectIcarusCode(() =>
      decodeChangedPathsDigestV1({
        schemaVersion: 1,
        paths: ["src/a.ts", "src/a.ts"],
      }),
    );

    const review = {
      schemaVersion: 1,
      id: REVIEW_ID,
      runId: RUN_ID,
      kind: "review",
      digest: LANDING.diffSha256,
      actor: "operator",
      decision: "approve",
      createdAt: "2026-07-31T12:00:00.000Z",
    };
    expect(decodeReviewDecisionDigestV1(review)).toEqual(review);
    expectIcarusCode(() => decodeReviewDecisionDigestV1({ ...review, decision: "reject" }));

    const registeredChecks: readonly CheckProfile[] = [
      { id: "typecheck", name: "Typecheck", argv: ["pnpm", "typecheck"] },
    ];
    const verification: VerificationEvidence = {
      outcome: "passed",
      changedPaths: CHANGED_PATHS,
      diffSha256: LANDING.diffSha256,
      checkpointSha256: LANDING.checkpointSha256,
      checks: [
        {
          checkId: "typecheck",
          argv: ["pnpm", "typecheck"],
          exitCode: 0,
          signal: null,
          durationMs: 25,
          stdout: "ok\n",
          stderr: "",
          truncated: false,
          outcome: "passed",
        },
      ],
    };
    const digest = buildVerificationDigestV1({
      runId: RUN_ID,
      verification,
      registeredChecks,
    });
    expect(decodeVerificationDigestV1(digest)).toEqual(digest);
    expect(digest.checks[0]).toMatchObject({
      stdoutBytes: 3,
      stdoutSha256: sha256("ok\n"),
      stderrBytes: 0,
      stderrSha256: sha256(""),
    });
    expectIcarusCode(() =>
      buildVerificationDigestV1({
        runId: RUN_ID,
        verification: {
          ...verification,
          checks: verification.checks.map((check) => ({
            ...check,
            argv: ["pnpm", "test"],
          })),
        },
        registeredChecks,
      }),
    );
  });

  it("enforces credential-audit subject and object-manifest null/order grammars", () => {
    const audit: CandidateCredentialAuditV1 = {
      schemaVersion: 1,
      policyVersion: "landing-outgoing-v1",
      outcome: "passed",
      subjects: [
        {
          kind: "changed_blob",
          path: "src/a.ts",
          bytes: 3,
          sha256: sha256("one"),
        },
        {
          kind: "commit_message",
          path: null,
          bytes: Buffer.byteLength(COMMIT_MESSAGE),
          sha256: sha256(COMMIT_MESSAGE),
        },
        {
          kind: "pull_request_title",
          path: null,
          bytes: Buffer.byteLength(PULL_REQUEST_TITLE),
          sha256: sha256(PULL_REQUEST_TITLE),
        },
        {
          kind: "pull_request_body_prefix",
          path: null,
          bytes: Buffer.byteLength(PULL_REQUEST_BODY_PREFIX),
          sha256: sha256(PULL_REQUEST_BODY_PREFIX),
        },
      ],
    };
    expect(decodeCandidateCredentialAuditV1(audit)).toEqual(audit);
    expectIcarusCode(() =>
      decodeCandidateCredentialAuditV1({
        ...audit,
        subjects: [...audit.subjects].reverse(),
      }),
    );

    const manifest: CandidateObjectManifestV1 = {
      schemaVersion: 1,
      baseCommitSha1: BASE_COMMIT,
      baseTreeSha1: BASE_TREE,
      candidateTreeSha1: CANDIDATE_TREE,
      candidateCommitSha1: CANDIDATE_COMMIT,
      candidateCommitPayloadSha256: LANDING.candidateCommitPayloadSha256,
      entries: [
        {
          path: "src/a.ts",
          op: "modify",
          mode: "100644",
          blobSha1: "e".repeat(40),
          contentBytes: 3,
          contentSha256: sha256("one"),
        },
        {
          path: "src/b.ts",
          op: "delete",
          mode: "100644",
          blobSha1: null,
          contentBytes: null,
          contentSha256: null,
        },
      ],
    };
    expect(decodeCandidateObjectManifestV1(manifest)).toEqual(manifest);
    expectIcarusCode(() =>
      decodeCandidateObjectManifestV1({
        ...manifest,
        entries: [manifest.entries[0], { ...manifest.entries[1], contentBytes: 0 }],
      }),
    );
  });

  it("strictly decodes the internally correlated landing authority", () => {
    expect(decodeLandingDigestV1(LANDING)).toEqual(LANDING);
    expectIcarusCode(() =>
      decodeLandingDigestV1({ ...LANDING, expectedRemoteBaseSha1: "e".repeat(40) }),
    );
    expectIcarusCode(() =>
      decodeLandingDigestV1({
        ...LANDING,
        directIcarusEffects: [...DIRECT_ICARUS_EFFECTS].reverse(),
      }),
    );
    expectIcarusCode(() =>
      decodeLandingDigestV1({
        ...LANDING,
        profile: { ...PROFILE, repository: "other" },
      }),
    );
  });

  it("changes the approval digest for every authority leaf without admitting token values", () => {
    const baseline = digestLandingRecord(LANDING);
    const mutations = mutateEveryLeaf(LANDING as unknown as MutableJson);

    expect(mutations.length).toBeGreaterThan(50);
    for (const key of Object.keys(LANDING)) {
      expect(mutations.some((mutation) => mutation.path.startsWith(`$.${key}`))).toBe(true);
    }
    for (const mutation of mutations) {
      expect(digestLandingRecord(mutation.value), mutation.path).not.toBe(baseline);
    }

    const tokenValueSentinel = "PACKET3_CREDENTIAL_VALUE_SENTINEL_DO_NOT_PERSIST";
    expect(canonicalLandingJson(LANDING)).not.toContain(tokenValueSentinel);
    expect(canonicalLandingJson(PROFILE)).not.toContain(tokenValueSentinel);
  });

  it("binds approved text and renders the exact deterministic draft-PR body", () => {
    const landingSha256 = digestLandingRecord(LANDING);
    expect(
      assertLandingDigestTextBindingsV1(LANDING, {
        commitMessage: COMMIT_MESSAGE,
        pullRequestTitle: PULL_REQUEST_TITLE,
        pullRequestBodyPrefix: PULL_REQUEST_BODY_PREFIX,
      }),
    ).toEqual({
      commitMessage: COMMIT_MESSAGE,
      pullRequestTitle: PULL_REQUEST_TITLE,
      pullRequestBodyPrefix: PULL_REQUEST_BODY_PREFIX,
    });
    expectIcarusCode(() =>
      assertLandingDigestTextBindingsV1(LANDING, {
        commitMessage: "different\n",
        pullRequestTitle: PULL_REQUEST_TITLE,
        pullRequestBodyPrefix: PULL_REQUEST_BODY_PREFIX,
      }),
    );

    const marker = `<!-- icarus-landing:v1:${LANDING_ID}:${landingSha256} -->\n`;
    expect(landingPullRequestMarkerV1(LANDING_ID, landingSha256)).toBe(marker);
    expect(
      renderPullRequestBodyV1({
        landing: LANDING,
        landingSha256,
        bodyPrefix: PULL_REQUEST_BODY_PREFIX,
      }),
    ).toBe(
      `${PULL_REQUEST_BODY_PREFIX}\n\n` +
        "Icarus landing evidence v1\n" +
        `run-id: ${RUN_ID}\n` +
        `candidate-commit-sha1: ${CANDIDATE_COMMIT}\n` +
        `plan-sha256: ${LANDING.planSha256}\n` +
        `diff-sha256: ${LANDING.diffSha256}\n` +
        `checkpoint-sha256: ${LANDING.checkpointSha256}\n` +
        "object-format: sha1\n\n" +
        marker,
    );
    expect(reconstructPullRequestUrlV1(PROFILE, 17)).toBe(
      "https://github.com/octocat/icarus-target/pull/17",
    );
  });

  it("strictly decodes operation intent and HTTP request boundaries", () => {
    const landingSha256 = digestLandingRecord(LANDING);
    const candidateOperation = {
      schemaVersion: 1,
      operationId: OPERATION_ID,
      landingId: LANDING_ID,
      coordinatorAttempt: 1,
      kindAttempt: 1,
      kind: "candidate.prepare",
      expectedState: "preparing_candidate",
      expectedVersion: 0,
      input: {
        profileSha256: LANDING.profileSha256,
        baseCommitSha1: BASE_COMMIT,
        baseTreeSha1: BASE_TREE,
        planSha256: LANDING.planSha256,
        diffSha256: LANDING.diffSha256,
        checkpointSha256: LANDING.checkpointSha256,
        verificationSha256: LANDING.verificationSha256,
        reviewDecisionSha256: LANDING.reviewDecisionSha256,
        changedPathsSha256: LANDING.changedPathsSha256,
        headRef: LANDING.headRef,
        commitMessageSha256: LANDING.commitMessageSha256,
        commitEpochSeconds: COMMIT_EPOCH_SECONDS,
        commitIso8601: COMMIT_INSTANT,
        pullRequestTitleSha256: LANDING.pullRequestTitleSha256,
        pullRequestBodyPrefixSha256: LANDING.pullRequestBodyPrefixSha256,
      },
    };
    expect(decodeLandingOperationRequestV1(candidateOperation)).toEqual(candidateOperation);
    expectIcarusCode(() =>
      decodeLandingOperationRequestV1({
        ...candidateOperation,
        input: { ...candidateOperation.input, unknownSha256: sha256("unknown") },
      }),
    );

    const operation = {
      schemaVersion: 1,
      operationId: OPERATION_ID,
      landingId: LANDING_ID,
      coordinatorAttempt: 1,
      kindAttempt: 1,
      kind: "local_ref.create",
      expectedState: "approved",
      expectedVersion: 2,
      input: {
        landingSha256,
        headRef: LANDING.headRef,
        candidateCommitSha1: CANDIDATE_COMMIT,
      },
    };
    expect(decodeLandingOperationRequestV1(operation)).toEqual(operation);
    expectIcarusCode(() =>
      decodeLandingOperationRequestV1({ ...operation, expectedState: "local_ready" }),
    );
    expectIcarusCode(() =>
      decodeLandingOperationRequestV1({
        ...operation,
        input: { ...operation.input, url: "https://api.github.com" },
      }),
    );

    const getRequest = {
      schemaVersion: 1,
      requestId: REQUEST_ID,
      landingId: LANDING_ID,
      operationId: OPERATION_ID,
      coordinatorAttempt: 1,
      operationKind: "github.preflight",
      requestOrdinal: 1,
      kind: "github.actor.get",
      method: "GET",
      profileSha256: LANDING.profileSha256,
      bodySha256: null,
      subject: { expectedActor: "octocat" },
    };
    expect(decodeLandingHttpRequestV1(getRequest)).toEqual(getRequest);
    expectIcarusCode(() =>
      decodeLandingHttpRequestV1({
        ...getRequest,
        method: "POST",
        bodySha256: sha256("body"),
      }),
    );
    expectIcarusCode(() =>
      decodeLandingHttpRequestV1({
        ...getRequest,
        operationKind: "candidate.prepare",
      }),
    );
  });

  it("closes and canonicalizes each GitHub POST wire value", () => {
    const blob = { content: "aGVsbG8=", encoding: "base64" };
    expect(decodeGitHubPostBodyV1("github.blob.post", blob)).toEqual(blob);
    expect(canonicalGitHubPostBodyV1("github.blob.post", blob)).toEqual({
      value: blob,
      body: '{"content":"aGVsbG8=","encoding":"base64"}',
      sha256: sha256('{"content":"aGVsbG8=","encoding":"base64"}'),
    });
    expectIcarusCode(() =>
      decodeGitHubPostBodyV1("github.blob.post", {
        content: "aGVsbG8",
        encoding: "base64",
      }),
    );

    const tree = {
      base_tree: BASE_TREE,
      tree: [
        { path: "src/a.ts", mode: "100644", type: "blob", sha: "e".repeat(40) },
        { path: "src/b.ts", mode: "100644", type: "blob", sha: null },
      ],
    };
    expect(decodeGitHubPostBodyV1("github.tree.post", tree)).toEqual(tree);
    expectIcarusCode(() =>
      decodeGitHubPostBodyV1("github.tree.post", {
        ...tree,
        tree: [...tree.tree].reverse(),
      }),
    );

    const commit = {
      message: COMMIT_MESSAGE,
      tree: CANDIDATE_TREE,
      parents: [BASE_COMMIT],
      author: { ...PROFILE.commitIdentity, date: COMMIT_INSTANT },
      committer: { ...PROFILE.commitIdentity, date: COMMIT_INSTANT },
    };
    expect(decodeGitHubPostBodyV1("github.commit.post", commit)).toEqual(commit);
    expect(
      decodeGitHubPostBodyV1("github.ref.post", {
        ref: LANDING.headRef,
        sha: CANDIDATE_COMMIT,
      }),
    ).toEqual({ ref: LANDING.headRef, sha: CANDIDATE_COMMIT });

    const body = renderPullRequestBodyV1({
      landing: LANDING,
      landingSha256: digestLandingRecord(LANDING),
      bodyPrefix: PULL_REQUEST_BODY_PREFIX,
    });
    const pullRequest = {
      title: PULL_REQUEST_TITLE,
      head: `octocat:icarus/${RUN_ID}`,
      base: "main",
      body,
      draft: true,
      maintainer_can_modify: false,
    };
    expect(decodeGitHubPostBodyV1("github.pull_request.post", pullRequest)).toEqual(pullRequest);
    expectIcarusCode(() =>
      decodeGitHubPostBodyV1("github.pull_request.post", {
        ...pullRequest,
        maintainer_can_modify: true,
      }),
    );
  });
});

describe("landing v1 durable ledger records", () => {
  const landingSha256 = digestLandingRecord(LANDING);

  it("validates standalone credential environment names and durable decisions", () => {
    expect(assertLandingCredentialEnvironmentName("ICARUS_GITHUB_TOKEN_TEST")).toBe(
      "ICARUS_GITHUB_TOKEN_TEST",
    );
    for (const name of [
      "GITHUB_TOKEN",
      "ICARUS_GITHUB_TOKEN_",
      "ICARUS_GITHUB_TOKEN_lowercase",
      "ICARUS_GITHUB_TOKEN_TRAILING_",
    ]) {
      expectIcarusCode(() => assertLandingCredentialEnvironmentName(name));
    }

    const decision = {
      id: REVIEW_ID,
      landingId: LANDING_ID,
      landingSha256,
      actor: "operator",
      decision: "approve",
      createdAt: "2026-08-02T12:00:00.000Z",
    };
    expect(decodeLandingDecisionV1(decision)).toEqual(decision);
    expectIcarusCode(() => decodeLandingDecisionV1({ ...decision, unknown: true }));
    expectIcarusCode(() => decodeLandingDecisionV1({ ...decision, actor: "bad\nactor" }));
    expectIcarusCode(() =>
      decodeLandingDecisionV1({ ...decision, landingSha256: landingSha256.toUpperCase() }),
    );
  });

  it("closes every representable local-ref fact and rejects the undefined invalid shape", () => {
    const absent = {
      schemaVersion: 1,
      state: "absent",
      objectSha1: null,
      symbolicTargetSha256: null,
    };
    const direct = {
      schemaVersion: 1,
      state: "direct",
      objectSha1: CANDIDATE_COMMIT,
      symbolicTargetSha256: null,
    };
    const symbolic = {
      schemaVersion: 1,
      state: "symbolic",
      objectSha1: null,
      symbolicTargetSha256: sha256("refs/heads/main"),
    };

    expect(decodeLocalRefFactV1(absent)).toEqual(absent);
    expect(decodeLocalRefFactV1(direct)).toEqual(direct);
    expect(decodeLocalRefFactV1(symbolic)).toEqual(symbolic);
    expect(decodeCanonicalLocalRefFactJsonV1(canonicalLandingJson(direct))).toEqual(direct);

    const noncanonical = JSON.stringify(direct);
    expect(noncanonical).not.toBe(canonicalLandingJson(direct));
    expectIcarusCode(() => decodeCanonicalLocalRefFactJsonV1(noncanonical));
    expectIcarusCode(() =>
      decodeLocalRefFactV1({
        schemaVersion: 1,
        state: "invalid",
        objectSha1: null,
        symbolicTargetSha256: null,
      }),
    );
    expectIcarusCode(() =>
      decodeLocalRefFactV1({ ...direct, symbolicTargetSha256: sha256("target") }),
    );
    expectIcarusCode(() => decodeLocalRefFactV1({ ...absent, extra: null }));
  });

  it("enforces observation phase, fact order, cardinality, IDs, and canonical bytes", () => {
    const localObservation = {
      schemaVersion: 1,
      operationId: OPERATION_ID,
      kind: "local_ref.create",
      phase: "pre_effect",
      facts: [
        {
          fact: "local_ref",
          requestId: null,
          resultSha256: sha256("local-ref-fact"),
        },
      ],
    };
    expect(decodeLandingOperationObservationV1(localObservation)).toEqual(localObservation);
    expect(
      decodeCanonicalLandingOperationObservationJsonV1(canonicalLandingJson(localObservation)),
    ).toEqual(localObservation);

    const preflightObservation = {
      schemaVersion: 1,
      operationId: OPERATION_ID,
      kind: "github.preflight",
      phase: "pre_effect",
      facts: [
        { fact: "actor", requestId: REQUEST_ID, resultSha256: sha256("actor") },
        { fact: "base_ref", requestId: REVIEW_ID, resultSha256: sha256("base") },
        { fact: "head_ref", requestId: RUN_ID, resultSha256: sha256("head") },
      ],
    };
    expect(decodeLandingOperationObservationV1(preflightObservation)).toEqual(preflightObservation);
    expectIcarusCode(() =>
      decodeLandingOperationObservationV1({
        ...preflightObservation,
        facts: [...preflightObservation.facts].reverse(),
      }),
    );
    expectIcarusCode(() =>
      decodeLandingOperationObservationV1({
        ...preflightObservation,
        facts: preflightObservation.facts.map((fact, index) =>
          index === 0 ? { ...fact, requestId: null } : fact,
        ),
      }),
    );
    expectIcarusCode(() =>
      decodeLandingOperationObservationV1({
        ...localObservation,
        kind: "landing.reconcile",
      }),
    );
    expectIcarusCode(() =>
      decodeLandingOperationObservationV1({
        ...localObservation,
        kind: "candidate.prepare",
        facts: [],
      }),
    );
  });

  it("strictly maps operation outcomes, boundaries, evidence, and stage values", () => {
    const candidateResult = {
      schemaVersion: 1,
      operationId: OPERATION_ID,
      kind: "candidate.prepare",
      outcome: "completed",
      boundary: "candidate_ready",
      evidence: [],
      value: {
        candidateTreeSha1: CANDIDATE_TREE,
        candidateCommitSha1: CANDIDATE_COMMIT,
        candidateCommitPayloadSha256: LANDING.candidateCommitPayloadSha256,
        candidateObjectManifestSha256: LANDING.candidateObjectManifestSha256,
        candidateCredentialAuditSha256: LANDING.candidateCredentialAuditSha256,
        diffByteEqual: true,
      },
      errorCode: null,
    };
    expect(decodeLandingOperationResultV1(candidateResult)).toEqual(candidateResult);
    expect(
      decodeCanonicalLandingOperationResultJsonV1(canonicalLandingJson(candidateResult)),
    ).toEqual(candidateResult);
    expectIcarusCode(() =>
      decodeLandingOperationResultV1({
        ...candidateResult,
        boundary: "local_ref_ready",
      }),
    );
    expectIcarusCode(() =>
      decodeLandingOperationResultV1({
        ...candidateResult,
        evidence: [{ requestId: null, resultSha256: sha256("unexpected") }],
      }),
    );

    const localResult = {
      schemaVersion: 1,
      operationId: OPERATION_ID,
      kind: "local_ref.create",
      outcome: "completed",
      boundary: "local_ref_ready",
      evidence: [{ requestId: null, resultSha256: sha256("local-ref-fact") }],
      value: {
        headRef: LANDING.headRef,
        candidateCommitSha1: CANDIDATE_COMMIT,
        localRefOutcome: "created",
        updateRefExitCode: 0,
      },
      errorCode: null,
    };
    expect(decodeLandingOperationResultV1(localResult)).toEqual(localResult);
    expectIcarusCode(() =>
      decodeLandingOperationResultV1({
        ...localResult,
        value: {
          ...localResult.value,
          localRefOutcome: "reconciled",
          updateRefExitCode: 0,
        },
      }),
    );

    const failedResult = {
      ...localResult,
      outcome: "failed",
      boundary: "operation_failed",
      evidence: [],
      value: null,
      errorCode: "LOCAL_REF_CONFLICT",
    };
    expect(decodeLandingOperationResultV1(failedResult)).toEqual(failedResult);
    expectIcarusCode(() => decodeLandingOperationResultV1({ ...failedResult, errorCode: null }));
    expectIcarusCode(() =>
      decodeLandingOperationResultV1({
        ...failedResult,
        kind: "candidate.prepare",
        outcome: "reconciliation_required",
        boundary: "reconciliation_required",
        value: { subjectOperationId: OPERATION_ID, remoteResidue: "none" },
      }),
    );

    const retryResult = {
      schemaVersion: 1,
      operationId: OPERATION_ID,
      kind: "landing.reconcile",
      outcome: "completed",
      boundary: "retry_stage_proven",
      evidence: [{ requestId: null, resultSha256: sha256("subject") }],
      value: {
        subjectOperationId: REVIEW_ID,
        nextState: "approved",
        remoteResidue: "none",
        stageValue: null,
      },
      errorCode: null,
    };
    expect(decodeLandingOperationResultV1(retryResult)).toEqual(retryResult);
    expectIcarusCode(() =>
      decodeLandingOperationResultV1({
        ...retryResult,
        boundary: "subject_settled",
      }),
    );
    expectIcarusCode(() =>
      decodeLandingOperationResultV1({
        ...retryResult,
        value: { ...retryResult.value, nextState: "landed" },
      }),
    );

    const pullRequestProjection = {
      type: "pull_request",
      number: 17,
      state: "open",
      draft: true,
      owner: "octocat",
      repository: "icarus-target",
      headOwner: "octocat",
      headRef: `icarus/${RUN_ID}`,
      headSha1: CANDIDATE_COMMIT,
      baseRef: "main",
      baseSha1: BASE_COMMIT,
      titleSha256: LANDING.pullRequestTitleSha256,
      bodySha256: sha256("final-body"),
      markerCount: 1,
      maintainerCanModify: false,
    };
    expect(decodePullRequestProjectionV1(pullRequestProjection)).toEqual(pullRequestProjection);
    expectIcarusCode(() =>
      decodePullRequestProjectionV1({ ...pullRequestProjection, markerCount: 2 }),
    );
    expectIcarusCode(() => decodePullRequestProjectionV1({ ...pullRequestProjection, number: 0 }));
  });

  it("decodes only the closed event payload for the separately supplied type", () => {
    const attemptStarted = {
      schemaVersion: 1,
      landingId: LANDING_ID,
      coordinatorAttempt: 1,
    };
    expect(decodeLandingEventPayloadV1("landing.attempt.started", attemptStarted)).toEqual(
      attemptStarted,
    );
    expect(
      decodeCanonicalLandingEventPayloadJsonV1(
        "landing.attempt.started",
        canonicalLandingJson(attemptStarted),
      ),
    ).toEqual(attemptStarted);

    const stateChanged = {
      schemaVersion: 1,
      landingId: LANDING_ID,
      from: "awaiting_approval",
      to: "approved",
      version: 2,
      operationId: null,
    };
    expect(decodeLandingEventPayloadV1("landing.state.changed", stateChanged)).toEqual(
      stateChanged,
    );
    expectIcarusCode(() =>
      decodeLandingEventPayloadV1("landing.state.changed", {
        ...stateChanged,
        to: "local_ready",
      }),
    );
    expectIcarusCode(() =>
      decodeLandingEventPayloadV1("landing.state.changed", {
        ...stateChanged,
        to: stateChanged.from,
      }),
    );

    const requestAdmitted = {
      schemaVersion: 1,
      landingId: LANDING_ID,
      operationId: OPERATION_ID,
      requestId: REQUEST_ID,
      coordinatorAttempt: 2,
      operationKind: "github.preflight",
      requestOrdinal: 1,
      kind: "github.actor.get",
      requestSha256: sha256("request"),
    };
    expect(decodeLandingEventPayloadV1("landing.github.request.admitted", requestAdmitted)).toEqual(
      requestAdmitted,
    );
    expectIcarusCode(() =>
      decodeLandingEventPayloadV1("landing.github.request.admitted", {
        ...requestAdmitted,
        operationKind: "candidate.prepare",
      }),
    );

    const operationSettled = {
      schemaVersion: 1,
      landingId: LANDING_ID,
      operationId: OPERATION_ID,
      coordinatorAttempt: 1,
      kind: "candidate.prepare",
      outcome: "completed",
      resultSha256: sha256("candidate-result"),
      errorCode: null,
    };
    expect(decodeLandingEventPayloadV1("landing.operation.settled", operationSettled)).toEqual(
      operationSettled,
    );
    expectIcarusCode(() =>
      decodeLandingEventPayloadV1("landing.operation.settled", {
        ...operationSettled,
        outcome: "failed",
      }),
    );
    expectIcarusCode(() =>
      decodeLandingEventPayloadV1("landing.attempt.started", {
        ...attemptStarted,
        extra: true,
      }),
    );
    expectIcarusCode(() => decodeLandingEventPayloadV1("landing.unknown", attemptStarted));
    expectIcarusCode(() =>
      decodeLandingEventPayloadV1("landing.decision.recorded", {
        schemaVersion: 1,
        landingId: LANDING_ID,
        decisionId: REVIEW_ID,
        landingSha256,
        decision: "approve",
        actor: "bad\ractor",
      }),
    );
  });
});
