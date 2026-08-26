import { digestJson } from "./digest.js";
import { IcarusError } from "./errors.js";
import {
  type HeadlessHostProviderProfileV1,
  type ResolvedHeadlessProfileV1,
  resolveHeadlessProfileV1,
} from "./headless-profile.js";
import { assertOperatorActor, planApprovalDigest } from "./policy.js";
import type {
  ApprovalRecord,
  JsonValue,
  ProjectRecord,
  ReadableManifest,
  RunRecord,
} from "./types.js";

// H2a binds an H1 resolution to persisted run authority. It remains a pure
// snapshot contract: no lease is acquired, no state changes, and no provider,
// workspace, tool, or worker is created here. H2 must re-create this binding
// from authoritative records while holding the existing run lease.

export const HEADLESS_EXECUTION_BINDING_SCHEMA = "icarus.headless.execution-binding.v1";

export interface HeadlessExecutionApprovalV1 {
  readonly kind: "egress" | "plan";
  readonly digest: string;
  readonly actor: string;
  readonly createdAt: string;
}

export interface HeadlessExecutionBindingAuthorityV1 {
  readonly run: RunRecord;
  readonly project: ProjectRecord;
  readonly approvals: readonly ApprovalRecord[];
  readonly readableManifest: ReadableManifest | null;
  readonly providerProfiles: readonly HeadlessHostProviderProfileV1[];
}

export interface HeadlessExecutionBindingV1 {
  readonly schema: typeof HEADLESS_EXECUTION_BINDING_SCHEMA;
  readonly runId: string;
  readonly projectId: string;
  readonly baseCommit: string;
  readonly contextSha256: string;
  readonly planSha256: string;
  readonly egressApproval: HeadlessExecutionApprovalV1 | null;
  readonly planApproval: HeadlessExecutionApprovalV1;
  readonly profileDigestSha256: string;
  readonly resolutionDigestSha256: string;
  readonly bindingDigestSha256: string;
  readonly resolution: ResolvedHeadlessProfileV1;
}

function invalidHost(message: string): never {
  throw new IcarusError("INVALID_HEADLESS_BINDING_HOST", message);
}

function denied(message: string): never {
  throw new IcarusError("HEADLESS_BINDING_AUTHORITY_DENIED", message);
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function assertPristineRunningRun(run: RunRecord): void {
  if (run.state !== "running") {
    denied("headless execution binding requires a run at the running state");
  }
  if (
    run.resumeState !== null ||
    run.patchSet !== null ||
    run.cachePath !== null ||
    run.worktreePath !== null ||
    run.baselineBase64 !== null ||
    run.approvedBase64 !== null ||
    run.diff !== null ||
    run.verification !== null ||
    run.lastError !== null
  ) {
    denied("headless execution binding requires a pristine pre-worker run snapshot");
  }
}

function exactApproval(
  approvals: readonly ApprovalRecord[],
  runId: string,
  kind: "egress" | "plan",
  digest: string,
): HeadlessExecutionApprovalV1 {
  if (!Array.isArray(approvals)) invalidHost("Host approvals must be an array");
  const records = approvals.filter((approval) => approval.kind === kind);
  if (records.length !== 1) {
    denied(`headless execution binding requires exactly one ${kind} approval`);
  }
  const approval = records[0];
  if (approval === undefined) invalidHost(`Host ${kind} approval is unavailable`);
  if (approval.runId !== runId || approval.digest !== digest || approval.decision !== "approve") {
    denied(`recorded ${kind} approval does not match this run authority`);
  }
  try {
    assertOperatorActor(approval.actor, "INVALID_HEADLESS_BINDING_HOST");
  } catch {
    invalidHost(`recorded ${kind} approval actor is invalid`);
  }
  if (
    typeof approval.createdAt !== "string" ||
    approval.createdAt.length === 0 ||
    !Number.isFinite(Date.parse(approval.createdAt))
  ) {
    invalidHost(`recorded ${kind} approval timestamp is invalid`);
  }
  return {
    kind,
    digest: approval.digest,
    actor: approval.actor,
    createdAt: approval.createdAt,
  };
}

function providerDigest(provider: RunRecord["provider"]): string {
  return digestJson(json(provider));
}

function bindHeadlessExecutionCurrentV1(
  profile: unknown,
  authority: HeadlessExecutionBindingAuthorityV1,
): HeadlessExecutionBindingV1 {
  const { run, project } = authority;
  if (typeof run !== "object" || run === null || Array.isArray(run)) {
    invalidHost("Host run record is invalid");
  }
  if (typeof project !== "object" || project === null || Array.isArray(project)) {
    invalidHost("Host project record is invalid");
  }
  if (run.projectId !== project.id) {
    denied("run and project identities do not match");
  }
  if (run.plan === null || run.planSha256 === null) {
    denied("headless execution binding requires a persisted plan and digest");
  }

  const recomputedPlanSha256 = planApprovalDigest({
    task: run.task,
    baseCommit: run.baseCommit,
    contextSha256: run.contextSha256,
    targets: run.context.targets,
    provider: run.provider,
    checks: project.checks,
    sandbox: project.sandbox,
    ceiling: project.ceiling,
    plan: run.plan,
    readableManifest: authority.readableManifest,
  });
  if (recomputedPlanSha256 !== run.planSha256) {
    denied("persisted plan digest no longer matches the complete run authority");
  }

  const planApproval = exactApproval(authority.approvals, run.id, "plan", run.planSha256);
  const egressApproval =
    run.provider.capabilities.locality === "remote"
      ? exactApproval(authority.approvals, run.id, "egress", run.contextSha256)
      : null;

  const resolution = resolveHeadlessProfileV1(profile, {
    providerProfiles: authority.providerProfiles,
    projectCeiling: project.ceiling,
    approvedPlan: run.plan,
  });
  if (providerDigest(resolution.provider) !== providerDigest(run.provider)) {
    denied("resolved profile provider does not equal the plan-approved run provider");
  }

  const payload = {
    schema: HEADLESS_EXECUTION_BINDING_SCHEMA,
    runId: run.id,
    projectId: project.id,
    baseCommit: run.baseCommit,
    contextSha256: run.contextSha256,
    planSha256: run.planSha256,
    egressApproval,
    planApproval,
    profileDigestSha256: resolution.profileDigestSha256,
    resolutionDigestSha256: resolution.resolutionDigestSha256,
  } as const;
  return {
    ...payload,
    bindingDigestSha256: digestJson(json(payload)),
    resolution,
  };
}

export function bindHeadlessExecutionV1(
  profile: unknown,
  authority: HeadlessExecutionBindingAuthorityV1,
): HeadlessExecutionBindingV1 {
  assertPristineRunningRun(authority.run);
  return bindHeadlessExecutionCurrentV1(profile, authority);
}

/**
 * H3b evidence reconstruction (ADR 0056). Recomputes the identical H2a
 * identity over current persisted inputs without requiring the pristine
 * pre-worker snapshot: after process death the run legitimately carries
 * workspace, patch, verification, or error state. The result remains
 * self-checking metadata only — it is not approval, a lease, or execution
 * authority, and it grants no continuation.
 */
export function reconstructHeadlessExecutionBindingV1(
  profile: unknown,
  authority: HeadlessExecutionBindingAuthorityV1,
): HeadlessExecutionBindingV1 {
  return bindHeadlessExecutionCurrentV1(profile, authority);
}
