import { describe, expect, it, vi } from "vitest";

import { CODEBASE_EXPLANATION_SCHEMA, explainCodebaseV2 } from "../../packages/core/src/index.js";
import { retrieveReadOnlyContextV3 } from "../../packages/core/src/context-retrieval.js";
import type { TreeEntry } from "../../packages/core/src/git.js";
import { createProviderConfig, type ModelGateway } from "../../packages/core/src/provider.js";

const TASK =
  "Explain Lantern's entry point, configuration flow, and greeting module with file-and-line provenance and no repository changes.";
const BASE = "a".repeat(40);

async function retrieval(budget?: {
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly maxScanBytes: number;
}) {
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
        'import json\nfrom pathlib import Path\n\nfrom src.greeting import greeting\n\nprint(greeting(json.loads(Path("config/app.json").read_text())["audience"]))\n',
      ),
    ],
    [
      "greeting",
      Buffer.from('def greeting(audience: str) -> str:\n    return f"Welcome, {audience}."\n'),
    ],
  ]);
  const tree: TreeEntry[] = [
    { mode: "100644", type: "blob", objectId: "readme", path: "README.md" },
    { mode: "100644", type: "blob", objectId: "config", path: "config/app.json" },
    { mode: "100644", type: "blob", objectId: "greeting", path: "src/greeting.py" },
    { mode: "100644", type: "blob", objectId: "main", path: "src/main.py" },
  ];
  return retrieveReadOnlyContextV3(
    {
      listTree: vi.fn(async () => tree),
      readBlob: vi.fn(async (_repository: string, objectId: string) => {
        const value = blobs.get(objectId);
        if (value === undefined) throw new Error(`unknown blob ${objectId}`);
        return value;
      }),
    },
    "/repository",
    BASE,
    TASK,
    budget ?? { maxFiles: 4, maxTotalBytes: 4_096, maxScanBytes: 4_096 },
  );
}

function gateway(): ModelGateway {
  return {
    config: createProviderConfig({
      kind: "ollama",
      model: "fixture-explainer",
      baseUrl: "http://127.0.0.1:11434/",
    }),
    generateStructured: vi.fn(async () => ({
      text: JSON.stringify({
        summary: "Lantern loads a configured audience and prints a greeting.",
        claims: [
          {
            text: "Execution begins in src/main.py.",
            citations: [{ path: "src/main.py", lineStart: 1, lineEnd: 6 }],
          },
          {
            text: "The entry point reads the audience from config/app.json.",
            citations: [
              { path: "config/app.json", lineStart: 1, lineEnd: 3 },
              { path: "src/main.py", lineStart: 6, lineEnd: 6 },
            ],
          },
          {
            text: "src.greeting.greeting formats the final welcome message.",
            citations: [
              { path: "src/greeting.py", lineStart: 1, lineEnd: 2 },
              { path: "src/main.py", lineStart: 4, lineEnd: 6 },
            ],
          },
        ],
      }),
      usage: { inputTokens: 120, outputTokens: 80, estimatedCostUsd: 0, latencyMs: 12 },
    })),
  };
}

describe("Gate 2 read-only codebase explanation", () => {
  it("returns a digest-bound explanation whose claims cite selected source lines", async () => {
    const context = await retrieval();
    const provider = gateway();

    const result = await explainCodebaseV2(provider, context, TASK);

    expect(result).toMatchObject({
      schema: CODEBASE_EXPLANATION_SCHEMA,
      baseCommit: BASE,
      taskSha256: context.querySha256,
      retrievalDigestSha256: context.digestSha256,
      summary: "Lantern loads a configured audience and prints a greeting.",
      claims: expect.arrayContaining([
        expect.objectContaining({
          text: "Execution begins in src/main.py.",
          citations: [{ path: "src/main.py", lineStart: 1, lineEnd: 6 }],
        }),
      ]),
      usage: { inputTokens: 120, outputTokens: 80, estimatedCostUsd: 0, latencyMs: 12 },
    });
    expect(result.digestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(provider.generateStructured).toHaveBeenCalledOnce();
    expect(provider.generateStructured).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaName: "codebase_explanation_v1",
        input: expect.stringContaining('"path":"src/main.py"'),
      }),
      undefined,
    );
  });

  it("refuses changed retrieval content before the provider can observe it", async () => {
    const context = await retrieval();
    const provider = gateway();
    const changed = {
      ...context,
      entries: context.entries.map((entry, index) =>
        index === 0 ? { ...entry, content: "forged after retrieval\n" } : entry,
      ),
    };

    await expect(explainCodebaseV2(provider, changed, TASK)).rejects.toMatchObject({
      code: "INVALID_CODEBASE_EXPLANATION",
    });
    expect(provider.generateStructured).not.toHaveBeenCalled();
  });

  it("refuses a citation whose selected line range contains no source evidence", async () => {
    const context = await retrieval();
    const provider = gateway();
    vi.mocked(provider.generateStructured).mockResolvedValueOnce({
      text: JSON.stringify({
        summary: "Lantern is explained.",
        claims: [
          {
            text: "The entry point is documented.",
            citations: [{ path: "README.md", lineStart: 4, lineEnd: 4 }],
          },
        ],
      }),
      usage: { inputTokens: 80, outputTokens: 20, estimatedCostUsd: 0, latencyMs: 5 },
    });

    await expect(explainCodebaseV2(provider, context, TASK)).rejects.toMatchObject({
      code: "INVALID_CODEBASE_EXPLANATION",
    });
  });

  it("projects the retrieval's omission evidence into the artifact a human reads", async () => {
    // The seam that failed the first time. The artifact carried only an opaque
    // retrieval digest, so a reader of a persisted result could not tell "nothing
    // contrary matched" from "contrary files were excluded by a ceiling". Asserted
    // by exact equality so deleting, zeroing, or swapping a projected member fails.
    const context = await retrieval({ maxFiles: 2, maxTotalBytes: 4_096, maxScanBytes: 4_096 });
    expect(context.omittedMatches.length).toBeGreaterThan(0);

    // Cites only a file that survives the tightened budget, so the assertion is
    // about the coverage projection rather than citation scope.
    const narrowGateway: ModelGateway = {
      config: createProviderConfig({
        kind: "ollama",
        model: "fixture-explainer",
        baseUrl: "http://127.0.0.1:11434/",
      }),
      generateStructured: vi.fn(async () => ({
        text: JSON.stringify({
          summary: "Lantern reads a configured audience.",
          claims: [
            {
              text: "The audience is configured in config/app.json.",
              citations: [{ path: "config/app.json", lineStart: 1, lineEnd: 3 }],
            },
          ],
        }),
        usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0, latencyMs: 1 },
      })),
    };

    const result = await explainCodebaseV2(narrowGateway, context, TASK);

    expect(result.retrievalCoverage).toEqual({
      matchedFiles: context.matchedFiles,
      selectedFiles: context.entries.length,
      omittedMatches: context.omittedMatches,
      omittedReferences: context.omittedReferences,
      excludedFiles: context.excludedFiles,
    });
    // The withheld files are named, not merely counted, so the reader can look.
    expect(result.retrievalCoverage.omittedMatches[0]?.path).toEqual(expect.any(String));
    expect(result.retrievalCoverage.matchedFiles).toBeGreaterThan(
      result.retrievalCoverage.selectedFiles,
    );
  });
});
