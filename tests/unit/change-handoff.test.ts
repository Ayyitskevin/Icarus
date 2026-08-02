import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, canonicalJsonLine } from "../../packages/core/src/canonical-json.js";
import {
  assertExpectedChangeHandoffPreview,
  buildChangeHandoffPreview,
  CHANGE_HANDOFF_DISCLOSURE_CLASS,
  CHANGE_HANDOFF_INTEGRITY_STATEMENT,
  CHANGE_HANDOFF_OMISSIONS,
  CHANGE_HANDOFF_SCHEMA,
  CHANGE_HANDOFF_UNCERTAINTIES,
  type ChangeHandoffPreview,
  type ChangeHandoffSourceSnapshot,
  createChangeHandoffExportResult,
  decodeChangeHandoffExportResultBytes,
  decodeChangeHandoffPayloadBytes,
  encodeChangeHandoffExportResult,
  inspectChangeHandoffDocuments,
  validateChangeHandoffRequest,
  verifyChangeHandoffDocuments,
} from "../../packages/core/src/change-handoff.js";
import {
  CHANGE_HANDOFF_FILENAME,
  CHANGE_HANDOFF_MAX_BYTES,
  CHANGE_HANDOFF_RESULT_FILENAME,
  readSecureHandoffFile,
  writeChangeHandoffFiles,
} from "../../packages/core/src/change-handoff-files.js";
import { readChangeHandoffSource } from "../../packages/core/src/change-handoff-reader.js";
import { digestJson, sha256 } from "../../packages/core/src/digest.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import {
  checkpointDigest,
  planApprovalDigest,
  treeCheckpointDigest,
} from "../../packages/core/src/policy.js";
import { createProviderConfig } from "../../packages/core/src/provider.js";
import { SESSION_ITERATION_OPERATION_KIND } from "../../packages/core/src/store.js";
import type { IcarusStore } from "../../packages/core/src/store.js";
import {
  approveChangeRoomPlan,
  type ChangeRoomFixture,
  createChangeRoomFixture,
  driveToCompleted,
  driveToRolledBack,
  finishToAwaitingReview,
  prepareChangeRoomRun,
} from "../support/change-room-fixtures.js";
import type { JsonValue } from "../../packages/core/src/types.js";
import {
  UNIT_BASE_COMMIT,
  UNIT_CEILING,
  UNIT_PLAN,
  UNIT_RUN_ID,
  unitContextDigest,
  unitContextManifest,
} from "../support/unit-fixtures.js";

interface TestDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...parameters: unknown[]): unknown;
    get(...parameters: unknown[]): unknown;
    all(...parameters: unknown[]): unknown[];
  };
  close(): void;
}

const Database = createRequire(new URL("../../packages/core/package.json", import.meta.url))(
  "better-sqlite3",
) as new (
  filename: string,
) => TestDatabase;

const cleanupRoots = new Set<string>();
const openStores = new Set<IcarusStore>();

function trackedFixture(ceiling = UNIT_CEILING): ChangeRoomFixture {
  const fixture = createChangeRoomFixture(ceiling);
  cleanupRoots.add(fixture.root);
  openStores.add(fixture.store);
  return fixture;
}

function closeFixture(fixture: ChangeRoomFixture): void {
  if (openStores.delete(fixture.store)) fixture.store.close();
}

function completedFixture(): ChangeRoomFixture {
  const fixture = trackedFixture();
  driveToCompleted(fixture.store);
  closeFixture(fixture);
  return fixture;
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(IcarusError);
    expect((error as IcarusError).code).toBe(code);
  }
}

