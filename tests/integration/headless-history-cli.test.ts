import { afterEach, describe, expect, test } from "vitest";
import { HEADLESS_HISTORY_SCHEMA } from "../../packages/core/src/index.js";
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
  test("exports the complete run trajectory as versioned JSONL", async () => {
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
    const lines = history.stdout
      .trimEnd()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            readonly schema: string;
            readonly kind: string;
            readonly sequence?: number;
            readonly eventCount?: number;
          },
      );

    expect(lines.length).toBeGreaterThan(2);
    expect(lines.every((line) => line.schema === HEADLESS_HISTORY_SCHEMA)).toBe(true);
    expect(lines[0]?.kind).toBe("run");
    expect(lines.at(-1)?.kind).toBe("end");
    expect(lines.at(-1)?.eventCount).toBe(lines.filter((line) => line.kind === "event").length);
    expect(lines.filter((line) => line.kind === "event").map((line) => line.sequence)).toEqual(
      expect.arrayContaining([1]),
    );
  });
});
