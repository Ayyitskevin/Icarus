import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isGate2ProviderOutcomeBound,
  recordContractBound,
  verifyGate2PublishedEvidence,
  verifyGate2PublishedEvidenceSet,
} from "../../scripts/gate2-live-evidence-publish.mjs";

const repositoryRoot = decodeURIComponent(new URL("../../", import.meta.url).pathname);
const FROZEN_ARTIFACT_RELATIVE = "docs/evals/artifacts/gate2-reasoning-suppressed-20260901";

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
      // from, and not the secret scan that only walks the listed paths.
      await writeFile(path.join(artifactDirectory, "extra.json"), "{}\n");
      await expect(verifyGate2PublishedEvidence(temporary, "reasoning-suppressed")).rejects.toThrow(
        "published evidence directory holds unlisted files: extra.json",
      );
    });
  });

  it("screens the frozen set for secret shapes rather than trusting its age", async () => {
    await withFrozenCopy(async (temporary, artifactDirectory) => {
      const recordPath = path.join(artifactDirectory, "routed/explain-lantern-flow.json");
      const record = JSON.parse(await readFile(recordPath, "utf8"));
      record.password = "correct-horse-battery-staple";
      await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
      await expect(verifyGate2PublishedEvidence(temporary, "reasoning-suppressed")).rejects.toThrow(
        "routed/explain-lantern-flow.json contains an unknown secret-shaped span",
      );
    });
  });

  it("refuses a frozen record that contradicts the contract its manifest declares", async () => {
    await withFrozenCopy(async (temporary, artifactDirectory) => {
      // The digest is repaired so only the declared record contract can catch this: a
      // nonzero reading in a set whose manifest says every reading is an encoded absence.
      const relative = "routed/explain-lantern-flow.json";
      const recordPath = path.join(artifactDirectory, relative);
      const record = JSON.parse(await readFile(recordPath, "utf8"));
      record.reasoningChars = 5;
      const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
      await writeFile(recordPath, bytes);
      const manifestPath = path.join(artifactDirectory, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const entry = manifest.files.find((file: { path: string }) => file.path === relative) as {
        bytes: number;
        sha256: string;
      };
      entry.bytes = bytes.length;
      entry.sha256 = createHash("sha256").update(bytes).digest("hex");
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      await expect(verifyGate2PublishedEvidence(temporary, "reasoning-suppressed")).rejects.toThrow(
        `published case record is not bound: ${relative}`,
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

  it("still binds every frozen record against the contract its manifest declares", async () => {
    // The published 2026-09-01 config DOES carry the member, so the relaxation above must
    // not have loosened the real set: all 60 records are checked against `0`.
    const verified = await verifyGate2PublishedEvidence(repositoryRoot, "reasoning-suppressed");
    expect(verified.manifest.recordContract).toMatchObject({ everyRecordReasoningChars: 0 });
    await withFrozenCopy(async (temporary, artifactDirectory) => {
      const relative = "baseline/repair-cart-off-by-one.json";
      const recordPath = path.join(artifactDirectory, relative);
      const record = JSON.parse(await readFile(recordPath, "utf8"));
      record.reasoningChars = 41;
      const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
      await writeFile(recordPath, bytes);
      const manifestPath = path.join(artifactDirectory, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const entry = manifest.files.find((file: { path: string }) => file.path === relative) as {
        bytes: number;
        sha256: string;
      };
      entry.bytes = bytes.length;
      entry.sha256 = createHash("sha256").update(bytes).digest("hex");
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      await expect(verifyGate2PublishedEvidence(temporary, "reasoning-suppressed")).rejects.toThrow(
        `published case record is not bound: ${relative}`,
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
