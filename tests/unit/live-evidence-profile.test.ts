import { describe, expect, it } from "vitest";

import {
  assertLiveEvidenceProfileApproved,
  assertLiveEvidenceProfileMatchesManifest,
  decodeLiveEvidenceProfileV1,
  LIVE_EVIDENCE_AUTHORIZED_EFFECTS,
  liveEvidenceProfileApprovalDigest,
} from "../../packages/core/src/live-evidence-profile.js";

function landingProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    provider: "github",
    owner: "ayyitskevin",
    repository: "icarus-gate1-typescript",
    baseBranch: "main",
    branchNamespace: "icarus/",
    credentialRef: { kind: "environment", name: "ICARUS_GITHUB_TOKEN_GATE1" },
    expectedActor: "ayyitskevin",
    commitIdentity: { name: "Icarus Gate 1", email: "gate1@example.invalid" },
    derivativeEffects: {
      version: 1,
      disposition: "inert-repository",
      evidenceSha256: "b".repeat(64),
    },
    ...overrides,
  };
}

function profileWithoutApproval(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    profileId: "gate1-live-v1",
    benchmarkId: "icarus-gate1",
    benchmarkRevision: "v1",
    offlineManifestDigest: "a".repeat(64),
    provider: {
      kind: "ollama",
      model: "qwen3.8:27b",
      baseUrl: "http://127.0.0.1:11434/",
      adapterVersion: "ollama-adapter-v1",
      inputUsdPerMillionTokens: null,
      outputUsdPerMillionTokens: null,
    },
    budgets: { maxSpendUsd: 0, maxRuntimeSeconds: 3600 },
    authorizedEffects: [...LIVE_EVIDENCE_AUTHORIZED_EFFECTS],
    cases: [
      { caseId: "typescript-library-repair", landingProfile: landingProfile() },
      {
        caseId: "python-cli-repair",
        landingProfile: landingProfile({ repository: "icarus-gate1-python" }),
      },
      {
        caseId: "react-node-repair",
        landingProfile: landingProfile({ repository: "icarus-gate1-react" }),
      },
    ],
    ...overrides,
  };
}

function approvedProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = profileWithoutApproval(overrides);
  const decodedForDigest = decodeLiveEvidenceProfileV1({
    ...base,
    approval: {
      actor: "kevin",
      approvedAt: "2026-08-18T12:00:00.000Z",
      profileDigestSha256: "0".repeat(64),
    },
  });
  return {
    ...base,
    approval: {
      actor: "kevin",
      approvedAt: "2026-08-18T12:00:00.000Z",
      profileDigestSha256: liveEvidenceProfileApprovalDigest(decodedForDigest),
    },
  };
}

const MANIFEST = {
  benchmarkId: "icarus-gate1",
  benchmarkRevision: "v1",
  cases: [
    { id: "typescript-library-repair" },
    { id: "python-cli-repair" },
    { id: "react-node-repair" },
  ],
};

