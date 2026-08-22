import { describe, expect, test } from "vitest";

import { IcarusError } from "../../packages/core/src/errors.js";
import {
  decodeLiveEvidenceProfileV1,
  LIVE_EVIDENCE_AUTHORIZED_EFFECTS,
  liveEvidenceProfileApprovalDigest,
} from "../../packages/core/src/live-evidence-profile.js";
import { authorizeLiveEvidenceRun } from "../../packages/core/src/live-evidence-run.js";
import { providerCredentialEnvironmentName } from "../../packages/core/src/provider.js";
import { createGateway } from "../../packages/core/src/providers.js";
import type { ProviderConfig, ProviderKind } from "../../packages/core/src/types.js";
import { GithubGateway } from "../../packages/github-gateway/src/gateway.js";

/**
 * The live-evidence preflight exists to refuse early what a consumer would
 * refuse late. That promise is only worth something if the predicate the
 * preflight applies is at least as strong as the predicate applied by whatever
 * will actually spend the credential.
 *
 * This file asserts that relation against the REAL consumers rather than
 * against a transcription of their rules. `GithubGateway` and `createGateway`
 * are the same constructors the live path uses, so the day any of them tightens
 * its own credential rule, this test fails and the preflight is updated with
 * it. A copied regex would have gone quietly out of date instead.
 *
 * Why this file exists at all: the preflight originally checked own-property
 * presence and `!== ""`, which admitted eleven of sixteen environment shapes
 * that every consumer rejects — whitespace-only values, values below the
 * eight-character floor, values carrying an embedded NUL or CRLF, and
 * non-strings. Three separate reviews had already found three defects of the
 * same shape on this surface: the field that is easy to compare gets bound, and
 * the field that decides the blast radius does not. An executable agreement
 * check is what turns that from a thing reviewers notice one at a time into an
 * invariant.
 *
 * Constructing a gateway performs no I/O: every predicate under test is a
 * constructor invariant, so nothing here contacts a provider or GitHub.
 */

const MANIFEST_DIGEST = "a".repeat(64);
const GITHUB_CREDENTIAL = "ICARUS_GITHUB_TOKEN_GATE1";

function manifestCase(id: string, repository: string) {
  return {
    id,
    repository: {
      githubOwner: "ayyitskevin",
      githubRepository: repository,
      baseBranch: "main",
    },
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
  };
}

const MANIFEST = {
  benchmarkId: "icarus-gate1",
  benchmarkRevision: "v1",
  cases: [manifestCase("case-one", "icarus-gate1-one")],
};

function landingProfile(repository: string): Record<string, unknown> {
  return {
    version: 1,
    provider: "github",
    owner: "ayyitskevin",
    repository,
    baseBranch: "main",
    branchNamespace: "icarus/",
    credentialRef: { kind: "environment", name: GITHUB_CREDENTIAL },
    expectedActor: "ayyitskevin",
    commitIdentity: { name: "Icarus Gate 1", email: "gate1@example.invalid" },
    derivativeEffects: {
      version: 1,
      disposition: "inert-repository",
      evidenceSha256: "b".repeat(64),
    },
  };
}

