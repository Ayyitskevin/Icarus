import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyGate2PublishedEvidence } from "../../scripts/gate2-live-evidence-publish.mjs";

const repositoryRoot = decodeURIComponent(new URL("../../", import.meta.url).pathname);

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

  it("recomputes target-discovery evidence and retains a timeout as a bounded failure", async () => {
    const verified = await verifyGate2PublishedEvidence(repositoryRoot, "v2");
    expect(verified.files).toHaveLength(64);
    expect(verified.manifest).toMatchObject({
      executionProfileDigestSha256:
        "03399661d25002304f160f2e4959fe1a0e2be826bb752671e1234c8e34496169",
      instructionPolicySha256: "d4993a35669f17c3dc26e873b8afb8a5699bb792fbbab6f9d52838275986d39b",
      routingPolicySha256: "01c96e8eedc4376cae8aab5fb1c354e9fe84f8fa18ae1a77ed93875724ccd54a",
    });
    expect(verified.baseline.aggregates).toMatchObject({
      taskCount: 30,
      measuredTaskCount: 30,
      successCount: 2,
      firstPassPlanAcceptance: 0.233333333333,
      thresholdsPassed: false,
    });
    expect(verified.routed.aggregates).toMatchObject({
      taskCount: 30,
      measuredTaskCount: 30,
      successCount: 17,
      firstPassPlanAcceptance: 0.7,
      incorrectEdits: 0,
      thresholdsPassed: false,
    });
    expect(verified.comparison).toMatchObject({
      baselineSuccessCount: 2,
      routedSuccessCount: 17,
      successCountRatio: 8.5,
      costReduction: 0.749437262357,
      passed: false,
    });
    const timeout = JSON.parse(
      await readFile(path.join(verified.destination, "routed/repair-parser-false.json"), "utf8"),
    );
    expect(timeout).toMatchObject({
      finishReason: "timeout",
      providerFailure: "request_timeout",
      usageBasis: "declared_budget_upper_bound",
      rawCandidate: "",
      candidate: null,
      evaluatorEvidence: {
        providerFailure: "request_timeout",
        usageBasis: "declared_budget_upper_bound",
        providerOutputComplete: false,
        scenarioStatus: "failed",
      },
      observation: {
        scenarioStatus: "failed",
        usage: { inputTokens: 50_000, outputTokens: 8192, latencyMs: 300_000 },
      },
    });
  });

  it("refuses a timeout record whose declared provider failure is erased", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "icarus-gate2-published-"));
    try {
      await cp(path.join(repositoryRoot, "fixtures"), path.join(temporary, "fixtures"), {
        recursive: true,
      });
      const artifactRelative =
        "docs/evals/artifacts/gate2-local-vulcan-target-discovery-r7-20260828";
      await mkdir(path.join(temporary, "docs/evals/artifacts"), { recursive: true });
      await cp(
        path.join(repositoryRoot, artifactRelative),
        path.join(temporary, artifactRelative),
        { recursive: true },
      );
      const timeoutPath = path.join(temporary, artifactRelative, "routed/repair-parser-false.json");
      const timeout = JSON.parse(await readFile(timeoutPath, "utf8"));
      timeout.providerFailure = null;
      await writeFile(timeoutPath, `${JSON.stringify(timeout, null, 2)}\n`);
      await expect(verifyGate2PublishedEvidence(temporary, "v2")).rejects.toThrow(
        "published case record is not bound: routed/repair-parser-false.json",
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
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
