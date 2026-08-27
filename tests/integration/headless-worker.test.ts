import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ArtifactStore } from "../../packages/core/src/artifacts.js";
import { sha256 } from "../../packages/core/src/digest.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import type {
  GitController,
  PrivateWorkspace,
  RepositoryInspection,
  TreeEntry,
} from "../../packages/core/src/git.js";
import { bindHeadlessExecutionV1 } from "../../packages/core/src/headless-binding.js";
import type { HeadlessProfileV1 } from "../../packages/core/src/headless-profile.js";
import {
  createAppliedHeadlessWorkerSettlementV1,
  createInterruptedHeadlessWorkerSettlementV1,
  HEADLESS_WORKER_APPLY_SCHEMA,
  headlessPatchSetDigestV1,
} from "../../packages/core/src/headless-worker.js";
import { DEFAULT_CEILING, DEFAULT_SANDBOX_LIMITS } from "../../packages/core/src/policy.js";
import {
  createProviderConfig,
  type ModelGateway,
  type StructuredGenerationRequest,
} from "../../packages/core/src/provider.js";
import type { CheckRunInput, CheckRunner } from "../../packages/core/src/sandbox.js";
import { IcarusService } from "../../packages/core/src/service.js";
import { IcarusStore } from "../../packages/core/src/store.js";
import type {
  CheckEvidence,
  CheckpointFile,
  JsonValue,
  PatchSet,
  ProviderConfig,
  SunCeiling,
} from "../../packages/core/src/types.js";

const TARGET = "src/greeting.txt";
const BASELINE = "Hello, world!\n";
const BROKEN = "Hello, Icrus!\n";
const FIXED = "Hello, Icarus!\n";
const BASE_COMMIT = "b".repeat(40);
const IMAGE = `python@sha256:${"c".repeat(64)}`;
const cleanupRoots: string[] = [];

const CEILING: SunCeiling = {
  ...DEFAULT_CEILING,
  maxActiveRuntimeMs: 120_000,
  commandTimeoutMs: 5_000,
  providerTimeoutMs: 5_000,
  maxOutputTokensPerCall: 512,
  maxTotalTokens: 50_000,
};

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

class ControlledGit {
  constructor(readonly repositoryPath: string) {}

  inspectRepository(): Promise<RepositoryInspection> {
    return Promise.resolve({
      canonicalPath: this.repositoryPath,
      device: 1,
      inode: 2,
      head: BASE_COMMIT,
    });
  }
  resolveCommit(): Promise<string> {
    return Promise.resolve(BASE_COMMIT);
  }
  assertCleanAtCommit(): Promise<void> {
    return Promise.resolve();
  }
  listTree(): Promise<TreeEntry[]> {
    return Promise.resolve([
      { mode: "100644", type: "blob", objectId: "d".repeat(40), path: TARGET },
    ]);
  }
  readBlob(): Promise<Buffer> {
    return Promise.resolve(Buffer.from(BASELINE, "utf8"));
  }
  async createPrivateWorkspace(
    _sourceRepository: string,
    _commit: string,
    runRoot: string,
  ): Promise<PrivateWorkspace> {
    const cachePath = path.join(runRoot, "git-cache.git");
    const worktreePath = path.join(runRoot, "worktree");
    await mkdir(cachePath, { recursive: true, mode: 0o700 });
    await mkdir(path.join(worktreePath, "src"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(worktreePath, TARGET), BASELINE, "utf8");
    return { cachePath, worktreePath };
  }
  readRegularUtf8File(worktreePath: string, target: string): Promise<string> {
    return readFile(path.join(worktreePath, target), "utf8");
  }
  async readOptionalRegularUtf8File(worktreePath: string, target: string): Promise<string | null> {
    try {
      return await readFile(path.join(worktreePath, target), "utf8");
    } catch {
      return null;
    }
  }
  atomicWriteUtf8(worktreePath: string, target: string, value: string): Promise<void> {
    return writeFile(path.join(worktreePath, target), value, "utf8");
  }
  async applyFileWrites(
    worktreePath: string,
    writes: readonly { readonly path: string; readonly content: string | null }[],
  ): Promise<void> {
    for (const write of writes) {
      const absolute = path.join(worktreePath, write.path);
      if (write.content === null) await rm(absolute, { force: true });
      else await writeFile(absolute, write.content, "utf8");
    }
  }
  stageIntentToAdd(): Promise<void> {
    return Promise.resolve();
  }
  resetIndex(): Promise<void> {
    return Promise.resolve();
  }
  async changedPaths(worktreePath: string): Promise<string[]> {
    return (await this.readRegularUtf8File(worktreePath, TARGET)) === BASELINE ? [] : [TARGET];
  }
  async diff(worktreePath: string): Promise<string> {
    const current = await this.readRegularUtf8File(worktreePath, TARGET);
    if (current === BASELINE) throw new IcarusError("EMPTY_DIFF", "Synthetic worktree is clean");
    return [
      `diff --git a/${TARGET} b/${TARGET}`,
      `--- a/${TARGET}`,
      `+++ b/${TARGET}`,
      `-${BASELINE.trimEnd()}`,
      `+${current.trimEnd()}`,
      "",
    ].join("\n");
  }
}

class ControlledChecks implements CheckRunner {
  reconcile(): Promise<void> {
    return Promise.resolve();
  }
  async runChecks(input: CheckRunInput): Promise<readonly CheckEvidence[]> {
    const current = await readFile(path.join(input.worktreePath, TARGET), "utf8");
    const passed = current === FIXED;
    return input.checks.map((check) => ({
      checkId: check.id,
      argv: check.argv,
      exitCode: passed ? 0 : 1,
      signal: null,
      durationMs: 1,
      stdout: passed ? "ok\n" : "not fixed\n",
      stderr: "",
      truncated: false,
      outcome: passed ? "passed" : "failed",
    }));
  }
}

function patchSet(value: string): JsonValue {
  return {
    summary: "Apply the approved greeting.",
    edits: [
      {
        op: "modify",
        path: TARGET,
        expectedPreimageSha256: sha256(BASELINE),
        replacements: [{ findText: BASELINE, replaceText: value }],
        content: null,
        rationale: "Replace one operator-selected file.",
      },
    ],
  };
}

function plan(iterations: number): JsonValue {
  return {
    summary: "Replace the greeting.",
    steps: ["Apply one exact replacement.", "Run verification."],
    risks: ["The preimage may differ."],
    target: TARGET,
    targets: [TARGET],
    iterationCeiling: iterations,
    checkIds: ["verify"],
    grants: iterations === 0 ? [] : [{ kind: "mutation.patchset", scope: [TARGET], maxCalls: 2 }],
  };
}

function gatewayFactory(
  outputs: readonly JsonValue[],
  hook?: (request: StructuredGenerationRequest) => void,
  estimatedCostUsd = 0,
): (config: ProviderConfig) => ModelGateway {
  const queue = [...outputs];
  return (config) => ({
    config,
    generateStructured: (request) => {
      hook?.(request);
      const output = queue.shift();
      if (output === undefined) throw new Error("Synthetic provider queue exhausted");
      return Promise.resolve({
        text: JSON.stringify(output),
        usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd, latencyMs: 1 },
      });
    },
  });
}

