import path from "node:path";

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
  digestLandingRecord,
  GITHUB_API_VERSION,
  type GitHubLandingProfileV1,
  type LandingDigestV1,
  type LocalRefFactV1,
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
 * Every remote effect remains Packet 4 work. Nothing in this module performs a
 * credential lookup, network request, GitHub effect, migration, merge, or
 * deployment.
 */

const LANDING_ATTEMPT_TIMEOUT_MS = 10 * 60 * 1_000;

export type LandingGitService = Pick<
  LandingGitController,
  "inspectBase" | "prepareCandidate" | "observeLocalRef" | "createAbsentLocalRef"
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

export class LandingCoordinator {
  readonly #store: IcarusStore;
  readonly #landingGit: LandingGitService;
  readonly #landingCredentialEnvironmentNames: ReadonlySet<string>;
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
      if (current.landing.state === "local_ready") {
        return current;
      }
      invariant(
        !(
          current.landing.state === "failed" &&
          current.landing.resumeState !== "preparing_candidate" &&
          current.landing.resumeState !== "approved"
        ),
        "INVALID_LANDING_STATE",
        "Packet 3 cannot resume this later landing stage",
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
        case "reconciliation_required":
          invariant(
            admission.operationId !== null,
            "LANDING_RECORD_INVALID",
            "Reconciliation resume has no durable operation intent",
          );
          return this.#executeLocalRefReconciliation(
            current.landing.id,
            admission.operationId,
            attemptSignal,
          );
        default:
          throw new IcarusError(
            "INVALID_LANDING_STATE",
            "Landing resume reached an unsupported Packet 3 state",
          );
      }
    });
  }
}
