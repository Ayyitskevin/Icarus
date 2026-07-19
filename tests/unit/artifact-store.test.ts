import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../../packages/core/src/artifacts.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import { UNIT_RUN_ID } from "../support/unit-fixtures.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("immutable artifact store", () => {
  it("makes identical writes idempotent and rejects conflicting bytes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "icarus-unit-artifact-"));
    temporaryRoots.push(root);
    const store = new ArtifactStore(root);
    await store.initialize();

    const first = await store.writeJson(UNIT_RUN_ID, "context.json", { value: 1 });
    const second = await store.writeJson(UNIT_RUN_ID, "context.json", { value: 1 });
    expect(second).toBe(first);
    expect(await readFile(first, "utf8")).toBe('{"value":1}\n');

    try {
      await store.writeJson(UNIT_RUN_ID, "context.json", { value: 2 });
      throw new Error("Expected immutable artifact conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(IcarusError);
      expect((error as IcarusError).code).toBe("IMMUTABLE_ARTIFACT_CONFLICT");
    }
  });
});
