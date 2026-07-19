import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256 } from "../../packages/core/src/digest.js";
import { DEFAULT_CEILING } from "../../packages/core/src/policy.js";
import { type CheckRunInput, DockerSandboxRunner } from "../../packages/core/src/sandbox.js";
import type { CheckProfile, SandboxProfile, SunCeiling } from "../../packages/core/src/types.js";
import {
  createRecordingDocker,
  type FakeDockerCall,
  type FakeDockerScenario,
} from "../support/sandbox-fake-docker.js";
import {
  createSandboxGitFixture,
  SANDBOX_BASE_COMMIT,
  SANDBOX_EDITED_TEXT,
  SANDBOX_TARGET,
} from "../support/sandbox-git.js";

const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const IMAGE = `python:3.12-slim@sha256:${"c".repeat(64)}`;
const CHECK: CheckProfile = {
  id: "safe",
  name: "Safe wire check",
  argv: ["node", "--version"],
};
const SANDBOX: SandboxProfile = {
  image: IMAGE,
  cpus: 1.5,
  memoryMb: 384,
  pids: 37,
  tmpfsMb: 48,
};
const CEILING: SunCeiling = {
  ...DEFAULT_CEILING,
  maxFileBytes: 1024 * 1024,
  maxCommandOutputBytes: 16 * 1024,
  maxRawCommandOutputBytes: 64 * 1024,
  commandTimeoutMs: 2_000,
};

const temporaryRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "icarus-sandbox-wire-"));
  temporaryRoots.push(root);
  return root;
}

function makeInput(
  worktreePath: string,
  overrides: Partial<Pick<CheckRunInput, "ceiling" | "signal">> = {},
): CheckRunInput {
  return {
    runId: RUN_ID,
    worktreePath,
    baseCommit: SANDBOX_BASE_COMMIT,
    target: SANDBOX_TARGET,
    checks: [CHECK],
    sandbox: SANDBOX,
    ceiling: overrides.ceiling ?? CEILING,
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
  };
}

async function runScenario(
  scenario: FakeDockerScenario,
  inputOverrides: Partial<Pick<CheckRunInput, "ceiling" | "signal">> = {},
) {
  const root = await makeRoot();
  const docker = await createRecordingDocker(root, scenario);
  const git = createSandboxGitFixture();
  const runner = new DockerSandboxRunner(root, git.git, docker.binary);
  const worktreePath = path.join(root, "private-worktree");
  const evidence = await runner.runChecks(makeInput(worktreePath, inputOverrides));
  return { root, docker, git, evidence, worktreePath };
}

function expectUnavailableWithMessage(
  evidence: Awaited<ReturnType<DockerSandboxRunner["runChecks"]>>,
  message: string,
): void {
  expect(evidence).toHaveLength(1);
  expect(evidence[0]).toMatchObject({
    checkId: CHECK.id,
    argv: CHECK.argv,
    exitCode: null,
    outcome: "unavailable",
  });
  expect(evidence[0]?.stderr).toContain(message);
}

