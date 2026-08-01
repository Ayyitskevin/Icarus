import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { CHANGE_HANDOFF_SCHEMA } from "../../packages/core/src/change-handoff.js";
import {
  CHANGE_HANDOFF_FILENAME,
  CHANGE_HANDOFF_RESULT_FILENAME,
} from "../../packages/core/src/change-handoff-files.js";
import { sha256 } from "../../packages/core/src/digest.js";
import { IcarusStore } from "../../packages/core/src/store.js";
import {
  type ChangeRoomFixture,
  createChangeRoomFixture,
  driveToCompleted,
  prepareChangeRoomRun,
} from "../support/change-room-fixtures.js";
import { jsonOutput, type ProcessResult, runCli } from "../support/integration-cli.js";

interface PreviewDigests {
  readonly payloadSha256: string;
  readonly previewSha256: string;
}

interface ExportResult {
  readonly exportStatus: "exported";
  readonly previewSha256: string;
  readonly outputSchema: string;
  readonly payloadSha256: string;
}

interface VerificationResult extends ExportResult {
  readonly schema: string;
  readonly consistency: "internally_consistent";
  readonly authenticity: "not_established";
  readonly authorization: "not_established";
  readonly semanticTruth: "not_established";
  readonly disclosurePermission: "not_established";
  readonly executionAuthority: "none";
}

interface InspectionResult extends VerificationResult {
  readonly handoff: {
    readonly schema: string;
    readonly identifiers: {
      readonly runId: string;
      readonly correlationId: string;
      readonly externalTaskRef: string | null;
    };
    readonly run: { readonly state: string; readonly phase: string };
    readonly summary: readonly string[];
  };
}

const cleanupRoots = new Set<string>();
const openStores = new Set<IcarusStore>();

function trackedFixture(): ChangeRoomFixture {
  const fixture = createChangeRoomFixture();
  cleanupRoots.add(fixture.root);
  openStores.add(fixture.store);
  return fixture;
}

function closeStore(store: IcarusStore): void {
  if (openStores.delete(store)) store.close();
}

function closeFixture(fixture: ChangeRoomFixture): void {
  closeStore(fixture.store);
}

function completedFixture(): ChangeRoomFixture {
  const fixture = trackedFixture();
  driveToCompleted(fixture.store);
  closeFixture(fixture);
  return fixture;
}

function stateRoot(fixture: ChangeRoomFixture): string {
  return path.dirname(fixture.databasePath);
}

function stateDirectoryFingerprint(root: string): unknown {
  const directory = lstatSync(root, { bigint: true });
  return {
    directory: {
      mode: String(directory.mode),
      size: String(directory.size),
      modifiedAt: String(directory.mtimeNs),
      changedAt: String(directory.ctimeNs),
    },
    entries: readdirSync(root)
      .sort()
      .map((name) => {
        const filePath = path.join(root, name);
        const stat = lstatSync(filePath, { bigint: true });
        return {
          name,
          mode: String(stat.mode),
          links: String(stat.nlink),
          size: String(stat.size),
          modifiedAt: String(stat.mtimeNs),
          changedAt: String(stat.ctimeNs),
          sha256: stat.isFile()
            ? createHash("sha256").update(readFileSync(filePath)).digest("hex")
            : null,
        };
      }),
  };
}

function parsePreviewDigests(result: ProcessResult): PreviewDigests {
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stderr) as PreviewDigests;
}

function errorCode(result: ProcessResult): string {
  expect(result.exitCode).not.toBe(0);
  const decoded = JSON.parse(result.stderr) as { readonly error: { readonly code: string } };
  return decoded.error.code;
}

afterEach(() => {
  for (const store of openStores) {
    try {
      store.close();
    } catch {
      // Cleanup must not hide the primary test failure.
    }
  }
  openStores.clear();
  for (const root of cleanupRoots) rmSync(root, { recursive: true, force: true });
  cleanupRoots.clear();
});

