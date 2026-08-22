import { describe, expect, it } from "vitest";

import { sha256 } from "../../packages/core/src/digest.js";

import {
  decodeLiveEvidenceProfileV1,
  LIVE_EVIDENCE_AUTHORIZED_EFFECTS,
  type LiveEvidenceEffect,
  liveEvidenceProfileApprovalDigest,
} from "../../packages/core/src/live-evidence-profile.js";
import {
  authorizeLiveEvidenceRun,
  LiveEvidenceEffectLedger,
} from "../../packages/core/src/live-evidence-run.js";
import { providerCredentialEnvironmentName } from "../../packages/core/src/provider.js";

function manifestBytesOf(manifest: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(manifest));
}

// The manifest pins the provider kind, whether the adapter is paid, and the
// case cost ceiling; the profile must agree with all three. Tests that exercise
// a remote provider therefore build a manifest that pins that provider, because
// a mismatched pair is now refused — which is the point of the binding.
function manifestCase(
  id: string,
  repository: string,
  pin: { providerKind?: string; paid?: boolean; maxCostUsd?: number } = {},
) {
  return {
    id,
    repository: {
      githubOwner: "ayyitskevin",
      githubRepository: repository,
      baseBranch: "main",
    },
    modelAdapter: {
      provider: pin.providerKind ?? "ollama",
      model: "icarus-gate1-fixture-model-v1",
      adapterVersion: "production-ollama-api-chat-v1",
      transport: "deterministic-loopback-http",
      inputUsdPerMillionTokens: 0,
      outputUsdPerMillionTokens: 0,
      expectedRequests: 2,
      paid: pin.paid ?? false,
      credentials: false,
    },
    budgets: { maxCostUsd: pin.maxCostUsd ?? 10 },
  };
}

function manifestFor(pin: { providerKind?: string; paid?: boolean; maxCostUsd?: number } = {}) {
  return {
    benchmarkId: "icarus-gate1",
    benchmarkRevision: "v1",
    cases: [
      manifestCase("case-one", "icarus-gate1-one", pin),
      manifestCase("case-two", "icarus-gate1-two", pin),
    ],
  };
}

