import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { containsSecretShapedContent, isSecretShapedPath } from "./context.js";
import { sha256 } from "./digest.js";
import { errorMessage, IcarusError, invariant } from "./errors.js";
import type { GitController } from "./git.js";
import { runControllerProcess } from "./process.js";
import { sanitizeText } from "./redaction.js";
import type { CheckEvidence, CheckProfile, SandboxProfile, SunCeiling } from "./types.js";

const RUN_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOT_FILE_BYTES = 16 * 1024 * 1024;

function controllerEnvironment(): Record<string, string> {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/nonexistent",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    DOCKER_CONFIG: "/nonexistent",
  };
}

export interface CheckRunInput {
  readonly runId: string;
  readonly worktreePath: string;
  readonly baseCommit: string;
  readonly target: string;
  readonly checks: readonly CheckProfile[];
  readonly sandbox: SandboxProfile;
  readonly ceiling: SunCeiling;
  readonly signal?: AbortSignal;
}

export interface CheckRunner {
  reconcile(runId: string, signal?: AbortSignal): Promise<void>;
  runChecks(input: CheckRunInput): Promise<readonly CheckEvidence[]>;
}

async function removeSnapshot(snapshotRoot: string): Promise<void> {
  const makeWritable = async (directory: string): Promise<void> => {
    await chmod(directory, 0o700).catch(() => undefined);
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await makeWritable(path.join(directory, entry.name));
      }
    }
  };
  await makeWritable(snapshotRoot);
  await rm(snapshotRoot, { recursive: true, force: true });
}

async function createReadOnlySnapshot(
  git: GitController,
  snapshotsRoot: string,
  input: CheckRunInput,
): Promise<string> {
  invariant(RUN_ID_PATTERN.test(input.runId), "INVALID_RUN_ID", "Run ID is invalid");
  await mkdir(snapshotsRoot, { recursive: true, mode: 0o700 });
  await chmod(snapshotsRoot, 0o700);
  const runRoot = path.join(snapshotsRoot, input.runId);
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  await chmod(runRoot, 0o700);
  const snapshotRoot = path.join(runRoot, randomUUID());
  await mkdir(snapshotRoot, { recursive: false, mode: 0o700 });

  const tree = await git.listTree(input.worktreePath, input.baseCommit, input.signal);
  const directories = new Set<string>([snapshotRoot]);
  const writtenFiles: { path: string; executable: boolean }[] = [];
  let totalBytes = 0;
  let foundTarget = false;

  try {
    for (const entry of tree) {
      invariant(
        entry.type !== "commit",
        "SUBMODULE_DENIED",
        "Sandbox snapshots do not support submodules",
      );
      if (entry.type !== "blob") {
        continue;
      }
      invariant(
        entry.mode === "100644" || entry.mode === "100755",
        "SNAPSHOT_MODE_DENIED",
        `Sandbox snapshot cannot materialize Git mode ${entry.mode}: ${entry.path}`,
      );
      invariant(
        !isSecretShapedPath(entry.path),
        "SNAPSHOT_SECRET_PATH",
        `Secret-shaped tracked path is denied in the check snapshot: ${entry.path}`,
      );

      const bytes =
        entry.path === input.target
          ? Buffer.from(
              await git.readRegularUtf8File(
                input.worktreePath,
                input.target,
                input.ceiling.maxFileBytes,
              ),
              "utf8",
            )
          : await git.readBlob(
              input.worktreePath,
              entry.objectId,
              MAX_SNAPSHOT_FILE_BYTES,
              input.signal,
            );
      foundTarget ||= entry.path === input.target;
      invariant(
        !containsSecretShapedContent(bytes),
        "SNAPSHOT_SECRET_DETECTED",
        `Secret-shaped tracked content is denied in the check snapshot: ${entry.path}`,
      );
      totalBytes += bytes.length;
      invariant(
        totalBytes <= MAX_SNAPSHOT_BYTES,
        "SNAPSHOT_BUDGET_EXCEEDED",
        "Tracked repository snapshot exceeds the Milestone 1 byte ceiling",
      );

      const destination = path.join(snapshotRoot, ...entry.path.split("/"));
      const parent = path.dirname(destination);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      let current = parent;
      while (current.startsWith(`${snapshotRoot}${path.sep}`)) {
        directories.add(current);
        if (current === snapshotRoot) {
          break;
        }
        current = path.dirname(current);
      }
      await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
      writtenFiles.push({ path: destination, executable: entry.mode === "100755" });
    }
    invariant(
      foundTarget,
      "TARGET_NOT_TRACKED",
      "Approved target is missing from the sandbox snapshot",
    );

    for (const file of writtenFiles) {
      await chmod(file.path, file.executable ? 0o555 : 0o444);
    }
    for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
      await chmod(directory, 0o555);
    }
    return snapshotRoot;
  } catch (error) {
    await removeSnapshot(snapshotRoot);
    throw error;
  }
}

