import path from "node:path";

import { GithubGateway, type GithubPullRequestReceipt } from "@icarus/github-gateway";

import { containsSecretShapedContent } from "./context.js";
import { sha256 } from "./digest.js";
import { IcarusError, invariant } from "./errors.js";
import {
  type LandingCandidateResult,
  LandingGitController,
  type LandingLocalRefFact,
  type LandingLocalRefObservation,
  type LandingLocalRefUpdateResult,
} from "./landing-git.js";
import type {
  CandidateSettlementInputV1,
  LandingEligibilityV1,
  LandingProfileRecordV1,
  LandingRecordV1,
  LandingStatusV1,
} from "./landing-ledger.js";
import {
  assertLandingCredentialEnvironmentAllowed,
  assertLandingCredentialEnvironmentName,
  canonicalizeCommitMessage,
  canonicalizePullRequestBodyPrefix,
  canonicalizePullRequestTitle,
  commitEpochToGitInstant,
  DERIVATIVE_EFFECTS,
  DERIVATIVE_GITHUB_EVENTS,
  DIRECT_ICARUS_EFFECTS,
  decodeCandidateCredentialAuditV1,
  decodeGitHubLandingProfileV1,
  decodeLandingDigestV1,
  deriveCandidateObjectManifestV1,
  digestLandingRecord,
  GITHUB_API_ORIGIN,
  GITHUB_API_VERSION,
  type GitHubLandingProfileV1,
  type LandingDigestV1,
  type LocalRefFactV1,
  type PullRequestProjectionV1,
  renderPullRequestBodyV1,
} from "./landing-records.js";
import type { RunLeaseManager } from "./lease.js";
import { asIcarusError, boundedSignal } from "./service-support.js";
import type { IcarusStore } from "./store.js";
import type { CheckpointFile } from "./types.js";

/**
 * The Packet 3 landing coordinator, extracted from `IcarusService` without
 * behavior change. It owns preparation, the digest-bound decision, private
 * local-ref creation, and reconciliation; the service delegates its landing
 * methods here and keeps the public surface unchanged.
 *
 * The S2b-ii slices drive the full GitHub delivery chain through the
 * injectable gateway seam: the read-only preflight, the object upload and
 * absent-only remote ref (ii-a/ii-b), and the at-most-once draft pull request
 * with its immutable receipt (ii-c) — every request admitted to the durable
 * ledger before its I/O and settled after, with the credential resolved
 * env-only at call time and never persisted. Nothing here performs a merge,
 * a pull-request state change beyond draft creation, or a deployment.
 */

const LANDING_ATTEMPT_TIMEOUT_MS = 10 * 60 * 1_000;

export type LandingGitService = Pick<
  LandingGitController,
  "inspectBase" | "prepareCandidate" | "observeLocalRef" | "createAbsentLocalRef"
>;

/**
 * The bounded slice of the GitHub gateway the landing coordinator drives. The
 * gateway owns one validated call at a time; the coordinator owns durable
 * admission, settlement, and recovery (ADR 0043's argument-shape decision: the
 * coordinator translates records to values at this boundary).
 */
export type LandingGithubGateway = Pick<
  GithubGateway,
  | "readActor"
  | "readBaseReference"
  | "readReference"
  | "readPullRequestByHead"
  | "createBlob"
  | "createTree"
  | "createCommit"
  | "createAbsentRef"
  | "createDraftPullRequest"
>;

export interface PrepareLandingInput {
  readonly runId: string;
  readonly commitMessage: string;
  readonly pullRequestTitle: string;
  readonly pullRequestBodyPrefix: string;
}

export interface LandingCoordinatorOptions {
  readonly stateRoot: string;
  readonly store: IcarusStore;
  readonly leases: RunLeaseManager;
  readonly landingGit?: LandingGitService;
  readonly landingCredentialEnvironmentNames?: readonly string[];
  /**
   * Builds the bounded gateway for one attempt from the just-resolved
   * credential. Production wires the pinned `api.github.com` origin; tests
   * inject a deterministic fake or an explicit loopback transport. Never
   * persisted: the credential exists only inside one attempt's scope.
   */
  readonly landingGithubGateway?: (credential: string) => LandingGithubGateway;
  /**
   * Resolves one allowlisted environment value at call time. Defaults to the
   * process environment; tests inject a fixed map so no real environment is
   * read.
   */
  readonly landingCredentialEnvironment?: (name: string) => string | undefined;
  readonly now: () => string;
  readonly platform: NodeJS.Platform;
}

function decodeLandingCheckpointBytes(value: string, name: string): Buffer {
  invariant(
    value.length % 4 === 0 && (value.length === 0 || /^[A-Za-z0-9+/]+={0,2}$/.test(value)),
    "INVALID_CHECKPOINT",
    `${name} is not canonical base64`,
  );
  const bytes = Buffer.from(value, "base64");
  invariant(
    bytes.toString("base64") === value,
    "INVALID_CHECKPOINT",
    `${name} is not canonical base64`,
  );
  return bytes;
}

function candidateCredentialAudit(
  checkpointFiles: readonly CheckpointFile[],
  text: {
    readonly commitMessage: string;
    readonly pullRequestTitle: string;
    readonly pullRequestBodyPrefix: string;
  },
) {
  const changedBlobs = checkpointFiles.flatMap((file) => {
    if (file.approvedBase64 === null) return [];
    const bytes = decodeLandingCheckpointBytes(
      file.approvedBase64,
      `checkpointFiles[${file.path}].approvedBase64`,
    );
    invariant(
      !containsSecretShapedContent(bytes),
      "LANDING_CREDENTIAL_AUDIT_FAILED",
      "Candidate changed bytes contain recognizable credential material",
    );
    return [
      {
        kind: "changed_blob" as const,
        path: file.path,
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
      },
    ];
  });
  const textSubjects = [
    { kind: "commit_message" as const, value: text.commitMessage },
    { kind: "pull_request_title" as const, value: text.pullRequestTitle },
    { kind: "pull_request_body_prefix" as const, value: text.pullRequestBodyPrefix },
  ].map(({ kind, value }) => {
    const bytes = Buffer.from(value, "utf8");
    invariant(
      !containsSecretShapedContent(bytes),
      "LANDING_CREDENTIAL_AUDIT_FAILED",
      "Candidate landing text contains recognizable credential material",
    );
    return { kind, path: null, bytes: bytes.byteLength, sha256: sha256(bytes) };
  });
  return decodeCandidateCredentialAuditV1({
    schemaVersion: 1,
    policyVersion: "landing-outgoing-v1",
    outcome: "passed",
    subjects: [...changedBlobs, ...textSubjects],
  });
}

function buildCandidateSettlement(
  landing: LandingRecordV1,
  eligibility: LandingEligibilityV1,
  candidate: LandingCandidateResult,
): CandidateSettlementInputV1 {
  const audit = candidateCredentialAudit(eligibility.checkpointFiles, {
    commitMessage: landing.commitMessage,
    pullRequestTitle: landing.pullRequestTitle,
    pullRequestBodyPrefix: landing.pullRequestBodyPrefix,
  });
  const candidateCredentialAuditSha256 = digestLandingRecord(audit);
  const authority: LandingDigestV1 = decodeLandingDigestV1({
    schemaVersion: 1,
    policyVersion: 1,
    githubApiVersion: GITHUB_API_VERSION,
    landingId: landing.id,
    runId: landing.runId,
    projectId: landing.projectId,
    baseCommitSha1: landing.baseCommitSha1,
    baseTreeSha1: landing.baseTreeSha1,
    planSha256: landing.planSha256,
    diffSha256: landing.diffSha256,
    checkpointSha256: landing.checkpointSha256,
    verificationSha256: landing.verificationSha256,
    reviewDecisionId: landing.reviewDecisionId,
    reviewDecisionSha256: landing.reviewDecisionSha256,
    changedPaths: landing.changedPaths,
    changedPathsSha256: landing.changedPathsSha256,
    candidateCredentialAuditSha256,
    profileVersion: 1,
    profileSha256: landing.profileSha256,
    profile: landing.profile,
    objectFormat: candidate.objectFormat,
    candidateParentSha1: landing.baseCommitSha1,
    candidateTreeSha1: candidate.candidateTreeSha1,
    candidateCommitSha1: candidate.candidateCommitSha1,
    candidateCommitPayloadSha256: candidate.candidateCommitPayloadSha256,
    candidateObjectManifestSha256: candidate.candidateObjectManifestSha256,
    commitMessageSha256: landing.commitMessageSha256,
    commitAuthor: landing.profile.commitIdentity,
    commitCommitter: landing.profile.commitIdentity,
    commitEpochSeconds: landing.commitEpochSeconds,
    commitIso8601: landing.commitIso8601,
    baseRef: `refs/heads/${landing.profile.baseBranch}`,
    expectedRemoteBaseSha1: landing.baseCommitSha1,
    headRef: landing.headRef,
    pullRequestTitleSha256: landing.pullRequestTitleSha256,
    pullRequestBodyPrefixSha256: landing.pullRequestBodyPrefixSha256,
    pullRequestMarkerVersion: 1,
    draft: true,
    maintainerCanModify: false,
    directIcarusEffects: DIRECT_ICARUS_EFFECTS,
    derivativeEffectDisclosure: {
      version: 1,
      githubEvents: DERIVATIVE_GITHUB_EVENTS,
      mayTrigger: DERIVATIVE_EFFECTS,
      disposition: landing.profile.derivativeEffects.disposition,
      evidenceSha256: landing.profile.derivativeEffects.evidenceSha256,
    },
  });
  const landingSha256 = digestLandingRecord(authority);
  const pullRequestBody = renderPullRequestBodyV1({
    landing: authority,
    landingSha256,
    bodyPrefix: landing.pullRequestBodyPrefix,
  });
  return {
    candidateTreeSha1: candidate.candidateTreeSha1,
    candidateCommitSha1: candidate.candidateCommitSha1,
    candidateCommitPayloadSha256: candidate.candidateCommitPayloadSha256,
    candidateObjectManifestSha256: candidate.candidateObjectManifestSha256,
    candidateCredentialAuditSha256,
    landingDigest: authority,
    pullRequestBodySha256: sha256(pullRequestBody),
  };
}

const ABSENT_LOCAL_REF_FACT: LocalRefFactV1 = {
  schemaVersion: 1,
  state: "absent",
  objectSha1: null,
  symbolicTargetSha256: null,
};
const ABSENT_LOCAL_REF_FACT_SHA256 = digestLandingRecord(ABSENT_LOCAL_REF_FACT);

function durableLocalRefFact(fact: LandingLocalRefFact): LocalRefFactV1 {
  return { schemaVersion: 1, ...fact };
}

const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Maps any thrown value to a bounded host safe code. Both `IcarusError` and
 * the gateway's structurally compatible `GithubGatewayError` carry a `code`;
 * anything else collapses to the fallback so no foreign text is persisted.
 */
function githubErrorCode(error: unknown, fallback: string): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
  return typeof code === "string" && SAFE_CODE_PATTERN.test(code) ? code : fallback;
}

/**
 * Extracts the HTTP status an error carries, reduced to the bounded integer
 * the record contract admits. Anything else — including header text or an
 * out-of-range value — becomes null, the "null transport refusal" shape.
 */
function githubErrorStatus(error: unknown): number | null {
  const details =
    typeof error === "object" && error !== null && "details" in error
      ? (error as { readonly details?: unknown }).details
      : undefined;
  const status =
    typeof details === "object" && details !== null && "status" in details
      ? (details as { readonly status?: unknown }).status
      : undefined;
  return typeof status === "number" &&
    Number.isSafeInteger(status) &&
    status >= 100 &&
    status <= 599
    ? status
    : null;
}

function assertLocalRefObservationBinding(
  observation: LandingLocalRefObservation,
  landing: LandingRecordV1,
): void {
  invariant(
    observation.headRef === landing.headRef,
    "LANDING_GIT_OUTPUT_INVALID",
    "Landing Git observed a different local ref",
  );
}

function assertLocalRefUpdateBinding(
  result: LandingLocalRefUpdateResult,
  landing: LandingRecordV1,
): void {
  invariant(
    result.headRef === landing.headRef &&
      result.candidateCommitSha1 === landing.candidateCommitSha1,
    "LANDING_GIT_OUTPUT_INVALID",
    "Landing Git updated a different local-ref authority",
  );
}

function hasDurableAbsentReconciliationSubject(status: LandingStatusV1): boolean {
  const reconcile = status.operations.find(
    (operation) => operation.kind === "landing.reconcile" && operation.status === "started",
  );
  if (reconcile === undefined) return false;
  const input = reconcile.request.input;
  if (!("subjectOperationId" in input) || typeof input.subjectOperationId !== "string") {
    return false;
  }
  const subject = status.operations.find(
    (operation) =>
      operation.id === input.subjectOperationId && operation.kind === "local_ref.create",
  );
  return (
    subject?.observation?.facts.some(
      (fact) => fact.fact === "local_ref" && fact.resultSha256 === ABSENT_LOCAL_REF_FACT_SHA256,
    ) === true
  );
}

