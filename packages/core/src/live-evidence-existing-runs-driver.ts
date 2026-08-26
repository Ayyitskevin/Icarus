import { canonicalJson, parseStrictJson } from "./canonical-json.js";
import { sha256 } from "./digest.js";
import { IcarusError, invariant } from "./errors.js";
import type { LandingStatusV1 } from "./landing-ledger.js";
import type { GitHubLandingProfileV1 } from "./landing-records.js";
import type {
  LiveEvidenceCaseContext,
  LiveEvidenceCaseDriver,
  LiveEvidenceCaseObservation,
} from "./live-evidence-executor.js";
import type { LiveEvidenceEffect, LiveEvidenceProfileV1 } from "./live-evidence-profile.js";
import type { IcarusService } from "./service.js";
import type { CheckProfile, JsonValue, RunRecord } from "./types.js";

const RUN_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export const LIVE_EVIDENCE_PROVIDER_ADAPTER_VERSIONS = Object.freeze({
  ollama: "production-ollama-api-chat-v1",
  openai: "production-openai-responses-v1",
  anthropic: "production-anthropic-messages-v1",
});

export interface LiveEvidenceCaseRunBindingV1 {
  readonly caseId: string;
  readonly runId: string;
}

export interface LiveEvidenceCaseRunMapV1 {
  readonly schemaVersion: 1;
  readonly profileId: string;
  readonly manifestSha256: string;
  readonly cases: readonly LiveEvidenceCaseRunBindingV1[];
}

type LandingService = Pick<
  IcarusService,
  | "getRun"
  | "getProject"
  | "getProjectRepositoryStatus"
  | "getLandingProfile"
  | "getLandingStatus"
  | "prepareLanding"
  | "decideLanding"
  | "resumeLanding"
>;

interface ManifestCaseContract {
  readonly id: string;
  readonly taskSha256: string;
  readonly selectedPaths: readonly string[];
  readonly expectedChangedPaths: readonly string[];
  readonly checks: readonly CheckProfile[];
  readonly sourceCommitSha1: string;
  readonly sourceTreeSha1: string;
  readonly candidate: {
    readonly commitEpochSeconds: number;
    readonly commitMessage: string;
    readonly commitIdentity: { readonly name: string; readonly email: string };
    readonly candidateTreeSha1: string;
    readonly candidateCommitSha1: string;
    readonly candidateCommitPayloadSha256: string;
  };
}