function unavailableEvidence(
  checks: readonly CheckProfile[],
  message: string,
  outcome: "unavailable" | "cancelled" = "unavailable",
): CheckEvidence[] {
  const sanitized = sanitizeText(message);
  return checks.map((check) => ({
    checkId: check.id,
    argv: check.argv,
    exitCode: null,
    signal: null,
    durationMs: 0,
    stdout: "",
    stderr: sanitized,
    truncated: false,
    outcome,
  }));
}

export class DockerSandboxRunner implements CheckRunner {
  readonly #git: GitController;
  readonly #snapshotsRoot: string;
  readonly #dockerBinary: string;

  constructor(stateRoot: string, git: GitController, dockerBinary = "docker") {
    this.#git = git;
    this.#snapshotsRoot = path.join(stateRoot, "snapshots");
    this.#dockerBinary = dockerBinary;
  }

  async #controller(args: readonly string[], timeoutMs: number, signal?: AbortSignal) {
    return runControllerProcess(this.#dockerBinary, args, {
      cwd: this.#snapshotsRoot,
      env: controllerEnvironment(),
      timeoutMs,
      maxOutputBytes: 64 * 1024,
      maxRawOutputBytes: 1024 * 1024,
      signal,
    });
  }

  async #preflight(image: string, signal?: AbortSignal): Promise<void> {
    await mkdir(this.#snapshotsRoot, { recursive: true, mode: 0o700 });
    const info = await this.#controller(
      ["info", "--format", "{{json .SecurityOptions}}"],
      30_000,
      signal,
    );
    if (info.cancelled) {
      throw new IcarusError("CANCELLED", "Docker preflight was cancelled");
    }
    let securityOptions: unknown;
    try {
      securityOptions = JSON.parse(info.stdout) as unknown;
    } catch {
      securityOptions = null;
    }
    invariant(
      info.exitCode === 0 &&
        Array.isArray(securityOptions) &&
        securityOptions.some(
          (option) =>
            typeof option === "string" &&
            option.startsWith("name=seccomp") &&
            !option.toLowerCase().includes("unconfined"),
        ),
      "SANDBOX_UNAVAILABLE",
      "Docker daemon is unavailable or its seccomp protection is disabled",
    );
    const imageInspection = await this.#controller(
      ["image", "inspect", "--format", "{{json .Config}}", image],
      30_000,
      signal,
    );
    if (imageInspection.cancelled) {
      throw new IcarusError("CANCELLED", "Docker image preflight was cancelled");
    }
    invariant(
      imageInspection.exitCode === 0,
      "SANDBOX_IMAGE_UNAVAILABLE",
      "Digest-pinned sandbox image is not present locally; Icarus will not pull it",
    );
    let imageConfig: unknown;
    try {
      imageConfig = JSON.parse(imageInspection.stdout) as unknown;
    } catch {
      imageConfig = null;
    }
    invariant(
      typeof imageConfig === "object" && imageConfig !== null && !Array.isArray(imageConfig),
      "SANDBOX_PROTOCOL_ERROR",
      "Docker returned invalid sandbox image configuration",
    );
    const declaredVolumes = (imageConfig as Record<string, unknown>).Volumes;
    invariant(
      declaredVolumes === undefined ||
        declaredVolumes === null ||
        (typeof declaredVolumes === "object" &&
          !Array.isArray(declaredVolumes) &&
          Object.keys(declaredVolumes).length === 0),
      "SANDBOX_IMAGE_VOLUMES_DENIED",
      "Sandbox images declaring writable VOLUME paths are not supported",
    );
  }

  async #inspectContainer(
    name: string,
    signal?: AbortSignal,
  ): Promise<{ readonly exists: boolean; readonly labels: Record<string, string> }> {
    const inspection = await this.#controller(
      ["container", "inspect", "--format", "{{json .Config.Labels}}", name],
      15_000,
      signal,
    );
    if (inspection.exitCode === 0) {
      let labels: unknown;
      try {
        labels = JSON.parse(inspection.stdout) as unknown;
      } catch {
        throw new IcarusError("SANDBOX_PROTOCOL_ERROR", "Docker returned invalid container labels");
      }
      invariant(
        typeof labels === "object" && labels !== null && !Array.isArray(labels),
        "SANDBOX_PROTOCOL_ERROR",
        "Docker returned invalid container labels",
      );
      return { exists: true, labels: labels as Record<string, string> };
    }
    invariant(
      /No such (?:object|container)/i.test(inspection.stderr),
      "SANDBOX_CLEANUP_UNCONFIRMED",
      "Docker could not confirm whether a managed container still exists",
    );
    return { exists: false, labels: {} };
  }

  async #cleanupContainer(
    name: string,
    expectedRunId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const inspection = await this.#inspectContainer(name, signal);
    if (!inspection.exists) {
      return;
    }
    invariant(
      inspection.labels["icarus.managed"] === "true" &&
        inspection.labels["icarus.run_id"] === expectedRunId,
      "SANDBOX_CONTAINER_COLLISION",
      "Refusing to remove a container not owned by this Icarus run",
    );
    const removal = await this.#controller(
      ["container", "rm", "--force", "--volumes", name],
      15_000,
      signal,
    );
    invariant(
      removal.exitCode === 0,
      "SANDBOX_CLEANUP_FAILED",
      "Docker could not remove a managed container",
    );
    invariant(
      !(await this.#inspectContainer(name, signal)).exists,
      "SANDBOX_CLEANUP_FAILED",
      "Managed container still exists after forced removal",
    );
  }

  async reconcile(runId: string, signal?: AbortSignal): Promise<void> {
    invariant(RUN_ID_PATTERN.test(runId), "INVALID_RUN_ID", "Run ID is invalid");
    await mkdir(this.#snapshotsRoot, { recursive: true, mode: 0o700 });
    const listing = await this.#controller(
      [
        "container",
        "list",
        "--all",
        "--filter",
        "label=icarus.managed=true",
        "--filter",
        `label=icarus.run_id=${runId}`,
        "--format",
        "{{.ID}}",
      ],
      30_000,
      signal,
    );
    invariant(
      listing.exitCode === 0,
      "SANDBOX_RECONCILIATION_FAILED",
      "Docker container reconciliation failed",
    );
    const containerIds = listing.stdout.split(/\s+/).filter((value) => value.length > 0);
    for (const containerId of containerIds) {
      invariant(
        /^[a-f0-9]{12,64}$/.test(containerId),
        "SANDBOX_PROTOCOL_ERROR",
        "Docker returned an invalid container ID",
      );
      await this.#cleanupContainer(containerId, runId, signal);
    }
  }

  async runChecks(input: CheckRunInput): Promise<readonly CheckEvidence[]> {
    let snapshotRoot: string | null = null;
    try {
      await this.#preflight(input.sandbox.image, input.signal);
      await this.reconcile(input.runId, input.signal);
      snapshotRoot = await createReadOnlySnapshot(this.#git, this.#snapshotsRoot, input);
      invariant(
        !snapshotRoot.includes(",") && !/[\r\n]/.test(snapshotRoot),
        "SANDBOX_PATH_DENIED",
        "Sandbox snapshot path cannot be represented safely as a Docker mount",
      );
    } catch (error) {
      const cancelled =
        input.signal?.aborted === true ||
        (error instanceof IcarusError && error.code === "CANCELLED");
      return unavailableEvidence(
        input.checks,
        cancelled ? "Verification was cancelled during sandbox preflight" : errorMessage(error),
        cancelled ? "cancelled" : "unavailable",
      );
    }

    const evidence: CheckEvidence[] = [];
    try {
      for (const [checkIndex, check] of input.checks.entries()) {
        if (input.signal?.aborted) {
          evidence.push({
            checkId: check.id,
            argv: check.argv,
            exitCode: null,
            signal: null,
            durationMs: 0,
            stdout: "",
            stderr: "Verification was cancelled",
            truncated: false,
            outcome: "cancelled",
          });
          continue;
        }

        const containerName = `icarus-${input.runId}-${checkIndex}-${sha256(check.id).slice(0, 8)}`;
        await this.#cleanupContainer(containerName, input.runId, input.signal);
        const args = [
          "run",
          "--name",
          containerName,
          "--label",
          "icarus.managed=true",
          "--label",
          `icarus.run_id=${input.runId}`,
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
          String(input.sandbox.pids),
          "--memory",
          `${input.sandbox.memoryMb}m`,
          "--memory-swap",
          `${input.sandbox.memoryMb}m`,
          "--cpus",
          String(input.sandbox.cpus),
          "--user",
          "65534:65534",
          "--tmpfs",
          `/tmp:rw,noexec,nosuid,nodev,size=${input.sandbox.tmpfsMb}m,mode=1777`,
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
          check.argv[0] ?? "",
          input.sandbox.image,
          ...check.argv.slice(1),
        ];

        let checkEvidence: CheckEvidence;
        try {
          const result = await runControllerProcess(this.#dockerBinary, args, {
            cwd: this.#snapshotsRoot,
            env: controllerEnvironment(),
            timeoutMs: input.ceiling.commandTimeoutMs,
            maxOutputBytes: input.ceiling.maxCommandOutputBytes,
            maxRawOutputBytes: input.ceiling.maxRawCommandOutputBytes,
            signal: input.signal,
          });
          checkEvidence = {
            checkId: check.id,
            argv: check.argv,
            exitCode: result.exitCode,
            signal: result.signal,
            durationMs: result.durationMs,
            stdout: result.stdout,
            stderr: result.timedOut
              ? `${result.stderr}\nVerification exceeded its configured timeout`.trim()
              : result.stderr,
            truncated: result.truncated || result.rawLimitExceeded,
            outcome:
              result.cancelled || input.signal?.aborted
                ? "cancelled"
                : result.exitCode === 0 && !result.timedOut && !result.rawLimitExceeded
                  ? "passed"
                  : "failed",
          };
        } catch (error) {
          checkEvidence = {
            checkId: check.id,
            argv: check.argv,
            exitCode: null,
            signal: null,
            durationMs: 0,
            stdout: "",
            stderr: sanitizeText(errorMessage(error)),
            truncated: false,
            outcome:
              error instanceof IcarusError && error.code === "CANCELLED"
                ? "cancelled"
                : "unavailable",
          };
        }
        try {
          await this.#cleanupContainer(containerName, input.runId);
        } catch (error) {
          checkEvidence = {
            ...checkEvidence,
            stderr: sanitizeText(
              `${checkEvidence.stderr}\nContainer cleanup was not confirmed: ${errorMessage(error)}`,
            ).trim(),
            outcome: "unavailable",
          };
        }
        evidence.push(checkEvidence);
      }
      return evidence;
    } finally {
      await removeSnapshot(snapshotRoot);
    }
  }
}
