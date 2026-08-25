import { afterEach, describe, expect, test } from "vitest";
import {
  HEADLESS_HISTORY_SCHEMA,
  type HeadlessHistoryContentLine,
  headlessHistoryContentSha256,
} from "../../packages/core/src/index.js";
import {
  createFixtureRepository,
  jsonOutput,
  PYTHON_IMAGE,
  planResponse,
  runCli,
  startOllamaQueue,
} from "../support/integration-cli.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("headless history CLI", () => {
  test("exports the complete run trajectory as deterministic, checksum-terminated JSONL", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.cleanup);
    const provider = await startOllamaQueue([planResponse()]);
    cleanups.push(provider.close);

    expect(
      (
        await runCli(fixture.stateRoot, [
          "repo",
          "add",
          "--name",
          "fixture",
          "--path",
          fixture.repository,
        ])
      ).exitCode,
    ).toBe(0);
    expect(
      (
        await runCli(fixture.stateRoot, [
          "project",
          "add",
          "--name",
          "golden",
          "--repo",
          "fixture",
          "--base-ref",
          "main",
          "--sandbox-image",
          PYTHON_IMAGE,
          "--check",
          JSON.stringify({
            id: "verify",
            name: "Verify greeting",
            argv: ["python", "checks/verify.py"],
          }),
        ])
      ).exitCode,
    ).toBe(0);

    const planned = jsonOutput<{ readonly id: string }>(
      await runCli(fixture.stateRoot, [
        "run",
        "plan",
        "--project",
        "golden",
        "--task",
        "Inspect the greeting.",
        "--target",
        "src/greeting.txt",
        "--provider",
        "ollama",
        "--model",
        "contract-model",
        "--base-url",
        provider.baseUrl,
      ]),
    );

    const history = await runCli(fixture.stateRoot, [
      "run",
      "history",
      planned.id,
      "--format",
      "jsonl",
    ]);
    expect(history.exitCode).toBe(0);
    const repeated = await runCli(fixture.stateRoot, [
      "run",
      "history",
      planned.id,
      "--format",
      "jsonl",
    ]);
    expect(repeated.exitCode).toBe(0);
    expect(repeated.stdout).toBe(history.stdout);

    const lines = history.stdout
      .trimEnd()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            readonly schema: string;
            readonly kind: string;
            readonly sequence?: number;
            readonly approvalCount?: number;
            readonly eventCount?: number;
            readonly contentSha256?: string;
          },
      );

    expect(lines.length).toBeGreaterThan(2);
    expect(lines.every((line) => line.schema === HEADLESS_HISTORY_SCHEMA)).toBe(true);
    expect(lines[0]?.kind).toBe("run");
    expect(lines.at(-1)?.kind).toBe("end");
    expect(lines.at(-1)?.eventCount).toBe(lines.filter((line) => line.kind === "event").length);
    expect(lines.at(-1)?.approvalCount).toBe(
      lines.filter((line) => line.kind === "approval").length,
    );
    expect(lines.at(-1)?.contentSha256).toBe(
      headlessHistoryContentSha256(
        lines.slice(0, -1) as unknown as readonly HeadlessHistoryContentLine[],
      ),
    );
    expect(lines.filter((line) => line.kind === "event").map((line) => line.sequence)).toEqual(
      expect.arrayContaining([1]),
    );

    const invalid = await runCli(fixture.stateRoot, [
      "run",
      "history",
      planned.id,
      "--format",
      "yaml",
    ]);
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr).toContain("INVALID_ARGUMENT");
  });
});
