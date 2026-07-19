import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, link, lstat, mkdir, open, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { IcarusError, invariant } from "./errors.js";
import type { JsonValue } from "./types.js";

const ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export class ArtifactStore {
  readonly #root: string;

  constructor(stateRoot: string) {
    this.#root = path.join(stateRoot, "artifacts");
  }

  #runRoot(runId: string): string {
    invariant(ID_PATTERN.test(runId), "INVALID_RUN_ID", "Run ID is invalid");
    return path.join(this.#root, runId);
  }

  async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(this.#root);
    invariant(
      rootStat.isDirectory() && !rootStat.isSymbolicLink(),
      "UNSAFE_STATE_ROOT",
      "Artifact root is unsafe",
    );
    await chmod(this.#root, 0o700);
  }

  async writeJson(runId: string, name: string, value: JsonValue): Promise<string> {
    invariant(NAME_PATTERN.test(name), "INVALID_ARTIFACT_NAME", "Artifact name is invalid");
    const runRoot = this.#runRoot(runId);
    await mkdir(runRoot, { recursive: false, mode: 0o700 }).catch(async (error: unknown) => {
      const existing = await lstat(runRoot).catch(() => null);
      if (existing === null || !existing.isDirectory() || existing.isSymbolicLink()) {
        throw error;
      }
    });
    const runRootStat = await lstat(runRoot);
    invariant(
      runRootStat.isDirectory() && !runRootStat.isSymbolicLink(),
      "UNSAFE_ARTIFACT_PATH",
      "Run artifact directory is unsafe",
    );
    await chmod(runRoot, 0o700);
    const destination = path.join(runRoot, name);
    const temporary = path.join(runRoot, `.${name}.${randomUUID()}.tmp`);
    const serialized = `${JSON.stringify(value)}\n`;
    await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      await link(temporary, destination);
      await unlink(temporary);
      await chmod(destination, 0o600);
      return destination;
    } catch (_error) {
      await unlink(temporary).catch(() => undefined);
      let existing: Buffer;
      try {
        existing = await this.#readOwnedFile(destination, Buffer.byteLength(serialized, "utf8"));
      } catch (readError) {
        if (readError instanceof IcarusError && readError.code === "ARTIFACT_TOO_LARGE") {
          throw new IcarusError(
            "IMMUTABLE_ARTIFACT_CONFLICT",
            "An immutable artifact already exists with different contents",
          );
        }
        throw readError;
      }
      invariant(
        existing.toString("utf8") === serialized,
        "IMMUTABLE_ARTIFACT_CONFLICT",
        "An immutable artifact already exists with different contents",
      );
      return destination;
    }
  }

  async readJson(artifactPath: string, maxBytes: number): Promise<unknown> {
    const canonicalRoot = `${path.resolve(this.#root)}${path.sep}`;
    const resolved = path.resolve(artifactPath);
    invariant(
      resolved.startsWith(canonicalRoot),
      "ARTIFACT_ESCAPE",
      "Artifact path escapes the state root",
    );
    const bytes = await this.#readOwnedFile(resolved, maxBytes);
    try {
      return JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      throw new IcarusError("INVALID_ARTIFACT", "Artifact contains invalid JSON");
    }
  }

  async removeRun(runId: string): Promise<void> {
    const runRoot = this.#runRoot(runId);
    const entryStat = await lstat(runRoot).catch(() => null);
    if (entryStat === null) {
      return;
    }
    invariant(
      entryStat.isDirectory() && !entryStat.isSymbolicLink(),
      "UNSAFE_ARTIFACT_PATH",
      "Refusing to remove an unsafe artifact directory",
    );
    await rm(runRoot, { recursive: true, force: true });
  }

  async #readOwnedFile(filePath: string, maxBytes: number): Promise<Buffer> {
    const root = path.resolve(this.#root);
    const resolved = path.resolve(filePath);
    const relative = path.relative(root, resolved);
    invariant(
      relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative),
      "ARTIFACT_ESCAPE",
      "Artifact path escapes the state root",
    );
    let current = root;
    const components = relative.split(path.sep);
    for (const [index, component] of components.entries()) {
      current = path.join(current, component);
      const entryStat = await lstat(current);
      invariant(
        !entryStat.isSymbolicLink(),
        "UNSAFE_ARTIFACT_PATH",
        "Artifact path contains a symlink",
      );
      if (index < components.length - 1) {
        invariant(
          entryStat.isDirectory(),
          "UNSAFE_ARTIFACT_PATH",
          "Artifact parent is not a directory",
        );
      } else {
        invariant(
          entryStat.isFile() && entryStat.nlink === 1,
          "UNSAFE_ARTIFACT_PATH",
          "Artifact is not an owned regular file",
        );
        invariant(
          entryStat.size <= maxBytes,
          "ARTIFACT_TOO_LARGE",
          "Artifact exceeds the read ceiling",
        );
      }
    }
    const handle = await open(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const handleStat = await handle.stat();
      invariant(
        handleStat.isFile() && handleStat.nlink === 1 && handleStat.size <= maxBytes,
        "UNSAFE_ARTIFACT_PATH",
        "Artifact identity changed during read",
      );
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }
}