const MANIFEST = manifestFor();
const MANIFEST_BYTES = manifestBytesOf(MANIFEST);

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
    offlineManifestDigest: sha256(MANIFEST_BYTES),
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
    const authorization = authorizeLiveEvidenceRun(approvedProfile(), MANIFEST_BYTES, PRESENT_ENV);
    expect(authorization.caseIds).toEqual(["case-one", "case-two"]);
    expect(authorization.credentialEnvironmentNames).toEqual(["ICARUS_GITHUB_TOKEN_GATE1"]);
    expect(authorization.effects).toEqual([...LIVE_EVIDENCE_AUTHORIZED_EFFECTS]);
  });

  it("refuses before any effect when the credential is absent, so a run cannot die halfway through mutating repositories", () => {
    expect(() => authorizeLiveEvidenceRun(approvedProfile(), MANIFEST_BYTES, {})).toThrowError(
      /absent or empty; refusing before any remote effect/,
    );
  });

  it("treats an empty credential as absent", () => {
    expect(() =>
      authorizeLiveEvidenceRun(approvedProfile(), MANIFEST_BYTES, {
        ICARUS_GITHUB_TOKEN_GATE1: "",
      }),
    ).toThrowError(/absent or empty/);
  });

  // Each of these was ADMITTED before the usability predicate landed, while the
  // gateway that would spend the token rejects every one of them. Presence is
  // not usability: an own property holding `undefined` is inside the declared
  // `NodeJS.ProcessEnv` type, and a value pasted with a trailing newline or
  // padded with a space is the ordinary way a real operator produces one.
  it.each([
    ["an own property holding undefined", undefined],
    ["a single space", " "],
    ["only whitespace", "\t\n"],
    ["a non-breaking space", "\u00a0"],
    ["a value below the length floor", "short"],
    ["a value above the length ceiling", "z".repeat(513)],
    ["a usable value padded with a space", " ghp_0123456789abcdef "],
    ["a usable value with a trailing newline", "ghp_0123456789abcdef\n"],
    ["a value carrying an embedded CRLF", "ghp_0123\r\nX-Injected: 1"],
    ["a value carrying an embedded NUL", "ghp_0123\u0000456789"],
    ["a value carrying an embedded control character", "ghp_0123\u0001456789"],
  ])("refuses %s, which the consuming gateway would reject", (_label, value) => {
    expect(() =>
      authorizeLiveEvidenceRun(approvedProfile(), MANIFEST_BYTES, {
        ICARUS_GITHUB_TOKEN_GATE1: value,
      }),
    ).toThrowError(/absent or empty|usable credential/);
  });

  it("refuses a credential that is not a string, because the environment is untyped at runtime", () => {
    for (const value of [12345678, {}, [], new String("ghp_0123456789abcdef")]) {
      expect(() =>
        authorizeLiveEvidenceRun(approvedProfile(), MANIFEST_BYTES, {
          ICARUS_GITHUB_TOKEN_GATE1: value,
        } as unknown as NodeJS.ProcessEnv),
      ).toThrowError(/usable credential/);
    }
  });

  it("never surfaces the credential value in the refusal it emits for an unusable one", () => {
    const secret = "ghp_ThisMustNeverAppearAnywhere ";
    expect(() =>
      authorizeLiveEvidenceRun(approvedProfile(), MANIFEST_BYTES, {
        ICARUS_GITHUB_TOKEN_GATE1: secret,
      }),
    ).toThrowError(/usable credential/);
    try {
      authorizeLiveEvidenceRun(approvedProfile(), MANIFEST_BYTES, {
        ICARUS_GITHUB_TOKEN_GATE1: secret,
      });
      expect.unreachable("an unusable credential must refuse");
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(secret.trim());
    }
  });

  it("never surfaces the credential value in its refusal or its result", () => {
    const secret = "ghp_ThisMustNeverAppearAnywhere";
    const authorization = authorizeLiveEvidenceRun(approvedProfile(), MANIFEST_BYTES, {
      ICARUS_GITHUB_TOKEN_GATE1: secret,
    });
    expect(JSON.stringify(authorization)).not.toContain(secret);
    const ledger = new LiveEvidenceEffectLedger(authorization);
    expect(JSON.stringify(ledger.summary())).not.toContain(secret);
  });

  it("refuses a profile whose approval no longer binds its content", () => {
    const profile = approvedProfile();
    const tampered = { ...profile, budgets: { maxSpendUsd: 9999, maxRuntimeSeconds: 3600 } };
    expect(() => authorizeLiveEvidenceRun(tampered, MANIFEST_BYTES, PRESENT_ENV)).toThrowError(
      /does not apply to this profile/,
    );
  });

  it("refuses a profile bound to a different manifest", () => {
    expect(() =>
      authorizeLiveEvidenceRun(
        approvedProfile(),
        manifestBytesOf({ ...MANIFEST, benchmarkRevision: "never-reviewed" }),
        PRESENT_ENV,
      ),
    ).toThrowError(/does not match the offline manifest/);
  });
});

