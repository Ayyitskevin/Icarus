import { afterEach, describe, expect, it, vi } from "vitest";

import { runCliMain } from "../../packages/cli/src/main.js";
import { canonicalJson } from "../../packages/core/src/canonical-json.js";
import {
  bindHeadlessExecutionV1,
  type HeadlessExecutionBindingAuthorityV1,
} from "../../packages/core/src/headless-binding.js";
import {
  HEADLESS_RECONSTRUCTION_SCHEMA,
  type HeadlessReconstructionAuthorityV1,
  reconstructHeadlessEvidenceV1,
} from "../../packages/core/src/headless-reconstruction.js";
import {
  createInterruptedHeadlessWorkerSettlementV1,
  headlessWorkerSettledPayload,
  headlessWorkerStartedPayload,
} from "../../packages/core/src/headless-worker.js";
import { planApprovalDigest } from "../../packages/core/src/policy.js";
import type { IcarusRuntime } from "../../packages/core/src/runtime.js";
import type {
  ApprovalRecord,
  EventRecord,
  JsonValue,
  ProjectRecord,
  RunRecord,
} from "../../packages/core/src/types.js";
import {
  UNIT_BASE_COMMIT,
  UNIT_CEILING,
  UNIT_PLAN,
  UNIT_PROVIDER,
  UNIT_RUN_ID,
  UNIT_SANDBOX,
  unitContextDigest,
  unitContextManifest,
} from "../support/unit-fixtures.js";

const NOW = "2026-08-26T05:30:00.000Z";

function sourceProfile(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    profileId: "unit-one-task",
    providerProfileId: "unit-provider",
    toolIds: [],
    budgets: { ...UNIT_CEILING, iterationCeiling: 0 },
    output: { format: "jsonl" },
    worker: {
      mode: "one_task",
      maxConcurrency: 1,
      childRuns: "deny",
      scheduledRuns: "deny",
    },
  };
}

