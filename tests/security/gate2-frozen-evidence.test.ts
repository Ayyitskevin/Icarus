import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  computeFrozenEntries,
  GATE2_FROZEN_EVIDENCE_SCHEMA,
  verifyFrozenEvidence,
} from "../../scripts/gate2-freeze-live-evidence.mjs";

/**
 * Why this boundary exists.
 *
 * A frozen evidence set is the only thing that lets a reader recompute an evaluation's
 * figures from the repository instead of trusting prose. On 2026-09-01 the first such
 * manifest was hashed before the formatter reflowed the files, 30 of 64 digests were
 * wrong, and nothing in the gate read the directory — so the layer that existed to make
 * stale figures catchable asserted something untrue and stayed green. The verifier must
 * fail on a wrong digest, a missing file, and an unlisted file, and must never trust the
 * manifest's own entry for itself.
 */
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function frozenSet(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "icarus-frozen-evidence-"));
  roots.push(root);
  await mkdir(path.join(root, "routed"));
  await writeFile(path.join(root, "routed", "case-a.json"), '{\n  "caseId": "case-a"\n}\n');
  await writeFile(path.join(root, "comparison.json"), '{\n  "passed": false\n}\n');
  const files = await computeFrozenEntries(root);
  await writeFile(
    path.join(root, "manifest.json"),
    `${JSON.stringify({ schema: GATE2_FROZEN_EVIDENCE_SCHEMA, files }, null, 2)}\n`,
  );
  return root;
}

describe("Gate 2 frozen evidence verifier", () => {
  it("accepts a manifest that is true of the committed bytes", async () => {
    const root = await frozenSet();
    expect(await verifyFrozenEvidence(root)).toEqual([]);
  });

  it("fails when a file's bytes no longer match the digest that was recorded", async () => {
    // The formatter case: same JSON, different bytes.
    const root = await frozenSet();
    await writeFile(path.join(root, "routed", "case-a.json"), '{"caseId":"case-a"}\n');
    const problems = await verifyFrozenEvidence(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^routed\/case-a\.json: manifest/);
  });

  it("fails on a listed file that is absent and on a present file that is unlisted", async () => {
    const root = await frozenSet();
    await rm(path.join(root, "comparison.json"));
    await writeFile(path.join(root, "routed", "case-b.json"), "{}\n");
    const problems = await verifyFrozenEvidence(root);
    expect(problems).toEqual(
      expect.arrayContaining([
        "comparison.json: listed but absent",
        "routed/case-b.json: present but unlisted",
      ]),
    );
  });

  it("never lists the manifest as one of its own entries", async () => {
    const root = await frozenSet();
    const entries = await computeFrozenEntries(root);
    expect(entries.map((entry) => entry.path)).not.toContain("manifest.json");
  });
});
