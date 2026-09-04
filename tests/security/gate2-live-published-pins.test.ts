import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GATE2_LIVE_CANDIDATE_CONTRACT_REVISION } from "../../scripts/gate2-live-candidate-contract.mjs";
import {
  GATE2_PUBLISHED_EVIDENCE_CONFIGS,
  verifyGate2PublishedEvidence,
} from "../../scripts/gate2-live-evidence-publish.mjs";
import { GATE2_LIVE_ROUTING_POLICY_SHA256 } from "../../scripts/gate2-live-routing-policy.mjs";

/**
 * Why this boundary exists.
 *
 * A published evidence set is a record of what a run measured. Its validator must accept it
 * for as long as the bytes are unchanged — including after the live code moves on. The v2
 * config pinned `candidateContractRevision` and `routingPolicySha256` to the live module
 * constants, so bumping either would have made the validator refuse evidence the bump never
 * touched: valid only while the code stands still, which is not a binding at all. Issue #81.
 */
const repositoryRoot = decodeURIComponent(new URL("../../", import.meta.url).pathname);

const SETS = [
  { version: "v1", directory: "gate2-local-vulcan-code-routing-20260828" },
  { version: "v2", directory: "gate2-local-vulcan-target-discovery-r7-20260828" },
  { version: "reasoning-suppressed", directory: "gate2-reasoning-suppressed-20260901" },
] as const;

async function committedIdentities(directory: string): Promise<{
  candidateContractRevisions: Set<unknown>;
  routingPolicyDigests: Set<unknown>;
  recordCount: number;
}> {
  const root = path.join(repositoryRoot, "docs/evals/artifacts", directory);
  const candidateContractRevisions = new Set<unknown>();
  const routingPolicyDigests = new Set<unknown>();
  let recordCount = 0;
  for (const mode of ["baseline", "routed"]) {
    for (const name of await readdir(path.join(root, mode))) {
      if (!name.endsWith(".json")) continue;
      const record = JSON.parse(await readFile(path.join(root, mode, name), "utf8"));
      candidateContractRevisions.add(record.candidateContractRevision);
      routingPolicyDigests.add(record.routingPolicySha256);
      recordCount += 1;
    }
  }
  return { candidateContractRevisions, routingPolicyDigests, recordCount };
}

describe("Gate 2 published evidence configs pin by value", () => {
  for (const { version, directory } of SETS) {
    it(`pins ${version} to the identities its own 60 records carry`, async () => {
      const config = GATE2_PUBLISHED_EVIDENCE_CONFIGS[version] as Record<string, unknown>;
      const committed = await committedIdentities(directory);
      expect(committed.recordCount).toBe(60);
      // Every record agrees, so there is one value to pin, and the config carries it.
      expect([...committed.candidateContractRevisions]).toEqual([config.candidateContractRevision]);
      expect([...committed.routingPolicyDigests]).toEqual([config.routingPolicySha256]);
    });
  }

  it("pins v2 to values that are literals here, not references to today's constants", () => {
    // They are equal today, which is exactly why the reference looked harmless. The
    // mutation test below is what proves the difference.
    const v2 = GATE2_PUBLISHED_EVIDENCE_CONFIGS.v2 as Record<string, unknown>;
    expect(v2.candidateContractRevision).toBe(5);
    expect(v2.routingPolicySha256).toBe(
      "01c96e8eedc4376cae8aab5fb1c354e9fe84f8fa18ae1a77ed93875724ccd54a",
    );
    expect(GATE2_LIVE_CANDIDATE_CONTRACT_REVISION).toBe(5);
    expect(GATE2_LIVE_ROUTING_POLICY_SHA256).toBe(v2.routingPolicySha256);
  });

  it("keeps every published set verifying when both live constants move", async () => {
    // The proof the issue asks for: the live candidate-contract revision and the live
    // routing policy are bumped in a scratch copy of `scripts/`, and the published sets —
    // whose bytes did not change — must still verify. Before the pin, v2 refused.
    const scratch = await mkdtemp(path.join(os.tmpdir(), "icarus-pins-"));
    try {
      await cp(path.join(repositoryRoot, "scripts"), path.join(scratch, "scripts"), {
        recursive: true,
      });
      const candidatePath = path.join(scratch, "scripts/gate2-live-candidate-contract.mjs");
      const candidate = await readFile(candidatePath, "utf8");
      const bumped = candidate.replace(
        /export const GATE2_LIVE_CANDIDATE_CONTRACT_REVISION = \d+;/,
        "export const GATE2_LIVE_CANDIDATE_CONTRACT_REVISION = 99;",
      );
      expect(bumped).not.toBe(candidate);
      await writeFile(candidatePath, bumped);

      const routingPath = path.join(scratch, "scripts/gate2-live-routing-policy.mjs");
      const routing = await readFile(routingPath, "utf8");
      const rerouted = routing.replace(
        'routed: Object.freeze({\n    defaultModelId: "code",\n    overrides: Object.freeze({}),\n  }),',
        'routed: Object.freeze({\n    defaultModelId: "code",\n    overrides: Object.freeze({ security_review: "code-fast" }),\n  }),',
      );
      expect(rerouted).not.toBe(routing);
      await writeFile(routingPath, rerouted);

      // The publisher reaches the built core by a relative path; re-point it at the real one.
      const publisherPath = path.join(scratch, "scripts/gate2-live-evidence-publish.mjs");
      const publisher = await readFile(publisherPath, "utf8");
      await writeFile(
        publisherPath,
        publisher.replace(
          '"../packages/core/dist/context.js"',
          JSON.stringify(path.join(repositoryRoot, "packages/core/dist/context.js")),
        ),
      );

      const mutated = await import(publisherPath);
      expect(mutated.GATE2_PUBLISHED_EVIDENCE_CONFIGS.v2.candidateContractRevision).toBe(5);
      for (const { version } of SETS) {
        const verified = await mutated.verifyGate2PublishedEvidence(repositoryRoot, version);
        expect(verified.files).toHaveLength(64);
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("still verifies every set with the constants as they stand", async () => {
    for (const { version } of SETS) {
      expect((await verifyGate2PublishedEvidence(repositoryRoot, version)).files).toHaveLength(64);
    }
  });
});