describe("live-evidence profile decode", () => {
  it("accepts a complete profile", () => {
    const decoded = decodeLiveEvidenceProfileV1(approvedProfile());
    expect(decoded.profileId).toBe("gate1-live-v1");
    expect(decoded.cases).toHaveLength(3);
    expect(decoded.cases[0]?.landingProfile.derivativeEffects.disposition).toBe("inert-repository");
  });

  it("refuses an unknown field, because a profile carrying unreviewed keys is not the record that was approved", () => {
    expect(() =>
      decodeLiveEvidenceProfileV1({ ...approvedProfile(), extraField: "surprise" }),
    ).toThrowError(/missing or unknown keys/);
  });

  it("refuses a prototype-polluted record", () => {
    const hostile = Object.create({ injected: true }) as Record<string, unknown>;
    Object.assign(hostile, approvedProfile());
    expect(() => decodeLiveEvidenceProfileV1(hostile)).toThrowError(/non-record prototype/);
  });

  it("requires each case to carry a landing profile, so the per-repository automation assessment cannot be omitted", () => {
    const noAssessment = landingProfile();
    delete noAssessment.derivativeEffects;
    expect(() =>
      decodeLiveEvidenceProfileV1(
        approvedProfile({
          cases: [{ caseId: "typescript-library-repair", landingProfile: noAssessment }],
        }),
      ),
    ).toThrowError();
  });

  it("refuses duplicate case ids", () => {
    expect(() =>
      decodeLiveEvidenceProfileV1(
        approvedProfile({
          cases: [
            { caseId: "typescript-library-repair", landingProfile: landingProfile() },
            { caseId: "typescript-library-repair", landingProfile: landingProfile() },
          ],
        }),
      ),
    ).toThrowError(/duplicate caseId/);
  });

  it("refuses a non-instant approval timestamp so evidence times cannot be ambiguous", () => {
    expect(() =>
      decodeLiveEvidenceProfileV1({
        ...profileWithoutApproval(),
        approval: {
          actor: "kevin",
          approvedAt: "2026-08-18 12:00:00",
          profileDigestSha256: "c".repeat(64),
        },
      }),
    ).toThrowError(/ISO-8601/);
  });
});

describe("authorized effects are a closed set", () => {
  it("refuses an added effect, because authority that grows by appending is not a bound", () => {
    expect(() =>
      decodeLiveEvidenceProfileV1(
        approvedProfile({
          authorizedEffects: [...LIVE_EVIDENCE_AUTHORIZED_EFFECTS, "github.ref.force_update"],
        }),
      ),
    ).toThrowError(/authorizedEffects must be exactly/);
  });

  it("refuses a removed effect, so the reviewed authority cannot be silently narrowed either", () => {
    expect(() =>
      decodeLiveEvidenceProfileV1(
        approvedProfile({ authorizedEffects: LIVE_EVIDENCE_AUTHORIZED_EFFECTS.slice(0, 2) }),
      ),
    ).toThrowError(/authorizedEffects must be exactly/);
  });

  it("names no merge, deployment, force-update, or deletion effect", () => {
    const joined = LIVE_EVIDENCE_AUTHORIZED_EFFECTS.join(" ");
    expect(joined).not.toMatch(/merge|deploy|force|delete|update/);
  });
});

describe("approval binds to exact content", () => {
  it("accepts an untampered approved profile", () => {
    const decoded = decodeLiveEvidenceProfileV1(approvedProfile());
    expect(() => assertLiveEvidenceProfileApproved(decoded)).not.toThrow();
  });

  it("rejects a profile whose pins changed after approval, so approval cannot be inherited by edited content", () => {
    const approved = approvedProfile();
    const tampered = decodeLiveEvidenceProfileV1({
      ...approved,
      budgets: { maxSpendUsd: 500, maxRuntimeSeconds: 3600 },
    });
    expect(() => assertLiveEvidenceProfileApproved(tampered)).toThrowError(
      /does not apply to this profile/,
    );
  });

  it("rejects a swapped repository after approval, the highest-consequence tamper", () => {
    const approved = approvedProfile();
    const tampered = decodeLiveEvidenceProfileV1({
      ...approved,
      cases: [
        {
          caseId: "typescript-library-repair",
          landingProfile: landingProfile({ repository: "production-website" }),
        },
        {
          caseId: "python-cli-repair",
          landingProfile: landingProfile({ repository: "icarus-gate1-python" }),
        },
        {
          caseId: "react-node-repair",
          landingProfile: landingProfile({ repository: "icarus-gate1-react" }),
        },
      ],
    });
    expect(() => assertLiveEvidenceProfileApproved(tampered)).toThrowError(
      /does not apply to this profile/,
    );
  });
});

