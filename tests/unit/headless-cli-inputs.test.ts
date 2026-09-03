import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { runCliMain } from "../../packages/cli/src/main.js";
import type { IcarusRuntime } from "../../packages/core/src/runtime.js";

const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROFILE = { schemaVersion: 1, profileId: "operator-profile" };
const CATALOG = [{ id: "operator-provider" }];

let scratch: string | undefined;
let previousHome: string | undefined;
let previousExitCode: string | number | null | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
  process.exitCode = previousExitCode;
  if (previousHome === undefined) delete process.env.ICARUS_HOME;
  else process.env.ICARUS_HOME = previousHome;
});

function setup(): string {
  previousHome = process.env.ICARUS_HOME;
  previousExitCode = process.exitCode;
  scratch = mkdtempSync(path.join(os.tmpdir(), "icarus-headless-inputs-"));
  process.env.ICARUS_HOME = path.join(scratch, "state");
  process.exitCode = undefined;
  return scratch;
}

async function invoke(args: readonly string[]): Promise<{
  readonly stderr: string;
  readonly approveHeadlessPlan: ReturnType<typeof vi.fn>;
}> {
  const stderr: string[] = [];
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  const approveHeadlessPlan = vi.fn(async () => {
    throw new Error("Input parsing reached the service boundary");
  });
  const createRuntime = vi.fn(async () => {
    return {
      service: { approveHeadlessPlan },
      close: vi.fn(),
    } as unknown as IcarusRuntime;
  });
  try {
    await runCliMain({ args, platform: "linux", createRuntime });
    return { stderr: stderr.join(""), approveHeadlessPlan };
  } finally {
    stderrSpy.mockRestore();
  }
}

function approvalArgs(profileArgs: readonly string[], catalogArgs: readonly string[]): string[] {
  return [
    "run",
    "approve-headless",
    RUN_ID,
    "--plan-sha",
    "f".repeat(64),
    "--actor",
    "operator",
    ...profileArgs,
    ...catalogArgs,
  ];
}

describe("headless CLI profile and provider-catalog inputs", () => {
  test("file and inline transports deliver identical decoded records to the service", async () => {
    const root = setup();
    const profilePath = path.join(root, "profile.json");
    const catalogPath = path.join(root, "catalog.json");
    writeFileSync(profilePath, JSON.stringify(PROFILE), { mode: 0o600 });
    writeFileSync(catalogPath, JSON.stringify(CATALOG), { mode: 0o600 });

    const inline = await invoke(
      approvalArgs(
        ["--profile-json", JSON.stringify(PROFILE)],
        ["--provider-catalog-json", JSON.stringify(CATALOG)],
      ),
    );
    const file = await invoke(
      approvalArgs(["--profile-file", profilePath], ["--provider-catalog-file", catalogPath]),
    );

    expect(inline.stderr).toContain("Input parsing reached the service boundary");
    expect(file.stderr).toContain("Input parsing reached the service boundary");
    expect(inline.approveHeadlessPlan).toHaveBeenCalledOnce();
    expect(file.approveHeadlessPlan).toHaveBeenCalledOnce();
    expect(file.approveHeadlessPlan.mock.calls[0]?.slice(0, 5)).toEqual(
      inline.approveHeadlessPlan.mock.calls[0]?.slice(0, 5),
    );
  });

  test("requires exactly one transport for each input", async () => {
    const root = setup();
    const profilePath = path.join(root, "profile.json");
    writeFileSync(profilePath, JSON.stringify(PROFILE), { mode: 0o600 });

    const both = await invoke(
      approvalArgs(
        ["--profile-json", JSON.stringify(PROFILE), "--profile-file", profilePath],
        ["--provider-catalog-json", JSON.stringify(CATALOG)],
      ),
    );
    expect(both.stderr).toContain("Exactly one of --profile-json or --profile-file");
    expect(both.approveHeadlessPlan).not.toHaveBeenCalled();

    const neither = await invoke(
      approvalArgs([], ["--provider-catalog-json", JSON.stringify(CATALOG)]),
    );
    expect(neither.stderr).toContain("Exactly one of --profile-json or --profile-file");
    expect(neither.approveHeadlessPlan).not.toHaveBeenCalled();
  });

  test("rejects duplicate members in either transport before the service boundary", async () => {
    const root = setup();
    const duplicate = '{"schemaVersion":1,"schemaVersion":1}';
    const profilePath = path.join(root, "profile.json");
    writeFileSync(profilePath, duplicate, { mode: 0o600 });

    const inline = await invoke(
      approvalArgs(
        ["--profile-json", duplicate],
        ["--provider-catalog-json", JSON.stringify(CATALOG)],
      ),
    );
    expect(inline.stderr).toContain("strict JSON without duplicate object members");
    expect(inline.approveHeadlessPlan).not.toHaveBeenCalled();

    const file = await invoke(
      approvalArgs(
        ["--profile-file", profilePath],
        ["--provider-catalog-json", JSON.stringify(CATALOG)],
      ),
    );
    expect(file.stderr).toContain("strict JSON without duplicate object members");
    expect(file.approveHeadlessPlan).not.toHaveBeenCalled();
  });

  test("rejects symlinked, shared-writable, and oversized files before service work", async () => {
    const root = setup();
    const profilePath = path.join(root, "profile.json");
    const linkedPath = path.join(root, "linked.json");
    writeFileSync(profilePath, JSON.stringify(PROFILE), { mode: 0o600 });
    symlinkSync(profilePath, linkedPath);

    const linked = await invoke(
      approvalArgs(
        ["--profile-file", linkedPath],
        ["--provider-catalog-json", JSON.stringify(CATALOG)],
      ),
    );
    expect(linked.stderr).toContain("INVALID_HEADLESS_INPUT_FILE");
    expect(linked.approveHeadlessPlan).not.toHaveBeenCalled();

    chmodSync(profilePath, 0o620);
    const writable = await invoke(
      approvalArgs(
        ["--profile-file", profilePath],
        ["--provider-catalog-json", JSON.stringify(CATALOG)],
      ),
    );
    expect(writable.stderr).toContain("group- or world-writable");
    expect(writable.approveHeadlessPlan).not.toHaveBeenCalled();

    const oversizedPath = path.join(root, "oversized.json");
    writeFileSync(oversizedPath, " ".repeat(256 * 1024 + 1), { mode: 0o600 });
    const oversized = await invoke(
      approvalArgs(
        ["--profile-file", oversizedPath],
        ["--provider-catalog-json", JSON.stringify(CATALOG)],
      ),
    );
    expect(oversized.stderr).toContain("Input exceeds its file-size ceiling");
    expect(oversized.approveHeadlessPlan).not.toHaveBeenCalled();

    const realDirectory = path.join(root, "real");
    const linkedDirectory = path.join(root, "linked-directory");
    mkdirSync(realDirectory);
    const nestedPath = path.join(realDirectory, "profile.json");
    writeFileSync(nestedPath, JSON.stringify(PROFILE), { mode: 0o600 });
    symlinkSync(realDirectory, linkedDirectory);
    const linkedAncestor = await invoke(
      approvalArgs(
        ["--profile-file", path.join(linkedDirectory, "profile.json")],
        ["--provider-catalog-json", JSON.stringify(CATALOG)],
      ),
    );
    expect(linkedAncestor.stderr).toContain("Input path must not contain symbolic links");
    expect(linkedAncestor.approveHeadlessPlan).not.toHaveBeenCalled();
  });
});
