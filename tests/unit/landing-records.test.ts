import { describe, expect, it } from "vitest";
import { sha256 } from "../../packages/core/src/digest.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import {
  assertGitBranchName,
  assertLandingCredentialEnvironmentAllowed,
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
  decodeCanonicalLandingJson,
  decodeChangedPathsDigestV1,
  decodeGitHubLandingProfileV1,
  decodeGitHubPostBodyV1,
  decodeLandingDigestV1,
  decodeLandingHttpRequestV1,
  decodeLandingOperationRequestV1,
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
