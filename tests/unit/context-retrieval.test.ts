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

describe("Gate 2 retrieval omission evidence", () => {
  // A security review that reports "no finding" is trusted because the retrieval
  // is supposed to have looked. When a ceiling silently drops a file that matched
  // and ranked, the artifact cannot distinguish "the repository held nothing
  // contrary" from "the contrary evidence ranked below the cap" -- and a human
  // approves on that difference.
  it("records a matched file the file ceiling excluded, with its reason", async () => {
    const { git } = fixture();
    const result = await retrieveReadOnlyContextV1(git, "/repo", BASE, QUERY, {
      maxFiles: 1,
      maxTotalBytes: 8_192,
      maxScanBytes: 16_384,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.matchedFiles).toBeGreaterThan(1);
    expect(result.omittedMatches.length).toBe(result.matchedFiles - result.entries.length);
    expect(result.omittedMatches.every((omission) => omission.reason === "file_ceiling")).toBe(
      true,
    );
    // The omitted file is named, so a reader can go and look at it.
    const selected = new Set(result.entries.map((entry) => entry.path));
    for (const omission of result.omittedMatches) {
      expect(selected.has(omission.path)).toBe(false);
      expect(omission.bytes).toBeGreaterThan(0);
    }
  });

  it("distinguishes a byte-ceiling exclusion from a file-ceiling one", async () => {
    const { git } = fixture();
    const result = await retrieveReadOnlyContextV1(git, "/repo", BASE, QUERY, {
      maxFiles: MAX_RETRIEVAL_FILES,
      maxTotalBytes: 160,
      maxScanBytes: 16_384,
    });

    expect(result.omittedMatches.length).toBeGreaterThan(0);
    expect(result.omittedMatches.some((omission) => omission.reason === "byte_ceiling")).toBe(true);
  });

  it("counts what never became a candidate without naming it", async () => {
    const { git } = fixture();
    const result = await retrieveReadOnlyContextV1(git, "/repo", BASE, QUERY, BUDGET);

    // The fixture carries one binary blob and one secret-shaped file. Naming the
    // secret-shaped path here would disclose a file that failed the secret screen,
    // so these are counts.
    expect(result.excludedFiles.nonText).toBe(1);
    expect(result.excludedFiles.secretShaped).toBe(1);
    expect(result.excludedFiles.byPolicy).toBeGreaterThan(0);
    expect(result.omittedMatches.every((omission) => omission.path !== "notes.txt")).toBe(true);
  });

  it("reports no omissions when every match fit", async () => {
    const { git } = fixture();
    const result = await retrieveReadOnlyContextV1(git, "/repo", BASE, QUERY, BUDGET);

    expect(result.omittedMatches).toEqual([]);
    expect(result.matchedFiles).toBe(result.entries.length);
  });
});

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

  it("normalizes check vocabulary and follows one bounded source-reference hop", async () => {
    const blobs = new Map<string, Buffer>([
      [
        "readme",
        Buffer.from(
          "Name normalization is duplicated across two modules, including src/profile.py and another public module. See also src.profile.py for details. A behavior-preserving refactor must extract a shared implementation and retain the check.\n",
        ),
      ],
      [
        "check",
        Buffer.from(
          "from src.format_name import format_name\nfrom src.profile import display_name\n\nassert format_name('  ada  ') == display_name('  ada  ')\n",
        ),
      ],
      [
        "format",
        Buffer.from(
          'def format_name(value: str) -> str:\n    return " ".join(value.strip().split()).title()\n',
        ),
      ],
      [
        "profile",
        Buffer.from(
          'def display_name(value: str) -> str:\n    return " ".join(value.strip().split()).title()\n',
        ),
      ],
      ["profile-decoy", Buffer.from("This file is not imported.\n")],
    ]);
    const tree: TreeEntry[] = [
      { mode: "100644", type: "blob", objectId: "readme", path: "README.md" },
      { mode: "100644", type: "blob", objectId: "check", path: "checks/test_profile.py" },
      { mode: "100644", type: "blob", objectId: "format", path: "src/format_name.py" },
      { mode: "100644", type: "blob", objectId: "profile", path: "src/profile.py" },
      {
        mode: "100644",
        type: "blob",
        objectId: "profile-decoy",
        path: "src/profile.py.bak",
      },
    ];
    const git = {
      listTree: vi.fn(async () => tree),
      readBlob: vi.fn(async (_repository: string, objectId: string) => {
        const value = blobs.get(objectId);
        if (value === undefined) throw new Error(`unknown object ${objectId}`);
        return value;
      }),
    };

    const result = await retrieveReadOnlyContextV1(
      git,
      "/repository",
      BASE,
      "Trace normalization duplication through both public functions and the check proving equivalence.",
      { maxFiles: 5, maxTotalBytes: 8_192, maxScanBytes: 16_384 },
    );

    expect(result.entries.map((entry) => entry.path).sort()).toEqual([
      "README.md",
      "checks/test_profile.py",
      "src/format_name.py",
      "src/profile.py",
    ]);
    expect(result.entries.find((entry) => entry.path === "src/format_name.py")).toMatchObject({
      score: 0,
      matchedTerms: [],
      matches: [],
    });
  });

  it("treats verification and verify as the same retrieval term", async () => {
    const blobs = new Map<string, Buffer>([
      ["readme", Buffer.from("A fixture overview.\n")],
      ["verify", Buffer.from("assert True\n")],
    ]);
    const git = {
      listTree: vi.fn(
        async () =>
          [
            { mode: "100644", type: "blob", objectId: "readme", path: "README.md" },
            { mode: "100644", type: "blob", objectId: "verify", path: "checks/verify.py" },
          ] satisfies TreeEntry[],
      ),
      readBlob: vi.fn(async (_repository: string, objectId: string) => {
        const value = blobs.get(objectId);
        if (value === undefined) throw new Error(`unknown object ${objectId}`);
        return value;
      }),
    };

    const result = await retrieveReadOnlyContextV1(
      git,
      "/repository",
      BASE,
      "Cite the registered verification.",
      { maxFiles: 1, maxTotalBytes: 8_192, maxScanBytes: 16_384 },
    );

    expect(result.entries.map((entry) => entry.path)).toEqual(["checks/verify.py"]);
    expect(result.queryTerms).toContain("check");
  });

  it("recognizes a referenced path before sentence punctuation", async () => {
    const blobs = new Map<string, Buffer>([
      ["readme", Buffer.from("Architecture overview: implementation lives in src/widget.ts.\n")],
      ["widget", Buffer.from("export const widget = true;\n")],
    ]);
    const git = {
      listTree: vi.fn(
        async () =>
          [
            { mode: "100644", type: "blob", objectId: "readme", path: "README.md" },
            { mode: "100644", type: "blob", objectId: "widget", path: "src/widget.ts" },
          ] satisfies TreeEntry[],
      ),
      readBlob: vi.fn(async (_repository: string, objectId: string) => {
        const value = blobs.get(objectId);
        if (value === undefined) throw new Error(`unknown object ${objectId}`);
        return value;
      }),
    };

    const result = await retrieveReadOnlyContextV1(
      git,
      "/repository",
      BASE,
      "Trace the architecture overview.",
      { maxFiles: 2, maxTotalBytes: 8_192, maxScanBytes: 16_384 },
    );

    expect(result.entries.map((entry) => entry.path)).toEqual(["README.md", "src/widget.ts"]);
  });
});
