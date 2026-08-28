import { describe, expect, it, vi } from "vitest";
import { digestJson } from "../../packages/core/src/digest.js";
import type { TreeEntry } from "../../packages/core/src/git.js";
import { explainCodebaseV1, retrieveReadOnlyContextV1 } from "../../packages/core/src/index.js";
import { createProviderConfig, type ModelGateway } from "../../packages/core/src/provider.js";
import type { JsonValue, ProviderUsage } from "../../packages/core/src/types.js";

const TASK = "Explain the main entry point with file-and-line provenance.";
const BASE = "b".repeat(40);
const VALID_RESPONSE = {
  summary: "The selected source defines the entry point.",
  claims: [
    {
      text: "main returns the application name.",
      citations: [{ path: "src/main.ts", lineStart: 1, lineEnd: 1 }],
    },
  ],
};
const VALID_USAGE: ProviderUsage = {
  inputTokens: 20,
  outputTokens: 10,
  estimatedCostUsd: 0,
  latencyMs: 2,
};

async function retrieval(
  source = Buffer.from('export function main(): string { return "Lantern"; }\n'),
) {
  const tree: TreeEntry[] = [
    { mode: "100644", type: "blob", objectId: "main", path: "src/main.ts" },
  ];
  return retrieveReadOnlyContextV1(
    {
      listTree: vi.fn(async () => tree),
      readBlob: vi.fn(async () => source),
    },
    "/repository",
    BASE,
    TASK,
    {
      maxFiles: 1,
      maxTotalBytes: Math.max(1_024, source.length + 64),
      maxScanBytes: Math.max(1_024, source.length + 64),
    },
  );
}

function gateway(response: unknown, usage: ProviderUsage = VALID_USAGE): ModelGateway {
  return {
    config: createProviderConfig({
      kind: "ollama",
      model: "fixture-explainer",
      baseUrl: "http://127.0.0.1:11434/",
    }),
    generateStructured: vi.fn(async () => ({
      text: typeof response === "string" ? response : JSON.stringify(response),
      usage,
    })),
  };
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

describe("Gate 2 explanation trust-boundary contract", () => {
  it.each([
    ["unknown response field", { ...VALID_RESPONSE, unreviewed: true }],
    [
      "unselected citation path",
      {
        ...VALID_RESPONSE,
        claims: [
          {
            text: "A package file defines the entry point.",
            citations: [{ path: "package.json", lineStart: 1, lineEnd: 1 }],
          },
        ],
      },
    ],
    [
      "out-of-range citation",
      {
        ...VALID_RESPONSE,
        claims: [
          {
            text: "The entry point spans many lines.",
            citations: [{ path: "src/main.ts", lineStart: 1, lineEnd: 99 }],
          },
        ],
      },
    ],
    [
      "duplicate citation",
      {
        ...VALID_RESPONSE,
        claims: [
          {
            text: "The entry point is repeated.",
            citations: [
              { path: "src/main.ts", lineStart: 1, lineEnd: 1 },
              { path: "src/main.ts", lineStart: 1, lineEnd: 1 },
            ],
          },
        ],
      },
    ],
    [
      "secret-shaped text",
      {
        ...VALID_RESPONSE,
        claims: [
          {
            text: `The entry point contains sk-${"a".repeat(24)}.`,
            citations: [{ path: "src/main.ts", lineStart: 1, lineEnd: 1 }],
          },
        ],
      },
    ],
    [
      "duplicate JSON field",
      '{"summary":"one","summary":"two","claims":[{"text":"main returns the application name.","citations":[{"path":"src/main.ts","lineStart":1,"lineEnd":1}]}]}',
    ],
  ])("rejects %s", async (_name, response) => {
    await expect(
      explainCodebaseV1(gateway(response), await retrieval(), TASK),
    ).rejects.toMatchObject({ code: "INVALID_CODEBASE_EXPLANATION" });
  });

  it("rejects forged provider accounting instead of returning it in the receipt", async () => {
    const forgedUsage: ProviderUsage = { ...VALID_USAGE, inputTokens: -1 };

    await expect(
      explainCodebaseV1(gateway(VALID_RESPONSE, forgedUsage), await retrieval(), TASK),
    ).rejects.toMatchObject({ code: "INVALID_CODEBASE_EXPLANATION" });
  });

  it("refuses line-number expansion beyond the explanation input ceiling before provider I/O", async () => {
    const provider = gateway(VALID_RESPONSE);
    const lineDenseSource = Buffer.from(`main\n${"x\n".repeat(131_072)}`);

    await expect(
      explainCodebaseV1(provider, await retrieval(lineDenseSource), TASK),
    ).rejects.toMatchObject({ code: "INVALID_CODEBASE_EXPLANATION" });
    expect(provider.generateStructured).not.toHaveBeenCalled();
  });

  it("documents that an internally self-consistent retrieval digest does not authenticate its origin", async () => {
    const trusted = await retrieval();
    const forgedBaseCommit = "c".repeat(40);
    const unsigned = {
      ...trusted,
      baseCommit: forgedBaseCommit,
      repositoryDigestSha256: digestJson(
        asJsonValue({
          baseCommit: forgedBaseCommit,
          files: trusted.entries.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
        }),
      ),
      digestSha256: undefined,
    };
    const { digestSha256: _omitted, ...withoutDigest } = unsigned;
    const digestable = {
      ...withoutDigest,
      entries: withoutDigest.entries.map(({ content: _content, ...entry }) => entry),
    };
    const counterfeit = {
      ...withoutDigest,
      digestSha256: digestJson(asJsonValue(digestable)),
    };

    const accepted = await explainCodebaseV1(gateway(VALID_RESPONSE), counterfeit, TASK);

    expect(accepted.baseCommit).toBe(forgedBaseCommit);
  });

  it("documents that a valid citation location does not prove semantic entailment", async () => {
    const falseButCited = {
      summary: "The selected source is cited but the claim is semantically false.",
      claims: [
        {
          text: "main launches a destructive database migration.",
          citations: [{ path: "src/main.ts", lineStart: 1, lineEnd: 1 }],
        },
      ],
    };

    const accepted = await explainCodebaseV1(gateway(falseButCited), await retrieval(), TASK);

    expect(accepted.claims[0]?.text).toBe(falseButCited.claims[0]?.text);
  });
});
