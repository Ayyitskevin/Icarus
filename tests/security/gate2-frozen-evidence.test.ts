import {
  chmod,
  link,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  computeFrozenEntries,
  deriveRecordContract,
  freezeLiveEvidence,
  GATE2_FROZEN_EVIDENCE_SCHEMA,
  isFreezerRefusal,
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

describe("Gate 2 frozen evidence: one parser, regular files only", () => {
  it("refuses a manifest with a duplicated member, as the publisher does", async () => {
    // Native JSON.parse keeps the last duplicate silently; the publisher's strict parser
    // refuses it. Two verifiers reading one manifest two ways was a review finding.
    const root = await frozenSet();
    const manifestPath = path.join(root, "manifest.json");
    const text = await readFile(manifestPath, "utf8");
    await writeFile(
      manifestPath,
      text.replace(/^\{/, '{\n  "schema": "icarus.gate2-frozen-evidence.v2",'),
    );
    await expect(verifyFrozenEvidence(root)).rejects.toThrow(/duplicate JSON object members/);
  });

  it("refuses a listed record that is a symlink, even to byte-identical content", async () => {
    // A followed symlink would let the manifest vouch for bytes outside the frozen root.
    const root = await frozenSet();
    const outside = await mkdtemp(path.join(os.tmpdir(), "icarus-frozen-outside-"));
    roots.push(outside);
    const target = path.join(root, "routed", "case-a.json");
    await writeFile(path.join(outside, "case-a.json"), await readFile(target));
    await rm(target);
    await symlink(path.join(outside, "case-a.json"), target);
    const problems = await verifyFrozenEvidence(root);
    expect(problems).toEqual(["Gate 2 evidence freeze: routed/case-a.json is not a regular file"]);
  });
});

describe("Gate 2 frozen evidence: hard links and the catch boundary", () => {
  it("refuses a listed record that is hard-linked, as the publisher does", async () => {
    const root = await frozenSet();
    const outside = await mkdtemp(path.join(os.tmpdir(), "icarus-frozen-outside-"));
    roots.push(outside);
    await link(path.join(root, "routed", "case-a.json"), path.join(outside, "case-a.json"));
    expect(await verifyFrozenEvidence(root)).toEqual([
      "Gate 2 evidence freeze: routed/case-a.json is hard-linked",
    ]);
  });

  it.skipIf(process.getuid?.() === 0)(
    "reports only its own refusals as verdicts and rethrows anything else",
    async () => {
      // A directory the walk cannot read is a fault, not a finding about the evidence.
      // (Root ignores mode bits, so the condition cannot be staged there; skipped, not red.)
      const root = await frozenSet();
      await chmod(path.join(root, "routed"), 0o000);
      try {
        await expect(verifyFrozenEvidence(root)).rejects.toThrow(/EACCES|EPERM/);
      } finally {
        await chmod(path.join(root, "routed"), 0o700);
      }
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    "derives no contract from half a set: an unreadable arm is a fault, not an absence",
    async () => {
      // readRecords once read an unreadable directory as "no records here" and derived the
      // contract from the other arm alone. Only a missing directory is an absence.
      const root = await frozenSet();
      await chmod(path.join(root, "routed"), 0o000);
      try {
        await expect(deriveRecordContract(root)).rejects.toThrow(/EACCES|EPERM/);
      } finally {
        await chmod(path.join(root, "routed"), 0o700);
      }
    },
  );
});

describe("Gate 2 frozen evidence: the root and the second pass", () => {
  it("refuses a set root that resolves through a symlink, from both entry points", async () => {
    // Leaf symlinks were refused; a symlinked ROOT still let both verifiers vouch for a
    // whole set living outside the path they claimed to verify.
    const root = await frozenSet();
    const alias = path.join(await mkdtemp(path.join(os.tmpdir(), "icarus-frozen-alias-")), "set");
    roots.push(path.dirname(alias));
    await symlink(root, alias, "dir");
    const problems = await verifyFrozenEvidence(alias);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/resolves through a symlink to /);
    await expect(deriveRecordContract(alias)).rejects.toThrow(/resolves through a symlink/);
  });

  it("reports a record the strict parser refuses as a verdict", async () => {
    const root = await frozenSet();
    const target = path.join(root, "routed", "case-a.json");
    const text = await readFile(target, "utf8");
    await writeFile(target, text.replace(/^\{/, '{\n  "caseId": "case-a",'));
    const problems = await verifyFrozenEvidence(root);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^routed\/case-a\.json: manifest/),
        expect.stringMatching(/^recordContract: Gate 2 benchmark contract: .*duplicate/),
      ]),
    );
  });

  it("reports a directory named like a record as a verdict, from the walk", async () => {
    // This fixture has moved twice, each time one layer earlier. It once injected a
    // second-pass EISDIR: the walk recursed into the empty directory and the record read
    // hit it. Then the record read lstat-checked every record and it became a verdict
    // there. Now the walk refuses it first, because an empty directory holds no listed
    // file (issue #96) -- the same fact, said by the layer that sees the directory rather
    // than by the one that expected a record.
    const root = await frozenSet();
    await mkdir(path.join(root, "routed", "fault.json"));
    expect(await verifyFrozenEvidence(root)).toEqual([
      "Gate 2 evidence freeze: routed/fault.json holds no files",
    ]);
  });

  it("still reports a NON-empty directory named like a record from the record read", async () => {
    // The empty-directory rule must not swallow the record read's own type check: a
    // directory holding a file passes the walk's "holds no files" and is refused where a
    // record was expected.
    const root = await frozenSet();
    await mkdir(path.join(root, "routed", "fault.json"));
    await writeFile(path.join(root, "routed", "fault.json", "inner.json"), "{}\n");
    expect(await verifyFrozenEvidence(root)).toEqual(
      expect.arrayContaining([
        "recordContract: Gate 2 evidence freeze: routed/fault.json is not a regular file",
      ]),
    );
  });

  it("classifies only deliberate refusals as verdicts", () => {
    expect(isFreezerRefusal(new Error("Gate 2 evidence freeze: x is hard-linked"))).toBe(true);
    expect(
      isFreezerRefusal(new Error("Gate 2 benchmark contract: manifest must be strict JSON")),
    ).toBe(true);
    expect(isFreezerRefusal(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }))).toBe(
      false,
    );
    expect(isFreezerRefusal("not an error")).toBe(false);
  });
});

