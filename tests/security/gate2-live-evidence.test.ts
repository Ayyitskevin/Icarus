import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyGate2PublishedEvidence } from "../../scripts/gate2-live-evidence-publish.mjs";

const repositoryRoot = decodeURIComponent(new URL("../../", import.meta.url).pathname);

describe("Gate 2 published live evidence", () => {
  it("recomputes both 30-case results, their comparison, and every retained evidence digest", async () => {
    const verified = await verifyGate2PublishedEvidence(repositoryRoot);
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
      await expect(verifyGate2PublishedEvidence(temporary)).rejects.toThrow(
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
      await expect(verifyGate2PublishedEvidence(temporary)).rejects.toThrow(
        "duplicate JSON object members",
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