function baseFixture(): {
  readonly profile: Record<string, unknown>;
  readonly project: ProjectRecord;
  readonly pristineRun: RunRecord;
  readonly approvals: readonly ApprovalRecord[];
  readonly bindingAuthority: HeadlessExecutionBindingAuthorityV1;
} {
  const context = unitContextManifest();
  const project: ProjectRecord = {
    id: "project-unit",
    name: "unit-project",
    repositoryId: "repository-unit",
    baseRef: "main",
    checks: [{ id: "unit", name: "Unit check", argv: ["node", "--test"] }],
    sandbox: UNIT_SANDBOX,
    ceiling: UNIT_CEILING,
    createdAt: NOW,
  };
  const contextSha256 = unitContextDigest(context);
  const planSha256 = planApprovalDigest({
    task: "Update the greeting",
    baseCommit: UNIT_BASE_COMMIT,
    contextSha256,
    targets: context.targets,
    provider: UNIT_PROVIDER,
    checks: project.checks,
    sandbox: project.sandbox,
    ceiling: project.ceiling,
    plan: UNIT_PLAN,
    readableManifest: null,
  });
  const pristineRun: RunRecord = {
    id: UNIT_RUN_ID,
    projectId: project.id,
    task: "Update the greeting",
    target: UNIT_PLAN.target,
    provider: UNIT_PROVIDER,
    state: "running",
    resumeState: null,
    baseCommit: UNIT_BASE_COMMIT,
    context,
    contextArtifactPath: "/private/context.json",
    contextSha256,
    plan: UNIT_PLAN,
    planSha256,
    patchSet: null,
    cachePath: null,
    worktreePath: null,
    baselineBase64: null,
    approvedBase64: null,
    diff: null,
    verification: null,
    usage: {
      toolCalls: 2,
      inputTokens: 100,
      outputTokens: 50,
      activeRuntimeMs: 25,
      estimatedCostUsd: 0,
      reservedCostUsd: 0,
    },
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const approvals: readonly ApprovalRecord[] = [
    {
      runId: pristineRun.id,
      kind: "plan",
      digest: planSha256,
      actor: "unit-operator",
      decision: "approve",
      createdAt: NOW,
    },
  ];
  const bindingAuthority: HeadlessExecutionBindingAuthorityV1 = {
    run: pristineRun,
    project,
    approvals,
    readableManifest: null,
    providerProfiles: [
      {
        id: "unit-provider",
        kind: UNIT_PROVIDER.kind,
        model: UNIT_PROVIDER.model,
        baseUrl: UNIT_PROVIDER.baseUrl,
        inputUsdPerMillionTokens: UNIT_PROVIDER.inputUsdPerMillionTokens,
        outputUsdPerMillionTokens: UNIT_PROVIDER.outputUsdPerMillionTokens,
      },
    ],
  };
  return { profile: sourceProfile(), project, pristineRun, approvals, bindingAuthority };
}

function event(sequence: number, type: string, payload: JsonValue): EventRecord {
  return { sequence, runId: UNIT_RUN_ID, type, payload, createdAt: NOW };
}

function operationStarted(sequence: number, operationId: string, kind: string): EventRecord {
  return event(sequence, "operation.started", {
    operationId,
    kind,
    reservedCostUsd: 0,
    reservedTokens: 4,
    reservedRuntimeMs: 5,
  });
}

function operationInterrupted(sequence: number, operationId: string, kind: string): EventRecord {
  return event(sequence, "operation.interrupted", {
    operationId,
    kind,
    reservedCostUsd: 0,
    reservedTokens: 4,
    reservedRuntimeMs: 5,
  });
}

function operationFinished(
  sequence: number,
  operationId: string,
  kind: string,
  extra: Record<string, JsonValue> = {},
): EventRecord {
  return event(sequence, "operation.finished", {
    operationId,
    kind,
    outcome: "succeeded",
    detail: { observed: true },
    ...extra,
  });
}

/** A crashed run legitimately carries workspace and effect state. */
function crashedRun(pristineRun: RunRecord): RunRecord {
  return {
    ...pristineRun,
    worktreePath: "/private/worktree",
    cachePath: "/private/cache",
    diff: "diff",
    updatedAt: "2026-08-26T05:31:00.000Z",
  };
}

function crashFixture(): {
  readonly authority: HeadlessReconstructionAuthorityV1;
  readonly bindingDigestSha256: string;
} {
  const { profile, project, pristineRun, approvals, bindingAuthority } = baseFixture();
  const binding = bindHeadlessExecutionV1(profile, bindingAuthority);
  const run = crashedRun(pristineRun);
  const tail: EventRecord[] = [
    event(1, "headless.worker.started", headlessWorkerStartedPayload(binding)),
    operationStarted(2, "op-read-manifest", "session.tool.read.manifest"),
    operationFinished(3, "op-read-manifest", "session.tool.read.manifest"),
    operationStarted(4, "op-read-checks", "session.tool.read.checks"),
    operationInterrupted(5, "op-read-checks", "session.tool.read.checks"),
    operationStarted(6, "op-provider-edit", "provider.edit"),
    operationInterrupted(7, "op-provider-edit", "provider.edit"),
  ];
  const settlement = createInterruptedHeadlessWorkerSettlementV1({ run, events: tail });
  const events = [
    ...tail,
    event(8, "headless.worker.settled", headlessWorkerSettledPayload(settlement)),
  ];
  return {
    authority: { run, project, approvals, events, readableManifest: null },
    bindingDigestSha256: binding.bindingDigestSha256,
  };
}

describe("headless evidence reconstruction", () => {
  it("binds the latest monotonic session-iteration boundary into reconstruction", () => {
    const { profile, project, pristineRun, approvals, bindingAuthority } = baseFixture();
    const binding = bindHeadlessExecutionV1(profile, bindingAuthority);
    const run = crashedRun(pristineRun);
    const tail: EventRecord[] = [
      event(1, "headless.worker.started", headlessWorkerStartedPayload(binding)),
      operationStarted(2, "op-revise", "provider.revise"),
      operationFinished(3, "op-revise", "provider.revise"),
      operationStarted(4, "op-read", "session.tool.read.manifest"),
      operationFinished(5, "op-read", "session.tool.read.manifest"),
      event(6, "session.iteration_completed", { iterations: 1 }),
    ];
    const settlement = createInterruptedHeadlessWorkerSettlementV1({ run, events: tail });
    const events = [
      ...tail,
      event(7, "headless.worker.settled", headlessWorkerSettledPayload(settlement)),
    ];
    const authority = { run, project, approvals, events, readableManifest: null };
    const result = reconstructHeadlessEvidenceV1(authority);

    expect(result).toMatchObject({
      schema: "icarus.headless.reconstruction.v2",
      sessionIterationBoundary: { eventSequence: 6, iterations: 1 },
    });
    const withoutBoundary = reconstructHeadlessEvidenceV1({
      ...authority,
      events: events.filter((candidate) => candidate.type !== "session.iteration_completed"),
    });
    expect(withoutBoundary).not.toHaveProperty("sessionIterationBoundary");
    expect(withoutBoundary.reconstructionDigestSha256).not.toBe(result.reconstructionDigestSha256);
    expect(() =>
      reconstructHeadlessEvidenceV1({
        ...authority,
        events: [
          ...tail,
          event(7, "session.iteration_completed", { iterations: 3 }),
          event(8, "headless.worker.settled", headlessWorkerSettledPayload(settlement)),
        ],
      }),
    ).toThrowError(/malformed or nonmonotonic/);
  });

  it("reconstructs the exact binding and classifies a reconciled crash tail", () => {
    const { authority, bindingDigestSha256 } = crashFixture();
    const result = reconstructHeadlessEvidenceV1(authority);

    expect(result).toMatchObject({
      schema: HEADLESS_RECONSTRUCTION_SCHEMA,
      runId: UNIT_RUN_ID,
      projectId: "project-unit",
      lifecycle: "settled",
      startedEventSequence: 1,
      bindingDigestSha256,
      planSha256: authority.run.planSha256,
      provider: {
        kind: UNIT_PROVIDER.kind,
        model: UNIT_PROVIDER.model,
        baseUrl: UNIT_PROVIDER.baseUrl,
        locality: "loopback",
      },
      workspace: {
        baseCommit: UNIT_BASE_COMMIT,
        contextSha256: authority.run.contextSha256,
        worktreeMaterialized: true,
      },
    });
    expect(result.profileDigestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.resolutionDigestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.reconstructionDigestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.effects).toEqual([
      {
        operationId: "op-read-manifest",
        kind: "session.tool.read.manifest",
        startedSequence: 2,
        settlementSequence: 3,
        settlement: "finished",
        disposition: "durably_settled",
      },
      {
        operationId: "op-read-checks",
        kind: "session.tool.read.checks",
        startedSequence: 4,
        settlementSequence: 5,
        settlement: "interrupted",
        disposition: "no_effect",
      },
      {
        operationId: "op-provider-edit",
        kind: "provider.edit",
        startedSequence: 6,
        settlementSequence: 7,
        settlement: "interrupted",
        disposition: "ambiguous",
      },
    ]);
  });

  it("returns byte-identical canonical output for the same durable bytes", () => {
    const { authority } = crashFixture();
    const first = reconstructHeadlessEvidenceV1(authority);
    const second = reconstructHeadlessEvidenceV1(authority);
    expect(canonicalJson(first as unknown as JsonValue)).toBe(
      canonicalJson(second as unknown as JsonValue),
    );
    expect(second.reconstructionDigestSha256).toBe(first.reconstructionDigestSha256);
  });

  it("reconstructs an unreconciled crash tail without settling anything", () => {
    const { profile, project, pristineRun, approvals, bindingAuthority } = baseFixture();
    const binding = bindHeadlessExecutionV1(profile, bindingAuthority);
    const run = crashedRun(pristineRun);
    const events = [
      event(1, "headless.worker.started", headlessWorkerStartedPayload(binding)),
      operationStarted(2, "op-provider-edit", "provider.edit"),
    ];
    const result = reconstructHeadlessEvidenceV1({
      run,
      project,
      approvals,
      events,
      readableManifest: null,
    });
    expect(result.lifecycle).toBe("started");
    expect(result.bindingDigestSha256).toBe(binding.bindingDigestSha256);
    expect(result.effects).toEqual([
      {
        operationId: "op-provider-edit",
        kind: "provider.edit",
        startedSequence: 2,
        settlementSequence: null,
        settlement: null,
        disposition: "ambiguous",
      },
    ]);
  });

  it("requires the original lifecycle binding digest exactly", () => {
    const { profile, project, pristineRun, approvals, bindingAuthority } = baseFixture();
    const binding = bindHeadlessExecutionV1(profile, bindingAuthority);
    const forged = "0".repeat(64);
    const forgedPayload = {
      ...(headlessWorkerStartedPayload(binding) as Record<string, JsonValue>),
      bindingDigestSha256: forged,
    };
    const run = crashedRun(pristineRun);
    const tail = [event(1, "headless.worker.started", forgedPayload)];
    const settlement = createInterruptedHeadlessWorkerSettlementV1({ run, events: tail });
    const events = [
      ...tail,
      event(2, "headless.worker.settled", headlessWorkerSettledPayload(settlement)),
    ];
    expect(() =>
      reconstructHeadlessEvidenceV1({ run, project, approvals, events, readableManifest: null }),
    ).toThrowError(/does not match the durable headless lifecycle/);
  });

  it("fails closed when the current persisted authority drifts", () => {
    const { authority } = crashFixture();
    const approval = authority.approvals[0];
    if (approval === undefined) throw new Error("approval fixture missing");
    expect(() =>
      reconstructHeadlessEvidenceV1({
        ...authority,
        approvals: [{ ...approval, actor: "second-operator" }],
      }),
    ).toThrowError(/does not match the durable headless lifecycle/);
    // Provider drift is caught at the resolution layer because the recomputed
    // resolution digest binds the exact provider the worker recorded.
    expect(() =>
      reconstructHeadlessEvidenceV1({
        ...authority,
        run: { ...authority.run, provider: { ...authority.run.provider, model: "other-model" } },
      }),
    ).toThrowError(/does not match the durable worker start/);
    // Task drift passes the lifecycle digests but breaks the recomputed plan
    // approval digest inside the binding.
    expect(() =>
      reconstructHeadlessEvidenceV1({
        ...authority,
        run: { ...authority.run, task: "Change everything" },
      }),
    ).toThrowError(/plan digest no longer matches/);
    expect(() =>
      reconstructHeadlessEvidenceV1({
        ...authority,
        project: { ...authority.project, id: "project-other" },
      }),
    ).toThrowError(/identities do not match/);
  });

  it("fails closed on tampered or widened durable start payloads", () => {
    const { authority } = crashFixture();
    const started = authority.events[0];
    if (started === undefined) throw new Error("start fixture missing");
    const payload = started.payload as Record<string, JsonValue>;
    const tamperedProfile = { ...payload, profileId: "other-profile" };
    expect(() =>
      reconstructHeadlessEvidenceV1({
        ...authority,
        events: [{ ...started, payload: tamperedProfile }, ...authority.events.slice(1)],
      }),
    ).toThrowError(/does not match the durable worker start/);
    const widened = { ...payload, schedule: "hourly" };
    expect(() =>
      reconstructHeadlessEvidenceV1({
        ...authority,
        events: [{ ...started, payload: widened }, ...authority.events.slice(1)],
      }),
    ).toThrowError(/members are malformed/);
  });

  it("refuses malformed worker lifecycles and absent workers", () => {
    const { authority } = crashFixture();
    const started = authority.events[0];
    if (started === undefined) throw new Error("start fixture missing");
    expect(() =>
      reconstructHeadlessEvidenceV1({
        ...authority,
        events: [started, { ...started, sequence: 9 }, ...authority.events.slice(1)],
      }),
    ).toThrowError(/exactly one start/);
    expect(() =>
      reconstructHeadlessEvidenceV1({
        ...authority,
        events: authority.events.filter(
          (candidate) => candidate.type !== "headless.worker.started",
        ),
      }),
    ).toThrowError(/never started|without a start/);
    expect(() => reconstructHeadlessEvidenceV1({ ...authority, events: [] })).toThrowError(
      /Headless worker never started/,
    );
  });

  it("treats resume intent inside the lifecycle as malformed evidence", () => {
    const { authority } = crashFixture();
    const resumed = event(9, "resume.requested", { actor: "unit-operator" });
    expect(() =>
      reconstructHeadlessEvidenceV1({ ...authority, events: [...authority.events, resumed] }),
    ).toThrowError(/resume intent/);
  });

  it("classifies missing, extra, contradictory, and unknown evidence as ambiguous", () => {
    const { profile, project, pristineRun, approvals, bindingAuthority } = baseFixture();
    const binding = bindHeadlessExecutionV1(profile, bindingAuthority);
    const run = crashedRun(pristineRun);
    const classify = (tail: readonly EventRecord[]) =>
      reconstructHeadlessEvidenceV1({
        run,
        project,
        approvals,
        events: [
          event(1, "headless.worker.started", headlessWorkerStartedPayload(binding)),
          ...tail,
        ],
        readableManifest: null,
      }).effects;

    // Extra terminator without a durable start.
    expect(classify([operationFinished(2, "op-extra", "provider.edit")])).toEqual([
      expect.objectContaining({ operationId: "op-extra", kind: null, disposition: "ambiguous" }),
    ]);
    // Duplicate starts for one operation.
    expect(
      classify([
        operationStarted(2, "op-dup", "provider.edit"),
        operationStarted(3, "op-dup", "provider.edit"),
      ]),
    ).toEqual([expect.objectContaining({ operationId: "op-dup", disposition: "ambiguous" })]);
    // Contradictory kind identity between start and finish.
    expect(
      classify([
        operationStarted(2, "op-kind", "provider.edit"),
        operationFinished(3, "op-kind", "provider.revise"),
      ]),
    ).toEqual([expect.objectContaining({ operationId: "op-kind", disposition: "ambiguous" })]);
    // A receipt with extra or missing members is not a durable settlement.
    expect(
      classify([
        operationStarted(2, "op-receipt-extra", "provider.edit"),
        operationFinished(3, "op-receipt-extra", "provider.edit", { replayed: true }),
      ]),
    ).toEqual([
      expect.objectContaining({ operationId: "op-receipt-extra", disposition: "ambiguous" }),
    ]);
    expect(
      classify([
        operationStarted(2, "op-receipt-missing", "provider.edit"),
        event(3, "operation.finished", {
          operationId: "op-receipt-missing",
          kind: "provider.edit",
          outcome: "succeeded",
        }),
      ]),
    ).toEqual([
      expect.objectContaining({ operationId: "op-receipt-missing", disposition: "ambiguous" }),
    ]);
    // An unknown operation kind never earns a positive label.
    expect(
      classify([
        operationStarted(2, "op-unknown", "plugin.foreign"),
        operationInterrupted(3, "op-unknown", "plugin.foreign"),
      ]),
    ).toEqual([expect.objectContaining({ operationId: "op-unknown", disposition: "ambiguous" })]);
    // An out-of-order terminator contradicts the start.
    expect(
      classify([
        operationFinished(2, "op-order", "provider.edit"),
        operationStarted(3, "op-order", "provider.edit"),
      ]),
    ).toEqual([expect.objectContaining({ operationId: "op-order", disposition: "ambiguous" })]);
    // A still-open read-only operation has provably no external effect.
    expect(classify([operationStarted(2, "op-open-read", "session.tool.read.manifest")])).toEqual([
      expect.objectContaining({
        operationId: "op-open-read",
        settlement: null,
        disposition: "no_effect",
      }),
    ]);
  });

  it("emits metadata only: no private paths, pricing, plans, or receipts", () => {
    const { authority } = crashFixture();
    const serialized = canonicalJson(
      reconstructHeadlessEvidenceV1(authority) as unknown as JsonValue,
    );
    expect(serialized).not.toContain("/private/worktree");
    expect(serialized).not.toContain("/private/cache");
    expect(serialized).not.toContain("/private/context.json");
    expect(serialized).not.toContain("inputUsdPerMillionTokens");
    expect(serialized).not.toContain("steps");
    expect(serialized).not.toContain("detail");
  });
});

describe("headless reconstruction CLI", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prints one canonical record and performs no other service call", async () => {
    const previousHome = process.env.ICARUS_HOME;
    const previousExitCode = process.exitCode;
    const { authority, bindingDigestSha256 } = crashFixture();
    const result = reconstructHeadlessEvidenceV1(authority);
    expect(result.bindingDigestSha256).toBe(bindingDigestSha256);
    const service = {
      reconstructHeadlessEvidence: vi.fn(() => result),
    };
    const close = vi.fn();
    const createRuntime = vi.fn(async () => ({ service, close }) as unknown as IcarusRuntime);
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    process.env.ICARUS_HOME = "/tmp/icarus-headless-reconstruction-cli-unit";
    process.exitCode = undefined;
    try {
      await runCliMain({
        args: ["run", "reconstruct-headless", UNIT_RUN_ID],
        platform: "linux",
        createRuntime,
      });
      expect(stderr).toEqual([]);
      expect(process.exitCode).toBeUndefined();
      expect(service.reconstructHeadlessEvidence).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      const output = stdout.join("");
      expect(output).toBe(`${canonicalJson(result as unknown as JsonValue)}\n`);
      expect(JSON.parse(output)).toMatchObject({
        schema: HEADLESS_RECONSTRUCTION_SCHEMA,
        runId: UNIT_RUN_ID,
      });
    } finally {
      process.exitCode = previousExitCode;
      if (previousHome === undefined) delete process.env.ICARUS_HOME;
      else process.env.ICARUS_HOME = previousHome;
    }
  });
});