describe("Gate 2 frozen evidence: the root check runs before the manifest read", () => {
  it("reports a root that does not exist as a verdict, not an ENOENT crash", async () => {
    // The guard already existed, inside `computeFrozenEntries`; the manifest read reached
    // ENOENT first, so a fact about the directory surfaced as a fault (issue #88).
    const parent = await mkdtemp(path.join(os.tmpdir(), "icarus-frozen-absent-"));
    roots.push(parent);
    const absent = path.join(parent, "no-such-set");
    expect(await verifyFrozenEvidence(absent)).toEqual([
      `Gate 2 evidence freeze: ${absent} does not exist`,
    ]);
  });

  it("reports a regular file given as a root as a verdict", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "icarus-frozen-file-"));
    roots.push(parent);
    const file = path.join(parent, "not-a-directory");
    await writeFile(file, "{}\n");
    expect(await verifyFrozenEvidence(file)).toEqual([
      `Gate 2 evidence freeze: ${file} is not a directory`,
    ]);
  });

  it("still verifies the repository's committed set", async () => {
    const repositoryRoot = decodeURIComponent(new URL("../../", import.meta.url).pathname);
    expect(
      await verifyFrozenEvidence(
        path.join(repositoryRoot, "docs/evals/artifacts/gate2-reasoning-suppressed-20260901"),
      ),
    ).toEqual([]);
  });
});

