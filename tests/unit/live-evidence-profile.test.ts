import { describe, expect, it } from "vitest";

import { sha256 } from "../../packages/core/src/digest.js";
import {
  approveLiveEvidenceProfileV1,
  assertLiveEvidenceProfileApproved,
  assertLiveEvidenceProfileMatchesManifest,
  decodeLiveEvidenceProfileDraftV1,
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
    offlineManifestDigest: MANIFEST_SHA256,
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

function manifestCase(id: string, repository: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    repository: {
      githubOwner: "ayyitskevin",
      githubRepository: repository,
      baseBranch: "main",
    },
    // Mirrors the committed manifest: an unpaid deterministic-loopback adapter
    // and a zero cost ceiling. The profile fixtures pin ollama with null rates
    // and maxSpendUsd 0, so they agree with it.
    modelAdapter: {
      provider: "ollama",
      model: "icarus-gate1-fixture-model-v1",
      adapterVersion: "production-ollama-api-chat-v1",
      transport: "deterministic-loopback-http",
      inputUsdPerMillionTokens: 0,
      outputUsdPerMillionTokens: 0,
      expectedRequests: 2,
      paid: false,
      credentials: false,
    },
    budgets: { maxCostUsd: 0 },
    ...overrides,
  };
}

const MANIFEST = {
  benchmarkId: "icarus-gate1",
  benchmarkRevision: "v1",
  cases: [
    manifestCase("typescript-library-repair", "icarus-gate1-typescript"),
    manifestCase("python-cli-repair", "icarus-gate1-python"),
    manifestCase("react-node-repair", "icarus-gate1-react"),
  ],
};

function manifestBytesOf(manifest: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(manifest));
}

const MANIFEST_BYTES = manifestBytesOf(MANIFEST);
const MANIFEST_SHA256 = sha256(MANIFEST_BYTES);

/**
 * A decoded profile pinned to exactly the bytes it will be handed.
 *
 * Every check below the digest gate is only reachable when the profile pins the
 * manifest it receives, so a test aimed at one of those checks has to bind
 * itself to the manifest it passes. That the gate stops everything else before
 * those checks run is the property this binding exists to have.
 */
function boundTo(manifest: unknown, overrides: Record<string, unknown> = {}) {
  return decodeLiveEvidenceProfileV1(
    approvedProfile({ ...overrides, offlineManifestDigest: sha256(manifestBytesOf(manifest)) }),
  );
}

