import { describe, expect, it } from "vitest";

import {
  decodeLiveEvidenceProfileV1,
  LIVE_EVIDENCE_AUTHORIZED_EFFECTS,
  liveEvidenceProfileApprovalDigest,
} from "../../packages/core/src/live-evidence-profile.js";
import {
  authorizeLiveEvidenceRun,
  LiveEvidenceEffectLedger,
} from "../../packages/core/src/live-evidence-run.js";

const MANIFEST_DIGEST = "a".repeat(64);

const MANIFEST = {
  benchmarkId: "icarus-gate1",
  benchmarkRevision: "v1",
  cases: [
    {
      id: "case-one",
      repository: {
        githubOwner: "ayyitskevin",
        githubRepository: "icarus-gate1-one",
        baseBranch: "main",
      },
    },
    {
      id: "case-two",
      repository: {
        githubOwner: "ayyitskevin",
        githubRepository: "icarus-gate1-two",
        baseBranch: "main",
      },
    },
  ],
};

function landingProfile(repository: string, credentialName: string): Record<string, unknown> {
  return {
    version: 1,
    provider: "github",
    owner: "ayyitskevin",
    repository,
    baseBranch: "main",
    branchNamespace: "icarus/",
    credentialRef: { kind: "environment", name: credentialName },
    expectedActor: "ayyitskevin",
    commitIdentity: { name: "Icarus Gate 1", email: "gate1@example.invalid" },
    derivativeEffects: {
      version: 1,
      disposition: "inert-repository",
      evidenceSha256: "b".repeat(64),
    },
  };
}

function approvedProfile(overrides: Record<string, unknown> = {}) {
  const base = {
    schemaVersion: 1,
    profileId: "gate1-live-v1",
    benchmarkId: "icarus-gate1",
    benchmarkRevision: "v1",
    offlineManifestDigest: MANIFEST_DIGEST,
    provider: {
      kind: "ollama",
      model: "qwen3.8:27b",
      baseUrl: "http://127.0.0.1:11434/",
      adapterVersion: "ollama-adapter-v1",
      inputUsdPerMillionTokens: null,
      outputUsdPerMillionTokens: null,
    },
    budgets: { maxSpendUsd: 10, maxRuntimeSeconds: 3600 },
    authorizedEffects: [...LIVE_EVIDENCE_AUTHORIZED_EFFECTS],
    cases: [
      {
        caseId: "case-one",
        landingProfile: landingProfile("icarus-gate1-one", "ICARUS_GITHUB_TOKEN_GATE1"),
      },
      {
        caseId: "case-two",
        landingProfile: landingProfile("icarus-gate1-two", "ICARUS_GITHUB_TOKEN_GATE1"),
      },
    ],
    ...overrides,
  };
  const seeded = decodeLiveEvidenceProfileV1({
    ...base,
    approval: {
      actor: "kevin",
      approvedAt: "2026-08-18T12:00:00.000Z",
      profileDigestSha256: "0".repeat(64),
    },
  });
  return decodeLiveEvidenceProfileV1({
    ...base,
    approval: {
      actor: "kevin",
      approvedAt: "2026-08-18T12:00:00.000Z",
      profileDigestSha256: liveEvidenceProfileApprovalDigest(seeded),
    },
  });
}

const PRESENT_ENV = { ICARUS_GITHUB_TOKEN_GATE1: "not-read-by-the-gate" };

