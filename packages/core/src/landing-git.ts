import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { sha256 } from "./digest.js";
import { IcarusError, invariant } from "./errors.js";
import {
  assertSha1,
  assertUuid,
  buildUnsignedCommitPayloadV1,
  type CandidateObjectManifestEntryV1,
  type CandidateObjectManifestV1,
  canonicalizeCommitMessage,
  digestLandingRecord,
  gitObjectSha1,
} from "./landing-records.js";
import { assertAllowedTarget, MAX_CHANGED_FILES } from "./policy.js";
import {
  type ControllerProcessOptions,
  type ControllerProcessResult,
  MAX_CONTROLLER_STDIN_BYTES,
  runControllerProcess,
} from "./process.js";
import type { CheckpointFile } from "./types.js";

const GIT_OUTPUT_LIMIT = MAX_CONTROLLER_STDIN_BYTES;
const MACHINE_OUTPUT_LIMIT = 64 * 1024;
const ZERO_SHA1 = "0".repeat(40);
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA1_PATTERN = /^[a-f0-9]{40}$/;
const CANONICAL_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

interface CacheIdentity {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

interface NormalizedCheckpointFile {
  readonly path: string;
  readonly op: "modify" | "create" | "delete";
  readonly baseline: Buffer | null;
  readonly approved: Buffer | null;
}

interface IndexEntry {
  readonly mode: string;
  readonly objectId: string;
  readonly stage: number;
  readonly path: string;
}

export interface LandingCandidateInput {
  readonly cachePath: string;
  readonly runId: string;
  readonly baseCommitSha1: string;
  readonly baseTreeSha1: string;
  readonly checkpointFiles: readonly CheckpointFile[];
  readonly reviewedDiffBytes: Uint8Array;
  readonly commitIdentity: {
    readonly name: string;
    readonly email: string;
  };
  readonly commitEpochSeconds: number;
  readonly commitMessage: string;
}

export interface LandingCandidateResult {
  readonly objectFormat: "sha1";
  readonly baseCommitSha1: string;
  readonly baseTreeSha1: string;
  readonly candidateTreeSha1: string;
  readonly candidateCommitSha1: string;
  readonly candidateCommitPayloadSha256: string;
  readonly candidateObjectManifest: CandidateObjectManifestV1;
  readonly candidateObjectManifestSha256: string;
  readonly diffByteEqual: true;
}

export interface LandingLocalRefInput {
  readonly cachePath: string;
  readonly runId: string;
  readonly candidateCommitSha1: string;
}

export interface LandingLocalRefResult {
  readonly headRef: string;
  readonly candidateCommitSha1: string;
  readonly localRefOutcome: "created";
  readonly updateRefExitCode: 0;
}

function nullDevice(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

function byteCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isWellFormedUnicode(value: string): boolean {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "utf8")) === value;
  } catch {
    return false;
  }
}

function decodeCanonicalBase64(value: string, field: string): Buffer {
  invariant(
    CANONICAL_BASE64_PATTERN.test(value) && value.length % 4 === 0,
    "LANDING_CHECKPOINT_INVALID",
    `${field} is not canonical padded RFC 4648 base64`,
  );
  const bytes = Buffer.from(value, "base64");
  invariant(
    bytes.toString("base64") === value,
    "LANDING_CHECKPOINT_INVALID",
    `${field} is not canonical padded RFC 4648 base64`,
  );
  invariant(
    bytes.byteLength <= MAX_CONTROLLER_STDIN_BYTES,
    "LANDING_CHECKPOINT_INVALID",
    `${field} exceeds the local candidate byte ceiling`,
  );
  return bytes;
}