function expectExactControllerEnvironment(call: FakeDockerCall, snapshotsRoot: string): void {
  expect(call.cwd).toBe(snapshotsRoot);
  expect(call.env).toEqual({
    DOCKER_CONFIG: "/nonexistent",
    HOME: "/nonexistent",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: "/usr/local/bin:/usr/bin:/bin",
  });
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("Docker sandbox wire contract", () => {
  it("uses the exact fail-closed Docker argv and a sealed controller environment", async () => {
    const { root, docker, git, evidence, worktreePath } = await runScenario({
      imageConfig: {},
      observePaths: ["README.md", SANDBOX_TARGET],
      run: { stdout: "check passed\n" },
    });

    expect(evidence).toEqual([
      {
        checkId: CHECK.id,
        argv: CHECK.argv,
        exitCode: 0,
        signal: null,
        durationMs: expect.any(Number),
        stdout: "check passed\n",
        stderr: "",
        truncated: false,
        outcome: "passed",
      },
    ]);

    const calls = await docker.calls();
    expect(calls).toHaveLength(8);
    const containerName = `icarus-${RUN_ID}-0-${sha256(CHECK.id).slice(0, 8)}`;
    expect(calls[0]?.argv).toEqual(["info", "--format", "{{json .SecurityOptions}}"]);
    expect(calls[1]?.argv).toEqual(["image", "inspect", "--format", "{{json .Config}}", IMAGE]);
    expect(calls[2]?.argv).toEqual([
      "container",
      "list",
      "--all",
      "--filter",
      "label=icarus.managed=true",
      "--filter",
      `label=icarus.run_id=${RUN_ID}`,
      "--format",
      "{{.ID}}",
    ]);
    expect(calls[3]?.argv).toEqual([
      "container",
      "inspect",
      "--format",
      "{{json .Config.Labels}}",
      containerName,
    ]);

    const runCall = calls[4];
    expect(runCall).toBeDefined();
    const snapshotRoot = runCall?.snapshot?.root;
    expect(snapshotRoot).toMatch(new RegExp(`^${root}/snapshots/${RUN_ID}/[a-f0-9-]{36}$`));
    expect(runCall?.argv).toEqual([
      "run",
      "--name",
      containerName,
      "--label",
      "icarus.managed=true",
      "--label",
      `icarus.run_id=${RUN_ID}`,
      "--log-driver",
      "none",
      "--no-healthcheck",
      "--pull",
      "never",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--pids-limit",
      "37",
      "--memory",
      "384m",
      "--memory-swap",
      "384m",
      "--cpus",
      "1.5",
      "--user",
      "65534:65534",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=48m,mode=1777",
      "--env",
      "HOME=/tmp",
      "--env",
      "TMPDIR=/tmp",
      "--env",
      "PYTHONDONTWRITEBYTECODE=1",
      "--mount",
      `type=bind,source=${snapshotRoot},target=/workspace,readonly`,
      "--workdir",
      "/workspace",
      "--entrypoint",
      "node",
      IMAGE,
      "--version",
    ]);
    expect(runCall?.snapshot?.entries).toEqual({
      "README.md": { content: "# Wire fixture\n", mode: 0o444 },
      [SANDBOX_TARGET]: { content: SANDBOX_EDITED_TEXT, mode: 0o444 },
    });
    expect(calls[5]?.argv).toEqual([
      "container",
      "inspect",
      "--format",
      "{{json .Config.Labels}}",
      containerName,
    ]);
    expect(calls[6]?.argv).toEqual(["container", "rm", "--force", "--volumes", containerName]);
    expect(calls[7]?.argv).toEqual([
      "container",
      "inspect",
      "--format",
      "{{json .Config.Labels}}",
      containerName,
    ]);
    for (const call of calls) {
      expectExactControllerEnvironment(call, path.join(root, "snapshots"));
    }
    expect(git.calls.listTree).toEqual([`${worktreePath}:${SANDBOX_BASE_COMMIT}`]);
    expect(git.calls.readBlob).toEqual(["2".repeat(40)]);
    expect(git.calls.readRegularUtf8File).toEqual([SANDBOX_TARGET]);
    await expect(access(snapshotRoot ?? "missing")).rejects.toThrow();
  });

  it("rejects an image-declared writable VOLUME before reconciliation or execution", async () => {
    const { docker, evidence } = await runScenario({
      imageConfig: { Volumes: { "/writable-cache": {} } },
    });

    expectUnavailableWithMessage(
      evidence,
      "Sandbox images declaring writable VOLUME paths are not supported",
    );
    expect((await docker.calls()).map((call) => call.argv[0])).toEqual(["info", "image"]);
  });

  it.each([
    {
      name: "daemon without confirmed seccomp",
      scenario: { securityOptions: ["name=apparmor"] },
      message: "Docker daemon is unavailable or its seccomp protection is disabled",
      commands: ["info"],
    },
    {
      name: "missing digest-pinned image",
      scenario: { imageInspectExitCode: 1 },
      message: "Digest-pinned sandbox image is not present locally; Icarus will not pull it",
      commands: ["info", "image"],
    },
    {
      name: "malformed image configuration",
      scenario: { imageInspectStdout: "not-json" },
      message: "Docker returned invalid sandbox image configuration",
      commands: ["info", "image"],
    },
  ])("fails closed during preflight for $name", async ({ scenario, message, commands }) => {
    const { docker, evidence } = await runScenario(scenario);

    expectUnavailableWithMessage(evidence, message);
    expect((await docker.calls()).map((call) => call.argv[0])).toEqual(commands);
  });

  it("reports cancellation, not unavailability, when preflight is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { docker, evidence } = await runScenario({}, { signal: controller.signal });

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      checkId: CHECK.id,
      exitCode: null,
      outcome: "cancelled",
      stderr: "Verification was cancelled during sandbox preflight",
    });
    expect(await docker.calls()).toEqual([]);
  });

  it("bounds a hanging check and still removes its managed container", async () => {
    const { docker, evidence } = await runScenario(
      { imageConfig: { Volumes: null }, run: { delayMs: 1_000 } },
      { ceiling: { ...CEILING, commandTimeoutMs: 40 } },
    );

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      checkId: CHECK.id,
      exitCode: null,
      signal: "SIGTERM",
      outcome: "failed",
    });
    expect(evidence[0]?.stderr).toContain("exceeded its configured timeout");
    const calls = await docker.calls();
    expect(calls.some((call) => call.argv[0] === "run")).toBe(true);
    expect(calls.some((call) => call.argv[0] === "container" && call.argv[1] === "rm")).toBe(true);
  });

  it("cancels a live check and performs cleanup without the aborted signal", async () => {
    const root = await makeRoot();
    const docker = await createRecordingDocker(root, {
      run: { delayMs: 10_000 },
    });
    const git = createSandboxGitFixture();
    const runner = new DockerSandboxRunner(root, git.git, docker.binary);
    const controller = new AbortController();
    const result = runner.runChecks(
      makeInput(path.join(root, "private-worktree"), { signal: controller.signal }),
    );
    await docker.waitForCall((call) => call.argv[0] === "run");
    controller.abort();

    const evidence = await result;
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      checkId: CHECK.id,
      exitCode: null,
      signal: "SIGTERM",
      outcome: "cancelled",
    });
    const calls = await docker.calls();
    const runIndex = calls.findIndex((call) => call.argv[0] === "run");
    expect(runIndex).toBeGreaterThanOrEqual(0);
    expect(
      calls
        .slice(runIndex + 1)
        .some((call) => call.argv[0] === "container" && call.argv[1] === "inspect"),
    ).toBe(true);
  });

  it("cannot report a successful check when managed-container cleanup fails", async () => {
    const { docker, evidence } = await runScenario({
      cleanupFails: true,
      run: { exitCode: 0, stdout: "nominal success\n" },
    });

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      checkId: CHECK.id,
      exitCode: 0,
      stdout: "nominal success\n",
      outcome: "unavailable",
    });
    expect(evidence[0]?.stderr).toContain("Container cleanup was not confirmed");
    expect(evidence[0]?.stderr).toContain("Docker could not remove a managed container");
    const calls = await docker.calls();
    expect(calls.at(-1)?.argv.slice(0, 3)).toEqual(["container", "rm", "--force"]);
  });
});