describe("live-evidence profile decode", () => {
  it("decodes the approvable draft without manufacturing approval", () => {
    const draft = decodeLiveEvidenceProfileDraftV1(profileWithoutApproval());
    expect(draft.profileId).toBe("gate1-live-v1");
    expect("approval" in draft).toBe(false);
  });

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
  it("authors approval only after binding the draft to the reviewed manifest bytes", () => {
    const approved = approveLiveEvidenceProfileV1(
      profileWithoutApproval(),
      MANIFEST_BYTES,
      "kevin",
      "2026-08-23T12:00:00.000Z",
    );

    expect(approved.approval).toEqual({
      actor: "kevin",
      approvedAt: "2026-08-23T12:00:00.000Z",
      profileDigestSha256: liveEvidenceProfileApprovalDigest(approved),
    });
    expect(() => assertLiveEvidenceProfileApproved(approved)).not.toThrow();
  });

  it("refuses approval when the supplied manifest is not the pinned manifest", () => {
    expect(() =>
      approveLiveEvidenceProfileV1(
        profileWithoutApproval(),
        new TextEncoder().encode(JSON.stringify({ ...MANIFEST, benchmarkRevision: "v2" })),
        "kevin",
        "2026-08-23T12:00:00.000Z",
      ),
    ).toThrowError(/does not match the offline manifest/);
  });

  it("refuses an approver identity containing control characters", () => {
    expect(() =>
      approveLiveEvidenceProfileV1(
        profileWithoutApproval(),
        MANIFEST_BYTES,
        `kevin${String.fromCharCode(0)}admin`,
        "2026-08-23T12:00:00.000Z",
      ),
    ).toThrowError();
  });

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
  it("accepts a profile bound to the exact manifest and case set", () => {
    const decoded = decodeLiveEvidenceProfileV1(approvedProfile());
    expect(() => assertLiveEvidenceProfileMatchesManifest(decoded, MANIFEST_BYTES)).not.toThrow();
  });

  it("rejects manifest bytes whose digest is not the one the profile pins, so a profile cannot target work nobody reviewed", () => {
    const decoded = decodeLiveEvidenceProfileV1(approvedProfile());
    expect(() =>
      assertLiveEvidenceProfileMatchesManifest(
        decoded,
        manifestBytesOf({ ...MANIFEST, benchmarkRevision: "never-reviewed" }),
      ),
    ).toThrowError(/does not match the offline manifest/);
  });

  it("rejects a missing case, because a partial profile cannot produce complete evidence", () => {
    const decoded = decodeLiveEvidenceProfileV1(
      approvedProfile({
        cases: [{ caseId: "typescript-library-repair", landingProfile: landingProfile() }],
      }),
    );
    expect(() => assertLiveEvidenceProfileMatchesManifest(decoded, MANIFEST_BYTES)).toThrowError(
      /exactly the offline manifest case set/,
    );
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
    expect(() => assertLiveEvidenceProfileMatchesManifest(decoded, MANIFEST_BYTES)).toThrowError(
      /exactly the offline manifest case set/,
    );
  });

  it("rejects a correctly approved profile that aims a case at an unreviewed repository, the finding that a matching case-id set alone cannot catch", () => {
    // Reproduces the reviewer's construction exactly: exact manifest digest,
    // exact case-id set, self-consistent approval, one swapped repository.
    const swapped = approvedProfile({
      cases: [
        {
          caseId: "typescript-library-repair",
          landingProfile: landingProfile({ repository: "unreviewed-repository" }),
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
    const decoded = decodeLiveEvidenceProfileV1(swapped);
    // The approval genuinely binds this content — the old checks both passed.
    expect(() => assertLiveEvidenceProfileApproved(decoded)).not.toThrow();
    expect(() => assertLiveEvidenceProfileMatchesManifest(decoded, MANIFEST_BYTES)).toThrowError(
      /unreviewed-repository.*but the offline manifest pins/,
    );
  });

  it("rejects a swapped base branch, because the branch is part of the target identity", () => {
    const decoded = decodeLiveEvidenceProfileV1(
      approvedProfile({
        cases: [
          {
            caseId: "typescript-library-repair",
            landingProfile: landingProfile({ baseBranch: "release" }),
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
      }),
    );
    expect(() => assertLiveEvidenceProfileMatchesManifest(decoded, MANIFEST_BYTES)).toThrowError(
      /but the offline manifest pins/,
    );
  });

  it("refuses a manifest case with no repository identity, so a missing pin cannot read as no constraint", () => {
    const unpinned = {
      ...MANIFEST,
      cases: [
        { id: "typescript-library-repair" },
        manifestCase("python-cli-repair", "icarus-gate1-python"),
        manifestCase("react-node-repair", "icarus-gate1-react"),
      ],
    };
    expect(() =>
      assertLiveEvidenceProfileMatchesManifest(boundTo(unpinned), manifestBytesOf(unpinned)),
    ).toThrowError(/must carry the authoritative repository identity/);
  });

  it("refuses a manifest mapping two cases to one repository, so a single landing cannot receive two cases' effects", () => {
    // Each case's own draft-pull-request count would stay at one while the
    // landing behind them received two POSTs, contradicting the durable
    // one_create_pr_post_per_landing index.
    const collidedManifest = {
      ...MANIFEST,
      cases: [
        manifestCase("typescript-library-repair", "icarus-gate1-typescript"),
        manifestCase("python-cli-repair", "icarus-gate1-typescript"),
        manifestCase("react-node-repair", "icarus-gate1-react"),
      ],
    };
    const collided = boundTo(collidedManifest, {
      cases: [
        { caseId: "typescript-library-repair", landingProfile: landingProfile() },
        { caseId: "python-cli-repair", landingProfile: landingProfile() },
        {
          caseId: "react-node-repair",
          landingProfile: landingProfile({ repository: "icarus-gate1-react" }),
        },
      ],
    });
    expect(() =>
      assertLiveEvidenceProfileMatchesManifest(collided, manifestBytesOf(collidedManifest)),
    ).toThrowError(/maps more than one case to repository ayyitskevin\/icarus-gate1-typescript/);
  });

  it("refuses a manifest with a duplicate case id rather than assuming the benchmark validator ran", () => {
    const duplicated = {
      ...MANIFEST,
      cases: [
        manifestCase("typescript-library-repair", "icarus-gate1-typescript"),
        manifestCase("typescript-library-repair", "icarus-gate1-python"),
        manifestCase("react-node-repair", "icarus-gate1-react"),
      ],
    };
    expect(() =>
      assertLiveEvidenceProfileMatchesManifest(boundTo(duplicated), manifestBytesOf(duplicated)),
    ).toThrowError(/duplicate case id typescript-library-repair/);
  });

  it("still accepts the reviewed manifest, whose three cases hold three distinct repositories", () => {
    const decoded = decodeLiveEvidenceProfileV1(approvedProfile());
    expect(() => assertLiveEvidenceProfileMatchesManifest(decoded, MANIFEST_BYTES)).not.toThrow();
  });

  it("refuses the profile that binds everything except the spend: exact digest, exact case ids, correct repositories, valid approval, paid remote model", () => {
    // This is the defect this binding exists to close, reproduced end to end.
    // Before it, every check below passed and the run was authorized.
    const paidRemote = decodeLiveEvidenceProfileV1(
      approvedProfile({
        provider: {
          kind: "anthropic",
          model: "claude-opus-5",
          baseUrl: "https://api.anthropic.com/",
          adapterVersion: "anthropic-adapter-v1",
          inputUsdPerMillionTokens: 15,
          outputUsdPerMillionTokens: 75,
        },
        budgets: { maxSpendUsd: 500, maxRuntimeSeconds: 3600 },
      }),
    );
    // The approval genuinely binds this content — the tamper is not there.
    expect(() => assertLiveEvidenceProfileApproved(paidRemote)).not.toThrow();
    // The manifest binding is what refuses it.
    expect(() => assertLiveEvidenceProfileMatchesManifest(paidRemote, MANIFEST_BYTES)).toThrowError(
      /pins provider anthropic, but offline manifest case .* pins ollama/,
    );
  });

  it("refuses a spend ceiling above the ceiling the manifest case pins", () => {
    const overspending = decodeLiveEvidenceProfileV1(
      approvedProfile({ budgets: { maxSpendUsd: 0.01, maxRuntimeSeconds: 3600 } }),
    );
    expect(() =>
      assertLiveEvidenceProfileMatchesManifest(overspending, MANIFEST_BYTES),
    ).toThrowError(/authorizes up to 0.01 USD, above the 0 USD ceiling/);
  });

  it("refuses a paid token rate when the manifest declares the adapter unpaid", () => {
    // Same provider kind, so only the rate distinguishes it: a manifest that
    // says this case costs nothing cannot authorize a profile that charges.
    const charged = decodeLiveEvidenceProfileV1(
      approvedProfile({
        provider: {
          kind: "ollama",
          model: "qwen3.8:27b",
          baseUrl: "http://127.0.0.1:11434/",
          adapterVersion: "ollama-adapter-v1",
          inputUsdPerMillionTokens: 0,
          outputUsdPerMillionTokens: 0.5,
        },
      }),
    );
    expect(() => assertLiveEvidenceProfileMatchesManifest(charged, MANIFEST_BYTES)).toThrowError(
      /declares an unpaid model adapter, but the profile pins token rates/,
    );
  });

  it("accepts null token rates, because a loopback provider charges nothing", () => {
    const loopback = decodeLiveEvidenceProfileV1(approvedProfile());
    expect(() => assertLiveEvidenceProfileMatchesManifest(loopback, MANIFEST_BYTES)).not.toThrow();
  });

  it("refuses a manifest case carrying no model adapter, so a missing pin cannot read as no constraint", () => {
    const unpinned = {
      ...MANIFEST,
      cases: [
        (() => {
          const { modelAdapter: _dropped, ...rest } = manifestCase(
            "typescript-library-repair",
            "icarus-gate1-typescript",
          );
          return rest;
        })(),
        manifestCase("python-cli-repair", "icarus-gate1-python"),
        manifestCase("react-node-repair", "icarus-gate1-react"),
      ],
    };
    expect(() =>
      assertLiveEvidenceProfileMatchesManifest(boundTo(unpinned), manifestBytesOf(unpinned)),
    ).toThrowError(/manifest.cases\[0\].modelAdapter must be an object/);
  });

  it("refuses a manifest case carrying no cost ceiling", () => {
    const unpinned = {
      ...MANIFEST,
      cases: [
        manifestCase("typescript-library-repair", "icarus-gate1-typescript", { budgets: {} }),
        manifestCase("python-cli-repair", "icarus-gate1-python"),
        manifestCase("react-node-repair", "icarus-gate1-react"),
      ],
    };
    expect(() =>
      assertLiveEvidenceProfileMatchesManifest(boundTo(unpinned), manifestBytesOf(unpinned)),
    ).toThrowError(/budgets.maxCostUsd must be a finite number/);
  });

  it("rejects a mismatched benchmark revision", () => {
    // Bound to the v2 bytes on purpose: the digest gate would otherwise refuse
    // first, and this test exists to prove the revision comparison still fires.
    const other = { ...MANIFEST, benchmarkRevision: "v2" };
    expect(() =>
      assertLiveEvidenceProfileMatchesManifest(boundTo(other), manifestBytesOf(other)),
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

  it("rejects a vulcan pin until Gate 1 evidence deliberately admits it", () => {
    // Vulcan is a real provider kind elsewhere in the runtime, so its refusal
    // here is a policy boundary, not a vocabulary miss: Gate 1 evidence is
    // bound to the three production adapters with pinned versions and
    // Icarus-accountable spend. Hosted vulcan aliases are metered by Vulcan's
    // own ledger, which an Icarus spend ceiling cannot observe. Admission
    // needs its own ADR; see the decodeProvider comment.
    expect(() =>
      decodeLiveEvidenceProfileV1(
        approvedProfile({
          provider: {
            kind: "vulcan",
            model: "code",
            baseUrl: "http://127.0.0.1:8140/v1/",
            adapterVersion: "vulcan-chat-completions-v1",
            inputUsdPerMillionTokens: 0,
            outputUsdPerMillionTokens: 0,
          },
        }),
      ),
    ).toThrowError(/provider.kind must be/);
  });
});

describe("the approval digest signs every pinned field", () => {
  // liveEvidenceProfileApprovalDigest hand-builds its projection. That is
  // complete today, but a field added to LiveEvidenceProfileV1 later would be
  // silently unsigned: the operator would approve a digest that omits it, and
  // nothing else in the suite would notice. These two tests are the tripwire.

  it("covers exactly the record's pinned keys, so a new field cannot be added without deciding whether it is signed", () => {
    const decoded = decodeLiveEvidenceProfileV1(approvedProfile());
    const pinned = Object.keys(decoded)
      .filter((key) => key !== "approval")
      .sort();
    // If this fails, LiveEvidenceProfileV1 grew a field. Add it to
    // liveEvidenceProfileApprovalDigest's projection, add a digest-changes case
    // below, and then update this list — in that order.
    expect(pinned).toEqual([
      "authorizedEffects",
      "benchmarkId",
      "benchmarkRevision",
      "budgets",
      "cases",
      "offlineManifestDigest",
      "profileId",
      "provider",
      "schemaVersion",
    ]);
  });

  it("changes when any pinned field changes", () => {
    const baseline = liveEvidenceProfileApprovalDigest(
      decodeLiveEvidenceProfileV1(approvedProfile()),
    );
    const variants: Record<string, Record<string, unknown>> = {
      profileId: { profileId: "gate1-live-v2" },
      benchmarkId: { benchmarkId: "icarus-gate2" },
      benchmarkRevision: { benchmarkRevision: "v2" },
      offlineManifestDigest: { offlineManifestDigest: "c".repeat(64) },
      provider: {
        provider: {
          kind: "ollama",
          model: "a-different-model",
          baseUrl: "http://127.0.0.1:11434/",
          adapterVersion: "ollama-adapter-v1",
          inputUsdPerMillionTokens: null,
          outputUsdPerMillionTokens: null,
        },
      },
      budgets: { budgets: { maxSpendUsd: 0, maxRuntimeSeconds: 7200 } },
      cases: {
        cases: [
          {
            caseId: "typescript-library-repair",
            landingProfile: landingProfile({ expectedActor: "someone-else" }),
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
      },
    };
    for (const [field, override] of Object.entries(variants)) {
      const mutated = liveEvidenceProfileApprovalDigest(
        decodeLiveEvidenceProfileV1(approvedProfile(override)),
      );
      expect(mutated, `${field} is not signed by the approval digest`).not.toBe(baseline);
    }
  });
});
