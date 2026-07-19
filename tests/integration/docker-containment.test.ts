import { mkdir } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { GitController } from "../../packages/core/src/git.js";
import { runControllerProcess } from "../../packages/core/src/process.js";
import { DEFAULT_CEILING } from "../../packages/core/src/policy.js";
import { DockerSandboxRunner } from "../../packages/core/src/sandbox.js";
import { createFixtureRepository, git, PYTHON_IMAGE } from "../support/integration-cli.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe("real Docker containment", () => {
  test("runs with no network/capabilities/host environment and leaves no managed container", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.cleanup);
    const stateRoot = path.join(fixture.root, "sandbox-state");
    const controllerHome = path.join(stateRoot, "controller-home");
    const runsRoot = path.join(stateRoot, "runs");
    await mkdir(controllerHome, { recursive: true, mode: 0o700 });
    await mkdir(runsRoot, { recursive: true, mode: 0o700 });
    const controller = new GitController(controllerHome, runsRoot);
    const runner = new DockerSandboxRunner(stateRoot, controller);
    const runId = "11111111-1111-4111-8111-111111111111";
    const probe = [
      "import os, pathlib, socket",
      "status = pathlib.Path('/proc/self/status').read_text()",
      "assert os.getuid() == 65534",
      "assert 'CapEff:\\t0000000000000000' in status",
      "assert 'NoNewPrivs:\\t1' in status",
      "assert 'Seccomp:\\t2' in status",
      "assert os.getenv('ICARUS_HOST_SENTINEL') is None",
      "assert not pathlib.Path('/var/run/docker.sock').exists()",
      "try:\n pathlib.Path('/workspace/src/greeting.txt').write_text('escape')\n raise AssertionError('workspace writable')\nexcept OSError:\n pass",
      "try:\n pathlib.Path('/icarus-host-write').write_text('escape')\n raise AssertionError('root writable')\nexcept OSError:\n pass",
      "pathlib.Path('/tmp/icarus-probe').write_text('ok')",
      "sock = socket.socket(); sock.settimeout(0.25)",
      "assert sock.connect_ex(('1.1.1.1', 53)) != 0",
      "print('containment-ok')",
    ].join("\n");
    const previousSentinel = process.env.ICARUS_HOST_SENTINEL;
    process.env.ICARUS_HOST_SENTINEL = "must-not-enter-container";
    try {
      const evidence = await runner.runChecks({
        runId,
        worktreePath: fixture.repository,
        baseCommit: (await git(fixture.repository, ["rev-parse", "HEAD"])).trim(),
        target: "src/greeting.txt",
        checks: [{ id: "containment", name: "Containment", argv: ["python", "-c", probe] }],
        sandbox: {
          image: PYTHON_IMAGE,
          cpus: 1,
          memoryMb: 256,
          pids: 32,
          tmpfsMb: 16,
        },
        ceiling: { ...DEFAULT_CEILING, commandTimeoutMs: 30_000 },
      });
      expect(evidence).toHaveLength(1);
      expect(evidence[0]?.outcome).toBe("passed");
      expect(evidence[0]?.stdout).toContain("containment-ok");
    } finally {
      if (previousSentinel === undefined) delete process.env.ICARUS_HOST_SENTINEL;
      else process.env.ICARUS_HOST_SENTINEL = previousSentinel;
    }

    const containers = await runControllerProcess(
      "docker",
      [
        "container",
        "list",
        "--all",
        "--filter",
        `label=icarus.run_id=${runId}`,
        "--format",
        "{{.ID}}",
      ],
      {
        cwd: stateRoot,
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: "/nonexistent",
          DOCKER_CONFIG: "/nonexistent",
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
        },
        timeoutMs: 30_000,
        maxOutputBytes: 64 * 1024,
        maxRawOutputBytes: 1024 * 1024,
      },
    );
    expect(containers.exitCode).toBe(0);
    expect(containers.stdout.trim()).toBe("");
  }, 120_000);
});
