import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http, { type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ArtifactStore } from "../../packages/core/src/artifacts.js";
import { sha256 } from "../../packages/core/src/digest.js";
import type { GitController } from "../../packages/core/src/git.js";
import {
  type LandingCandidateResult,
  LandingGitController,
} from "../../packages/core/src/landing-git.js";
import { canonicalLandingJson, gitObjectSha1 } from "../../packages/core/src/landing-records.js";
import { planApprovalDigest, treeCheckpointDigest } from "../../packages/core/src/policy.js";
import type { CheckRunner } from "../../packages/core/src/sandbox.js";
import {
  IcarusService,
  type LandingGitService,
  type LandingGithubGateway,
} from "../../packages/core/src/service.js";
import { IcarusStore } from "../../packages/core/src/store.js";
import type {
  CheckpointFile,
  PatchSet,
  VerificationEvidence,
} from "../../packages/core/src/types.js";
import { GithubGateway } from "../../packages/github-gateway/src/gateway.js";
import { repositoryFingerprint } from "../support/integration-cli.js";
import {
  type CapturedProviderRequest,
  type ProviderHttpServer,
  parseProviderRequestBody,
  sendProviderJson,
  startProviderHttpServer,
} from "../support/provider-http.js";
import {
  seedUnitProject,
  UNIT_BASE_COMMIT,
  UNIT_PLAN,
  UNIT_PROVIDER,
  unitContextDigest,
  unitContextManifest,
} from "../support/unit-fixtures.js";

interface TestDatabase {
  prepare(sql: string): {
    run(...parameters: unknown[]): { readonly changes: number };
  };
  close(): void;
}

const Database = createRequire(new URL("../../packages/core/package.json", import.meta.url))(
  "better-sqlite3",
) as new (
  filename: string,
) => TestDatabase;

const WORKER_TEST = "__adr_0027_real_landing_crash_worker__";
const PHASE_ENV = "ICARUS_LANDING_CRASH_PHASE";
const ROOT_ENV = "ICARUS_LANDING_CRASH_ROOT";
const MARKER_ENV = "ICARUS_LANDING_CRASH_MARKER";
const RESULT_ENV = "ICARUS_LANDING_CRASH_RESULT";
const NOW = "2026-07-19T12:00:00.000Z";
const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REVIEW_ID = "11111111-1111-4111-8111-111111111111";
const BASE_TREE_SHA1 = "1".repeat(40);
const CREDENTIAL_ENV = "ICARUS_GITHUB_TOKEN_CRASH";
const OPERATOR = "crash-test-operator";
const ZERO_SHA1 = "0".repeat(40);

enum CrashPhase {
  BeforeLandingRow = "before-landing-row",
  AfterCandidateIntent = "after-candidate-intent",
  DuringCandidateBuild = "during-candidate-build",
  AfterCandidateCommit = "after-candidate-commit",
  AwaitingApproval = "awaiting-approval",
  AfterApproval = "after-approval",
  BeforeCas = "before-cas",
  DuringCas = "during-cas",
  AfterCas = "after-cas",
  ExistingBeforeObservation = "existing-before-observation",
  BlockObservation = "block-observation",
  InspectOnce = "inspect-once",
  RollbackOnce = "rollback-once",
  PreflightBeforeActorGet = "preflight-before-actor-get",
  PreflightDuringActorGet = "preflight-during-actor-get",
  PreflightAfterActorGet = "preflight-after-actor-get",
  PreflightBeforeBaseGet = "preflight-before-base-get",
  PreflightDuringBaseGet = "preflight-during-base-get",
  PreflightAfterBaseGet = "preflight-after-base-get",
  PreflightBeforeHeadGet = "preflight-before-head-get",
  PreflightDuringHeadGet = "preflight-during-head-get",
  PreflightAfterHeadGet = "preflight-after-head-get",
  PreflightBeforeSettlement = "preflight-before-settlement",
  PreflightAfterSettlement = "preflight-after-settlement",
  UploadBeforeBlobPost = "upload-before-blob-post",
  UploadDuringBlobPost = "upload-during-blob-post",
  UploadAfterBlobPost = "upload-after-blob-post",
  UploadBeforeTreePost = "upload-before-tree-post",
  UploadDuringTreePost = "upload-during-tree-post",
  UploadAfterTreePost = "upload-after-tree-post",
  UploadBeforeCommitPost = "upload-before-commit-post",
  UploadDuringCommitPost = "upload-during-commit-post",
  UploadAfterCommitPost = "upload-after-commit-post",
  UploadBeforeSettlement = "upload-before-settlement",
  UploadAfterSettlement = "upload-after-settlement",
  RemoteRefBeforePost = "remote-ref-before-post",
  RemoteRefDuringPost = "remote-ref-during-post",
  RemoteRefAfterPost = "remote-ref-after-post",
  RemoteRefBeforeSettlement = "remote-ref-before-settlement",
  RemoteRefAfterSettlement = "remote-ref-after-settlement",
  DraftPrBeforePost = "pr-before-post",
  DraftPrDuringPost = "pr-during-post",
  DraftPrBeforeSettlement = "pr-before-settlement",
  DraftPrAfterSettlement = "pr-after-settlement",
}

interface Paths {
  readonly root: string;
  readonly stateRoot: string;
  readonly databasePath: string;
  readonly markerPath: string;
  readonly resultPath: string;
  readonly sourcePath: string;
  readonly controllerHome: string;
  readonly runsRoot: string;
  readonly cachePath: string;
  readonly headRef: string;
}

interface RealFixture extends Paths {
  readonly baseCommitSha1: string;
  readonly baseTreeSha1: string;
  readonly diffSha256: string;
  readonly sourceFingerprint: Record<string, string>;
  readonly requests: () => number;
  readonly server: Server;
}

interface Marker {
  readonly phase: CrashPhase;
  readonly pid: number;
  readonly detail?: unknown;
}

interface CasRelease {
  readonly phase: CrashPhase.DuringCas;
  readonly pid: number;
  readonly realGitPid: number;
  readonly prepared: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface Runtime {
  readonly metadata: Paths;
  readonly store: IcarusStore;
  readonly service: IcarusService;
  readonly landingGit: LandingGitController;
  readonly close: () => void;
}

interface Worker {
  readonly child: ChildProcess;
  readonly markerPath: string;
  readonly resultPath: string;
  readonly exit: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  readonly stderr: () => string;
}

function paths(root: string, nonce = "default"): Paths {
  const stateRoot = path.join(root, "state");
  const runsRoot = path.join(stateRoot, "runs");
  return {
    root,
    stateRoot,
    databasePath: path.join(stateRoot, "icarus.sqlite3"),
    markerPath: path.join(root, `crash-marker-${nonce}.json`),
    resultPath: path.join(root, `crash-result-${nonce}.json`),
    sourcePath: path.join(root, "source"),
    controllerHome: path.join(stateRoot, "controller-home"),
    runsRoot,
    cachePath: path.join(runsRoot, RUN_ID, "git-cache.git"),
    headRef: `refs/heads/icarus/${RUN_ID}`,
  };
}

function seedEligibleRun(
  fixture: Paths,
  options: {
    readonly baseCommitSha1?: string;
    readonly cachePath?: string;
    readonly reviewedDiff?: string;
  } = {},
): IcarusStore {
  const baseCommitSha1 = options.baseCommitSha1 ?? UNIT_BASE_COMMIT;
  mkdirSync(fixture.stateRoot, { recursive: true, mode: 0o700 });
  const store = new IcarusStore(fixture.databasePath, { now: () => NOW });
  const { projectId } = seedUnitProject(store);
  store.createRun({
    id: RUN_ID,
    projectId,
    task: "Update the greeting",
    targets: UNIT_PLAN.targets,
    provider: UNIT_PROVIDER,
  });
  store.pinRunBase(RUN_ID, baseCommitSha1);
  const context = { ...unitContextManifest(), baseCommit: baseCommitSha1 };
  store.completePreparation(
    RUN_ID,
    context,
    path.join(fixture.root, "context.json"),
    unitContextDigest(context),
  );
  const project = store.getProject(projectId);
  const planSha256 = planApprovalDigest({
    task: "Update the greeting",
    baseCommit: baseCommitSha1,
    contextSha256: unitContextDigest(context),
    targets: context.targets,
    provider: UNIT_PROVIDER,
    checks: project.checks,
    sandbox: project.sandbox,
    ceiling: project.ceiling,
    plan: UNIT_PLAN,
    readableManifest: null,
  });
  store.recordPlanAndAwaitApproval(RUN_ID, UNIT_PLAN, planSha256);
  store.approvePlan(RUN_ID, planSha256, OPERATOR);
  store.recordWorkspace(
    RUN_ID,
    options.cachePath ?? "/tmp/unit-cache.git",
    "/tmp/unit-worktree",
    null,
  );
  const checkpointFiles: readonly CheckpointFile[] = [
    {
      path: UNIT_PLAN.target,
      op: "modify",
      baselineBase64: Buffer.from("hello\n").toString("base64"),
      approvedBase64: Buffer.from("goodbye\n").toString("base64"),
    },
  ];
  const patchSet: PatchSet = {
    summary: "Update the fixture greeting.",
    edits: [
      {
        op: "modify",
        path: UNIT_PLAN.target,
        expectedPreimageSha256: sha256("hello\n"),
        replacements: [{ findText: "hello", replaceText: "goodbye" }],
        rationale: "Exercise durable local landing recovery.",
      },
    ],
  };
  store.recordPatchSetIntent(RUN_ID, patchSet, checkpointFiles);
  const checkpointSha256 = treeCheckpointDigest({
    runId: RUN_ID,
    baseCommit: baseCommitSha1,
    files: checkpointFiles,
  });
  store.saveTreeCheckpoint(RUN_ID, checkpointSha256);
  store.transition(RUN_ID, "verifying", "execution.completed");
  const diff =
    options.reviewedDiff ??
    "diff --git a/src/greeting.txt b/src/greeting.txt\n" +
      "--- a/src/greeting.txt\n+++ b/src/greeting.txt\n@@ -1 +1 @@\n-hello\n+goodbye\n";
  const verification: VerificationEvidence = {
    outcome: "passed",
    checks: [
      {
        checkId: "unit",
        argv: ["node", "--test"],
        exitCode: 0,
        signal: null,
        durationMs: 1,
        stdout: "ok\n",
        stderr: "",
        truncated: false,
        outcome: "passed",
      },
    ],
    changedPaths: [UNIT_PLAN.target],
    diffSha256: sha256(diff),
    checkpointSha256,
  };
  store.recordVerificationAndAwaitReview(RUN_ID, diff, verification);
  const database = new Database(fixture.databasePath);
  database
    .prepare(
      "INSERT INTO approvals (id, run_id, kind, digest, actor, decision, created_at) " +
        "VALUES (?, ?, 'review', ?, ?, 'approve', ?)",
    )
    .run(REVIEW_ID, RUN_ID, verification.diffSha256, OPERATOR, NOW);
  database
    .prepare("UPDATE runs SET state = 'completed', version = version + 1 WHERE id = ?")
    .run(RUN_ID);
  database.close();
  store.setLandingProfile(
    projectId,
    {
      version: 1,
      provider: "github",
      owner: "icarus-crash-test",
      repository: "landing-crash-recovery",
      baseBranch: "main",
      branchNamespace: "icarus/",
      credentialRef: { kind: "environment", name: CREDENTIAL_ENV },
      expectedActor: "crash-test-github-actor",
      commitIdentity: { name: "Icarus Crash Test", email: "icarus@example.invalid" },
      derivativeEffects: {
        version: 1,
        disposition: "inert-repository",
        evidenceSha256: "7".repeat(64),
      },
    },
    new Set([CREDENTIAL_ENV]),
  );
  return store;
}

const realCleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of realCleanups.splice(0).reverse()) await cleanup();
});

function runGit(cwd: string, args: readonly string[], stdin?: Uint8Array): Buffer {
  const result = spawnSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Crash Fixture",
      GIT_AUTHOR_EMAIL: "crash@example.invalid",
      GIT_AUTHOR_DATE: "1700000000 +0000",
      GIT_COMMITTER_NAME: "Crash Fixture",
      GIT_COMMITTER_EMAIL: "crash@example.invalid",
      GIT_COMMITTER_DATE: "1700000000 +0000",
      GIT_TERMINAL_PROMPT: "0",
    },
    input: stdin,
    encoding: null,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      "git " +
        (args[0] ?? "") +
        " failed: " +
        (result.error?.message ?? result.stderr.toString("utf8")),
    );
  }
  return result.stdout;
}

function runGitText(cwd: string, args: readonly string[]): string {
  return runGit(cwd, args).toString("utf8").trim();
}

