import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJsonLine } from "../../packages/core/src/canonical-json.js";
import type { LiveEvidenceExecutionJournalV1 } from "../../packages/core/src/live-evidence-executor.js";
import { FileLiveEvidenceJournalStore } from "../../packages/core/src/live-evidence-journal.js";

let scratch: string | undefined;

afterEach(() => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function journal(): LiveEvidenceExecutionJournalV1 {
  return {
    schemaVersion: 1,
    resumeId: "11111111-1111-4111-8111-111111111111",
    profileId: "gate1-live",
    profileDigestSha256: "a".repeat(64),
    manifestSha256: "b".repeat(64),
    caseOrder: ["case-one"],
    completedCases: [],
    terminalReceipts: [],
    terminalReceipt: null,
    createdAt: "2026-08-23T12:00:00.000Z",
    updatedAt: "2026-08-23T12:00:00.000Z",
  };
}

describe("live-evidence filesystem journal", () => {
  it("round-trips canonical owner-only state and permits append-only progress", () => {
    scratch = mkdtempSync(path.join(os.tmpdir(), "icarus-live-journal-"));
    const store = new FileLiveEvidenceJournalStore(scratch);
    const initial = journal();
    store.create(initial);
    expect(store.load(initial.resumeId)).toEqual(initial);

    const completed = {
      ...initial,
      completedCases: [
        {
          caseId: "case-one",
          effects: [
            "github.objects.upload",
            "github.ref.create.absent_only",
            "github.pull_request.create.draft",
            "github.landing.receipt",
          ] as const,
          spendUsd: 0,
          elapsedSeconds: 5,
          receipt: { pullRequestNumber: 1 },
        },
      ],
      updatedAt: "2026-08-23T12:01:00.000Z",
    };
    store.save(completed);
    expect(store.load(initial.resumeId)?.completedCases).toHaveLength(1);
    expect(() => store.save({ ...completed, completedCases: [] })).toThrowError(/append-only/);
  });

  it("recovers an fsynced initial journal interrupted before publication", () => {
    scratch = mkdtempSync(path.join(os.tmpdir(), "icarus-live-journal-"));
    const store = new FileLiveEvidenceJournalStore(scratch);
    const initial = journal();
    const root = path.join(scratch, "live-evidence");
    const temporary = path.join(root, `.${initial.resumeId}.create`);
    const target = path.join(root, `${initial.resumeId}.json`);
    writeFileSync(temporary, canonicalJsonLine(initial), { mode: 0o600 });

    expect(store.load(initial.resumeId)).toEqual(initial);
    expect(() => linkSync(temporary, target)).toThrowError();
  });

  it("recovers initial journal publication interrupted after the hard link", () => {
    scratch = mkdtempSync(path.join(os.tmpdir(), "icarus-live-journal-"));
    const store = new FileLiveEvidenceJournalStore(scratch);
    const initial = journal();
    const root = path.join(scratch, "live-evidence");
    const temporary = path.join(root, `.${initial.resumeId}.create`);
    const target = path.join(root, `${initial.resumeId}.json`);
    writeFileSync(temporary, canonicalJsonLine(initial), { mode: 0o600 });
    linkSync(temporary, target);

    expect(store.load(initial.resumeId)).toEqual(initial);
    expect(() => linkSync(temporary, target)).toThrowError();
  });

  it("refuses a symlink journal rather than following it", () => {
    scratch = mkdtempSync(path.join(os.tmpdir(), "icarus-live-journal-"));
    const store = new FileLiveEvidenceJournalStore(scratch);
    const target = path.join(scratch, "outside.json");
    writeFileSync(target, "{}\n", { mode: 0o600 });
    symlinkSync(
      target,
      path.join(scratch, "live-evidence", "22222222-2222-4222-8222-222222222222.json"),
    );
    expect(() => store.load("22222222-2222-4222-8222-222222222222")).toThrow();
  });
});