/**
 * Projects one gateway pull-request receipt into the record contract's exact
 * shape, or null when the observed pull request does not conform (not an open
 * draft, maintainer edits enabled, or not exactly one landing marker). The
 * upstream title and body never cross this boundary — only their
 * gateway-computed digests.
 */
function pullRequestProjectionFromReceipt(
  receipt: GithubPullRequestReceipt,
  coordinates: { readonly owner: string; readonly repository: string },
): PullRequestProjectionV1 | null {
  if (
    !Number.isSafeInteger(receipt.number) ||
    receipt.number < 1 ||
    receipt.state !== "open" ||
    !receipt.isDraft ||
    receipt.maintainerCanModify ||
    receipt.markerCount !== 1 ||
    !receipt.headRef.startsWith("refs/heads/")
  ) {
    return null;
  }
  return {
    type: "pull_request",
    number: receipt.number,
    state: "open",
    draft: true,
    owner: coordinates.owner,
    repository: coordinates.repository,
    headOwner: coordinates.owner,
    // The receipt echoes the full head reference; the projection binds the
    // branch name, exactly as the record contract spells it.
    headRef: receipt.headRef.slice("refs/heads/".length),
    headSha1: receipt.headSha1,
    baseRef: receipt.baseBranch,
    baseSha1: receipt.baseSha1,
    titleSha256: receipt.titleSha256,
    bodySha256: receipt.bodySha256,
    markerCount: 1,
    maintainerCanModify: false,
  };
}

/** Whether one projected pull request restates the landing's approved subject. */
function pullRequestProjectionMatchesLanding(
  projection: PullRequestProjectionV1,
  landing: LandingRecordV1,
): boolean {
  return (
    projection.owner === landing.profile.owner &&
    projection.repository === landing.profile.repository &&
    projection.headOwner === landing.profile.owner &&
    projection.headRef === landing.headRef.slice("refs/heads/".length) &&
    projection.headSha1 === landing.candidateCommitSha1 &&
    projection.baseRef === landing.profile.baseBranch &&
    projection.baseSha1 === landing.baseCommitSha1 &&
    projection.titleSha256 === landing.pullRequestTitleSha256 &&
    projection.bodySha256 === landing.pullRequestBodySha256
  );
}

export class LandingCoordinator {
  readonly #store: IcarusStore;
  readonly #landingGit: LandingGitService;
  readonly #landingCredentialEnvironmentNames: ReadonlySet<string>;
  readonly #landingGithubGateway: (credential: string) => LandingGithubGateway;
  readonly #landingCredentialEnvironment: (name: string) => string | undefined;
  readonly #leases: RunLeaseManager;
  readonly #now: () => string;
  readonly #platform: NodeJS.Platform;

  constructor(options: LandingCoordinatorOptions) {
    const stateRoot = path.resolve(options.stateRoot);
    this.#store = options.store;
    this.#leases = options.leases;
    this.#landingGit =
      options.landingGit ??
      new LandingGitController(
        path.join(stateRoot, "controller-home"),
        path.join(stateRoot, "runs"),
      );
    const landingCredentialEnvironmentNames = options.landingCredentialEnvironmentNames ?? [];
    for (const [index, name] of landingCredentialEnvironmentNames.entries()) {
      assertLandingCredentialEnvironmentName(name, `landingCredentialEnvironmentNames[${index}]`);
    }
    invariant(
      new Set(landingCredentialEnvironmentNames).size === landingCredentialEnvironmentNames.length,
      "LANDING_CREDENTIAL_NOT_ALLOWED",
      "Landing credential environment allowlist names must be unique",
    );
    this.#landingCredentialEnvironmentNames = new Set(landingCredentialEnvironmentNames);
    this.#landingGithubGateway =
      options.landingGithubGateway ??
      ((credential) => new GithubGateway({ baseUrl: GITHUB_API_ORIGIN, token: credential }));
    this.#landingCredentialEnvironment =
      options.landingCredentialEnvironment ?? ((name) => process.env[name]);
    this.#now = options.now;
    this.#platform = options.platform;
  }