describe("authorizeLiveEvidenceRun", () => {
  it("authorizes a run whose approval, manifest binding, and credentials all hold", () => {
    const authorization = authorizeLiveEvidenceRun(
      approvedProfile(),
      MANIFEST,
      MANIFEST_DIGEST,
      PRESENT_ENV,
    );
    expect(authorization.caseIds).toEqual(["case-one", "case-two"]);
    expect(authorization.credentialEnvironmentNames).toEqual(["ICARUS_GITHUB_TOKEN_GATE1"]);
    expect(authorization.effects).toEqual([...LIVE_EVIDENCE_AUTHORIZED_EFFECTS]);
  });

  it("refuses before any effect when the credential is absent, so a run cannot die halfway through mutating repositories", () => {
    expect(() =>
      authorizeLiveEvidenceRun(approvedProfile(), MANIFEST, MANIFEST_DIGEST, {}),
    ).toThrowError(/absent or empty; refusing before any remote effect/);
  });

  it("treats an empty credential as absent", () => {
    expect(() =>
      authorizeLiveEvidenceRun(approvedProfile(), MANIFEST, MANIFEST_DIGEST, {
        ICARUS_GITHUB_TOKEN_GATE1: "",
      }),
    ).toThrowError(/absent or empty/);
  });

  it("never surfaces the credential value in its refusal or its result", () => {
    const secret = "ghp_ThisMustNeverAppearAnywhere";
    const authorization = authorizeLiveEvidenceRun(approvedProfile(), MANIFEST, MANIFEST_DIGEST, {
      ICARUS_GITHUB_TOKEN_GATE1: secret,
    });
    expect(JSON.stringify(authorization)).not.toContain(secret);
    const ledger = new LiveEvidenceEffectLedger(authorization);
    expect(JSON.stringify(ledger.summary())).not.toContain(secret);
  });

  it("refuses a profile whose approval no longer binds its content", () => {
    const profile = approvedProfile();
    const tampered = { ...profile, budgets: { maxSpendUsd: 9999, maxRuntimeSeconds: 3600 } };
    expect(() =>
      authorizeLiveEvidenceRun(tampered, MANIFEST, MANIFEST_DIGEST, PRESENT_ENV),
    ).toThrowError(/does not apply to this profile/);
  });

  it("refuses a profile bound to a different manifest", () => {
    expect(() =>
      authorizeLiveEvidenceRun(approvedProfile(), MANIFEST, "e".repeat(64), PRESENT_ENV),
    ).toThrowError(/does not match the offline manifest/);
  });
});

describe("effect ledger", () => {
  function ledger() {
    return new LiveEvidenceEffectLedger(
      authorizeLiveEvidenceRun(approvedProfile(), MANIFEST, MANIFEST_DIGEST, PRESENT_ENV),
    );
  }

  it("records authorized effects per case", () => {
    const entry = ledger();
    entry.recordEffect("case-one", "github.objects.upload");
    entry.recordEffect("case-one", "github.objects.upload");
    const summary = entry.summary();
    expect(summary.cases[0]?.effects["github.objects.upload"]).toBe(2);
    expect(summary.cases[1]?.effects["github.objects.upload"]).toBe(0);
  });

  it("refuses an unauthorized effect", () => {
    const entry = ledger();
    expect(() => entry.recordEffect("case-one", "github.ref.force_update" as never)).toThrowError(
      /is not authorized by profile/,
    );
  });

  it("refuses an effect for an unknown case, so work outside the approved set cannot be laundered through the ledger", () => {
    const entry = ledger();
    expect(() => entry.recordEffect("case-three", "github.objects.upload")).toThrowError(
      /unknown case/,
    );
  });

  it("admits the draft pull request at most once per case, because a lost response is reconciled by reading and never by a second POST", () => {
    const entry = ledger();
    entry.recordEffect("case-one", "github.pull_request.create.draft");
    expect(() => entry.recordEffect("case-one", "github.pull_request.create.draft")).toThrowError(
      /never by a second POST/,
    );
    // the other case is unaffected
    expect(() => entry.recordEffect("case-two", "github.pull_request.create.draft")).not.toThrow();
  });

  it("refuses the call that would exceed the spend ceiling, so the ceiling bounds rather than reports", () => {
    const entry = ledger();
    entry.recordSpend(9.5);
    expect(() => entry.recordSpend(1)).toThrowError(/spend ceiling of 10 USD/);
    expect(entry.summary().spendUsd).toBe(9.5);
  });

  it("refuses the call that would exceed the runtime ceiling", () => {
    const entry = ledger();
    entry.recordElapsed(3599);
    expect(() => entry.recordElapsed(2)).toThrowError(/runtime ceiling of 3600 seconds/);
  });

  it("refuses negative or non-finite spend", () => {
    const entry = ledger();
    expect(() => entry.recordSpend(-1)).toThrowError(/non-negative finite/);
    expect(() => entry.recordSpend(Number.NaN)).toThrowError(/non-negative finite/);
  });

  it("refuses to call a partial run complete, because incomplete evidence must not be reported as passing", () => {
    const entry = ledger();
    for (const effect of LIVE_EVIDENCE_AUTHORIZED_EFFECTS) {
      entry.recordEffect("case-one", effect);
    }
    expect(() => entry.assertComplete()).toThrowError(/case-two did not record required effect/);
  });

  it("accepts a run where every case completed the full authorized chain", () => {
    const entry = ledger();
    for (const caseId of ["case-one", "case-two"]) {
      for (const effect of LIVE_EVIDENCE_AUTHORIZED_EFFECTS) {
        entry.recordEffect(caseId, effect);
      }
    }
    expect(() => entry.assertComplete()).not.toThrow();
    const summary = entry.summary();
    expect(summary.cases).toHaveLength(2);
    expect(summary.budgets.maxSpendUsd).toBe(10);
  });
});