// Pinned to loopback Ollama, which reads no credential of its own, so the only
// credential the preflight examines is the landing token. The preflight applies
// one predicate to every name it collects, so exercising it through the landing
// token measures the same rule the provider key would meet.
function approvedProfile() {
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
    budgets: { maxSpendUsd: 0, maxRuntimeSeconds: 3600 },
    authorizedEffects: [...LIVE_EVIDENCE_AUTHORIZED_EFFECTS],
    cases: [{ caseId: "case-one", landingProfile: landingProfile("icarus-gate1-one") }],
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

const PROFILE = approvedProfile();
const USABLE = `ghp_${"y".repeat(36)}`;

/**
 * Values straddling every boundary a consumer enforces: the length floor and
 * ceiling from both sides, and each class of byte the consumers reject.
 */
const CORPUS: readonly (readonly [string, string])[] = [
  ["a plausible token", USABLE],
  ["exactly the eight-character floor", "12345678"],
  ["exactly the 512-character ceiling", "z".repeat(512)],
  ["one character below the floor", "1234567"],
  ["one character above the ceiling", "z".repeat(513)],
  ["a single character", "x"],
  ["empty", ""],
  ["one space", " "],
  ["a tab and a newline", "\t\n"],
  ["a non-breaking space", "\u00a0"],
  ["a usable token with a trailing newline", `${USABLE}\n`],
  ["a usable token with an embedded CRLF", `${USABLE}\r\nX-Injected: 1`],
  ["a usable token with an embedded NUL", `${USABLE}\u0000tail`],
  ["a usable token with an embedded C0 control", `${USABLE}\u0001tail`],
  ["a usable token with an embedded DEL", `${USABLE}\u007ftail`],
];

/**
 * A refusal is an answer. Anything else means the fixture stopped reaching the
 * preflight, which is exactly how the previous probe on this surface decayed
 * into measuring nothing: its `catch` returned false for a malformed fixture
 * and for a genuine refusal alike, so two of its three results silently became
 * vacuous while the third kept working and made the output look plausible.
 */
function preflightAdmits(value: string): boolean {
  try {
    authorizeLiveEvidenceRun(PROFILE, MANIFEST, MANIFEST_DIGEST, {
      [GITHUB_CREDENTIAL]: value,
    });
    return true;
  } catch (error) {
    if (error instanceof IcarusError && error.code === "LIVE_EVIDENCE_REFUSED") {
      return false;
    }
    throw error;
  }
}

function constructs(build: () => unknown): boolean {
  try {
    build();
    return true;
  } catch {
    return false;
  }
}

function providerConfig(kind: ProviderKind, baseUrl: string): ProviderConfig {
  return {
    kind,
    model: "agreement-fixture-model",
    baseUrl,
    inputUsdPerMillionTokens: 1,
    outputUsdPerMillionTokens: 1,
    capabilities: {
      contextSize: null,
      toolSupport: false,
      visionSupport: false,
      structuredOutputSupport: true,
      streamingSupport: false,
      costClass: "configured_remote",
      latencyClass: "remote",
      privacyClass: "remote_api",
      reasoningQuality: "unknown",
      locality: "remote",
    },
  };
}

function modelGatewayAccepts(
  kind: "openai" | "anthropic",
  baseUrl: string,
  value: string,
): boolean {
  const name = providerCredentialEnvironmentName(kind);
  if (name === null) {
    throw new Error(`${kind} is expected to read a credential`);
  }
  return constructs(() => createGateway(providerConfig(kind, baseUrl), { [name]: value }));
}

function admittedButRejectedBy(accepts: (value: string) => boolean): readonly string[] {
  return CORPUS.filter(([, value]) => preflightAdmits(value) && !accepts(value)).map(
    ([label]) => label,
  );
}

describe("the live-evidence credential preflight agrees with the consumers it preflights", () => {
  // Without this, every assertion below passes when the preflight admits
  // nothing at all — an empty corpus and a broken fixture fail identically, and
  // neither announces itself.
  test("the corpus exercises both verdicts, so an agreement assertion cannot pass vacuously", () => {
    const admitted = CORPUS.filter(([, value]) => preflightAdmits(value)).map(([label]) => label);
    const refused = CORPUS.filter(([, value]) => !preflightAdmits(value)).map(([label]) => label);

    expect(admitted).toContain("a plausible token");
    expect(admitted).toContain("exactly the eight-character floor");
    expect(refused).toContain("empty");
    expect(refused).toContain("one space");
    expect(admitted.length).toBeGreaterThan(1);
    expect(refused.length).toBeGreaterThan(1);
  });

  test("every credential it admits is one the GitHub landing gateway will accept", () => {
    expect(
      admittedButRejectedBy((value) =>
        constructs(() => new GithubGateway({ token: value, baseUrl: "https://api.github.com" })),
      ),
    ).toEqual([]);
  });

  test("every credential it admits is one the OpenAI gateway will accept", () => {
    expect(
      admittedButRejectedBy((value) =>
        modelGatewayAccepts("openai", "https://api.openai.com", value),
      ),
    ).toEqual([]);
  });

  test("every credential it admits is one the Anthropic gateway will accept", () => {
    expect(
      admittedButRejectedBy((value) =>
        modelGatewayAccepts("anthropic", "https://api.anthropic.com", value),
      ),
    ).toEqual([]);
  });

  test("a value that is not a string is refused, because the environment is untyped at runtime", () => {
    for (const value of [12345678, {}, [], new String(USABLE)]) {
      expect(() =>
        authorizeLiveEvidenceRun(PROFILE, MANIFEST, MANIFEST_DIGEST, {
          [GITHUB_CREDENTIAL]: value,
        } as unknown as NodeJS.ProcessEnv),
      ).toThrow(IcarusError);
    }
  });
});
