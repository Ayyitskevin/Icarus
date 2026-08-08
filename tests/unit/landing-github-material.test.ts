import { existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";

import { sha256 } from "../../packages/core/src/digest.js";
import {
  digestLandingRecord,
  type GitHubLandingProfileV1,
  gitObjectSha1,
} from "../../packages/core/src/landing-records.js";
import type { RunLeaseGuard } from "../../packages/core/src/lease.js";
import { checkpointReadBoundsV1, IcarusStore } from "../../packages/core/src/store.js";
import type { SunCeiling } from "../../packages/core/src/types.js";
import {
  MATERIAL_BINARY_BYTES as BINARY_BYTES,
  createLandingGitHubMaterialFixture,
  type LandingGitHubMaterialFixture as Fixture,
  MATERIAL_MODIFIED_BYTES as MODIFIED_BYTES,
  MATERIAL_PATHS as PATHS,
  MATERIAL_PROFILE as PROFILE,
} from "../support/landing-github-material-fixture.js";
import { UNIT_CEILING, UNIT_RUN_ID } from "../support/unit-fixtures.js";

interface TestDatabase {
  prepare(sql: string): {
    run(...parameters: unknown[]): { readonly changes: number };
  };
  close(): void;
}

const Database = createRequire(new URL("../../packages/core/package.json", import.meta.url))(
  "better-sqlite3",
) as new (
  filename: string,
) => TestDatabase;

const fixtures: Fixture[] = [];
const additionalStores: IcarusStore[] = [];

afterEach(() => {
  for (const store of additionalStores.splice(0)) store.close();
  for (const fixture of fixtures.splice(0)) {
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture(
  ceiling: SunCeiling = UNIT_CEILING,
  createdBytes: Uint8Array = BINARY_BYTES,
  commitMessage?: string,
  requireSafeAudit = true,
): Promise<Fixture> {
  const fixture = await createLandingGitHubMaterialFixture(
    ceiling,
    createdBytes,
    commitMessage,
    requireSafeAudit,
  );
  fixtures.push(fixture);
  return fixture;
}

async function admitRequest(fixture: Fixture, guard: RunLeaseGuard) {
  const started = await fixture.store.startGitHubPreflight(guard, fixture.landingId);
  return fixture.store.admitNextGitHubPreflightRequest(
    guard,
    fixture.landingId,
    started.operationId,
  );
}

function mutate(databasePath: string, sql: string, ...parameters: unknown[]): void {
  const database = new Database(databasePath);
  try {
    expect(database.prepare(sql).run(...parameters).changes).toBe(1);
  } finally {
    database.close();
  }
}

function mutateIgnoringChecks(databasePath: string, sql: string, ...parameters: unknown[]): void {
  const database = new Database(databasePath);
  try {
    database.prepare("PRAGMA ignore_check_constraints = ON").run();
    expect(database.prepare(sql).run(...parameters).changes).toBe(1);
  } finally {
    database.close();
  }
}

describe("guard-bound immutable GitHub landing material", () => {
  it("reconstructs create, delete, modify, and binary material without source paths", async () => {
    const fixture = await createFixture();
    expect(existsSync(fixture.cachePath)).toBe(false);
    expect(existsSync(fixture.worktreePath)).toBe(false);
    let requestId = "";

    await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      const admitted = await admitRequest(fixture, guard);
      requestId = admitted.request.requestId;
      await expect(
        fixture.store.readClaimedGitHubLandingMaterial(
          guard,
          admitted.request.requestId,
          fixture.landingId,
        ),
      ).rejects.toMatchObject({ code: "GITHUB_GATEWAY_MATERIAL_UNAVAILABLE" });

      const claim = await fixture.store.claimAdmittedGitHubPreflightRequestWithMaterial(
        guard,
        admitted.request.requestId,
      );
      expect(Object.keys(claim).sort()).toEqual(["landingSha256", "request"]);
      expect(claim.request).toEqual(admitted.request);
      const database = new Database(fixture.databasePath);
      try {
        expect(
          database
            .prepare(
              "UPDATE checkpoint_files SET approved_base64 = ? WHERE run_id = ? AND path = ?",
            )
            .run(Buffer.from("tampered\n").toString("base64"), UNIT_RUN_ID, PATHS[2]).changes,
        ).toBe(1);
        expect(
          database
            .prepare(
              "UPDATE landings SET commit_message = ?, " +
                "profile_json = replace(profile_json, ?, ?) WHERE id = ?",
            )
            .run(
              "Tampered after claim\n",
              `"owner":"${PROFILE.owner}"`,
              '"owner":"tampered-owner"',
              fixture.landingId,
            ).changes,
        ).toBe(1);
      } finally {
        database.close();
      }
      const material = await fixture.store.readClaimedGitHubLandingMaterial(
        guard,
        admitted.request.requestId,
        fixture.landingId,
      );
      expect(material.objectManifest.entries.map((entry) => entry.op)).toEqual([
        "create",
        "delete",
        "modify",
      ]);
      expect(material.changedBlobs.map((entry) => entry.path)).toEqual([PATHS[0], PATHS[2]]);
      expect(material.changedBlobs[0]?.content).toEqual(BINARY_BYTES);
      expect(material.changedBlobs[1]?.content).toEqual(new Uint8Array(MODIFIED_BYTES));
      expect(digestLandingRecord(material.objectManifest)).toBe(fixture.candidateManifestSha256);
      expect(JSON.stringify(material)).not.toContain(fixture.cachePath);
      expect(JSON.stringify(material)).not.toContain(fixture.worktreePath);

      material.changedBlobs[0]?.content.fill(42);
      (material.landing.changedPaths as string[])[0] = "mutated/path";
      (material.profile as { owner: string }).owner = "mutated-owner";
      const mutableManifestEntry = (
        material.objectManifest.entries as unknown as { path: string }[]
      )[0];
      expect(mutableManifestEntry).toBeDefined();
      if (mutableManifestEntry !== undefined) mutableManifestEntry.path = "mutated/object";
      const reread = await fixture.store.readClaimedGitHubLandingMaterial(
        guard,
        admitted.request.requestId,
        fixture.landingId,
      );
      expect(reread.changedBlobs[0]?.content).toEqual(BINARY_BYTES);
      expect(reread.landing.changedPaths[0]).toBe(PATHS[0]);
      expect(reread.profile.owner).toBe(PROFILE.owner);
      expect(reread.objectManifest.entries[0]?.path).toBe(PATHS[0]);

      await expect(
        fixture.store.readClaimedGitHubLandingMaterial(
          guard,
          admitted.request.requestId,
          "ffffffff-ffff-4fff-8fff-ffffffffffff",
        ),
      ).rejects.toMatchObject({ code: "GITHUB_GATEWAY_MATERIAL_UNAVAILABLE" });

      const otherStore = new IcarusStore(fixture.databasePath);
      additionalStores.push(otherStore);
      await expect(
        otherStore.readClaimedGitHubLandingMaterial(
          guard,
          admitted.request.requestId,
          fixture.landingId,
        ),
      ).rejects.toMatchObject({ code: "GITHUB_GATEWAY_MATERIAL_UNAVAILABLE" });
    });

    await fixture.leases.withLease(UNIT_RUN_ID, async (freshGuard) => {
      await expect(
        fixture.store.readClaimedGitHubLandingMaterial(freshGuard, requestId, fixture.landingId),
      ).rejects.toMatchObject({ code: "GITHUB_GATEWAY_MATERIAL_UNAVAILABLE" });
    });
  });

  it("does not promote a legacy claim into material authority", async () => {
    const fixture = await createFixture();
    await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      const admitted = await admitRequest(fixture, guard);
      await expect(
        fixture.store.claimAdmittedGitHubPreflightRequest(guard, admitted.request.requestId),
      ).resolves.toMatchObject({ request: admitted.request });
      await expect(
        fixture.store.readClaimedGitHubLandingMaterial(
          guard,
          admitted.request.requestId,
          fixture.landingId,
        ),
      ).rejects.toMatchObject({ code: "GITHUB_GATEWAY_MATERIAL_UNAVAILABLE" });
    });
  });

  it("keeps an existing landing bound to its original profile after a project profile update", async () => {
    const fixture = await createFixture();
    const updatedProfile: GitHubLandingProfileV1 = {
      ...PROFILE,
      owner: "updated-owner",
      repository: "updated-repository",
      expectedActor: "updated-actor",
    };
    fixture.store.setLandingProfile(
      fixture.projectId,
      updatedProfile,
      new Set([updatedProfile.credentialRef.name]),
    );
    expect(fixture.store.getLandingProfile(fixture.projectId)?.profile).toEqual(updatedProfile);

    await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      const admitted = await admitRequest(fixture, guard);
      const claim = await fixture.store.claimAdmittedGitHubPreflightRequestWithMaterial(
        guard,
        admitted.request.requestId,
      );
      const material = await fixture.store.readClaimedGitHubLandingMaterial(
        guard,
        admitted.request.requestId,
        fixture.landingId,
      );
      expect(claim.request).toMatchObject({
        kind: "github.actor.get",
        profileSha256: digestLandingRecord(PROFILE),
        subject: { expectedActor: PROFILE.expectedActor },
      });
      expect(material.profile).toEqual(PROFILE);
      expect(material.landing.profile).toEqual(PROFILE);
    });
  });

  it("reconstructs an approved empty file as the exact empty Git blob", async () => {
    const fixture = await createFixture(UNIT_CEILING, new Uint8Array());
    await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      const admitted = await admitRequest(fixture, guard);
      await fixture.store.claimAdmittedGitHubPreflightRequestWithMaterial(
        guard,
        admitted.request.requestId,
      );
      const material = await fixture.store.readClaimedGitHubLandingMaterial(
        guard,
        admitted.request.requestId,
        fixture.landingId,
      );
      expect(material.changedBlobs[0]).toMatchObject({ path: PATHS[0] });
      expect(material.changedBlobs[0]?.content).toEqual(new Uint8Array());
      expect(material.objectManifest.entries[0]).toMatchObject({
        path: PATHS[0],
        contentBytes: 0,
        contentSha256: sha256(new Uint8Array()),
        blobSha1: gitObjectSha1("blob", new Uint8Array()),
      });
    });
  });

  it("re-scans a digest-consistent secret-shaped changed blob before caching", async () => {
    const secretBytes = Buffer.from(`ghp_${"a".repeat(20)}`, "utf8");
    const fixture = await createFixture(UNIT_CEILING, secretBytes, undefined, false);
    await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      const admitted = await admitRequest(fixture, guard);
      await expect(
        fixture.store.claimAdmittedGitHubPreflightRequestWithMaterial(
          guard,
          admitted.request.requestId,
        ),
      ).rejects.toMatchObject({ code: "LANDING_CREDENTIAL_AUDIT_FAILED" });
      await expect(
        fixture.store.readClaimedGitHubLandingMaterial(
          guard,
          admitted.request.requestId,
          fixture.landingId,
        ),
      ).rejects.toMatchObject({ code: "GITHUB_GATEWAY_MATERIAL_UNAVAILABLE" });
    });
  });

  it("re-scans digest-consistent secret-shaped landing text before caching", async () => {
    const secretMessage = `ghp_${"a".repeat(20)}\n`;
    const fixture = await createFixture(UNIT_CEILING, BINARY_BYTES, secretMessage, false);
    await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      const admitted = await admitRequest(fixture, guard);
      await expect(
        fixture.store.claimAdmittedGitHubPreflightRequestWithMaterial(
          guard,
          admitted.request.requestId,
        ),
      ).rejects.toMatchObject({ code: "LANDING_CREDENTIAL_AUDIT_FAILED" });
      await expect(
        fixture.store.readClaimedGitHubLandingMaterial(
          guard,
          admitted.request.requestId,
          fixture.landingId,
        ),
      ).rejects.toMatchObject({ code: "GITHUB_GATEWAY_MATERIAL_UNAVAILABLE" });
    });
  });

  const corruptions: readonly {
    readonly name: string;
    readonly apply: (fixture: Fixture) => void;
  }[] = [
    {
      name: "checkpoint",
      apply: (fixture) =>
        mutate(
          fixture.databasePath,
          "UPDATE checkpoint_files SET approved_base64 = ? WHERE run_id = ? AND path = ?",
          Buffer.from("tampered\n").toString("base64"),
          UNIT_RUN_ID,
          PATHS[2],
        ),
    },
    {
      name: "noncanonical baseline",
      apply: (fixture) =>
        mutate(
          fixture.databasePath,
          "UPDATE checkpoint_files SET baseline_base64 = baseline_base64 || ' ' " +
            "WHERE run_id = ? AND path = ?",
          UNIT_RUN_ID,
          PATHS[1],
        ),
    },
    {
      name: "oversized baseline text",
      apply: (fixture) =>
        mutate(
          fixture.databasePath,
          "UPDATE checkpoint_files SET baseline_base64 = CAST(zeroblob(?) AS TEXT) " +
            "WHERE run_id = ? AND path = ?",
          1024 * 1024,
          UNIT_RUN_ID,
          PATHS[1],
        ),
    },
    {
      name: "oversized approved text",
      apply: (fixture) =>
        mutate(
          fixture.databasePath,
          "UPDATE checkpoint_files SET approved_base64 = CAST(zeroblob(?) AS TEXT) " +
            "WHERE run_id = ? AND path = ?",
          1024 * 1024,
          UNIT_RUN_ID,
          PATHS[0],
        ),
    },
    {
      name: "baseline blob",
      apply: (fixture) =>
        mutate(
          fixture.databasePath,
          "UPDATE checkpoint_files SET baseline_base64 = zeroblob(?) " +
            "WHERE run_id = ? AND path = ?",
          1024 * 1024,
          UNIT_RUN_ID,
          PATHS[1],
        ),
    },
    {
      name: "approved blob",
      apply: (fixture) =>
        mutate(
          fixture.databasePath,
          "UPDATE checkpoint_files SET approved_base64 = zeroblob(?) " +
            "WHERE run_id = ? AND path = ?",
          1024 * 1024,
          UNIT_RUN_ID,
          PATHS[0],
        ),
    },
    {
      name: "oversized checkpoint path",
      apply: (fixture) =>
        mutate(
          fixture.databasePath,
          "UPDATE checkpoint_files SET path = ? WHERE run_id = ? AND path = ?",
          `z/${"x".repeat(4 * 1024)}`,
          UNIT_RUN_ID,
          PATHS[0],
        ),
    },
    {
      name: "checkpoint operation blob",
      apply: (fixture) =>
        mutateIgnoringChecks(
          fixture.databasePath,
          "UPDATE checkpoint_files SET op = CAST('modify' AS BLOB) " +
            "WHERE run_id = ? AND path = ?",
          UNIT_RUN_ID,
          PATHS[2],
        ),
    },
    {
      name: "text",
      apply: (fixture) =>
        mutate(
          fixture.databasePath,
          "UPDATE landings SET commit_message = ? WHERE id = ?",
          "Tampered commit message\n",
          fixture.landingId,
        ),
    },
    {
      name: "profile",
      apply: (fixture) =>
        mutate(
          fixture.databasePath,
          "UPDATE landings SET profile_json = replace(profile_json, ?, ?) WHERE id = ?",
          `"owner":"${PROFILE.owner}"`,
          '"owner":"different-owner"',
          fixture.landingId,
        ),
    },
    {
      name: "manifest",
      apply: (fixture) =>
        mutate(
          fixture.databasePath,
          "UPDATE landing_operations SET result_json = replace(result_json, ?, ?) " +
            "WHERE landing_id = ? AND kind = 'candidate.prepare'",
          fixture.candidateManifestSha256,
          "8".repeat(64),
          fixture.landingId,
        ),
    },
    {
      name: "commit payload",
      apply: (fixture) =>
        mutate(
          fixture.databasePath,
          "UPDATE landings SET candidate_commit_payload_sha256 = ? WHERE id = ?",
          "9".repeat(64),
          fixture.landingId,
        ),
    },
    {
      name: "landing digest",
      apply: (fixture) =>
        mutate(
          fixture.databasePath,
          "UPDATE landings SET landing_sha256 = ? WHERE id = ?",
          "a".repeat(64),
          fixture.landingId,
        ),
    },
  ];

  for (const corruption of corruptions) {
    it(`rejects ${corruption.name} corruption while claiming material`, async () => {
      const fixture = await createFixture();
      await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
        const admitted = await admitRequest(fixture, guard);
        corruption.apply(fixture);
        await expect(
          fixture.store.claimAdmittedGitHubPreflightRequestWithMaterial(
            guard,
            admitted.request.requestId,
          ),
        ).rejects.toMatchObject({ code: expect.any(String) });
        await expect(
          fixture.store.readClaimedGitHubLandingMaterial(
            guard,
            admitted.request.requestId,
            fixture.landingId,
          ),
        ).rejects.toMatchObject({ code: "GITHUB_GATEWAY_MATERIAL_UNAVAILABLE" });
      });
    });
  }

  it("preserves the accepted 64-file by 8 MiB checkpoint authority above 32 MiB", () => {
    const bounds = checkpointReadBoundsV1(64, 8 * 1024 * 1024);
    expect(bounds).toEqual({
      maxFiles: 64,
      maxEncodedFileBytes: 4 * Math.ceil((8 * 1024 * 1024) / 3),
      maxSelectedBytes: 64 * (4 * 1024 + 8 + 2 * (4 * Math.ceil((8 * 1024 * 1024) / 3))),
    });
    expect(bounds.maxSelectedBytes).toBeGreaterThan(32 * 1024 * 1024);
  });

  it("rejects a checkpoint row sentinel before mapping an over-bound array", async () => {
    const fixture = await createFixture();
    await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      const admitted = await admitRequest(fixture, guard);
      const database = new Database(fixture.databasePath);
      try {
        const insert = database.prepare(
          "INSERT INTO checkpoint_files " +
            "(run_id, path, op, baseline_base64, approved_base64) VALUES (?, ?, 'create', NULL, ?)",
        );
        for (let index = 0; index < 62; index += 1) {
          expect(
            insert.run(
              UNIT_RUN_ID,
              `zz/extra-${index.toString().padStart(2, "0")}.txt`,
              Buffer.from("x").toString("base64"),
            ).changes,
          ).toBe(1);
        }
      } finally {
        database.close();
      }
      await expect(
        fixture.store.claimAdmittedGitHubPreflightRequestWithMaterial(
          guard,
          admitted.request.requestId,
        ),
      ).rejects.toMatchObject({ code: "DATABASE_ERROR" });
      await expect(
        fixture.store.readClaimedGitHubLandingMaterial(
          guard,
          admitted.request.requestId,
          fixture.landingId,
        ),
      ).rejects.toMatchObject({ code: "GITHUB_GATEWAY_MATERIAL_UNAVAILABLE" });
    });
  });
});
