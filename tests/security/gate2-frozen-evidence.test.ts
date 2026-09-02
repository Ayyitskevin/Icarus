import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  computeFrozenEntries,
  deriveRecordContract,
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
 *
 * Schema v2 adds a second claim the manifest can get wrong: `recordContract`, what the
 * records encode. It is derived from the record bytes on freeze and re-derived on verify,
 * so a manifest that states a revision, a `requestedThink` presence, or a write date the
 * records contradict is refused the same way a wrong digest is.
 */
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const POLICY = "a".repeat(64);
const PROFILE = "b".repeat(64);

function record(caseId: string, overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify(
    {
      caseId,
      evidenceRecordRevision: 6,
      generatedAt: "2026-09-02T15:04:05.000Z",
      instructionPolicySha256: POLICY,
      executionProfileDigestSha256: PROFILE,
      requestedThink: false,
      reasoningChars: null,
      ...overrides,
    },
    null,
    2,
  )}\n`;
}

async function liveSet(records: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "icarus-frozen-evidence-"));
  roots.push(root);
  await mkdir(path.join(root, "baseline"));
  await mkdir(path.join(root, "routed"));
  const files: Record<string, string> = {
    "baseline/case-a.json": record("case-a"),
    "routed/case-a.json": record("case-a"),
    "comparison.json": '{\n  "passed": false\n}\n',
    "preflight.json": `${JSON.stringify(
      { instructionPolicySha256: POLICY, executionProfileDigestSha256: PROFILE },
      null,
      2,
    )}\n`,
    ...records,
  };
  for (const [relative, body] of Object.entries(files)) {
    await writeFile(path.join(root, relative), body);
  }
  return root;
}

async function frozenSet(): Promise<string> {
  const root = await liveSet();
  await writeManifest(root, { recordContract: await deriveRecordContract(root) });
  return root;
}

async function writeManifest(root: string, overrides: Record<string, unknown>): Promise<void> {
  const manifest = {
    schema: GATE2_FROZEN_EVIDENCE_SCHEMA,
    evidenceRecordRevision: 6,
    files: await computeFrozenEntries(root),
    ...overrides,
  };
  await writeFile(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

describe("Gate 2 frozen evidence verifier", () => {
  it("accepts a manifest that is true of the committed bytes", async () => {
    const root = await frozenSet();
    expect(await verifyFrozenEvidence(root)).toEqual([]);
  });

  it("fails when a file's bytes no longer match the digest that was recorded", async () => {
    // The formatter case: same JSON, different bytes.
    const root = await frozenSet();
    const compact = `${JSON.stringify(JSON.parse(record("case-a")))}\n`;
    await writeFile(path.join(root, "routed", "case-a.json"), compact);
    const problems = await verifyFrozenEvidence(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^routed\/case-a\.json: manifest/);
  });

  it("fails on a listed file that is absent and on a present file that is unlisted", async () => {
    // The directory is closed to every file, not only JSON: a stray text file at the top
    // level and a stray note inside a record directory are both refused, the same way the
    // publisher refuses them.
    const root = await frozenSet();
    await rm(path.join(root, "comparison.json"));
    await writeFile(path.join(root, "stray.txt"), "not evidence\n");
    await writeFile(path.join(root, "routed", "scratch.md"), "# notes\n");
    const problems = await verifyFrozenEvidence(root);
    expect(problems).toEqual(
      expect.arrayContaining([
        "comparison.json: listed but absent",
        "stray.txt: present but unlisted",
        "routed/scratch.md: present but unlisted",
      ]),
    );
  });

  it("never lists the manifest as one of its own entries", async () => {
    const root = await frozenSet();
    const entries = await computeFrozenEntries(root);
    expect(entries.map((entry) => entry.path)).not.toContain("manifest.json");
  });

  it("refuses a manifest whose record contract says what the records contradict", async () => {
    const root = await frozenSet();
    const derived = await deriveRecordContract(root);
    await writeManifest(root, {
      recordContract: {
        ...derived,
        requestedThinkMemberPresent: !derived.requestedThinkMemberPresent,
      },
    });
    const problems = await verifyFrozenEvidence(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^recordContract: manifest .* != bytes /);
  });

  it("refuses a set whose records disagree with each other, digests aside", async () => {
    const root = await frozenSet();
    await writeFile(
      path.join(root, "routed", "case-a.json"),
      record("case-a", { evidenceRecordRevision: 5 }),
    );
    const problems = await verifyFrozenEvidence(root);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^routed\/case-a\.json: manifest/),
        expect.stringMatching(
          /^recordContract: .*records disagree on evidenceRecordRevision: 6, 5/,
        ),
      ]),
    );
  });
});

describe("Gate 2 frozen evidence record contract", () => {
  it("is derived from the records, with the absence encoding keyed on their revision", async () => {
    const root = await liveSet();
    expect(await deriveRecordContract(root)).toEqual({
      evidenceRecordRevision: 6,
      requestedThinkMemberPresent: true,
      absentThinkingEncodedAs: null,
      writtenOn: "2026-09-02",
      everyRecordReasoningChars: null,
    });
  });

  it("claims one reasoning size only when every record reports it", async () => {
    const root = await liveSet({ "routed/case-a.json": record("case-a", { reasoningChars: 12 }) });
    const contract = await deriveRecordContract(root);
    expect(Object.hasOwn(contract, "everyRecordReasoningChars")).toBe(false);
  });

  it("refuses a revision whose absence encoding it does not know rather than guess one", async () => {
    const root = await liveSet({
      "baseline/case-a.json": record("case-a", { evidenceRecordRevision: 7 }),
      "routed/case-a.json": record("case-a", { evidenceRecordRevision: 7 }),
    });
    await expect(deriveRecordContract(root)).rejects.toThrow(
      /no absent-thinking encoding is known for evidence record revision 7/,
    );
  });

  it("refuses a set written across two UTC dates, since the schema carries one", async () => {
    const root = await liveSet({
      "routed/case-a.json": record("case-a", { generatedAt: "2026-09-03T00:00:01.000Z" }),
    });
    await expect(deriveRecordContract(root)).rejects.toThrow(
      /records disagree on the UTC date written/,
    );
  });
});

describe("Gate 2 frozen evidence on the committed bytes", () => {
  it("accepts the repository's frozen 2026-09-01 set, the only bytes the verifier exists for", async () => {
    // Every other test here points at a temp fixture. This one points at the real set, so
    // a verifier that refuses the repository's own evidence cannot ship green again.
    const repositoryRoot = decodeURIComponent(new URL("../../", import.meta.url).pathname);
    const committed = path.join(
      repositoryRoot,
      "docs/evals/artifacts/gate2-reasoning-suppressed-20260901",
    );
    expect(await verifyFrozenEvidence(committed)).toEqual([]);
    expect(await deriveRecordContract(committed)).toEqual({
      evidenceRecordRevision: 5,
      requestedThinkMemberPresent: false,
      absentThinkingEncodedAs: 0,
      writtenOn: "2026-09-01",
      everyRecordReasoningChars: 0,
    });
  });
});