describe("effect ledger", () => {
  function ledger() {
    return new LiveEvidenceEffectLedger(
      authorizeLiveEvidenceRun(approvedProfile(), MANIFEST_BYTES, PRESENT_ENV),
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
    for (const caseId of ["case-one", "case-two"]) {
      entry.recordEffect(caseId, "github.objects.upload");
      entry.recordEffect(caseId, "github.ref.create.absent_only");
    }
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

describe("provider credential preflight", () => {
  const OPENAI_PROVIDER = {
    kind: "openai",
    model: "gpt-5.6",
    baseUrl: "https://api.openai.com/v1/",
    adapterVersion: "openai-adapter-v1",
    inputUsdPerMillionTokens: 1,
    outputUsdPerMillionTokens: 2,
  };
  // A remote pin only authorizes against a manifest that pins the same
  // provider and declares it paid: the profile and the manifest must agree
  // about who spends money.
  const OPENAI_MANIFEST = manifestFor({ providerKind: "openai", paid: true });
  const OPENAI_MANIFEST_BYTES = manifestBytesOf(OPENAI_MANIFEST);
  const ANTHROPIC_MANIFEST = manifestFor({ providerKind: "anthropic", paid: true });
  const ANTHROPIC_MANIFEST_BYTES = manifestBytesOf(ANTHROPIC_MANIFEST);

  const ANTHROPIC_PROVIDER = {
    kind: "anthropic",
    model: "claude-opus-5",
    baseUrl: "https://api.anthropic.com/",
    adapterVersion: "anthropic-adapter-v1",
    inputUsdPerMillionTokens: 1,
    outputUsdPerMillionTokens: 2,
  };

  it("refuses an OpenAI run whose model key is absent, before any repository is touched", () => {
    // The landing credential is present; only the provider key is missing. Without
    // this check the run is admitted and dies after case one has already uploaded
    // objects and opened a pull request.
    expect(() =>
      authorizeLiveEvidenceRun(
        approvedProfile({
          provider: OPENAI_PROVIDER,
          offlineManifestDigest: sha256(OPENAI_MANIFEST_BYTES),
        }),
        OPENAI_MANIFEST_BYTES,
        PRESENT_ENV,
      ),
    ).toThrowError(/OPENAI_API_KEY, which is absent or empty; refusing before any remote effect/);
  });

  it("refuses an Anthropic run whose model key is absent", () => {
    expect(() =>
      authorizeLiveEvidenceRun(
        approvedProfile({
          provider: ANTHROPIC_PROVIDER,
          offlineManifestDigest: sha256(ANTHROPIC_MANIFEST_BYTES),
        }),
        ANTHROPIC_MANIFEST_BYTES,
        PRESENT_ENV,
      ),
    ).toThrowError(/ANTHROPIC_API_KEY, which is absent or empty/);
  });

  it("treats an empty provider key as absent", () => {
    expect(() =>
      authorizeLiveEvidenceRun(
        approvedProfile({
          provider: OPENAI_PROVIDER,
          offlineManifestDigest: sha256(OPENAI_MANIFEST_BYTES),
        }),
        OPENAI_MANIFEST_BYTES,
        {
          ...PRESENT_ENV,
          OPENAI_API_KEY: "",
        },
      ),
    ).toThrowError(/OPENAI_API_KEY, which is absent or empty/);
  });

  it("requires exactly the variable the gateway will read, resolved from the shared table", () => {
    // Asserted through the resolver rather than a literal: a preflight that
    // hardcoded its own name could check a variable the gateway never reads.
    const expected = providerCredentialEnvironmentName("openai");
    const authorization = authorizeLiveEvidenceRun(
      approvedProfile({
        provider: OPENAI_PROVIDER,
        offlineManifestDigest: sha256(OPENAI_MANIFEST_BYTES),
      }),
      OPENAI_MANIFEST_BYTES,
      { ...PRESENT_ENV, OPENAI_API_KEY: "not-read-by-the-gate" },
    );
    expect(expected).not.toBeNull();
    expect(authorization.credentialEnvironmentNames).toEqual([
      expected,
      "ICARUS_GITHUB_TOKEN_GATE1",
    ]);
  });

  it("requires no model key for a loopback Ollama run", () => {
    expect(providerCredentialEnvironmentName("ollama")).toBeNull();
    const authorization = authorizeLiveEvidenceRun(approvedProfile(), MANIFEST_BYTES, PRESENT_ENV);
    expect(authorization.credentialEnvironmentNames).toEqual(["ICARUS_GITHUB_TOKEN_GATE1"]);
  });

  it("never surfaces the provider credential value", () => {
    const secret = "sk-ThisMustNeverAppearAnywhere";
    const authorization = authorizeLiveEvidenceRun(
      approvedProfile({
        provider: OPENAI_PROVIDER,
        offlineManifestDigest: sha256(OPENAI_MANIFEST_BYTES),
      }),
      OPENAI_MANIFEST_BYTES,
      { ...PRESENT_ENV, OPENAI_API_KEY: secret },
    );
    expect(JSON.stringify(authorization)).not.toContain(secret);
    expect(JSON.stringify(new LiveEvidenceEffectLedger(authorization).summary())).not.toContain(
      secret,
    );
  });
});

describe("authority is immutable at runtime", () => {
  function mutableAuthorization(): {
    profileId: string;
    caseIds: string[];
    effects: LiveEvidenceEffect[];
    budgets: { maxSpendUsd: number; maxRuntimeSeconds: number };
    credentialEnvironmentNames: string[];
  } {
    return {
      profileId: "gate1-live-v1",
      caseIds: ["case-one", "case-two"],
      effects: [...LIVE_EVIDENCE_AUTHORIZED_EFFECTS],
      budgets: { maxSpendUsd: 10, maxRuntimeSeconds: 3600 },
      credentialEnvironmentNames: [],
    };
  }

  it("freezes the authorization, because readonly is a compile-time annotation and callers are not all typed", () => {
    const authorization = authorizeLiveEvidenceRun(approvedProfile(), MANIFEST_BYTES, PRESENT_ENV);
    expect(Object.isFrozen(authorization)).toBe(true);
    expect(Object.isFrozen(authorization.effects)).toBe(true);
    expect(Object.isFrozen(authorization.budgets)).toBe(true);
    expect(Object.isFrozen(authorization.caseIds)).toBe(true);
    expect(() =>
      (authorization.effects as LiveEvidenceEffect[]).push(
        "github.ref.force_update" as LiveEvidenceEffect,
      ),
    ).toThrowError(TypeError);
    expect(() => {
      (authorization.budgets as { maxSpendUsd: number }).maxSpendUsd = Number.MAX_SAFE_INTEGER;
    }).toThrowError(TypeError);
  });

  it("copies before freezing, so authorizing does not freeze the caller's profile", () => {
    const profile = approvedProfile();
    authorizeLiveEvidenceRun(profile, MANIFEST_BYTES, PRESENT_ENV);
    expect(Object.isFrozen(profile.authorizedEffects)).toBe(false);
    expect(() => authorizeLiveEvidenceRun(profile, MANIFEST_BYTES, PRESENT_ENV)).not.toThrow();
  });

  it("refuses a hand-built authorization naming an effect outside the closed set", () => {
    const forged = mutableAuthorization();
    forged.effects.push("github.ref.force_update" as LiveEvidenceEffect);
    expect(() => new LiveEvidenceEffectLedger(forged)).toThrowError(/must carry exactly/);
  });

  it("refuses an authorization whose effects are reordered, because the chain order is the authority", () => {
    const forged = mutableAuthorization();
    forged.effects.reverse();
    expect(() => new LiveEvidenceEffectLedger(forged)).toThrowError(/in that order/);
  });

  it("copies the authorization, so widening it after the ledger exists changes nothing", () => {
    const mutable = mutableAuthorization();
    const entry = new LiveEvidenceEffectLedger(mutable);
    mutable.effects.push("github.ref.force_update" as LiveEvidenceEffect);
    mutable.budgets.maxSpendUsd = Number.MAX_SAFE_INTEGER;
    expect(() =>
      entry.recordEffect("case-one", "github.ref.force_update" as LiveEvidenceEffect),
    ).toThrowError(/is not authorized by profile/);
    expect(() => entry.recordSpend(1_000_000)).toThrowError(/spend ceiling of 10 USD/);
  });

  it("refuses a ceiling that cannot bound anything", () => {
    // `next > NaN` is always false and Infinity is never exceeded: either would
    // turn the budget checks into no-ops that still read as ceilings.
    for (const maxSpendUsd of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const forged = mutableAuthorization();
      forged.budgets.maxSpendUsd = maxSpendUsd;
      expect(() => new LiveEvidenceEffectLedger(forged)).toThrowError(
        /non-negative finite spend ceiling/,
      );
    }
    for (const maxRuntimeSeconds of [Number.NaN, Number.POSITIVE_INFINITY, 0, 1.5]) {
      const forged = mutableAuthorization();
      forged.budgets.maxRuntimeSeconds = maxRuntimeSeconds;
      expect(() => new LiveEvidenceEffectLedger(forged)).toThrowError(
        /positive integer runtime ceiling/,
      );
    }
  });

  it("refuses an authorization with no case or a repeated case", () => {
    const empty = mutableAuthorization();
    empty.caseIds = [];
    expect(() => new LiveEvidenceEffectLedger(empty)).toThrowError(/at least one case/);
    const repeated = mutableAuthorization();
    repeated.caseIds = ["case-one", "case-one"];
    expect(() => new LiveEvidenceEffectLedger(repeated)).toThrowError(/must not repeat a case id/);
  });
});

describe("the ledger binds the landing chain order", () => {
  function ledger(): LiveEvidenceEffectLedger {
    return new LiveEvidenceEffectLedger(
      authorizeLiveEvidenceRun(approvedProfile(), MANIFEST_BYTES, PRESENT_ENV),
    );
  }

  it("refuses a receipt recorded before anything was uploaded, because counting alone cannot prove a landing happened", () => {
    expect(() => ledger().recordEffect("case-one", "github.landing.receipt")).toThrowError(
      /before github.objects.upload; the landing chain admits no skipped stage/,
    );
  });

  it("refuses a skipped stage", () => {
    const entry = ledger();
    entry.recordEffect("case-one", "github.objects.upload");
    expect(() => entry.recordEffect("case-one", "github.pull_request.create.draft")).toThrowError(
      /before github.ref.create.absent_only/,
    );
  });

  it("refuses a stage recorded after a later one, because the chain runs in one direction", () => {
    const entry = ledger();
    entry.recordEffect("case-one", "github.objects.upload");
    entry.recordEffect("case-one", "github.ref.create.absent_only");
    expect(() => entry.recordEffect("case-one", "github.objects.upload")).toThrowError(
      /the landing chain runs in one direction/,
    );
  });

  it("admits repeats of the stage a case is in, because uploads legitimately recur", () => {
    const entry = ledger();
    entry.recordEffect("case-one", "github.objects.upload");
    expect(() => entry.recordEffect("case-one", "github.objects.upload")).not.toThrow();
    expect(entry.summary().cases[0]?.effects["github.objects.upload"]).toBe(2);
  });

  it("tracks each case's position independently", () => {
    const entry = ledger();
    entry.recordEffect("case-one", "github.objects.upload");
    entry.recordEffect("case-one", "github.ref.create.absent_only");
    // case-two is still at the start of its own chain
    expect(() => entry.recordEffect("case-two", "github.ref.create.absent_only")).toThrowError(
      /before github.objects.upload/,
    );
    expect(() => entry.recordEffect("case-two", "github.objects.upload")).not.toThrow();
  });

  it("accepts the full chain in order for every case", () => {
    const entry = ledger();
    for (const caseId of ["case-one", "case-two"]) {
      for (const effect of LIVE_EVIDENCE_AUTHORIZED_EFFECTS) {
        entry.recordEffect(caseId, effect);
      }
    }
    expect(() => entry.assertComplete()).not.toThrow();
  });
});