async function startNetworkTrap(): Promise<{
  readonly server: Server;
  readonly url: string;
  readonly requests: () => number;
}> {
  let count = 0;
  const server = http.createServer((_request, response) => {
    count += 1;
    response.writeHead(500);
    response.end("network forbidden\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${address.port}/must-not-be-contacted.git`,
    requests: () => count,
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function createRealFixture(): Promise<RealFixture> {
  const root = path.join(os.tmpdir(), `icarus-landing-crash-real-${randomUUID()}`);
  const fixture = paths(root);
  const trap = await startNetworkTrap();
  mkdirSync(path.join(fixture.sourcePath, "src"), { recursive: true, mode: 0o700 });
  mkdirSync(fixture.controllerHome, { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(fixture.cachePath), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(fixture.sourcePath, UNIT_PLAN.target), "hello\n");
  runGit(fixture.sourcePath, ["init", "-b", "main"]);
  runGit(fixture.sourcePath, ["add", "."]);
  runGit(fixture.sourcePath, ["commit", "-m", "base"]);
  const baseCommitSha1 = runGitText(fixture.sourcePath, ["rev-parse", "HEAD"]);
  const baseTreeSha1 = runGitText(fixture.sourcePath, ["rev-parse", "HEAD^{tree}"]);
  runGit(root, [
    "clone",
    "--bare",
    "--no-local",
    "--no-hardlinks",
    fixture.sourcePath,
    fixture.cachePath,
  ]);
  chmodSync(fixture.cachePath, 0o700);
  chmodSync(path.join(fixture.cachePath, "objects"), 0o700);
  chmodSync(path.join(fixture.cachePath, "refs"), 0o700);
  runGit(fixture.cachePath, ["remote", "set-url", "origin", trap.url]);
  const reviewPath = path.join(root, "review");
  runGit(root, ["clone", "--no-local", fixture.sourcePath, reviewPath]);
  writeFileSync(path.join(reviewPath, UNIT_PLAN.target), "goodbye\n");
  runGit(reviewPath, ["add", "-A"]);
  const reviewedDiff = runGit(reviewPath, [
    "--literal-pathspecs",
    "-c",
    "diff.algorithm=myers",
    "-c",
    "diff.indentHeuristic=false",
    "-c",
    "color.ui=false",
    "diff",
    "--cached",
    "--binary",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--no-color",
    "--no-indent-heuristic",
    "--diff-algorithm=myers",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    baseCommitSha1,
    "--",
    UNIT_PLAN.target,
  ]).toString("utf8");
  const store = seedEligibleRun(fixture, {
    baseCommitSha1,
    cachePath: fixture.cachePath,
    reviewedDiff,
  });
  store.close();
  const sourceFingerprint = await repositoryFingerprint(fixture.sourcePath);
  const result: RealFixture = {
    ...fixture,
    baseCommitSha1,
    baseTreeSha1,
    diffSha256: sha256(reviewedDiff),
    sourceFingerprint,
    requests: trap.requests,
    server: trap.server,
  };
  realCleanups.push(async () => {
    try {
      await expectSourceCheckoutUnchanged(result);
    } finally {
      await closeServer(trap.server);
      rmSync(root, { recursive: true, force: true });
    }
  });
  return result;
}

async function expectSourceCheckoutUnchanged(fixture: RealFixture): Promise<void> {
  expect(await repositoryFingerprint(fixture.sourcePath)).toEqual(fixture.sourceFingerprint);
}

function refValue(fixture: RealFixture): string | null {
  const prefix = ["--git-dir", fixture.cachePath, "show-ref", "--verify"] as const;
  const existence = spawnSync("git", [...prefix, "--quiet", "--", fixture.headRef], {
    encoding: "utf8",
  });
  if (existence.status === 1) return null;
  if (existence.error !== undefined || existence.status !== 0) {
    throw new Error(existence.error?.message ?? existence.stderr);
  }
  return runGitText(fixture.cachePath, ["show-ref", "--verify", "--hash", "--", fixture.headRef]);
}

function setRef(fixture: RealFixture, sha1: string): void {
  runGit(fixture.cachePath, ["update-ref", "--no-deref", fixture.headRef, sha1, ZERO_SHA1]);
}

function privateRefs(fixture: RealFixture): readonly string[] {
  const output = runGitText(fixture.cachePath, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/heads/icarus/",
  ]);
  return output.length === 0 ? [] : output.split("\n");
}

function interruptedIndexes(fixture: RealFixture): readonly string[] {
  const prefix = `.icarus-landing-index-${RUN_ID}-`;
  return readdirSync(fixture.controllerHome).filter((entry) => entry.startsWith(prefix));
}

function expectNoExternalEffect(fixture: RealFixture): void {
  expect(fixture.requests()).toBe(0);
  expect(privateRefs(fixture)).toEqual([]);
}

function fakeLandingGit(): LandingGitService {
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected landing Git call");
  };
  return {
    inspectBase: async () => ({
      objectFormat: "sha1",
      baseCommitSha1: UNIT_BASE_COMMIT,
      baseTreeSha1: BASE_TREE_SHA1,
    }),
    prepareCandidate: unexpected,
    observeLocalRef: unexpected,
    createAbsentLocalRef: unexpected,
  };
}

interface LandingSeams {
  readonly gateway?: (credential: string) => LandingGithubGateway;
  readonly credentialEnvironment?: (name: string) => string | undefined;
}

async function serviceFor(
  fixture: Paths,
  store: IcarusStore,
  landingGit: LandingGitService = fakeLandingGit(),
  landing: LandingSeams = {},
): Promise<IcarusService> {
  const ordinaryGit = new Proxy(
    {},
    {
      get: (_target, property) => () => {
        throw new Error(`Unexpected ordinary Git call: ${String(property)}`);
      },
    },
  ) as GitController;
  const checks: CheckRunner = {
    reconcile: async () => {
      throw new Error("Unexpected check reconciliation");
    },
    runChecks: async () => {
      throw new Error("Unexpected check execution");
    },
  };
  const service = new IcarusService({
    stateRoot: fixture.stateRoot,
    store,
    artifacts: new ArtifactStore(fixture.stateRoot),
    git: ordinaryGit,
    landingGit,
    landingCredentialEnvironmentNames: [CREDENTIAL_ENV],
    // Fail closed by default: no test in this file may construct a real
    // provider-bound gateway. Preflight phases inject the loopback transport.
    landingGithubGateway:
      landing.gateway ??
      (() => {
        throw new Error("Unexpected GitHub gateway construction");
      }),
    ...(landing.credentialEnvironment === undefined
      ? {}
      : { landingCredentialEnvironment: landing.credentialEnvironment }),
    checks,
    now: () => NOW,
  });
  await service.initialize();
  return service;
}

function delegateLandingGit(
  controller: LandingGitController,
  overrides: Partial<LandingGitService> = {},
): LandingGitService {
  return {
    inspectBase: controller.inspectBase.bind(controller),
    prepareCandidate: controller.prepareCandidate.bind(controller),
    observeLocalRef: controller.observeLocalRef.bind(controller),
    createAbsentLocalRef: controller.createAbsentLocalRef.bind(controller),
    ...overrides,
  };
}

async function openRealRuntime(
  root: string,
  factory?: (controller: LandingGitController) => LandingGitService,
  executable = "git",
  landing: LandingSeams = {},
): Promise<Runtime> {
  const fixture = paths(root);
  const store = new IcarusStore(fixture.databasePath, { now: () => NOW });
  const landingGit = new LandingGitController(fixture.controllerHome, fixture.runsRoot, executable);
  const service = await serviceFor(fixture, store, factory?.(landingGit) ?? landingGit, landing);
  return {
    metadata: fixture,
    store,
    service,
    landingGit,
    close: () => store.close(),
  };
}

/** Reopens the crashed fixture with the loopback GitHub transport wired in. */
async function reopenPreflightWithLoopback(
  fixture: RealFixture,
  options: {
    readonly remoteRefs?: Readonly<Record<string, string>>;
    readonly initialPullRequest?: {
      readonly title: string;
      readonly body: string;
      readonly number: number;
    };
  } = {},
): Promise<{
  readonly runtime: Runtime;
  readonly loopback: GithubLoopback;
}> {
  const probe = new IcarusStore(fixture.databasePath, { now: () => NOW });
  let candidateTreeSha1 = "";
  let candidateCommitSha1 = "";
  try {
    const landing = probe.getLandingStatusForRun(RUN_ID)?.landing;
    candidateTreeSha1 = landing?.candidateTreeSha1 ?? "";
    candidateCommitSha1 = landing?.candidateCommitSha1 ?? "";
  } finally {
    probe.close();
  }
  const loopback = await startGithubLoopback({
    expectedActor: "crash-test-github-actor",
    baseCommitSha1: () => fixture.baseCommitSha1,
    headRef: fixture.headRef,
    candidateTreeSha1: () => candidateTreeSha1,
    candidateCommitSha1: () => candidateCommitSha1,
    ...(options.remoteRefs === undefined ? {} : { initialRefs: options.remoteRefs }),
    ...(options.initialPullRequest === undefined
      ? {}
      : { initialPullRequest: options.initialPullRequest }),
  });
  const runtime = await openRealRuntime(fixture.root, undefined, "git", {
    gateway: (credential) =>
      new GithubGateway({
        baseUrl: loopback.server.baseUrl,
        token: credential,
        allowLoopback: true,
      }),
    credentialEnvironment: (name) => (name === CREDENTIAL_ENV ? PREFLIGHT_TOKEN : undefined),
  });
  return { runtime, loopback };
}

function prepareInput() {
  return {
    runId: RUN_ID,
    commitMessage: "Apply the reviewed greeting change\n",
    pullRequestTitle: "Apply the reviewed greeting change",
    pullRequestBodyPrefix: "Prepared from exact reviewed evidence.",
  } as const;
}

async function prepareAwaiting(fixture: RealFixture) {
  const runtime = await openRealRuntime(fixture.root);
  try {
    return await runtime.service.prepareLanding(prepareInput());
  } finally {
    runtime.close();
  }
}

async function approveLanding(fixture: RealFixture) {
  const awaiting = await prepareAwaiting(fixture);
  const runtime = await openRealRuntime(fixture.root);
  try {
    return await runtime.service.decideLanding(
      RUN_ID,
      awaiting.landing.landingSha256 ?? "",
      OPERATOR,
      "approve",
    );
  } finally {
    runtime.close();
  }
}

async function replayCandidate(runtime: Runtime): Promise<LandingCandidateResult> {
  const status = runtime.store.getLandingStatusForRun(RUN_ID);
  if (status === null) throw new Error("Landing is missing");
  const evidence = runtime.store.getLandingEvidence(RUN_ID);
  return runtime.landingGit.prepareCandidate({
    cachePath: evidence.cachePath,
    runId: evidence.runId,
    baseCommitSha1: evidence.baseCommitSha1,
    baseTreeSha1: status.landing.baseTreeSha1,
    checkpointFiles: evidence.checkpointFiles,
    reviewedDiffBytes: Buffer.from(evidence.reviewedDiff, "utf8"),
    commitIdentity: status.landing.profile.commitIdentity,
    commitEpochSeconds: status.landing.commitEpochSeconds,
    commitMessage: status.landing.commitMessage,
  });
}

function pause(markerPath: string, phase: CrashPhase, detail?: unknown): never {
  writeFileSync(markerPath, JSON.stringify({ phase, pid: process.pid, detail }), {
    flag: "wx",
    mode: 0o600,
  });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error("Crash pause returned");
}

const PREFLIGHT_TOKEN = "ghp-crash-preflight-token-sentinel-do-not-persist";

type PreflightReadClass = "actor" | "base" | "head";
type GithubPostClass = "blob" | "tree" | "commit" | "ref" | "pr";

/** The loopback remote's one pull request record, when the POST landed. */
interface LoopbackPullRequest {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly headSha1: string;
  readonly baseSha1: string;
}

/** The wire shape the gateway's pull-request reader validates and projects. */
function loopbackPullRequestPayload(pr: LoopbackPullRequest) {
  return {
    number: pr.number,
    draft: true,
    state: "open",
    merged_at: null,
    head: { ref: pr.headBranch, sha: pr.headSha1 },
    base: { ref: pr.baseBranch, sha: pr.baseSha1 },
    title: pr.title,
    body: pr.body,
    maintainer_can_modify: false,
  };
}

interface GithubLoopback {
  readonly server: ProviderHttpServer;
  readonly requests: readonly CapturedProviderRequest[];
  /** One entry per request: whether the exact expected credential was presented. */
  readonly authorizationChecks: readonly boolean[];
}

/**
 * The deterministic loopback GitHub transport for remote-stage crash phases.
 * It serves the exact read and mutation shapes the contract's grammars admit —
 * blobs are answered with their content-addressed name, refs are stateful —
 * and for a "during" phase it parks the response mid-exchange so the kill
 * lands while the request is in flight. The credential value is only ever
 * compared, never recorded.
 */
async function startGithubLoopback(options: {
  readonly expectedActor: string;
  readonly baseCommitSha1: () => string;
  readonly headRef: string;
  readonly candidateTreeSha1?: () => string;
  readonly candidateCommitSha1?: () => string;
  readonly initialRefs?: Readonly<Record<string, string>>;
  /** A pre-existing conforming pull request, for "the lost POST landed" answers. */
  readonly initialPullRequest?: {
    readonly title: string;
    readonly body: string;
    readonly number: number;
  };
  readonly pauseOnRead?: PreflightReadClass;
  readonly pauseOnPost?: GithubPostClass;
  readonly pausePhase?: CrashPhase;
  readonly markerPath?: string;
}): Promise<GithubLoopback> {
  const authorizationChecks: boolean[] = [];
  const remoteRefs = new Map<string, string>(Object.entries(options.initialRefs ?? {}));
  const headBranch = options.headRef.startsWith("refs/heads/")
    ? options.headRef.slice("refs/heads/".length)
    : options.headRef;
  let remotePullRequest: LoopbackPullRequest | null = null;
  let initialPullRequestConsumed = false;
  // The candidate closures answer "" until the worker reads its store, so the
  // initial pull request materializes lazily at its first read.
  const currentPullRequest = (): LoopbackPullRequest | null => {
    if (!initialPullRequestConsumed) {
      initialPullRequestConsumed = true;
      const initial = options.initialPullRequest;
      if (initial !== undefined) {
        remotePullRequest = {
          number: initial.number,
          title: initial.title,
          body: initial.body,
          headBranch,
          baseBranch: "main",
          headSha1: remoteRefs.get(options.headRef) ?? options.candidateCommitSha1?.() ?? "",
          baseSha1: options.baseCommitSha1(),
        };
      }
    }
    return remotePullRequest;
  };
  const prefix = "/repos/icarus-crash-test/landing-crash-recovery";
  const server = await startProviderHttpServer((request, response) => {
    authorizationChecks.push(request.headers.authorization === `Bearer ${PREFLIGHT_TOKEN}`);
    const url = request.url ?? "";
    const pauseHere = (boundary: string, extra: Record<string, unknown> = {}): void => {
      pause(options.markerPath ?? "", options.pausePhase ?? CrashPhase.InspectOnce, {
        boundary,
        authorized: authorizationChecks.at(-1) ?? false,
        ...extra,
      });
    };
    if (request.method === "POST") {
      const post: GithubPostClass | null =
        url === `${prefix}/git/blobs`
          ? "blob"
          : url === `${prefix}/git/trees`
            ? "tree"
            : url === `${prefix}/git/commits`
              ? "commit"
              : url === `${prefix}/git/refs`
                ? "ref"
                : url === `${prefix}/pulls`
                  ? "pr"
                  : null;
      if (post === null) {
        sendProviderJson(response, 404, { message: "Not Found" });
        return;
      }
      if (options.pauseOnPost === post) {
        pauseHere("github-post-in-flight", { post });
      }
      const body = parseProviderRequestBody(request) as Record<string, unknown>;
      if (post === "pr") {
        // The draft-PR create: record the one pull request the way GitHub
        // would, then answer the exact created shape.
        const head = typeof body.head === "string" ? body.head : "";
        const separator = head.indexOf(":");
        remotePullRequest = {
          number: 701,
          title: typeof body.title === "string" ? body.title : "",
          body: typeof body.body === "string" ? body.body : "",
          headBranch: separator === -1 ? head : head.slice(separator + 1),
          baseBranch: typeof body.base === "string" ? body.base : "main",
          headSha1: remoteRefs.get(options.headRef) ?? options.candidateCommitSha1?.() ?? "",
          baseSha1: options.baseCommitSha1(),
        };
        initialPullRequestConsumed = true;
        sendProviderJson(response, 201, loopbackPullRequestPayload(remotePullRequest));
        return;
      }
      if (post === "blob") {
        const content = typeof body.content === "string" ? body.content : "";
        const sha = gitObjectSha1("blob", Buffer.from(content, "base64"));
        sendProviderJson(response, 201, { sha });
        return;
      }
      if (post === "tree") {
        sendProviderJson(response, 201, { sha: options.candidateTreeSha1?.() ?? "" });
        return;
      }
      if (post === "commit") {
        sendProviderJson(response, 201, { sha: options.candidateCommitSha1?.() ?? "" });
        return;
      }
      const ref = typeof body.ref === "string" ? body.ref : "";
      const sha = typeof body.sha === "string" ? body.sha : "";
      remoteRefs.set(ref, sha);
      sendProviderJson(response, 201, { ref, object: { sha, type: "commit" } });
      return;
    }
    if (url.startsWith(`${prefix}/pulls`)) {
      // The pull-request list read: the complete one-page answer, either the
      // empty absence proof or the one record the create stored.
      const pr = currentPullRequest();
      sendProviderJson(response, 200, pr === null ? [] : [loopbackPullRequestPayload(pr)]);
      return;
    }
    const read: PreflightReadClass | null =
      url === "/user"
        ? "actor"
        : url === `${prefix}/git/ref/heads/main`
          ? "base"
          : url === `${prefix}/git/ref/heads/icarus/${RUN_ID}`
            ? "head"
            : null;
    if (read === null) {
      sendProviderJson(response, 404, { message: "Not Found" });
      return;
    }
    if (options.pauseOnRead === read) {
      pauseHere("github-read-in-flight", { read });
    }
    if (read === "actor") {
      sendProviderJson(response, 200, { login: options.expectedActor });
    } else if (read === "base") {
      sendProviderJson(response, 200, {
        ref: "refs/heads/main",
        object: { sha: options.baseCommitSha1(), type: "commit" },
      });
    } else {
      const existing = remoteRefs.get(options.headRef);
      if (existing === undefined) {
        sendProviderJson(response, 404, { message: "Not Found" });
      } else {
        sendProviderJson(response, 200, {
          ref: options.headRef,
          object: { sha: existing, type: "commit" },
        });
      }
    }
  });
  return { server, requests: server.requests, authorizationChecks };
}

function isRemotePhase(phase: CrashPhase): boolean {
  return (
    phase.startsWith("preflight-") ||
    phase.startsWith("upload-") ||
    phase.startsWith("remote-ref-") ||
    phase.startsWith("pr-")
  );
}

function preflightBeforeGetKind(phase: CrashPhase): string | null {
  switch (phase) {
    case CrashPhase.PreflightBeforeActorGet:
      return "github.actor.get";
    case CrashPhase.PreflightBeforeBaseGet:
      return "github.base_ref.get";
    case CrashPhase.PreflightBeforeHeadGet:
      return "github.head_ref.get";
    case CrashPhase.UploadBeforeBlobPost:
      return "github.blob.post";
    case CrashPhase.UploadBeforeTreePost:
      return "github.tree.post";
    case CrashPhase.UploadBeforeCommitPost:
      return "github.commit.post";
    case CrashPhase.RemoteRefBeforePost:
      return "github.ref.post";
    case CrashPhase.DraftPrBeforePost:
      return "github.pull_request.post";
    default:
      return null;
  }
}

function preflightDuringRead(phase: CrashPhase): PreflightReadClass | null {
  switch (phase) {
    case CrashPhase.PreflightDuringActorGet:
      return "actor";
    case CrashPhase.PreflightDuringBaseGet:
      return "base";
    case CrashPhase.PreflightDuringHeadGet:
      return "head";
    default:
      return null;
  }
}

function duringPostClass(phase: CrashPhase): GithubPostClass | null {
  switch (phase) {
    case CrashPhase.UploadDuringBlobPost:
      return "blob";
    case CrashPhase.UploadDuringTreePost:
      return "tree";
    case CrashPhase.UploadDuringCommitPost:
      return "commit";
    case CrashPhase.RemoteRefDuringPost:
      return "ref";
    case CrashPhase.DraftPrDuringPost:
      return "pr";
    default:
      return null;
  }
}

function preflightAfterGetOrdinal(phase: CrashPhase): number | null {
  switch (phase) {
    case CrashPhase.PreflightAfterActorGet:
      return 1;
    case CrashPhase.PreflightAfterBaseGet:
      return 2;
    case CrashPhase.PreflightAfterHeadGet:
      return 3;
    default:
      return null;
  }
}

function afterPostObjectKind(phase: CrashPhase): GithubPostClass | null {
  switch (phase) {
    case CrashPhase.UploadAfterBlobPost:
      return "blob";
    case CrashPhase.UploadAfterTreePost:
      return "tree";
    case CrashPhase.UploadAfterCommitPost:
      return "commit";
    case CrashPhase.RemoteRefAfterPost:
      return "ref";
    default:
      return null;
  }
}

function settlementOperationKind(
  phase: CrashPhase,
):
  | "github.preflight"
  | "github.objects.upload"
  | "github.ref.create"
  | "github.pull_request.create"
  | null {
  switch (phase) {
    case CrashPhase.PreflightBeforeSettlement:
    case CrashPhase.PreflightAfterSettlement:
      return "github.preflight";
    case CrashPhase.UploadBeforeSettlement:
    case CrashPhase.UploadAfterSettlement:
      return "github.objects.upload";
    case CrashPhase.RemoteRefBeforeSettlement:
    case CrashPhase.RemoteRefAfterSettlement:
      return "github.ref.create";
    case CrashPhase.DraftPrBeforeSettlement:
    case CrashPhase.DraftPrAfterSettlement:
      return "github.pull_request.create";
    default:
      return null;
  }
}

function isBeforeSettlementPhase(phase: CrashPhase): boolean {
  return (
    phase === CrashPhase.PreflightBeforeSettlement ||
    phase === CrashPhase.UploadBeforeSettlement ||
    phase === CrashPhase.RemoteRefBeforeSettlement ||
    phase === CrashPhase.DraftPrBeforeSettlement
  );
}

/**
 * Arms the crash boundary in the worker: admission and settlement wrappers
 * pause before/after their durable commit; the in-flight boundary is parked by
 * the loopback handler itself.
 */
function armPreflightWrappers(store: IcarusStore, phase: CrashPhase, markerPath: string): void {
  const beforeKind = preflightBeforeGetKind(phase);
  if (beforeKind !== null) {
    const original = store.admitGithubRequest.bind(store);
    Object.defineProperty(store, "admitGithubRequest", {
      configurable: true,
      value: (...args: Parameters<typeof original>) => {
        if (args[2] === beforeKind) {
          pause(markerPath, phase, { boundary: "before-request-admission", kind: beforeKind });
        }
        return original(...args);
      },
    });
  }
  const afterOrdinal = preflightAfterGetOrdinal(phase);
  const afterObjectKind = afterPostObjectKind(phase);
  if (afterOrdinal !== null || afterObjectKind !== null) {
    const original = store.settleGithubRequest.bind(store);
    let settled = 0;
    Object.defineProperty(store, "settleGithubRequest", {
      configurable: true,
      value: (...args: Parameters<typeof original>) => {
        const result = original(...args);
        settled += 1;
        const projection = args[2]?.projection;
        if (afterOrdinal !== null && settled === afterOrdinal) {
          pause(markerPath, phase, {
            boundary: "after-request-settlement",
            requestOrdinal: afterOrdinal,
          });
        }
        if (
          afterObjectKind !== null &&
          projection?.type === "object" &&
          projection.objectKind === afterObjectKind
        ) {
          pause(markerPath, phase, {
            boundary: "after-request-settlement",
            kind: `github.${afterObjectKind}.post`,
          });
        }
        return result;
      },
    });
  }
  const operationKind = settlementOperationKind(phase);
  if (operationKind !== null) {
    const method =
      operationKind === "github.preflight"
        ? "settleGithubPreflight"
        : operationKind === "github.objects.upload"
          ? "settleGithubObjectsUpload"
          : operationKind === "github.ref.create"
            ? "settleGithubRemoteRef"
            : "settleGithubPullRequest";
    const original = store[method].bind(store) as (...args: unknown[]) => unknown;
    Object.defineProperty(store, method, {
      configurable: true,
      value: (...args: unknown[]): unknown => {
        if (isBeforeSettlementPhase(phase)) {
          pause(markerPath, phase, {
            boundary: "before-operation-settlement",
            kind: operationKind,
          });
        }
        const result = original(...args);
        pause(markerPath, phase, { boundary: "after-operation-settlement", kind: operationKind });
        return result;
      },
    });
  }
}

function gitPauseWrapper(
  fixture: Paths,
  markerPath: string,
  phase: CrashPhase.DuringCandidateBuild | CrashPhase.DuringCas,
): string {
  const wrapperPath = path.join(fixture.root, `git-wrapper-${randomUUID()}.mjs`);
  const fallback = [
    'const child = spawnSync("git", argv, { stdio: "inherit" });',
    "if (child.error) process.exit(127);",
    "if (child.signal !== null) process.kill(process.pid, child.signal);",
    "process.exit(child.status ?? 128);",
  ];
  const behavior =
    phase === CrashPhase.DuringCas
      ? [
          'if (command[0] === "update-ref" && command[1] === "--stdin") {',
          '  const preparedOutput = Buffer.from("start: ok\\nprepare: ok\\n", "utf8");',
          "  const coordinatorPid = process.ppid;",
          '  const child = spawn("git", argv, { stdio: ["pipe", "pipe", "pipe"] });',
          "  let observedStdout = Buffer.alloc(0);",
          "  let marked = false;",
          "  process.stdin.pipe(child.stdin);",
          "  child.stderr.resume();",
          '  child.stdout.on("data", (chunk) => {',
          "    if (marked) return;",
          "    process.stdout.write(chunk);",
          "    observedStdout = Buffer.concat([observedStdout, chunk]);",
          "    if (",
          "      observedStdout.byteLength > preparedOutput.byteLength ||",
          "      !observedStdout.equals(preparedOutput.subarray(0, observedStdout.byteLength))",
          "    ) process.exit(126);",
          "    if (!observedStdout.equals(preparedOutput)) return;",
          "    marked = true;",
          "    process.stdin.unpipe(child.stdin);",
          "    writeFileSync(",
          "      markerPath,",
          "      JSON.stringify({",
          "        phase,",
          "        pid: process.pid,",
          "        detail: {",
          "          command,",
          '          boundary: "update-ref-transaction-prepared",',
          '          preparedOutput: observedStdout.toString("utf8"),',
          "          realGitPid: child.pid,",
          "        },",
          "      }),",
          '      { flag: "wx", mode: 0o600 },',
          "    );",
          "    const waiter = new Int32Array(new SharedArrayBuffer(4));",
          "    while (process.ppid === coordinatorPid) {",
          "      try {",
          "        process.kill(coordinatorPid, 0);",
          "      } catch {",
          "        break;",
          "      }",
          "      Atomics.wait(waiter, 0, 0, 20);",
          "    }",
          "    process.stdin.destroy();",
          "    child.stdin.end();",
          "  });",
          '  child.once("error", () => process.exit(127));',
          '  child.once("close", (code, signal) => {',
          "    writeFileSync(",
          "      releasePath,",
          "      JSON.stringify({",
          "        phase,",
          "        pid: process.pid,",
          "        realGitPid: child.pid,",
          "        prepared: marked,",
          "        exitCode: code,",
          "        signal,",
          "      }),",
          '      { flag: "wx", mode: 0o600 },',
          "    );",
          "    process.exit(code ?? 128);",
          "  });",
          "} else {",
          ...fallback.map((line) => `  ${line}`),
          "}",
        ]
      : [
          'if (command[0] === "write-tree") {',
          "  writeFileSync(",
          "    markerPath,",
          "    JSON.stringify({ phase, pid: process.pid, detail: { command } }),",
          '    { flag: "wx", mode: 0o600 },',
          "  );",
          "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);",
          "}",
          ...fallback,
        ];
  writeFileSync(
    wrapperPath,
    [
      "#!/usr/bin/env node",
      'import { spawn, spawnSync } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      `const markerPath = ${JSON.stringify(markerPath)};`,
      `const releasePath = ${JSON.stringify(`${markerPath}.released`)};`,
      `const phase = ${JSON.stringify(phase)};`,
      "const argv = process.argv.slice(2);",
      'const index = argv.lastIndexOf("--git-dir");',
      "const command = index === -1 ? [] : argv.slice(index + 2);",
      ...behavior,
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  chmodSync(wrapperPath, 0o700);
  return wrapperPath;
}

/**
 * The preflight crash worker: resume the approved landing to `local_ready`
 * with the real Git controller, then arm the phase's boundary and run the
 * read-only preflight through the loopback transport. The credential lives
 * only in the worker's environment and is presented only to the loopback.
 */
async function preflightWorkerMain(
  fixture: Paths,
  phase: CrashPhase,
  markerPath: string,
): Promise<void> {
  process.env[CREDENTIAL_ENV] = PREFLIGHT_TOKEN;
  let baseCommitSha1 = "";
  let candidateTreeSha1 = "";
  let candidateCommitSha1 = "";
  const duringRead = preflightDuringRead(phase);
  const duringPost = duringPostClass(phase);
  const loopback = await startGithubLoopback({
    expectedActor: "crash-test-github-actor",
    baseCommitSha1: () => baseCommitSha1,
    headRef: fixture.headRef,
    candidateTreeSha1: () => candidateTreeSha1,
    candidateCommitSha1: () => candidateCommitSha1,
    ...(duringRead === null ? {} : { pauseOnRead: duringRead }),
    ...(duringPost === null ? {} : { pauseOnPost: duringPost }),
    pausePhase: phase,
    markerPath,
  });
  const runtime = await openRealRuntime(fixture.root, undefined, "git", {
    gateway: (credential) =>
      new GithubGateway({
        baseUrl: loopback.server.baseUrl,
        token: credential,
        allowLoopback: true,
      }),
  });
  try {
    const landing = runtime.store.getLandingStatusForRun(RUN_ID)?.landing;
    baseCommitSha1 = landing?.baseCommitSha1 ?? "";
    candidateTreeSha1 = landing?.candidateTreeSha1 ?? "";
    candidateCommitSha1 = landing?.candidateCommitSha1 ?? "";
    if (baseCommitSha1 === "" || candidateTreeSha1 === "" || candidateCommitSha1 === "") {
      throw new Error("Landing authority is incomplete");
    }
    const ready = await runtime.service.resumeLanding(RUN_ID);
    if (ready.landing.state !== "local_ready") {
      throw new Error("Landing did not reach local_ready before the remote phase");
    }
    if (phase.startsWith("remote-ref-")) {
      // Remote-ref phases crash the third resume: first finish the upload.
      const objectsReady = await runtime.service.resumeLanding(RUN_ID);
      if (objectsReady.landing.state !== "objects_ready") {
        throw new Error("Landing did not reach objects_ready before the remote-ref phase");
      }
      armPreflightWrappers(runtime.store, phase, markerPath);
      await runtime.service.resumeLanding(RUN_ID);
      return;
    }
    if (phase.startsWith("pr-")) {
      // Draft-PR phases crash the fourth resume: first finish the upload and
      // the remote ref so the landing sits armed at remote_ready.
      const objectsReady = await runtime.service.resumeLanding(RUN_ID);
      if (objectsReady.landing.state !== "objects_ready") {
        throw new Error("Landing did not reach objects_ready before the draft-PR phase");
      }
      const remoteReady = await runtime.service.resumeLanding(RUN_ID);
      if (remoteReady.landing.state !== "remote_ready") {
        throw new Error("Landing did not reach remote_ready before the draft-PR phase");
      }
      armPreflightWrappers(runtime.store, phase, markerPath);
      await runtime.service.resumeLanding(RUN_ID);
      return;
    }
    armPreflightWrappers(runtime.store, phase, markerPath);
    await runtime.service.resumeLanding(RUN_ID);
  } finally {
    runtime.close();
  }
}

async function workerMain(
  root: string,
  phase: CrashPhase,
  markerPath: string,
  resultPath: string,
): Promise<void> {
  const fixture = paths(root);
  if (isRemotePhase(phase)) {
    await preflightWorkerMain(fixture, phase, markerPath);
    return;
  }
  if (phase === CrashPhase.BeforeLandingRow) {
    const store = seedEligibleRun(fixture);
    const calls = {
      inspectBase: 0,
      prepareCandidate: 0,
      observeLocalRef: 0,
      createAbsentLocalRef: 0,
    };
    const landingGit: LandingGitService = {
      inspectBase: async () => {
        calls.inspectBase += 1;
        return {
          objectFormat: "sha1",
          baseCommitSha1: UNIT_BASE_COMMIT,
          baseTreeSha1: BASE_TREE_SHA1,
        };
      },
      prepareCandidate: async () => {
        calls.prepareCandidate += 1;
        throw new Error("Candidate construction crossed the pre-transaction boundary");
      },
      observeLocalRef: async () => {
        calls.observeLocalRef += 1;
        throw new Error("Local-ref observation crossed the pre-transaction boundary");
      },
      createAbsentLocalRef: async () => {
        calls.createAbsentLocalRef += 1;
        throw new Error("Local-ref creation crossed the pre-transaction boundary");
      },
    };
    const service = await serviceFor(fixture, store, landingGit);
    const original = store.createLanding.bind(store);
    Object.defineProperty(store, "createLanding", {
      configurable: true,
      value: (...args: Parameters<typeof original>) => {
        pause(markerPath, phase, {
          boundary: "before_landing_row_transaction",
          calls,
          sourceCheckoutExists: existsSync(fixture.sourcePath),
          cacheExists: existsSync(fixture.cachePath),
        });
        return original(...args);
      },
    });
    await service.prepareLanding(prepareInput());
    return;
  }

  let runtime: Runtime;
  if (phase === CrashPhase.DuringCandidateBuild || phase === CrashPhase.DuringCas) {
    runtime = await openRealRuntime(root, undefined, gitPauseWrapper(fixture, markerPath, phase));
  } else if (phase === CrashPhase.AfterCandidateIntent) {
    runtime = await openRealRuntime(root, (controller) =>
      delegateLandingGit(controller, {
        prepareCandidate: async () => pause(markerPath, phase),
      }),
    );
  } else if (phase === CrashPhase.AfterCandidateCommit) {
    runtime = await openRealRuntime(root, (controller) =>
      delegateLandingGit(controller, {
        prepareCandidate: async (input, signal) => {
          const result = await controller.prepareCandidate(input, signal);
          return pause(markerPath, phase, result);
        },
      }),
    );
  } else if (phase === CrashPhase.BeforeCas) {
    runtime = await openRealRuntime(root, (controller) =>
      delegateLandingGit(controller, {
        createAbsentLocalRef: async () => pause(markerPath, phase),
      }),
    );
  } else if (phase === CrashPhase.AfterCas) {
    runtime = await openRealRuntime(root, (controller) =>
      delegateLandingGit(controller, {
        createAbsentLocalRef: async (input, signal) => {
          const result = await controller.createAbsentLocalRef(input, signal);
          return pause(markerPath, phase, result);
        },
      }),
    );
  } else if (phase === CrashPhase.ExistingBeforeObservation) {
    let first = true;
    runtime = await openRealRuntime(root, (controller) =>
      delegateLandingGit(controller, {
        observeLocalRef: async (input, signal) => {
          const result = await controller.observeLocalRef(input, signal);
          if (first) {
            first = false;
            return pause(markerPath, phase, result);
          }
          return result;
        },
      }),
    );
  } else if (phase === CrashPhase.BlockObservation) {
    runtime = await openRealRuntime(root, (controller) =>
      delegateLandingGit(controller, {
        observeLocalRef: async () => pause(markerPath, phase),
      }),
    );
  } else {
    runtime = await openRealRuntime(root);
  }

  try {
    if (
      phase === CrashPhase.AfterCandidateIntent ||
      phase === CrashPhase.DuringCandidateBuild ||
      phase === CrashPhase.AfterCandidateCommit
    ) {
      await runtime.service.prepareLanding(prepareInput());
      return;
    }
    if (phase === CrashPhase.AwaitingApproval) {
      const status = runtime.service.getLandingStatus(RUN_ID);
      if (status?.landing.state !== "awaiting_approval") {
        throw new Error("Landing is not awaiting approval");
      }
      pause(markerPath, phase, status);
    }
    if (phase === CrashPhase.AfterApproval) {
      const status = runtime.service.getLandingStatus(RUN_ID);
      const digest = status?.landing.landingSha256;
      if (digest === null || digest === undefined) {
        throw new Error("Landing digest is unavailable");
      }
      const approved = await runtime.service.decideLanding(RUN_ID, digest, OPERATOR, "approve");
      pause(markerPath, phase, approved);
    }
    if (
      phase === CrashPhase.BeforeCas ||
      phase === CrashPhase.DuringCas ||
      phase === CrashPhase.AfterCas ||
      phase === CrashPhase.ExistingBeforeObservation ||
      phase === CrashPhase.BlockObservation
    ) {
      await runtime.service.resumeLanding(RUN_ID);
      return;
    }
    if (phase === CrashPhase.InspectOnce) {
      writeFileSync(resultPath, canonicalLandingJson(runtime.service.getLandingStatus(RUN_ID)), {
        mode: 0o600,
      });
      return;
    }
    if (phase === CrashPhase.RollbackOnce) {
      try {
        const diffSha256 = runtime.store.getRun(RUN_ID).verification?.diffSha256 ?? "";
        await runtime.service.rollback(RUN_ID, diffSha256, OPERATOR);
        writeFileSync(resultPath, JSON.stringify({ ok: true }), { mode: 0o600 });
      } catch (error) {
        writeFileSync(
          resultPath,
          JSON.stringify({
            ok: false,
            code:
              typeof error === "object" && error !== null && "code" in error
                ? (error as { code: unknown }).code
                : null,
          }),
          { mode: 0o600 },
        );
      }
    }
  } finally {
    runtime.close();
  }
}

function launchWorker(fixture: Paths, phase: CrashPhase): Worker {
  const nonce = randomUUID();
  const launchPaths = paths(fixture.root, nonce);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    [PHASE_ENV]: phase,
    [ROOT_ENV]: fixture.root,
    [MARKER_ENV]: launchPaths.markerPath,
    [RESULT_ENV]: launchPaths.resultPath,
  };
  delete environment.VITEST_POOL_ID;
  delete environment.VITEST_WORKER_ID;
  const child = spawn(
    process.execPath,
    [
      path.resolve("node_modules/vitest/vitest.mjs"),
      "run",
      "tests/integration/landing-crash-recovery.test.ts",
      "-t",
      `^${WORKER_TEST}$`,
      "--reporter=dot",
      "--pool=threads",
      "--maxWorkers=1",
      "--no-file-parallelism",
    ],
    {
      cwd: path.resolve("."),
      env: environment,
      detached: true,
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr = (stderr + (typeof chunk === "string" ? chunk : chunk.toString("utf8"))).slice(-8192);
  });
  const exit = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    markerPath: launchPaths.markerPath,
    resultPath: launchPaths.resultPath,
    exit,
    stderr: () => stderr,
  };
}

async function waitForMarker(worker: Worker): Promise<Marker> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (existsSync(worker.markerPath)) {
      return JSON.parse(readFileSync(worker.markerPath, "utf8")) as Marker;
    }
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
      throw new Error(`Worker exited before marker: ${worker.stderr()}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Worker did not reach boundary: ${worker.stderr()}`);
}

async function waitForCasRelease(worker: Worker): Promise<CasRelease> {
  const releasePath = `${worker.markerPath}.released`;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(releasePath)) {
      return JSON.parse(readFileSync(releasePath, "utf8")) as CasRelease;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Prepared update-ref did not release after coordinator death: ${worker.stderr()}`,
  );
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function crashAt(
  fixture: Paths,
  phase: CrashPhase,
  beforeKill?: (marker: Marker) => void | Promise<void>,
): Promise<Marker> {
  const worker = launchWorker(fixture, phase);
  const marker = await waitForMarker(worker);
  await beforeKill?.(marker);
  const coordinatorPid = worker.child.pid;
  if (coordinatorPid === undefined) throw new Error("Worker has no pid");
  killGroup(coordinatorPid);
  if (phase === CrashPhase.DuringCas) {
    try {
      const released = await waitForCasRelease(worker);
      expect(released).toMatchObject({
        phase,
        pid: marker.pid,
        realGitPid: (marker.detail as { realGitPid?: unknown } | undefined)?.realGitPid,
        prepared: true,
        signal: null,
      });
    } catch (error) {
      if (marker.pid !== coordinatorPid) killGroup(marker.pid);
      throw error;
    }
  } else if (marker.pid !== coordinatorPid) {
    killGroup(marker.pid);
  }
  expect(await worker.exit).toEqual({ code: null, signal: "SIGKILL" });
  return marker;
}

async function runWorkerOnce(
  fixture: Paths,
  phase: CrashPhase.InspectOnce | CrashPhase.RollbackOnce,
): Promise<unknown> {
  const worker = launchWorker(fixture, phase);
  expect(await worker.exit, worker.stderr()).toEqual({ code: 0, signal: null });
  return JSON.parse(readFileSync(worker.resultPath, "utf8")) as unknown;
}

const workerPhase = process.env[PHASE_ENV] as CrashPhase | undefined;
if (workerPhase !== undefined) {
  test(WORKER_TEST, async () => {
    const root = process.env[ROOT_ENV];
    const markerPath = process.env[MARKER_ENV];
    const resultPath = process.env[RESULT_ENV];
    expect(root).toBeDefined();
    expect(markerPath).toBeDefined();
    expect(resultPath).toBeDefined();
    await workerMain(root ?? "", workerPhase, markerPath ?? "", resultPath ?? "");
  }, 60_000);
} else {
  describe.runIf(process.platform === "linux")(
    "Packet 3 real-process landing crash recovery",
    () => {
      test("before the landing row transaction leaves no landing or effect", async () => {
        const root = path.join(os.tmpdir(), `icarus-landing-crash-${process.pid}-${Date.now()}`);
        mkdirSync(root, { recursive: false, mode: 0o700 });
        const fixture = paths(root);
        try {
          const marker = await crashAt(fixture, CrashPhase.BeforeLandingRow);
          expect(marker).toMatchObject({
            phase: CrashPhase.BeforeLandingRow,
            detail: {
              boundary: "before_landing_row_transaction",
              calls: {
                inspectBase: 1,
                prepareCandidate: 0,
                observeLocalRef: 0,
                createAbsentLocalRef: 0,
              },
              sourceCheckoutExists: false,
              cacheExists: false,
            },
          });
          expect(existsSync(fixture.sourcePath)).toBe(false);
          expect(existsSync(fixture.cachePath)).toBe(false);

          const store = new IcarusStore(fixture.databasePath, { now: () => NOW });
          const service = await serviceFor(fixture, store);
          try {
            expect(service.getLandingStatus(RUN_ID)).toBeNull();
            await expect(service.resumeLanding(RUN_ID)).rejects.toMatchObject({
              code: "NOT_FOUND",
            });
            expect(service.getLandingStatus(RUN_ID)).toBeNull();
            expect(existsSync(fixture.sourcePath)).toBe(false);
            expect(existsSync(fixture.cachePath)).toBe(false);
          } finally {
            store.close();
          }
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }, 60_000);

      test("candidate intent before object writes cold-resumes the same authority", async () => {
        const fixture = await createRealFixture();
        await crashAt(fixture, CrashPhase.AfterCandidateIntent);

        const runtime = await openRealRuntime(fixture.root);
        try {
          const interrupted = runtime.service.getLandingStatus(RUN_ID);
          expect(interrupted?.landing.state).toBe("preparing_candidate");
          expect(interrupted?.operations.at(-1)).toMatchObject({
            kind: "candidate.prepare",
            status: "started",
          });
          const resumed = await runtime.service.resumeLanding(RUN_ID);
          expect(resumed.landing.state).toBe("awaiting_approval");
          expect(resumed.attempts.map((attempt) => attempt.status)).toEqual([
            "interrupted",
            "completed",
          ]);
          expect(resumed.operations.map((operation) => operation.status)).toEqual([
            "interrupted",
            "completed",
          ]);
          expectNoExternalEffect(fixture);
        } finally {
          runtime.close();
        }
      }, 60_000);

      test("SIGKILL during real candidate construction cleans its stale index on replay", async () => {
        const fixture = await createRealFixture();
        await crashAt(fixture, CrashPhase.DuringCandidateBuild, (marker) => {
          expect(marker.phase).toBe(CrashPhase.DuringCandidateBuild);
          expect(interruptedIndexes(fixture)).toHaveLength(1);
        });
        expect(interruptedIndexes(fixture)).toHaveLength(1);

        const runtime = await openRealRuntime(fixture.root);
        try {
          expect(interruptedIndexes(fixture)).toHaveLength(1);
          const resumed = await runtime.service.resumeLanding(RUN_ID);
          expect(resumed.landing.state).toBe("awaiting_approval");
          expect(interruptedIndexes(fixture)).toEqual([]);
          const replay = await replayCandidate(runtime);
          expect(replay.candidateCommitSha1).toBe(resumed.landing.candidateCommitSha1);
          expect(replay.candidateTreeSha1).toBe(resumed.landing.candidateTreeSha1);
          expectNoExternalEffect(fixture);
        } finally {
          runtime.close();
        }
      }, 60_000);

      test("a written candidate commit is recomputed identically before settlement", async () => {
        const fixture = await createRealFixture();
        const marker = await crashAt(fixture, CrashPhase.AfterCandidateCommit);
        const written = marker.detail as LandingCandidateResult;
        expect(runGitText(fixture.cachePath, ["cat-file", "-t", written.candidateCommitSha1])).toBe(
          "commit",
        );

        const runtime = await openRealRuntime(fixture.root);
        try {
          expect(runtime.service.getLandingStatus(RUN_ID)?.landing.candidateCommitSha1).toBeNull();
          const resumed = await runtime.service.resumeLanding(RUN_ID);
          expect(resumed.landing.candidateCommitSha1).toBe(written.candidateCommitSha1);
          expect(resumed.landing.candidateTreeSha1).toBe(written.candidateTreeSha1);
          const replay = await replayCandidate(runtime);
          expect(replay.candidateCommitSha1).toBe(written.candidateCommitSha1);
          expectNoExternalEffect(fixture);
        } finally {
          runtime.close();
        }
      }, 60_000);

      test("awaiting approval stays inert until one exact durable decision", async () => {
        const fixture = await createRealFixture();
        const awaiting = await prepareAwaiting(fixture);
        const before = canonicalLandingJson(awaiting);
        const marker = await crashAt(fixture, CrashPhase.AwaitingApproval);
        expect(marker.phase).toBe(CrashPhase.AwaitingApproval);

        const runtime = await openRealRuntime(fixture.root);
        try {
          expect(canonicalLandingJson(runtime.service.getLandingStatus(RUN_ID))).toBe(before);
          await expect(runtime.service.resumeLanding(RUN_ID)).rejects.toMatchObject({
            code: "INVALID_LANDING_STATE",
          });
          await expect(
            runtime.service.decideLanding(RUN_ID, "f".repeat(64), OPERATOR, "approve"),
          ).rejects.toMatchObject({ code: "LANDING_DECISION_CONFLICT" });
          const approved = await runtime.service.decideLanding(
            RUN_ID,
            awaiting.landing.landingSha256 ?? "",
            OPERATOR,
            "approve",
          );
          expect(approved.landing.state).toBe("approved");
          expect(runtime.store.getRun(RUN_ID).state).toBe("completed");
          expectNoExternalEffect(fixture);
        } finally {
          runtime.close();
        }
      }, 60_000);

      test("committed approval waits for explicit resume and creates the ref once", async () => {
        const fixture = await createRealFixture();
        await prepareAwaiting(fixture);
        const marker = await crashAt(fixture, CrashPhase.AfterApproval);
        expect(marker.detail).toMatchObject({ landing: { state: "approved" } });

        const runtime = await openRealRuntime(fixture.root);
        try {
          expect(runtime.store.getRun(RUN_ID).state).toBe("completed");
          expect(runtime.service.getLandingStatus(RUN_ID)?.landing.state).toBe("approved");
          expect(refValue(fixture)).toBeNull();
          const ready = await runtime.service.resumeLanding(RUN_ID);
          expect(ready.landing.state).toBe("local_ready");
          expect(refValue(fixture)).toBe(ready.landing.candidateCommitSha1);
          expect(privateRefs(fixture)).toEqual([fixture.headRef]);
          // A further resume at local_ready admits the read-only GitHub
          // preflight. The worker has no credential in its environment, so the
          // attempt fails before any HTTPS request is admitted — the crash
          // matrix's credential-missing row — and the local ref is untouched.
          const replay = await runtime.service.resumeLanding(RUN_ID);
          expect(replay.landing).toMatchObject({
            state: "failed",
            resumeState: "local_ready",
            errorCode: "LANDING_CREDENTIAL_MISSING",
          });
          expect(replay.httpRequests).toEqual([]);
          expect(privateRefs(fixture)).toEqual([fixture.headRef]);
          expect(fixture.requests()).toBe(0);
        } finally {
          runtime.close();
        }
      }, 60_000);

      test("durable absence before CAS reconciles to an explicit retry", async () => {
        const fixture = await createRealFixture();
        await approveLanding(fixture);
        await crashAt(fixture, CrashPhase.BeforeCas);

        const runtime = await openRealRuntime(fixture.root);
        try {
          const interrupted = runtime.service.getLandingStatus(RUN_ID);
          expect(interrupted?.landing.state).toBe("creating_local_ref");
          expect(interrupted?.operations.at(-1)).toMatchObject({
            kind: "local_ref.create",
            status: "started",
            observation: { phase: "pre_effect" },
          });
          const approvedAgain = await runtime.service.resumeLanding(RUN_ID);
          expect(approvedAgain.landing.state).toBe("approved");
          expect(refValue(fixture)).toBeNull();
          const ready = await runtime.service.resumeLanding(RUN_ID);
          expect(ready.landing.state).toBe("local_ready");
          expect(refValue(fixture)).toBe(ready.landing.candidateCommitSha1);
          expect(privateRefs(fixture)).toEqual([fixture.headRef]);
          expect(fixture.requests()).toBe(0);
        } finally {
          runtime.close();
        }
      }, 60_000);

      test.each([
        ["a still-absent ref", "absent"],
        ["the exact candidate ref", "exact"],
        ["a different direct ref", "different"],
      ] as const)(
        "during or after CAS with %s follows only the proved recovery",
        async (_label, outcome) => {
          const fixture = await createRealFixture();
          const approved = await approveLanding(fixture);
          const candidateCommitSha1 = approved.landing.candidateCommitSha1;
          if (candidateCommitSha1 === null) throw new Error("Candidate commit is missing");
          const phase = outcome === "exact" ? CrashPhase.AfterCas : CrashPhase.DuringCas;
          const marker = await crashAt(fixture, phase);
          if (phase === CrashPhase.DuringCas) {
            expect(marker.detail).toMatchObject({
              command: ["update-ref", "--stdin"],
              boundary: "update-ref-transaction-prepared",
              preparedOutput: "start: ok\nprepare: ok\n",
              realGitPid: expect.any(Number),
            });
          }
          if (outcome === "different") setRef(fixture, fixture.baseCommitSha1);
          if (outcome === "exact") {
            expect(marker.detail).toMatchObject({ outcome: "succeeded" });
            expect(refValue(fixture)).toBe(candidateCommitSha1);
          } else if (outcome === "absent") {
            expect(refValue(fixture)).toBeNull();
          } else {
            expect(refValue(fixture)).toBe(fixture.baseCommitSha1);
          }

          const runtime = await openRealRuntime(fixture.root);
          try {
            let resumed = await runtime.service.resumeLanding(RUN_ID);
            if (outcome === "absent") {
              expect(resumed.landing.state).toBe("approved");
              expect(refValue(fixture)).toBeNull();
              resumed = await runtime.service.resumeLanding(RUN_ID);
              expect(resumed.landing.state).toBe("local_ready");
              expect(refValue(fixture)).toBe(candidateCommitSha1);
            } else if (outcome === "exact") {
              expect(resumed.landing.state).toBe("local_ready");
              expect(refValue(fixture)).toBe(candidateCommitSha1);
            } else {
              expect(resumed.landing).toMatchObject({
                state: "reconciliation_required",
                resumeState: "approved",
                errorCode: "LANDING_COORDINATOR_TAKEOVER",
              });
              expect(resumed.operations.at(-1)?.errorCode).toBe("LANDING_LOCAL_REF_CONFLICT");
              expect(refValue(fixture)).toBe(fixture.baseCommitSha1);
            }
            expect(privateRefs(fixture)).toEqual([fixture.headRef]);
            expect(fixture.requests()).toBe(0);
          } finally {
            runtime.close();
          }
        },
        60_000,
      );

      test("a pre-existing exact candidate ref is never adopted without prior absence", async () => {
        const fixture = await createRealFixture();
        const approved = await approveLanding(fixture);
        const candidateCommitSha1 = approved.landing.candidateCommitSha1;
        if (candidateCommitSha1 === null) throw new Error("Candidate commit is missing");
        setRef(fixture, candidateCommitSha1);
        const marker = await crashAt(fixture, CrashPhase.ExistingBeforeObservation);
        expect(marker.detail).toMatchObject({
          outcome: "definitive",
          fact: { state: "direct", objectSha1: candidateCommitSha1 },
        });

        const runtime = await openRealRuntime(fixture.root);
        try {
          const resumed = await runtime.service.resumeLanding(RUN_ID);
          expect(resumed.landing).toMatchObject({
            state: "reconciliation_required",
            resumeState: "approved",
            errorCode: "LANDING_COORDINATOR_TAKEOVER",
          });
          expect(resumed.operations.at(-1)?.errorCode).toBe("LANDING_LOCAL_REF_CONFLICT");
          expect(refValue(fixture)).toBe(candidateCommitSha1);
          expect(privateRefs(fixture)).toEqual([fixture.headRef]);
          expect(fixture.requests()).toBe(0);
        } finally {
          runtime.close();
        }
      }, 60_000);

      test("startup inspection is inert after process death with a started operation", async () => {
        const fixture = await createRealFixture();
        await approveLanding(fixture);
        await crashAt(fixture, CrashPhase.BlockObservation);

        const store = new IcarusStore(fixture.databasePath, { now: () => NOW });
        const before = canonicalLandingJson(store.getLandingStatusForRun(RUN_ID));
        store.close();
        const inspected = await runWorkerOnce(fixture, CrashPhase.InspectOnce);
        expect(canonicalLandingJson(inspected)).toBe(before);
        expect(refValue(fixture)).toBeNull();
        expect(fixture.requests()).toBe(0);

        const runtime = await openRealRuntime(fixture.root);
        try {
          expect(canonicalLandingJson(runtime.service.getLandingStatus(RUN_ID))).toBe(before);
          const approvedAgain = await runtime.service.resumeLanding(RUN_ID);
          expect(approvedAgain.landing.state).toBe("approved");
          const ready = await runtime.service.resumeLanding(RUN_ID);
          expect(ready.landing.state).toBe("local_ready");
          expect(refValue(fixture)).toBe(ready.landing.candidateCommitSha1);
          expect(fixture.requests()).toBe(0);
        } finally {
          runtime.close();
        }
      }, 60_000);

      test("concurrent landing and rollback processes admit exactly one run mutation", async () => {
        const fixture = await createRealFixture();
        const landingWorker = launchWorker(fixture, CrashPhase.AfterCandidateIntent);
        const marker = await waitForMarker(landingWorker);
        expect(marker.phase).toBe(CrashPhase.AfterCandidateIntent);
        try {
          const rollback = await runWorkerOnce(fixture, CrashPhase.RollbackOnce);
          expect(rollback).toEqual({ ok: false, code: "RUN_BUSY" });
        } finally {
          const coordinatorPid = landingWorker.child.pid;
          if (coordinatorPid !== undefined) killGroup(coordinatorPid);
          if (coordinatorPid === undefined || marker.pid !== coordinatorPid) {
            killGroup(marker.pid);
          }
          expect(await landingWorker.exit).toEqual({ code: null, signal: "SIGKILL" });
        }

        const runtime = await openRealRuntime(fixture.root);
        try {
          expect(runtime.store.getRun(RUN_ID).state).toBe("completed");
          const interrupted = runtime.service.getLandingStatus(RUN_ID);
          expect(interrupted?.landing.state).toBe("preparing_candidate");
          expect(interrupted?.operations.at(-1)).toMatchObject({
            kind: "candidate.prepare",
            status: "started",
          });
          const resumed = await runtime.service.resumeLanding(RUN_ID);
          expect(resumed.landing.state).toBe("awaiting_approval");
          expect(resumed.attempts.map((attempt) => attempt.status)).toEqual([
            "interrupted",
            "completed",
          ]);
          expectNoExternalEffect(fixture);
        } finally {
          runtime.close();
        }
      }, 60_000);

      test("successive coordinator deaths exhaust attempt eight without a ninth effect", async () => {
        const fixture = await createRealFixture();
        await approveLanding(fixture);

        for (let ordinal = 2; ordinal <= 8; ordinal += 1) {
          await crashAt(fixture, CrashPhase.BlockObservation);
          const store = new IcarusStore(fixture.databasePath, { now: () => NOW });
          try {
            const status = store.getLandingStatusForRun(RUN_ID);
            expect(status?.landing.attemptCount).toBe(ordinal);
            expect(status?.attempts.at(-1)?.status).toBe("started");
          } finally {
            store.close();
          }
        }

        const runtime = await openRealRuntime(fixture.root);
        try {
          await expect(runtime.service.resumeLanding(RUN_ID)).rejects.toMatchObject({
            code: "LANDING_ATTEMPT_LIMIT",
          });
          const exhausted = runtime.service.getLandingStatus(RUN_ID);
          expect(exhausted?.landing).toMatchObject({
            state: "reconciliation_required",
            resumeState: "approved",
            attemptCount: 8,
          });
          expect(exhausted?.attempts.map((attempt) => attempt.status)).toEqual([
            "completed",
            "interrupted",
            "interrupted",
            "interrupted",
            "interrupted",
            "interrupted",
            "interrupted",
            "interrupted",
          ]);
          expect(exhausted?.operations.some((operation) => operation.status === "started")).toBe(
            false,
          );
          expect(
            exhausted?.operations.filter((operation) => operation.kind === "local_ref.create"),
          ).toHaveLength(1);
          expect(
            exhausted?.operations.filter((operation) => operation.kind === "landing.reconcile"),
          ).toHaveLength(6);
          const beforeReplay = canonicalLandingJson(exhausted);
          await expect(runtime.service.resumeLanding(RUN_ID)).rejects.toMatchObject({
            code: "LANDING_ATTEMPT_LIMIT",
          });
          expect(canonicalLandingJson(runtime.service.getLandingStatus(RUN_ID))).toBe(beforeReplay);
          expect(refValue(fixture)).toBeNull();
          expect(fixture.requests()).toBe(0);
        } finally {
          runtime.close();
        }
      }, 180_000);

      const REMOTE_STAGE_FIXTURE_NOTE =
        "remote stage crash phases reopen through the deterministic loopback transport";

      test.each([
        [
          CrashPhase.PreflightBeforeActorGet,
          { boundary: "before-request-admission", kind: "github.actor.get" },
          0,
          0,
        ],
        [
          CrashPhase.PreflightDuringActorGet,
          { boundary: "github-read-in-flight", read: "actor", authorized: true },
          1,
          1,
        ],
        [
          CrashPhase.PreflightAfterActorGet,
          { boundary: "after-request-settlement", requestOrdinal: 1 },
          1,
          0,
        ],
        [
          CrashPhase.PreflightBeforeBaseGet,
          { boundary: "before-request-admission", kind: "github.base_ref.get" },
          1,
          0,
        ],
        [
          CrashPhase.PreflightDuringBaseGet,
          { boundary: "github-read-in-flight", read: "base", authorized: true },
          2,
          1,
        ],
        [
          CrashPhase.PreflightAfterBaseGet,
          { boundary: "after-request-settlement", requestOrdinal: 2 },
          2,
          0,
        ],
        [
          CrashPhase.PreflightBeforeHeadGet,
          { boundary: "before-request-admission", kind: "github.head_ref.get" },
          2,
          0,
        ],
        [
          CrashPhase.PreflightDuringHeadGet,
          { boundary: "github-read-in-flight", read: "head", authorized: true },
          3,
          1,
        ],
        [
          CrashPhase.PreflightAfterHeadGet,
          { boundary: "after-request-settlement", requestOrdinal: 3 },
          3,
          0,
        ],
        [CrashPhase.PreflightBeforeSettlement, { boundary: "before-operation-settlement" }, 3, 0],
      ] as const)(
        "crash at %s replays the preflight-then-upload chain without duplicate or ambiguous effects",
        async (phase, markerExpectation, crashedRows, ambiguousRows) => {
          const fixture = await createRealFixture();
          await approveLanding(fixture);
          const marker = await crashAt(fixture, phase);
          expect(marker.phase).toBe(phase);
          expect(marker.detail).toMatchObject(markerExpectation);

          // Reopen cold: the durable state tells the truth before any resume.
          const inspection = new IcarusStore(fixture.databasePath, { now: () => NOW });
          try {
            const interrupted = inspection.getLandingStatusForRun(RUN_ID);
            expect(interrupted?.landing).toMatchObject({
              state: "local_ready",
              errorCode: null,
            });
            expect(interrupted?.attempts.map((attempt) => attempt.status)).toEqual([
              "completed",
              "completed",
              "started",
            ]);
            expect(
              interrupted?.operations.map((operation) => [operation.kind, operation.status]),
            ).toEqual([
              ["candidate.prepare", "completed"],
              ["local_ref.create", "completed"],
              ["github.preflight", "started"],
            ]);
            expect(interrupted?.httpRequests).toHaveLength(crashedRows);
            if (ambiguousRows === 1) {
              expect(interrupted?.httpRequests.at(-1)).toMatchObject({ status: "admitted" });
            }
          } finally {
            inspection.close();
          }

          const { runtime, loopback } = await reopenPreflightWithLoopback(fixture);
          try {
            const resumed = await runtime.service.resumeLanding(RUN_ID);
            expect(resumed.landing).toMatchObject({ state: "objects_ready", errorCode: null });
            expect(resumed.attempts.map((attempt) => attempt.status)).toEqual([
              "completed",
              "completed",
              "interrupted",
              "completed",
            ]);
            expect(
              resumed.operations
                .filter((operation) => operation.kind === "github.preflight")
                .map((operation) => [operation.kindAttempt, operation.status]),
            ).toEqual([
              [1, "interrupted"],
              [2, "completed"],
            ]);
            expect(resumed.operations.at(-1)).toMatchObject({
              kind: "github.objects.upload",
              status: "completed",
            });
            // No read is ever duplicated: the crashed attempt's rows stay
            // settled, and the replay's seven reads are fresh identities.
            expect(resumed.httpRequests).toHaveLength(crashedRows + 7);
            expect(new Set(resumed.httpRequests.map((row) => row.id)).size).toBe(crashedRows + 7);
            expect(
              resumed.httpRequests.filter(
                (row) => row.coordinatorAttempt === 3 && row.outcome === "ambiguous",
              ),
            ).toHaveLength(ambiguousRows);
            for (const ambiguous of resumed.httpRequests.filter(
              (row) => row.outcome === "ambiguous",
            )) {
              expect(ambiguous).toMatchObject({
                httpStatus: null,
                errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
              });
            }
            expect(
              resumed.httpRequests
                .filter((row) => row.coordinatorAttempt === 4)
                .map((row) => row.requestOrdinal),
            ).toEqual([1, 2, 3, 4, 5, 6, 7]);
            const interrupted = resumed.operations.find(
              (operation) =>
                operation.kind === "github.preflight" && operation.status === "interrupted",
            );
            expect(interrupted?.errorCode).toBe("LANDING_COORDINATOR_TAKEOVER");
            expect(interrupted?.result?.evidence).toHaveLength(crashedRows);
            expect(
              resumed.events
                .filter((event) => event.type === "landing.state.changed")
                .map((event) => {
                  const payload = event.payload as {
                    readonly from: string;
                    readonly to: string;
                  };
                  return `${payload.from}->${payload.to}`;
                }),
            ).toEqual([
              "preparing_candidate->awaiting_approval",
              "awaiting_approval->approved",
              "approved->creating_local_ref",
              "creating_local_ref->local_ready",
              "local_ready->uploading_objects",
              "uploading_objects->objects_ready",
            ]);
            expect(loopback.requests).toHaveLength(7);
            expect([...loopback.authorizationChecks]).toEqual(
              Array.from({ length: 7 }, () => true),
            );
            expect(readFileSync(fixture.databasePath).includes(Buffer.from(PREFLIGHT_TOKEN))).toBe(
              false,
            );
            expect(refValue(fixture)).toBe(resumed.landing.candidateCommitSha1);
            expect(privateRefs(fixture)).toEqual([fixture.headRef]);
            expect(fixture.requests()).toBe(0);
          } finally {
            runtime.close();
            await loopback.server.close();
          }
        },
        60_000,
      );

      test("crash after the preflight settlement commit replays the chain without duplication", async () => {
        const fixture = await createRealFixture();
        await approveLanding(fixture);
        const marker = await crashAt(fixture, CrashPhase.PreflightAfterSettlement);
        expect(marker.detail).toMatchObject({ boundary: "after-operation-settlement" });

        // The preflight completed but its attempt never closed: the crash
        // landed in the between-operations window.
        const inspection = new IcarusStore(fixture.databasePath, { now: () => NOW });
        try {
          const completed = inspection.getLandingStatusForRun(RUN_ID);
          expect(completed?.landing).toMatchObject({ state: "local_ready", errorCode: null });
          expect(completed?.attempts.map((attempt) => attempt.status)).toEqual([
            "completed",
            "completed",
            "started",
          ]);
          expect(completed?.operations.at(-1)).toMatchObject({
            kind: "github.preflight",
            status: "completed",
          });
          expect(completed?.httpRequests.map((row) => row.outcome)).toEqual([
            "succeeded",
            "succeeded",
            "succeeded",
          ]);
        } finally {
          inspection.close();
        }

        const { runtime, loopback } = await reopenPreflightWithLoopback(fixture);
        try {
          const resumed = await runtime.service.resumeLanding(RUN_ID);
          expect(resumed.landing).toMatchObject({ state: "objects_ready", errorCode: null });
          expect(resumed.attempts.map((attempt) => attempt.status)).toEqual([
            "completed",
            "completed",
            "interrupted",
            "completed",
          ]);
          expect(
            resumed.operations
              .filter((operation) => operation.kind === "github.preflight")
              .map((operation) => [operation.kindAttempt, operation.status]),
          ).toEqual([
            [1, "completed"],
            [2, "completed"],
          ]);
          expect(resumed.httpRequests).toHaveLength(10);
          expect(new Set(resumed.httpRequests.map((row) => row.id)).size).toBe(10);
          expect(
            resumed.httpRequests
              .filter((row) => row.coordinatorAttempt === 4)
              .map((row) => row.requestOrdinal),
          ).toEqual([1, 2, 3, 4, 5, 6, 7]);
          expect(loopback.requests).toHaveLength(7);
          expect([...loopback.authorizationChecks]).toEqual(Array.from({ length: 7 }, () => true));
          expect(readFileSync(fixture.databasePath).includes(Buffer.from(PREFLIGHT_TOKEN))).toBe(
            false,
          );
          expect(fixture.requests()).toBe(0);
        } finally {
          runtime.close();
          await loopback.server.close();
        }
      }, 60_000);

      const UPLOAD_PHASES: ReadonlyArray<readonly [CrashPhase, number, number, boolean]> = [
        [CrashPhase.UploadBeforeBlobPost, 4, 0, false],
        [CrashPhase.UploadDuringBlobPost, 5, 0, true],
        [CrashPhase.UploadAfterBlobPost, 5, 1, false],
        [CrashPhase.UploadBeforeTreePost, 5, 1, false],
        [CrashPhase.UploadDuringTreePost, 6, 1, true],
        [CrashPhase.UploadAfterTreePost, 6, 2, false],
        [CrashPhase.UploadBeforeCommitPost, 6, 2, false],
        [CrashPhase.UploadDuringCommitPost, 7, 2, true],
        [CrashPhase.UploadAfterCommitPost, 7, 3, false],
        [CrashPhase.UploadBeforeSettlement, 7, 3, false],
      ];

      for (const [phase, crashedRows, settledPosts, inFlight] of UPLOAD_PHASES) {
        test(`crash at ${phase} proves the object upload replay-safe`, async () => {
          const fixture = await createRealFixture();
          await approveLanding(fixture);
          const marker = await crashAt(fixture, phase);
          expect(marker.phase).toBe(phase);

          const completeAtCrash = settledPosts === 3;
          const inspection = new IcarusStore(fixture.databasePath, { now: () => NOW });
          try {
            const interrupted = inspection.getLandingStatusForRun(RUN_ID);
            expect(interrupted?.landing).toMatchObject({
              state: "uploading_objects",
              errorCode: null,
            });
            expect(interrupted?.attempts.map((attempt) => attempt.status)).toEqual([
              "completed",
              "completed",
              "started",
            ]);
            expect(interrupted?.operations.at(-1)).toMatchObject({
              kind: "github.objects.upload",
              status: "started",
            });
            expect(interrupted?.httpRequests).toHaveLength(crashedRows);
            expect(interrupted?.httpRequests.filter((row) => row.method === "POST")).toHaveLength(
              settledPosts + (inFlight ? 1 : 0),
            );
            if (inFlight) {
              expect(interrupted?.httpRequests.at(-1)).toMatchObject({ status: "admitted" });
            }
          } finally {
            inspection.close();
          }

          const { runtime, loopback } = await reopenPreflightWithLoopback(fixture);
          try {
            let resumed = await runtime.service.resumeLanding(RUN_ID);
            if (completeAtCrash) {
              // Every object landed before the crash: reconciliation proves
              // the stage with zero new remote requests.
              expect(resumed.landing).toMatchObject({
                state: "objects_ready",
                errorCode: null,
              });
              expect(resumed.httpRequests).toHaveLength(crashedRows);
              const reconcile = resumed.operations.at(-1);
              expect(reconcile).toMatchObject({
                kind: "landing.reconcile",
                status: "completed",
              });
              expect(reconcile?.result).toMatchObject({
                boundary: "subject_settled",
                value: { nextState: "objects_ready", remoteResidue: "none" },
              });
              expect(loopback.requests).toHaveLength(0);
              return;
            }
            // An incomplete upload reconciles to the byte-identical retry at
            // local_ready, then one fresh attempt replays the exact bodies.
            expect(resumed.landing).toMatchObject({
              state: "local_ready",
              errorCode: null,
            });
            expect(resumed.operations.at(-1)?.result).toMatchObject({
              boundary: "retry_stage_proven",
              value: { nextState: "local_ready", remoteResidue: "none" },
            });
            resumed = await runtime.service.resumeLanding(RUN_ID);
            expect(resumed.landing).toMatchObject({ state: "objects_ready", errorCode: null });
            const uploads = resumed.operations.filter(
              (operation) => operation.kind === "github.objects.upload",
            );
            expect(uploads.map((operation) => [operation.kindAttempt, operation.status])).toEqual([
              [1, "interrupted"],
              [2, "completed"],
            ]);
            // Byte-identical replay: the retried upload's POST rows carry the
            // same subjects and body digests wherever the first attempt
            // reached, never new content.
            const firstPosts = resumed.httpRequests.filter(
              (row) => row.operationId === uploads[0]?.id && row.method === "POST",
            );
            const secondPosts = resumed.httpRequests.filter(
              (row) => row.operationId === uploads[1]?.id && row.method === "POST",
            );
            expect(secondPosts).toHaveLength(3);
            for (const [index, row] of secondPosts.entries()) {
              const prior = firstPosts[index];
              expect(row.request.bodySha256).not.toBeNull();
              if (prior !== undefined) {
                expect(row.request.bodySha256).toBe(prior.request.bodySha256);
                expect(canonicalLandingJson(row.request.subject)).toBe(
                  canonicalLandingJson(prior.request.subject),
                );
              }
              expect(row.outcome).toBe("succeeded");
            }
            expect(new Set(resumed.httpRequests.map((row) => row.id)).size).toBe(
              resumed.httpRequests.length,
            );
            // The remote ref is never created as a side effect of an upload.
            expect(resumed.httpRequests.some((row) => row.kind === "github.ref.post")).toBe(false);
            expect(readFileSync(fixture.databasePath).includes(Buffer.from(PREFLIGHT_TOKEN))).toBe(
              false,
            );
            expect(fixture.requests()).toBe(0);
          } finally {
            runtime.close();
            await loopback.server.close();
          }
        }, 60_000);
      }

      test("crash after the upload settlement commit continues at the ref stage", async () => {
        const fixture = await createRealFixture();
        await approveLanding(fixture);
        const marker = await crashAt(fixture, CrashPhase.UploadAfterSettlement);
        expect(marker.detail).toMatchObject({ boundary: "after-operation-settlement" });

        const inspection = new IcarusStore(fixture.databasePath, { now: () => NOW });
        try {
          const completed = inspection.getLandingStatusForRun(RUN_ID);
          expect(completed?.landing).toMatchObject({ state: "objects_ready", errorCode: null });
          expect(completed?.operations.at(-1)).toMatchObject({
            kind: "github.objects.upload",
            status: "completed",
          });
        } finally {
          inspection.close();
        }

        const { runtime, loopback } = await reopenPreflightWithLoopback(fixture);
        try {
          const resumed = await runtime.service.resumeLanding(RUN_ID);
          expect(resumed.landing).toMatchObject({ state: "remote_ready", errorCode: null });
          expect(
            resumed.operations.filter((operation) => operation.kind === "github.objects.upload"),
          ).toHaveLength(1);
          expect(resumed.operations.at(-1)?.result).toMatchObject({
            boundary: "remote_ref_ready",
            value: { remoteRefOutcome: "created" },
          });
          expect(resumed.httpRequests.filter((row) => row.kind === "github.ref.post")).toHaveLength(
            1,
          );
          expect(fixture.requests()).toBe(0);
        } finally {
          runtime.close();
          await loopback.server.close();
        }
      }, 60_000);

      test("crash before the remote-ref POST admission replays the absent-only create once", async () => {
        const fixture = await createRealFixture();
        await approveLanding(fixture);
        const marker = await crashAt(fixture, CrashPhase.RemoteRefBeforePost);
        expect(marker.detail).toMatchObject({
          boundary: "before-request-admission",
          kind: "github.ref.post",
        });

        const { runtime, loopback } = await reopenPreflightWithLoopback(fixture);
        try {
          let resumed = await runtime.service.resumeLanding(RUN_ID);
          // No POST was admitted, so nothing can have happened remotely: the
          // reconciliation authorizes the retry from the durable rows alone.
          expect(resumed.landing).toMatchObject({
            state: "objects_ready",
            errorCode: null,
          });
          resumed = await runtime.service.resumeLanding(RUN_ID);
          expect(resumed.landing).toMatchObject({ state: "remote_ready", errorCode: null });
          // Exactly one absent-only create exists over the whole recovery:
          // the crashed operation never admitted its POST.
          const refPosts = resumed.httpRequests.filter((row) => row.kind === "github.ref.post");
          expect(refPosts).toHaveLength(1);
          expect(refPosts[0]?.outcome).toBe("succeeded");
          expect(
            resumed.operations
              .filter((operation) => operation.kind === "github.ref.create")
              .map((operation) => [operation.kindAttempt, operation.status]),
          ).toEqual([
            [1, "interrupted"],
            [2, "completed"],
          ]);
          expect(fixture.requests()).toBe(0);
        } finally {
          runtime.close();
          await loopback.server.close();
        }
      }, 60_000);

      for (const remoteState of ["absent", "exact"] as const) {
        test(`crash during the remote-ref POST with the remote ${remoteState} follows only the proved recovery`, async () => {
          const fixture = await createRealFixture();
          await approveLanding(fixture);
          const marker = await crashAt(fixture, CrashPhase.RemoteRefDuringPost);
          expect(marker.detail).toMatchObject({
            boundary: "github-post-in-flight",
            post: "ref",
            authorized: true,
          });
          const candidateCommitSha1 = (() => {
            const probe = new IcarusStore(fixture.databasePath, { now: () => NOW });
            try {
              return probe.getLandingStatusForRun(RUN_ID)?.landing.candidateCommitSha1 ?? "";
            } finally {
              probe.close();
            }
          })();

          const inspection = new IcarusStore(fixture.databasePath, { now: () => NOW });
          try {
            const interrupted = inspection.getLandingStatusForRun(RUN_ID);
            expect(interrupted?.landing).toMatchObject({
              state: "creating_remote_ref",
              errorCode: null,
            });
            expect(interrupted?.operations.at(-1)).toMatchObject({
              kind: "github.ref.create",
              status: "started",
            });
            expect(interrupted?.httpRequests.at(-1)).toMatchObject({
              kind: "github.ref.post",
              status: "admitted",
            });
          } finally {
            inspection.close();
          }

          const { runtime, loopback } = await reopenPreflightWithLoopback(fixture, {
            remoteRefs: remoteState === "exact" ? { [fixture.headRef]: candidateCommitSha1 } : {},
          });
          try {
            let resumed = await runtime.service.resumeLanding(RUN_ID);
            if (remoteState === "exact") {
              // The lost POST actually landed: one exact branch is proven and
              // reconciled — never a second create, never an adopted mystery.
              expect(resumed.landing).toMatchObject({
                state: "remote_ready",
                errorCode: null,
              });
              expect(
                resumed.httpRequests.filter((row) => row.kind === "github.ref.post"),
              ).toHaveLength(1);
              const reconcile = resumed.operations.at(-1);
              expect(reconcile?.result).toMatchObject({
                boundary: "subject_settled",
                value: {
                  nextState: "remote_ready",
                  remoteResidue: "branch",
                  stageValue: { remoteRefOutcome: "reconciled" },
                },
              });
              return;
            }
            // An absent head proves the POST had no effect: the same
            // absent-only POST runs again in a fresh operation, byte-identical.
            expect(resumed.landing).toMatchObject({
              state: "objects_ready",
              errorCode: null,
            });
            expect(resumed.operations.at(-1)?.result).toMatchObject({
              boundary: "retry_stage_proven",
              value: { nextState: "objects_ready", remoteResidue: "none" },
            });
            resumed = await runtime.service.resumeLanding(RUN_ID);
            expect(resumed.landing).toMatchObject({ state: "remote_ready", errorCode: null });
            const refCreates = resumed.operations.filter(
              (operation) => operation.kind === "github.ref.create",
            );
            expect(
              refCreates.map((operation) => [operation.kindAttempt, operation.status]),
            ).toEqual([
              [1, "interrupted"],
              [2, "completed"],
            ]);
            const refPosts = resumed.httpRequests.filter((row) => row.kind === "github.ref.post");
            expect(refPosts).toHaveLength(2);
            expect(refPosts[1]?.request.bodySha256).toBe(refPosts[0]?.request.bodySha256);
            expect(refPosts[1]?.id).not.toBe(refPosts[0]?.id);
            expect(resumed.operations.at(-1)?.result).toMatchObject({
              boundary: "remote_ref_ready",
              value: { remoteRefOutcome: "created" },
            });
            expect(fixture.requests()).toBe(0);
          } finally {
            runtime.close();
            await loopback.server.close();
          }
        }, 60_000);
      }

      test("crash after the remote-ref settlement commit resumes remote_ready into landed", async () => {
        const fixture = await createRealFixture();
        await approveLanding(fixture);
        const marker = await crashAt(fixture, CrashPhase.RemoteRefAfterSettlement);
        expect(marker.detail).toMatchObject({ boundary: "after-operation-settlement" });

        const candidateCommitSha1 = (() => {
          const probe = new IcarusStore(fixture.databasePath, { now: () => NOW });
          try {
            const interrupted = probe.getLandingStatusForRun(RUN_ID);
            expect(interrupted?.landing).toMatchObject({ state: "remote_ready", errorCode: null });
            expect(interrupted?.operations.at(-1)).toMatchObject({
              kind: "github.ref.create",
              status: "completed",
            });
            return interrupted?.landing.candidateCommitSha1 ?? "";
          } finally {
            probe.close();
          }
        })();

        // The draft-PR slice is admitted: the remote_ready preflight re-proves
        // the exact head and the empty pull-request list, then the one POST
        // lands and the receipt commits.
        const { runtime, loopback } = await reopenPreflightWithLoopback(fixture, {
          remoteRefs: { [fixture.headRef]: candidateCommitSha1 },
        });
        try {
          const landed = await runtime.service.resumeLanding(RUN_ID);
          expect(landed.landing).toMatchObject({ state: "landed", errorCode: null });
          expect(landed.receipt?.pullRequestOutcome).toBe("created");
          expect(
            landed.httpRequests.filter((row) => row.kind === "github.pull_request.post"),
          ).toHaveLength(1);
          // `landed` is terminal: resume refuses with zero new remote calls.
          const requestsBefore = loopback.requests.length;
          await expect(runtime.service.resumeLanding(RUN_ID)).rejects.toMatchObject({
            code: "INVALID_LANDING_STATE",
          });
          expect(loopback.requests).toHaveLength(requestsBefore);
          expect(fixture.requests()).toBe(0);
        } finally {
          runtime.close();
          await loopback.server.close();
        }
      }, 60_000);

      test("crash before the draft-PR POST admission still admits exactly one POST ever", async () => {
        const fixture = await createRealFixture();
        await approveLanding(fixture);
        const marker = await crashAt(fixture, CrashPhase.DraftPrBeforePost);
        expect(marker.detail).toMatchObject({
          boundary: "before-request-admission",
          kind: "github.pull_request.post",
        });

        const candidateCommitSha1 = (() => {
          const probe = new IcarusStore(fixture.databasePath, { now: () => NOW });
          try {
            const interrupted = probe.getLandingStatusForRun(RUN_ID);
            expect(interrupted?.landing).toMatchObject({
              state: "opening_draft_pr",
              errorCode: null,
            });
            expect(interrupted?.operations.at(-1)).toMatchObject({
              kind: "github.pull_request.create",
              status: "started",
            });
            expect(
              interrupted?.httpRequests.some((row) => row.kind === "github.pull_request.post"),
            ).toBe(false);
            return interrupted?.landing.candidateCommitSha1 ?? "";
          } finally {
            probe.close();
          }
        })();

        const { runtime, loopback } = await reopenPreflightWithLoopback(fixture, {
          remoteRefs: { [fixture.headRef]: candidateCommitSha1 },
        });
        try {
          // The interrupted operation never admitted its POST: reconciliation
          // proves the complete empty list and authorizes the retry from
          // remote_ready from the durable rows alone.
          let resumed = await runtime.service.resumeLanding(RUN_ID);
          expect(resumed.landing).toMatchObject({ state: "remote_ready", errorCode: null });
          resumed = await runtime.service.resumeLanding(RUN_ID);
          expect(resumed.landing).toMatchObject({ state: "landed", errorCode: null });
          const posts = resumed.httpRequests.filter(
            (row) => row.kind === "github.pull_request.post",
          );
          expect(posts).toHaveLength(1);
          expect(posts[0]?.outcome).toBe("succeeded");
          expect(resumed.receipt?.pullRequestOutcome).toBe("created");
          expect(
            resumed.operations
              .filter((operation) => operation.kind === "github.pull_request.create")
              .map((operation) => [operation.kindAttempt, operation.status]),
          ).toEqual([
            [1, "interrupted"],
            [2, "completed"],
          ]);
          expect(fixture.requests()).toBe(0);
        } finally {
          runtime.close();
          await loopback.server.close();
        }
      }, 60_000);

      for (const remoteState of ["absent", "exact"] as const) {
        test(`crash during the draft-PR POST with the remote ${remoteState} never admits a second POST`, async () => {
          const fixture = await createRealFixture();
          await approveLanding(fixture);
          const marker = await crashAt(fixture, CrashPhase.DraftPrDuringPost);
          expect(marker.detail).toMatchObject({
            boundary: "github-post-in-flight",
            post: "pr",
            authorized: true,
          });

          const crashed = (() => {
            const probe = new IcarusStore(fixture.databasePath, { now: () => NOW });
            try {
              const interrupted = probe.getLandingStatusForRun(RUN_ID);
              expect(interrupted?.landing).toMatchObject({
                state: "opening_draft_pr",
                errorCode: null,
              });
              expect(interrupted?.operations.at(-1)).toMatchObject({
                kind: "github.pull_request.create",
                status: "started",
              });
              // The POST was admitted but never settled: the response is lost.
              expect(interrupted?.httpRequests.at(-1)).toMatchObject({
                kind: "github.pull_request.post",
                status: "admitted",
              });
              return {
                candidateCommitSha1: interrupted?.landing.candidateCommitSha1 ?? "",
                pullRequestTitle: interrupted?.landing.pullRequestTitle ?? "",
                pullRequestBody:
                  probe.getRunLandingProjection(RUN_ID).landing?.pullRequestBody ?? "",
              };
            } finally {
              probe.close();
            }
          })();

          const { runtime, loopback } = await reopenPreflightWithLoopback(fixture, {
            remoteRefs: { [fixture.headRef]: crashed.candidateCommitSha1 },
            ...(remoteState === "exact"
              ? {
                  initialPullRequest: {
                    title: crashed.pullRequestTitle,
                    body: crashed.pullRequestBody,
                    number: 701,
                  },
                }
              : {}),
          });
          try {
            if (remoteState === "exact") {
              // The lost POST actually landed: the takeover settles its row
              // ambiguous and the fresh complete list proves the one
              // conforming pull request — reconciled, never a second create.
              const resumed = await runtime.service.resumeLanding(RUN_ID);
              expect(resumed.landing).toMatchObject({ state: "landed", errorCode: null });
              expect(
                resumed.httpRequests.filter((row) => row.kind === "github.pull_request.post"),
              ).toHaveLength(1);
              expect(resumed.receipt?.pullRequestOutcome).toBe("reconciled");
              const receiptJson = canonicalLandingJson(resumed.receipt);
              const requestsBefore = loopback.requests.length;
              await expect(runtime.service.resumeLanding(RUN_ID)).rejects.toMatchObject({
                code: "INVALID_LANDING_STATE",
              });
              expect(loopback.requests).toHaveLength(requestsBefore);
              expect(canonicalLandingJson(runtime.service.getLandingStatus(RUN_ID)?.receipt)).toBe(
                receiptJson,
              );
              expect(
                readFileSync(fixture.databasePath).includes(Buffer.from(PREFLIGHT_TOKEN)),
              ).toBe(false);
              expect(fixture.requests()).toBe(0);
              return;
            }
            // The complete empty list proves the lost POST had no effect, but
            // the spent admission forbids the retry mapping: the landing holds
            // for the operator, and a further resume still admits no POST.
            const held = await runtime.service.resumeLanding(RUN_ID);
            expect(held.landing).toMatchObject({
              state: "reconciliation_required",
              resumeState: "remote_ready",
            });
            expect(held.receipt).toBeNull();
            const heldAgain = await runtime.service.resumeLanding(RUN_ID);
            expect(heldAgain.landing).toMatchObject({
              state: "reconciliation_required",
              resumeState: "remote_ready",
            });
            expect(
              heldAgain.httpRequests.filter((row) => row.kind === "github.pull_request.post"),
            ).toHaveLength(1);
            expect(loopback.requests.filter((request) => request.method === "POST")).toHaveLength(
              0,
            );
            expect(fixture.requests()).toBe(0);
          } finally {
            runtime.close();
            await loopback.server.close();
          }
        }, 60_000);
      }

      test("crash before the draft-PR settlement commit replays the receipt exactly once", async () => {
        const fixture = await createRealFixture();
        await approveLanding(fixture);
        const marker = await crashAt(fixture, CrashPhase.DraftPrBeforeSettlement);
        expect(marker.detail).toMatchObject({
          boundary: "before-operation-settlement",
          kind: "github.pull_request.create",
        });

        const crashed = (() => {
          const probe = new IcarusStore(fixture.databasePath, { now: () => NOW });
          try {
            const interrupted = probe.getLandingStatusForRun(RUN_ID);
            // The POST and its suffix reads are settled; the settlement
            // transaction — operation, receipt, and the landed transition —
            // never committed, so no receipt exists yet.
            expect(interrupted?.landing).toMatchObject({
              state: "opening_draft_pr",
              errorCode: null,
            });
            expect(interrupted?.receipt).toBeNull();
            expect(interrupted?.operations.at(-1)).toMatchObject({
              kind: "github.pull_request.create",
              status: "started",
            });
            const post = interrupted?.httpRequests.find(
              (row) => row.kind === "github.pull_request.post",
            );
            expect(post).toMatchObject({ status: "settled", outcome: "succeeded" });
            return {
              candidateCommitSha1: interrupted?.landing.candidateCommitSha1 ?? "",
              pullRequestTitle: interrupted?.landing.pullRequestTitle ?? "",
              pullRequestBody: probe.getRunLandingProjection(RUN_ID).landing?.pullRequestBody ?? "",
            };
          } finally {
            probe.close();
          }
        })();

        const { runtime, loopback } = await reopenPreflightWithLoopback(fixture, {
          remoteRefs: { [fixture.headRef]: crashed.candidateCommitSha1 },
          initialPullRequest: {
            title: crashed.pullRequestTitle,
            body: crashed.pullRequestBody,
            number: 701,
          },
        });
        try {
          const resumed = await runtime.service.resumeLanding(RUN_ID);
          expect(resumed.landing).toMatchObject({ state: "landed", errorCode: null });
          // Exactly one POST and exactly one receipt over the whole recovery:
          // the reconciliation proof, not the settled POST response, writes it.
          expect(
            resumed.httpRequests.filter((row) => row.kind === "github.pull_request.post"),
          ).toHaveLength(1);
          expect(resumed.receipt?.pullRequestOutcome).toBe("reconciled");
          const receiptJson = canonicalLandingJson(resumed.receipt);
          const requestsBefore = loopback.requests.length;
          await expect(runtime.service.resumeLanding(RUN_ID)).rejects.toMatchObject({
            code: "INVALID_LANDING_STATE",
          });
          expect(loopback.requests).toHaveLength(requestsBefore);
          expect(canonicalLandingJson(runtime.service.getLandingStatus(RUN_ID)?.receipt)).toBe(
            receiptJson,
          );
          expect(fixture.requests()).toBe(0);
        } finally {
          runtime.close();
          await loopback.server.close();
        }
      }, 60_000);

      test("crash after the draft-PR settlement commit leaves landed terminal with its receipt durable", async () => {
        const fixture = await createRealFixture();
        await approveLanding(fixture);
        const marker = await crashAt(fixture, CrashPhase.DraftPrAfterSettlement);
        expect(marker.detail).toMatchObject({
          boundary: "after-operation-settlement",
          kind: "github.pull_request.create",
        });

        const receiptJson = (() => {
          const probe = new IcarusStore(fixture.databasePath, { now: () => NOW });
          try {
            const landed = probe.getLandingStatusForRun(RUN_ID);
            expect(landed?.landing).toMatchObject({ state: "landed", errorCode: null });
            expect(landed?.operations.at(-1)).toMatchObject({
              kind: "github.pull_request.create",
              status: "completed",
            });
            expect(landed?.receipt?.pullRequestOutcome).toBe("created");
            return canonicalLandingJson(landed?.receipt);
          } finally {
            probe.close();
          }
        })();

        const { runtime, loopback } = await reopenPreflightWithLoopback(fixture);
        try {
          const reloaded = runtime.service.getLandingStatus(RUN_ID);
          expect(reloaded?.landing.state).toBe("landed");
          // The receipt reloads byte-identically and resume refuses without
          // any new admission or remote call.
          expect(canonicalLandingJson(reloaded?.receipt)).toBe(receiptJson);
          await expect(runtime.service.resumeLanding(RUN_ID)).rejects.toMatchObject({
            code: "INVALID_LANDING_STATE",
          });
          expect(loopback.requests).toHaveLength(0);
          expect(fixture.requests()).toBe(0);
        } finally {
          runtime.close();
          await loopback.server.close();
        }
      }, 60_000);

      void REMOTE_STAGE_FIXTURE_NOTE;
    },
  );
}
