import { describe, expect, it, vi } from "vitest";

import {
  MAX_RETRIEVAL_FILES,
  retrieveReadOnlyContextV1,
} from "../../packages/core/src/context-retrieval.js";
import type { TreeEntry } from "../../packages/core/src/git.js";

const BASE = "a".repeat(40);
const BUDGET = { maxFiles: 8, maxTotalBytes: 8_192, maxScanBytes: 16_384 } as const;
const QUERY =
  "Explain Lantern's entry point, configuration flow, and greeting module with file-and-line provenance and no repository changes.";

function fixture() {
  const blobs = new Map<string, Buffer>([
    [
      "readme",
      Buffer.from(
        "# Lantern\n\nConfiguration lives in `config/app.json`; execution begins in `src/main.py`.\n",
      ),
    ],
    ["config", Buffer.from('{\n  "audience": "traveler"\n}\n')],
    [
      "main",
      Buffer.from(
        'import json\nfrom pathlib import Path\nfrom src.greeting import greeting\n\nprint(greeting(json.loads(Path("config/app.json").read_text())["audience"]))\n',
      ),
    ],
    [
      "greeting",
      Buffer.from('def greeting(audience: str) -> str:\n    return f"Welcome, {audience}."\n'),
    ],
    ["secret", Buffer.from("API_TOKEN=real-secret-value-1234567890\n")],
    ["binary", Buffer.from([0, 1, 2, 3])],
    ["hidden", Buffer.from("const greeting = true;\n")],
    ["link", Buffer.from("src/main.py")],
  ]);
  const tree: TreeEntry[] = [
    { mode: "100644", type: "blob", objectId: "main", path: "src/main.py" },
    { mode: "100644", type: "blob", objectId: "secret", path: "notes.txt" },
    { mode: "100644", type: "blob", objectId: "config", path: "config/app.json" },
    { mode: "100644", type: "blob", objectId: "readme", path: "README.md" },
    { mode: "100644", type: "blob", objectId: "binary", path: "assets/logo.dat" },
    { mode: "100644", type: "blob", objectId: "hidden", path: "dist/generated.js" },
    { mode: "120000", type: "blob", objectId: "link", path: "entry.py" },
    { mode: "100644", type: "blob", objectId: "greeting", path: "src/greeting.py" },
  ];
  const readBlob = vi.fn(async (_repository: string, objectId: string) => {
    const value = blobs.get(objectId);
    if (value === undefined) throw new Error(`unknown object ${objectId}`);
    return value;
  });
  return {
    git: { listTree: vi.fn(async () => tree), readBlob },
    readBlob,
    tree,
  };
}

describe("Gate 2 read-only context retrieval", () => {
  it("deterministically retrieves the unfamiliar-codebase evidence with line provenance", async () => {
    const firstFixture = fixture();
    const secondFixture = fixture();
    secondFixture.tree.reverse();

    const first = await retrieveReadOnlyContextV1(
      firstFixture.git,
      "/repository",
      BASE,
      QUERY,
      BUDGET,
    );
    const second = await retrieveReadOnlyContextV1(
      secondFixture.git,
      "/repository",
      BASE,
      QUERY,
      BUDGET,
    );

    expect(second).toEqual(first);
    expect(first.entries.map((entry) => entry.path).sort()).toEqual([
      "README.md",
      "config/app.json",
      "src/greeting.py",
      "src/main.py",
    ]);
    expect(first.entries.find((entry) => entry.path === "src/main.py")?.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ term: "config", lines: [5] }),
        expect.objectContaining({ term: "greeting", lines: [3, 5] }),
      ]),
    );
    expect(first.querySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.repositoryDigestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.digestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(first)).not.toContain("real-secret-value");
    expect(first.scannedFiles).toBe(6);
    expect(firstFixture.readBlob.mock.calls.map((call) => call[1])).not.toContain("hidden");
    expect(firstFixture.readBlob.mock.calls.map((call) => call[1])).not.toContain("link");
  });

  it("enforces scan, selection, query, and secret boundaries", async () => {
    const { git } = fixture();
    await expect(
      retrieveReadOnlyContextV1(git, "/repository", BASE, QUERY, {
        ...BUDGET,
        maxFiles: MAX_RETRIEVAL_FILES + 1,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONTEXT_RETRIEVAL" });
    await expect(
      retrieveReadOnlyContextV1(git, "/repository", BASE, "API_TOKEN=real-secret-value", BUDGET),
    ).rejects.toMatchObject({ code: "INVALID_CONTEXT_RETRIEVAL" });
    await expect(
      retrieveReadOnlyContextV1(
        git,
        "/repository",
        BASE,
        Array.from({ length: 129 }, (_, index) => `term${index}`).join(" "),
        BUDGET,
      ),
    ).rejects.toMatchObject({ code: "INVALID_CONTEXT_RETRIEVAL" });
    await expect(
      retrieveReadOnlyContextV1(git, "/repository", BASE, QUERY, {
        maxFiles: 4,
        maxTotalBytes: 32,
        maxScanBytes: 33,
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_RETRIEVAL_SCAN_BUDGET_EXCEEDED" });
  });

  it("never truncates a selected file to fit the result budget", async () => {
    const { git } = fixture();
    const result = await retrieveReadOnlyContextV1(git, "/repository", BASE, QUERY, {
      maxFiles: 4,
      maxTotalBytes: 40,
      maxScanBytes: 16_384,
    });

    expect(result.entries).toEqual([]);
    expect(result.totalBytes).toBe(0);
  });
});