function fail(code: string, message: string): never {
  throw new IcarusError(code, message);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("LIVE_EVIDENCE_CASE_MISMATCH", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail("LIVE_EVIDENCE_CASE_MISMATCH", `${field} must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    fail("LIVE_EVIDENCE_CASE_MISMATCH", `${field} must be a string array`);
  }
  return value as string[];
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left as JsonValue) === canonicalJson(right as JsonValue);
}

function parseManifestCases(bytes: Uint8Array): readonly ManifestCaseContract[] {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("LIVE_EVIDENCE_CASE_MISMATCH", "Manifest is not valid UTF-8");
  }
  const manifest = record(parseStrictJson(source), "manifest");
  if (!Array.isArray(manifest.cases)) {
    fail("LIVE_EVIDENCE_CASE_MISMATCH", "manifest.cases must be an array");
  }
  return manifest.cases.map((entry, index) => {
    const item = record(entry, `manifest.cases[${index}]`);
    const repository = record(item.repository, `manifest.cases[${index}].repository`);
    const sourceRevision = record(
      repository.sourceRevision,
      `manifest.cases[${index}].repository.sourceRevision`,
    );
    const task = record(item.task, `manifest.cases[${index}].task`);
    const candidate = record(item.candidate, `manifest.cases[${index}].candidate`);
    const identity = record(
      candidate.commitIdentity,
      `manifest.cases[${index}].candidate.commitIdentity`,
    );
    if (!Array.isArray(item.checks)) {
      fail("LIVE_EVIDENCE_CASE_MISMATCH", `manifest.cases[${index}].checks must be an array`);
    }
    const checks = item.checks.map((check, checkIndex) => {
      const decoded = record(check, `manifest.cases[${index}].checks[${checkIndex}]`);
      return {
        id: text(decoded.id, `manifest.cases[${index}].checks[${checkIndex}].id`),
        name: text(decoded.name, `manifest.cases[${index}].checks[${checkIndex}].name`),
        argv: stringArray(decoded.argv, `manifest.cases[${index}].checks[${checkIndex}].argv`),
      };
    });
    const commitEpochSeconds = candidate.commitEpochSeconds;
    if (!Number.isSafeInteger(commitEpochSeconds) || (commitEpochSeconds as number) < 0) {
      fail("LIVE_EVIDENCE_CASE_MISMATCH", "candidate.commitEpochSeconds is invalid");
    }
    const sourceCommitSha1 = text(sourceRevision.commitSha1, "source commit");
    const sourceTreeSha1 = text(sourceRevision.treeSha1, "source tree");
    const candidateTreeSha1 = text(candidate.candidateTreeSha1, "candidate tree");
    const candidateCommitSha1 = text(candidate.candidateCommitSha1, "candidate commit");
    const candidateCommitPayloadSha256 = text(
      candidate.candidateCommitPayloadSha256,
      "candidate payload",
    );
    if (
      !SHA1.test(sourceCommitSha1) ||
      !SHA1.test(sourceTreeSha1) ||
      !SHA1.test(candidateTreeSha1) ||
      !SHA1.test(candidateCommitSha1) ||
      !SHA256.test(candidateCommitPayloadSha256)
    ) {
      fail("LIVE_EVIDENCE_CASE_MISMATCH", "Manifest Git identity is invalid");
    }
    return {
      id: text(item.id, `manifest.cases[${index}].id`),
      taskSha256: text(task.sha256, `manifest.cases[${index}].task.sha256`),
      selectedPaths: stringArray(item.selectedPaths, "selectedPaths"),
      expectedChangedPaths: stringArray(item.expectedChangedPaths, "expectedChangedPaths"),
      checks,
      sourceCommitSha1,
      sourceTreeSha1,
      candidate: {
        commitEpochSeconds: commitEpochSeconds as number,
        commitMessage: text(candidate.commitMessage, "candidate.commitMessage"),
        commitIdentity: {
          name: text(identity.name, "candidate.commitIdentity.name"),
          email: text(identity.email, "candidate.commitIdentity.email"),
        },
        candidateTreeSha1,
        candidateCommitSha1,
        candidateCommitPayloadSha256,
      },
    };
  });
}

export function decodeLiveEvidenceCaseRunMapV1(
  value: unknown,
  profile: LiveEvidenceProfileV1,
  manifestBytes: Uint8Array,
): LiveEvidenceCaseRunMapV1 {
  const decoded = record(value, "run map");
  const keys = Object.keys(decoded).sort();
  if (!same(keys, ["cases", "manifestSha256", "profileId", "schemaVersion"])) {
    fail("INVALID_LIVE_EVIDENCE_RUN_MAP", "Run map has missing or unknown fields");
  }
  if (decoded.schemaVersion !== 1 || decoded.profileId !== profile.profileId) {
    fail("INVALID_LIVE_EVIDENCE_RUN_MAP", "Run map does not bind the approved profile");
  }
  const manifestDigest = sha256(manifestBytes);
  if (decoded.manifestSha256 !== manifestDigest || !Array.isArray(decoded.cases)) {
    fail("INVALID_LIVE_EVIDENCE_RUN_MAP", "Run map does not bind the supplied manifest");
  }
  const order = parseManifestCases(manifestBytes).map((entry) => entry.id);
  const cases = decoded.cases.map((entry, index) => {
    const binding = record(entry, `run map cases[${index}]`);
    if (!same(Object.keys(binding).sort(), ["caseId", "runId"])) {
      fail("INVALID_LIVE_EVIDENCE_RUN_MAP", "Run binding has missing or unknown fields");
    }
    const caseId = text(binding.caseId, "run map caseId");
    const runId = text(binding.runId, "run map runId");
    if (caseId !== order[index] || !RUN_ID.test(runId)) {
      fail("INVALID_LIVE_EVIDENCE_RUN_MAP", "Run bindings must follow manifest order");
    }
    return { caseId, runId };
  });
  if (
    cases.length !== order.length ||
    new Set(cases.map((entry) => entry.runId)).size !== cases.length
  ) {
    fail("INVALID_LIVE_EVIDENCE_RUN_MAP", "Run map must bind one distinct run per case");
  }
  return { schemaVersion: 1, profileId: profile.profileId, manifestSha256: manifestDigest, cases };
}

function effectsFor(status: LandingStatusV1): readonly LiveEvidenceEffect[] {
  const kinds = new Set(status.httpRequests.map((request) => request.kind));
  const effects: LiveEvidenceEffect[] = [];
  if (
    kinds.has("github.blob.post") ||
    kinds.has("github.tree.post") ||
    kinds.has("github.commit.post")
  ) {
    effects.push("github.objects.upload");
  }
  if (kinds.has("github.ref.post")) effects.push("github.ref.create.absent_only");
  if (kinds.has("github.pull_request.post")) effects.push("github.pull_request.create.draft");
  if (status.receipt !== null) effects.push("github.landing.receipt");
  return effects;
}

function nextEffectsFor(status: LandingStatusV1): readonly LiveEvidenceEffect[] {
  if (status.landing.state === "local_ready") return ["github.objects.upload"];
  if (status.landing.state === "objects_ready") return ["github.ref.create.absent_only"];
  if (status.landing.state === "remote_ready") {
    return ["github.pull_request.create.draft", "github.landing.receipt"];
  }
  if (status.landing.state !== "failed") return [];
  const existing = new Set(effectsFor(status));
  if (status.landing.resumeState === "local_ready" && !existing.has("github.objects.upload")) {
    return ["github.objects.upload"];
  }
  if (
    status.landing.resumeState === "objects_ready" &&
    !existing.has("github.ref.create.absent_only")
  ) {
    return ["github.ref.create.absent_only"];
  }
  if (
    status.landing.resumeState === "remote_ready" &&
    !existing.has("github.pull_request.create.draft")
  ) {
    return ["github.pull_request.create.draft", "github.landing.receipt"];
  }
  return [];
}

function providerMatches(run: RunRecord, profile: LiveEvidenceProfileV1): boolean {
  return (
    run.provider.kind === profile.provider.kind &&
    run.provider.model === profile.provider.model &&
    run.provider.baseUrl === profile.provider.baseUrl &&
    run.provider.inputUsdPerMillionTokens === profile.provider.inputUsdPerMillionTokens &&
    run.provider.outputUsdPerMillionTokens === profile.provider.outputUsdPerMillionTokens &&
    // Vulcan can never match: the profile decoder refuses a vulcan pin, and
    // this guard keeps that exclusion load-bearing even if the decoder is
    // ever widened without pinning a vulcan adapter version below. Gate 1
    // evidence comes only from the three adapters in
    // LIVE_EVIDENCE_PROVIDER_ADAPTER_VERSIONS.
    profile.provider.kind !== "vulcan" &&
    profile.provider.adapterVersion ===
      LIVE_EVIDENCE_PROVIDER_ADAPTER_VERSIONS[profile.provider.kind]
  );
}

function profileMatches(left: GitHubLandingProfileV1, right: GitHubLandingProfileV1): boolean {
  return same(left, right);
}

export class ExistingRunsLiveEvidenceCaseDriver implements LiveEvidenceCaseDriver {
  readonly #service: LandingService;
  readonly #bindings: ReadonlyMap<string, string>;
  readonly #contracts: ReadonlyMap<string, ManifestCaseContract>;

  constructor(
    service: LandingService,
    runMap: LiveEvidenceCaseRunMapV1,
    manifestBytes: Uint8Array,
  ) {
    this.#service = service;
    this.#bindings = new Map(runMap.cases.map((entry) => [entry.caseId, entry.runId]));
    this.#contracts = new Map(parseManifestCases(manifestBytes).map((entry) => [entry.id, entry]));
  }

  async #validated(context: LiveEvidenceCaseContext): Promise<{
    readonly run: RunRecord;
    readonly contract: ManifestCaseContract;
    readonly status: LandingStatusV1 | null;
  }> {
    const runId = this.#bindings.get(context.caseId);
    const contract = this.#contracts.get(context.caseId);
    invariant(
      runId !== undefined && contract !== undefined,
      "LIVE_EVIDENCE_CASE_MISMATCH",
      "Case binding is absent",
    );
    const run = this.#service.getRun(runId);
    const project = this.#service.getProject(run.projectId);
    const repository = await this.#service.getProjectRepositoryStatus(
      run.projectId,
      context.signal,
    );
    const verification = run.verification;
    if (
      run.state !== "completed" ||
      run.createdAt < context.profile.approval.approvedAt ||
      run.baseCommit !== contract.sourceCommitSha1 ||
      sha256(run.task) !== contract.taskSha256 ||
      !providerMatches(run, context.profile) ||
      !same(run.plan?.targets, contract.selectedPaths) ||
      !same(
        run.plan?.checkIds,
        contract.checks.map((check) => check.id),
      ) ||
      !same(project.checks, contract.checks) ||
      verification?.outcome !== "passed" ||
      !same(verification.changedPaths, contract.expectedChangedPaths) ||
      !same(
        verification.checks.map((check) => ({
          checkId: check.checkId,
          argv: check.argv,
          exitCode: check.exitCode,
          signal: check.signal,
          truncated: check.truncated,
          outcome: check.outcome,
        })),
        contract.checks.map((check) => ({
          checkId: check.id,
          argv: check.argv,
          exitCode: 0,
          signal: null,
          truncated: false,
          outcome: "passed",
        })),
      ) ||
      repository.availability !== "available" ||
      repository.worktree !== "clean" ||
      repository.baseCommit !== contract.sourceCommitSha1 ||
      repository.head !== contract.sourceCommitSha1 ||
      repository.issue !== null
    ) {
      fail(
        "LIVE_EVIDENCE_CASE_MISMATCH",
        `Completed run evidence does not match case ${context.caseId}`,
      );
    }
    const configured = this.#service.getLandingProfile(project.name);
    if (
      configured === null ||
      !profileMatches(configured.profile, context.casePin.landingProfile)
    ) {
      fail(
        "LIVE_EVIDENCE_LANDING_PROFILE_MISMATCH",
        `Project landing profile does not match case ${context.caseId}`,
      );
    }
    const status = this.#service.getLandingStatus(runId);
    if (status !== null) {
      const landing = status.landing;
      if (
        !profileMatches(landing.profile, context.casePin.landingProfile) ||
        landing.baseCommitSha1 !== contract.sourceCommitSha1 ||
        landing.baseTreeSha1 !== contract.sourceTreeSha1 ||
        landing.commitEpochSeconds !== contract.candidate.commitEpochSeconds ||
        landing.commitMessage !== contract.candidate.commitMessage ||
        landing.profile.commitIdentity.name !== contract.candidate.commitIdentity.name ||
        landing.profile.commitIdentity.email !== contract.candidate.commitIdentity.email ||
        (landing.candidateTreeSha1 !== null &&
          landing.candidateTreeSha1 !== contract.candidate.candidateTreeSha1) ||
        (landing.candidateCommitSha1 !== null &&
          landing.candidateCommitSha1 !== contract.candidate.candidateCommitSha1) ||
        (landing.candidateCommitPayloadSha256 !== null &&
          landing.candidateCommitPayloadSha256 !== contract.candidate.candidateCommitPayloadSha256)
      ) {
        fail(
          "LIVE_EVIDENCE_CASE_MISMATCH",
          `Landing evidence does not match case ${context.caseId}`,
        );
      }
    }
    return { run, contract, status };
  }

  async observe(context: LiveEvidenceCaseContext): Promise<LiveEvidenceCaseObservation> {
    try {
      const { run, status } = await this.#validated(context);
      const accounting = {
        spendUsd: run.usage.estimatedCostUsd,
        // Journals use integer-only canonical JSON. Round up so sub-second
        // runtime is recorded and the approved ceiling remains conservative.
        elapsedSeconds: Math.ceil(run.usage.activeRuntimeMs / 1_000),
      };
      if (status === null) {
        return {
          caseId: context.caseId,
          durableStage: "landing.prepare",
          outcome: "ready",
          effects: [],
          nextEffects: [],
          ...accounting,
          receipt: null,
          errorCode: null,
        };
      }
      const effects = effectsFor(status);
      if (status.landing.state === "landed") {
        invariant(
          status.receipt !== null,
          "LIVE_EVIDENCE_CASE_MISMATCH",
          "Landed case has no receipt",
        );
        return {
          caseId: context.caseId,
          durableStage: "landed",
          outcome: "complete",
          effects,
          nextEffects: [],
          ...accounting,
          receipt: status.receipt as unknown as JsonValue,
          errorCode: null,
        };
      }
      const recoverable =
        status.landing.state === "failed" ||
        status.landing.state === "reconciliation_required" ||
        status.landing.state === "creating_local_ref" ||
        status.landing.state === "uploading_objects" ||
        status.landing.state === "creating_remote_ref" ||
        status.landing.state === "opening_draft_pr";
      if (recoverable && context.mode === "start") {
        return {
          caseId: context.caseId,
          durableStage: status.landing.state,
          outcome: "blocked",
          effects,
          nextEffects: [],
          ...accounting,
          receipt: null,
          errorCode: status.landing.errorCode ?? "LIVE_EVIDENCE_RECOVERY_REQUIRED",
        };
      }
      if (status.landing.state === "rejected" || status.landing.state === "abandoned") {
        return {
          caseId: context.caseId,
          durableStage: status.landing.state,
          outcome: "blocked",
          effects,
          nextEffects: [],
          ...accounting,
          receipt: null,
          errorCode: "LIVE_EVIDENCE_LANDING_TERMINAL",
        };
      }
      return {
        caseId: context.caseId,
        durableStage: status.landing.state,
        outcome: "ready",
        effects,
        nextEffects: recoverable ? nextEffectsFor(status) : nextEffectsFor(status),
        ...accounting,
        receipt: null,
        errorCode: null,
      };
    } catch (error) {
      const code = error instanceof IcarusError ? error.code : "LIVE_EVIDENCE_CASE_UNAVAILABLE";
      return {
        caseId: context.caseId,
        durableStage: "case.preflight",
        outcome: "blocked",
        effects: [],
        nextEffects: [],
        spendUsd: 0,
        elapsedSeconds: 0,
        receipt: null,
        errorCode: /^[A-Z][A-Z0-9_]{1,127}$/.test(code) ? code : "LIVE_EVIDENCE_CASE_UNAVAILABLE",
      };
    }
  }

  async advance(
    context: LiveEvidenceCaseContext,
    observation: LiveEvidenceCaseObservation,
  ): Promise<void> {
    const { run, contract, status } = await this.#validated(context);
    if (status === null) {
      await this.#service.prepareLanding(
        {
          runId: run.id,
          commitMessage: contract.candidate.commitMessage,
          pullRequestTitle: `Icarus Gate 1: ${context.caseId}`,
          pullRequestBodyPrefix: `Gate 1 live evidence for ${context.caseId}.`,
          commitEpochSeconds: contract.candidate.commitEpochSeconds,
        },
        context.signal,
      );
      return;
    }
    if (status.landing.state === "awaiting_approval") {
      invariant(
        status.landing.landingSha256 !== null,
        "LIVE_EVIDENCE_CASE_MISMATCH",
        "Landing digest is absent",
      );
      await this.#service.decideLanding(
        run.id,
        status.landing.landingSha256,
        context.profile.approval.actor,
        "approve",
      );
      return;
    }
    invariant(observation.outcome === "ready", "LIVE_EVIDENCE_CASE_MISMATCH", "Case is not ready");
    await this.#service.resumeLanding(run.id, context.signal);
  }
}