describe("Gate 2 frozen evidence: no read before the closed-tree verdict", () => {
  it("refuses a symlinked manifest before parsing it, so planted outside bytes never speak", async () => {
    // A review moved manifest.json outside the set behind a symlink and planted a duplicate
    // member in the outside copy; the parser reported the planted bytes before the walk.
    const root = await frozenSet();
    const outside = await mkdtemp(path.join(os.tmpdir(), "icarus-frozen-outside-"));
    roots.push(outside);
    const manifestPath = path.join(root, "manifest.json");
    const text = await readFile(manifestPath, "utf8");
    await writeFile(
      path.join(outside, "manifest.json"),
      text.replace(/^\{/, '{\n  "schema": "icarus.gate2-frozen-evidence.v2",'),
    );
    await rm(manifestPath);
    await symlink(path.join(outside, "manifest.json"), manifestPath);
    const problems = await verifyFrozenEvidence(root);
    expect(problems).toEqual(["Gate 2 evidence freeze: manifest.json is not a regular file"]);
  });

  it("refuses a symlinked record directory from both entry points, before any record read", async () => {
    const root = await frozenSet();
    const outside = await mkdtemp(path.join(os.tmpdir(), "icarus-frozen-outside-"));
    roots.push(outside);
    const routed = path.join(root, "routed");
    const text = await readFile(path.join(routed, "case-a.json"), "utf8");
    await writeFile(
      path.join(outside, "case-a.json"),
      text.replace(/^\{/, '{\n  "caseId": "case-a",'),
    );
    await rm(routed, { recursive: true });
    await symlink(outside, routed, "dir");
    expect(await verifyFrozenEvidence(root)).toEqual([
      "Gate 2 evidence freeze: routed is not a regular file",
    ]);
    await expect(deriveRecordContract(root)).rejects.toThrow(/routed is not a regular file/);
  });

  it("refuses a symlinked record file on the direct contract path", async () => {
    const root = await frozenSet();
    const outside = await mkdtemp(path.join(os.tmpdir(), "icarus-frozen-outside-"));
    roots.push(outside);
    const target = path.join(root, "routed", "case-a.json");
    await writeFile(path.join(outside, "case-a.json"), await readFile(target));
    await rm(target);
    await symlink(path.join(outside, "case-a.json"), target);
    await expect(deriveRecordContract(root)).rejects.toThrow(
      /routed\/case-a\.json is not a regular file/,
    );
  });
});

describe("Gate 2 frozen evidence: a directory named like the manifest", () => {
  it("is a verdict from the walk, never an EISDIR fault at the read", async () => {
    const root = await frozenSet();
    await rm(path.join(root, "manifest.json"));
    await mkdir(path.join(root, "manifest.json"));
    expect(await verifyFrozenEvidence(root)).toEqual([
      "Gate 2 evidence freeze: manifest.json is not a regular file",
    ]);
  });
});

describe("Gate 2 frozen evidence: a directory that holds no listed file", () => {
  it("refuses an empty stray directory, at the root and nested", async () => {
    // Directories are walked but never listed, so an EMPTY one carried no bytes,
    // contributed no entry, and nothing objected. "The directory is closed" has to mean it
    // holds exactly the listed files; a directory holding none of them is not part of the
    // set, wherever it sits (issue #96).
    for (const stray of ["an-empty-stray-directory", "routed/empty-nested", "a/b/c"]) {
      const root = await frozenSet();
      await mkdir(path.join(root, stray), { recursive: true });
      const problems = await verifyFrozenEvidence(root);
      // `a/b/c` is refused at its deepest empty directory, which is the one that holds
      // nothing; the parents hold it, so they are not the finding.
      expect(problems).toEqual([`Gate 2 evidence freeze: ${stray} holds no files`]);
    }
  });

  it("still accepts the set's own record directories, which do hold files", async () => {
    expect(await verifyFrozenEvidence(await frozenSet())).toEqual([]);
  });
});

describe("Gate 2 freeze: the live directory, before anything is created", () => {
  it("refuses a symlinked record in the source and creates no destination", async () => {
    // `cp` copies a symlink as a symlink, so a link in the source becomes a link in the
    // frozen set -- and every check that would catch it ran after the copy, the formatter
    // and two reads. The source is walked before `mkdir`, so a refused freeze leaves
    // nothing behind (issue #93).
    const live = await liveSet();
    const outside = await mkdtemp(path.join(os.tmpdir(), "icarus-freeze-outside-"));
    roots.push(outside);
    const record = path.join(live, "routed", "case-a.json");
    await writeFile(path.join(outside, "case-a.json"), await readFile(record));
    await rm(record);
    await symlink(path.join(outside, "case-a.json"), record);
    const destination = path.join(outside, "frozen");
    await expect(
      freezeLiveEvidence({
        from: live,
        to: destination,
        commit: "abc1234",
        policyRevision: 9,
        evidenceRevision: 6,
      }),
    ).rejects.toThrow(/routed\/case-a\.json in the live directory is not a regular file/);
    expect(await stat(destination).catch(() => null)).toBeNull();
  });

  it("refuses a hard-linked record in the source", async () => {
    const live = await liveSet();
    const outside = await mkdtemp(path.join(os.tmpdir(), "icarus-freeze-outside-"));
    roots.push(outside);
    await link(path.join(live, "routed", "case-a.json"), path.join(outside, "alias.json"));
    const destination = path.join(outside, "frozen");
    await expect(
      freezeLiveEvidence({
        from: live,
        to: destination,
        commit: "abc1234",
        policyRevision: 9,
        evidenceRevision: 6,
      }),
    ).rejects.toThrow(/routed\/case-a\.json in the live directory is hard-linked/);
    expect(await stat(destination).catch(() => null)).toBeNull();
  });
});