interface Fixture {
  readonly service: IcarusService;
  readonly store: IcarusStore;
  readonly provider: ProviderConfig;
  close(): void;
}

async function fixture(
  outputs: readonly JsonValue[],
  hook?: (request: StructuredGenerationRequest) => void,
  estimatedCostUsd = 0,
  providerOverride?: ProviderConfig,
): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "icarus-headless-worker-"));
  cleanupRoots.push(root);
  const stateRoot = path.join(root, "state");
  const repositoryPath = path.join(root, "repository");
  await mkdir(stateRoot, { mode: 0o700 });
  await mkdir(path.join(repositoryPath, "src"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(repositoryPath, TARGET), BASELINE, "utf8");
  const store = new IcarusStore(path.join(stateRoot, "icarus.sqlite3"));
  const service = new IcarusService({
    stateRoot,
    store,
    artifacts: new ArtifactStore(stateRoot),
    git: new ControlledGit(repositoryPath) as unknown as GitController,
    checks: new ControlledChecks(),
    gatewayFactory: gatewayFactory(outputs, hook, estimatedCostUsd),
  });
  await service.initialize();
  await service.registerRepository("fixture", repositoryPath);
  service.createProject({
    name: "headless-test",
    repositoryName: "fixture",
    baseRef: "main",
    checks: [{ id: "verify", name: "Synthetic verification", argv: ["synthetic-check"] }],
    sandbox: { image: IMAGE, ...DEFAULT_SANDBOX_LIMITS },
    ceiling: CEILING,
  });
  const provider =
    providerOverride ??
    createProviderConfig({
      kind: "ollama",
      model: "synthetic-model",
      baseUrl: "http://127.0.0.1:11434/",
      ...(estimatedCostUsd === 0
        ? {}
        : { inputUsdPerMillionTokens: 100, outputUsdPerMillionTokens: 100 }),
    });
  return { service, store, provider, close: () => store.close() };
}

function profile(
  iterationCeiling: number,
  toolIds: HeadlessProfileV1["toolIds"] = [],
): HeadlessProfileV1 {
  return {
    schemaVersion: 1,
    profileId: "local-headless",
    providerProfileId: "local-provider",
    toolIds,
    budgets: { ...CEILING, iterationCeiling },
    output: { format: "jsonl" },
    worker: {
      mode: "one_task",
      maxConcurrency: 1,
      childRuns: "deny",
      scheduledRuns: "deny",
      mutation: "apply",
    },
  };
}