function normalizeCheckpointFiles(files: readonly CheckpointFile[]): NormalizedCheckpointFile[] {
  invariant(
    files.length > 0 && files.length <= MAX_CHANGED_FILES,
    "LANDING_CHECKPOINT_INVALID",
    "Landing checkpoint must contain a bounded nonempty changed-path set",
  );
  const normalized = files.map((file, index): NormalizedCheckpointFile => {
    const safePath = assertAllowedTarget(file.path);
    invariant(
      isWellFormedUnicode(safePath) && safePath.normalize("NFC") === safePath,
      "LANDING_CHECKPOINT_INVALID",
      "Landing checkpoint path must be well-formed NFC Unicode",
    );
    invariant(
      file.op === "modify" || file.op === "create" || file.op === "delete",
      "LANDING_CHECKPOINT_INVALID",
      "Landing checkpoint operation is invalid",
    );
    const baseline =
      file.baselineBase64 === null
        ? null
        : decodeCanonicalBase64(file.baselineBase64, `checkpointFiles[${index}].baselineBase64`);
    const approved =
      file.approvedBase64 === null
        ? null
        : decodeCanonicalBase64(file.approvedBase64, `checkpointFiles[${index}].approvedBase64`);
    invariant(
      (file.op === "modify" && baseline !== null && approved !== null) ||
        (file.op === "create" && baseline === null && approved !== null) ||
        (file.op === "delete" && baseline !== null && approved === null),
      "LANDING_CHECKPOINT_INVALID",
      "Landing checkpoint operation and byte presence are inconsistent",
    );
    return { path: safePath, op: file.op, baseline, approved };
  });
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    invariant(
      previous !== undefined &&
        current !== undefined &&
        byteCompare(previous.path, current.path) < 0,
      "LANDING_CHECKPOINT_INVALID",
      "Landing checkpoint paths must be strictly byte-sorted and duplicate-free",
    );
  }
  return normalized;
}

function parseIndexEntries(bytes: Uint8Array): readonly IndexEntry[] {
  let output: string;
  try {
    output = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new IcarusError("LANDING_GIT_OUTPUT_INVALID", "Git index output is not valid UTF-8");
  }
  const records = output.split("\0");
  invariant(
    records.at(-1) === "",
    "LANDING_GIT_OUTPUT_INVALID",
    "Git index output is not NUL terminated",
  );
  records.pop();
  return records.map((record) => {
    const match = /^([0-7]{6}) ([a-f0-9]{40}) ([0-3])\t(.+)$/.exec(record);
    invariant(match !== null, "LANDING_GIT_OUTPUT_INVALID", "Git index entry is malformed");
    const [, mode, objectId, stageText, entryPath] = match;
    invariant(
      mode !== undefined &&
        objectId !== undefined &&
        stageText !== undefined &&
        entryPath !== undefined,
      "LANDING_GIT_OUTPUT_INVALID",
      "Git index entry is incomplete",
    );
    const safePath = assertAllowedTarget(entryPath);
    return { mode, objectId, stage: Number(stageText), path: safePath };
  });
}

function parseChangedPaths(
  bytes: Uint8Array,
): readonly { readonly status: string; readonly path: string }[] {
  let output: string;
  try {
    output = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new IcarusError(
      "LANDING_GIT_OUTPUT_INVALID",
      "Git changed-path output is not valid UTF-8",
    );
  }
  const fields = output.split("\0");
  invariant(
    fields.at(-1) === "" && (fields.length - 1) % 2 === 0,
    "LANDING_GIT_OUTPUT_INVALID",
    "Git changed-path output is malformed",
  );
  fields.pop();
  const changed: { status: string; path: string }[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index];
    const entryPath = fields[index + 1];
    invariant(
      status !== undefined && entryPath !== undefined && /^(A|M|D)$/.test(status),
      "LANDING_GIT_OUTPUT_INVALID",
      "Git changed-path status is unsupported",
    );
    changed.push({ status, path: assertAllowedTarget(entryPath) });
  }
  return changed;
}

/**
 * ADR 0027's credential-free local Git authority. Public methods accept value
 * objects only; no caller can supply an argv, ref, remote, URL, refspec, hook,
 * helper, worktree, or source-checkout path.
 */
export class LandingGitController {
  readonly #controlHome: string;
  readonly #managedRunsRoot: string;
  readonly #gitExecutable: string;

  constructor(controlHome: string, managedRunsRoot: string, gitExecutable = "git") {
    this.#controlHome = path.resolve(controlHome);
    this.#managedRunsRoot = path.resolve(managedRunsRoot);
    this.#gitExecutable = gitExecutable;
  }

