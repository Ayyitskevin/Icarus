import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeGate2FrozenEvidenceFigures,
  renderMarkdown,
} from "../../scripts/gate2-frozen-evidence-figures.mjs";

const repositoryRoot = decodeURIComponent(new URL("../../", import.meta.url).pathname);
const SET = "docs/evals/artifacts/gate2-reasoning-suppressed-20260901";

async function withCopy(
  body: (temporary: string, setDirectory: string) => Promise<void>,
): Promise<void> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "icarus-gate2-figures-"));
  try {
    await cp(path.join(repositoryRoot, "fixtures"), path.join(temporary, "fixtures"), {
      recursive: true,
    });
    await mkdir(path.join(temporary, "docs/evals/artifacts"), { recursive: true });
    await cp(path.join(repositoryRoot, SET), path.join(temporary, SET), { recursive: true });
    await body(temporary, path.join(temporary, SET));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

describe("Gate 2 frozen evidence figures", () => {
  it("recomputes the 2026-09-01 evaluation's headline figures from the committed records", async () => {
    const figures = await computeGate2FrozenEvidenceFigures(SET, { repositoryRoot });
    // ADR 0070's outcome table and the 2026-09-01 diagnosis. These are recomputed from the
    // 60 records, not read back from the result files -- and the script separately checks
    // that the result files agree, which is the assertion below.
    expect(figures.arms.baseline.successes).toBe(2);
    expect(figures.arms.baseline.taskCount).toBe(30);
    expect(figures.arms.baseline.firstPlanAcceptance).toBe(0.066666666667);
    expect(figures.arms.routed.successes).toBe(12);
    expect(figures.arms.routed.taskCount).toBe(30);
    expect(figures.arms.routed.firstPlanAcceptance).toBe(0.6);
    expect(figures.agreesWithCommittedResults).toBe(true);
    expect(figures.disagreements).toEqual([]);
  });

  it("reproduces the diagnosis's routed failure buckets", async () => {
    // "Six of the ten [zero-class cases] are plan rejections; four are unparseable output."
    const { routed } = (await computeGate2FrozenEvidenceFigures(SET, { repositoryRoot })).arms;
    expect(routed.buckets).toEqual({
      passed: 12,
      planRejectedBeforeAnyCheck: 8,
      unparseable: 4,
      executedAndFailed: 6,
    });
    expect(
      routed.buckets.passed +
        routed.buckets.planRejectedBeforeAnyCheck +
        routed.buckets.unparseable +
        routed.buckets.executedAndFailed,
    ).toBe(30);
    expect(routed.unparseableShapes.derivedFromRawCandidate).toEqual({
      markdown_fenced: 1,
      leading_prose: 1,
      empty: 1,
      truncated: 1,
    });
  });

  it("reproduces the baseline arm's fenced-output finding", async () => {
    // "27 of those 28 are markdown-fenced JSON."
    const { baseline } = (await computeGate2FrozenEvidenceFigures(SET, { repositoryRoot })).arms;
    expect(baseline.failureCount).toBe(28);
    expect(baseline.markdownFencedFailures).toBe(27);
    expect(baseline.buckets).toEqual({
      passed: 2,
      planRejectedBeforeAnyCheck: 1,
      unparseable: 27,
      executedAndFailed: 0,
    });
  });

  it("reports the per-class counts the manifest pins", async () => {
    const figures = await computeGate2FrozenEvidenceFigures(SET, { repositoryRoot });
    expect(figures.arms.routed.classes).toEqual({
      repair: { successes: 7, count: 10 },
      refactor: { successes: 0, count: 5 },
      explanation: { successes: 3, count: 5 },
      security_review: { successes: 2, count: 5 },
      scaffold: { successes: 0, count: 5 },
    });
    expect(figures.arms.baseline.classes.repair).toEqual({ successes: 1, count: 10 });
    // The two classes the diagnosis is about score zero in both arms.
    for (const arm of [figures.arms.baseline, figures.arms.routed]) {
      expect(arm.classes.refactor).toEqual({ successes: 0, count: 5 });
      expect(arm.classes.scaffold).toEqual({ successes: 0, count: 5 });
    }
  });

  it("names no strict-JSON shape this set never recorded", async () => {
    // The shape vocabulary landed after this set was frozen, so every unparseable record's
    // error names none. Absence must read as null; "other" would be a shape nobody wrote.
    const figures = await computeGate2FrozenEvidenceFigures(SET, { repositoryRoot });
    expect(figures.arms.baseline.unparseableShapes.recordedInError).toEqual({ null: 27 });
    expect(figures.arms.routed.unparseableShapes.recordedInError).toEqual({ null: 4 });
  });

  it("refuses to compute a figure from a set whose manifest is not true of its bytes", async () => {
    await withCopy(async (temporary, setDirectory) => {
      const recordPath = path.join(setDirectory, "routed/repair-parser-false.json");
      const record = JSON.parse(await readFile(recordPath, "utf8"));
      record.generatedAt = "2026-09-01T23:59:59.999Z";
      await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
      await expect(
        computeGate2FrozenEvidenceFigures(SET, { repositoryRoot: temporary }),
      ).rejects.toThrow("did not verify");
    });
  });

  it("refuses a set measured against a different benchmark manifest", async () => {
    await withCopy(async (temporary) => {
      await expect(
        computeGate2FrozenEvidenceFigures(SET, {
          repositoryRoot: temporary,
          manifestPath: "fixtures/evals/gate2/manifest.v1.json",
        }),
      ).rejects.toThrow("different benchmark manifest");
    });
  });

  it("renders the same figures it returns", async () => {
    const figures = await computeGate2FrozenEvidenceFigures(SET, { repositoryRoot });
    const markdown = renderMarkdown(figures);
    expect(markdown).toContain("| successes / tasks | 2 / 30 | 12 / 30 |");
    expect(markdown).toContain("| plan rejected before any check | 1 | 8 |");
    expect(markdown).toContain("| markdown-fenced failures | 27 | 1 |");
    expect(markdown).toContain("null x27");
    expect(markdown).toContain(
      "Every recomputed figure agrees with the committed result and comparison files.",
    );
  });
});