  #assertLandingMutationPlatform(): void {
    invariant(
      this.#platform === "linux",
      "UNSUPPORTED_PLATFORM",
      "Git landing mutations require Linux",
    );
  }

  #landingEligibilityFor(landing: LandingRecordV1): LandingEligibilityV1 {
    const eligibility = this.#store.getLandingEvidence(landing.runId);
    invariant(
      eligibility.runId === landing.runId &&
        eligibility.projectId === landing.projectId &&
        eligibility.baseCommitSha1 === landing.baseCommitSha1 &&
        eligibility.planSha256 === landing.planSha256 &&
        eligibility.diffSha256 === landing.diffSha256 &&
        eligibility.checkpointSha256 === landing.checkpointSha256 &&
        eligibility.verificationSha256 === landing.verificationSha256 &&
        eligibility.reviewDecisionId === landing.reviewDecisionId &&
        eligibility.reviewDecisionSha256 === landing.reviewDecisionSha256 &&
        eligibility.changedPathsSha256 === landing.changedPathsSha256,
      "LANDING_NOT_ELIGIBLE",
      "Landing run evidence no longer matches its durable snapshot",
    );
    return eligibility;
  }

  async #executeLandingCandidate(
    landingId: string,
    signal?: AbortSignal,
  ): Promise<LandingStatusV1> {
    const status = this.#store.getLandingStatus(landingId);
    const landing = status.landing;
    invariant(
      landing.state === "preparing_candidate",
      "INVALID_LANDING_STATE",
      "Landing is not preparing its candidate",
    );
    assertLandingCredentialEnvironmentAllowed(
      landing.profile,
      this.#landingCredentialEnvironmentNames,
    );
    const eligibility = this.#landingEligibilityFor(landing);
    const base = await this.#landingGit.inspectBase(
      {
        cachePath: eligibility.cachePath,
        runId: landing.runId,
        baseCommitSha1: landing.baseCommitSha1,
      },
      signal,
    );
    invariant(
      base.objectFormat === "sha1" &&
        base.baseCommitSha1 === landing.baseCommitSha1 &&
        base.baseTreeSha1 === landing.baseTreeSha1,
      "LANDING_BASE_CHANGED",
      "Landing base tree no longer matches its durable snapshot",
    );
    this.#store.startCandidatePreparation(landing.id);
    try {
      const candidate = await this.#landingGit.prepareCandidate(
        {
          cachePath: eligibility.cachePath,
          runId: landing.runId,
          baseCommitSha1: landing.baseCommitSha1,
          baseTreeSha1: landing.baseTreeSha1,
          checkpointFiles: eligibility.checkpointFiles,
          reviewedDiffBytes: Buffer.from(eligibility.reviewedDiff, "utf8"),
          commitIdentity: landing.profile.commitIdentity,
          commitEpochSeconds: landing.commitEpochSeconds,
          commitMessage: landing.commitMessage,
        },
        signal,
      );
      invariant(
        candidate.objectFormat === "sha1" &&
          candidate.baseCommitSha1 === landing.baseCommitSha1 &&
          candidate.baseTreeSha1 === landing.baseTreeSha1 &&
          candidate.candidateObjectManifest.baseCommitSha1 === landing.baseCommitSha1 &&
          candidate.candidateObjectManifest.baseTreeSha1 === landing.baseTreeSha1 &&
          candidate.candidateObjectManifest.candidateTreeSha1 === candidate.candidateTreeSha1 &&
          candidate.candidateObjectManifest.candidateCommitSha1 === candidate.candidateCommitSha1 &&
          digestLandingRecord(candidate.candidateObjectManifest) ===
            candidate.candidateObjectManifestSha256,
        "LANDING_CANDIDATE_MISMATCH",
        "Landing candidate result is not bound to its durable authority",
      );
      return this.#store.settleLandingCandidate(
        landing.id,
        buildCandidateSettlement(landing, eligibility, candidate),
      );
    } catch (error) {
      const failure = asIcarusError(error, "LANDING_CANDIDATE_FAILED");
      const errorCode = /^[A-Z][A-Z0-9_]*$/.test(failure.code)
        ? failure.code
        : "LANDING_CANDIDATE_FAILED";
      const current = this.#store.getLandingStatus(landing.id);
      if (
        current.operations.some(
          (operation) => operation.kind === "candidate.prepare" && operation.status === "started",
        )
      ) {
        this.#store.settleLandingCandidateFailure(
          landing.id,
          errorCode,
          signal?.aborted === true || errorCode === "CANCELLED" ? "interrupted" : "failed",
        );
      }
      throw new IcarusError(failure.code, failure.message, { runId: landing.runId });
    }
  }

  async #executeLocalRefCreation(
    landingId: string,
    signal?: AbortSignal,
  ): Promise<LandingStatusV1> {
    const status = this.#store.getLandingStatus(landingId);
    const landing = status.landing;
    invariant(
      landing.state === "approved" &&
        status.decision?.decision === "approve" &&
        landing.candidateCommitSha1 !== null,
      "INVALID_LANDING_STATE",
      "Landing is not approved with a complete local candidate",
    );
    assertLandingCredentialEnvironmentAllowed(
      landing.profile,
      this.#landingCredentialEnvironmentNames,
    );
    const eligibility = this.#landingEligibilityFor(landing);
    const admitted = this.#store.startLocalRefCreation(landing.id);

    let observation: LandingLocalRefObservation;
    try {
      observation = await this.#landingGit.observeLocalRef(
        { cachePath: eligibility.cachePath, runId: landing.runId },
        signal,
      );
      assertLocalRefObservationBinding(observation, landing);
    } catch (error) {
      const failure = asIcarusError(error, "LANDING_LOCAL_REF_OBSERVATION_FAILED");
      const errorCode = /^[A-Z][A-Z0-9_]*$/.test(failure.code)
        ? failure.code
        : "LANDING_LOCAL_REF_OBSERVATION_FAILED";
      return this.#store.settleLocalRefCreation(landing.id, {
        outcome: "failed",
        errorCode,
        observedFact: null,
        postEffectFact: null,
      });
    }
    if (observation.outcome !== "definitive") {
      return this.#store.settleLocalRefCreation(landing.id, {
        outcome: "failed",
        errorCode: observation.errorCode,
        observedFact: null,
        postEffectFact: null,
      });
    }

    const observedFact = durableLocalRefFact(observation.fact);
    this.#store.recordLocalRefObservation(landing.id, admitted.operationId, observedFact);
    if (observedFact.state !== "absent") {
      return this.#store.settleLocalRefCreation(landing.id, {
        outcome: "failed",
        errorCode: "LANDING_LOCAL_REF_CONFLICT",
        observedFact,
        postEffectFact: null,
      });
    }

    let execution:
      | { readonly outcome: "succeeded"; readonly errorCode: null }
      | { readonly outcome: "failed" | "ambiguous"; readonly errorCode: string };
    try {
      const result = await this.#landingGit.createAbsentLocalRef(
        {
          cachePath: eligibility.cachePath,
          runId: landing.runId,
          candidateCommitSha1: landing.candidateCommitSha1,
        },
        signal,
      );
      assertLocalRefUpdateBinding(result, landing);
      execution =
        result.outcome === "succeeded"
          ? { outcome: "succeeded", errorCode: null }
          : { outcome: result.outcome, errorCode: result.errorCode };
    } catch (error) {
      const failure = asIcarusError(error, "LANDING_LOCAL_REF_OUTCOME_AMBIGUOUS");
      execution = {
        outcome: "ambiguous",
        errorCode: /^[A-Z][A-Z0-9_]*$/.test(failure.code)
          ? failure.code
          : "LANDING_LOCAL_REF_OUTCOME_AMBIGUOUS",
      };
    }

    let postEffectFact: LocalRefFactV1 | null = null;
    try {
      const post = await this.#landingGit.observeLocalRef(
        {
          cachePath: eligibility.cachePath,
          runId: landing.runId,
        },
        signal,
      );
      assertLocalRefObservationBinding(post, landing);
      if (post.outcome === "definitive") {
        postEffectFact = durableLocalRefFact(post.fact);
      }
    } catch {
      postEffectFact = null;
    }

    const settledOutcome =
      postEffectFact?.state === "absent" && execution.outcome === "ambiguous"
        ? "failed"
        : execution.outcome;
    return this.#store.settleLocalRefCreation(landing.id, {
      outcome: settledOutcome,
      errorCode: settledOutcome === "succeeded" ? null : execution.errorCode,
      observedFact,
      postEffectFact,
    });
  }

  async #executeLocalRefReconciliation(
    landingId: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<LandingStatusV1> {
    const status = this.#store.getLandingStatus(landingId);
    const landing = status.landing;
    invariant(
      landing.state === "reconciliation_required" &&
        landing.resumeState === "approved" &&
        landing.candidateCommitSha1 !== null &&
        status.operations.some(
          (operation) =>
            operation.id === operationId &&
            operation.kind === "landing.reconcile" &&
            operation.status === "started",
        ),
      "INVALID_LANDING_STATE",
      "Landing is not reconciling the admitted local-ref subject",
    );
    assertLandingCredentialEnvironmentAllowed(
      landing.profile,
      this.#landingCredentialEnvironmentNames,
    );
    const eligibility = this.#landingEligibilityFor(landing);

    let observation: LandingLocalRefObservation;
    try {
      observation = await this.#landingGit.observeLocalRef(
        { cachePath: eligibility.cachePath, runId: landing.runId },
        signal,
      );
      assertLocalRefObservationBinding(observation, landing);
    } catch (error) {
      const failure = asIcarusError(error, "LANDING_LOCAL_REF_OBSERVATION_AMBIGUOUS");
      const errorCode = /^[A-Z][A-Z0-9_]*$/.test(failure.code)
        ? failure.code
        : "LANDING_LOCAL_REF_OBSERVATION_AMBIGUOUS";
      return this.#store.settleLocalRefReconciliation(landing.id, {
        outcome: "reconciliation_required",
        errorCode,
        fact: null,
      });
    }
    if (observation.outcome !== "definitive") {
      return this.#store.settleLocalRefReconciliation(landing.id, {
        outcome: "reconciliation_required",
        errorCode: observation.errorCode,
        fact: null,
      });
    }

    const fact = durableLocalRefFact(observation.fact);
    const observed = this.#store.recordLocalRefObservation(landing.id, operationId, fact);
    const exactCandidate =
      fact.state === "direct" && fact.objectSha1 === landing.candidateCommitSha1;
    if (fact.state === "absent") {
      return this.#store.settleLocalRefReconciliation(landing.id, {
        outcome: "retry_approved",
        errorCode: null,
        fact,
      });
    }
    if (exactCandidate && hasDurableAbsentReconciliationSubject(observed)) {
      return this.#store.settleLocalRefReconciliation(landing.id, {
        outcome: "local_ready",
        errorCode: null,
        fact,
      });
    }
    return this.#store.settleLocalRefReconciliation(landing.id, {
      outcome: "reconciliation_required",
      errorCode: "LANDING_LOCAL_REF_CONFLICT",
      fact,
    });
  }

  /**
   * The read-only remote stage (S2b-ii-a): admit the preflight intent, then
   * perform the contract's bounded reads — actor, base ref, head-ref absence —
   * each admitted to the ledger before its I/O and settled after. No mutating
   * request exists in this slice, so every failure is retry-safe: definitive
   * refusals enter `failed` with the stable `local_ready` resume marker, and
   * interruptions leave the landing in `local_ready` for explicit resume.
   *
   * S2b-ii-b generalizes the stage to `objects_ready` and, when the attempt
   * chains its effect operation (`chainEffect`), a completed preflight leaves
   * the attempt open for it.
   */
  async #executeGithubPreflight(
    landingId: string,
    signal: AbortSignal | undefined,
    chainEffect: boolean,
  ): Promise<LandingStatusV1> {
    const status = this.#store.getLandingStatus(landingId);
    const landing = status.landing;
    invariant(
      (landing.state === "local_ready" ||
        landing.state === "objects_ready" ||
        landing.state === "remote_ready") &&
        status.decision?.decision === "approve" &&
        landing.landingSha256 !== null &&
        landing.candidateCommitSha1 !== null,
      "INVALID_LANDING_STATE",
      "Landing is not at a stable delivery state with a complete approved candidate",
    );
    assertLandingCredentialEnvironmentAllowed(
      landing.profile,
      this.#landingCredentialEnvironmentNames,
    );
    this.#landingEligibilityFor(landing);
    const admitted = this.#store.startGithubPreflight(landing.id);
    const operationId = admitted.operationId;

    // The credential resolves env-only at call time, immediately before the
    // bounded reads, and is dropped when the attempt completes or fails. A
    // missing credential fails before any HTTPS request is admitted.
    const credential = this.#landingCredentialEnvironment(landing.profile.credentialRef.name);
    if (credential === undefined || credential.length === 0) {
      return this.#store.settleGithubPreflight(landing.id, {
        outcome: "failed",
        errorCode: "LANDING_CREDENTIAL_MISSING",
        closeAttempt: true,
      });
    }
    let gateway: LandingGithubGateway;
    try {
      gateway = this.#landingGithubGateway(credential);
    } catch (error) {
      return this.#store.settleGithubPreflight(landing.id, {
        outcome: "failed",
        errorCode: githubErrorCode(error, "LANDING_GITHUB_GATEWAY_INVALID"),
        closeAttempt: true,
      });
    }

    const coordinates = { owner: landing.profile.owner, repository: landing.profile.repository };
    const baseRef = `refs/heads/${landing.profile.baseBranch}`;

    const actorAdmission = this.#store.admitGithubRequest(
      landing.id,
      operationId,
      "github.actor.get",
    );
    try {
      const receipt = await gateway.readActor(landing.profile.expectedActor, { signal });
      this.#store.settleGithubRequest(landing.id, actorAdmission.requestId, {
        outcome: "succeeded",
        httpStatus: 200,
        projection: { type: "actor", login: receipt.login },
        errorCode: null,
      });
    } catch (error) {
      return this.#failPreflightRead(landing.id, actorAdmission.requestId, error, signal);
    }

    const baseAdmission = this.#store.admitGithubRequest(
      landing.id,
      operationId,
      "github.base_ref.get",
    );
    let baseSha1: string;
    try {
      const receipt = await gateway.readBaseReference(coordinates, baseRef, { signal });
      if (receipt === null) {
        // A missing base ref is a failure, never a provable absence: only the
        // exact head-ref GET may carry the absent projection.
        this.#store.settleGithubRequest(landing.id, baseAdmission.requestId, {
          outcome: "failed",
          httpStatus: 404,
          projection: null,
          errorCode: "LANDING_REMOTE_BASE_MISSING",
        });
        return this.#store.settleGithubPreflight(landing.id, {
          outcome: "failed",
          errorCode: "LANDING_REMOTE_BASE_MISSING",
          closeAttempt: true,
        });
      }
      baseSha1 = receipt.sha;
      this.#store.settleGithubRequest(landing.id, baseAdmission.requestId, {
        outcome: "succeeded",
        httpStatus: 200,
        projection: { type: "ref", state: "direct", ref: baseRef, sha1: receipt.sha },
        errorCode: null,
      });
    } catch (error) {
      return this.#failPreflightRead(landing.id, baseAdmission.requestId, error, signal);
    }
    if (baseSha1 !== landing.baseCommitSha1) {
      // The read was truthful and its settled row records the drift; the
      // operation refuses before any later grammar member is admitted.
      return this.#store.settleGithubPreflight(landing.id, {
        outcome: "failed",
        errorCode: "LANDING_REMOTE_BASE_CHANGED",
        closeAttempt: true,
      });
    }

    const headAdmission = this.#store.admitGithubRequest(
      landing.id,
      operationId,
      "github.head_ref.get",
    );
    // Before the object/remote-ref stages the head must be absent; before
    // draft-PR creation it must point at the candidate exactly.
    const headRequiredExact = landing.state === "remote_ready";
    try {
      const receipt = await gateway.readReference(coordinates, landing.headRef, { signal });
      if (receipt === null) {
        this.#store.settleGithubRequest(landing.id, headAdmission.requestId, {
          outcome: "succeeded",
          httpStatus: 404,
          projection: { type: "ref", state: "absent", ref: landing.headRef, sha1: null },
          errorCode: null,
        });
        if (headRequiredExact) {
          // The remote-ref stage proved this branch; its disappearance is a
          // retry-safe pre-POST refusal.
          return this.#store.settleGithubPreflight(landing.id, {
            outcome: "failed",
            errorCode: "LANDING_REMOTE_HEAD_MISSING",
            closeAttempt: true,
          });
        }
      } else {
        this.#store.settleGithubRequest(landing.id, headAdmission.requestId, {
          outcome: "succeeded",
          httpStatus: 200,
          projection: { type: "ref", state: "direct", ref: landing.headRef, sha1: receipt.sha },
          errorCode: null,
        });
        if (headRequiredExact) {
          if (receipt.sha !== landing.candidateCommitSha1) {
            return this.#store.settleGithubPreflight(landing.id, {
              outcome: "failed",
              errorCode: "LANDING_REMOTE_HEAD_CONFLICT",
              closeAttempt: true,
            });
          }
        } else {
          // A pre-existing head is a conflict even when it points at the
          // candidate: without this landing's durable prior-absence proof the
          // remote branch is never adopted.
          return this.#store.settleGithubPreflight(landing.id, {
            outcome: "failed",
            errorCode: "LANDING_REMOTE_HEAD_CONFLICT",
            closeAttempt: true,
          });
        }
      }
    } catch (error) {
      return this.#failPreflightRead(landing.id, headAdmission.requestId, error, signal);
    }

    if (headRequiredExact) {
      // The draft-PR preflight's fourth read proves the complete empty
      // pull-request list before the one POST may be admitted.
      const listAdmission = this.#store.admitGithubRequest(
        landing.id,
        operationId,
        "github.pull_requests.get",
      );
      try {
        const receipt = await gateway.readPullRequestByHead(
          coordinates,
          landing.headRef,
          landing.profile.baseBranch,
          { signal },
        );
        if (receipt === null) {
          this.#store.settleGithubRequest(landing.id, listAdmission.requestId, {
            outcome: "succeeded",
            httpStatus: 200,
            projection: { type: "pull_request_list", complete: true, count: 0, objects: [] },
            errorCode: null,
          });
        } else {
          const projection = pullRequestProjectionFromReceipt(receipt, coordinates);
          if (projection === null) {
            // A pull request exists for this head but does not conform to the
            // exact subject shape; the truthful read cannot be projected, so
            // the row records the refusal.
            this.#store.settleGithubRequest(landing.id, listAdmission.requestId, {
              outcome: "failed",
              httpStatus: 200,
              projection: null,
              errorCode: "LANDING_PULL_REQUEST_CONFLICT",
            });
          } else {
            // A pre-existing pull request is a conflict even when it conforms:
            // without this landing's durable prior-absence proof it is never
            // adopted.
            this.#store.settleGithubRequest(landing.id, listAdmission.requestId, {
              outcome: "succeeded",
              httpStatus: 200,
              projection: {
                type: "pull_request_list",
                complete: true,
                count: 1,
                objects: [projection],
              },
              errorCode: null,
            });
          }
          return this.#store.settleGithubPreflight(landing.id, {
            outcome: "failed",
            errorCode: "LANDING_PULL_REQUEST_CONFLICT",
            closeAttempt: true,
          });
        }
      } catch (error) {
        return this.#failPreflightRead(landing.id, listAdmission.requestId, error, signal);
      }
    }

    return this.#store.settleGithubPreflight(landing.id, {
      outcome: "completed",
      errorCode: null,
      closeAttempt: !chainEffect,
    });
  }

  /**
   * Settles the just-admitted pre-POST read of an effect operation as failed
   * with the bounded host code, then settles the operation. No mutating POST
   * has been admitted on this path, so the operation definitively had no
   * remote effect and fails back to its stable retry-safe stage.
   */
  #failGithubEffectRead(
    landingId: string,
    requestId: string,
    error: unknown,
    stage: "github.objects.upload" | "github.ref.create" | "github.pull_request.create",
  ): LandingStatusV1 {
    const errorCode = githubErrorCode(error, "LANDING_GITHUB_READ_FAILED");
    this.#store.settleGithubRequest(landingId, requestId, {
      outcome: "failed",
      httpStatus: githubErrorStatus(error),
      projection: null,
      errorCode,
    });
    const settlement = { outcome: "failed" as const, errorCode };
    return stage === "github.objects.upload"
      ? this.#store.settleGithubObjectsUpload(landingId, settlement)
      : stage === "github.ref.create"
        ? this.#store.settleGithubRemoteRef(landingId, settlement)
        : this.#store.settleGithubPullRequest(landingId, settlement);
  }

  /**
   * Performs one mutating object POST for the upload stage: admit, dispatch,
   * settle. A returned object name equal to the locally computed identity is
   * the only success; a contradicting response never proves the effect state,
   * so the row is ambiguous and the operation holds for reconciliation.
   */
  async #performObjectPost(
    landingId: string,
    operationId: string,
    kind: "github.blob.post" | "github.tree.post" | "github.commit.post",
    objectKind: "blob" | "tree" | "commit",
    expectedSha1: string,
    call: (signal?: AbortSignal) => Promise<{ readonly sha: string }>,
    signal?: AbortSignal,
  ): Promise<LandingStatusV1 | null> {
    const admission = this.#store.admitGithubRequest(landingId, operationId, kind);
    try {
      const receipt = await call(signal);
      if (receipt.sha === expectedSha1) {
        this.#store.settleGithubRequest(landingId, admission.requestId, {
          outcome: "succeeded",
          httpStatus: 201,
          projection: { type: "object", objectKind, sha1: receipt.sha },
          errorCode: null,
        });
        return null;
      }
      this.#store.settleGithubRequest(landingId, admission.requestId, {
        outcome: "ambiguous",
        httpStatus: null,
        projection: null,
        errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
      });
      return this.#store.settleGithubObjectsUpload(landingId, {
        outcome: "reconciliation_required",
        errorCode: "GITHUB_PROTOCOL_ERROR",
      });
    } catch (error) {
      const errorCode = githubErrorCode(error, "LANDING_GITHUB_POST_FAILED");
      const ambiguous = errorCode === "GITHUB_OUTCOME_AMBIGUOUS";
      this.#store.settleGithubRequest(landingId, admission.requestId, {
        outcome: ambiguous ? "ambiguous" : "failed",
        httpStatus: ambiguous ? null : githubErrorStatus(error),
        projection: null,
        errorCode: ambiguous ? "GITHUB_OUTCOME_AMBIGUOUS" : errorCode,
      });
      return this.#store.settleGithubObjectsUpload(landingId, {
        outcome: "reconciliation_required",
        errorCode: ambiguous ? "GITHUB_OUTCOME_AMBIGUOUS" : errorCode,
      });
    }
  }

  /**
   * Object upload (S2b-ii-b) — the first remote mutation. The actor read and
   * the durable observation commit before any POST; each blob, the tree, and
   * the commit are admitted with their byte-exact bodies before dispatch and
   * settled with the returned object name after. Content addressing makes a
   * proven interruption replayable byte-identically, and no object ever
   * becomes reachable as a side effect.
   */
  async #executeGithubObjectsUpload(
    landingId: string,
    signal?: AbortSignal,
  ): Promise<LandingStatusV1> {
    const status = this.#store.getLandingStatus(landingId);
    const landing = status.landing;
    invariant(
      landing.state === "local_ready" &&
        status.decision?.decision === "approve" &&
        landing.landingSha256 !== null &&
        landing.candidateTreeSha1 !== null &&
        landing.candidateCommitSha1 !== null &&
        landing.candidateCommitPayloadSha256 !== null,
      "INVALID_LANDING_STATE",
      "Landing is not local-ready with a complete approved candidate",
    );
    assertLandingCredentialEnvironmentAllowed(
      landing.profile,
      this.#landingCredentialEnvironmentNames,
    );
    const eligibility = this.#landingEligibilityFor(landing);
    const candidateOperation = status.operations.find(
      (operation) =>
        operation.kind === "candidate.prepare" &&
        operation.status === "completed" &&
        operation.result?.outcome === "completed",
    );
    const recordedManifest =
      candidateOperation?.result?.value !== null &&
      candidateOperation?.result?.value !== undefined &&
      "candidateObjectManifestSha256" in candidateOperation.result.value
        ? candidateOperation.result.value.candidateObjectManifestSha256
        : undefined;
    const manifest = deriveCandidateObjectManifestV1({
      baseCommitSha1: landing.baseCommitSha1,
      baseTreeSha1: landing.baseTreeSha1,
      candidateTreeSha1: landing.candidateTreeSha1,
      candidateCommitSha1: landing.candidateCommitSha1,
      candidateCommitPayloadSha256: landing.candidateCommitPayloadSha256,
      changedPaths: landing.changedPaths,
      checkpointFiles: eligibility.checkpointFiles,
    });
    invariant(
      typeof recordedManifest === "string" && digestLandingRecord(manifest) === recordedManifest,
      "LANDING_CANDIDATE_MISMATCH",
      "Landing candidate manifest does not match its durable authority",
    );
    const admitted = this.#store.startGithubObjectsUpload(landing.id);
    const operationId = admitted.operationId;

    const credential = this.#landingCredentialEnvironment(landing.profile.credentialRef.name);
    if (credential === undefined || credential.length === 0) {
      return this.#store.settleGithubObjectsUpload(landing.id, {
        outcome: "failed",
        errorCode: "LANDING_CREDENTIAL_MISSING",
      });
    }
    let gateway: LandingGithubGateway;
    try {
      gateway = this.#landingGithubGateway(credential);
    } catch (error) {
      return this.#store.settleGithubObjectsUpload(landing.id, {
        outcome: "failed",
        errorCode: githubErrorCode(error, "LANDING_GITHUB_GATEWAY_INVALID"),
      });
    }
    const coordinates = { owner: landing.profile.owner, repository: landing.profile.repository };

    const actorAdmission = this.#store.admitGithubRequest(
      landing.id,
      operationId,
      "github.actor.get",
    );
    try {
      const receipt = await gateway.readActor(landing.profile.expectedActor, { signal });
      this.#store.settleGithubRequest(landing.id, actorAdmission.requestId, {
        outcome: "succeeded",
        httpStatus: 200,
        projection: { type: "actor", login: receipt.login },
        errorCode: null,
      });
    } catch (error) {
      return this.#failGithubEffectRead(
        landing.id,
        actorAdmission.requestId,
        error,
        "github.objects.upload",
      );
    }
    // The pre-effect observation — the one actor fact — commits before the
    // first mutating POST is admitted.
    this.#store.recordGithubOperationObservation(landing.id, operationId);

    for (const entry of manifest.entries) {
      if (entry.op === "delete") continue;
      const file = eligibility.checkpointFiles.find((candidate) => candidate.path === entry.path);
      invariant(
        file !== undefined && file.approvedBase64 !== null && entry.blobSha1 !== null,
        "LANDING_CANDIDATE_MISMATCH",
        "Checkpoint bytes are missing for a non-deleted manifest entry",
      );
      const expectedBlobSha1 = entry.blobSha1;
      const held = await this.#performObjectPost(
        landing.id,
        operationId,
        "github.blob.post",
        "blob",
        expectedBlobSha1,
        (postSignal) =>
          gateway.createBlob(coordinates, file.approvedBase64 ?? "", {
            signal: postSignal,
          }),
        signal,
      );
      if (held !== null) return held;
    }

    const treeEntries = manifest.entries.map((entry) => ({
      path: entry.path,
      mode: "100644",
      blobSha: entry.blobSha1,
    }));
    const candidateTreeSha1 = landing.candidateTreeSha1;
    const heldAtTree = await this.#performObjectPost(
      landing.id,
      operationId,
      "github.tree.post",
      "tree",
      candidateTreeSha1,
      (postSignal) =>
        gateway.createTree(coordinates, treeEntries, landing.baseTreeSha1, {
          signal: postSignal,
        }),
      signal,
    );
    if (heldAtTree !== null) return heldAtTree;

    const candidateCommitSha1 = landing.candidateCommitSha1;
    const party = {
      name: landing.profile.commitIdentity.name,
      email: landing.profile.commitIdentity.email,
      date: landing.commitIso8601,
    };
    const heldAtCommit = await this.#performObjectPost(
      landing.id,
      operationId,
      "github.commit.post",
      "commit",
      candidateCommitSha1,
      (postSignal) =>
        gateway.createCommit(
          coordinates,
          {
            message: landing.commitMessage,
            treeSha: candidateTreeSha1,
            parentShas: [landing.baseCommitSha1],
            author: party,
            committer: party,
          },
          { signal: postSignal },
        ),
      signal,
    );
    if (heldAtCommit !== null) return heldAtCommit;

    return this.#store.settleGithubObjectsUpload(landing.id, {
      outcome: "completed",
      errorCode: null,
    });
  }

  /**
   * The absent-only remote-ref creation (S2b-ii-b), mirroring the local CAS
   * discipline: the three pre-effect reads and the durable observation commit
   * before the one POST; the fixed post-read suffix then proves the outcome.
   * `created` and `reconciled` are evidence-derived; a definitive no-effect
   * suffix (absent head, unchanged base) fails back to `objects_ready` for an
   * explicit retry; drift or conflict holds `reconciliation_required`.
   */
  async #executeGithubRemoteRefCreation(
    landingId: string,
    signal?: AbortSignal,
  ): Promise<LandingStatusV1> {
    const status = this.#store.getLandingStatus(landingId);
    const landing = status.landing;
    invariant(
      landing.state === "objects_ready" &&
        status.decision?.decision === "approve" &&
        landing.landingSha256 !== null &&
        landing.candidateCommitSha1 !== null,
      "INVALID_LANDING_STATE",
      "Landing is not objects-ready with a complete approved candidate",
    );
    assertLandingCredentialEnvironmentAllowed(
      landing.profile,
      this.#landingCredentialEnvironmentNames,
    );
    this.#landingEligibilityFor(landing);
    const admitted = this.#store.startGithubRemoteRef(landing.id);
    const operationId = admitted.operationId;

    const credential = this.#landingCredentialEnvironment(landing.profile.credentialRef.name);
    if (credential === undefined || credential.length === 0) {
      return this.#store.settleGithubRemoteRef(landing.id, {
        outcome: "failed",
        errorCode: "LANDING_CREDENTIAL_MISSING",
      });
    }
    let gateway: LandingGithubGateway;
    try {
      gateway = this.#landingGithubGateway(credential);
    } catch (error) {
      return this.#store.settleGithubRemoteRef(landing.id, {
        outcome: "failed",
        errorCode: githubErrorCode(error, "LANDING_GITHUB_GATEWAY_INVALID"),
      });
    }
    const coordinates = { owner: landing.profile.owner, repository: landing.profile.repository };
    const baseRef = `refs/heads/${landing.profile.baseBranch}`;

    const actorAdmission = this.#store.admitGithubRequest(
      landing.id,
      operationId,
      "github.actor.get",
    );
    try {
      const receipt = await gateway.readActor(landing.profile.expectedActor, { signal });
      this.#store.settleGithubRequest(landing.id, actorAdmission.requestId, {
        outcome: "succeeded",
        httpStatus: 200,
        projection: { type: "actor", login: receipt.login },
        errorCode: null,
      });
    } catch (error) {
      return this.#failGithubEffectRead(
        landing.id,
        actorAdmission.requestId,
        error,
        "github.ref.create",
      );
    }

    const baseAdmission = this.#store.admitGithubRequest(
      landing.id,
      operationId,
      "github.base_ref.get",
    );
    try {
      const receipt = await gateway.readBaseReference(coordinates, baseRef, { signal });
      if (receipt === null) {
        this.#store.settleGithubRequest(landing.id, baseAdmission.requestId, {
          outcome: "failed",
          httpStatus: 404,
          projection: null,
          errorCode: "LANDING_REMOTE_BASE_MISSING",
        });
        return this.#store.settleGithubRemoteRef(landing.id, {
          outcome: "failed",
          errorCode: "LANDING_REMOTE_BASE_MISSING",
        });
      }
      this.#store.settleGithubRequest(landing.id, baseAdmission.requestId, {
        outcome: "succeeded",
        httpStatus: 200,
        projection: { type: "ref", state: "direct", ref: baseRef, sha1: receipt.sha },
        errorCode: null,
      });
      if (receipt.sha !== landing.baseCommitSha1) {
        return this.#store.settleGithubRemoteRef(landing.id, {
          outcome: "failed",
          errorCode: "LANDING_REMOTE_BASE_CHANGED",
        });
      }
    } catch (error) {
      return this.#failGithubEffectRead(
        landing.id,
        baseAdmission.requestId,
        error,
        "github.ref.create",
      );
    }

    const headAdmission = this.#store.admitGithubRequest(
      landing.id,
      operationId,
      "github.head_ref.get",
    );
    try {
      const receipt = await gateway.readReference(coordinates, landing.headRef, { signal });
      if (receipt === null) {
        this.#store.settleGithubRequest(landing.id, headAdmission.requestId, {
          outcome: "succeeded",
          httpStatus: 404,
          projection: { type: "ref", state: "absent", ref: landing.headRef, sha1: null },
          errorCode: null,
        });
      } else {
        this.#store.settleGithubRequest(landing.id, headAdmission.requestId, {
          outcome: "succeeded",
          httpStatus: 200,
          projection: { type: "ref", state: "direct", ref: landing.headRef, sha1: receipt.sha },
          errorCode: null,
        });
        // A pre-existing head is a conflict even at the candidate: without
        // this landing's durable prior-absence proof it is never adopted.
        return this.#store.settleGithubRemoteRef(landing.id, {
          outcome: "failed",
          errorCode: "LANDING_REMOTE_HEAD_CONFLICT",
        });
      }
    } catch (error) {
      return this.#failGithubEffectRead(
        landing.id,
        headAdmission.requestId,
        error,
        "github.ref.create",
      );
    }
    // The exact observations and the absent-only intent are durable before the
    // compare-and-swap POST.
    this.#store.recordGithubOperationObservation(landing.id, operationId);

    const postAdmission = this.#store.admitGithubRequest(
      landing.id,
      operationId,
      "github.ref.post",
    );
    try {
      const receipt = await gateway.createAbsentRef(
        coordinates,
        landing.headRef,
        landing.candidateCommitSha1,
        { signal },
      );
      if (receipt.ref === landing.headRef && receipt.sha === landing.candidateCommitSha1) {
        this.#store.settleGithubRequest(landing.id, postAdmission.requestId, {
          outcome: "succeeded",
          httpStatus: 201,
          projection: { type: "object", objectKind: "ref", sha1: receipt.sha },
          errorCode: null,
        });
      } else {
        this.#store.settleGithubRequest(landing.id, postAdmission.requestId, {
          outcome: "ambiguous",
          httpStatus: null,
          projection: null,
          errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
        });
      }
    } catch (error) {
      const errorCode = githubErrorCode(error, "LANDING_GITHUB_POST_FAILED");
      const ambiguous = errorCode === "GITHUB_OUTCOME_AMBIGUOUS";
      this.#store.settleGithubRequest(landing.id, postAdmission.requestId, {
        outcome: ambiguous ? "ambiguous" : "failed",
        httpStatus: ambiguous ? null : githubErrorStatus(error),
        projection: null,
        errorCode: ambiguous ? "GITHUB_OUTCOME_AMBIGUOUS" : errorCode,
      });
    }

    // The fixed post-read suffix always runs after the settled POST: only its
    // proof decides created, reconciled, retryable failure, or the hold.
    const suffixHeadAdmission = this.#store.admitGithubRequest(
      landing.id,
      operationId,
      "github.head_ref.get",
    );
    try {
      const receipt = await gateway.readReference(coordinates, landing.headRef, { signal });
      this.#store.settleGithubRequest(landing.id, suffixHeadAdmission.requestId, {
        outcome: "succeeded",
        httpStatus: receipt === null ? 404 : 200,
        projection:
          receipt === null
            ? { type: "ref", state: "absent", ref: landing.headRef, sha1: null }
            : { type: "ref", state: "direct", ref: landing.headRef, sha1: receipt.sha },
        errorCode: null,
      });
    } catch (error) {
      const errorCode = githubErrorCode(error, "LANDING_GITHUB_READ_FAILED");
      this.#store.settleGithubRequest(landing.id, suffixHeadAdmission.requestId, {
        outcome: "failed",
        httpStatus: githubErrorStatus(error),
        projection: null,
        errorCode,
      });
      return this.#store.settleGithubRemoteRef(landing.id, {
        outcome: "reconciliation_required",
        errorCode,
      });
    }
    const suffixBaseAdmission = this.#store.admitGithubRequest(
      landing.id,
      operationId,
      "github.base_ref.get",
    );
    try {
      const receipt = await gateway.readBaseReference(coordinates, baseRef, { signal });
      if (receipt === null) {
        this.#store.settleGithubRequest(landing.id, suffixBaseAdmission.requestId, {
          outcome: "failed",
          httpStatus: 404,
          projection: null,
          errorCode: "LANDING_REMOTE_BASE_MISSING",
        });
        return this.#store.settleGithubRemoteRef(landing.id, {
          outcome: "reconciliation_required",
          errorCode: "LANDING_REMOTE_BASE_MISSING",
        });
      }
      this.#store.settleGithubRequest(landing.id, suffixBaseAdmission.requestId, {
        outcome: "succeeded",
        httpStatus: 200,
        projection: { type: "ref", state: "direct", ref: baseRef, sha1: receipt.sha },
        errorCode: null,
      });
    } catch (error) {
      const errorCode = githubErrorCode(error, "LANDING_GITHUB_READ_FAILED");
      this.#store.settleGithubRequest(landing.id, suffixBaseAdmission.requestId, {
        outcome: "failed",
        httpStatus: githubErrorStatus(error),
        projection: null,
        errorCode,
      });
      return this.#store.settleGithubRemoteRef(landing.id, {
        outcome: "reconciliation_required",
        errorCode,
      });
    }

    return this.#settleRemoteRefFromRows(landing.id);
  }

  /**
   * Derives the remote-ref operation outcome from its durable settled rows —
   * the store re-derives legality and the residue when it settles, so a
   * coordinator mis-derivation fails closed rather than persisting.
   */
  #settleRemoteRefFromRows(landingId: string): LandingStatusV1 {
    const status = this.#store.getLandingStatus(landingId);
    const landing = status.landing;
    const operation = status.operations.find(
      (entry) => entry.kind === "github.ref.create" && entry.status === "started",
    );
    invariant(
      operation !== undefined && landing.candidateCommitSha1 !== null,
      "LANDING_RECORD_INVALID",
      "Remote-ref settlement lacks its active operation",
    );
    const rows = status.httpRequests
      .filter((entry) => entry.operationId === operation.id)
      .sort((left, right) => left.requestOrdinal - right.requestOrdinal);
    const post = rows.find((entry) => entry.kind === "github.ref.post");
    const suffixHead = rows.filter((entry) => entry.kind === "github.head_ref.get").at(-1);
    const suffixBase = rows.filter((entry) => entry.kind === "github.base_ref.get").at(-1);
    const headProjection =
      suffixHead?.result?.projection?.type === "ref" ? suffixHead.result.projection : null;
    const baseProjection =
      suffixBase?.result?.projection?.type === "ref" ? suffixBase.result.projection : null;
    const baseUnchanged =
      baseProjection?.state === "direct" && baseProjection.sha1 === landing.baseCommitSha1;
    const headAbsent = headProjection?.state === "absent";
    const headExact =
      headProjection?.state === "direct" && headProjection.sha1 === landing.candidateCommitSha1;
    if (
      (post?.outcome === "succeeded" || post?.outcome === "ambiguous") &&
      headExact &&
      baseUnchanged
    ) {
      return this.#store.settleGithubRemoteRef(landingId, {
        outcome: "completed",
        errorCode: null,
      });
    }
    if (headAbsent && baseUnchanged) {
      // The suffix definitively proves the POST had no effect, so the landing
      // fails back to `objects_ready` and an explicit resume retries.
      return this.#store.settleGithubRemoteRef(landingId, {
        outcome: "failed",
        errorCode: post?.errorCode ?? "LANDING_REMOTE_REF_OUTCOME_UNPROVEN",
      });
    }
    const errorCode = !baseUnchanged
      ? "LANDING_REMOTE_BASE_CHANGED"
      : headProjection?.state === "direct"
        ? "LANDING_REMOTE_HEAD_CONFLICT"
        : (suffixHead?.errorCode ?? "LANDING_REMOTE_REF_OUTCOME_AMBIGUOUS");
    return this.#store.settleGithubRemoteRef(landingId, {
      outcome: "reconciliation_required",
      errorCode,
    });
  }

  /**
   * Draft pull-request creation (S2b-ii-c) — the at-most-once mutation. The
   * four pre-effect reads must prove the actor, the unchanged base, the exact
   * candidate head, and the complete empty pull-request list before the one
   * POST is admitted; the durable observation commits before it. A lost or
   * contradicted response is never retried: the fixed suffix reads decide
   * created (POST succeeded with the exact projection), reconciled (POST
   * ambiguous with the suffix list proving exactly one conforming pull
   * request), a definitive pre-POST refusal, or the reconciliation hold. The
   * immutable receipt commits in the settlement's one transaction.
   */
  async #executeGithubDraftPrCreation(
    landingId: string,
    signal?: AbortSignal,
  ): Promise<LandingStatusV1> {
    const status = this.#store.getLandingStatus(landingId);
    const landing = status.landing;
    invariant(
      landing.state === "remote_ready" &&
        status.decision?.decision === "approve" &&
        landing.landingSha256 !== null &&
        landing.candidateCommitSha1 !== null &&
        landing.pullRequestBodySha256 !== null,
      "INVALID_LANDING_STATE",
      "Landing is not remote-ready with a complete approved candidate",
    );
    assertLandingCredentialEnvironmentAllowed(
      landing.profile,
      this.#landingCredentialEnvironmentNames,
    );
    this.#landingEligibilityFor(landing);
    // The exact body re-derives from the durable landing authority (the
    // loader re-validates its digest); it is never stored or re-read from the
    // provider.
    const pullRequestBody = this.#store.getRunLandingProjection(landing.runId).landing
      ?.pullRequestBody;
    invariant(
      typeof pullRequestBody === "string",
      "LANDING_RECORD_INVALID",
      "Landing pull-request body did not re-derive from its authority",
    );
    const admitted = this.#store.startGithubPullRequest(landing.id);
    const operationId = admitted.operationId;

    const credential = this.#landingCredentialEnvironment(landing.profile.credentialRef.name);
    if (credential === undefined || credential.length === 0) {
      return this.#store.settleGithubPullRequest(landing.id, {
        outcome: "failed",
        errorCode: "LANDING_CREDENTIAL_MISSING",
      });
    }
    let gateway: LandingGithubGateway;
    try {
      gateway = this.#landingGithubGateway(credential);
    } catch (error) {
      return this.#store.settleGithubPullRequest(landing.id, {
        outcome: "failed",
        errorCode: githubErrorCode(error, "LANDING_GITHUB_GATEWAY_INVALID"),
      });
    }
    const coordinates = { owner: landing.profile.owner, repository: landing.profile.repository };
    const baseRef = `refs/heads/${landing.profile.baseBranch}`;

    const actorAdmission = this.#store.admitGithubRequest(
      landing.id,
      operationId,
      "github.actor.get",
    );
    try {
      const receipt = await gateway.readActor(landing.profile.expectedActor, { signal });
      this.#store.settleGithubRequest(landing.id, actorAdmission.requestId, {
        outcome: "succeeded",
        httpStatus: 200,
        projection: { type: "actor", login: receipt.login },
        errorCode: null,
      });
    } catch (error) {
      return this.#failGithubEffectRead(
        landing.id,
        actorAdmission.requestId,
        error,
        "github.pull_request.create",
      );
    }

    const baseAdmission = this.#store.admitGithubRequest(
      landing.id,
      operationId,
      "github.base_ref.get",
    );
    try {
      const receipt = await gateway.readBaseReference(coordinates, baseRef, { signal });
      if (receipt === null) {
        this.#store.settleGithubRequest(landing.id, baseAdmission.requestId, {
          outcome: "failed",
          httpStatus: 404,
          projection: null,
          errorCode: "LANDING_REMOTE_BASE_MISSING",
        });
        return this.#store.settleGithubPullRequest(landing.id, {
          outcome: "failed",
          errorCode: "LANDING_REMOTE_BASE_MISSING",
        });
      }
      this.#store.settleGithubRequest(landing.id, baseAdmission.requestId, {
        outcome: "succeeded",
        httpStatus: 200,
        projection: { type: "ref", state: "direct", ref: baseRef, sha1: receipt.sha },
        errorCode: null,
      });
      if (receipt.sha !== landing.baseCommitSha1) {
        return this.#store.settleGithubPullRequest(landing.id, {
          outcome: "failed",
          errorCode: "LANDING_REMOTE_BASE_CHANGED",
        });
      }
    } catch (error) {
      return this.#failGithubEffectRead(
        landing.id,
        baseAdmission.requestId,
        error,
        "github.pull_request.create",
      );
    }

    const headAdmission = this.#store.admitGithubRequest(
      landing.id,
      operationId,
      "github.head_ref.get",
    );
    try {
      const receipt = await gateway.readReference(coordinates, landing.headRef, { signal });
      if (receipt === null) {
        // The remote-ref stage proved this branch; its absence now is a
        // retry-safe pre-POST refusal.
        this.#store.settleGithubRequest(landing.id, headAdmission.requestId, {
          outcome: "succeeded",
          httpStatus: 404,
          projection: { type: "ref", state: "absent", ref: landing.headRef, sha1: null },
          errorCode: null,
        });
        return this.#store.settleGithubPullRequest(landing.id, {
          outcome: "failed",
          errorCode: "LANDING_REMOTE_HEAD_MISSING",
        });
      }
      this.#store.settleGithubRequest(landing.id, headAdmission.requestId, {
        outcome: "succeeded",
        httpStatus: 200,
        projection: { type: "ref", state: "direct", ref: landing.headRef, sha1: receipt.sha },
        errorCode: null,
      });
      if (receipt.sha !== landing.candidateCommitSha1) {
        return this.#store.settleGithubPullRequest(landing.id, {
          outcome: "failed",
          errorCode: "LANDING_REMOTE_HEAD_CONFLICT",
        });
      }
    } catch (error) {
      return this.#failGithubEffectRead(
        landing.id,
        headAdmission.requestId,
        error,
        "github.pull_request.create",
      );
    }

    const listAdmission = this.#store.admitGithubRequest(
      landing.id,
      operationId,
      "github.pull_requests.get",
    );
    try {
      const receipt = await gateway.readPullRequestByHead(
        coordinates,
        landing.headRef,
        landing.profile.baseBranch,
        { signal },
      );
      if (receipt === null) {
        this.#store.settleGithubRequest(landing.id, listAdmission.requestId, {
          outcome: "succeeded",
          httpStatus: 200,
          projection: { type: "pull_request_list", complete: true, count: 0, objects: [] },
          errorCode: null,
        });
      } else {
        const projection = pullRequestProjectionFromReceipt(receipt, coordinates);
        if (projection === null) {
          this.#store.settleGithubRequest(landing.id, listAdmission.requestId, {
            outcome: "failed",
            httpStatus: 200,
            projection: null,
            errorCode: "LANDING_PULL_REQUEST_CONFLICT",
          });
        } else {
          this.#store.settleGithubRequest(landing.id, listAdmission.requestId, {
            outcome: "succeeded",
            httpStatus: 200,
            projection: {
              type: "pull_request_list",
              complete: true,
              count: 1,
              objects: [projection],
            },
            errorCode: null,
          });
        }
        // A pre-existing pull request on this head is a definitive pre-POST
        // refusal: the one POST admission stays unspent and the landing
        // resumes at remote_ready once the operator clears the conflict.
        return this.#store.settleGithubPullRequest(landing.id, {
          outcome: "failed",
          errorCode: "LANDING_PULL_REQUEST_CONFLICT",
        });
      }
    } catch (error) {
      return this.#failGithubEffectRead(
        landing.id,
        listAdmission.requestId,
        error,
        "github.pull_request.create",
      );
    }
    // The exact observations and the durable prior absence commit before the
    // one POST is admitted.
    this.#store.recordGithubOperationObservation(landing.id, operationId);

    const postAdmission = this.#store.admitGithubRequest(
      landing.id,
      operationId,
      "github.pull_request.post",
    );
    try {
      const receipt = await gateway.createDraftPullRequest(
        coordinates,
        {
          title: landing.pullRequestTitle,
          body: pullRequestBody,
          headRef: landing.headRef,
          baseBranch: landing.profile.baseBranch,
        },
        { signal },
      );
      const projection = pullRequestProjectionFromReceipt(receipt, coordinates);
      if (projection !== null && pullRequestProjectionMatchesLanding(projection, landing)) {
        this.#store.settleGithubRequest(landing.id, postAdmission.requestId, {
          outcome: "succeeded",
          httpStatus: 201,
          projection,
          errorCode: null,
        });
      } else {
        // A contradicting response never proves the effect state, so the row
        // is ambiguous and only the suffix reads may decide.
        this.#store.settleGithubRequest(landing.id, postAdmission.requestId, {
          outcome: "ambiguous",
          httpStatus: null,
          projection: null,
          errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
        });
      }
    } catch (error) {
      const errorCode = githubErrorCode(error, "LANDING_GITHUB_POST_FAILED");
      const ambiguous = errorCode === "GITHUB_OUTCOME_AMBIGUOUS";
      this.#store.settleGithubRequest(landing.id, postAdmission.requestId, {
        outcome: ambiguous ? "ambiguous" : "failed",
        httpStatus: ambiguous ? null : githubErrorStatus(error),
        projection: null,
        errorCode: ambiguous ? "GITHUB_OUTCOME_AMBIGUOUS" : errorCode,
      });
    }

    // The fixed post-read suffix always runs after the settled POST: only its
    // proof decides created, reconciled, or the hold.
    const suffixBaseAdmission = this.#store.admitGithubRequest(
      landing.id,
      operationId,
      "github.base_ref.get",
    );
    try {
      const receipt = await gateway.readBaseReference(coordinates, baseRef, { signal });
      if (receipt === null) {
        this.#store.settleGithubRequest(landing.id, suffixBaseAdmission.requestId, {
          outcome: "failed",
          httpStatus: 404,
          projection: null,
          errorCode: "LANDING_REMOTE_BASE_MISSING",
        });
        return this.#store.settleGithubPullRequest(landing.id, {
          outcome: "reconciliation_required",
          errorCode: "LANDING_REMOTE_BASE_MISSING",
        });
      }
      this.#store.settleGithubRequest(landing.id, suffixBaseAdmission.requestId, {
        outcome: "succeeded",
        httpStatus: 200,
        projection: { type: "ref", state: "direct", ref: baseRef, sha1: receipt.sha },
        errorCode: null,
      });
    } catch (error) {
      const errorCode = githubErrorCode(error, "LANDING_GITHUB_READ_FAILED");
      this.#store.settleGithubRequest(landing.id, suffixBaseAdmission.requestId, {
        outcome: "failed",
        httpStatus: githubErrorStatus(error),
        projection: null,
        errorCode,
      });
      return this.#store.settleGithubPullRequest(landing.id, {
        outcome: "reconciliation_required",
        errorCode,
      });
    }
    const suffixHeadAdmission = this.#store.admitGithubRequest(
      landing.id,
      operationId,
      "github.head_ref.get",
    );
    try {
      const receipt = await gateway.readReference(coordinates, landing.headRef, { signal });
      this.#store.settleGithubRequest(landing.id, suffixHeadAdmission.requestId, {
        outcome: "succeeded",
        httpStatus: receipt === null ? 404 : 200,
        projection:
          receipt === null
            ? { type: "ref", state: "absent", ref: landing.headRef, sha1: null }
            : { type: "ref", state: "direct", ref: landing.headRef, sha1: receipt.sha },
        errorCode: null,
      });
    } catch (error) {
      const errorCode = githubErrorCode(error, "LANDING_GITHUB_READ_FAILED");
      this.#store.settleGithubRequest(landing.id, suffixHeadAdmission.requestId, {
        outcome: "failed",
        httpStatus: githubErrorStatus(error),
        projection: null,
        errorCode,
      });
      return this.#store.settleGithubPullRequest(landing.id, {
        outcome: "reconciliation_required",
        errorCode,
      });
    }
    const suffixListAdmission = this.#store.admitGithubRequest(
      landing.id,
      operationId,
      "github.pull_requests.get",
    );
    try {
      const receipt = await gateway.readPullRequestByHead(
        coordinates,
        landing.headRef,
        landing.profile.baseBranch,
        { signal },
      );
      if (receipt === null) {
        this.#store.settleGithubRequest(landing.id, suffixListAdmission.requestId, {
          outcome: "succeeded",
          httpStatus: 200,
          projection: { type: "pull_request_list", complete: true, count: 0, objects: [] },
          errorCode: null,
        });
      } else {
        const projection = pullRequestProjectionFromReceipt(receipt, coordinates);
        if (projection === null) {
          // The list read succeeded but its one pull request no longer
          // conforms to the exact subject shape, so it cannot be adopted.
          this.#store.settleGithubRequest(landing.id, suffixListAdmission.requestId, {
            outcome: "failed",
            httpStatus: 200,
            projection: null,
            errorCode: "LANDING_PULL_REQUEST_OUTCOME_AMBIGUOUS",
          });
        } else {
          this.#store.settleGithubRequest(landing.id, suffixListAdmission.requestId, {
            outcome: "succeeded",
            httpStatus: 200,
            projection: {
              type: "pull_request_list",
              complete: true,
              count: 1,
              objects: [projection],
            },
            errorCode: null,
          });
        }
      }
    } catch (error) {
      const errorCode = githubErrorCode(error, "LANDING_GITHUB_READ_FAILED");
      this.#store.settleGithubRequest(landing.id, suffixListAdmission.requestId, {
        outcome: "failed",
        httpStatus: githubErrorStatus(error),
        projection: null,
        errorCode,
      });
      return this.#store.settleGithubPullRequest(landing.id, {
        outcome: "reconciliation_required",
        errorCode,
      });
    }

    return this.#settlePullRequestFromRows(landing.id);
  }

  /**
   * Derives the pull-request operation outcome from its durable settled rows —
   * the store re-derives legality and the residue when it settles, so a
   * coordinator mis-derivation fails closed rather than persisting.
   */
  #settlePullRequestFromRows(landingId: string): LandingStatusV1 {
    const status = this.#store.getLandingStatus(landingId);
    const landing = status.landing;
    const operation = status.operations.find(
      (entry) => entry.kind === "github.pull_request.create" && entry.status === "started",
    );
    invariant(
      operation !== undefined && landing.candidateCommitSha1 !== null,
      "LANDING_RECORD_INVALID",
      "Pull-request settlement lacks its active operation",
    );
    const rows = status.httpRequests
      .filter((entry) => entry.operationId === operation.id)
      .sort((left, right) => left.requestOrdinal - right.requestOrdinal);
    const post = rows.find((entry) => entry.kind === "github.pull_request.post");
    const suffixBase = rows.filter((entry) => entry.kind === "github.base_ref.get").at(-1);
    const suffixHead = rows.filter((entry) => entry.kind === "github.head_ref.get").at(-1);
    const suffixList = rows.filter((entry) => entry.kind === "github.pull_requests.get").at(-1);
    const baseProjection =
      suffixBase?.result?.projection?.type === "ref" ? suffixBase.result.projection : null;
    const headProjection =
      suffixHead?.result?.projection?.type === "ref" ? suffixHead.result.projection : null;
    const listProjection =
      suffixList?.result?.projection?.type === "pull_request_list"
        ? suffixList.result.projection
        : null;
    const baseUnchanged =
      baseProjection?.state === "direct" && baseProjection.sha1 === landing.baseCommitSha1;
    const headExact =
      headProjection?.state === "direct" && headProjection.sha1 === landing.candidateCommitSha1;
    const provenPullRequest =
      listProjection !== null && listProjection.complete && listProjection.count === 1
        ? (listProjection.objects[0] ?? null)
        : null;
    if (
      (post?.outcome === "succeeded" || post?.outcome === "ambiguous") &&
      baseUnchanged &&
      headExact &&
      provenPullRequest !== null &&
      pullRequestProjectionMatchesLanding(provenPullRequest, landing)
    ) {
      return this.#store.settleGithubPullRequest(landingId, {
        outcome: "completed",
        errorCode: null,
      });
    }
    if (post === undefined) {
      // Unreachable from the executor (every pre-POST refusal returns before
      // the admission); kept as the fail-closed safety net.
      return this.#store.settleGithubPullRequest(landingId, {
        outcome: "failed",
        errorCode:
          rows.find((row) => row.outcome === "failed")?.errorCode ??
          "LANDING_PULL_REQUEST_OUTCOME_UNPROVEN",
      });
    }
    const errorCode = !baseUnchanged
      ? "LANDING_REMOTE_BASE_CHANGED"
      : !headExact
        ? headProjection?.state === "absent"
          ? "LANDING_REMOTE_HEAD_MISSING"
          : "LANDING_REMOTE_HEAD_CONFLICT"
        : (post.errorCode ?? suffixList?.errorCode ?? "LANDING_PULL_REQUEST_OUTCOME_AMBIGUOUS");
    return this.#store.settleGithubPullRequest(landingId, {
      outcome: "reconciliation_required",
      errorCode,
    });
  }

  /**
   * Object-upload reconciliation performs no fresh reads: the immutable
   * subject's durable rows either prove every object landed (advancing to
   * `objects_ready`) or authorize the byte-identical retry at `local_ready`.
   */
  async #executeObjectUploadReconciliation(
    landingId: string,
    operationId: string,
  ): Promise<LandingStatusV1> {
    const status = this.#store.getLandingStatus(landingId);
    const landing = status.landing;
    invariant(
      landing.state === "reconciliation_required" &&
        landing.resumeState === "local_ready" &&
        status.operations.some(
          (operation) =>
            operation.id === operationId &&
            operation.kind === "landing.reconcile" &&
            operation.status === "started",
        ),
      "INVALID_LANDING_STATE",
      "Landing is not reconciling the admitted object-upload subject",
    );
    assertLandingCredentialEnvironmentAllowed(
      landing.profile,
      this.#landingCredentialEnvironmentNames,
    );
    this.#landingEligibilityFor(landing);
    // The subject-binding observation is durable before the outcome is settled.
    this.#store.recordGithubOperationObservation(landing.id, operationId);
    const observed = this.#store.getLandingStatus(landingId);
    const input = observed.operations.find((operation) => operation.id === operationId)?.request
      .input;
    invariant(
      input !== undefined && "subjectOperationId" in input,
      "LANDING_RECORD_INVALID",
      "Object-upload reconciliation lacks its subject binding",
    );
    const subject = observed.operations.find(
      (operation) => operation.id === input.subjectOperationId,
    );
    invariant(
      subject !== undefined,
      "LANDING_RECORD_INVALID",
      "Object-upload reconciliation subject is missing",
    );
    const subjectRows = observed.httpRequests.filter(
      (row) => row.operationId === subject.id && row.status === "settled",
    );
    const posts = subjectRows.filter((row) => row.method === "POST");
    const complete =
      posts.length > 0 &&
      posts.every((row) => row.outcome === "succeeded") &&
      subjectRows.some((row) => row.kind === "github.commit.post" && row.outcome === "succeeded");
    return this.#store.settleObjectUploadReconciliation(landing.id, {
      outcome: complete ? "objects_ready" : "retry_local_ready",
      errorCode: null,
    });
  }

  /**
   * Remote-ref reconciliation re-reads the actor, the exact base, and the head
   * through the durable machinery: unchanged base + freshly absent head permits
   * one more absent-only POST from `objects_ready`; unchanged base + the exact
   * candidate head reconciles to `remote_ready`; drift, conflict, or uncertain
   * visibility holds with the honestly derived residue.
   */
  async #executeRemoteRefReconciliation(
    landingId: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<LandingStatusV1> {
    const status = this.#store.getLandingStatus(landingId);
    const landing = status.landing;
    invariant(
      landing.state === "reconciliation_required" &&
        landing.resumeState === "objects_ready" &&
        landing.candidateCommitSha1 !== null &&
        status.operations.some(
          (operation) =>
            operation.id === operationId &&
            operation.kind === "landing.reconcile" &&
            operation.status === "started",
        ),
      "INVALID_LANDING_STATE",
      "Landing is not reconciling the admitted remote-ref subject",
    );
    assertLandingCredentialEnvironmentAllowed(
      landing.profile,
      this.#landingCredentialEnvironmentNames,
    );
    this.#landingEligibilityFor(landing);
    const credential = this.#landingCredentialEnvironment(landing.profile.credentialRef.name);
    if (credential === undefined || credential.length === 0) {
      return this.#store.settleRemoteRefReconciliation(landing.id, {
        outcome: "reconciliation_required",
        errorCode: "LANDING_CREDENTIAL_MISSING",
      });
    }
    let gateway: LandingGithubGateway;
    try {
      gateway = this.#landingGithubGateway(credential);
    } catch (error) {
      return this.#store.settleRemoteRefReconciliation(landing.id, {
        outcome: "reconciliation_required",
        errorCode: githubErrorCode(error, "LANDING_GITHUB_GATEWAY_INVALID"),
      });
    }
    const coordinates = { owner: landing.profile.owner, repository: landing.profile.repository };
    const baseRef = `refs/heads/${landing.profile.baseBranch}`;

    const reads: {
      readonly kind: "github.actor.get" | "github.base_ref.get" | "github.head_ref.get";
    }[] = [
      { kind: "github.actor.get" },
      { kind: "github.base_ref.get" },
      { kind: "github.head_ref.get" },
    ];
    for (const { kind } of reads) {
      const admission = this.#store.admitGithubRequest(landing.id, operationId, kind);
      try {
        if (kind === "github.actor.get") {
          const receipt = await gateway.readActor(landing.profile.expectedActor, { signal });
          this.#store.settleGithubRequest(landing.id, admission.requestId, {
            outcome: "succeeded",
            httpStatus: 200,
            projection: { type: "actor", login: receipt.login },
            errorCode: null,
          });
        } else if (kind === "github.base_ref.get") {
          const receipt = await gateway.readBaseReference(coordinates, baseRef, { signal });
          if (receipt === null) {
            this.#store.settleGithubRequest(landing.id, admission.requestId, {
              outcome: "failed",
              httpStatus: 404,
              projection: null,
              errorCode: "LANDING_REMOTE_BASE_MISSING",
            });
            return this.#store.settleRemoteRefReconciliation(landing.id, {
              outcome: "reconciliation_required",
              errorCode: "LANDING_REMOTE_BASE_MISSING",
            });
          }
          this.#store.settleGithubRequest(landing.id, admission.requestId, {
            outcome: "succeeded",
            httpStatus: 200,
            projection: { type: "ref", state: "direct", ref: baseRef, sha1: receipt.sha },
            errorCode: null,
          });
        } else {
          const receipt = await gateway.readReference(coordinates, landing.headRef, { signal });
          this.#store.settleGithubRequest(landing.id, admission.requestId, {
            outcome: "succeeded",
            httpStatus: receipt === null ? 404 : 200,
            projection:
              receipt === null
                ? { type: "ref", state: "absent", ref: landing.headRef, sha1: null }
                : { type: "ref", state: "direct", ref: landing.headRef, sha1: receipt.sha },
            errorCode: null,
          });
        }
      } catch (error) {
        const errorCode = githubErrorCode(error, "LANDING_GITHUB_READ_FAILED");
        this.#store.settleGithubRequest(landing.id, admission.requestId, {
          outcome: "failed",
          httpStatus: githubErrorStatus(error),
          projection: null,
          errorCode,
        });
        return this.#store.settleRemoteRefReconciliation(landing.id, {
          outcome: "reconciliation_required",
          errorCode,
        });
      }
    }
    this.#store.recordGithubOperationObservation(landing.id, operationId);

    const observed = this.#store.getLandingStatus(landingId);
    const rows = observed.httpRequests.filter(
      (row) => row.operationId === operationId && row.status === "settled",
    );
    const baseProjection = rows.find((row) => row.kind === "github.base_ref.get")?.result
      ?.projection;
    const headProjection = rows.find((row) => row.kind === "github.head_ref.get")?.result
      ?.projection;
    const baseUnchanged =
      baseProjection?.type === "ref" &&
      baseProjection.state === "direct" &&
      baseProjection.sha1 === landing.baseCommitSha1;
    const headAbsent = headProjection?.type === "ref" && headProjection.state === "absent";
    const headExact =
      headProjection?.type === "ref" &&
      headProjection.state === "direct" &&
      headProjection.sha1 === landing.candidateCommitSha1;
    if (baseUnchanged && headExact) {
      return this.#store.settleRemoteRefReconciliation(landing.id, {
        outcome: "remote_ready",
        errorCode: null,
      });
    }
    if (baseUnchanged && headAbsent) {
      return this.#store.settleRemoteRefReconciliation(landing.id, {
        outcome: "retry_objects_ready",
        errorCode: null,
      });
    }
    const errorCode = !baseUnchanged
      ? "LANDING_REMOTE_BASE_CHANGED"
      : headProjection?.type === "ref" && headProjection.state === "direct"
        ? "LANDING_REMOTE_HEAD_CONFLICT"
        : "LANDING_REMOTE_REF_OUTCOME_AMBIGUOUS";
    return this.#store.settleRemoteRefReconciliation(landing.id, {
      outcome: "reconciliation_required",
      errorCode,
    });
  }

  /**
   * Draft-PR reconciliation re-reads the actor, the exact base, the head, and
   * the pull-request list through the durable machinery: unchanged base +
   * exact candidate head + a fresh complete list proving exactly one
   * conforming pull request reconciles to `landed` with the receipt in the
   * same transaction; unchanged base + exact head + a fresh complete empty
   * list authorizes the one POST from `remote_ready` only when the subject
   * never admitted it. Drift, conflict, or unresolved visibility holds with
   * the honestly derived residue. Never a second POST.
   */
  async #executePullRequestReconciliation(
    landingId: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<LandingStatusV1> {
    const status = this.#store.getLandingStatus(landingId);
    const landing = status.landing;
    invariant(
      landing.state === "reconciliation_required" &&
        landing.resumeState === "remote_ready" &&
        landing.candidateCommitSha1 !== null &&
        status.operations.some(
          (operation) =>
            operation.id === operationId &&
            operation.kind === "landing.reconcile" &&
            operation.status === "started",
        ),
      "INVALID_LANDING_STATE",
      "Landing is not reconciling the admitted draft-PR subject",
    );
    assertLandingCredentialEnvironmentAllowed(
      landing.profile,
      this.#landingCredentialEnvironmentNames,
    );
    this.#landingEligibilityFor(landing);
    const credential = this.#landingCredentialEnvironment(landing.profile.credentialRef.name);
    if (credential === undefined || credential.length === 0) {
      return this.#store.settlePullRequestReconciliation(landing.id, {
        outcome: "reconciliation_required",
        errorCode: "LANDING_CREDENTIAL_MISSING",
      });
    }
    let gateway: LandingGithubGateway;
    try {
      gateway = this.#landingGithubGateway(credential);
    } catch (error) {
      return this.#store.settlePullRequestReconciliation(landing.id, {
        outcome: "reconciliation_required",
        errorCode: githubErrorCode(error, "LANDING_GITHUB_GATEWAY_INVALID"),
      });
    }
    const coordinates = { owner: landing.profile.owner, repository: landing.profile.repository };
    const baseRef = `refs/heads/${landing.profile.baseBranch}`;
    const hold = (errorCode: string): LandingStatusV1 =>
      this.#store.settlePullRequestReconciliation(landing.id, {
        outcome: "reconciliation_required",
        errorCode,
      });

    const actorAdmission = this.#store.admitGithubRequest(
      landing.id,
      operationId,
      "github.actor.get",
    );
    try {
      const receipt = await gateway.readActor(landing.profile.expectedActor, { signal });
      this.#store.settleGithubRequest(landing.id, actorAdmission.requestId, {
        outcome: "succeeded",
        httpStatus: 200,
        projection: { type: "actor", login: receipt.login },
        errorCode: null,
      });
    } catch (error) {
      const errorCode = githubErrorCode(error, "LANDING_GITHUB_READ_FAILED");
      this.#store.settleGithubRequest(landing.id, actorAdmission.requestId, {
        outcome: "failed",
        httpStatus: githubErrorStatus(error),
        projection: null,
        errorCode,
      });
      return hold(errorCode);
    }

    const baseAdmission = this.#store.admitGithubRequest(
      landing.id,
      operationId,
      "github.base_ref.get",
    );
    try {
      const receipt = await gateway.readBaseReference(coordinates, baseRef, { signal });
      if (receipt === null) {
        this.#store.settleGithubRequest(landing.id, baseAdmission.requestId, {
          outcome: "failed",
          httpStatus: 404,
          projection: null,
          errorCode: "LANDING_REMOTE_BASE_MISSING",
        });
        return hold("LANDING_REMOTE_BASE_MISSING");
      }
      this.#store.settleGithubRequest(landing.id, baseAdmission.requestId, {
        outcome: "succeeded",
        httpStatus: 200,
        projection: { type: "ref", state: "direct", ref: baseRef, sha1: receipt.sha },
        errorCode: null,
      });
    } catch (error) {
      const errorCode = githubErrorCode(error, "LANDING_GITHUB_READ_FAILED");
      this.#store.settleGithubRequest(landing.id, baseAdmission.requestId, {
        outcome: "failed",
        httpStatus: githubErrorStatus(error),
        projection: null,
        errorCode,
      });
      return hold(errorCode);
    }

    const headAdmission = this.#store.admitGithubRequest(
      landing.id,
      operationId,
      "github.head_ref.get",
    );
    try {
      const receipt = await gateway.readReference(coordinates, landing.headRef, { signal });
      this.#store.settleGithubRequest(landing.id, headAdmission.requestId, {
        outcome: "succeeded",
        httpStatus: receipt === null ? 404 : 200,
        projection:
          receipt === null
            ? { type: "ref", state: "absent", ref: landing.headRef, sha1: null }
            : { type: "ref", state: "direct", ref: landing.headRef, sha1: receipt.sha },
        errorCode: null,
      });
    } catch (error) {
      const errorCode = githubErrorCode(error, "LANDING_GITHUB_READ_FAILED");
      this.#store.settleGithubRequest(landing.id, headAdmission.requestId, {
        outcome: "failed",
        httpStatus: githubErrorStatus(error),
        projection: null,
        errorCode,
      });
      return hold(errorCode);
    }

    const listAdmission = this.#store.admitGithubRequest(
      landing.id,
      operationId,
      "github.pull_requests.get",
    );
    try {
      const receipt = await gateway.readPullRequestByHead(
        coordinates,
        landing.headRef,
        landing.profile.baseBranch,
        { signal },
      );
      if (receipt === null) {
        this.#store.settleGithubRequest(landing.id, listAdmission.requestId, {
          outcome: "succeeded",
          httpStatus: 200,
          projection: { type: "pull_request_list", complete: true, count: 0, objects: [] },
          errorCode: null,
        });
      } else {
        const projection = pullRequestProjectionFromReceipt(receipt, coordinates);
        if (projection === null) {
          this.#store.settleGithubRequest(landing.id, listAdmission.requestId, {
            outcome: "failed",
            httpStatus: 200,
            projection: null,
            errorCode: "LANDING_PULL_REQUEST_OUTCOME_AMBIGUOUS",
          });
        } else {
          this.#store.settleGithubRequest(landing.id, listAdmission.requestId, {
            outcome: "succeeded",
            httpStatus: 200,
            projection: {
              type: "pull_request_list",
              complete: true,
              count: 1,
              objects: [projection],
            },
            errorCode: null,
          });
        }
      }
    } catch (error) {
      const errorCode = githubErrorCode(error, "LANDING_GITHUB_READ_FAILED");
      this.#store.settleGithubRequest(landing.id, listAdmission.requestId, {
        outcome: "failed",
        httpStatus: githubErrorStatus(error),
        projection: null,
        errorCode,
      });
      return hold(errorCode);
    }
    // The subject-binding observation is durable before the outcome settles.
    this.#store.recordGithubOperationObservation(landing.id, operationId);

    const observed = this.#store.getLandingStatus(landing.id);
    const rows = observed.httpRequests.filter(
      (row) => row.operationId === operationId && row.status === "settled",
    );
    const baseProjection = rows.find((row) => row.kind === "github.base_ref.get")?.result
      ?.projection;
    const headProjection = rows.find((row) => row.kind === "github.head_ref.get")?.result
      ?.projection;
    const listProjection = rows.find((row) => row.kind === "github.pull_requests.get")?.result
      ?.projection;
    const baseUnchanged =
      baseProjection?.type === "ref" &&
      baseProjection.state === "direct" &&
      baseProjection.sha1 === landing.baseCommitSha1;
    const headExact =
      headProjection?.type === "ref" &&
      headProjection.state === "direct" &&
      headProjection.sha1 === landing.candidateCommitSha1;
    const provenPullRequest =
      listProjection?.type === "pull_request_list" &&
      listProjection.complete &&
      listProjection.count === 1
        ? (listProjection.objects[0] ?? null)
        : null;
    const listEmpty =
      listProjection?.type === "pull_request_list" &&
      listProjection.complete &&
      listProjection.count === 0;
    const input = observed.operations.find((operation) => operation.id === operationId)?.request
      .input;
    invariant(
      input !== undefined && "subjectOperationId" in input,
      "LANDING_RECORD_INVALID",
      "Pull-request reconciliation lacks its subject binding",
    );
    const subjectPost = observed.httpRequests.find(
      (row) =>
        row.operationId === input.subjectOperationId && row.kind === "github.pull_request.post",
    );
    if (
      baseUnchanged &&
      headExact &&
      provenPullRequest !== null &&
      pullRequestProjectionMatchesLanding(provenPullRequest, landing)
    ) {
      return this.#store.settlePullRequestReconciliation(landing.id, {
        outcome: "landed",
        errorCode: null,
      });
    }
    if (baseUnchanged && headExact && listEmpty && subjectPost === undefined) {
      return this.#store.settlePullRequestReconciliation(landing.id, {
        outcome: "retry_remote_ready",
        errorCode: null,
      });
    }
    const errorCode = !baseUnchanged
      ? "LANDING_REMOTE_BASE_CHANGED"
      : !headExact
        ? headProjection?.type === "ref" && headProjection.state === "absent"
          ? "LANDING_REMOTE_HEAD_MISSING"
          : "LANDING_REMOTE_HEAD_CONFLICT"
        : "LANDING_PULL_REQUEST_OUTCOME_AMBIGUOUS";
    return hold(errorCode);
  }

  /**
   * Settles the just-admitted read as failed with the bounded host code, then
   * settles the operation. Cancellation closes the attempt as interrupted —
   * the landing keeps its retry-safe stable state — while a definitive refusal
   * enters `failed` with the `local_ready` resume marker.
   */
  #failPreflightRead(
    landingId: string,
    requestId: string,
    error: unknown,
    signal?: AbortSignal,
  ): LandingStatusV1 {
    const errorCode = githubErrorCode(error, "LANDING_GITHUB_READ_FAILED");
    this.#store.settleGithubRequest(landingId, requestId, {
      outcome: "failed",
      httpStatus: githubErrorStatus(error),
      projection: null,
      errorCode,
    });
    const cancelled =
      signal?.aborted === true || errorCode === "GITHUB_CANCELLED" || errorCode === "CANCELLED";
    return this.#store.settleGithubPreflight(
      landingId,
      cancelled
        ? { outcome: "interrupted", errorCode, closeAttempt: true }
        : { outcome: "failed", errorCode, closeAttempt: true },
    );
  }

  setLandingProfile(
    projectName: string,
    profileInput: GitHubLandingProfileV1,
  ): LandingProfileRecordV1 {
    this.#assertLandingMutationPlatform();
    const project = this.#store.getProjectByName(projectName);
    const profile = decodeGitHubLandingProfileV1(profileInput);
    assertLandingCredentialEnvironmentAllowed(profile, this.#landingCredentialEnvironmentNames);
    return this.#store.setLandingProfile(
      project.id,
      profile,
      this.#landingCredentialEnvironmentNames,
    );
  }

  getLandingProfile(projectName: string): LandingProfileRecordV1 | null {
    const project = this.#store.getProjectByName(projectName);
    return this.#store.getLandingProfile(project.id);
  }

  getLandingStatus(runId: string): LandingStatusV1 | null {
    return this.#store.getLandingStatusForRun(runId);
  }

  async prepareLanding(input: PrepareLandingInput, signal?: AbortSignal): Promise<LandingStatusV1> {
    this.#assertLandingMutationPlatform();
    return this.#leases.withLease(input.runId, async () => {
      const attemptSignal = boundedSignal(signal, LANDING_ATTEMPT_TIMEOUT_MS);
      const eligibility = this.#store.getLandingEligibility(input.runId);
      assertLandingCredentialEnvironmentAllowed(
        eligibility.profile,
        this.#landingCredentialEnvironmentNames,
      );
      const base = await this.#landingGit.inspectBase(
        {
          cachePath: eligibility.cachePath,
          runId: eligibility.runId,
          baseCommitSha1: eligibility.baseCommitSha1,
        },
        attemptSignal,
      );
      invariant(
        base.objectFormat === "sha1" && base.baseCommitSha1 === eligibility.baseCommitSha1,
        "LANDING_BASE_CHANGED",
        "Landing base identity no longer matches its eligible run",
      );
      const commitMessage = canonicalizeCommitMessage(input.commitMessage);
      const pullRequestTitle = canonicalizePullRequestTitle(input.pullRequestTitle);
      const pullRequestBodyPrefix = canonicalizePullRequestBodyPrefix(input.pullRequestBodyPrefix);
      const parsedNow = Date.parse(this.#now());
      invariant(
        Number.isSafeInteger(parsedNow) && parsedNow >= 0,
        "INVALID_LANDING_TIMESTAMP",
        "Landing commit timestamp is invalid",
      );
      const commitEpochSeconds = Math.floor(parsedNow / 1_000);
      const commitIso8601 = commitEpochToGitInstant(commitEpochSeconds);
      const created = this.#store.createLanding(
        {
          runId: eligibility.runId,
          baseTreeSha1: base.baseTreeSha1,
          commitMessage,
          commitEpochSeconds,
          commitIso8601,
          pullRequestTitle,
          pullRequestBodyPrefix,
        },
        this.#landingCredentialEnvironmentNames,
      );
      assertLandingCredentialEnvironmentAllowed(
        created.landing.profile,
        this.#landingCredentialEnvironmentNames,
      );
      return this.#executeLandingCandidate(created.landing.id, attemptSignal);
    });
  }

  async decideLanding(
    runId: string,
    landingSha256: string,
    actor: string,
    decision: "approve" | "reject",
  ): Promise<LandingStatusV1> {
    this.#assertLandingMutationPlatform();
    return this.#leases.withLease(runId, async () => {
      const status = this.#store.getLandingStatusForRun(runId);
      invariant(status !== null, "NOT_FOUND", "Landing was not found");
      assertLandingCredentialEnvironmentAllowed(
        status.landing.profile,
        this.#landingCredentialEnvironmentNames,
      );
      return this.#store.recordLandingDecision(status.landing.id, landingSha256, actor, decision);
    });
  }

  async resumeLanding(runId: string, signal?: AbortSignal): Promise<LandingStatusV1> {
    this.#assertLandingMutationPlatform();
    return this.#leases.withLease(runId, async () => {
      const attemptSignal = boundedSignal(signal, LANDING_ATTEMPT_TIMEOUT_MS);
      const current = this.#store.getLandingStatusForRun(runId);
      invariant(current !== null, "NOT_FOUND", "Landing was not found");
      assertLandingCredentialEnvironmentAllowed(
        current.landing.profile,
        this.#landingCredentialEnvironmentNames,
      );
      // `local_ready`, `objects_ready`, and `remote_ready` each run the
      // read-only preflight and then chain their effect stage in the same
      // attempt (the contract requires the effect's input to bind the
      // immediately preceding completed preflight of that attempt).
      invariant(
        !(
          current.landing.state === "failed" &&
          current.landing.resumeState !== "preparing_candidate" &&
          current.landing.resumeState !== "approved" &&
          current.landing.resumeState !== "local_ready" &&
          current.landing.resumeState !== "objects_ready" &&
          current.landing.resumeState !== "remote_ready"
        ),
        "INVALID_LANDING_STATE",
        "This landing stage cannot resume from its durable resume marker",
      );

      const admission = this.#store.admitLandingResume(current.landing.id);
      invariant(
        admission.attemptOrdinal !== null,
        "INVALID_LANDING_STATE",
        "Landing is not in an explicitly resumable state",
      );
      switch (admission.status.landing.state) {
        case "preparing_candidate":
          invariant(
            admission.operationId === null,
            "LANDING_RECORD_INVALID",
            "Candidate resume unexpectedly pre-admitted an operation",
          );
          return this.#executeLandingCandidate(current.landing.id, attemptSignal);
        case "approved":
          invariant(
            admission.operationId === null,
            "LANDING_RECORD_INVALID",
            "Approved resume unexpectedly pre-admitted an operation",
          );
          return this.#executeLocalRefCreation(current.landing.id, attemptSignal);
        case "local_ready":
        case "objects_ready":
        case "remote_ready": {
          invariant(
            admission.operationId === null,
            "LANDING_RECORD_INVALID",
            "Stable-state resume unexpectedly pre-admitted an operation",
          );
          const stage = admission.status.landing.state;
          const preflighted = await this.#executeGithubPreflight(
            current.landing.id,
            attemptSignal,
            true,
          );
          const preflightOperation = preflighted.operations.at(-1);
          if (
            preflighted.landing.state !== stage ||
            preflightOperation?.kind !== "github.preflight" ||
            preflightOperation.status !== "completed"
          ) {
            return preflighted;
          }
          return stage === "local_ready"
            ? this.#executeGithubObjectsUpload(current.landing.id, attemptSignal)
            : stage === "objects_ready"
              ? this.#executeGithubRemoteRefCreation(current.landing.id, attemptSignal)
              : this.#executeGithubDraftPrCreation(current.landing.id, attemptSignal);
        }
        case "reconciliation_required": {
          invariant(
            admission.operationId !== null,
            "LANDING_RECORD_INVALID",
            "Reconciliation resume has no durable operation intent",
          );
          const resumeState = admission.status.landing.resumeState;
          if (resumeState === "approved") {
            return this.#executeLocalRefReconciliation(
              current.landing.id,
              admission.operationId,
              attemptSignal,
            );
          }
          if (resumeState === "local_ready") {
            return this.#executeObjectUploadReconciliation(
              current.landing.id,
              admission.operationId,
            );
          }
          if (resumeState === "objects_ready") {
            return this.#executeRemoteRefReconciliation(
              current.landing.id,
              admission.operationId,
              attemptSignal,
            );
          }
          if (resumeState === "remote_ready") {
            return this.#executePullRequestReconciliation(
              current.landing.id,
              admission.operationId,
              attemptSignal,
            );
          }
          throw new IcarusError(
            "INVALID_LANDING_STATE",
            "Landing reconciliation is not in an implemented slice",
          );
        }
        default:
          throw new IcarusError(
            "INVALID_LANDING_STATE",
            "Landing resume reached an unsupported state for this slice",
          );
      }
    });
  }
}