function withPlatform<T>(platform: NodeJS.Platform, action: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (descriptor === undefined) throw new Error("process.platform descriptor is unavailable");
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  try {
    return action();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

function previewFor(fixture: ChangeRoomFixture): ChangeHandoffPreview {
  return buildChangeHandoffPreview(readChangeHandoffSource(fixture.databasePath, fixture.runId), {
    correlationId: "athena-task-42",
    externalTaskRef: "task.room:alpha",
  });
}

function validDocuments(fixture: ChangeRoomFixture): {
  readonly preview: ChangeHandoffPreview;
  readonly resultBytes: Buffer;
} {
  const preview = previewFor(fixture);
  return {
    preview,
    resultBytes: encodeChangeHandoffExportResult(createChangeHandoffExportResult(preview)),
  };
}

function mutateDatabase(
  fixture: ChangeRoomFixture,
  mutation: (database: TestDatabase) => void,
): void {
  closeFixture(fixture);
  const database = new Database(fixture.databasePath);
  try {
    mutation(database);
  } finally {
    database.close();
  }
}

function chargeRepairIteration(store: IcarusStore): void {
  const operation = store.beginOperation(
    UNIT_RUN_ID,
    SESSION_ITERATION_OPERATION_KIND,
    0,
    16,
    1_000,
  );
  store.finishOperation(operation, {
    outcome: "succeeded",
    activeRuntimeMs: 1,
    inputTokens: 1,
    outputTokens: 1,
    estimatedCostUsd: 0,
    detail: {},
  });
}

function prepareIterationPlan(fixture: ChangeRoomFixture, iterationCeiling = 1): void {
  prepareChangeRoomRun(fixture.store);
  const plan = { ...UNIT_PLAN, iterationCeiling };
  const run = fixture.store.getRun(fixture.runId);
  const project = fixture.store.getProject(run.projectId);
  const planSha256 = planApprovalDigest({
    task: run.task,
    baseCommit: run.baseCommit,
    contextSha256: run.contextSha256,
    targets: run.context.targets,
    provider: run.provider,
    checks: project.checks,
    sandbox: project.sandbox,
    ceiling: project.ceiling,
    plan,
    readableManifest: null,
  });
  fixture.store.recordPlanAndAwaitApproval(fixture.runId, plan, planSha256);
  fixture.store.approvePlan(fixture.runId, planSha256, "unit-operator");
}

function enterChargedRepairSession(fixture: ChangeRoomFixture): void {
  prepareIterationPlan(fixture);
  finishToAwaitingReview(fixture.store, "failed", "verifying");
  fixture.store.beginSessionIteration(fixture.runId);
  chargeRepairIteration(fixture.store);
}

function recordPassingSessionVerification(fixture: ChangeRoomFixture): string {
  const current = fixture.store.getRun(fixture.runId);
  if (current.diff === null || current.verification === null) {
    throw new Error("Expected current failing verification evidence");
  }
  const passing = {
    ...current.verification,
    outcome: "passed" as const,
    checks: current.verification.checks.map((check) => ({
      ...check,
      exitCode: 0,
      signal: null,
      stdout: "ok\n",
      stderr: "",
      outcome: "passed" as const,
    })),
  };
  const operation = fixture.store.beginOperation(
    fixture.runId,
    "session.tool.exec.check",
    0,
    0,
    1_000,
    "running",
  );
  fixture.store.finishSessionVerificationOperation(
    operation,
    {
      outcome: "succeeded",
      activeRuntimeMs: 1,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      detail: { tool: "run_checks" },
    },
    current.diff,
    passing,
  );
  return passing.diffSha256;
}

function atomicSessionCompletedFixture(): ChangeRoomFixture {
  const fixture = trackedFixture();
  enterChargedRepairSession(fixture);
  const diffSha256 = recordPassingSessionVerification(fixture);
  const operation = fixture.store.beginOperation(
    fixture.runId,
    "session.control.report_done",
    0,
    0,
    1_000,
    "running",
  );
  fixture.store.finishSessionControlOperation(
    operation,
    {
      outcome: "succeeded",
      activeRuntimeMs: 1,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      detail: { tool: "report_done" },
    },
    "completed",
    "The registered check passes.",
    1,
  );
  fixture.store.recordSessionIterationBoundary(fixture.runId, 1);
  fixture.store.decideReview(fixture.runId, diffSha256, "unit-operator", "approve");
  closeFixture(fixture);
  return fixture;
}

function supersededRepairFixture(resumeBeforeReplacement = false): ChangeRoomFixture {
  const fixture = trackedFixture();
  prepareIterationPlan(fixture);
  finishToAwaitingReview(fixture.store, "failed", "verifying");
  fixture.store.beginSessionIteration(fixture.runId);
  chargeRepairIteration(fixture.store);
  if (resumeBeforeReplacement) {
    fixture.store.failRun(
      fixture.runId,
      "running",
      new IcarusError("INTERRUPTED", "Synthetic replacement interruption"),
    );
    fixture.store.resumeFailed(fixture.runId);
  }
  const current = fixture.store.getRun(fixture.runId);
  if (current.patchSet === null) throw new Error("Expected a patch set to supersede");
  fixture.store.beginOperation(
    fixture.runId,
    "session.tool.mutation.patchset",
    0,
    0,
    1_000,
    "running",
  );
  fixture.store.recordPatchSetIntent(
    fixture.runId,
    current.patchSet,
    fixture.store.listCheckpointFiles(fixture.runId),
  );
  fixture.store.markStartedOperationsInterrupted(fixture.runId);
  closeFixture(fixture);
  return fixture;
}

function sourceFamilyFingerprint(databasePath: string): unknown {
  const directory = path.dirname(databasePath);
  const basename = path.basename(databasePath);
  const directoryStat = lstatSync(directory, { bigint: true });
  const names = readdirSync(directory).sort();
  const familyNames = names.filter((name) => name === basename || name.startsWith(`${basename}-`));
  return {
    directory: {
      mode: String(directoryStat.mode),
      size: String(directoryStat.size),
      modifiedAt: String(directoryStat.mtimeNs),
      changedAt: String(directoryStat.ctimeNs),
      entries: names,
    },
    files: familyNames.map((name) => {
      const filePath = path.join(directory, name);
      const stat = lstatSync(filePath, { bigint: true });
      return {
        name,
        device: String(stat.dev),
        inode: String(stat.ino),
        mode: String(stat.mode),
        links: String(stat.nlink),
        owner: String(stat.uid),
        size: String(stat.size),
        modifiedAt: String(stat.mtimeNs),
        changedAt: String(stat.ctimeNs),
        sha256: createHash("sha256").update(readFileSync(filePath)).digest("hex"),
      };
    }),
  };
}

function treeFingerprint(root: string): unknown {
  const fingerprint = (absolutePath: string, relativePath: string): unknown => {
    const stat = lstatSync(absolutePath, { bigint: true });
    const common = {
      path: relativePath,
      device: String(stat.dev),
      inode: String(stat.ino),
      mode: String(stat.mode),
      links: String(stat.nlink),
      owner: String(stat.uid),
      size: String(stat.size),
      modifiedAt: String(stat.mtimeNs),
      changedAt: String(stat.ctimeNs),
    };
    if (stat.isDirectory()) {
      return {
        ...common,
        type: "directory",
        entries: readdirSync(absolutePath)
          .sort()
          .map((name) =>
            fingerprint(
              path.join(absolutePath, name),
              relativePath.length === 0 ? name : path.join(relativePath, name),
            ),
          ),
      };
    }
    if (stat.isFile()) {
      return {
        ...common,
        type: "file",
        sha256: createHash("sha256").update(readFileSync(absolutePath)).digest("hex"),
      };
    }
    return { ...common, type: "other" };
  };

  return fingerprint(root, "");
}

const PRIVATE_CANARIES = {
  task: "private-task-canary: explain the undisclosed implementation",
  target: "private-target-canary/entry.ts",
  path: "private-source-path-canary/research.txt",
  plan: "private-plan-canary: inspect confidential research before editing",
  planStep: "private-plan-step-canary",
  planRisk: "private-plan-risk-canary",
  grantScope: "private-check-grant-canary",
  patchSummary: "private-patchset-summary-canary",
  patchRationale: "private-patchset-rationale-canary",
  patchBaseline: "private-patchset-baseline-bytes-canary\n",
  patchApproved: "private-patchset-approved-bytes-canary\n",
  artifactPath: "/tmp/private-context-artifact-path-canary.json",
  diff: "private-diff-canary",
  command: "private-command-canary",
  argv: "private-argv-canary",
  stdout: "private-stdout-canary",
  stderr: "private-stderr-canary",
  sandbox: "private-sandbox-canary",
  annotation: "private-annotation-body-canary",
  actor: "private-annotation-actor-canary",
  eventPayload: "private-event-payload-canary",
  cache: "/tmp/private-cache-path-canary.git",
  worktree: "/tmp/private-worktree-path-canary",
  url: "http://127.0.0.1:11434/private-url-canary/",
  credential: "sk-private-credential-canary",
  header: "Authorization: Bearer private-header-canary",
  research: "private-research-canary",
  code: "const private_code_canary = true;",
  error: "private-error-message-canary",
} as const;

function seedCompletedPrivateCanaryRun(fixture: ChangeRoomFixture): void {
  const initialProject = fixture.store.getProject(fixture.projectId);
  const provider = createProviderConfig({
    kind: "ollama",
    model: "unit-model",
    baseUrl: PRIVATE_CANARIES.url,
  });
  const checks = [
    {
      id: PRIVATE_CANARIES.grantScope,
      name: "Private command canary",
      argv: [PRIVATE_CANARIES.command, PRIVATE_CANARIES.argv],
    },
  ];
  const sandbox = {
    ...initialProject.sandbox,
    image: [PRIVATE_CANARIES.sandbox, "@sha256:", "c".repeat(64)].join(""),
  };
  let database = new Database(fixture.databasePath);
  try {
    database
      .prepare(
        "UPDATE runs SET task = ?, target = ?, provider_json = ?, context_json = json_set(context_json, '$.targets', json(?)) WHERE id = ?",
      )
      .run(
        PRIVATE_CANARIES.task,
        PRIVATE_CANARIES.target,
        JSON.stringify(provider),
        JSON.stringify([PRIVATE_CANARIES.target]),
        fixture.runId,
      );
    database
      .prepare(
        "UPDATE run_events SET payload_json = json_set(payload_json, '$.target', ?) WHERE run_id = ? AND type = 'run.created'",
      )
      .run(PRIVATE_CANARIES.target, fixture.runId);
    database
      .prepare("UPDATE projects SET checks_json = ?, sandbox_json = ? WHERE id = ?")
      .run(JSON.stringify(checks), JSON.stringify(sandbox), fixture.projectId);
  } finally {
    database.close();
  }

  fixture.store.pinRunBase(fixture.runId, UNIT_BASE_COMMIT);
  const targetBytes = Buffer.byteLength(PRIVATE_CANARIES.patchBaseline);
  const sourceBytes = Buffer.byteLength(PRIVATE_CANARIES.research);
  const context = {
    auditPolicyVersion: unitContextManifest().auditPolicyVersion,
    baseCommit: UNIT_BASE_COMMIT,
    targets: [PRIVATE_CANARIES.target],
    repositoryMap: [PRIVATE_CANARIES.target, PRIVATE_CANARIES.path].sort(),
    entries: [
      {
        path: PRIVATE_CANARIES.target,
        reason: "target" as const,
        bytes: targetBytes,
        sha256: sha256(PRIVATE_CANARIES.patchBaseline),
      },
      {
        path: PRIVATE_CANARIES.path,
        reason: "repository_map" as const,
        bytes: sourceBytes,
        sha256: "e".repeat(64),
      },
    ],
    totalBytes:
      targetBytes +
      Buffer.byteLength(PRIVATE_CANARIES.target) +
      sourceBytes +
      Buffer.byteLength(PRIVATE_CANARIES.path),
  };
  fixture.store.completePreparation(
    fixture.runId,
    context,
    PRIVATE_CANARIES.artifactPath,
    unitContextDigest(context),
  );
  const plan = {
    ...UNIT_PLAN,
    summary: PRIVATE_CANARIES.plan,
    steps: [PRIVATE_CANARIES.planStep],
    risks: [PRIVATE_CANARIES.planRisk],
    target: PRIVATE_CANARIES.target,
    targets: [PRIVATE_CANARIES.target],
    checkIds: [PRIVATE_CANARIES.grantScope],
    grants: [
      {
        kind: "mutation.patchset" as const,
        scope: [PRIVATE_CANARIES.target],
        maxCalls: 1,
      },
      {
        kind: "read.checks" as const,
        scope: [PRIVATE_CANARIES.grantScope],
        maxCalls: 1,
      },
    ],
  };
  const run = fixture.store.getRun(fixture.runId);
  const project = fixture.store.getProject(fixture.projectId);
  const planSha256 = planApprovalDigest({
    task: run.task,
    baseCommit: run.baseCommit,
    contextSha256: run.contextSha256,
    targets: run.context.targets,
    provider: run.provider,
    checks: project.checks,
    sandbox: project.sandbox,
    ceiling: project.ceiling,
    plan,
    readableManifest: null,
  });
  fixture.store.recordPlanAndAwaitApproval(fixture.runId, plan, planSha256);
  fixture.store.approvePlan(fixture.runId, planSha256, "private-plan-actor-canary");
  fixture.store.recordWorkspace(
    fixture.runId,
    PRIVATE_CANARIES.cache,
    PRIVATE_CANARIES.worktree,
    null,
  );
  const checkpointFiles = [
    {
      path: PRIVATE_CANARIES.target,
      op: "modify" as const,
      baselineBase64: Buffer.from(PRIVATE_CANARIES.patchBaseline).toString("base64"),
      approvedBase64: Buffer.from(PRIVATE_CANARIES.patchApproved).toString("base64"),
    },
  ];
  fixture.store.recordPatchSetIntent(
    fixture.runId,
    {
      summary: PRIVATE_CANARIES.patchSummary,
      edits: [
        {
          op: "modify",
          path: PRIVATE_CANARIES.target,
          expectedPreimageSha256: sha256(PRIVATE_CANARIES.patchBaseline),
          replacements: [
            {
              findText: PRIVATE_CANARIES.patchBaseline.trimEnd(),
              replaceText: PRIVATE_CANARIES.patchApproved.trimEnd(),
            },
          ],
          rationale: PRIVATE_CANARIES.patchRationale,
        },
      ],
    },
    checkpointFiles,
  );
  const checkpointSha256 = treeCheckpointDigest({
    runId: fixture.runId,
    baseCommit: UNIT_BASE_COMMIT,
    files: checkpointFiles,
  });
  fixture.store.saveTreeCheckpoint(fixture.runId, checkpointSha256);
  fixture.store.transition(fixture.runId, "verifying", "edit.materialized", {
    target: PRIVATE_CANARIES.target,
    approvedSha256: sha256(PRIVATE_CANARIES.patchApproved),
  });
  const customDiff = [
    `diff --git a/${PRIVATE_CANARIES.target} b/${PRIVATE_CANARIES.target}`,
    `-${PRIVATE_CANARIES.patchBaseline.trimEnd()}`,
    `+${PRIVATE_CANARIES.patchApproved.trimEnd()}`,
    PRIVATE_CANARIES.diff,
    "",
  ].join("\n");
  const customDiffSha256 = sha256(customDiff);
  fixture.store.recordVerificationAndAwaitReview(fixture.runId, customDiff, {
    outcome: "passed",
    checks: [
      {
        checkId: PRIVATE_CANARIES.grantScope,
        argv: [PRIVATE_CANARIES.command, PRIVATE_CANARIES.argv],
        exitCode: 0,
        signal: null,
        durationMs: 10,
        stdout: PRIVATE_CANARIES.stdout,
        stderr: PRIVATE_CANARIES.stderr,
        truncated: false,
        outcome: "passed",
      },
    ],
    changedPaths: [PRIVATE_CANARIES.target],
    diffSha256: customDiffSha256,
    checkpointSha256,
  });
  fixture.store.decideReview(
    fixture.runId,
    customDiffSha256,
    "private-review-actor-canary",
    "approve",
  );

  database = new Database(fixture.databasePath);
  try {
    database
      .prepare("UPDATE runs SET error_message = ? WHERE id = ?")
      .run(PRIVATE_CANARIES.error, fixture.runId);
    const eventCanaryPayload = JSON.stringify({
      canary: PRIVATE_CANARIES.eventPayload,
      credential: PRIVATE_CANARIES.credential,
      header: PRIVATE_CANARIES.header,
      research: PRIVATE_CANARIES.research,
      code: PRIVATE_CANARIES.code,
    });
    const eventCanaryUpdate = database
      .prepare(
        "UPDATE run_events SET payload_json = ? WHERE run_id = ? AND type = 'workspace.created'",
      )
      .run(eventCanaryPayload, fixture.runId) as { readonly changes: number };
    if (eventCanaryUpdate.changes !== 1) {
      throw new Error("Expected to persist the private event-payload canaries");
    }
    const persistedEvent = database
      .prepare(
        "SELECT payload_json FROM run_events WHERE run_id = ? AND type = 'workspace.created'",
      )
      .get(fixture.runId) as { readonly payload_json: string };
    if (persistedEvent.payload_json !== eventCanaryPayload) {
      throw new Error("Private event-payload canaries were not persisted exactly");
    }
  } finally {
    database.close();
  }

  fixture.store.addRunAnnotation(
    fixture.runId,
    "room",
    PRIVATE_CANARIES.actor,
    PRIVATE_CANARIES.annotation,
  );
}

afterEach(() => {
  for (const store of openStores) {
    try {
      store.close();
    } catch {
      // Cleanup must not hide the primary test failure.
    }
  }
  openStores.clear();
  for (const root of cleanupRoots) rmSync(root, { recursive: true, force: true });
  cleanupRoots.clear();
});

describe("Change Handoff projection", () => {
  it("rejects sparse and decorated arrays at the canonical JSON boundary", () => {
    const sparse: unknown[] = [];
    sparse.length = 1;
    const stringDecorated = ["safe"];
    Object.defineProperty(stringDecorated, "privateCanary", {
      value: "hidden",
      enumerable: true,
    });
    const symbolDecorated = ["safe"];
    Object.defineProperty(symbolDecorated, Symbol("privateCanary"), {
      value: "hidden",
      enumerable: true,
    });

    for (const value of [sparse, stringDecorated, symbolDecorated]) {
      expectCode(() => canonicalJson(value), "INVALID_CANONICAL_JSON");
    }
  });

  it("builds byte-identical canonical previews from the same authoritative snapshot", () => {
    const fixture = completedFixture();
    const source = readChangeHandoffSource(fixture.databasePath, fixture.runId);
    const request = {
      correlationId: "athena-task-42",
      externalTaskRef: "task.room:alpha",
    } as const;

    const first = buildChangeHandoffPreview(source, request);
    const second = buildChangeHandoffPreview(source, request);
    const decoded = JSON.parse(first.payloadBytes.toString("utf8")) as Record<string, unknown>;

    expect(second).toEqual(first);
    expect(first.payloadBytes.equals(canonicalJsonLine(first.payload))).toBe(true);
    expect(first.payloadBytes.at(-1)).toBe(0x0a);
    expect(first.payloadBytes.subarray(0, -1).includes(0x0a)).toBe(false);
    expect(first.payloadSha256).toBe(sha256(first.payloadBytes));
    expect(first.previewSha256).not.toBe(first.payloadSha256);
    expect(Object.keys(decoded)).toEqual([
      "artifactReferences",
      "counts",
      "disclosureClass",
      "identifiers",
      "integrity",
      "lifecycle",
      "omissions",
      "provider",
      "run",
      "schema",
      "summary",
      "uncertainty",
      "version",
    ]);
    expect(first.payload).toMatchObject({
      schema: CHANGE_HANDOFF_SCHEMA,
      disclosureClass: CHANGE_HANDOFF_DISCLOSURE_CLASS,
      run: { state: "completed", phase: "completed" },
      lifecycle: {
        egress: "not_required_loopback",
        planApproval: "approved",
        verification: "passed",
        review: "approved",
        terminalReason: "completed",
      },
    });
  });

  it("previews a valid early cancellation from preparing", () => {
    const fixture = trackedFixture();
    fixture.store.transition(fixture.runId, "cancelling", "cancellation.requested", {
      actor: "unit-operator",
    });
    fixture.store.finishCancellation(fixture.runId);
    closeFixture(fixture);

    const source = readChangeHandoffSource(fixture.databasePath, fixture.runId);
    expect(source).toMatchObject({
      state: "cancelled",
      contextSha256: null,
      planSha256: null,
      verification: null,
    });
    const payload = buildChangeHandoffPreview(source, { correlationId: "cancel-early" }).payload;

    expect(payload.run).toEqual({ state: "cancelled", phase: "cancelled" });
    expect(payload.lifecycle).toEqual({
      egress: "not_required_loopback",
      planApproval: "not_reached",
      verification: "not_run",
      review: "not_reached",
      rollback: "not_started",
      restoration: "not_started",
      terminalReason: "cancelled",
    });
    expect(payload.artifactReferences).toEqual([]);
  });

  it("keeps fixed summary and integrity copy exact and fails lifecycle approvals closed", () => {
    const fixture = trackedFixture();
    closeFixture(fixture);
    const base = readChangeHandoffSource(fixture.databasePath, fixture.runId);
    const plannedSource: ChangeHandoffSourceSnapshot = {
      ...base,
      state: "planned",
      contextSha256: "a".repeat(64),
      planSha256: null,
      approvals: [],
    };
    const planned = buildChangeHandoffPreview(plannedSource, {
      correlationId: "corr-1",
    }).payload;
    expect(planned.lifecycle.egress).toBe("not_required_loopback");
    expect(planned.lifecycle.planApproval).toBe("not_reached");

    const planDeniedSource: ChangeHandoffSourceSnapshot = {
      ...base,
      state: "awaiting_approval",
      contextSha256: "a".repeat(64),
      planSha256: "b".repeat(64),
      approvals: [{ kind: "plan", digest: "d".repeat(64), decision: "approve" }],
    };

    expect(planned.lifecycle).toEqual({
      egress: "not_required_loopback",
      planApproval: "not_reached",
      verification: "not_run",
      review: "not_reached",
      rollback: "not_started",
      restoration: "not_started",
      terminalReason: null,
    });
    expect(planned.summary).toEqual([
      "This Icarus run is planned.",
      "Verification has not been recorded.",
      "Review has not been reached.",
      "Evidence remains local in Icarus.",
      "No commit, push, merge, or deployment is represented by this artifact.",
    ]);
    expect(planned.integrity).toEqual({
      semantics: "byte_binding_and_recorded_local_evidence_only",
      statement: CHANGE_HANDOFF_INTEGRITY_STATEMENT,
    });
    expect(planned.omissions).toEqual(CHANGE_HANDOFF_OMISSIONS);
    expect(planned.uncertainty).toEqual(CHANGE_HANDOFF_UNCERTAINTIES);

    const cancellationFixture = trackedFixture();
    cancellationFixture.store.transition(
      cancellationFixture.runId,
      "cancelling",
      "cancellation.requested",
      { actor: "unit-operator" },
    );
    cancellationFixture.store.finishCancellation(cancellationFixture.runId);
    closeFixture(cancellationFixture);
    const cancelledSource = readChangeHandoffSource(
      cancellationFixture.databasePath,
      cancellationFixture.runId,
    );
    const egressDenied = buildChangeHandoffPreview(
      {
        ...cancelledSource,
        provider: {
          kind: "openai",
          model: "safe-remote-model",
          locality: "remote",
          privacyClass: "remote_api",
        },
        contextSha256: "a".repeat(64),
      },
      { correlationId: "corr-1" },
    ).payload;
    expect(egressDenied.lifecycle.egress).toBe("not_approved");

    const awaitingEgress = buildChangeHandoffPreview(
      {
        ...base,
        state: "awaiting_egress_approval",
        provider: {
          kind: "openai",
          model: "safe-remote-model",
          locality: "remote",
          privacyClass: "remote_api",
        },
        contextSha256: "a".repeat(64),
        planSha256: null,
        approvals: [],
      },
      { correlationId: "corr-1" },
    ).payload;
    expect(awaitingEgress.lifecycle.egress).toBe("awaiting_approval");

    const awaitingPlan = buildChangeHandoffPreview(
      { ...planDeniedSource, state: "awaiting_approval" },
      { correlationId: "corr-1" },
    ).payload;
    expect(awaitingPlan.lifecycle.planApproval).toBe("awaiting_approval");

    const approvedPlanDigest = planDeniedSource.planSha256;
    if (approvedPlanDigest === null) throw new Error("Expected a plan digest");
    const approved = buildChangeHandoffPreview(
      {
        ...planDeniedSource,
        state: "running",
        approvals: [{ kind: "plan", digest: approvedPlanDigest, decision: "approve" }],
      },
      { correlationId: "corr-1" },
    ).payload;
    expect(approved.lifecycle.planApproval).toBe("approved");

    expectCode(
      () =>
        buildChangeHandoffPreview(
          {
            ...planDeniedSource,
            state: "running",
            planSha256: "b".repeat(64),
          },
          { correlationId: "corr-1" },
        ),
      "HANDOFF_SOURCE_INVALID",
    );
  });

  it("never projects deliberately persisted private evidence canaries", () => {
    const fixture = trackedFixture();
    seedCompletedPrivateCanaryRun(fixture);
    closeFixture(fixture);
    const documents = validDocuments(fixture);
    const inspection = inspectChangeHandoffDocuments(
      documents.preview.payloadBytes,
      documents.resultBytes,
    );
    const published = [
      documents.preview.payloadBytes.toString("utf8"),
      documents.resultBytes.toString("utf8"),
      JSON.stringify(inspection),
    ].join("\n");

    for (const privateCanary of [
      ...Object.values(PRIVATE_CANARIES),
      Buffer.from(PRIVATE_CANARIES.patchBaseline).toString("base64"),
      Buffer.from(PRIVATE_CANARIES.patchApproved).toString("base64"),
      "Update the greeting",
      "src/greeting.txt",
      "Replace the greeting.",
      "Exercise the Change Room projection.",
      "diff --git",
      "node --test",
      "unit-operator",
      "/tmp/unit-cache.git",
      "/tmp/unit-worktree",
      "http://127.0.0.1:11434",
    ]) {
      expect(published).not.toContain(privateCanary);
    }
  });

  it("does not echo a deliberately persisted credential canary on the failure path", () => {
    const fixture = trackedFixture();
    closeFixture(fixture);
    mutateDatabase(fixture, (database) => {
      database
        .prepare(
          "UPDATE runs SET provider_json = json_set(provider_json, '$.model', ?) WHERE id = ?",
        )
        .run(PRIVATE_CANARIES.credential, fixture.runId);
    });

    let caught: unknown;
    try {
      previewFor(fixture);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IcarusError);
    const failure = caught as IcarusError;
    expect(failure.code).toBe("UNSAFE_PROVIDER_MODEL");
    const renderedFailure = JSON.stringify({
      name: failure.name,
      code: failure.code,
      message: failure.message,
      details: failure.details,
    });
    for (const privateCanary of Object.values(PRIVATE_CANARIES)) {
      expect(renderedFailure).not.toContain(privateCanary);
    }
  });

  it("rejects unsafe correlation IDs, external references, and provider models", () => {
    for (const correlationId of [
      "",
      "contains space",
      "../path",
      "https://receiver.invalid",
      "header=value;echo",
      "token.value",
      "sk-private-canary",
      "sk_live_private_canary",
      "rk_live_private_canary",
      "npm_private_canary",
      "glpat-private-canary",
      "ref.sk_live_1234567890abcdef",
      "task:AKIA1234567890ABCDEF",
      "refAKIA1234567890ABCDEF",
      "abcghp_1234567890abcdef",
      "abcsk_live_1234567890abcdef",
      "task:ASIA1234567890ABCDEF",
      "xoxc-1234567890-canary",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.signaturepart",
      "x".repeat(129),
      "unicode-☃",
    ]) {
      expectCode(() => validateChangeHandoffRequest({ correlationId }), "INVALID_CORRELATION_ID");
    }
    expect(validateChangeHandoffRequest({ correlationId: `a${"x".repeat(127)}` })).toEqual({
      correlationId: `a${"x".repeat(127)}`,
      externalTaskRef: null,
    });

    for (const externalTaskRef of [
      "",
      "path/to/task",
      "authorization:bearer",
      "private_key:value",
      "sk_live_private_canary",
      "rk_live_private_canary",
      "npm_private_canary",
      "glpat-private-canary",
      "ref.sk_live_1234567890abcdef",
      "task:AKIA1234567890ABCDEF",
      "refAKIA1234567890ABCDEF",
      "abcghp_1234567890abcdef",
      "abcsk_live_1234567890abcdef",
      "task:ASIA1234567890ABCDEF",
      "xoxc-1234567890-canary",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.signaturepart",
      "x".repeat(257),
    ]) {
      expectCode(
        () => validateChangeHandoffRequest({ correlationId: "safe", externalTaskRef }),
        "INVALID_EXTERNAL_TASK_REF",
      );
    }
    expect(
      validateChangeHandoffRequest({
        correlationId: "safe",
        externalTaskRef: `a${"x".repeat(255)}`,
      }),
    ).toEqual({ correlationId: "safe", externalTaskRef: `a${"x".repeat(255)}` });

    const fixture = trackedFixture();
    closeFixture(fixture);
    const source = readChangeHandoffSource(fixture.databasePath, fixture.runId);
    for (const model of [
      "api_key.private",
      "sk_live_private_canary",
      "rk_live_private_canary",
      "npm_private_canary",
      "glpat-private-canary",
      "ref.sk_live_1234567890abcdef",
      "task:AKIA1234567890ABCDEF",
      "refAKIA1234567890ABCDEF",
      "abcghp_1234567890abcdef",
      "abcsk_live_1234567890abcdef",
      "task:ASIA1234567890ABCDEF",
      "xoxc-1234567890-canary",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.signaturepart",
    ]) {
      expectCode(
        () =>
          buildChangeHandoffPreview(
            { ...source, provider: { ...source.provider, model } },
            { correlationId: "safe" },
          ),
        "UNSAFE_PROVIDER_MODEL",
      );
    }
  });

  it("requires the exact preview digest and distinguishes malformed from stale tokens", () => {
    const fixture = completedFixture();
    const preview = previewFor(fixture);

    expect(() => assertExpectedChangeHandoffPreview(preview, preview.previewSha256)).not.toThrow();
    expectCode(
      () => assertExpectedChangeHandoffPreview(preview, "f".repeat(64)),
      "STALE_HANDOFF_PREVIEW",
    );
    expectCode(
      () => assertExpectedChangeHandoffPreview(preview, preview.payloadSha256),
      "STALE_HANDOFF_PREVIEW",
    );
    expectCode(() => assertExpectedChangeHandoffPreview(preview, "ABC"), "INVALID_PREVIEW_DIGEST");
  });

  it("rejects recovery states without evidence and post-recovery completion without restoration", () => {
    const fixture = completedFixture();
    const source = readChangeHandoffSource(fixture.databasePath, fixture.runId);
    expectCode(
      () =>
        buildChangeHandoffPreview(
          {
            ...source,
            state: "failed",
            resumeState: "rolling_back",
            verification: null,
          },
          { correlationId: "missing-recovery-evidence" },
        ),
      "HANDOFF_SOURCE_INVALID",
    );

    const preview = buildChangeHandoffPreview(source, { correlationId: "recovery-state-matrix" });
    const impossible = {
      ...preview.payload,
      lifecycle: {
        ...preview.payload.lifecycle,
        rollback: "completed",
        restoration: "not_started",
      },
    };
    expectCode(
      () => decodeChangeHandoffPayloadBytes(canonicalJsonLine(impossible as unknown as JsonValue)),
      "INVALID_HANDOFF",
    );
  });
});

describe("Change Handoff authoritative reader", () => {
  it("leaves the complete SQLite source family byte-for-byte and metadata-for-metadata unchanged", () => {
    const fixture = completedFixture();
    const before = sourceFamilyFingerprint(fixture.databasePath);

    const first = readChangeHandoffSource(fixture.databasePath, fixture.runId);
    const second = readChangeHandoffSource(fixture.databasePath, fixture.runId);

    expect(second).toEqual(first);
    expect(sourceFamilyFingerprint(fixture.databasePath)).toEqual(before);
  });

  it("leaves checkout, Git metadata, cache, worktree, artifacts, and fetch count unchanged", () => {
    const fixture = completedFixture();
    const repositoryPath = path.join(fixture.root, "repository");
    const cachePath = path.join(fixture.root, "cache.git");
    const worktreePath = path.join(fixture.root, "worktree");
    const artifactPath = path.join(fixture.root, "context-artifact.json");
    mkdirSync(path.join(repositoryPath, ".git"), { recursive: true });
    mkdirSync(cachePath);
    mkdirSync(worktreePath);
    writeFileSync(
      path.join(repositoryPath, ".git", "config"),
      "[core]\nrepositoryformatversion=0\n",
    );
    writeFileSync(path.join(repositoryPath, "source.txt"), "checkout-source-canary\n");
    writeFileSync(path.join(cachePath, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(path.join(worktreePath, "materialized.txt"), "worktree-canary\n");
    writeFileSync(artifactPath, '{"artifact":"context-canary"}\n');
    const repositoryStat = lstatSync(repositoryPath, { bigint: true });
    mutateDatabase(fixture, (database) => {
      database
        .prepare(
          "UPDATE repositories SET path = ?, device = ?, inode = ? WHERE id = (SELECT repository_id FROM projects WHERE id = ?)",
        )
        .run(
          repositoryPath,
          Number(repositoryStat.dev),
          Number(repositoryStat.ino),
          fixture.projectId,
        );
      database
        .prepare(
          "UPDATE runs SET cache_path = ?, worktree_path = ?, context_artifact_path = ? WHERE id = ?",
        )
        .run(cachePath, worktreePath, artifactPath, fixture.runId);
    });
    const before = {
      state: sourceFamilyFingerprint(fixture.databasePath),
      repository: treeFingerprint(repositoryPath),
      cache: treeFingerprint(cachePath),
      worktree: treeFingerprint(worktreePath),
      artifact: treeFingerprint(artifactPath),
    };
    const originalFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    let fetchCalls = 0;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async () => {
        fetchCalls += 1;
        throw new Error("Preview attempted an external fetch");
      },
    });
    try {
      const first = previewFor(fixture);
      const second = previewFor(fixture);
      expect(second).toEqual(first);
    } finally {
      if (originalFetchDescriptor === undefined) {
        Reflect.deleteProperty(globalThis, "fetch");
      } else {
        Object.defineProperty(globalThis, "fetch", originalFetchDescriptor);
      }
    }

    expect(fetchCalls).toBe(0);
    expect({
      state: sourceFamilyFingerprint(fixture.databasePath),
      repository: treeFingerprint(repositoryPath),
      cache: treeFingerprint(cachePath),
      worktree: treeFingerprint(worktreePath),
      artifact: treeFingerprint(artifactPath),
    }).toEqual(before);
  });

  it.each(["execution.completed", "session.verification_requested"] as const)(
    "replays supported %s transitions and rejects malformed aliases",
    (eventType) => {
      const valid = completedFixture();
      mutateDatabase(valid, (database) => {
        const updated = database
          .prepare("UPDATE run_events SET type = ? WHERE run_id = ? AND type = 'edit.materialized'")
          .run(eventType, valid.runId) as { readonly changes: number };
        expect(updated.changes).toBe(1);
      });
      expect(readChangeHandoffSource(valid.databasePath, valid.runId).state).toBe("completed");

      for (const mutation of [
        (database: TestDatabase, runId: string) =>
          database
            .prepare(
              "UPDATE run_events SET type = ?, payload_json = json_set(payload_json, '$.from', 'verifying') WHERE run_id = ? AND type = 'edit.materialized'",
            )
            .run(eventType, runId),
        (database: TestDatabase, runId: string) =>
          database
            .prepare(
              "UPDATE run_events SET type = ?, payload_json = json_set(payload_json, '$.unexpected', 1) WHERE run_id = ? AND type = 'edit.materialized'",
            )
            .run(eventType, runId),
      ]) {
        const malformed = completedFixture();
        mutateDatabase(malformed, (database) => {
          mutation(database, malformed.runId);
        });
        expectCode(
          () => readChangeHandoffSource(malformed.databasePath, malformed.runId),
          "HANDOFF_SOURCE_INVALID",
        );
      }
    },
  );

  it("binds repair admission to current failed verification and the remaining iteration grant", () => {
    const valid = trackedFixture();
    prepareIterationPlan(valid);
    finishToAwaitingReview(valid.store, "failed", "verifying");
    valid.store.beginSessionIteration(valid.runId);
    closeFixture(valid);
    expect(readChangeHandoffSource(valid.databasePath, valid.runId).state).toBe("running");

    const wrongRemaining = trackedFixture();
    prepareIterationPlan(wrongRemaining);
    finishToAwaitingReview(wrongRemaining.store, "failed", "verifying");
    wrongRemaining.store.beginSessionIteration(wrongRemaining.runId);
    mutateDatabase(wrongRemaining, (database) => {
      database
        .prepare(
          "UPDATE run_events SET payload_json = json_set(payload_json, '$.remaining', 2) WHERE run_id = ? AND type = 'repair.requested'",
        )
        .run(wrongRemaining.runId);
    });
    expectCode(
      () => readChangeHandoffSource(wrongRemaining.databasePath, wrongRemaining.runId),
      "HANDOFF_SOURCE_INVALID",
    );

    const missingVerification = trackedFixture();
    prepareIterationPlan(missingVerification);
    finishToAwaitingReview(missingVerification.store, "failed", "verifying");
    missingVerification.store.beginSessionIteration(missingVerification.runId);
    mutateDatabase(missingVerification, (database) => {
      database
        .prepare(
          "UPDATE run_events SET type = 'base.pinned' WHERE run_id = ? AND type = 'verification.completed'",
        )
        .run(missingVerification.runId);
      database
        .prepare("UPDATE runs SET diff = NULL, verification_json = NULL WHERE id = ?")
        .run(missingVerification.runId);
    });
    expectCode(
      () => readChangeHandoffSource(missingVerification.databasePath, missingVerification.runId),
      "HANDOFF_SOURCE_INVALID",
    );
  });

  it("accepts valid session dispositions only when they bind current verification and iterations", () => {
    const atomic = atomicSessionCompletedFixture();
    const atomicSource = readChangeHandoffSource(atomic.databasePath, atomic.runId);
    expect(atomicSource).toMatchObject({
      state: "completed",
      verification: { outcome: "passed" },
      reviewDecision: "approve",
    });

    const compatibility = trackedFixture();
    enterChargedRepairSession(compatibility);
    recordPassingSessionVerification(compatibility);
    compatibility.store.recordSessionOutcome(
      compatibility.runId,
      "completed",
      "The registered check passes.",
      1,
    );
    compatibility.store.recordSessionIterationBoundary(compatibility.runId, 1);
    closeFixture(compatibility);
    expectCode(
      () => readChangeHandoffSource(compatibility.databasePath, compatibility.runId),
      "HANDOFF_SOURCE_INVALID",
    );

    const zeroTurnExhausted = trackedFixture();
    prepareIterationPlan(zeroTurnExhausted);
    finishToAwaitingReview(zeroTurnExhausted.store, "failed", "verifying");
    zeroTurnExhausted.store.beginSessionIteration(zeroTurnExhausted.runId);
    zeroTurnExhausted.store.recordSessionOutcome(zeroTurnExhausted.runId, "exhausted", null, 0);
    closeFixture(zeroTurnExhausted);
    expect(
      readChangeHandoffSource(zeroTurnExhausted.databasePath, zeroTurnExhausted.runId),
    ).toMatchObject({
      state: "awaiting_review",
      verification: { outcome: "failed" },
      reviewDecision: null,
    });

    const admissionExhausted = trackedFixture();
    prepareIterationPlan(admissionExhausted);
    finishToAwaitingReview(admissionExhausted.store, "failed", "verifying");
    admissionExhausted.store.recordSessionAdmissionExhausted(admissionExhausted.runId);
    closeFixture(admissionExhausted);
    expect(
      readChangeHandoffSource(admissionExhausted.databasePath, admissionExhausted.runId),
    ).toMatchObject({
      state: "awaiting_review",
      verification: { outcome: "failed" },
      reviewDecision: null,
    });
  });

  it("preserves same-revision completion authority across rollback, restore, and fresh verification", () => {
    const fixture = trackedFixture();
    enterChargedRepairSession(fixture);
    const diffSha256 = recordPassingSessionVerification(fixture);
    const reportDone = fixture.store.beginOperation(
      fixture.runId,
      "session.control.report_done",
      0,
      0,
      1_000,
      "running",
    );
    fixture.store.finishSessionControlOperation(
      reportDone,
      {
        outcome: "succeeded",
        activeRuntimeMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        detail: { tool: "report_done" },
      },
      "completed",
      "The registered check passes.",
      1,
    );
    fixture.store.recordSessionIterationBoundary(fixture.runId, 1);
    fixture.store.decideReview(fixture.runId, diffSha256, "unit-operator", "reject");
    fixture.store.finishRollback(fixture.runId);
    const checkpointSha256 = fixture.store.getCheckpoint(fixture.runId).checkpointSha256;
    fixture.store.approveRestore(fixture.runId, checkpointSha256, "unit-operator");
    fixture.store.finishRestore(fixture.runId);
    const restored = fixture.store.getRun(fixture.runId);
    if (restored.diff === null || restored.verification === null) {
      throw new Error("Expected restored same-revision evidence");
    }
    fixture.store.recordVerificationAndAwaitReview(
      fixture.runId,
      restored.diff,
      restored.verification,
    );
    fixture.store.decideReview(
      fixture.runId,
      restored.verification.diffSha256,
      "unit-operator",
      "approve",
    );
    closeFixture(fixture);

    expect(readChangeHandoffSource(fixture.databasePath, fixture.runId)).toMatchObject({
      state: "completed",
      verification: {
        outcome: "passed",
        diffSha256,
        checkpointSha256,
      },
      reviewDecision: "approve",
    });
  });

  it("expires completion authority when a later repair revision supersedes its intent", () => {
    const fixture = trackedFixture({ ...UNIT_CEILING, maxToolCalls: 8 });
    prepareIterationPlan(fixture, 2);
    finishToAwaitingReview(fixture.store, "failed", "verifying");
    fixture.store.beginSessionIteration(fixture.runId);
    chargeRepairIteration(fixture.store);
    const diffSha256 = recordPassingSessionVerification(fixture);
    const completed = fixture.store.getRun(fixture.runId);
    if (completed.diff === null || completed.verification === null || completed.patchSet === null) {
      throw new Error("Expected completed revision evidence");
    }
    const completedPatchSet = completed.patchSet;
    const reportDone = fixture.store.beginOperation(
      fixture.runId,
      "session.control.report_done",
      0,
      0,
      1_000,
      "running",
    );
    fixture.store.finishSessionControlOperation(
      reportDone,
      {
        outcome: "succeeded",
        activeRuntimeMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        detail: { tool: "report_done" },
      },
      "completed",
      "The registered check passes.",
      1,
    );
    fixture.store.recordSessionIterationBoundary(fixture.runId, 1);
    fixture.store.decideReview(fixture.runId, diffSha256, "unit-operator", "reject");
    fixture.store.finishRollback(fixture.runId);
    const checkpointSha256 = fixture.store.getCheckpoint(fixture.runId).checkpointSha256;
    fixture.store.approveRestore(fixture.runId, checkpointSha256, "unit-operator");
    fixture.store.finishRestore(fixture.runId);
    fixture.store.recordVerificationAndAwaitReview(
      fixture.runId,
      completed.diff,
      {
        ...completed.verification,
        outcome: "failed",
        checks: completed.verification.checks.map((check) => ({
          ...check,
          exitCode: 1,
          signal: null,
          stdout: "",
          stderr: "repair required\n",
          outcome: "failed" as const,
        })),
      },
      "verifying",
    );
    fixture.store.beginSessionIteration(fixture.runId);
    const checkpointFiles = fixture.store.listCheckpointFiles(fixture.runId);
    expectCode(
      () => fixture.store.recordPatchSetIntent(fixture.runId, completedPatchSet, checkpointFiles),
      "IMMUTABLE_ARTIFACT_CONFLICT",
    );
    chargeRepairIteration(fixture.store);
    const replacement = fixture.store.beginOperation(
      fixture.runId,
      "session.tool.mutation.patchset",
      0,
      0,
      1_000,
      "running",
    );
    fixture.store.recordPatchSetIntent(fixture.runId, completedPatchSet, checkpointFiles);
    fixture.store.saveTreeCheckpoint(fixture.runId, checkpointSha256);
    fixture.store.finishSessionVerificationOperation(
      replacement,
      {
        outcome: "succeeded",
        activeRuntimeMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        detail: { tool: "apply_patchset" },
      },
      completed.diff,
      {
        ...completed.verification,
        outcome: "unavailable",
        checks: completed.verification.checks.map((check) => ({
          ...check,
          exitCode: null,
          signal: null,
          stdout: "",
          stderr: "Checks have not run for this patch.\n",
          outcome: "unavailable" as const,
        })),
      },
    );
    fixture.store.transition(fixture.runId, "verifying", "execution.completed");
    fixture.store.recordVerificationAndAwaitReview(
      fixture.runId,
      completed.diff,
      completed.verification,
    );

    expectCode(
      () =>
        fixture.store.preflightReviewDecision(
          fixture.runId,
          diffSha256,
          "unit-operator",
          "approve",
        ),
      "SESSION_NOT_COMPLETED",
    );
    expectCode(
      () => fixture.store.decideReview(fixture.runId, diffSha256, "unit-operator", "approve"),
      "SESSION_NOT_COMPLETED",
    );
    closeFixture(fixture);
    expect(readChangeHandoffSource(fixture.databasePath, fixture.runId)).toMatchObject({
      state: "awaiting_review",
      reviewDecision: null,
      verification: { outcome: "passed", diffSha256, checkpointSha256 },
    });
  });

  it("accepts distinct approval row and event timestamps from a stepping clock", () => {
    const fixture = completedFixture();
    mutateDatabase(fixture, (database) => {
      const updated = database
        .prepare(
          "UPDATE approvals SET created_at = '2026-08-01T12:30:00.001Z' WHERE run_id = ? AND kind = 'review'",
        )
        .run(fixture.runId) as { readonly changes: number };
      expect(updated.changes).toBe(1);
    });

    expect(readChangeHandoffSource(fixture.databasePath, fixture.runId).state).toBe("completed");
  });

  it("rejects forged session completion, iteration, review, and atomic-control relations", () => {
    const failedCompletion = trackedFixture();
    enterChargedRepairSession(failedCompletion);
    mutateDatabase(failedCompletion, (database) => {
      database
        .prepare("UPDATE runs SET state = 'awaiting_review', version = version + 1 WHERE id = ?")
        .run(failedCompletion.runId);
      database
        .prepare(
          "INSERT INTO run_events (run_id, sequence, type, payload_json, created_at) VALUES (?, (SELECT MAX(sequence) + 1 FROM run_events WHERE run_id = ?), 'session.completed', ?, '2026-08-01T12:30:00.000Z')",
        )
        .run(
          failedCompletion.runId,
          failedCompletion.runId,
          JSON.stringify({ iterations: 1, summary: "Forged completion." }),
        );
    });
    expectCode(
      () => readChangeHandoffSource(failedCompletion.databasePath, failedCompletion.runId),
      "HANDOFF_SOURCE_INVALID",
    );

    const corruptions: ReadonlyArray<(database: TestDatabase, runId: string) => void> = [
      (database, runId) => {
        database
          .prepare(
            "UPDATE run_events SET payload_json = json_set(payload_json, '$.iterations', 0) WHERE run_id = ? AND type = 'session.completed'",
          )
          .run(runId);
      },
      (database, runId) => {
        database
          .prepare(
            "UPDATE run_events SET payload_json = json_remove(payload_json, '$.operationId') WHERE run_id = ? AND type = 'session.completed'",
          )
          .run(runId);
      },
      (database, runId) => {
        database
          .prepare(
            "UPDATE run_events SET type = 'operation.interrupted' WHERE run_id = ? AND sequence = (SELECT sequence - 1 FROM run_events WHERE run_id = ? AND type = 'session.completed')",
          )
          .run(runId, runId);
      },
      (database, runId) => {
        database
          .prepare(
            "UPDATE operations SET status = 'failed' WHERE run_id = ? AND kind = 'session.control.report_done'",
          )
          .run(runId);
      },
    ];
    for (const corrupt of corruptions) {
      const fixture = atomicSessionCompletedFixture();
      mutateDatabase(fixture, (database) => {
        corrupt(database, fixture.runId);
      });
      expectCode(
        () => readChangeHandoffSource(fixture.databasePath, fixture.runId),
        "HANDOFF_SOURCE_INVALID",
      );
    }
  });

  it("reconciles operation starts, terminals, atomic successors, and rows by operation identity", () => {
    const corruptions: ReadonlyArray<(database: TestDatabase, runId: string) => void> = [
      (database, runId) => {
        database
          .prepare(
            "UPDATE run_events SET type = 'base.pinned' WHERE run_id = ? AND type = 'operation.finished' AND json_extract(payload_json, '$.kind') = ?",
          )
          .run(runId, SESSION_ITERATION_OPERATION_KIND);
      },
      (database, runId) => {
        database
          .prepare(
            "UPDATE run_events SET type = 'operation.finished', payload_json = (SELECT payload_json FROM run_events WHERE run_id = ? AND type = 'operation.finished' AND json_extract(payload_json, '$.kind') = 'session.control.report_done') WHERE run_id = ? AND type = 'session.iteration_completed'",
          )
          .run(runId, runId);
      },
      (database, runId) => {
        const starts = database
          .prepare(
            "SELECT sequence FROM run_events WHERE run_id = ? AND type = 'operation.started' AND json_extract(payload_json, '$.kind') IN (?, 'session.control.report_done') ORDER BY sequence",
          )
          .all(runId, SESSION_ITERATION_OPERATION_KIND) as Array<{ readonly sequence: number }>;
        expect(starts).toHaveLength(2);
        const first = starts[0]?.sequence;
        const second = starts[1]?.sequence;
        if (first === undefined || second === undefined)
          throw new Error("Expected operation starts");
        database
          .prepare("UPDATE run_events SET sequence = -1 WHERE run_id = ? AND sequence = ?")
          .run(runId, first);
        database
          .prepare("UPDATE run_events SET sequence = ? WHERE run_id = ? AND sequence = ?")
          .run(first, runId, second);
        database
          .prepare("UPDATE run_events SET sequence = ? WHERE run_id = ? AND sequence = -1")
          .run(second, runId);
      },
      (database, runId) => {
        database
          .prepare(
            "UPDATE operations SET reserved_runtime_ms = reserved_runtime_ms + 1 WHERE run_id = ? AND kind = ?",
          )
          .run(runId, SESSION_ITERATION_OPERATION_KIND);
      },
      (database, runId) => {
        const repair = database
          .prepare("SELECT sequence FROM run_events WHERE run_id = ? AND type = 'repair.requested'")
          .get(runId) as { readonly sequence: number };
        const revise = database
          .prepare(
            "SELECT sequence FROM run_events WHERE run_id = ? AND type = 'operation.started' AND json_extract(payload_json, '$.kind') = ?",
          )
          .get(runId, SESSION_ITERATION_OPERATION_KIND) as { readonly sequence: number };
        database
          .prepare("UPDATE run_events SET sequence = -1 WHERE run_id = ? AND sequence = ?")
          .run(runId, repair.sequence);
        database
          .prepare("UPDATE run_events SET sequence = ? WHERE run_id = ? AND sequence = ?")
          .run(repair.sequence, runId, revise.sequence);
        database
          .prepare("UPDATE run_events SET sequence = ? WHERE run_id = ? AND sequence = -1")
          .run(revise.sequence, runId);
      },
    ];

    for (const corrupt of corruptions) {
      const fixture = atomicSessionCompletedFixture();
      mutateDatabase(fixture, (database) => corrupt(database, fixture.runId));
      expectCode(
        () => readChangeHandoffSource(fixture.databasePath, fixture.runId),
        "HANDOFF_SOURCE_INVALID",
      );
    }
  });

  it("rejects a session-only operation admitted outside an open repair epoch", () => {
    const fixture = trackedFixture();
    prepareChangeRoomRun(fixture.store);
    approveChangeRoomPlan(fixture.store);
    const operation = fixture.store.beginOperation(
      fixture.runId,
      "generic.read.manifest",
      0,
      0,
      1_000,
      "running",
    );
    fixture.store.finishOperation(operation, {
      outcome: "succeeded",
      activeRuntimeMs: 1,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      detail: { tool: "propose_patch" },
    });
    closeFixture(fixture);
    expect(() => readChangeHandoffSource(fixture.databasePath, fixture.runId)).not.toThrow();

    mutateDatabase(fixture, (database) => {
      database
        .prepare("UPDATE operations SET kind = ? WHERE run_id = ? AND id = ?")
        .run("session.tool.mutation.patchset", fixture.runId, operation.id);
      database
        .prepare(
          "UPDATE run_events SET payload_json = json_set(payload_json, '$.kind', ?) WHERE run_id = ? AND json_extract(payload_json, '$.operationId') = ?",
        )
        .run("session.tool.mutation.patchset", fixture.runId, operation.id);
    });
    expectCode(
      () => readChangeHandoffSource(fixture.databasePath, fixture.runId),
      "HANDOFF_SOURCE_INVALID",
    );
  });

  it("distinguishes advisory propose_patch from atomically verified apply_patchset", () => {
    const recordAdvisoryPatch = (fixture: ChangeRoomFixture): string => {
      enterChargedRepairSession(fixture);
      const operation = fixture.store.beginOperation(
        fixture.runId,
        "session.tool.mutation.patchset",
        0,
        0,
        1_000,
        "running",
      );
      fixture.store.finishOperation(operation, {
        outcome: "succeeded",
        activeRuntimeMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        detail: { tool: "propose_patch" },
      });
      const generic = fixture.store.beginOperation(
        fixture.runId,
        "generic.long_tool_metadata",
        0,
        0,
        1_000,
        "running",
      );
      fixture.store.finishOperation(generic, {
        outcome: "succeeded",
        activeRuntimeMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        detail: { tool: "x".repeat(100) },
      });
      return operation.id;
    };
    const recordAppliedPatch = (fixture: ChangeRoomFixture): string => {
      enterChargedRepairSession(fixture);
      const current = fixture.store.getRun(fixture.runId);
      if (current.patchSet === null || current.diff === null || current.verification === null) {
        throw new Error("Expected current patch and verification evidence");
      }
      const checkpointFiles = fixture.store.listCheckpointFiles(fixture.runId);
      const operation = fixture.store.beginOperation(
        fixture.runId,
        "session.tool.mutation.patchset",
        0,
        0,
        1_000,
        "running",
      );
      fixture.store.recordPatchSetIntent(fixture.runId, current.patchSet, checkpointFiles);
      fixture.store.saveTreeCheckpoint(fixture.runId, current.verification.checkpointSha256);
      fixture.store.finishSessionVerificationOperation(
        operation,
        {
          outcome: "succeeded",
          activeRuntimeMs: 1,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0,
          detail: { tool: "apply_patchset" },
        },
        current.diff,
        {
          ...current.verification,
          outcome: "unavailable",
          checks: current.verification.checks.map((check) => ({
            ...check,
            exitCode: null,
            signal: null,
            stdout: "",
            stderr: "Checks have not run for this patch.\n",
            outcome: "unavailable" as const,
          })),
        },
      );
      return operation.id;
    };

    const advisory = trackedFixture();
    recordAdvisoryPatch(advisory);
    closeFixture(advisory);
    expect(readChangeHandoffSource(advisory.databasePath, advisory.runId).state).toBe("running");

    const applied = trackedFixture();
    recordAppliedPatch(applied);
    closeFixture(applied);
    expect(readChangeHandoffSource(applied.databasePath, applied.runId)).toMatchObject({
      state: "running",
      verification: { outcome: "unavailable" },
    });

    const relabelledApply = trackedFixture();
    const relabelledOperationId = recordAppliedPatch(relabelledApply);
    mutateDatabase(relabelledApply, (database) => {
      database
        .prepare(
          "UPDATE run_events SET payload_json = json_set(payload_json, '$.detail.tool', 'propose_patch') WHERE run_id = ? AND type = 'operation.finished' AND json_extract(payload_json, '$.operationId') = ?",
        )
        .run(relabelledApply.runId, relabelledOperationId);
      database
        .prepare(
          "UPDATE operations SET result_json = json_set(result_json, '$.tool', 'propose_patch') WHERE run_id = ? AND id = ?",
        )
        .run(relabelledApply.runId, relabelledOperationId);
    });
    expectCode(
      () => readChangeHandoffSource(relabelledApply.databasePath, relabelledApply.runId),
      "HANDOFF_SOURCE_INVALID",
    );

    const contradictoryRow = trackedFixture();
    const contradictoryOperationId = recordAdvisoryPatch(contradictoryRow);
    mutateDatabase(contradictoryRow, (database) => {
      database
        .prepare(
          "UPDATE operations SET result_json = json_set(result_json, '$.tool', 'apply_patchset') WHERE run_id = ? AND id = ?",
        )
        .run(contradictoryRow.runId, contradictoryOperationId);
    });
    expectCode(
      () => readChangeHandoffSource(contradictoryRow.databasePath, contradictoryRow.runId),
      "HANDOFF_SOURCE_INVALID",
    );

    const duplicateRowTool = trackedFixture();
    const duplicateRowOperationId = recordAdvisoryPatch(duplicateRowTool);
    mutateDatabase(duplicateRowTool, (database) => {
      database
        .prepare("UPDATE operations SET result_json = ? WHERE run_id = ? AND id = ?")
        .run(
          '{"tool":"propose_patch","tool":"apply_patchset"}',
          duplicateRowTool.runId,
          duplicateRowOperationId,
        );
    });
    expectCode(
      () => readChangeHandoffSource(duplicateRowTool.databasePath, duplicateRowTool.runId),
      "HANDOFF_SOURCE_INVALID",
    );

    const duplicateEventTool = trackedFixture();
    const duplicateEventOperationId = recordAdvisoryPatch(duplicateEventTool);
    mutateDatabase(duplicateEventTool, (database) => {
      database
        .prepare(
          `UPDATE run_events
           SET payload_json = replace(
             payload_json,
             '"tool":"propose_patch"',
             '"tool":"propose_patch","tool":"apply_patchset"'
           )
           WHERE run_id = ? AND type = 'operation.finished'
             AND json_extract(payload_json, '$.operationId') = ?`,
        )
        .run(duplicateEventTool.runId, duplicateEventOperationId);
    });
    expectCode(
      () => readChangeHandoffSource(duplicateEventTool.databasePath, duplicateEventTool.runId),
      "HANDOFF_SOURCE_INVALID",
    );

    const forgedApply = trackedFixture();
    const operationId = recordAdvisoryPatch(forgedApply);
    mutateDatabase(forgedApply, (database) => {
      database
        .prepare(
          "UPDATE run_events SET payload_json = json_set(payload_json, '$.detail.tool', 'apply_patchset') WHERE run_id = ? AND type = 'operation.finished' AND json_extract(payload_json, '$.operationId') = ?",
        )
        .run(forgedApply.runId, operationId);
      database
        .prepare(
          "UPDATE operations SET result_json = json_set(result_json, '$.tool', 'apply_patchset') WHERE run_id = ? AND id = ?",
        )
        .run(forgedApply.runId, operationId);
    });
    expectCode(
      () => readChangeHandoffSource(forgedApply.databasePath, forgedApply.runId),
      "HANDOFF_SOURCE_INVALID",
    );
  });

  it.each(["failed", "cancelled"] as const)(
    "accepts an effectful %s patch only with its immediate unavailable verification",
    (outcome) => {
      const fixture = trackedFixture();
      enterChargedRepairSession(fixture);
      const current = fixture.store.getRun(fixture.runId);
      if (current.patchSet === null || current.diff === null || current.verification === null) {
        throw new Error("Expected current patch and verification evidence");
      }
      const operation = fixture.store.beginOperation(
        fixture.runId,
        "session.tool.mutation.patchset",
        0,
        0,
        1_000,
        "running",
      );
      fixture.store.recordPatchSetIntent(
        fixture.runId,
        current.patchSet,
        fixture.store.listCheckpointFiles(fixture.runId),
      );
      fixture.store.saveTreeCheckpoint(fixture.runId, current.verification.checkpointSha256);
      fixture.store.finishFailedSessionPatchVerificationOperation(
        operation,
        {
          outcome,
          activeRuntimeMs: 1,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0,
          detail: { tool: "apply_patchset", code: "SYNTHETIC_FAILURE" },
        },
        current.diff,
        {
          ...current.verification,
          outcome: "unavailable",
          checks: current.verification.checks.map((check) => ({
            ...check,
            exitCode: null,
            signal: null,
            stdout: "",
            stderr: "Patch settlement did not complete.\n",
            outcome: "unavailable" as const,
          })),
        },
      );
      closeFixture(fixture);

      expect(readChangeHandoffSource(fixture.databasePath, fixture.runId)).toMatchObject({
        state: "running",
        verification: { outcome: "unavailable" },
      });

      mutateDatabase(fixture, (database) => {
        database
          .prepare(
            "UPDATE run_events SET payload_json = json_set(payload_json, '$.detail.tool', 'propose_patch') WHERE run_id = ? AND type = 'operation.finished' AND json_extract(payload_json, '$.operationId') = ?",
          )
          .run(fixture.runId, operation.id);
        database
          .prepare(
            "UPDATE operations SET result_json = json_set(result_json, '$.tool', 'propose_patch') WHERE run_id = ? AND id = ?",
          )
          .run(fixture.runId, operation.id);
      });
      expectCode(
        () => readChangeHandoffSource(fixture.databasePath, fixture.runId),
        "HANDOFF_SOURCE_INVALID",
      );
    },
  );

  it("rejects running verification whose immediate operation did not succeed", () => {
    const fixture = atomicSessionCompletedFixture();
    mutateDatabase(fixture, (database) => {
      database
        .prepare(
          "UPDATE run_events SET payload_json = json_set(payload_json, '$.outcome', 'failed') WHERE run_id = ? AND type = 'operation.finished' AND json_extract(payload_json, '$.kind') = 'session.tool.exec.check'",
        )
        .run(fixture.runId);
      database
        .prepare(
          "UPDATE operations SET status = 'failed' WHERE run_id = ? AND kind = 'session.tool.exec.check'",
        )
        .run(fixture.runId);
    });

    expectCode(
      () => readChangeHandoffSource(fixture.databasePath, fixture.runId),
      "HANDOFF_SOURCE_INVALID",
    );
  });

  it("rejects operation kinds outside the Store grammar", () => {
    const fixture = trackedFixture();
    const operation = fixture.store.beginOperation(
      fixture.runId,
      "generic.safe",
      0,
      0,
      1_000,
      "preparing",
    );
    fixture.store.finishOperation(operation, {
      outcome: "succeeded",
      activeRuntimeMs: 1,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      detail: {},
    });
    driveToCompleted(fixture.store);
    closeFixture(fixture);
    expect(readChangeHandoffSource(fixture.databasePath, fixture.runId).state).toBe("completed");

    mutateDatabase(fixture, (database) => {
      const malformed = "generic\nunsafe";
      database.prepare("UPDATE operations SET kind = ? WHERE id = ?").run(malformed, operation.id);
      database
        .prepare(
          "UPDATE run_events SET payload_json = json_set(payload_json, '$.kind', ?) WHERE run_id = ? AND json_extract(payload_json, '$.operationId') = ?",
        )
        .run(malformed, fixture.runId, operation.id);
    });
    expectCode(
      () => readChangeHandoffSource(fixture.databasePath, fixture.runId),
      "HANDOFF_SOURCE_INVALID",
    );
  });

  it("binds replacement intent to its superseded paths and current repair revision", () => {
    const valid = supersededRepairFixture();
    expect(readChangeHandoffSource(valid.databasePath, valid.runId)).toMatchObject({
      state: "running",
      verification: null,
      checkpointSha256: null,
    });

    const outsideMutation = supersededRepairFixture();
    mutateDatabase(outsideMutation, (database) => {
      const started = database
        .prepare(
          "SELECT sequence FROM run_events WHERE run_id = ? AND type = 'operation.started' AND json_extract(payload_json, '$.kind') = 'session.tool.mutation.patchset'",
        )
        .get(outsideMutation.runId) as { readonly sequence: number };
      const superseded = database
        .prepare(
          "SELECT sequence FROM run_events WHERE run_id = ? AND type = 'patch_set.superseded'",
        )
        .get(outsideMutation.runId) as { readonly sequence: number };
      database
        .prepare("UPDATE run_events SET sequence = -1 WHERE run_id = ? AND sequence = ?")
        .run(outsideMutation.runId, started.sequence);
      database
        .prepare("UPDATE run_events SET sequence = ? WHERE run_id = ? AND sequence = ?")
        .run(started.sequence, outsideMutation.runId, superseded.sequence);
      database
        .prepare("UPDATE run_events SET sequence = ? WHERE run_id = ? AND sequence = -1")
        .run(superseded.sequence, outsideMutation.runId);
    });
    expectCode(
      () => readChangeHandoffSource(outsideMutation.databasePath, outsideMutation.runId),
      "HANDOFF_SOURCE_INVALID",
    );

    const mismatchedPaths = supersededRepairFixture();
    mutateDatabase(mismatchedPaths, (database) => {
      database
        .prepare(
          "UPDATE run_events SET payload_json = json_set(payload_json, '$.paths', json(?)) WHERE run_id = ? AND type = 'patch_set.superseded'",
        )
        .run(JSON.stringify(["src/not-the-active-intent.txt"]), mismatchedPaths.runId);
    });
    expectCode(
      () => readChangeHandoffSource(mismatchedPaths.databasePath, mismatchedPaths.runId),
      "HANDOFF_SOURCE_INVALID",
    );

    const missingMarker = supersededRepairFixture();
    mutateDatabase(missingMarker, (database) => {
      database
        .prepare(
          "UPDATE run_events SET type = 'resume.requested', payload_json = '{}' WHERE run_id = ? AND type = 'patch_set.superseded'",
        )
        .run(missingMarker.runId);
    });
    expectCode(
      () => readChangeHandoffSource(missingMarker.databasePath, missingMarker.runId),
      "HANDOFF_SOURCE_INVALID",
    );

    const failedRevision = supersededRepairFixture();
    mutateDatabase(failedRevision, (database) => {
      database
        .prepare("UPDATE operations SET status = 'failed' WHERE run_id = ? AND kind = ?")
        .run(failedRevision.runId, SESSION_ITERATION_OPERATION_KIND);
      database
        .prepare(
          "UPDATE run_events SET payload_json = json_set(payload_json, '$.outcome', 'failed') WHERE run_id = ? AND type = 'operation.finished' AND json_extract(payload_json, '$.kind') = ?",
        )
        .run(failedRevision.runId, SESSION_ITERATION_OPERATION_KIND);
    });
    expectCode(
      () => readChangeHandoffSource(failedRevision.databasePath, failedRevision.runId),
      "HANDOFF_SOURCE_INVALID",
    );

    const whileFailed = supersededRepairFixture(true);
    mutateDatabase(whileFailed, (database) => {
      const resumed = database
        .prepare("SELECT sequence FROM run_events WHERE run_id = ? AND type = 'run.resumed'")
        .get(whileFailed.runId) as { readonly sequence: number };
      const superseded = database
        .prepare(
          "SELECT sequence FROM run_events WHERE run_id = ? AND type = 'patch_set.superseded'",
        )
        .get(whileFailed.runId) as { readonly sequence: number };
      const replacement = database
        .prepare(
          "SELECT MAX(sequence) AS sequence FROM run_events WHERE run_id = ? AND type = 'patch_set.intent_recorded'",
        )
        .get(whileFailed.runId) as { readonly sequence: number };
      database
        .prepare("UPDATE run_events SET sequence = -1 WHERE run_id = ? AND sequence = ?")
        .run(whileFailed.runId, resumed.sequence);
      database
        .prepare("UPDATE run_events SET sequence = ? WHERE run_id = ? AND sequence = ?")
        .run(resumed.sequence, whileFailed.runId, superseded.sequence);
      database
        .prepare("UPDATE run_events SET sequence = ? WHERE run_id = ? AND sequence = ?")
        .run(superseded.sequence, whileFailed.runId, replacement.sequence);
      database
        .prepare("UPDATE run_events SET sequence = ? WHERE run_id = ? AND sequence = -1")
        .run(replacement.sequence, whileFailed.runId);
    });
    expectCode(
      () => readChangeHandoffSource(whileFailed.databasePath, whileFailed.runId),
      "HANDOFF_SOURCE_INVALID",
    );
  });

  it("converts a charged legacy edit revision to a clean reader-valid patch set", () => {
    const fixture = trackedFixture();
    prepareIterationPlan(fixture);
    const baseline = "hello\n";
    const approved = "hello, legacy\n";
    const baselineBase64 = Buffer.from(baseline, "utf8").toString("base64");
    const approvedBase64 = Buffer.from(approved, "utf8").toString("base64");
    const legacyEdit = {
      path: UNIT_PLAN.target,
      expectedPreimageSha256: sha256(baseline),
      findText: baseline,
      replaceText: approved,
      rationale: "Exercise legacy-to-modern replacement.",
    };
    fixture.store.recordWorkspace(
      fixture.runId,
      "/tmp/legacy-cache.git",
      "/tmp/legacy-worktree",
      baselineBase64,
    );
    const legacyWriter = new Database(fixture.databasePath);
    try {
      legacyWriter
        .prepare("UPDATE runs SET edit_json = ?, approved_base64 = ? WHERE id = ?")
        .run(JSON.stringify(legacyEdit), approvedBase64, fixture.runId);
      legacyWriter
        .prepare(
          `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
           SELECT ?, COALESCE(MAX(sequence), 0) + 1, 'edit.intent_recorded', ?, ?
           FROM run_events WHERE run_id = ?`,
        )
        .run(
          fixture.runId,
          JSON.stringify({
            path: UNIT_PLAN.target,
            expectedPreimageSha256: legacyEdit.expectedPreimageSha256,
          }),
          "2026-08-01T12:00:00.000Z",
          fixture.runId,
        );
    } finally {
      legacyWriter.close();
    }
    const legacyCheckpointSha256 = checkpointDigest({
      runId: fixture.runId,
      baseCommit: UNIT_BASE_COMMIT,
      target: UNIT_PLAN.target,
      baselineBase64,
      approvedBase64,
    });
    fixture.store.saveCheckpoint(
      fixture.runId,
      baselineBase64,
      approvedBase64,
      legacyCheckpointSha256,
    );
    fixture.store.transition(fixture.runId, "verifying", "edit.materialized");
    const diff = "diff --git a/src/greeting.txt b/src/greeting.txt\n-hello\n+hello, legacy\n";
    fixture.store.recordVerificationAndAwaitReview(
      fixture.runId,
      diff,
      {
        outcome: "failed",
        checks: [
          {
            checkId: "unit",
            argv: ["node", "--test"],
            exitCode: 1,
            signal: null,
            durationMs: 1,
            stdout: "",
            stderr: "repair required\n",
            truncated: false,
            outcome: "failed",
          },
        ],
        changedPaths: [UNIT_PLAN.target],
        diffSha256: sha256(diff),
        checkpointSha256: legacyCheckpointSha256,
      },
      "verifying",
    );
    fixture.store.beginSessionIteration(fixture.runId);
    chargeRepairIteration(fixture.store);

    const modernApproved = "hello, modern\n";
    const modernFiles = [
      {
        path: UNIT_PLAN.target,
        op: "modify" as const,
        baselineBase64,
        approvedBase64: Buffer.from(modernApproved, "utf8").toString("base64"),
      },
    ];
    const replacement = fixture.store.beginOperation(
      fixture.runId,
      "session.tool.mutation.patchset",
      0,
      0,
      1_000,
      "running",
    );
    fixture.store.recordPatchSetIntent(
      fixture.runId,
      {
        summary: "Replace the legacy edit with a modern patch set.",
        edits: [
          {
            op: "modify",
            path: UNIT_PLAN.target,
            expectedPreimageSha256: sha256(baseline),
            replacements: [{ findText: baseline, replaceText: modernApproved }],
            rationale: "Exercise replacement cleanup.",
          },
        ],
      },
      modernFiles,
    );
    const rawReader = new Database(fixture.databasePath);
    try {
      expect(
        rawReader
          .prepare(
            "SELECT edit_json, baseline_base64, approved_base64, diff, verification_json FROM runs WHERE id = ?",
          )
          .get(fixture.runId),
      ).toEqual({
        edit_json: null,
        baseline_base64: null,
        approved_base64: null,
        diff: null,
        verification_json: null,
      });
      expect(
        rawReader
          .prepare("SELECT COUNT(*) AS total FROM checkpoints WHERE run_id = ?")
          .get(fixture.runId),
      ).toEqual({ total: 0 });
    } finally {
      rawReader.close();
    }
    const modernCheckpointSha256 = treeCheckpointDigest({
      runId: fixture.runId,
      baseCommit: UNIT_BASE_COMMIT,
      files: modernFiles,
    });
    fixture.store.saveTreeCheckpoint(fixture.runId, modernCheckpointSha256);
    const modernDiff = "diff --git a/src/greeting.txt b/src/greeting.txt\n-hello\n+hello, modern\n";
    fixture.store.finishSessionVerificationOperation(
      replacement,
      {
        outcome: "succeeded",
        activeRuntimeMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        detail: { tool: "apply_patchset" },
      },
      modernDiff,
      {
        outcome: "unavailable",
        checks: [
          {
            checkId: "unit",
            argv: ["node", "--test"],
            exitCode: null,
            signal: null,
            durationMs: 0,
            stdout: "",
            stderr: "Checks have not run for this patch.\n",
            truncated: false,
            outcome: "unavailable",
          },
        ],
        changedPaths: [UNIT_PLAN.target],
        diffSha256: sha256(modernDiff),
        checkpointSha256: modernCheckpointSha256,
      },
    );
    closeFixture(fixture);

    expect(readChangeHandoffSource(fixture.databasePath, fixture.runId)).toMatchObject({
      state: "running",
      verification: { outcome: "unavailable" },
      checkpointSha256: modernCheckpointSha256,
    });
  });

  it("accepts a metered premature report_done failure inside an open repair session", () => {
    const fixture = trackedFixture();
    enterChargedRepairSession(fixture);
    const reportDone = fixture.store.beginOperation(
      fixture.runId,
      "session.control.report_done",
      0,
      0,
      1_000,
      "running",
    );
    fixture.store.finishOperation(reportDone, {
      outcome: "failed",
      activeRuntimeMs: 1,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      detail: { code: "VERIFICATION_NOT_PASSED" },
    });
    closeFixture(fixture);

    expect(readChangeHandoffSource(fixture.databasePath, fixture.runId)).toMatchObject({
      state: "running",
      verification: { outcome: "failed" },
    });
  });

  it("accepts current and legacy interrupted operations and preserves repair epochs across resume", () => {
    for (const legacy of [false, true]) {
      const fixture = trackedFixture();
      fixture.store.beginOperation(fixture.runId, "provider.prepare", 0.25, 16, 1_000);
      fixture.store.markStartedOperationsInterrupted(fixture.runId);
      closeFixture(fixture);
      if (legacy) {
        mutateDatabase(fixture, (database) => {
          database
            .prepare(
              "UPDATE run_events SET payload_json = json_remove(payload_json, '$.kind') WHERE run_id = ? AND type = 'operation.interrupted'",
            )
            .run(fixture.runId);
        });
      }
      expect(readChangeHandoffSource(fixture.databasePath, fixture.runId).state).toBe("preparing");
    }

    const resumed = trackedFixture();
    prepareIterationPlan(resumed, 2);
    finishToAwaitingReview(resumed.store, "failed", "verifying");
    resumed.store.beginSessionIteration(resumed.runId);
    resumed.store.beginOperation(resumed.runId, SESSION_ITERATION_OPERATION_KIND, 0, 16, 1_000);
    resumed.store.markStartedOperationsInterrupted(resumed.runId);
    resumed.store.failRun(
      resumed.runId,
      "running",
      new IcarusError("INTERRUPTED", "Synthetic provider interruption"),
    );
    resumed.store.resumeFailed(resumed.runId);
    chargeRepairIteration(resumed.store);
    closeFixture(resumed);
    expect(readChangeHandoffSource(resumed.databasePath, resumed.runId).state).toBe("running");
  });

  it("rejects resume while a session control operation remains active", () => {
    const fixture = trackedFixture();
    enterChargedRepairSession(fixture);
    recordPassingSessionVerification(fixture);
    fixture.store.beginOperation(
      fixture.runId,
      "session.control.report_done",
      0,
      0,
      1_000,
      "running",
    );
    fixture.store.failRun(
      fixture.runId,
      "running",
      new IcarusError("INTERRUPTED", "Synthetic control interruption"),
    );
    fixture.store.markStartedOperationsInterrupted(fixture.runId);
    fixture.store.resumeFailed(fixture.runId);
    closeFixture(fixture);
    expect(readChangeHandoffSource(fixture.databasePath, fixture.runId).state).toBe("running");

    mutateDatabase(fixture, (database) => {
      const interrupted = database
        .prepare(
          "SELECT sequence FROM run_events WHERE run_id = ? AND type = 'operation.interrupted'",
        )
        .get(fixture.runId) as { readonly sequence: number };
      const resumed = database
        .prepare("SELECT sequence FROM run_events WHERE run_id = ? AND type = 'run.resumed'")
        .get(fixture.runId) as { readonly sequence: number };
      database
        .prepare("UPDATE run_events SET sequence = -1 WHERE run_id = ? AND sequence = ?")
        .run(fixture.runId, interrupted.sequence);
      database
        .prepare("UPDATE run_events SET sequence = ? WHERE run_id = ? AND sequence = ?")
        .run(interrupted.sequence, fixture.runId, resumed.sequence);
      database
        .prepare("UPDATE run_events SET sequence = ? WHERE run_id = ? AND sequence = -1")
        .run(resumed.sequence, fixture.runId);
    });
    expectCode(
      () => readChangeHandoffSource(fixture.databasePath, fixture.runId),
      "HANDOFF_SOURCE_INVALID",
    );
  });

  it("validates emergency cancellation ordinals, reservations, and interruption evidence", () => {
    const emergencyFixture = (): ChangeRoomFixture => {
      const fixture = trackedFixture();
      fixture.store.transition(fixture.runId, "cancelling", "cancellation.requested", {
        actor: "unit-operator",
      });
      fixture.store.beginCancellationRecoveryOperation(fixture.runId);
      fixture.store.markStartedOperationsInterrupted(fixture.runId);
      fixture.store.finishCancellation(fixture.runId);
      closeFixture(fixture);
      return fixture;
    };

    const valid = emergencyFixture();
    expect(readChangeHandoffSource(valid.databasePath, valid.runId).state).toBe("cancelled");

    for (const field of ["attempt", "reservedRuntimeMs"] as const) {
      const corrupt = emergencyFixture();
      mutateDatabase(corrupt, (database) => {
        database
          .prepare(
            `UPDATE run_events SET payload_json = json_set(payload_json, '$.${field}', ?)
             WHERE run_id = ? AND type = 'operation.started'`,
          )
          .run(field === "attempt" ? 2 : 1, corrupt.runId);
      });
      expectCode(
        () => readChangeHandoffSource(corrupt.databasePath, corrupt.runId),
        "HANDOFF_SOURCE_INVALID",
      );
    }
  });

  it("rejects operation-count, reservation, and aggregate usage drift", () => {
    const corruptions: ReadonlyArray<(database: TestDatabase, runId: string) => void> = [
      (database, runId) => {
        database.prepare("UPDATE runs SET tool_calls = tool_calls + 1 WHERE id = ?").run(runId);
      },
      (database, runId) => {
        database.prepare("UPDATE runs SET reserved_cost_usd = 0.5 WHERE id = ?").run(runId);
      },
      (database, runId) => {
        database.prepare("UPDATE runs SET input_tokens = 999999999 WHERE id = ?").run(runId);
      },
      (database, runId) => {
        database.prepare("UPDATE runs SET active_runtime_ms = -1 WHERE id = ?").run(runId);
      },
    ];

    for (const corrupt of corruptions) {
      const fixture = completedFixture();
      mutateDatabase(fixture, (database) => corrupt(database, fixture.runId));
      expectCode(
        () => readChangeHandoffSource(fixture.databasePath, fixture.runId),
        "HANDOFF_SOURCE_INVALID",
      );
    }
  });

  it("fails closed across provider, approval, verification, checkpoint, digest, event, and state corruption", () => {
    const corruptions: ReadonlyArray<{
      readonly name: string;
      readonly mutate: (database: TestDatabase) => void;
    }> = [
      {
        name: "provider shape",
        mutate: (database) =>
          void database
            .prepare("UPDATE runs SET provider_json = '{}' WHERE id = ?")
            .run(UNIT_RUN_ID),
      },
      {
        name: "context digest",
        mutate: (database) =>
          void database
            .prepare("UPDATE runs SET context_sha256 = ? WHERE id = ?")
            .run("0".repeat(64), UNIT_RUN_ID),
      },
      {
        name: "plan digest",
        mutate: (database) =>
          void database
            .prepare("UPDATE runs SET plan_sha256 = ? WHERE id = ?")
            .run("0".repeat(64), UNIT_RUN_ID),
      },
      {
        name: "approval decision",
        mutate: (database) =>
          void database
            .prepare(
              "UPDATE approvals SET digest = 'not-a-digest' WHERE run_id = ? AND kind = 'review'",
            )
            .run(UNIT_RUN_ID),
      },
      {
        name: "verification diff binding",
        mutate: (database) =>
          void database
            .prepare("UPDATE runs SET diff = diff || 'tampered' WHERE id = ?")
            .run(UNIT_RUN_ID),
      },
      {
        name: "checkpoint binding",
        mutate: (database) =>
          void database
            .prepare("UPDATE checkpoints SET checkpoint_sha256 = ? WHERE run_id = ?")
            .run("0".repeat(64), UNIT_RUN_ID),
      },
      {
        name: "event high-water",
        mutate: (database) =>
          void database
            .prepare(
              "UPDATE run_events SET sequence = sequence + 1 WHERE run_id = ? AND sequence = (SELECT MAX(sequence) FROM run_events WHERE run_id = ?)",
            )
            .run(UNIT_RUN_ID, UNIT_RUN_ID),
      },
      {
        name: "terminal review relation",
        mutate: (database) =>
          void database
            .prepare("DELETE FROM approvals WHERE run_id = ? AND kind = 'review'")
            .run(UNIT_RUN_ID),
      },
      {
        name: "resume-state relation",
        mutate: (database) =>
          void database
            .prepare("UPDATE runs SET resume_state = 'running' WHERE id = ?")
            .run(UNIT_RUN_ID),
      },
      {
        name: "bounded source text",
        mutate: (database) =>
          void database
            .prepare("UPDATE runs SET task = ? WHERE id = ?")
            .run("x".repeat(8_193), UNIT_RUN_ID),
      },
      {
        name: "passed check exit semantics",
        mutate: (database) =>
          void database
            .prepare(
              "UPDATE runs SET verification_json = json_set(verification_json, '$.checks[0].exitCode', 1) WHERE id = ?",
            )
            .run(UNIT_RUN_ID),
      },
      {
        name: "run-created target",
        mutate: (database) =>
          void database
            .prepare(
              "UPDATE run_events SET payload_json = json_set(payload_json, '$.target', 'forged-target') WHERE run_id = ? AND type = 'run.created'",
            )
            .run(UNIT_RUN_ID),
      },
      {
        name: "approval event actor",
        mutate: (database) =>
          void database
            .prepare(
              "UPDATE run_events SET payload_json = json_set(payload_json, '$.actor', 'forged-actor') WHERE run_id = ? AND type = 'review.accepted'",
            )
            .run(UNIT_RUN_ID),
      },
    ];

    for (const corruption of corruptions) {
      const fixture = completedFixture();
      mutateDatabase(fixture, corruption.mutate);
      expectCode(
        () => readChangeHandoffSource(fixture.databasePath, fixture.runId),
        "HANDOFF_SOURCE_INVALID",
      );
      expect(corruption.name.length).toBeGreaterThan(0);
    }
  });

  it("strictly preflights and shapes verification event JSON before projection", () => {
    const mutations: ReadonlyArray<(database: TestDatabase) => void> = [
      (database) => {
        database
          .prepare(
            "UPDATE run_events SET payload_json = CAST(payload_json AS BLOB) WHERE run_id = ? AND type = 'verification.completed'",
          )
          .run(UNIT_RUN_ID);
      },
      (database) => {
        const persisted = database
          .prepare(
            "SELECT payload_json FROM run_events WHERE run_id = ? AND type = 'verification.completed'",
          )
          .get(UNIT_RUN_ID) as { readonly payload_json: string };
        database
          .prepare(
            "UPDATE run_events SET payload_json = ? WHERE run_id = ? AND type = 'verification.completed'",
          )
          .run(`${persisted.payload_json.slice(0, -1)},"from":"verifying"}`, UNIT_RUN_ID);
      },
      (database) => {
        const persisted = database
          .prepare(
            "SELECT payload_json FROM run_events WHERE run_id = ? AND type = 'verification.completed'",
          )
          .get(UNIT_RUN_ID) as { readonly payload_json: string };
        database
          .prepare(
            "UPDATE run_events SET payload_json = ? WHERE run_id = ? AND type = 'verification.completed'",
          )
          .run(`${persisted.payload_json.slice(0, -1)},"\\u0066rom":"verifying"}`, UNIT_RUN_ID);
      },
      (database) => {
        database
          .prepare(
            "UPDATE run_events SET payload_json = json_set(payload_json, '$.verification.checks', 'not-an-array') WHERE run_id = ? AND type = 'verification.completed'",
          )
          .run(UNIT_RUN_ID);
      },
      (database) => {
        database
          .prepare(
            "UPDATE run_events SET payload_json = json_set(payload_json, '$.verification.checkpointSha256', ?) WHERE run_id = ? AND type = 'verification.completed'",
          )
          .run("0".repeat(64), UNIT_RUN_ID);
      },
      (database) => {
        database
          .prepare(
            "UPDATE run_events SET payload_json = json_set(payload_json, '$.diff', 'same-shape-tamper') WHERE run_id = ? AND type = 'verification.completed'",
          )
          .run(UNIT_RUN_ID);
      },
      (database) => {
        database
          .prepare(
            "UPDATE run_events SET payload_json = json_set(payload_json, '$.verification.checks[0].stdout', 'same-shape-tamper') WHERE run_id = ? AND type = 'verification.completed'",
          )
          .run(UNIT_RUN_ID);
      },
      (database) => {
        database
          .prepare(
            "UPDATE run_events SET payload_json = ? WHERE run_id = ? AND type = 'verification.completed'",
          )
          .run(JSON.stringify("x".repeat(32 * 1024 * 1024)), UNIT_RUN_ID);
      },
    ];

    for (const mutate of mutations) {
      const fixture = completedFixture();
      mutateDatabase(fixture, mutate);
      expectCode(
        () => readChangeHandoffSource(fixture.databasePath, fixture.runId),
        "HANDOFF_SOURCE_INVALID",
      );
    }
  });

  it("revalidates canonical project configuration and context-manifest invariants", () => {
    const projectCorruptions: ReadonlyArray<(database: TestDatabase) => void> = [
      (database) => {
        const persisted = database
          .prepare("SELECT checks_json FROM projects WHERE id = ?")
          .get("00000000-0000-4000-8000-000000000002") as { readonly checks_json: string };
        const checks = JSON.parse(persisted.checks_json) as unknown[];
        database
          .prepare("UPDATE projects SET checks_json = ? WHERE id = ?")
          .run(JSON.stringify([...checks, checks[0]]), "00000000-0000-4000-8000-000000000002");
      },
      (database) => {
        database
          .prepare(
            "UPDATE projects SET sandbox_json = json_set(sandbox_json, '$.image', 'python:latest') WHERE id = ?",
          )
          .run("00000000-0000-4000-8000-000000000002");
      },
      (database) => {
        database
          .prepare(
            "UPDATE projects SET ceiling_json = json_set(ceiling_json, '$.maxOutputTokensPerCall', json_extract(ceiling_json, '$.maxTotalTokens') + 1) WHERE id = ?",
          )
          .run("00000000-0000-4000-8000-000000000002");
      },
    ];

    for (const corrupt of projectCorruptions) {
      const fixture = trackedFixture();
      mutateDatabase(fixture, corrupt);
      expectCode(
        () => readChangeHandoffSource(fixture.databasePath, fixture.runId),
        "HANDOFF_SOURCE_INVALID",
      );
    }

    interface PersistedContext {
      repositoryMap: string[];
      entries: Array<{
        path: string;
        reason: "repository_map" | "root_rules" | "target_rules" | "seed" | "target";
        bytes: number;
        sha256: string;
      }>;
      totalBytes: number;
    }
    const contextCorruptions: ReadonlyArray<(context: PersistedContext) => void> = [
      (context) => {
        context.totalBytes += 1;
      },
      (context) => {
        context.repositoryMap = ["z.ts", "a.ts"];
      },
      (context) => {
        const first = context.entries[0];
        if (first === undefined) throw new Error("Expected a context entry");
        context.entries.push({ ...first });
        context.totalBytes += first.bytes + Buffer.byteLength(first.path, "utf8");
      },
      (context) => {
        const mapPath = "<repository-map>";
        const bytes = UNIT_CEILING.maxContextBytes + 1;
        context.entries = [
          {
            path: mapPath,
            reason: "repository_map",
            bytes,
            sha256: "a".repeat(64),
          },
        ];
        context.totalBytes = bytes + Buffer.byteLength(mapPath, "utf8");
      },
    ];

    for (const corrupt of contextCorruptions) {
      const fixture = completedFixture();
      mutateDatabase(fixture, (database) => {
        const persisted = database
          .prepare("SELECT context_json FROM runs WHERE id = ?")
          .get(UNIT_RUN_ID) as { readonly context_json: string };
        const context = JSON.parse(persisted.context_json) as PersistedContext;
        corrupt(context);
        const encoded = JSON.stringify(context);
        database
          .prepare("UPDATE runs SET context_json = ?, context_sha256 = ? WHERE id = ?")
          .run(encoded, digestJson(context as unknown as JsonValue), UNIT_RUN_ID);
      });
      expectCode(
        () => readChangeHandoffSource(fixture.databasePath, fixture.runId),
        "HANDOFF_SOURCE_INVALID",
      );
    }
  });

  it("binds failed state and plan approval to exact event evidence and order", () => {
    const missingFailure = trackedFixture();
    missingFailure.store.failRun(
      missingFailure.runId,
      "preparing",
      new IcarusError("INTERRUPTED", "Synthetic failure"),
    );
    mutateDatabase(missingFailure, (database) => {
      database
        .prepare(
          "UPDATE run_events SET type = 'base.pinned' WHERE run_id = ? AND type = 'run.failed'",
        )
        .run(UNIT_RUN_ID);
    });
    expectCode(
      () => readChangeHandoffSource(missingFailure.databasePath, missingFailure.runId),
      "HANDOFF_SOURCE_INVALID",
    );

    const mismatchedFailure = trackedFixture();
    mismatchedFailure.store.failRun(
      mismatchedFailure.runId,
      "preparing",
      new IcarusError("INTERRUPTED", "Synthetic failure"),
    );
    mutateDatabase(mismatchedFailure, (database) => {
      database
        .prepare(
          "UPDATE run_events SET payload_json = json_set(payload_json, '$.code', 'FORGED') WHERE run_id = ? AND type = 'run.failed'",
        )
        .run(UNIT_RUN_ID);
    });
    expectCode(
      () => readChangeHandoffSource(mismatchedFailure.databasePath, mismatchedFailure.runId),
      "HANDOFF_SOURCE_INVALID",
    );

    const reorderedPlan = trackedFixture();
    prepareChangeRoomRun(reorderedPlan.store);
    approveChangeRoomPlan(reorderedPlan.store);
    mutateDatabase(reorderedPlan, (database) => {
      const created = database
        .prepare("SELECT sequence FROM run_events WHERE run_id = ? AND type = 'plan.created'")
        .get(UNIT_RUN_ID) as { readonly sequence: number };
      const approved = database
        .prepare("SELECT sequence FROM run_events WHERE run_id = ? AND type = 'plan.approved'")
        .get(UNIT_RUN_ID) as { readonly sequence: number };
      database
        .prepare(
          "UPDATE run_events SET sequence = 10000 WHERE run_id = ? AND type = 'plan.created'",
        )
        .run(UNIT_RUN_ID);
      database
        .prepare("UPDATE run_events SET sequence = ? WHERE run_id = ? AND type = 'plan.approved'")
        .run(created.sequence, UNIT_RUN_ID);
      database
        .prepare("UPDATE run_events SET sequence = ? WHERE run_id = ? AND type = 'plan.created'")
        .run(approved.sequence, UNIT_RUN_ID);
    });
    expectCode(
      () => readChangeHandoffSource(reorderedPlan.databasePath, reorderedPlan.runId),
      "HANDOFF_SOURCE_INVALID",
    );

    const mismatchedReadableCount = trackedFixture();
    prepareChangeRoomRun(mismatchedReadableCount.store);
    approveChangeRoomPlan(mismatchedReadableCount.store);
    mutateDatabase(mismatchedReadableCount, (database) => {
      database
        .prepare(
          "UPDATE run_events SET payload_json = json_set(payload_json, '$.readableFiles', 1) WHERE run_id = ? AND type = 'plan.created'",
        )
        .run(UNIT_RUN_ID);
    });
    expectCode(
      () =>
        readChangeHandoffSource(
          mismatchedReadableCount.databasePath,
          mismatchedReadableCount.runId,
        ),
      "HANDOFF_SOURCE_INVALID",
    );
  });

  it("rejects impossible transition replay, duplicate review, stale resume, and intent evidence", () => {
    const verificationEndpoint = trackedFixture();
    prepareChangeRoomRun(verificationEndpoint.store);
    approveChangeRoomPlan(verificationEndpoint.store);
    finishToAwaitingReview(verificationEndpoint.store, "passed");
    mutateDatabase(verificationEndpoint, (database) => {
      database
        .prepare(
          "UPDATE run_events SET payload_json = json_set(payload_json, '$.to', 'running') WHERE run_id = ? AND type = 'verification.completed'",
        )
        .run(UNIT_RUN_ID);
    });
    expectCode(
      () => readChangeHandoffSource(verificationEndpoint.databasePath, verificationEndpoint.runId),
      "HANDOFF_SOURCE_INVALID",
    );

    const wrongCancellationOrigin = trackedFixture();
    wrongCancellationOrigin.store.transition(
      wrongCancellationOrigin.runId,
      "cancelling",
      "cancellation.requested",
      { actor: "unit-operator" },
    );
    wrongCancellationOrigin.store.finishCancellation(wrongCancellationOrigin.runId);
    mutateDatabase(wrongCancellationOrigin, (database) => {
      database
        .prepare(
          "UPDATE run_events SET payload_json = json_set(payload_json, '$.from', 'running') WHERE run_id = ? AND type = 'cancellation.requested'",
        )
        .run(UNIT_RUN_ID);
    });
    expectCode(
      () =>
        readChangeHandoffSource(
          wrongCancellationOrigin.databasePath,
          wrongCancellationOrigin.runId,
        ),
      "HANDOFF_SOURCE_INVALID",
    );

    const staleResume = trackedFixture();
    prepareChangeRoomRun(staleResume.store);
    staleResume.store.failRun(
      staleResume.runId,
      "planned",
      new IcarusError("FIRST_FAILURE", "First synthetic failure"),
    );
    staleResume.store.failRun(
      staleResume.runId,
      "planned",
      new IcarusError("SECOND_FAILURE", "Second synthetic failure"),
    );
    staleResume.store.resumeFailed(staleResume.runId);
    mutateDatabase(staleResume, (database) => {
      database
        .prepare(
          "UPDATE run_events SET payload_json = json_set(payload_json, '$.resumeState', 'preparing') WHERE run_id = ? AND type = 'run.failed' AND sequence = (SELECT MAX(sequence) FROM run_events WHERE run_id = ? AND type = 'run.failed')",
        )
        .run(UNIT_RUN_ID, UNIT_RUN_ID);
    });
    expectCode(
      () => readChangeHandoffSource(staleResume.databasePath, staleResume.runId),
      "HANDOFF_SOURCE_INVALID",
    );

    const duplicateReview = completedFixture();
    mutateDatabase(duplicateReview, (database) => {
      const createdAt = "2026-08-01T12:00:00.000Z";
      database
        .prepare(
          "INSERT INTO approvals (id, run_id, kind, digest, actor, decision, created_at) SELECT ?, run_id, kind, digest, ?, decision, ? FROM approvals WHERE run_id = ? AND kind = 'review'",
        )
        .run(
          "ffffffff-ffff-4fff-8fff-ffffffffffff",
          "duplicate-review-actor",
          createdAt,
          UNIT_RUN_ID,
        );
      database
        .prepare(
          "INSERT INTO run_events (run_id, sequence, type, payload_json, created_at) SELECT run_id, (SELECT MAX(sequence) + 1 FROM run_events WHERE run_id = ?), type, json_set(payload_json, '$.actor', ?), ? FROM run_events WHERE run_id = ? AND type = 'review.accepted'",
        )
        .run(UNIT_RUN_ID, "duplicate-review-actor", createdAt, UNIT_RUN_ID);
    });
    expectCode(
      () => readChangeHandoffSource(duplicateReview.databasePath, duplicateReview.runId),
      "HANDOFF_SOURCE_INVALID",
    );

    const mismatchedIntent = completedFixture();
    mutateDatabase(mismatchedIntent, (database) => {
      database
        .prepare(
          "UPDATE run_events SET payload_json = json_set(payload_json, '$.operations', json('[\"delete\"]')) WHERE run_id = ? AND type = 'patch_set.intent_recorded'",
        )
        .run(UNIT_RUN_ID);
    });
    expectCode(
      () => readChangeHandoffSource(mismatchedIntent.databasePath, mismatchedIntent.runId),
      "HANDOFF_SOURCE_INVALID",
    );
  });

  it("rejects contradictory SQLite headers and cancellation completion without a prior request", () => {
    const mixedHeader = completedFixture();
    const image = readFileSync(mixedHeader.databasePath);
    image[18] = 1;
    image[19] = 2;
    writeFileSync(mixedHeader.databasePath, image);
    expectCode(
      () => readChangeHandoffSource(mixedHeader.databasePath, mixedHeader.runId),
      "HANDOFF_SOURCE_INVALID",
    );

    const cancelled = trackedFixture();
    cancelled.store.transition(cancelled.runId, "cancelling", "cancellation.requested", {
      actor: "unit-operator",
    });
    cancelled.store.finishCancellation(cancelled.runId);
    mutateDatabase(cancelled, (database) => {
      database
        .prepare(
          "UPDATE run_events SET type = 'base.pinned' WHERE run_id = ? AND type = 'cancellation.requested'",
        )
        .run(UNIT_RUN_ID);
    });
    expectCode(
      () => readChangeHandoffSource(cancelled.databasePath, cancelled.runId),
      "HANDOFF_SOURCE_INVALID",
    );
  });

  it("rejects missing recovery evidence, active operations, invalid IDs, and unsafe database families", () => {
    const rolledBack = trackedFixture();
    driveToRolledBack(rolledBack.store);
    mutateDatabase(rolledBack, (database) => {
      database
        .prepare("DELETE FROM run_events WHERE run_id = ? AND type = 'rollback.completed'")
        .run(UNIT_RUN_ID);
    });
    expectCode(
      () => readChangeHandoffSource(rolledBack.databasePath, rolledBack.runId),
      "HANDOFF_SOURCE_INVALID",
    );

    const busy = trackedFixture();
    busy.store.beginOperation(busy.runId, "handoff-test-operation", 0, 0, 1_000);
    closeFixture(busy);
    expectCode(() => readChangeHandoffSource(busy.databasePath, busy.runId), "RUN_BUSY");

    const missing = trackedFixture();
    closeFixture(missing);
    expectCode(
      () => readChangeHandoffSource(missing.databasePath, "not-a-run-id"),
      "INVALID_RUN_ID",
    );
    expectCode(
      () => readChangeHandoffSource(missing.databasePath, "ffffffff-ffff-4fff-8fff-ffffffffffff"),
      "RUN_NOT_FOUND",
    );

    const unexpectedFamily = completedFixture();
    closeFixture(unexpectedFamily);
    writeFileSync(`${unexpectedFamily.databasePath}-journal`, "unexpected", { mode: 0o600 });
    expectCode(
      () => readChangeHandoffSource(unexpectedFamily.databasePath, unexpectedFamily.runId),
      "HANDOFF_SOURCE_INVALID",
    );
  });

  it("accepts repeated rollback and restoration cycles while reporting the latest cycle", () => {
    const fixture = trackedFixture();
    const first = driveToRolledBack(fixture.store);
    fixture.store.approveRestore(fixture.runId, first.checkpointSha256, "unit-operator");
    fixture.store.finishRestore(fixture.runId);
    const restored = fixture.store.getRun(fixture.runId);
    if (restored.diff === null || restored.verification === null) {
      throw new Error("Expected restored verification evidence");
    }
    fixture.store.recordVerificationAndAwaitReview(
      fixture.runId,
      restored.diff,
      restored.verification,
    );
    fixture.store.decideReview(
      fixture.runId,
      restored.verification.diffSha256,
      "unit-operator",
      "reject",
    );
    fixture.store.finishRollback(fixture.runId);
    closeFixture(fixture);

    const source = readChangeHandoffSource(fixture.databasePath, fixture.runId);
    const preview = buildChangeHandoffPreview(source, { correlationId: "repeated-recovery" });
    expect(source.events).toMatchObject({
      rollbackCompletedCount: 2,
      restoreCompletedCount: 1,
    });
    expect(preview.payload.lifecycle).toMatchObject({
      rollback: "completed",
      restoration: "not_started",
    });
    expect(() => decodeChangeHandoffPayloadBytes(preview.payloadBytes)).not.toThrow();
  });

  it("suppresses historical verification and review after restoration until a fresh attempt", () => {
    const fixture = trackedFixture();
    const evidence = driveToRolledBack(fixture.store);
    fixture.store.approveRestore(fixture.runId, evidence.checkpointSha256, "unit-operator");
    fixture.store.finishRestore(fixture.runId);
    closeFixture(fixture);

    const source = readChangeHandoffSource(fixture.databasePath, fixture.runId);
    expect(source).toMatchObject({
      state: "verifying",
      verification: null,
      reviewDecision: null,
      interruptedRecovery: null,
      events: {
        rollbackCompletedCount: 1,
        restoreCompletedCount: 1,
      },
    });
    const preview = buildChangeHandoffPreview(source, {
      correlationId: "post-restore-verification-gap",
    });
    expect(preview.payload.lifecycle).toMatchObject({
      verification: "not_run",
      review: "not_reached",
      rollback: "completed",
      restoration: "completed",
    });
    expect(preview.payload.artifactReferences.map((artifact) => artifact.type)).not.toContain(
      "verified_diff",
    );
    expect(() => decodeChangeHandoffPayloadBytes(preview.payloadBytes)).not.toThrow();
  });

  it("does not replay a historical same-digest review onto a fresh verification attempt", () => {
    const fixture = trackedFixture();
    prepareChangeRoomRun(fixture.store);
    const run = fixture.store.getRun(fixture.runId);
    const project = fixture.store.getProject(run.projectId);
    const repairPlan = { ...UNIT_PLAN, iterationCeiling: 1 };
    const planSha256 = planApprovalDigest({
      task: run.task,
      baseCommit: run.baseCommit,
      contextSha256: run.contextSha256,
      targets: run.context.targets,
      provider: run.provider,
      checks: project.checks,
      sandbox: project.sandbox,
      ceiling: project.ceiling,
      plan: repairPlan,
      readableManifest: null,
    });
    fixture.store.recordPlanAndAwaitApproval(fixture.runId, repairPlan, planSha256);
    fixture.store.approvePlan(fixture.runId, planSha256, "unit-operator");
    const evidence = finishToAwaitingReview(fixture.store, "passed");
    fixture.store.decideReview(fixture.runId, evidence.diffSha256, "unit-operator", "reject");
    fixture.store.finishRollback(fixture.runId);
    fixture.store.approveRestore(fixture.runId, evidence.checkpointSha256, "unit-operator");
    fixture.store.finishRestore(fixture.runId);
    const restored = fixture.store.getRun(fixture.runId);
    if (restored.diff === null || restored.verification === null) {
      throw new Error("Expected restored verification evidence");
    }
    fixture.store.recordVerificationAndAwaitReview(
      fixture.runId,
      restored.diff,
      {
        ...restored.verification,
        outcome: "failed",
        checks: restored.verification.checks.map((check) => ({
          ...check,
          exitCode: 1,
          signal: null,
          stdout: "",
          stderr: "fresh failure\n",
          outcome: "failed",
        })),
      },
      "verifying",
    );
    closeFixture(fixture);

    const source = readChangeHandoffSource(fixture.databasePath, fixture.runId);
    expect(source).toMatchObject({
      state: "verifying",
      verification: { outcome: "failed", diffSha256: evidence.diffSha256 },
      reviewDecision: null,
    });
    const preview = buildChangeHandoffPreview(source, {
      correlationId: "same-digest-fresh-attempt",
    });
    expect(preview.payload.lifecycle).toMatchObject({
      verification: "failed",
      review: "not_decided",
      rollback: "completed",
      restoration: "completed",
    });
    expect(() => decodeChangeHandoffPayloadBytes(preview.payloadBytes)).not.toThrow();
  });

  it.each(["failed", "cancelling", "cancelled"] as const)(
    "preserves the post-restore verification gap in %s",
    (targetState) => {
      const fixture = trackedFixture();
      const evidence = driveToRolledBack(fixture.store);
      fixture.store.approveRestore(fixture.runId, evidence.checkpointSha256, "unit-operator");
      fixture.store.finishRestore(fixture.runId);
      if (targetState === "failed" || targetState === "cancelled") {
        fixture.store.failRun(
          fixture.runId,
          "verifying",
          new IcarusError("INTERRUPTED", "Synthetic verification interruption"),
        );
      }
      if (targetState === "cancelling" || targetState === "cancelled") {
        fixture.store.transition(fixture.runId, "cancelling", "cancellation.requested", {
          actor: "unit-operator",
        });
      }
      if (targetState === "cancelled") fixture.store.finishCancellation(fixture.runId);
      closeFixture(fixture);

      const source = readChangeHandoffSource(fixture.databasePath, fixture.runId);
      const preview = buildChangeHandoffPreview(source, {
        correlationId: `post-restore-${targetState}`,
      });
      expect(source).toMatchObject({
        state: targetState,
        verification: null,
        reviewDecision: null,
        interruptedRecovery: null,
      });
      expect(preview.payload.lifecycle).toMatchObject({
        verification: "not_run",
        review: "not_reached",
        rollback: "completed",
        restoration: "completed",
        terminalReason:
          targetState === "failed" ? "failed" : targetState === "cancelled" ? "cancelled" : null,
      });
      expect(() => decodeChangeHandoffPayloadBytes(preview.payloadBytes)).not.toThrow();
    },
  );

  it.each([
    ["rolling_back", false],
    ["rolling_back", true],
    ["restoring", false],
    ["restoring", true],
  ] as const)(
    "reports interrupted %s recovery truthfully when cancellation completed=%s",
    (resumeState, completeCancellation) => {
      const fixture = trackedFixture();
      const evidence = driveToCompleted(fixture.store);
      fixture.store.approveRollback(fixture.runId, evidence.diffSha256, "unit-operator");
      if (resumeState === "restoring") {
        fixture.store.finishRollback(fixture.runId);
        fixture.store.approveRestore(fixture.runId, evidence.checkpointSha256, "unit-operator");
      }
      fixture.store.failRun(
        fixture.runId,
        resumeState,
        new IcarusError("INTERRUPTED", "Synthetic recovery interruption"),
      );
      fixture.store.transition(fixture.runId, "cancelling", "cancellation.requested", {
        actor: "unit-operator",
      });
      if (completeCancellation) fixture.store.finishCancellation(fixture.runId);
      closeFixture(fixture);

      const source = readChangeHandoffSource(fixture.databasePath, fixture.runId);
      const preview = buildChangeHandoffPreview(source, {
        correlationId: `cancel-${resumeState}-${completeCancellation}`,
      });
      expect(source.interruptedRecovery).toBe(resumeState);
      expect(preview.payload.run.state).toBe(completeCancellation ? "cancelled" : "cancelling");
      expect(preview.payload.lifecycle).toMatchObject({
        verification: "passed",
        review: "approved",
        rollback: resumeState === "rolling_back" ? "interrupted" : "completed",
        restoration: resumeState === "restoring" ? "interrupted" : "not_started",
        terminalReason: completeCancellation ? "cancelled" : null,
      });
      expect(() => decodeChangeHandoffPayloadBytes(preview.payloadBytes)).not.toThrow();
    },
  );

  it("scopes verification and recovery status to the current superseded repair revision", () => {
    const fixture = trackedFixture();
    prepareChangeRoomRun(fixture.store);
    const repairPlan = { ...UNIT_PLAN, iterationCeiling: 1 };
    const run = fixture.store.getRun(fixture.runId);
    const project = fixture.store.getProject(run.projectId);
    const planSha256 = planApprovalDigest({
      task: run.task,
      baseCommit: run.baseCommit,
      contextSha256: run.contextSha256,
      targets: run.context.targets,
      provider: run.provider,
      checks: project.checks,
      sandbox: project.sandbox,
      ceiling: project.ceiling,
      plan: repairPlan,
      readableManifest: null,
    });
    fixture.store.recordPlanAndAwaitApproval(fixture.runId, repairPlan, planSha256);
    fixture.store.approvePlan(fixture.runId, planSha256, "unit-operator");

    const evidence = finishToAwaitingReview(fixture.store, "passed");
    fixture.store.decideReview(fixture.runId, evidence.diffSha256, "unit-operator", "reject");
    fixture.store.finishRollback(fixture.runId);
    fixture.store.approveRestore(fixture.runId, evidence.checkpointSha256, "unit-operator");
    fixture.store.finishRestore(fixture.runId);

    const restored = fixture.store.getRun(fixture.runId);
    if (restored.diff === null || restored.verification === null) {
      throw new Error("Expected restored verification evidence");
    }
    fixture.store.recordVerificationAndAwaitReview(
      fixture.runId,
      restored.diff,
      {
        ...restored.verification,
        outcome: "failed",
        checks: restored.verification.checks.map((check) => ({
          ...check,
          exitCode: 1,
          signal: null,
          stdout: "",
          stderr: "repair required\n",
          outcome: "failed",
        })),
      },
      "verifying",
    );
    fixture.store.beginSessionIteration(fixture.runId);
    chargeRepairIteration(fixture.store);
    const current = fixture.store.getRun(fixture.runId);
    if (current.patchSet === null) throw new Error("Expected a patch set");
    fixture.store.beginOperation(
      fixture.runId,
      "session.tool.mutation.patchset",
      0,
      0,
      1_000,
      "running",
    );
    fixture.store.recordPatchSetIntent(
      fixture.runId,
      current.patchSet,
      fixture.store.listCheckpointFiles(fixture.runId),
    );
    fixture.store.markStartedOperationsInterrupted(fixture.runId);
    closeFixture(fixture);

    const source = readChangeHandoffSource(fixture.databasePath, fixture.runId);
    expect(source).toMatchObject({
      state: "running",
      verification: null,
      checkpointSha256: null,
      events: {
        rollbackCompletedCount: 0,
        rollbackCompletedSequence: null,
        restoreCompletedCount: 0,
        restoreCompletedSequence: null,
      },
    });
    const documents = validDocuments(fixture);
    expect(documents.preview.payload.lifecycle).toMatchObject({
      verification: "not_run",
      rollback: "not_started",
      restoration: "not_started",
    });
    expect(() =>
      verifyChangeHandoffDocuments(documents.preview.payloadBytes, documents.resultBytes),
    ).not.toThrow();
  });

  it("rejects symlinked, hard-linked, and over-permissive source databases", () => {
    const linked = completedFixture();
    closeFixture(linked);
    const alias = path.join(path.dirname(linked.databasePath), "database-alias.sqlite3");
    symlinkSync(linked.databasePath, alias);
    expectCode(() => readChangeHandoffSource(alias, linked.runId), "HANDOFF_SOURCE_INVALID");

    const ancestorAlias = path.join(linked.root, "database-parent-alias");
    symlinkSync(path.dirname(linked.databasePath), ancestorAlias, "dir");
    expectCode(
      () =>
        readChangeHandoffSource(
          path.join(ancestorAlias, path.basename(linked.databasePath)),
          linked.runId,
        ),
      "HANDOFF_SOURCE_INVALID",
    );

    const hardLinked = completedFixture();
    closeFixture(hardLinked);
    linkSync(
      hardLinked.databasePath,
      path.join(path.dirname(hardLinked.databasePath), "database-hardlink.sqlite3"),
    );
    expectCode(
      () => readChangeHandoffSource(hardLinked.databasePath, hardLinked.runId),
      "HANDOFF_SOURCE_INVALID",
    );

    const permissive = completedFixture();
    closeFixture(permissive);
    chmodSync(permissive.databasePath, 0o622);
    expectCode(
      () => readChangeHandoffSource(permissive.databasePath, permissive.runId),
      "HANDOFF_SOURCE_INVALID",
    );
  });
});

describe("Change Handoff export files", () => {
  it("creates only fixed owner-private files and binds the newline-inclusive payload hash", () => {
    const fixture = completedFixture();
    const documents = validDocuments(fixture);
    const outputDirectory = path.join(fixture.root, "handoff-output");

    writeChangeHandoffFiles(outputDirectory, documents.preview.payloadBytes, documents.resultBytes);

    const payloadPath = path.join(outputDirectory, CHANGE_HANDOFF_FILENAME);
    const resultPath = path.join(outputDirectory, CHANGE_HANDOFF_RESULT_FILENAME);
    expect(readdirSync(outputDirectory).sort()).toEqual(
      [CHANGE_HANDOFF_FILENAME, CHANGE_HANDOFF_RESULT_FILENAME].sort(),
    );
    expect(lstatSync(outputDirectory).mode & 0o777).toBe(0o700);
    expect(lstatSync(payloadPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(resultPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(payloadPath).equals(documents.preview.payloadBytes)).toBe(true);
    expect(readFileSync(resultPath).equals(documents.resultBytes)).toBe(true);

    const decodedResult = decodeChangeHandoffExportResultBytes(readFileSync(resultPath));
    expect(decodedResult).toEqual({
      exportStatus: "exported",
      previewSha256: documents.preview.previewSha256,
      outputSchema: CHANGE_HANDOFF_SCHEMA,
      payloadSha256: sha256(readFileSync(payloadPath)),
    });
    expect(decodedResult.payloadSha256).not.toBe(
      sha256(documents.preview.payloadBytes.subarray(0, -1)),
    );
  });

  it("never overwrites either destination and removes only its own partial payload", () => {
    const fixture = completedFixture();
    const documents = validDocuments(fixture);
    const complete = path.join(fixture.root, "complete-output");
    writeChangeHandoffFiles(complete, documents.preview.payloadBytes, documents.resultBytes);
    const completePayload = path.join(complete, CHANGE_HANDOFF_FILENAME);
    const completeResult = path.join(complete, CHANGE_HANDOFF_RESULT_FILENAME);
    const beforePayload = readFileSync(completePayload);
    const beforeResult = readFileSync(completeResult);

    expectCode(
      () => writeChangeHandoffFiles(complete, Buffer.from("replacement"), Buffer.from("result")),
      "HANDOFF_EXPORT_EXISTS",
    );
    expect(readFileSync(completePayload).equals(beforePayload)).toBe(true);
    expect(readFileSync(completeResult).equals(beforeResult)).toBe(true);

    const payloadOnly = path.join(fixture.root, "payload-only-output");
    mkdirSync(payloadOnly, { mode: 0o700 });
    const preexistingPayload = path.join(payloadOnly, CHANGE_HANDOFF_FILENAME);
    writeFileSync(preexistingPayload, "preexisting-payload-canary", { mode: 0o600 });
    expectCode(
      () =>
        writeChangeHandoffFiles(payloadOnly, documents.preview.payloadBytes, documents.resultBytes),
      "HANDOFF_EXPORT_EXISTS",
    );
    expect(readFileSync(preexistingPayload, "utf8")).toBe("preexisting-payload-canary");
    expect(existsSync(path.join(payloadOnly, CHANGE_HANDOFF_RESULT_FILENAME))).toBe(false);

    const partial = path.join(fixture.root, "partial-output");
    mkdirSync(partial, { mode: 0o700 });
    const preexistingResult = path.join(partial, CHANGE_HANDOFF_RESULT_FILENAME);
    writeFileSync(preexistingResult, "preexisting-result-canary", { mode: 0o600 });
    expectCode(
      () => writeChangeHandoffFiles(partial, documents.preview.payloadBytes, documents.resultBytes),
      "HANDOFF_EXPORT_EXISTS",
    );
    expect(existsSync(path.join(partial, CHANGE_HANDOFF_FILENAME))).toBe(false);
    expect(readFileSync(preexistingResult, "utf8")).toBe("preexisting-result-canary");
    expect(readdirSync(partial)).toEqual([CHANGE_HANDOFF_RESULT_FILENAME]);
  });

  it("rejects permissive and symlinked output directories without publishing files", () => {
    const fixture = completedFixture();
    const documents = validDocuments(fixture);
    const permissive = path.join(fixture.root, "permissive-output");
    mkdirSync(permissive, { mode: 0o755 });
    expectCode(
      () =>
        writeChangeHandoffFiles(permissive, documents.preview.payloadBytes, documents.resultBytes),
      "HANDOFF_EXPORT_UNSAFE",
    );
    expect(readdirSync(permissive)).toEqual([]);

    const real = path.join(fixture.root, "real-output");
    const alias = path.join(fixture.root, "output-alias");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, alias);
    expectCode(
      () => writeChangeHandoffFiles(alias, documents.preview.payloadBytes, documents.resultBytes),
      "HANDOFF_EXPORT_UNSAFE",
    );
    expect(readdirSync(real)).toEqual([]);

    const ancestorReal = path.join(fixture.root, "real-parent");
    const ancestorAlias = path.join(fixture.root, "parent-alias");
    mkdirSync(ancestorReal, { mode: 0o700 });
    symlinkSync(ancestorReal, ancestorAlias, "dir");
    expectCode(
      () =>
        writeChangeHandoffFiles(
          path.join(ancestorAlias, "nested-output"),
          documents.preview.payloadBytes,
          documents.resultBytes,
        ),
      "HANDOFF_EXPORT_UNSAFE",
    );
    expect(existsSync(path.join(ancestorReal, "nested-output"))).toBe(false);

    const writableParent = path.join(fixture.root, "writable-parent");
    const beneathWritableParent = path.join(writableParent, "handoff-output");
    mkdirSync(writableParent, { mode: 0o700 });
    chmodSync(writableParent, 0o777);
    expectCode(
      () =>
        writeChangeHandoffFiles(
          beneathWritableParent,
          documents.preview.payloadBytes,
          documents.resultBytes,
        ),
      "HANDOFF_EXPORT_UNSAFE",
    );
    expect(existsSync(beneathWritableParent)).toBe(false);
  });
});

describe("Change Handoff strict file verification", () => {
  it("rejects malformed, duplicate, deep, oversized, BOM, NUL, invalid UTF-8, and noncanonical payloads", () => {
    const fixture = completedFixture();
    const { preview } = validDocuments(fixture);
    const nul = Buffer.from(preview.payloadBytes);
    nul[1] = 0;
    const oversized = Buffer.alloc(CHANGE_HANDOFF_MAX_BYTES + 1, 0x20);
    oversized[oversized.length - 1] = 0x0a;
    const hostileDocuments = [
      Buffer.from("{]\n"),
      Buffer.from('{"schema":1,"\\u0073chema":2}\n'),
      Buffer.from(`${'{"nested":'.repeat(9)}null${"}".repeat(9)}\n`),
      oversized,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), preview.payloadBytes]),
      nul,
      Buffer.from([0xc3, 0x28, 0x0a]),
      Buffer.from(`${JSON.stringify(preview.payload, null, 2)}\n`, "utf8"),
      Buffer.concat([preview.payloadBytes, Buffer.from("\n")]),
    ];

    for (const bytes of hostileDocuments) {
      expectCode(() => decodeChangeHandoffPayloadBytes(bytes), "INVALID_HANDOFF_FILE");
    }

    const unknown = JSON.parse(preview.payloadBytes.toString("utf8")) as Record<string, unknown>;
    unknown.privateCanary = "must-not-be-echoed";
    expectCode(
      () => decodeChangeHandoffPayloadBytes(canonicalJsonLine(unknown)),
      "INVALID_HANDOFF",
    );
  });

  it("enforces exact result shape, canonical bytes, and the payload hash relationship", () => {
    const fixture = completedFixture();
    const { preview, resultBytes } = validDocuments(fixture);
    const verification = verifyChangeHandoffDocuments(preview.payloadBytes, resultBytes);

    expect(verification).toEqual({
      schema: CHANGE_HANDOFF_SCHEMA,
      payloadSha256: preview.payloadSha256,
      previewSha256: preview.previewSha256,
      exportStatus: "exported",
      consistency: "internally_consistent",
      authenticity: "not_established",
      authorization: "not_established",
      semanticTruth: "not_established",
      disclosurePermission: "not_established",
      executionAuthority: "none",
    });

    const mismatchedResult = encodeChangeHandoffExportResult({
      ...createChangeHandoffExportResult(preview),
      payloadSha256: "f".repeat(64),
    });
    expectCode(
      () => verifyChangeHandoffDocuments(preview.payloadBytes, mismatchedResult),
      "HANDOFF_DIGEST_MISMATCH",
    );

    const substitutedResult = encodeChangeHandoffExportResult({
      ...createChangeHandoffExportResult(preview),
      previewSha256: preview.payloadSha256,
    });
    expectCode(
      () => verifyChangeHandoffDocuments(preview.payloadBytes, substitutedResult),
      "HANDOFF_DIGEST_MISMATCH",
    );
    const decoded = JSON.parse(resultBytes.toString("utf8")) as Record<string, unknown>;
    decoded.privateCanary = true;
    expectCode(
      () => decodeChangeHandoffExportResultBytes(canonicalJsonLine(decoded)),
      "INVALID_HANDOFF",
    );
    expectCode(
      () =>
        decodeChangeHandoffExportResultBytes(
          Buffer.from(`${JSON.stringify(createChangeHandoffExportResult(preview), null, 2)}\n`),
        ),
      "INVALID_HANDOFF_FILE",
    );
  });

  it("rejects symlinked, hard-linked, executable, permissive, and non-file inputs", () => {
    const fixture = completedFixture();
    const { preview } = validDocuments(fixture);
    const directory = path.join(fixture.root, "hostile-inputs");
    mkdirSync(directory, { mode: 0o700 });

    const ordinary = path.join(directory, "ordinary.json");
    writeFileSync(ordinary, preview.payloadBytes, { mode: 0o600 });
    expect(readSecureHandoffFile(ordinary, CHANGE_HANDOFF_MAX_BYTES).sha256).toBe(
      preview.payloadSha256,
    );

    const oversized = path.join(directory, "oversized.json");
    writeFileSync(oversized, Buffer.alloc(CHANGE_HANDOFF_MAX_BYTES + 1, 0x20), { mode: 0o600 });
    expectCode(
      () => readSecureHandoffFile(oversized, CHANGE_HANDOFF_MAX_BYTES),
      "HANDOFF_FILE_TOO_LARGE",
    );

    const symbolic = path.join(directory, "symbolic.json");
    symlinkSync(ordinary, symbolic);
    expectCode(
      () => readSecureHandoffFile(symbolic, CHANGE_HANDOFF_MAX_BYTES),
      "HANDOFF_FILE_UNSAFE",
    );

    const hardlinkSource = path.join(directory, "hardlink-source.json");
    const hardlink = path.join(directory, "hardlink.json");
    writeFileSync(hardlinkSource, preview.payloadBytes, { mode: 0o600 });
    linkSync(hardlinkSource, hardlink);
    expectCode(
      () => readSecureHandoffFile(hardlink, CHANGE_HANDOFF_MAX_BYTES),
      "HANDOFF_FILE_UNSAFE",
    );

    const permissive = path.join(directory, "permissive.json");
    writeFileSync(permissive, preview.payloadBytes, { mode: 0o644 });
    expectCode(
      () => readSecureHandoffFile(permissive, CHANGE_HANDOFF_MAX_BYTES),
      "HANDOFF_FILE_UNSAFE",
    );

    const executable = path.join(directory, "executable.json");
    writeFileSync(executable, preview.payloadBytes, { mode: 0o700 });
    expectCode(
      () => readSecureHandoffFile(executable, CHANGE_HANDOFF_MAX_BYTES),
      "HANDOFF_FILE_UNSAFE",
    );

    const notAFile = path.join(directory, "directory.json");
    mkdirSync(notAFile, { mode: 0o700 });
    expectCode(
      () => readSecureHandoffFile(notAFile, CHANGE_HANDOFF_MAX_BYTES),
      "HANDOFF_FILE_UNSAFE",
    );

    const realAncestor = path.join(fixture.root, "real-input-parent");
    const ancestorAlias = path.join(fixture.root, "input-parent-alias");
    mkdirSync(realAncestor, { mode: 0o700 });
    const beneathAncestor = path.join(realAncestor, "handoff.json");
    writeFileSync(beneathAncestor, preview.payloadBytes, { mode: 0o600 });
    symlinkSync(realAncestor, ancestorAlias, "dir");
    expectCode(
      () =>
        readSecureHandoffFile(path.join(ancestorAlias, "handoff.json"), CHANGE_HANDOFF_MAX_BYTES),
      "HANDOFF_FILE_UNSAFE",
    );
    expectCode(
      () => readSecureHandoffFile("/dev/null", CHANGE_HANDOFF_MAX_BYTES),
      "HANDOFF_FILE_UNSAFE",
    );
  });
});

describe("Change Handoff secure-platform preflight", () => {
  it.each(["darwin", "win32"] as const)(
    "fails closed on %s before touching protected paths",
    (platform) => {
      const fixture = trackedFixture();
      closeFixture(fixture);
      const missingInput = path.join(fixture.root, "missing-handoff.json");
      const outputDirectory = path.join(fixture.root, "must-not-be-created");

      withPlatform(platform, () => {
        expectCode(
          () => readSecureHandoffFile(missingInput, CHANGE_HANDOFF_MAX_BYTES),
          "HANDOFF_FILE_UNSUPPORTED",
        );
        expectCode(
          () => readChangeHandoffSource(fixture.databasePath, fixture.runId),
          "HANDOFF_SOURCE_UNSUPPORTED",
        );
        expectCode(
          () => writeChangeHandoffFiles(outputDirectory, Buffer.from("{}\n"), Buffer.from("{}\n")),
          "HANDOFF_EXPORT_UNSUPPORTED",
        );
      });

      expect(existsSync(missingInput)).toBe(false);
      expect(existsSync(outputDirectory)).toBe(false);
    },
  );
});
