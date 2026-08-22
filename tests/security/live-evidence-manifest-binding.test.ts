import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { sha256 } from "../../packages/core/src/digest.js";
import {
  assertLiveEvidenceProfileMatchesManifest,
  decodeLiveEvidenceProfileV1,
  LIVE_EVIDENCE_AUTHORIZED_EFFECTS,
  liveEvidenceProfileApprovalDigest,
} from "../../packages/core/src/live-evidence-profile.js";

/**
 * The manifest binding must bind the manifest.
 *
 * `assertLiveEvidenceProfileMatchesManifest` used to take the parsed manifest
 * and its digest as two independent parameters and compare the profile's pin
 * against the digest STRING. Nothing linked the string to the object, so an
 * edited manifest handed over with the reviewed manifest's digest was admitted,
 * and every binding below it — repository identity, provider kind,
 * unpaid-means-unpaid, the spend ceiling — was then evaluated against the edited
 * one. ADR 0045 property 1 says "changing the manifest invalidates the profile";
 * that was false.
 *
 * These tests run against the REAL committed manifest, because the defect was
 * about the relationship between reviewed bytes and acted-upon values, and a
 * synthetic fixture can be made to agree with itself.
 *
 * No I/O beyond reading the committed fixture; no network, no credential.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST_PATH = path.join(REPO_ROOT, "fixtures/evals/gate1/manifest.v1.json");

/** The exact reviewed bytes, and the digest an operator would approve. */
const REVIEWED_BYTES = new Uint8Array(readFileSync(MANIFEST_PATH));
const REVIEWED_DIGEST = sha256(REVIEWED_BYTES);
const REVIEWED = JSON.parse(new TextDecoder().decode(REVIEWED_BYTES)) as {
  benchmarkId: string;
  benchmarkRevision: string;
  cases: {
    id: string;
    repository: { githubOwner: string; githubRepository: string; baseBranch: string };
    modelAdapter: Record<string, unknown>;
    budgets: Record<string, unknown>;
  }[];
};

function encode(manifest: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(manifest));
}

function landingProfile(owner: string, repository: string, baseBranch: string) {
  return {
    version: 1,
    provider: "github",
    owner,
    repository,
    baseBranch,
    branchNamespace: "icarus/",
    credentialRef: { kind: "environment", name: "ICARUS_GITHUB_TOKEN_GATE1" },
    expectedActor: "ayyitskevin",
    commitIdentity: { name: "Icarus Gate 1", email: "gate1@example.invalid" },
    derivativeEffects: {
      version: 1,
      disposition: "inert-repository",
      evidenceSha256: "b".repeat(64),
    },
  };
}

/**
 * A profile an operator would legitimately approve against the reviewed
 * manifest: loopback Ollama, nothing charged, every case aimed at the
 * repository the manifest pins.
 */
function approvedAgainstReviewed(overrides: Record<string, unknown> = {}) {
  const base = {
    schemaVersion: 1,
    profileId: "gate1-live-v1",
    benchmarkId: REVIEWED.benchmarkId,
    benchmarkRevision: REVIEWED.benchmarkRevision,
    offlineManifestDigest: REVIEWED_DIGEST,
    provider: {
      kind: "ollama",
      model: "qwen3.8:27b",
      baseUrl: "http://127.0.0.1:11434/",
      adapterVersion: "production-ollama-api-chat-v1",
      inputUsdPerMillionTokens: null,
      outputUsdPerMillionTokens: null,
    },
    budgets: { maxSpendUsd: 0, maxRuntimeSeconds: 3600 },
    authorizedEffects: [...LIVE_EVIDENCE_AUTHORIZED_EFFECTS],
    cases: REVIEWED.cases.map((entry) => ({
      caseId: entry.id,
      landingProfile: landingProfile(
        entry.repository.githubOwner,
        entry.repository.githubRepository,
        entry.repository.baseBranch,
      ),
    })),
    ...overrides,
  };
  const seeded = decodeLiveEvidenceProfileV1({
    ...base,
    approval: {
      actor: "kevin",
      approvedAt: "2026-08-22T12:00:00.000Z",
      profileDigestSha256: "0".repeat(64),
    },
  });
  return decodeLiveEvidenceProfileV1({
    ...base,
    approval: {
      actor: "kevin",
      approvedAt: "2026-08-22T12:00:00.000Z",
      profileDigestSha256: liveEvidenceProfileApprovalDigest(seeded),
    },
  });
}