describe("Change Handoff CLI", () => {
  it("previews, exports, verifies, and inspects the same canonical evidence capsule", async () => {
    const fixture = completedFixture();
    const correlationId = "athena-task-42";
    const externalTaskRef = "task.room:alpha";
    const sourceBefore = stateDirectoryFingerprint(stateRoot(fixture));
    const preview = await runCli(stateRoot(fixture), [
      "run",
      "handoff-preview",
      fixture.runId,
      "--correlation-id",
      correlationId,
      "--external-task-ref",
      externalTaskRef,
    ]);
    expect(stateDirectoryFingerprint(stateRoot(fixture))).toEqual(sourceBefore);
    const previewDigests = parsePreviewDigests(preview);
    const previewPayload = JSON.parse(preview.stdout) as {
      readonly schema: string;
      readonly identifiers: {
        readonly runId: string;
        readonly correlationId: string;
        readonly externalTaskRef: string | null;
      };
      readonly omissions: readonly string[];
    };

    expect(preview.stdout.endsWith("\n")).toBe(true);
    expect(preview.stdout.slice(0, -1)).not.toContain("\n");
    expect(previewDigests.payloadSha256).toBe(sha256(Buffer.from(preview.stdout, "utf8")));
    expect(previewDigests.previewSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(previewDigests.previewSha256).not.toBe(previewDigests.payloadSha256);
    expect(previewPayload).toMatchObject({
      schema: CHANGE_HANDOFF_SCHEMA,
      identifiers: { runId: fixture.runId, correlationId, externalTaskRef },
    });
    expect(previewPayload.omissions).toHaveLength(8);
    for (const privateCanary of [
      "Update the greeting",
      "src/greeting.txt",
      "Replace the greeting.",
      "diff --git",
      "unit-operator",
      "/tmp/unit-cache.git",
      "/tmp/unit-worktree",
      "http://127.0.0.1:11434",
    ]) {
      expect(preview.stdout).not.toContain(privateCanary);
      expect(preview.stderr).not.toContain(privateCanary);
    }

    const outputDirectory = path.join(fixture.root, "handoff-export");
    const exported = await runCli(stateRoot(fixture), [
      "run",
      "handoff-export",
      fixture.runId,
      "--correlation-id",
      correlationId,
      "--external-task-ref",
      externalTaskRef,
      "--expected-preview-sha256",
      previewDigests.previewSha256,
      "--output-dir",
      outputDirectory,
    ]);
    const exportResult = jsonOutput<ExportResult>(exported);
    const payloadPath = path.join(outputDirectory, CHANGE_HANDOFF_FILENAME);
    const resultPath = path.join(outputDirectory, CHANGE_HANDOFF_RESULT_FILENAME);

    expect(exportResult).toEqual({
      exportStatus: "exported",
      previewSha256: previewDigests.previewSha256,
      outputSchema: CHANGE_HANDOFF_SCHEMA,
      payloadSha256: previewDigests.payloadSha256,
    });
    expect(readFileSync(payloadPath, "utf8")).toBe(preview.stdout);
    expect(JSON.parse(readFileSync(resultPath, "utf8"))).toEqual(exportResult);
    expect(lstatSync(outputDirectory).mode & 0o777).toBe(0o700);
    expect(lstatSync(payloadPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(resultPath).mode & 0o777).toBe(0o600);

    const sqliteConstructionDenyPreload = path.join(fixture.root, "deny-sqlite-construction.cjs");
    writeFileSync(
      sqliteConstructionDenyPreload,
      `const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const loaded = originalLoad.call(this, request, parent, isMain);
  if (request !== "better-sqlite3") return loaded;
  return new Proxy(loaded, {
    construct() {
      throw new Error("file-only handoff command opened SQLite");
    },
  });
};
`,
      { mode: 0o600 },
    );

    const nonexistentHome = path.join(fixture.root, "state-that-must-not-exist");
    const hostileRuntimeEnvironment = {
      NODE_OPTIONS:
        `${process.env.NODE_OPTIONS ?? ""} --require=${sqliteConstructionDenyPreload}`.trim(),
      ICARUS_APPROVE_SCHEMA_MIGRATION: "invalid-token-that-file-only-must-ignore",
    };
    expect(existsSync(nonexistentHome)).toBe(false);
    const verified = await runCli(
      nonexistentHome,
      ["handoff", "verify", "--input", payloadPath],
      hostileRuntimeEnvironment,
    );
    const verification = jsonOutput<VerificationResult>(verified);
    expect(verification).toEqual({
      schema: CHANGE_HANDOFF_SCHEMA,
      payloadSha256: previewDigests.payloadSha256,
      previewSha256: previewDigests.previewSha256,
      exportStatus: "exported",
      consistency: "internally_consistent",
      authenticity: "not_established",
      authorization: "not_established",
      semanticTruth: "not_established",
      disclosurePermission: "not_established",
      executionAuthority: "none",
    });
    expect(existsSync(nonexistentHome)).toBe(false);

    const inspected = await runCli(
      nonexistentHome,
      ["handoff", "inspect", "--input", payloadPath],
      hostileRuntimeEnvironment,
    );
    const inspection = jsonOutput<InspectionResult>(inspected);
    expect(inspection).toMatchObject({
      ...verification,
      handoff: {
        schema: CHANGE_HANDOFF_SCHEMA,
        identifiers: { runId: fixture.runId, correlationId, externalTaskRef },
        run: { state: "completed", phase: "completed" },
        summary: [
          "This Icarus run is completed.",
          "Verification passed.",
          "Review was approved.",
          "Evidence remains local in Icarus.",
          "No commit, push, merge, or deployment is represented by this artifact.",
        ],
      },
    });
    expect(existsSync(nonexistentHome)).toBe(false);
    for (const privateCanary of [
      "Update the greeting",
      "src/greeting.txt",
      "diff --git",
      "unit-operator",
      "/tmp/unit-worktree",
    ]) {
      expect(inspected.stdout).not.toContain(privateCanary);
    }
  });

  it("refuses a stale preview before creating an output directory", async () => {
    const fixture = trackedFixture();
    closeFixture(fixture);
    const correlationId = "stale-preview-canary";
    const preview = await runCli(stateRoot(fixture), [
      "run",
      "handoff-preview",
      fixture.runId,
      "--correlation-id",
      correlationId,
    ]);
    const previewDigests = parsePreviewDigests(preview);

    const mutationStore = new IcarusStore(fixture.databasePath);
    openStores.add(mutationStore);
    prepareChangeRoomRun(mutationStore);
    closeStore(mutationStore);
    const outputDirectory = path.join(fixture.root, "stale-output");
    const exported = await runCli(stateRoot(fixture), [
      "run",
      "handoff-export",
      fixture.runId,
      "--correlation-id",
      correlationId,
      "--expected-preview-sha256",
      previewDigests.previewSha256,
      "--output-dir",
      outputDirectory,
    ]);

    expect(errorCode(exported)).toBe("STALE_HANDOFF_PREVIEW");
    expect(exported.stdout).toBe("");
    expect(existsSync(outputDirectory)).toBe(false);
  });

  it("fails unsafe identifiers without writing output or leaking their values", async () => {
    const fixture = trackedFixture();
    closeFixture(fixture);
    const unsafeCorrelation = "https://receiver.invalid/private";
    const correlationFailure = await runCli(stateRoot(fixture), [
      "run",
      "handoff-preview",
      fixture.runId,
      "--correlation-id",
      unsafeCorrelation,
    ]);
    expect(errorCode(correlationFailure)).toBe("INVALID_CORRELATION_ID");
    expect(correlationFailure.stdout).toBe("");
    expect(correlationFailure.stderr).not.toContain(unsafeCorrelation);

    const unsafeReference = "authorization:bearer";
    const referenceFailure = await runCli(stateRoot(fixture), [
      "run",
      "handoff-preview",
      fixture.runId,
      "--correlation-id",
      "safe-correlation",
      "--external-task-ref",
      unsafeReference,
    ]);
    expect(errorCode(referenceFailure)).toBe("INVALID_EXTERNAL_TASK_REF");
    expect(referenceFailure.stdout).toBe("");
    expect(referenceFailure.stderr).not.toContain(unsafeReference);
  });

  it("requires the fixed payload filename for file-only verification", async () => {
    const fixture = completedFixture();
    const preview = await runCli(stateRoot(fixture), [
      "run",
      "handoff-preview",
      fixture.runId,
      "--correlation-id",
      "fixed-name-canary",
    ]);
    const digests = parsePreviewDigests(preview);
    const outputDirectory = path.join(fixture.root, "fixed-name-output");
    const exported = await runCli(stateRoot(fixture), [
      "run",
      "handoff-export",
      fixture.runId,
      "--correlation-id",
      "fixed-name-canary",
      "--expected-preview-sha256",
      digests.previewSha256,
      "--output-dir",
      outputDirectory,
    ]);
    expect(exported.exitCode).toBe(0);

    const wrongName = path.join(outputDirectory, "renamed-handoff.json");
    const failure = await runCli(path.join(fixture.root, "nonexistent-home"), [
      "handoff",
      "verify",
      "--input",
      wrongName,
    ]);
    expect(errorCode(failure)).toBe("INVALID_HANDOFF_FILE");
    expect(failure.stdout).toBe("");
  });
});