  #environment(indexPath?: string): Readonly<Record<string, string>> {
    return {
      PATH: process.env.PATH ?? "",
      HOME: this.#controlHome,
      XDG_CONFIG_HOME: this.#controlHome,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: nullDevice(),
      GIT_CONFIG_GLOBAL: nullDevice(),
      GIT_ATTR_NOSYSTEM: "1",
      GIT_LITERAL_PATHSPECS: "1",
      GIT_ALLOW_PROTOCOL: "never",
      GIT_PROTOCOL_FROM_USER: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: process.platform === "win32" ? process.execPath : "/bin/false",
      GIT_SSH_COMMAND: process.platform === "win32" ? process.execPath : "false",
      GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_PAGER: "cat",
      GIT_OPTIONAL_LOCKS: "0",
      ...(indexPath === undefined ? {} : { GIT_INDEX_FILE: indexPath, GIT_INDEX_VERSION: "2" }),
    };
  }

  #arguments(cachePath: string, command: readonly string[]): readonly string[] {
    return [
      "--no-pager",
      "--no-replace-objects",
      "-c",
      "core.fsmonitor=false",
      "-c",
      `core.hooksPath=${nullDevice()}`,
      "-c",
      `core.attributesFile=${nullDevice()}`,
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.safecrlf=false",
      "-c",
      "core.quotePath=true",
      "-c",
      "credential.helper=",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "tag.gpgSign=false",
      "-c",
      "diff.external=",
      "-c",
      "diff.renames=false",
      "-c",
      "diff.algorithm=myers",
      "-c",
      "diff.indentHeuristic=false",
      "-c",
      "color.ui=false",
      "-c",
      "core.pager=cat",
      "-c",
      "pager.diff=false",
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.file.allow=never",
      "-c",
      "protocol.ext.allow=never",
      "-c",
      "protocol.git.allow=never",
      "-c",
      "protocol.http.allow=never",
      "-c",
      "protocol.https.allow=never",
      "-c",
      "protocol.ssh.allow=never",
      "--git-dir",
      cachePath,
      ...command,
    ];
  }

  async #execute(
    cachePath: string,
    operation: string,
    command: readonly string[],
    options: {
      readonly signal?: AbortSignal | undefined;
      readonly stdinBytes?: Uint8Array | undefined;
      readonly maxOutputBytes?: number | undefined;
      readonly indexPath?: string | undefined;
    } = {},
  ): Promise<ControllerProcessResult> {
    const processOptions: ControllerProcessOptions = {
      cwd: this.#controlHome,
      env: this.#environment(options.indexPath),
      timeoutMs: 60_000,
      maxOutputBytes: options.maxOutputBytes ?? MACHINE_OUTPUT_LIMIT,
      maxRawOutputBytes: options.maxOutputBytes ?? MACHINE_OUTPUT_LIMIT,
      signal: options.signal,
      ...(options.stdinBytes === undefined
        ? {}
        : { stdinBytes: options.stdinBytes, maxStdinBytes: MAX_CONTROLLER_STDIN_BYTES }),
    };
    try {
      return await runControllerProcess(
        this.#gitExecutable,
        this.#arguments(cachePath, command),
        processOptions,
      );
    } catch (error) {
      if (error instanceof IcarusError && error.code === "CANCELLED") throw error;
      throw new IcarusError("LANDING_GIT_FAILED", "Landing Git operation failed", {
        operation,
        reason: "spawn_or_stdin",
      });
    }
  }

  #assertProcessResult(
    result: ControllerProcessResult,
    operation: string,
    acceptedExitCodes: readonly number[],
  ): void {
    if (result.cancelled) throw new IcarusError("CANCELLED", "Landing Git operation was cancelled");
    if (
      result.exitCode === null ||
      !acceptedExitCodes.includes(result.exitCode) ||
      result.timedOut ||
      result.rawLimitExceeded ||
      result.truncated
    ) {
      throw new IcarusError("LANDING_GIT_FAILED", "Landing Git operation failed", {
        operation,
        reason: result.timedOut
          ? "timeout"
          : result.rawLimitExceeded || result.truncated
            ? "output_limit"
            : "exit",
      });
    }
  }

  async #run(
    cachePath: string,
    operation: string,
    command: readonly string[],
    options: {
      readonly signal?: AbortSignal | undefined;
      readonly stdinBytes?: Uint8Array | undefined;
      readonly maxOutputBytes?: number | undefined;
      readonly acceptedExitCodes?: readonly number[] | undefined;
      readonly indexPath?: string | undefined;
    } = {},
  ): Promise<ControllerProcessResult> {
    const result = await this.#execute(cachePath, operation, command, options);
    this.#assertProcessResult(result, operation, options.acceptedExitCodes ?? [0]);
    return result;
  }

  async #line(
    cachePath: string,
    operation: string,
    command: readonly string[],
    signal?: AbortSignal,
  ): Promise<string> {
    const result = await this.#run(cachePath, operation, command, { signal });
    let output: string;
    try {
      output = new TextDecoder("utf-8", { fatal: true }).decode(result.stdoutBytes);
    } catch {
      throw new IcarusError("LANDING_GIT_OUTPUT_INVALID", "Git returned invalid machine output");
    }
    invariant(
      output.endsWith("\n") && output.indexOf("\n") === output.length - 1,
      "LANDING_GIT_OUTPUT_INVALID",
      "Git returned malformed machine output",
    );
    return output.slice(0, -1);
  }

  async #assertDirectory(directory: string, code: string, message: string): Promise<void> {
    const metadata = await lstat(directory).catch(() => null);
    const currentUid = process.getuid?.();
    invariant(
      metadata?.isDirectory() === true &&
        !metadata.isSymbolicLink() &&
        currentUid !== undefined &&
        metadata.uid === currentUid &&
        (metadata.mode & 0o022) === 0 &&
        (await realpath(directory)) === directory,
      code,
      message,
    );
  }

  async #assertForbiddenCacheFilesAbsent(cachePath: string): Promise<void> {
    for (const directory of [
      path.join(cachePath, "info"),
      path.join(cachePath, "objects", "info"),
    ]) {
      const metadata = await lstat(directory).catch(() => null);
      if (metadata !== null) {
        invariant(
          metadata.isDirectory() &&
            !metadata.isSymbolicLink() &&
            (await realpath(directory)) === directory,
          "LANDING_CACHE_INVALID",
          "Private Git cache metadata directory is unsafe",
        );
      }
    }
    for (const forbidden of [
      path.join(cachePath, "objects", "info", "alternates"),
      path.join(cachePath, "objects", "info", "http-alternates"),
      path.join(cachePath, "info", "attributes"),
      path.join(cachePath, "info", "grafts"),
    ]) {
      invariant(
        (await lstat(forbidden).catch(() => null)) === null,
        "LANDING_CACHE_INVALID",
        "Private Git cache contains forbidden alternate or attribute metadata",
      );
    }
  }

  async #validateCache(
    cachePath: string,
    runId: string,
    signal?: AbortSignal,
  ): Promise<CacheIdentity> {
    invariant(
      process.platform === "linux",
      "UNSUPPORTED_PLATFORM",
      "Git landing mutations require Linux",
    );
    assertUuid(runId, "runId");
    invariant(UUID_PATTERN.test(runId), "LANDING_CACHE_INVALID", "Landing run ID is invalid");
    await this.#assertDirectory(
      this.#controlHome,
      "LANDING_CACHE_INVALID",
      "Landing Git control home is unsafe",
    );
    await this.#assertDirectory(
      this.#managedRunsRoot,
      "LANDING_CACHE_INVALID",
      "Managed runs root is unsafe",
    );
    const runRoot = path.join(this.#managedRunsRoot, runId);
    const expectedCachePath = path.join(runRoot, "git-cache.git");
    invariant(
      cachePath === path.resolve(cachePath) && cachePath === expectedCachePath,
      "LANDING_CACHE_INVALID",
      "Private Git cache is not the canonical cache for this run",
    );
    await this.#assertDirectory(runRoot, "LANDING_CACHE_INVALID", "Private run root is unsafe");
    await this.#assertDirectory(cachePath, "LANDING_CACHE_INVALID", "Private Git cache is unsafe");
    await this.#assertDirectory(
      path.join(cachePath, "objects"),
      "LANDING_CACHE_INVALID",
      "Private Git object directory is unsafe",
    );
    await this.#assertDirectory(
      path.join(cachePath, "refs"),
      "LANDING_CACHE_INVALID",
      "Private Git refs directory is unsafe",
    );
    const head = await lstat(path.join(cachePath, "HEAD")).catch(() => null);
    invariant(
      head?.isFile() === true && !head.isSymbolicLink(),
      "LANDING_CACHE_INVALID",
      "Private Git cache HEAD is unsafe",
    );
    await this.#assertForbiddenCacheFilesAbsent(cachePath);

    invariant(
      (await this.#line(
        cachePath,
        "inspect_bare",
        ["rev-parse", "--is-bare-repository"],
        signal,
      )) === "true",
      "LANDING_CACHE_INVALID",
      "Private Git cache is not bare",
    );
    const objectFormat = await this.#line(
      cachePath,
      "inspect_object_format",
      ["rev-parse", "--show-object-format"],
      signal,
    );
    invariant(
      objectFormat === "sha1",
      "UNSUPPORTED_GIT_OBJECT_FORMAT",
      "GitHub landing v1 requires the SHA-1 Git object format",
    );
    const metadata = await lstat(cachePath);
    return { path: cachePath, device: metadata.dev, inode: metadata.ino };
  }

  async #revalidateCache(identity: CacheIdentity): Promise<void> {
    const metadata = await lstat(identity.path).catch(() => null);
    const currentUid = process.getuid?.();
    invariant(
      metadata?.isDirectory() === true &&
        !metadata.isSymbolicLink() &&
        currentUid !== undefined &&
        metadata.uid === currentUid &&
        (metadata.mode & 0o022) === 0 &&
        metadata.dev === identity.device &&
        metadata.ino === identity.inode &&
        (await realpath(identity.path)) === identity.path,
      "LANDING_CACHE_INVALID",
      "Private Git cache identity changed during the operation",
    );
  }

  async #assertBase(
    cachePath: string,
    baseCommitSha1: string,
    baseTreeSha1: string,
    signal?: AbortSignal,
  ): Promise<void> {
    assertSha1(baseCommitSha1, "baseCommitSha1");
    assertSha1(baseTreeSha1, "baseTreeSha1");
    invariant(
      (await this.#line(
        cachePath,
        "inspect_base_type",
        ["cat-file", "-t", baseCommitSha1],
        signal,
      )) === "commit",
      "LANDING_BASE_INVALID",
      "Landing base object is not a commit",
    );
    invariant(
      (await this.#line(
        cachePath,
        "inspect_base_commit",
        ["rev-parse", "--verify", `${baseCommitSha1}^{commit}`],
        signal,
      )) === baseCommitSha1,
      "LANDING_BASE_INVALID",
      "Private Git cache does not contain the exact base commit",
    );
    invariant(
      (await this.#line(
        cachePath,
        "inspect_base_tree",
        ["rev-parse", "--verify", `${baseCommitSha1}^{tree}`],
        signal,
      )) === baseTreeSha1,
      "LANDING_BASE_INVALID",
      "Landing base tree does not match the exact base commit",
    );
  }

  async #hashBlob(cachePath: string, bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
    const expected = gitObjectSha1("blob", bytes);
    const result = await this.#run(
      cachePath,
      "hash_blob",
      ["hash-object", "--no-filters", "-t", "blob", "-w", "--stdin"],
      { signal, stdinBytes: bytes },
    );
    const output = new TextDecoder("utf-8", { fatal: true }).decode(result.stdoutBytes);
    invariant(
      output === `${expected}\n`,
      "LANDING_GIT_OUTPUT_INVALID",
      "Git blob identity does not match the approved bytes",
    );
    return expected;
  }

  async prepareCandidate(
    input: LandingCandidateInput,
    signal?: AbortSignal,
  ): Promise<LandingCandidateResult> {
    const identity = await this.#validateCache(input.cachePath, input.runId, signal);
    await this.#assertBase(input.cachePath, input.baseCommitSha1, input.baseTreeSha1, signal);
    const checkpointFiles = normalizeCheckpointFiles(input.checkpointFiles);
    invariant(
      input.reviewedDiffBytes.byteLength > 0 &&
        input.reviewedDiffBytes.byteLength <= GIT_OUTPUT_LIMIT,
      "LANDING_DIFF_INVALID",
      "Reviewed landing diff is empty or exceeds the local byte ceiling",
    );
    const reviewedDiff = Buffer.from(input.reviewedDiffBytes);
    const commitMessage = canonicalizeCommitMessage(input.commitMessage);
    invariant(
      commitMessage === input.commitMessage,
      "LANDING_RECORD_INVALID",
      "Landing commit message is not already canonical",
    );

    const temporaryRoot = await mkdtemp(path.join(this.#controlHome, ".icarus-landing-index-"));
    const indexPath = path.join(temporaryRoot, "index");
    try {
      await this.#run(input.cachePath, "read_base_tree", ["read-tree", input.baseCommitSha1], {
        signal,
        indexPath,
      });
      const changedPaths = checkpointFiles.map((file) => file.path);
      const baseEntries = parseIndexEntries(
        (
          await this.#run(
            input.cachePath,
            "inspect_base_entries",
            ["ls-files", "--stage", "-z", "--", ...changedPaths],
            { signal, indexPath, maxOutputBytes: GIT_OUTPUT_LIMIT },
          )
        ).stdoutBytes,
      );
      const baseByPath = new Map<string, IndexEntry>();
      for (const entry of baseEntries) {
        invariant(
          changedPaths.includes(entry.path) && !baseByPath.has(entry.path),
          "LANDING_BASE_INVALID",
          "Landing base has an ambiguous changed-path entry",
        );
        baseByPath.set(entry.path, entry);
      }

      const manifestEntries: CandidateObjectManifestEntryV1[] = [];
      const indexRecords: Buffer[] = [];
      for (const file of checkpointFiles) {
        const baseEntry = baseByPath.get(file.path);
        if (file.op === "create") {
          invariant(
            baseEntry === undefined,
            "LANDING_BASE_INVALID",
            "Landing create path already exists in the base tree",
          );
        } else {
          invariant(
            baseEntry !== undefined &&
              baseEntry.stage === 0 &&
              baseEntry.mode === "100644" &&
              file.baseline !== null &&
              baseEntry.objectId === gitObjectSha1("blob", file.baseline),
            "LANDING_BASE_INVALID",
            "Landing checkpoint baseline does not match one normal base-tree file",
          );
        }

        if (file.approved === null) {
          indexRecords.push(Buffer.from(`0 ${ZERO_SHA1}\t${file.path}\0`, "utf8"));
          manifestEntries.push({
            path: file.path,
            op: file.op,
            mode: "100644",
            blobSha1: null,
            contentBytes: null,
            contentSha256: null,
          });
          continue;
        }
        const blobSha1 = await this.#hashBlob(input.cachePath, file.approved, signal);
        indexRecords.push(Buffer.from(`100644 ${blobSha1}\t${file.path}\0`, "utf8"));
        manifestEntries.push({
          path: file.path,
          op: file.op,
          mode: "100644",
          blobSha1,
          contentBytes: file.approved.byteLength,
          contentSha256: sha256(file.approved),
        });
      }

      await this.#run(
        input.cachePath,
        "update_candidate_index",
        ["update-index", "-z", "--index-info"],
        { signal, indexPath, stdinBytes: Buffer.concat(indexRecords) },
      );
      const candidateEntries = parseIndexEntries(
        (
          await this.#run(
            input.cachePath,
            "inspect_candidate_entries",
            ["ls-files", "--stage", "-z", "--", ...changedPaths],
            { signal, indexPath, maxOutputBytes: GIT_OUTPUT_LIMIT },
          )
        ).stdoutBytes,
      );
      const candidateByPath = new Map(candidateEntries.map((entry) => [entry.path, entry]));
      for (const manifest of manifestEntries) {
        const entry = candidateByPath.get(manifest.path);
        invariant(
          manifest.op === "delete"
            ? entry === undefined
            : entry !== undefined &&
                entry.stage === 0 &&
                entry.mode === "100644" &&
                entry.objectId === manifest.blobSha1,
          "LANDING_GIT_OUTPUT_INVALID",
          "Candidate index does not contain the exact approved operation",
        );
      }

      const actualChanged = parseChangedPaths(
        (
          await this.#run(
            input.cachePath,
            "inspect_candidate_changes",
            [
              "diff-index",
              "--cached",
              "--name-status",
              "-z",
              "--no-renames",
              input.baseCommitSha1,
              "--",
            ],
            { signal, indexPath, maxOutputBytes: GIT_OUTPUT_LIMIT },
          )
        ).stdoutBytes,
      );
      invariant(
        actualChanged.length === checkpointFiles.length &&
          actualChanged.every((entry, index) => {
            const expected = checkpointFiles[index];
            return (
              expected !== undefined &&
              entry.path === expected.path &&
              entry.status ===
                (expected.op === "create" ? "A" : expected.op === "delete" ? "D" : "M")
            );
          }),
        "LANDING_GIT_OUTPUT_INVALID",
        "Candidate tree changes do not equal the canonical checkpoint operations",
      );

      const generatedDiff = (
        await this.#run(
          input.cachePath,
          "generate_candidate_diff",
          [
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
            input.baseCommitSha1,
            "--",
            ...changedPaths,
          ],
          { signal, indexPath, maxOutputBytes: GIT_OUTPUT_LIMIT },
        )
      ).stdoutBytes;
      invariant(
        Buffer.from(generatedDiff).equals(reviewedDiff),
        "LANDING_DIFF_MISMATCH",
        "Candidate diff is not byte-equal to the reviewed persisted diff",
      );

      const candidateTreeSha1 = await this.#lineWithIndex(
        input.cachePath,
        "write_candidate_tree",
        ["write-tree"],
        indexPath,
        signal,
      );
      assertSha1(candidateTreeSha1, "candidateTreeSha1");
      const commitPayload = buildUnsignedCommitPayloadV1({
        candidateTreeSha1,
        baseCommitSha1: input.baseCommitSha1,
        commitIdentity: input.commitIdentity,
        commitEpochSeconds: input.commitEpochSeconds,
        commitMessage,
      });
      const candidateCommitSha1 = gitObjectSha1("commit", commitPayload);
      const storedCommit = await this.#hashCommit(input.cachePath, commitPayload, signal);
      invariant(
        storedCommit === candidateCommitSha1,
        "LANDING_GIT_OUTPUT_INVALID",
        "Git commit identity does not match the canonical unsigned payload",
      );
      const candidateCommitPayloadSha256 = sha256(commitPayload);
      const candidateObjectManifest: CandidateObjectManifestV1 = {
        schemaVersion: 1,
        baseCommitSha1: input.baseCommitSha1,
        baseTreeSha1: input.baseTreeSha1,
        candidateTreeSha1,
        candidateCommitSha1,
        candidateCommitPayloadSha256,
        entries: manifestEntries,
      };
      const candidateObjectManifestSha256 = digestLandingRecord(candidateObjectManifest);
      await this.#revalidateCache(identity);
      return {
        objectFormat: "sha1",
        baseCommitSha1: input.baseCommitSha1,
        baseTreeSha1: input.baseTreeSha1,
        candidateTreeSha1,
        candidateCommitSha1,
        candidateCommitPayloadSha256,
        candidateObjectManifest,
        candidateObjectManifestSha256,
        diffByteEqual: true,
      };
    } finally {
      invariant(
        path.dirname(temporaryRoot) === this.#controlHome &&
          path.basename(temporaryRoot).startsWith(".icarus-landing-index-"),
        "LANDING_CACHE_INVALID",
        "Temporary landing index path escaped its controller root",
      );
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  async #lineWithIndex(
    cachePath: string,
    operation: string,
    command: readonly string[],
    indexPath: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const result = await this.#run(cachePath, operation, command, { signal, indexPath });
    const output = new TextDecoder("utf-8", { fatal: true }).decode(result.stdoutBytes);
    invariant(
      output.endsWith("\n") && output.indexOf("\n") === output.length - 1,
      "LANDING_GIT_OUTPUT_INVALID",
      "Git returned malformed machine output",
    );
    return output.slice(0, -1);
  }

  async #hashCommit(cachePath: string, payload: Uint8Array, signal?: AbortSignal): Promise<string> {
    const result = await this.#run(
      cachePath,
      "hash_commit",
      ["hash-object", "-t", "commit", "-w", "--stdin"],
      { signal, stdinBytes: payload },
    );
    const output = new TextDecoder("utf-8", { fatal: true }).decode(result.stdoutBytes);
    invariant(
      SHA1_PATTERN.test(output.slice(0, -1)) && output === `${output.slice(0, -1)}\n`,
      "LANDING_GIT_OUTPUT_INVALID",
      "Git returned a malformed commit identity",
    );
    return output.slice(0, -1);
  }

  async #readLocalRef(
    cachePath: string,
    headRef: string,
    signal?: AbortSignal,
  ): Promise<
    | { readonly kind: "absent" }
    | { readonly kind: "direct"; readonly sha1: string }
    | { readonly kind: "symbolic" }
  > {
    const symbolic = await this.#run(
      cachePath,
      "inspect_local_symbolic_ref",
      ["symbolic-ref", "--quiet", "--no-recurse", headRef],
      { signal, acceptedExitCodes: [0, 1] },
    );
    if (symbolic.exitCode === 0) return { kind: "symbolic" };
    invariant(
      symbolic.stdoutBytes.byteLength === 0,
      "LANDING_GIT_OUTPUT_INVALID",
      "Git symbolic-ref absence output is malformed",
    );
    const existence = await this.#run(
      cachePath,
      "inspect_local_direct_ref_existence",
      ["show-ref", "--verify", "--quiet", "--", headRef],
      { signal, acceptedExitCodes: [0, 1] },
    );
    invariant(
      existence.stdoutBytes.byteLength === 0 && existence.stderrBytes.byteLength === 0,
      "LANDING_GIT_OUTPUT_INVALID",
      "Git direct-ref existence output is malformed",
    );
    if (existence.exitCode === 1) {
      return { kind: "absent" };
    }
    const direct = await this.#run(
      cachePath,
      "inspect_local_direct_ref",
      ["show-ref", "--verify", "--hash", "--", headRef],
      { signal },
    );
    const output = new TextDecoder("utf-8", { fatal: true }).decode(direct.stdoutBytes);
    invariant(
      output.endsWith("\n") &&
        SHA1_PATTERN.test(output.slice(0, -1)) &&
        output.indexOf("\n") === output.length - 1,
      "LANDING_GIT_OUTPUT_INVALID",
      "Git direct-ref output is malformed",
    );
    const sha1 = output.slice(0, -1);
    invariant(
      (await this.#line(
        cachePath,
        "inspect_local_ref_target",
        ["cat-file", "-t", sha1],
        signal,
      )) === "commit",
      "LANDING_LOCAL_REF_CONFLICT",
      "Existing landing ref does not name one commit",
    );
    return { kind: "direct", sha1 };
  }

  async createAbsentLocalRef(
    input: LandingLocalRefInput,
    signal?: AbortSignal,
  ): Promise<LandingLocalRefResult> {
    const identity = await this.#validateCache(input.cachePath, input.runId, signal);
    assertSha1(input.candidateCommitSha1, "candidateCommitSha1");
    invariant(
      (await this.#line(
        input.cachePath,
        "inspect_candidate_commit",
        ["cat-file", "-t", input.candidateCommitSha1],
        signal,
      )) === "commit",
      "LANDING_LOCAL_REF_CONFLICT",
      "Landing candidate does not name one local commit",
    );
    const headRef = `refs/heads/icarus/${input.runId}`;
    const namespace = path.join(input.cachePath, "refs", "heads", "icarus");
    const namespaceMetadata = await lstat(namespace).catch(() => null);
    invariant(
      namespaceMetadata === null ||
        (namespaceMetadata.isDirectory() &&
          !namespaceMetadata.isSymbolicLink() &&
          (await realpath(namespace)) === namespace),
      "LANDING_LOCAL_REF_CONFLICT",
      "Landing local-ref namespace is unsafe or conflicting",
    );
    const namedRefMetadata = await lstat(path.join(namespace, input.runId)).catch(() => null);
    invariant(
      namedRefMetadata === null || !namedRefMetadata.isSymbolicLink(),
      "LANDING_LOCAL_REF_CONFLICT",
      "Landing local ref is a filesystem symbolic link",
    );
    invariant(
      (await this.#readLocalRef(input.cachePath, headRef, signal)).kind === "absent",
      "LANDING_LOCAL_REF_CONFLICT",
      "Landing local ref already exists or is symbolic",
    );

    const update = await this.#execute(
      input.cachePath,
      "create_local_ref",
      ["update-ref", "--no-deref", headRef, input.candidateCommitSha1, ZERO_SHA1],
      { signal },
    );
    if (
      update.cancelled ||
      update.timedOut ||
      update.rawLimitExceeded ||
      update.truncated ||
      update.exitCode !== 0
    ) {
      throw new IcarusError(
        update.cancelled ? "CANCELLED" : "LANDING_LOCAL_REF_CONFLICT",
        update.cancelled
          ? "Landing Git operation was cancelled"
          : "Landing local ref could not be created absent-only",
      );
    }
    const observed = await this.#readLocalRef(input.cachePath, headRef, signal);
    invariant(
      observed.kind === "direct" && observed.sha1 === input.candidateCommitSha1,
      "LANDING_LOCAL_REF_CONFLICT",
      "Landing local ref post-read does not match the candidate commit",
    );
    await this.#revalidateCache(identity);
    return {
      headRef,
      candidateCommitSha1: input.candidateCommitSha1,
      localRefOutcome: "created",
      updateRefExitCode: 0,
    };
  }
}