describe("manifest binding", () => {
  const manifestDigest = "a".repeat(64);

  it("accepts a profile bound to the exact manifest and case set", () => {
    const decoded = decodeLiveEvidenceProfileV1(approvedProfile());
    expect(() =>
      assertLiveEvidenceProfileMatchesManifest(decoded, MANIFEST, manifestDigest),
    ).not.toThrow();
  });

  it("rejects a changed manifest digest, so a profile cannot target work nobody reviewed", () => {
    const decoded = decodeLiveEvidenceProfileV1(approvedProfile());
    expect(() =>
      assertLiveEvidenceProfileMatchesManifest(decoded, MANIFEST, "d".repeat(64)),
    ).toThrowError(/does not match the offline manifest/);
  });

  it("rejects a missing case, because a partial profile cannot produce complete evidence", () => {
    const decoded = decodeLiveEvidenceProfileV1(
      approvedProfile({
        cases: [{ caseId: "typescript-library-repair", landingProfile: landingProfile() }],
      }),
    );
    expect(() =>
      assertLiveEvidenceProfileMatchesManifest(decoded, MANIFEST, manifestDigest),
    ).toThrowError(/exactly the offline manifest case set/);
  });

  it("rejects an unknown case id", () => {
    const decoded = decodeLiveEvidenceProfileV1(
      approvedProfile({
        cases: [
          { caseId: "typescript-library-repair", landingProfile: landingProfile() },
          { caseId: "python-cli-repair", landingProfile: landingProfile() },
          { caseId: "not-in-the-manifest", landingProfile: landingProfile() },
        ],
      }),
    );
    expect(() =>
      assertLiveEvidenceProfileMatchesManifest(decoded, MANIFEST, manifestDigest),
    ).toThrowError(/exactly the offline manifest case set/);
  });

  it("rejects a mismatched benchmark revision", () => {
    const decoded = decodeLiveEvidenceProfileV1(approvedProfile());
    expect(() =>
      assertLiveEvidenceProfileMatchesManifest(
        decoded,
        { ...MANIFEST, benchmarkRevision: "v2" },
        manifestDigest,
      ),
    ).toThrowError(/benchmarkRevision does not match/);
  });
});

describe("budgets", () => {
  it("rejects a negative spend ceiling", () => {
    expect(() =>
      decodeLiveEvidenceProfileV1(
        approvedProfile({ budgets: { maxSpendUsd: -1, maxRuntimeSeconds: 60 } }),
      ),
    ).toThrowError(/maxSpendUsd/);
  });

  it("rejects a non-positive runtime ceiling, so an unbounded live run cannot be authorized", () => {
    expect(() =>
      decodeLiveEvidenceProfileV1(
        approvedProfile({ budgets: { maxSpendUsd: 0, maxRuntimeSeconds: 0 } }),
      ),
    ).toThrowError(/maxRuntimeSeconds/);
  });

  it("permits a zero spend ceiling, because a local provider genuinely costs nothing", () => {
    const decoded = decodeLiveEvidenceProfileV1(
      approvedProfile({ budgets: { maxSpendUsd: 0, maxRuntimeSeconds: 7200 } }),
    );
    expect(decoded.budgets.maxSpendUsd).toBe(0);
  });
});

describe("provider pin", () => {
  it("rejects credentials embedded in the base URL", () => {
    expect(() =>
      decodeLiveEvidenceProfileV1(
        approvedProfile({
          provider: {
            kind: "openai",
            model: "gpt-4o",
            baseUrl: "https://user:secret@api.openai.com/v1/",
            adapterVersion: "openai-adapter-v1",
            inputUsdPerMillionTokens: 2.5,
            outputUsdPerMillionTokens: 10,
          },
        }),
      ),
    ).toThrowError(/must not embed credentials/);
  });

  it("rejects an unknown provider kind", () => {
    expect(() =>
      decodeLiveEvidenceProfileV1(
        approvedProfile({
          provider: {
            kind: "mystery",
            model: "m",
            baseUrl: "https://example.invalid/",
            adapterVersion: "v1",
            inputUsdPerMillionTokens: null,
            outputUsdPerMillionTokens: null,
          },
        }),
      ),
    ).toThrowError(/provider.kind must be/);
  });
});