const PROVIDER_CATALOG = [
  {
    id: "local-provider",
    kind: "ollama" as const,
    model: "synthetic-model",
    baseUrl: "http://127.0.0.1:11434/",
    inputUsdPerMillionTokens: null,
    outputUsdPerMillionTokens: null,
  },
];

async function plannedRun(current: Fixture, iterations: number) {
  return current.service
    .planRun({
      projectName: "headless-test",
      task: "Replace the greeting.",
      targets: [TARGET],
      provider: current.provider,
    })
    .then((run) => {
      expect(run.plan?.iterationCeiling).toBe(iterations);
      return run;
    });
}

describe("bounded headless worker", () => {
  test("binds before effects and settles a passing task review-ready", async () => {
    const current = await fixture([plan(0), patchSet(FIXED)]);
    try {
      const planned = await plannedRun(current, 0);
      const result = await current.service.approveHeadlessPlan(
        planned.id,
        planned.planSha256 ?? "",
        "headless-operator",
        profile(0),
        PROVIDER_CATALOG,
      );
      expect(result.settlement).toMatchObject({ outcome: "review_ready", exitCode: 0 });
      expect(result.run.state).toBe("awaiting_review");
      const events = current.store.listEvents(planned.id);
      expect(events.findIndex((event) => event.type === "headless.worker.started")).toBeLessThan(
        events.findIndex((event) => event.type === "workspace.created"),
      );
      expect(events.at(-1)?.type).toBe("headless.worker.settled");
    } finally {
      current.close();
    }
  });

  test("settles failed initial checks durably with exit 1", async () => {
    const current = await fixture([plan(0), patchSet(BROKEN)]);
    try {
      const planned = await plannedRun(current, 0);
      const result = await current.service.approveHeadlessPlan(
        planned.id,
        planned.planSha256 ?? "",
        "headless-operator",
        profile(0),
        PROVIDER_CATALOG,
      );
      expect(result.run.state).toBe("awaiting_review");
      expect(result.run.verification?.outcome).toBe("failed");
      expect(result.run.lastError).toBeNull();
      expect(result.settlement).toMatchObject({
        outcome: "failed",
        exitCode: 1,
        error: { code: "HEADLESS_VERIFICATION_FAILED" },
      });
      expect(current.store.listEvents(planned.id).at(-1)).toMatchObject({
        type: "headless.worker.settled",
        payload: {
          outcome: "failed",
          exitCode: 1,
          error: { code: "HEADLESS_VERIFICATION_FAILED" },
        },
      });
    } finally {
      current.close();
    }
  });

  test("enforces a tighter profile operation ceiling", async () => {
    const current = await fixture([plan(0), patchSet(FIXED)]);
    try {
      const planned = await plannedRun(current, 0);
      const constrained = profile(0);
      await expect(
        current.service.approveHeadlessPlan(
          planned.id,
          planned.planSha256 ?? "",
          "headless-operator",
          { ...constrained, budgets: { ...constrained.budgets, maxToolCalls: 1 } },
          PROVIDER_CATALOG,
        ),
      ).rejects.toMatchObject({ code: "HEADLESS_PROFILE_ALREADY_EXHAUSTED" });
      expect(current.store.getRun(planned.id).state).toBe("awaiting_approval");
      expect(
        current.store
          .listEvents(planned.id)
          .some((event) => event.type === "headless.worker.started"),
      ).toBe(false);
    } finally {
      current.close();
    }
  });

  test("refuses an already-spent approval envelope before granting plan authority", async () => {
    const current = await fixture([plan(0)], undefined, 0.25);
    try {
      const planned = await plannedRun(current, 0);
      const eventCount = current.store.listEvents(planned.id).length;
      const providerCatalog = [{ id: "local-provider", ...current.provider }];

      await expect(
        current.service.approveHeadlessPlan(
          planned.id,
          planned.planSha256 ?? "",
          "headless-operator",
          profile(0),
          providerCatalog,
          undefined,
          { maxBudgetUsd: 0.1 },
        ),
      ).rejects.toMatchObject({ code: "HEADLESS_ENVELOPE_EXHAUSTED" });
      expect(current.store.getRun(planned.id).state).toBe("awaiting_approval");
      expect(current.store.listApprovals(planned.id)).toHaveLength(0);
      expect(current.store.listEvents(planned.id)).toHaveLength(eventCount);
    } finally {
      current.close();
    }
  });

  test("refuses an already-spent apply envelope before granting apply authority", async () => {
    const current = await fixture([plan(0), patchSet(FIXED)], undefined, 0.25);
    try {
      const planned = await plannedRun(current, 0);
      const providerCatalog = [{ id: "local-provider", ...current.provider }];
      const proposeProfile = profile(0);
      const { mutation: _mutation, ...workerWithoutMutation } = proposeProfile.worker;
      const proposed = await current.service.approveHeadlessPlan(
        planned.id,
        planned.planSha256 ?? "",
        "headless-operator",
        { ...proposeProfile, worker: workerWithoutMutation },
        providerCatalog,
      );
      const patchSetSha256 = (
        proposed.settlement as { readonly proposal: { readonly patchSetSha256: string } }
      ).proposal.patchSetSha256;
      const eventCount = current.store.listEvents(planned.id).length;

      await expect(
        current.service.applyHeadlessProposal(planned.id, patchSetSha256, "headless-operator", {
          maxBudgetUsd: 0.1,
        }),
      ).rejects.toMatchObject({ code: "HEADLESS_ENVELOPE_EXHAUSTED" });
      expect(current.store.listApprovals(planned.id).map((approval) => approval.kind)).toEqual([
        "plan",
      ]);
      expect(current.store.listEvents(planned.id)).toHaveLength(eventCount);
    } finally {
      current.close();
    }
  });

  test("meters and refuses a session tool disabled by the profile", async () => {
    const current = await fixture([
      plan(1),
      patchSet(BROKEN),
      { toolCalls: [{ name: "apply_patchset", arguments: { patchSet: patchSet(FIXED) } }] },
    ]);
    try {
      const planned = await plannedRun(current, 1);
      const result = await current.service.approveHeadlessPlan(
        planned.id,
        planned.planSha256 ?? "",
        "headless-operator",
        profile(1, ["report_done"]),
        PROVIDER_CATALOG,
      );
      expect(result.settlement).toMatchObject({ outcome: "exhausted", exitCode: 2 });
      expect(result.run.state).toBe("awaiting_review");
      expect(current.store.listEvents(planned.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "session.exhausted" }),
          expect.objectContaining({ type: "headless.worker.settled" }),
        ]),
      );
    } finally {
      current.close();
    }
  });

  test("proposes only in propose mode and applies only with the exact digest", async () => {
    const current = await fixture([plan(0), patchSet(FIXED)]);
    try {
      const planned = await plannedRun(current, 0);
      const proposeProfile = profile(0);
      // The ADR 0060 default: no mutation field means propose-only.
      const { mutation: _mutation, ...workerWithoutMutation } = proposeProfile.worker;
      const result = await current.service.approveHeadlessPlan(
        planned.id,
        planned.planSha256 ?? "",
        "headless-operator",
        { ...proposeProfile, worker: workerWithoutMutation },
        PROVIDER_CATALOG,
      );
      expect(result.settlement).toMatchObject({
        schema: "icarus.headless.worker-proposal.v1",
        outcome: "proposed",
        exitCode: 10,
        finalState: "running",
        error: null,
      });
      expect(result.run.state).toBe("running");
      const patchSetSha256 = (
        result.settlement as { readonly proposal?: { readonly patchSetSha256?: string } }
      ).proposal?.patchSetSha256;
      expect(patchSetSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(
        await current.service
          .applyHeadlessProposal(planned.id, "0".repeat(64), "headless-operator")
          .then(
            () => {
              throw new Error("apply with a wrong digest must refuse");
            },
            (error: unknown) => error,
          ),
      ).toMatchObject({ code: "HEADLESS_APPLY_DENIED" });
      expect(
        current.store.listApprovals(planned.id).filter((approval) => approval.kind === "apply"),
      ).toHaveLength(0);

      const applied = await current.service.applyHeadlessProposal(
        planned.id,
        patchSetSha256 as string,
        "headless-operator",
      );
      expect(applied.settlement).toMatchObject({
        schema: "icarus.headless.worker-application.v1",
        outcome: "review_ready",
        exitCode: 0,
        application: { patchSetSha256 },
      });
      expect(applied.run.state).toBe("awaiting_review");
      expect(applied.run.verification?.outcome).toBe("passed");
      expect(current.store.listApprovals(planned.id).map((approval) => approval.kind)).toEqual([
        "plan",
        "apply",
      ]);
      const eventCount = current.store.listEvents(planned.id).length;
      const repeated = await current.service.applyHeadlessProposal(
        planned.id,
        patchSetSha256 as string,
        "headless-operator",
      );
      expect(repeated.settlement).toEqual(applied.settlement);
      expect(current.store.listEvents(planned.id)).toHaveLength(eventCount);
    } finally {
      current.close();
    }
  });

  test("keeps a priced loopback vulcan proposal closed to the later apply act", async () => {
    let providerCalls = 0;
    const vulcan = createProviderConfig({
      kind: "vulcan",
      model: "code",
      baseUrl: "http://127.0.0.1:8140/v1/",
      inputUsdPerMillionTokens: 3,
      outputUsdPerMillionTokens: 15,
    });
    const current = await fixture(
      [plan(0), patchSet(FIXED)],
      () => {
        providerCalls += 1;
      },
      0,
      vulcan,
    );
    try {
      const planned = await plannedRun(current, 0);
      const selected = profile(0);
      const proposed = await current.service.approveHeadlessPlan(
        planned.id,
        planned.planSha256 ?? "",
        "headless-operator",
        { ...selected, worker: { ...selected.worker, mutation: "propose" } },
        [{ id: "local-provider", ...vulcan }],
      );
      expect(proposed.settlement).toMatchObject({
        schema: "icarus.headless.worker-proposal.v1",
        outcome: "proposed",
        exitCode: 10,
      });
      expect(proposed.run.provider.kind).toBe("vulcan");
      expect(providerCalls).toBe(2);
      const patchSetSha256 = (
        proposed.settlement as { readonly proposal: { readonly patchSetSha256: string } }
      ).proposal.patchSetSha256;

      await expect(
        current.service.applyHeadlessProposal(planned.id, patchSetSha256, "headless-operator"),
      ).rejects.toMatchObject({ code: "HEADLESS_APPLY_DENIED" });
      expect(providerCalls).toBe(2);
      expect(current.store.listApprovals(planned.id).map((approval) => approval.kind)).toEqual([
        "plan",
      ]);
      expect(current.store.getRun(planned.id).state).toBe("running");
    } finally {
      current.close();
    }
  });

  test("the store refuses a direct apply grant for a non-checkpoint digest", async () => {
    const current = await fixture([plan(0), patchSet(FIXED)]);
    try {
      const planned = await plannedRun(current, 0);
      const proposeProfile = profile(0);
      const { mutation: _mutation, ...workerWithoutMutation } = proposeProfile.worker;
      await current.service.approveHeadlessPlan(
        planned.id,
        planned.planSha256 ?? "",
        "headless-operator",
        { ...proposeProfile, worker: workerWithoutMutation },
        PROVIDER_CATALOG,
      );
      const started = current.store
        .listEvents(planned.id)
        .find((event) => event.type === "headless.worker.started");
      expect(started).toBeDefined();
      if (started === undefined) throw new Error("Expected a durable worker start");
      const bindingDigestSha256 = (started.payload as { readonly bindingDigestSha256?: unknown })
        .bindingDigestSha256;

      expect(() =>
        current.store.recordHeadlessWorkerApplyRequested(
          planned.id,
          {
            schema: HEADLESS_WORKER_APPLY_SCHEMA,
            runId: planned.id,
            bindingDigestSha256: bindingDigestSha256 as string,
            patchSetSha256: "0".repeat(64),
            startedEventSequence: started.sequence,
          },
          "headless-operator",
        ),
      ).toThrowError(/durable checkpoint/);
      expect(current.store.listApprovals(planned.id).map((approval) => approval.kind)).toEqual([
        "plan",
      ]);
    } finally {
      current.close();
    }
  });

  test("reconciliation closes a crashed application epoch and spends its allowance", async () => {
    const current = await fixture([plan(0), patchSet(FIXED)]);
    try {
      const planned = await plannedRun(current, 0);
      const proposeProfile = profile(0);
      const { mutation: _mutation, ...workerWithoutMutation } = proposeProfile.worker;
      const proposed = await current.service.approveHeadlessPlan(
        planned.id,
        planned.planSha256 ?? "",
        "headless-operator",
        { ...proposeProfile, worker: workerWithoutMutation },
        PROVIDER_CATALOG,
      );
      const proposal = proposed.settlement as {
        readonly proposal: { readonly patchSetSha256: string };
      };
      const started = current.store
        .listEvents(planned.id)
        .find((event) => event.type === "headless.worker.started");
      expect(started).toBeDefined();
      if (started === undefined) throw new Error("Expected a durable worker start");
      const bindingDigestSha256 = (started.payload as { readonly bindingDigestSha256?: unknown })
        .bindingDigestSha256;
      expect(bindingDigestSha256).toMatch(/^[a-f0-9]{64}$/);

      current.store.recordHeadlessWorkerApplyRequested(
        planned.id,
        {
          schema: HEADLESS_WORKER_APPLY_SCHEMA,
          runId: planned.id,
          bindingDigestSha256: bindingDigestSha256 as string,
          patchSetSha256: proposal.proposal.patchSetSha256,
          startedEventSequence: started.sequence,
        },
        "headless-operator",
      );
      const interrupted = createInterruptedHeadlessWorkerSettlementV1({
        run: current.store.getRun(planned.id),
        events: current.store.listEvents(planned.id),
      });

      expect(() =>
        current.store.recordHeadlessWorkerSettled(planned.id, interrupted),
      ).not.toThrow();
      expect(current.store.listEvents(planned.id).at(-1)).toMatchObject({
        type: "headless.worker.settled",
        payload: {
          schema: "icarus.headless.worker-interruption.v1",
          outcome: "interrupted",
        },
      });
      await expect(
        current.service.applyHeadlessProposal(
          planned.id,
          proposal.proposal.patchSetSha256,
          "headless-operator",
        ),
      ).rejects.toMatchObject({ code: "HEADLESS_APPLY_EXHAUSTED" });
    } finally {
      current.close();
    }
  });

  test("an interrupted proposal can persist its recovered application settlement", async () => {
    const current = await fixture([plan(0)]);
    try {
      const planned = await plannedRun(current, 0);
      current.store.approvePlan(planned.id, planned.planSha256 ?? "", "headless-operator");
      const proposeProfile = profile(0);
      const { mutation: _mutation, ...workerWithoutMutation } = proposeProfile.worker;
      const binding = bindHeadlessExecutionV1(
        { ...proposeProfile, worker: workerWithoutMutation },
        {
          run: current.store.getRun(planned.id),
          project: current.store.getProject(planned.projectId),
          approvals: current.store.listApprovals(planned.id),
          readableManifest: current.store.readableManifest(planned.id),
          providerProfiles: PROVIDER_CATALOG,
        },
      );
      current.store.recordHeadlessWorkerStarted(planned.id, binding);
      current.store.recordWorkspace(planned.id, "/tmp/cache", "/tmp/worktree", null);
      const acceptedPatchSet: PatchSet = {
        summary: "Apply the approved greeting.",
        edits: [
          {
            op: "modify",
            path: TARGET,
            expectedPreimageSha256: sha256(BASELINE),
            replacements: [{ findText: BASELINE, replaceText: FIXED }],
            rationale: "Replace one operator-selected file.",
          },
        ],
      };
      const files: readonly CheckpointFile[] = [
        {
          path: TARGET,
          op: "modify",
          baselineBase64: Buffer.from(BASELINE, "utf8").toString("base64"),
          approvedBase64: Buffer.from(FIXED, "utf8").toString("base64"),
        },
      ];
      current.store.recordPatchSetIntent(planned.id, acceptedPatchSet, files);
      const interrupted = createInterruptedHeadlessWorkerSettlementV1({
        run: current.store.getRun(planned.id),
        events: current.store.listEvents(planned.id),
      });
      current.store.recordHeadlessWorkerSettled(planned.id, interrupted);
      const firstSettlement = current.store
        .listEvents(planned.id)
        .find((event) => event.type === "headless.worker.settled");
      const started = current.store
        .listEvents(planned.id)
        .find((event) => event.type === "headless.worker.started");
      expect(firstSettlement).toBeDefined();
      expect(started).toBeDefined();
      if (firstSettlement === undefined || started === undefined) {
        throw new Error("Expected durable start and interrupted settlement evidence");
      }
      const patchSetSha256 = headlessPatchSetDigestV1(files);
      current.store.recordHeadlessWorkerApplyRequested(
        planned.id,
        {
          schema: HEADLESS_WORKER_APPLY_SCHEMA,
          runId: planned.id,
          bindingDigestSha256: binding.bindingDigestSha256,
          patchSetSha256,
          startedEventSequence: started.sequence,
        },
        "headless-operator",
      );
      current.store.recordSessionOutcome(planned.id, "exhausted", null, 0);
      const applyEvent = current.store
        .listEvents(planned.id)
        .find((event) => event.type === "headless.worker.apply_requested");
      expect(applyEvent).toBeDefined();
      if (applyEvent === undefined) throw new Error("Expected durable apply intent evidence");
      const settlement = createAppliedHeadlessWorkerSettlementV1({
        binding,
        run: current.store.getRun(planned.id),
        events: current.store.listEvents(planned.id),
        applyEventSequence: applyEvent.sequence,
        proposalSettlementSequence: firstSettlement.sequence,
        patchSetSha256,
      });

      expect(() =>
        current.store.recordHeadlessWorkerApplicationSettled(planned.id, settlement),
      ).not.toThrow();
      expect(current.store.listEvents(planned.id).at(-1)).toMatchObject({
        type: "headless.worker.settled",
        payload: { schema: "icarus.headless.worker-application.v1", outcome: "exhausted" },
      });
    } finally {
      current.close();
    }
  });

  test("clamps session turns through the envelope flag to exhaustion", async () => {
    const current = await fixture([plan(1), patchSet(BROKEN)]);
    try {
      const planned = await plannedRun(current, 1);
      const result = await current.service.approveHeadlessPlan(
        planned.id,
        planned.planSha256 ?? "",
        "headless-operator",
        profile(1, ["report_done"]),
        PROVIDER_CATALOG,
        undefined,
        { maxTurns: 0 },
      );
      expect(result.settlement).toMatchObject({ outcome: "exhausted", exitCode: 2 });
      expect(result.run.state).toBe("awaiting_review");
      expect(
        current.store.listEvents(planned.id).filter((event) => event.type === "provider.revise"),
      ).toHaveLength(0);
      expect(
        current.store.listEvents(planned.id).find((event) => event.type === "session.exhausted"),
      ).toMatchObject({ payload: { iterations: 0, reason: "iteration_ceiling" } });
    } finally {
      current.close();
    }
  });

  test("doom-loop guard lands the third identical tool call as exhaustion", async () => {
    const checkCall = { name: "run_checks", arguments: { checkIds: ["verify"] } };
    const checkPlan = {
      summary: "Replace the greeting.",
      steps: ["Apply one exact replacement.", "Run verification."],
      risks: ["The preimage may differ."],
      target: TARGET,
      targets: [TARGET],
      iterationCeiling: 1,
      checkIds: ["verify"],
      grants: [{ kind: "exec.check", scope: ["verify"], maxCalls: 5 }],
    };
    const current = await fixture([
      checkPlan,
      patchSet(BROKEN),
      { toolCalls: [checkCall, checkCall, checkCall] },
    ]);
    try {
      const planned = await plannedRun(current, 1);
      const result = await current.service.approveHeadlessPlan(
        planned.id,
        planned.planSha256 ?? "",
        "headless-operator",
        profile(1, ["run_checks"]),
        PROVIDER_CATALOG,
      );
      expect(result.settlement).toMatchObject({ outcome: "exhausted", exitCode: 2 });
      expect(result.run.state).toBe("awaiting_review");
      expect(
        current.store
          .listEvents(planned.id)
          .filter(
            (event) =>
              event.type === "operation.started" &&
              (event.payload as { readonly kind?: unknown }).kind === "session.tool.exec.check",
          ),
      ).toHaveLength(2);
      expect(current.store.listEvents(planned.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "session.exhausted",
            payload: expect.objectContaining({ reason: "doom_loop", tool: "run_checks" }),
          }),
        ]),
      );
    } finally {
      current.close();
    }
  });

  test("lands signal cancellation and settles with exit 130", async () => {
    const controller = new AbortController();
    const current = await fixture([plan(0), patchSet(FIXED)], (request) => {
      if (request.schemaName === "icarus_patch_set") controller.abort();
    });
    try {
      const planned = await plannedRun(current, 0);
      const result = await current.service.approveHeadlessPlan(
        planned.id,
        planned.planSha256 ?? "",
        "headless-operator",
        profile(0),
        PROVIDER_CATALOG,
        controller.signal,
      );
      expect(result.settlement).toMatchObject({ outcome: "cancelled", exitCode: 130 });
      expect(result.run.state).toBe("cancelled");
      expect(current.store.listEvents(planned.id).at(-1)?.type).toBe("headless.worker.settled");
    } finally {
      current.close();
    }
  });

  test("refuses provider remapping before the first worker effect", async () => {
    const current = await fixture([plan(0)]);
    try {
      const planned = await plannedRun(current, 0);
      const selectedProvider = PROVIDER_CATALOG[0];
      if (selectedProvider === undefined) throw new Error("test provider catalog is empty");
      await expect(
        current.service.approveHeadlessPlan(
          planned.id,
          planned.planSha256 ?? "",
          "headless-operator",
          profile(0),
          [{ ...selectedProvider, model: "remapped-model" }],
        ),
      ).rejects.toMatchObject({ code: "HEADLESS_BINDING_AUTHORITY_DENIED" });
      expect(
        current.store.listEvents(planned.id).some((event) => event.type === "workspace.created"),
      ).toBe(false);
      expect(
        current.store
          .listEvents(planned.id)
          .some((event) => event.type === "headless.worker.started"),
      ).toBe(false);
    } finally {
      current.close();
    }
  });

  test("refuses a profile tool without its approved-plan capability", async () => {
    const current = await fixture([plan(0)]);
    try {
      const planned = await plannedRun(current, 0);
      await expect(
        current.service.approveHeadlessPlan(
          planned.id,
          planned.planSha256 ?? "",
          "headless-operator",
          profile(0, ["run_checks"]),
          PROVIDER_CATALOG,
        ),
      ).rejects.toMatchObject({ code: "HEADLESS_PROFILE_AUTHORITY_DENIED" });
      expect(current.store.getRun(planned.id).state).toBe("awaiting_approval");
    } finally {
      current.close();
    }
  });

  test("refuses a profile budget above the persisted project ceiling", async () => {
    const current = await fixture([plan(0)]);
    try {
      const planned = await plannedRun(current, 0);
      const selected = profile(0);
      await expect(
        current.service.approveHeadlessPlan(
          planned.id,
          planned.planSha256 ?? "",
          "headless-operator",
          { ...selected, budgets: { ...selected.budgets, maxCostUsd: CEILING.maxCostUsd + 1 } },
          PROVIDER_CATALOG,
        ),
      ).rejects.toMatchObject({ code: "HEADLESS_PROFILE_AUTHORITY_DENIED" });
    } finally {
      current.close();
    }
  });

  test("refuses malformed profile fields rather than ignoring them", async () => {
    const current = await fixture([plan(0)]);
    try {
      const planned = await plannedRun(current, 0);
      await expect(
        current.service.approveHeadlessPlan(
          planned.id,
          planned.planSha256 ?? "",
          "headless-operator",
          { ...profile(0), providerUrl: "http://example.invalid" },
          PROVIDER_CATALOG,
        ),
      ).rejects.toMatchObject({ code: "INVALID_HEADLESS_PROFILE" });
    } finally {
      current.close();
    }
  });

  test("rejects the wrong plan digest before approval or worker lifecycle", async () => {
    const current = await fixture([plan(0)]);
    try {
      const planned = await plannedRun(current, 0);
      await expect(
        current.service.approveHeadlessPlan(
          planned.id,
          "0".repeat(64),
          "headless-operator",
          profile(0),
          PROVIDER_CATALOG,
        ),
      ).rejects.toMatchObject({ code: "STALE_APPROVAL" });
      expect(current.store.getRun(planned.id).state).toBe("awaiting_approval");
      expect(
        current.store
          .listEvents(planned.id)
          .some((event) => event.type.startsWith("headless.worker.")),
      ).toBe(false);
    } finally {
      current.close();
    }
  });

  test("does not admit a second worker for a settled run", async () => {
    const current = await fixture([plan(0), patchSet(FIXED)]);
    try {
      const planned = await plannedRun(current, 0);
      await current.service.approveHeadlessPlan(
        planned.id,
        planned.planSha256 ?? "",
        "headless-operator",
        profile(0),
        PROVIDER_CATALOG,
      );
      await expect(
        current.service.approveHeadlessPlan(
          planned.id,
          planned.planSha256 ?? "",
          "headless-operator",
          profile(0),
          PROVIDER_CATALOG,
        ),
      ).rejects.toMatchObject({ code: "INVALID_STATE" });
      expect(
        current.store
          .listEvents(planned.id)
          .filter((event) => event.type === "headless.worker.started"),
      ).toHaveLength(1);
    } finally {
      current.close();
    }
  });

  test("settles a provider failure durably instead of reporting success", async () => {
    const current = await fixture([plan(0)]);
    try {
      const planned = await plannedRun(current, 0);
      const result = await current.service.approveHeadlessPlan(
        planned.id,
        planned.planSha256 ?? "",
        "headless-operator",
        profile(0),
        PROVIDER_CATALOG,
      );
      expect(result.settlement).toMatchObject({ outcome: "failed", exitCode: 1 });
      expect(result.settlement.error?.code).toBe("RUN_STEP_FAILED");
      expect(current.store.listEvents(planned.id).at(-1)?.type).toBe("headless.worker.settled");
    } finally {
      current.close();
    }
  });

  test("settles a human-input request as incomplete with exit 3", async () => {
    const current = await fixture([
      plan(1),
      patchSet(BROKEN),
      { toolCalls: [{ name: "request_human_input", arguments: { question: "Which greeting?" } }] },
    ]);
    try {
      const planned = await plannedRun(current, 1);
      const result = await current.service.approveHeadlessPlan(
        planned.id,
        planned.planSha256 ?? "",
        "headless-operator",
        profile(1, ["request_human_input"]),
        PROVIDER_CATALOG,
      );
      expect(result.settlement).toMatchObject({
        outcome: "awaiting_human",
        exitCode: 3,
        error: null,
      });
      expect(result.run.state).toBe("awaiting_review");
    } finally {
      current.close();
    }
  });

  test("applies a tiny context ceiling to the first headless provider call", async () => {
    const current = await fixture([plan(0), patchSet(FIXED)]);
    try {
      const planned = await plannedRun(current, 0);
      const selected = profile(0);
      const result = await current.service.approveHeadlessPlan(
        planned.id,
        planned.planSha256 ?? "",
        "headless-operator",
        { ...selected, budgets: { ...selected.budgets, maxContextBytes: 1 } },
        PROVIDER_CATALOG,
      );
      expect(result.settlement).toMatchObject({ outcome: "failed", exitCode: 1 });
      expect(result.run.lastError?.code).toBe("CONTEXT_BUDGET_EXCEEDED");
    } finally {
      current.close();
    }
  });
});
