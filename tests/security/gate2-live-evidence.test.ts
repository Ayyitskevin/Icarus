import { createHash } from "node:crypto";
import {
  cp,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyFrozenEvidence } from "../../scripts/gate2-freeze-live-evidence.mjs";
import {
  isGate2ProviderOutcomeBound,
  recordContractBound,
  verifyGate2PublishedEvidence,
  verifyGate2PublishedEvidenceSet,
} from "../../scripts/gate2-live-evidence-publish.mjs";

const repositoryRoot = decodeURIComponent(new URL("../../", import.meta.url).pathname);
const FROZEN_ARTIFACT_RELATIVE = "docs/evals/artifacts/gate2-reasoning-suppressed-20260901";

/** Rewrites the manifest's digests so only a check other than the digest can object. */
async function repairManifest(artifactDirectory: string): Promise<void> {
  const manifestPath = path.join(artifactDirectory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const entry of manifest.files as Array<{ path: string; bytes: number; sha256: string }>) {
    const bytes = await readFile(path.join(artifactDirectory, entry.path));
    entry.bytes = bytes.length;
    entry.sha256 = createHash("sha256").update(bytes).digest("hex");
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** A disposable copy of any published set, for a tamper case outside the frozen branch. */
async function withPublishedCopy(
  directory: string,
  body: (temporary: string, artifactDirectory: string) => Promise<void>,
): Promise<void> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "icarus-gate2-published-copy-"));
  try {
    await cp(path.join(repositoryRoot, "fixtures"), path.join(temporary, "fixtures"), {
      recursive: true,
    });
    const relative = path.join("docs/evals/artifacts", directory);
    await mkdir(path.join(temporary, "docs/evals/artifacts"), { recursive: true });
    await cp(path.join(repositoryRoot, relative), path.join(temporary, relative), {
      recursive: true,
    });
    await body(temporary, path.join(temporary, relative));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** A disposable copy of the frozen set, so a tamper test never writes the real one. */
async function withFrozenCopy(
  body: (temporary: string, artifactDirectory: string) => Promise<void>,
): Promise<void> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "icarus-gate2-frozen-"));
  try {
    await cp(path.join(repositoryRoot, "fixtures"), path.join(temporary, "fixtures"), {
      recursive: true,
    });
    await mkdir(path.join(temporary, "docs/evals/artifacts"), { recursive: true });
    await cp(
      path.join(repositoryRoot, FROZEN_ARTIFACT_RELATIVE),
      path.join(temporary, FROZEN_ARTIFACT_RELATIVE),
      { recursive: true },
    );
    await body(temporary, path.join(temporary, FROZEN_ARTIFACT_RELATIVE));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

describe("Gate 2 published live evidence", () => {
  it("recomputes both 30-case results, their comparison, and every retained evidence digest", async () => {
    const verified = await verifyGate2PublishedEvidence(repositoryRoot, "v1");
    expect(verified.files).toHaveLength(64);
    expect(verified.baseline.aggregates).toMatchObject({
      taskCount: 30,
      measuredTaskCount: 30,
      successCount: 5,
      thresholdsPassed: false,
    });
    expect(verified.routed.aggregates).toMatchObject({
      taskCount: 30,
      measuredTaskCount: 30,
      successCount: 9,
      thresholdsPassed: false,
    });
    expect(verified.comparison).toMatchObject({
      baselineSuccessCount: 5,
      routedSuccessCount: 9,
      successCountRatio: 1.8,
      costReduction: 0.369962846348,
      passed: false,
    });
  });

  it("revalidates every published evidence version as one publication set", async () => {
    const verified = await verifyGate2PublishedEvidenceSet(repositoryRoot);
    expect(verified.v1.files).toHaveLength(64);
    expect(verified.v2.files).toHaveLength(64);
    expect(verified.reasoningSuppressed.files).toHaveLength(64);
  });

  it("recomputes leak-free target-discovery evidence", async () => {
    const verified = await verifyGate2PublishedEvidence(repositoryRoot, "v2");
    expect(verified.files).toHaveLength(64);
    expect(verified.manifest).toMatchObject({
      executionProfileDigestSha256:
        "03399661d25002304f160f2e4959fe1a0e2be826bb752671e1234c8e34496169",
      instructionPolicySha256: "5b299c7c27cd38d3f070d4c673c0234eaf257761d3cc294e49a1fbbbf023270d",
      routingPolicySha256: "01c96e8eedc4376cae8aab5fb1c354e9fe84f8fa18ae1a77ed93875724ccd54a",
    });
    expect(verified.baseline.aggregates).toMatchObject({
      taskCount: 30,
      measuredTaskCount: 30,
      successCount: 5,
      firstPassPlanAcceptance: 0.266666666667,
      thresholdsPassed: false,
    });
    expect(verified.routed.aggregates).toMatchObject({
      taskCount: 30,
      measuredTaskCount: 30,
      successCount: 16,
      firstPassPlanAcceptance: 0.766666666667,
      incorrectEdits: 0,
      thresholdsPassed: false,
    });
    expect(verified.comparison).toMatchObject({
      baselineSuccessCount: 5,
      routedSuccessCount: 16,
      successCountRatio: 3.2,
      costReduction: 0.554217121588,
      passed: false,
    });
  });

  it("recomputes the frozen reasoning-suppressed set against its committed bytes", async () => {
    const verified = await verifyGate2PublishedEvidence(repositoryRoot, "reasoning-suppressed");
    expect(verified.files).toHaveLength(64);
    expect(verified.manifest).toMatchObject({
      schema: "icarus.gate2-frozen-evidence.v2",
      evidenceRecordRevision: 5,
      executionProfileDigestSha256:
        "03399661d25002304f160f2e4959fe1a0e2be826bb752671e1234c8e34496169",
      instructionPolicySha256: "e6fb3111f6d2b9fe5d267117f705e1043ac7755fc14cca3ad499693094c6de57",
      // The declaration that lets a reader tell this set's zeros from a revision-6 zero.
      recordContract: {
        absentThinkingEncodedAs: 0,
        everyRecordReasoningChars: 0,
        evidenceRecordRevision: 5,
        requestedThinkMemberPresent: false,
        writtenOn: "2026-09-01",
      },
    });
    // The figures ADR 0070 reports, recomputed from the committed records rather than
    // read back from the prose beside them.
    expect(verified.baseline.aggregates).toMatchObject({
      taskCount: 30,
      measuredTaskCount: 30,
      successCount: 2,
      firstPassPlanAcceptance: 0.066666666667,
      incorrectEdits: 0,
      thresholdsPassed: false,
    });
    expect(verified.routed.aggregates).toMatchObject({
      taskCount: 30,
      measuredTaskCount: 30,
      successCount: 12,
      firstPassPlanAcceptance: 0.6,
      incorrectEdits: 0,
      thresholdsPassed: false,
    });
  });

  it("refuses a frozen record whose bytes drifted from the manifest", async () => {
    await withFrozenCopy(async (temporary, artifactDirectory) => {
      const recordPath = path.join(artifactDirectory, "baseline/explain-basic-guardrails.json");
      const record = JSON.parse(await readFile(recordPath, "utf8"));
      record.generatedAt = "2026-09-01T23:59:59.999Z";
      await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
      await expect(verifyGate2PublishedEvidence(temporary, "reasoning-suppressed")).rejects.toThrow(
        "frozen evidence manifest is invalid",
      );
    });
  });

  it("refuses a file the frozen manifest never listed", async () => {
    await withFrozenCopy(async (temporary, artifactDirectory) => {
      // An unlisted file is screened by nothing: not the digest comparison it is absent
      // from, and not the secret scan that only walks the listed paths. The refusal now
      // comes from the freezer's walk, which is the repository's one digest walk.
      await writeFile(path.join(artifactDirectory, "extra.json"), "{}\n");
      await expect(verifyGate2PublishedEvidence(temporary, "reasoning-suppressed")).rejects.toThrow(
        "extra.json: present but unlisted",
      );
    });
  });

  it("screens the frozen set for secret shapes rather than trusting its age", async () => {
    await withFrozenCopy(async (temporary, artifactDirectory) => {
      const recordPath = path.join(artifactDirectory, "routed/explain-lantern-flow.json");
      const record = JSON.parse(await readFile(recordPath, "utf8"));
      record.password = "correct-horse-battery-staple";
      await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
      // The manifest is repaired so the digest cannot object: a secret-shaped span is
      // exactly what a true manifest cannot see, and the screen is the only layer left.
      await repairManifest(artifactDirectory);
      await expect(verifyGate2PublishedEvidence(temporary, "reasoning-suppressed")).rejects.toThrow(
        "routed/explain-lantern-flow.json contains an unknown secret-shaped span",
      );
    });
  });

  it("refuses a set whose declared contract is internally true but not the reviewed one", async () => {
    // After the reorder the freezer speaks first, and it re-derives the record contract
    // from the records -- so a manifest that merely disagrees with its own bytes never
    // reaches this publisher. What remains this publisher's alone is the REVIEWED pin: a
    // set frozen honestly under a different contract is internally true and still not the
    // one whose figures were reviewed. Every record is rewritten so the derivation agrees.
    await withFrozenCopy(async (temporary, artifactDirectory) => {
      for (const mode of ["baseline", "routed"]) {
        const directory = path.join(artifactDirectory, mode);
        for (const name of await readdir(directory)) {
          const recordPath = path.join(directory, name);
          const record = JSON.parse(await readFile(recordPath, "utf8"));
          record.reasoningChars = 5;
          await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
        }
      }
      const manifestPath = path.join(artifactDirectory, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.recordContract.everyRecordReasoningChars = 5;
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      await repairManifest(artifactDirectory);
      // The freezer is satisfied: the manifest now describes its own bytes exactly.
      expect(await verifyFrozenEvidence(artifactDirectory)).toEqual([]);
      // The publisher is not, and `recordContractBound` is what refuses it -- per record,
      // inside the read pass, before the manifest-versus-config pin further down gets a
      // turn. Both are this publisher's; the freezer cannot make either judgement, because
      // "internally true" is all it can see.
      await expect(verifyGate2PublishedEvidence(temporary, "reasoning-suppressed")).rejects.toThrow(
        /published case record is not bound:/,
      );
    });
  });

  it("refuses one drifted record, and names the layer that caught it", async () => {
    // One record disagreeing with the other 59 makes the derived contract drop
    // `everyRecordReasoningChars`, so the manifest's declaration no longer matches the
    // bytes. That is the freezer's verdict now, one layer earlier than before, and the
    // message must say so rather than blaming the publisher's own binding.
    await withFrozenCopy(async (temporary, artifactDirectory) => {
      const relative = "routed/explain-lantern-flow.json";
      const recordPath = path.join(artifactDirectory, relative);
      const record = JSON.parse(await readFile(recordPath, "utf8"));
      record.reasoningChars = 41;
      await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
      await repairManifest(artifactDirectory);
      await expect(verifyGate2PublishedEvidence(temporary, "reasoning-suppressed")).rejects.toThrow(
        /frozen evidence manifest is invalid: recordContract:/,
      );
    });
  });

  it("treats an absent reasoning-size claim as no claim, and a present one as binding", () => {
    // The freezer derives `everyRecordReasoningChars` from the records and omits it when
    // they disagree -- the ordinary case for a reasoning-enabled arm. Requiring the member
    // regardless compared every record against `undefined` and refused exactly the sets it
    // was omitted from. An absent member must bind nothing; a present one must bind all.
    // Shaped like the frozen set's records: `requestedThink` is ABSENT, which is what its
    // contract declares.
    const record = (reasoningChars: number | null) => ({
      reasoningChars,
      generatedAt: "2026-09-01T03:31:00.000Z",
    });
    const shared = { requestedThinkMemberPresent: false, writtenOn: "2026-09-01" };
    const claims = { recordContract: { ...shared, everyRecordReasoningChars: 0 } };
    const noClaim = { recordContract: { ...shared } };

    expect(recordContractBound(record(0), claims)).toBe(true);
    expect(recordContractBound(record(41), claims)).toBe(false);
    expect(recordContractBound(record(null), claims)).toBe(false);

    // Records that disagree on reasoning size are all accepted when nothing was claimed.
    for (const reasoningChars of [0, 41, 8192, null]) {
      expect(recordContractBound(record(reasoningChars), noClaim)).toBe(true);
    }

    // "No claim" is scoped to that one member: every other member still binds, under both
    // contracts. A record carrying `requestedThink` at all contradicts a contract that says
    // the member is absent, even when its value is the pinned one.
    for (const contract of [claims, noClaim]) {
      expect(recordContractBound({ ...record(0), requestedThink: false }, contract)).toBe(false);
      expect(
        recordContractBound({ ...record(0), generatedAt: "2026-08-31T23:59:59.999Z" }, contract),
      ).toBe(false);
      expect(recordContractBound({ ...record(0), generatedAt: 20260901 }, contract)).toBe(false);
      expect(recordContractBound(null, contract)).toBe(false);
    }

    // A config that declares no contract at all is unchanged: it binds nothing.
    expect(recordContractBound(record(41), {})).toBe(true);
  });

  it("keeps the reviewed record contract on the real published set", async () => {
    // The committed set's manifest declares the contract the reviewed figures rest on, and
    // it is the one this publisher pins. Asserted directly, because the tamper cases above
    // now exercise the freezer's derivation rather than this pin.
    const verified = await verifyGate2PublishedEvidence(repositoryRoot, "reasoning-suppressed");
    expect(verified.manifest.recordContract).toEqual({
      absentThinkingEncodedAs: 0,
      everyRecordReasoningChars: 0,
      evidenceRecordRevision: 5,
      requestedThinkMemberPresent: false,
      writtenOn: "2026-09-01",
    });
  });

  it("agrees with the freezer on the same bytes, verdict for verdict", async () => {
    // Review of PR #78 found the two verifiers accepting different inputs: the freezer
    // walked only *.json, so a stray text file passed it while this publisher refused it.
    // Both now read the same universe, and the point of this test is that neither verdict
    // is read alone -- each case asserts what BOTH say, so a future divergence fails here
    // rather than being discovered when a published set disagrees with its own manifest.
    const frozenDirectory = path.join(repositoryRoot, FROZEN_ARTIFACT_RELATIVE);

    // (a) the untouched committed set: both accept.
    expect(await verifyFrozenEvidence(frozenDirectory)).toEqual([]);
    expect(
      (await verifyGate2PublishedEvidence(repositoryRoot, "reasoning-suppressed")).files,
    ).toHaveLength(64);

    // (b) a non-JSON stray: both refuse, and name the same file.
    await withFrozenCopy(async (temporary, artifactDirectory) => {
      await writeFile(path.join(artifactDirectory, "stray.txt"), "not evidence\n");
      expect(await verifyFrozenEvidence(artifactDirectory)).toContain(
        "stray.txt: present but unlisted",
      );
      await expect(verifyGate2PublishedEvidence(temporary, "reasoning-suppressed")).rejects.toThrow(
        "stray.txt: present but unlisted",
      );
    });

    // (c) one listed file's bytes corrupted, manifest untouched: both refuse, and name it.
    await withFrozenCopy(async (temporary, artifactDirectory) => {
      const relative = "routed/repair-parser-false.json";
      const recordPath = path.join(artifactDirectory, relative);
      const record = JSON.parse(await readFile(recordPath, "utf8"));
      record.generatedAt = "2026-09-01T23:59:59.999Z";
      await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
      const problems = await verifyFrozenEvidence(artifactDirectory);
      expect(problems.some((problem: string) => problem.startsWith(`${relative}:`))).toBe(true);
      await expect(verifyGate2PublishedEvidence(temporary, "reasoning-suppressed")).rejects.toThrow(
        relative,
      );
    });

    // (d) a manifest with a duplicated member: both refuse. The manifest is the one file
    // in the set its own digests do not cover, so the strict parser -- not the digest --
    // is what refuses it, on both sides. #85 added this refusal to the freezer.
    await withFrozenCopy(async (temporary, artifactDirectory) => {
      const manifestPath = path.join(artifactDirectory, "manifest.json");
      const text = await readFile(manifestPath, "utf8");
      await writeFile(
        manifestPath,
        text.replace(/^\{/, '{\n  "schema": "icarus.gate2-frozen-evidence.v2",'),
      );
      await expect(verifyFrozenEvidence(artifactDirectory)).rejects.toThrow(
        "duplicate JSON object members",
      );
      await expect(verifyGate2PublishedEvidence(temporary, "reasoning-suppressed")).rejects.toThrow(
        "duplicate JSON object members",
      );
    });

    // (e) a listed record hard-linked to a path outside the set: both refuse. The bytes,
    // the digest and the entry type are all unchanged -- only the link count differs -- so
    // nothing but an nlink check can catch it, and the manifest would otherwise vouch for
    // bytes that another path can rewrite without touching the frozen directory.
    await withFrozenCopy(async (temporary, artifactDirectory) => {
      const relative = "routed/explain-lantern-flow.json";
      await link(
        path.join(artifactDirectory, relative),
        path.join(temporary, "outside-the-set.json"),
      );
      expect(await verifyFrozenEvidence(artifactDirectory)).toEqual([
        `Gate 2 evidence freeze: ${relative} is hard-linked`,
      ]);
      // The publisher carries the freezer's wording now: the closed-tree verdict runs
      // before any read of the set, so it is what an operator is told.
      await expect(verifyGate2PublishedEvidence(temporary, "reasoning-suppressed")).rejects.toThrow(
        `${relative} is hard-linked`,
      );
    });

    // (g) the artifact directory ROOT replaced by a symlink to an intact set beside it:
    // both refuse. Every per-file check passes here -- the bytes, the digests, the entry
    // types and the record contract are all those of a real, intact set -- so nothing
    // below the root can catch it; only resolving the root can. Sol's probe found this
    // publisher verifying 64 bound files through such a link.
    await withFrozenCopy(async (temporary, artifactDirectory) => {
      const sibling = path.join(temporary, "intact-set-beside-the-expected-path");
      await rename(artifactDirectory, sibling);
      await symlink(sibling, artifactDirectory);
      // Both name the same thing now, because both apply the same rule.
      expect(await verifyFrozenEvidence(artifactDirectory)).toEqual([
        expect.stringMatching(/resolves through a symlink/),
      ]);
      await expect(verifyGate2PublishedEvidence(temporary, "reasoning-suppressed")).rejects.toThrow(
        /resolves through a symlink/,
      );
    });

    // (h) the set is intact and every component below the checkout is real, but the
    // checkout itself is reached through a symlink. The freezer refuses a link at ANY
    // component; this publisher adopted that rule rather than resolving the repository
    // root first, because a published set the two verifiers disagree about is exactly what
    // this test exists to prevent -- and they disagreed on this input alone.
    await withFrozenCopy(async (temporary, artifactDirectory) => {
      const alias = path.join(temporary, "alias-to-the-checkout");
      await symlink(temporary, alias);
      expect(await verifyFrozenEvidence(path.join(alias, FROZEN_ARTIFACT_RELATIVE))).toEqual([
        expect.stringMatching(/resolves through a symlink/),
      ]);
      await expect(verifyGate2PublishedEvidence(alias, "reasoning-suppressed")).rejects.toThrow(
        /resolves through a symlink/,
      );
      // The same set by its real path is accepted, so the refusal is about the link and
      // not about the copy.
      expect(await verifyFrozenEvidence(artifactDirectory)).toEqual([]);
      expect(
        (await verifyGate2PublishedEvidence(temporary, "reasoning-suppressed")).files,
      ).toHaveLength(64);
    });

    // (f) a listed record replaced by a symlink to byte-identical content outside the set:
    // both refuse. The digests still agree, so only an entry-type check can catch it --
    // otherwise the manifest vouches for bytes the frozen directory does not own.
    await withFrozenCopy(async (temporary, artifactDirectory) => {
      const relative = "routed/explain-lantern-flow.json";
      const target = path.join(artifactDirectory, relative);
      const outside = path.join(temporary, "outside-the-set.json");
      await writeFile(outside, await readFile(target));
      await rm(target);
      await symlink(outside, target);
      expect(await verifyFrozenEvidence(artifactDirectory)).toEqual([
        `Gate 2 evidence freeze: ${relative} is not a regular file`,
      ]);
      // The publisher carries the freezer's wording now: the closed-tree verdict runs
      // before any read of the set, so it is what an operator is told.
      await expect(verifyGate2PublishedEvidence(temporary, "reasoning-suppressed")).rejects.toThrow(
        `${relative} is not a regular file`,
      );
    });
  });

  it("refuses a file the manifest lists that the benchmark contract does not", async () => {
    // The publisher's own pin, not a freezer divergence: the freezer proves a manifest is
    // internally true of its directory, and a 65th file listed with a correct digest is
    // internally true. Only the publisher knows the set must be exactly the contract's 64
    // paths -- the ones `validateEvidenceSet` read and screened for secret shapes. Without
    // this, a listed extra file rides along unscreened.
    await withFrozenCopy(async (temporary, artifactDirectory) => {
      const extra = "extra.json";
      const bytes = Buffer.from('{"unscreened":true}\n');
      await writeFile(path.join(artifactDirectory, extra), bytes);
      const manifestPath = path.join(artifactDirectory, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.files.push({
        path: extra,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      manifest.files.sort((left: { path: string }, right: { path: string }) =>
        left.path.localeCompare(right.path),
      );
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      // The freezer accepts it: listed, present, digest correct.
      expect(await verifyFrozenEvidence(artifactDirectory)).toEqual([]);
      await expect(verifyGate2PublishedEvidence(temporary, "reasoning-suppressed")).rejects.toThrow(
        "frozen evidence directory does not hold exactly the contract's files",
      );
    });
  });

  it("refuses an unresolvable root before a conflicting failure underneath it can speak", async () => {
    // Ordering, not just the eventual verdict. The set behind the link is intact except
    // that its manifest.json is a DIRECTORY, so the read that would report it fails with
    // EISDIR. Whichever check runs first decides what the operator is told, and "this root
    // is not the directory it names" is the fact that explains the other one.
    await withFrozenCopy(async (temporary, artifactDirectory) => {
      const sibling = path.join(temporary, "intact-set-beside-the-expected-path");
      await rename(artifactDirectory, sibling);
      await symlink(sibling, artifactDirectory);
      await rm(path.join(sibling, "manifest.json"));
      await mkdir(path.join(sibling, "manifest.json"));
      await expect(verifyGate2PublishedEvidence(temporary, "reasoning-suppressed")).rejects.toThrow(
        /resolves through a symlink/,
      );
      await expect(
        verifyGate2PublishedEvidence(temporary, "reasoning-suppressed"),
      ).rejects.not.toThrow(/EISDIR/);
      // The freezer answers the same way, from its own entry point.
      expect(await verifyFrozenEvidence(artifactDirectory)).toEqual([
        expect.stringMatching(/resolves through a symlink/),
      ]);
    });
  });

  it("refuses an unresolvable repository root before the fixtures it would read", async () => {
    // The benchmark manifest and the execution profile are read from the caller's root
    // before the artifact directory is even named. A fixture manifest that is a directory
    // threw a raw EISDIR from that read while the link that made it reachable went
    // unmentioned; the root is asserted before the first read that trusts it.
    await withFrozenCopy(async (temporary) => {
      const alias = path.join(temporary, "alias-to-the-checkout");
      await symlink(temporary, alias);
      const fixtureManifest = path.join(temporary, "fixtures/evals/gate2/manifest.v2.json");
      await rm(fixtureManifest);
      await mkdir(fixtureManifest);
      await expect(verifyGate2PublishedEvidence(alias, "reasoning-suppressed")).rejects.toThrow(
        /resolves through a symlink/,
      );
      await expect(verifyGate2PublishedEvidence(alias, "reasoning-suppressed")).rejects.not.toThrow(
        /EISDIR/,
      );
    });
  });

  it("calls a directory named like a record a verdict, in the freezer's words, on both APIs", async () => {
    // Sol's P2 fixture, and its answer changed underneath it. This used to reach the record
    // read as an EISDIR fault, and the test asserted the fault. The freezer now lstat-checks
    // each record before reading it, so a directory where a record belongs is a FACT about
    // the evidence — which is the better answer, and the one both APIs must give.
    await withFrozenCopy(async (temporary, artifactDirectory) => {
      await mkdir(path.join(artifactDirectory, "routed", "fault.json"));
      const wording = "Gate 2 evidence freeze: routed/fault.json is not a regular file";
      expect(await verifyFrozenEvidence(artifactDirectory)).toEqual([`recordContract: ${wording}`]);
      const error = await verifyGate2PublishedEvidence(temporary, "reasoning-suppressed").then(
        () => null,
        (thrown: Error) => thrown,
      );
      expect(error?.message).toContain(wording);
      // A fault is what this is not: the publisher must not surface an I/O error for a
      // question the freezer can answer about the directory.
      expect(error?.message).not.toMatch(/EISDIR/);
    });
  });

  it("refuses a symlinked manifest in the freezer's words, without reading the planted bytes", async () => {
    // The manifest moved outside the set behind a symlink, with a duplicate member planted
    // in the outside copy. The strict parser would report the planted bytes; the closed-tree
    // walk reports that the set contains a link. The second is the true statement about this
    // directory, and it has to be the one that speaks.
    await withFrozenCopy(async (temporary, artifactDirectory) => {
      const outside = path.join(temporary, "manifest-outside-the-set.json");
      const text = await readFile(path.join(artifactDirectory, "manifest.json"), "utf8");
      await writeFile(
        outside,
        text.replace(/^\{/, '{\n  "schema": "icarus.gate2-frozen-evidence.v2",'),
      );
      await rm(path.join(artifactDirectory, "manifest.json"));
      await symlink(outside, path.join(artifactDirectory, "manifest.json"));

      const wording = "Gate 2 evidence freeze: manifest.json is not a regular file";
      expect(await verifyFrozenEvidence(artifactDirectory)).toEqual([wording]);
      const error = await verifyGate2PublishedEvidence(temporary, "reasoning-suppressed").then(
        () => null,
        (thrown: Error) => thrown,
      );
      expect(error?.message).toContain(wording);
      expect(error?.message).not.toMatch(/duplicate JSON object members/);
    });
  });

  it("refuses a symlinked record directory without reading a byte through it", async () => {
    // Sol's P1. `routed/` becomes a link to a tree outside the set holding a byte-identical
    // copy plus one planted defect. Every listed record then resolves, through that link,
    // to a real non-linked regular file -- so a per-file check passes and the publisher
    // used to read and report the planted defect from outside the root it was verifying.
    // The closed-tree verdict runs first, so what an operator is told is that the tree is
    // not closed, and the planted bytes are never read.
    await withFrozenCopy(async (temporary, artifactDirectory) => {
      const outside = path.join(temporary, "records-outside-the-set");
      await cp(path.join(artifactDirectory, "routed"), outside, { recursive: true });
      await rm(path.join(artifactDirectory, "routed"), { recursive: true });
      await symlink(outside, path.join(artifactDirectory, "routed"));
      const planted = path.join(outside, "explain-lantern-flow.json");
      const text = await readFile(planted, "utf8");
      await writeFile(planted, text.replace(/^\{/, '{\n  "caseId": "planted-from-outside",'));

      const error = await verifyGate2PublishedEvidence(temporary, "reasoning-suppressed").then(
        () => null,
        (thrown: Error) => thrown,
      );
      expect(error?.message).toMatch(/routed is not a regular file/);
      // The defect planted outside the root is never what the operator hears about.
      expect(error?.message).not.toMatch(/duplicate JSON object members/);
      expect(error?.message).not.toMatch(/planted-from-outside/);
    });
  });

  it("refuses a link on the path to a record even where no frozen manifest is read", async () => {
    // The belt, isolated: the v2 set has no frozen manifest, so the closed-tree verdict
    // above never runs for it. AGENTS.md requires paths checked component-by-component
    // before reads, and `lstat` on the file alone is not that check.
    await withPublishedCopy(
      "gate2-local-vulcan-target-discovery-r7-20260828",
      async (temporary, artifactDirectory) => {
        const outside = path.join(temporary, "records-outside-the-set");
        await cp(path.join(artifactDirectory, "routed"), outside, { recursive: true });
        await rm(path.join(artifactDirectory, "routed"), { recursive: true });
        await symlink(outside, path.join(artifactDirectory, "routed"));
        await expect(verifyGate2PublishedEvidence(temporary, "v2")).rejects.toThrow(
          /is reached through a link at routed/,
        );
      },
    );
  });

  it("refuses a symlinked execution profile before parsing a byte of it", async () => {
    // Sol's P1. The fixture reads were never component-checked, so a byte-identical target
    // behind a symlinked profile path was read and accepted -- the publisher verifying a
    // set against a profile it did not own. The target is byte-identical on purpose: no
    // digest, no parser, and no contract check can tell the difference. Only the walk can.
    await withFrozenCopy(async (temporary) => {
      const relative = "fixtures/evals/gate2/live-profile.v2.json";
      const outside = path.join(temporary, "profile-outside-the-repository.json");
      await writeFile(outside, await readFile(path.join(temporary, relative)));
      await rm(path.join(temporary, relative));
      await symlink(outside, path.join(temporary, relative));
      await expect(verifyGate2PublishedEvidence(temporary, "reasoning-suppressed")).rejects.toThrow(
        /live-profile\.v2\.json is reached through a link at/,
      );
    });
  });

  it("refuses a symlinked benchmark manifest without naming what was planted in it", async () => {
    // The same omission, on the other fixture read, and with a defect planted outside so
    // the failure mode is visible: the strict parser would report the duplicate, which is
    // an answer about a file outside the repository. The component check speaks first and
    // the planted bytes are never parsed.
    await withFrozenCopy(async (temporary) => {
      const relative = "fixtures/evals/gate2/manifest.v2.json";
      const outside = path.join(temporary, "manifest-outside-the-repository.json");
      const text = await readFile(path.join(temporary, relative), "utf8");
      await writeFile(outside, text.replace(/^\{/, '{\n  "schemaVersion": 2,'));
      await rm(path.join(temporary, relative));
      await symlink(outside, path.join(temporary, relative));
      const error = await verifyGate2PublishedEvidence(temporary, "reasoning-suppressed").then(
        () => null,
        (thrown: Error) => thrown,
      );
      expect(error?.message).toMatch(/manifest\.v2\.json is reached through a link at/);
      expect(error?.message).not.toMatch(/duplicate JSON object members/);
    });
  });

  it("refuses a link inside a fixture repository the contract loader will read", async () => {
    // The loader also reads every task and walks all seven fixture repositories. A helper
    // in this file cannot intercept those reads, so every path the loader will touch is
    // walked before it is called -- including the trees, entry by entry.
    await withFrozenCopy(async (temporary) => {
      const inside = path.join(temporary, "fixtures/evals/repos/buggy/src/planted-link.py");
      await symlink(path.join(temporary, "fixtures/evals/repos/buggy/src/cart.py"), inside);
      await expect(verifyGate2PublishedEvidence(temporary, "reasoning-suppressed")).rejects.toThrow(
        /fixture .* holds a link at/,
      );
    });
  });

  it("requires conservative declared-budget accounting for a retained timeout", () => {
    const profile = {
      budgets: { maxInputTokens: 50_000, maxOutputTokens: 8192, maxRuntimeSeconds: 300 },
    };
    const timeout = {
      finishReason: "timeout",
      providerFailure: "request_timeout",
      usageBasis: "declared_budget_upper_bound",
      rawCandidate: "",
      candidate: null,
      evaluatorEvidence: {
        providerFailure: "request_timeout",
        usageBasis: "declared_budget_upper_bound",
      },
      observation: { usage: { inputTokens: 50_000, outputTokens: 8192, latencyMs: 300_000 } },
    };
    expect(isGate2ProviderOutcomeBound(timeout, profile, 4)).toBe(true);
    expect(isGate2ProviderOutcomeBound({ ...timeout, providerFailure: null }, profile, 4)).toBe(
      false,
    );
  });

  it("refuses routing-policy drift in preflight evidence", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "icarus-gate2-published-"));
    try {
      await cp(path.join(repositoryRoot, "fixtures"), path.join(temporary, "fixtures"), {
        recursive: true,
      });
      const artifactRelative = "docs/evals/artifacts/gate2-local-vulcan-code-routing-20260828";
      await mkdir(path.join(temporary, "docs/evals/artifacts"), { recursive: true });
      await cp(
        path.join(repositoryRoot, artifactRelative),
        path.join(temporary, artifactRelative),
        {
          recursive: true,
        },
      );
      const preflightPath = path.join(temporary, artifactRelative, "preflight.json");
      const preflight = JSON.parse(await readFile(preflightPath, "utf8"));
      preflight.routingPolicySha256 = "0".repeat(64);
      await writeFile(preflightPath, `${JSON.stringify(preflight, null, 2)}\n`);
      await expect(verifyGate2PublishedEvidence(temporary, "v1")).rejects.toThrow(
        "published preflight is not bound",
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("refuses duplicate JSON members before native parsing can collapse them", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "icarus-gate2-published-"));
    try {
      await cp(path.join(repositoryRoot, "fixtures"), path.join(temporary, "fixtures"), {
        recursive: true,
      });
      const artifactRelative = "docs/evals/artifacts/gate2-local-vulcan-code-routing-20260828";
      await mkdir(path.join(temporary, "docs/evals/artifacts"), { recursive: true });
      await cp(
        path.join(repositoryRoot, artifactRelative),
        path.join(temporary, artifactRelative),
        { recursive: true },
      );
      const preflightPath = path.join(temporary, artifactRelative, "preflight.json");
      const preflight = await readFile(preflightPath, "utf8");
      await writeFile(
        preflightPath,
        preflight.replace('"schemaVersion": 1,', '"schemaVersion": 1,\n  "schemaVersion": 1,'),
      );
      await expect(verifyGate2PublishedEvidence(temporary, "v1")).rejects.toThrow(
        "duplicate JSON object members",
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