/**
 * The edit that made the original defect worth a blocker, applied to the RAW
 * TEXT rather than by re-serializing the parsed object.
 *
 * Re-serializing would produce bytes that differ from the committed
 * pretty-printed fixture by formatting alone, so the digest would change before
 * any semantic edit was considered and this file could not honestly claim the
 * dangerous change is what is refused. These replacements preserve every byte of
 * whitespace and key order; only the values that decide where effects land and
 * what may be spent move.
 */
function redirectedAndPaidBytes(): Uint8Array {
  const text = new TextDecoder().decode(REVIEWED_BYTES);
  const edited = text
    .replaceAll('"githubOwner": "icarus-gate1-benchmark"', '"githubOwner": "attacker-org"')
    .replaceAll('"provider": "ollama"', '"provider": "anthropic"')
    .replaceAll('"paid": false', '"paid": true')
    .replaceAll('"maxCostUsd": 0', '"maxCostUsd": 500');
  if (edited === text) {
    throw new Error("the manifest fixture no longer contains the values this test edits");
  }
  return new TextEncoder().encode(edited);
}

describe("the live-evidence manifest binding binds the manifest", () => {
  test("the committed manifest still admits a correctly approved profile", () => {
    expect(() =>
      assertLiveEvidenceProfileMatchesManifest(approvedAgainstReviewed(), REVIEWED_BYTES),
    ).not.toThrow();
  });

  // The control that proves the money/model binding is reachable at all. Without
  // it, the test below could pass because nothing runs rather than because the
  // digest gate refused.
  test("a paid remote profile is refused against the reviewed manifest's own bytes", () => {
    const paidRemote = approvedAgainstReviewed({
      provider: {
        kind: "anthropic",
        model: "claude-opus-5",
        baseUrl: "https://api.anthropic.com/",
        adapterVersion: "anthropic-adapter-v1",
        inputUsdPerMillionTokens: 15,
        outputUsdPerMillionTokens: 75,
      },
      budgets: { maxSpendUsd: 500, maxRuntimeSeconds: 3600 },
    });
    expect(() => assertLiveEvidenceProfileMatchesManifest(paidRemote, REVIEWED_BYTES)).toThrowError(
      /offline manifest case .* pins ollama/,
    );
  });

  test("an edited manifest cannot borrow the reviewed manifest's digest", () => {
    const editedBytes = redirectedAndPaidBytes();
    const edited = JSON.parse(new TextDecoder().decode(editedBytes)) as typeof REVIEWED;
    // Exactly the profile the operator approved: it pins the REVIEWED digest.
    // Previously this call received the edited object plus that digest string
    // and admitted the run, so every case below aimed real effects at
    // `attacker/*` while spending against a $500 ceiling.
    const profile = approvedAgainstReviewed({
      provider: {
        kind: "anthropic",
        model: "claude-opus-5",
        baseUrl: "https://api.anthropic.com/",
        adapterVersion: "anthropic-adapter-v1",
        inputUsdPerMillionTokens: 15,
        outputUsdPerMillionTokens: 75,
      },
      budgets: { maxSpendUsd: 500, maxRuntimeSeconds: 3600 },
      cases: edited.cases.map((entry) => ({
        caseId: entry.id,
        landingProfile: landingProfile(
          entry.repository.githubOwner,
          entry.repository.githubRepository,
          entry.repository.baseBranch,
        ),
      })),
    });

    // Same length, same formatting, same key order — only the values that decide
    // which repositories receive effects and what may be spent are different.
    expect(editedBytes.length).toBeGreaterThan(0);
    expect(sha256(editedBytes)).not.toBe(REVIEWED_DIGEST);
    expect(() => assertLiveEvidenceProfileMatchesManifest(profile, editedBytes)).toThrowError(
      /does not match the offline manifest/,
    );
  });

  test("a profile approved against edited bytes cannot be replayed against the reviewed ones", () => {
    const profile = approvedAgainstReviewed({
      offlineManifestDigest: sha256(redirectedAndPaidBytes()),
    });
    expect(() => assertLiveEvidenceProfileMatchesManifest(profile, REVIEWED_BYTES)).toThrowError(
      /does not match the offline manifest/,
    );
  });

  // States what this binding does NOT do, so nobody mistakes it for a semantic
  // one: it authenticates bytes. A reformat that changes no meaning still fails,
  // which is why the edited fixture above is a byte-minimal text substitution
  // rather than a re-serialization — otherwise that test would pass on
  // formatting and prove nothing about the dangerous edit inside it.
  test("a semantically identical reformat is also refused, because the binding is over bytes", () => {
    const reformatted = encode(REVIEWED);
    expect(new TextDecoder().decode(reformatted)).not.toBe(
      new TextDecoder().decode(REVIEWED_BYTES),
    );
    expect(JSON.parse(new TextDecoder().decode(reformatted))).toEqual(REVIEWED);
    expect(() =>
      assertLiveEvidenceProfileMatchesManifest(approvedAgainstReviewed(), reformatted),
    ).toThrowError(/does not match the offline manifest/);
  });

  test("a single flipped byte invalidates the binding", () => {
    const mutated = Uint8Array.from(REVIEWED_BYTES);
    const last = mutated.length - 1;
    mutated[last] = (REVIEWED_BYTES[last] ?? 0) ^ 0x01;
    expect(sha256(mutated)).not.toBe(REVIEWED_DIGEST);
    expect(() =>
      assertLiveEvidenceProfileMatchesManifest(approvedAgainstReviewed(), mutated),
    ).toThrowError(/does not match the offline manifest/);
  });

  test("a parsed object is refused where bytes are required, so the old call shape cannot come back", () => {
    expect(() =>
      assertLiveEvidenceProfileMatchesManifest(
        approvedAgainstReviewed(),
        REVIEWED as unknown as Uint8Array,
      ),
    ).toThrowError(/exact reviewed bytes/);
  });

  test("bytes that hash correctly but are not JSON are refused after the digest check", () => {
    const notJson = new TextEncoder().encode("this is not a manifest");
    const profile = approvedAgainstReviewed({ offlineManifestDigest: sha256(notJson) });
    expect(() => assertLiveEvidenceProfileMatchesManifest(profile, notJson)).toThrowError(
      /not strict JSON/,
    );
  });

  test("bytes that hash correctly but are not valid UTF-8 are refused rather than repaired", () => {
    // A lone continuation byte. Replacing it with U+FFFD would validate
    // something other than what was hashed.
    const invalidUtf8 = new Uint8Array([0x7b, 0xff, 0x7d]);
    const profile = approvedAgainstReviewed({ offlineManifestDigest: sha256(invalidUtf8) });
    expect(() => assertLiveEvidenceProfileMatchesManifest(profile, invalidUtf8)).toThrowError(
      /not valid UTF-8/,
    );
  });

  test("a JSON scalar is refused where the manifest must be an object", () => {
    const scalar = new TextEncoder().encode("42");
    const profile = approvedAgainstReviewed({ offlineManifestDigest: sha256(scalar) });
    expect(() => assertLiveEvidenceProfileMatchesManifest(profile, scalar)).toThrowError(
      /must decode to an object/,
    );
  });
});
