import { describe, expect, test } from "vitest";

import { sha256 } from "../../packages/core/src/digest.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import {
  decodeLiveEvidenceProfileV1,
  LIVE_EVIDENCE_AUTHORIZED_EFFECTS,
  liveEvidenceProfileApprovalDigest,
} from "../../packages/core/src/live-evidence-profile.js";
import { createProviderConfig } from "../../packages/core/src/provider.js";
import { createGateway } from "../../packages/core/src/providers.js";
import type { ProviderKind } from "../../packages/core/src/types.js";

/**
 * The provider pin must bind the provider HOST, not only its NAME.
 *
 * `decodeProvider` used to re-implement a weaker subset of the URL rule — valid
 * URL, HTTP(S), no embedded credentials — and knew nothing of locality. A
 * profile carrying the exact reviewed manifest digest, correct repository
 * identities and a self-consistent approval could aim the run's model traffic at
 * any host on the internet, with no credential required (the provider credential
 * table maps `ollama` to `null`) and a spend ceiling that can never fire.
 *
 * This file asserts the same relation the credential agreement test asserts, for
 * the URL instead of the secret: **whatever the profile decoder admits, the code
 * that will actually send traffic there accepts.** It measures the real
 * `createProviderConfig` and the real gateway constructors rather than a
 * transcription of their rules, so a consumer that tightens its own origin rule
 * fails this test instead of silently outgrowing the decoder.
 *
 * Constructing a config or a gateway performs no I/O; nothing here contacts a
 * provider.
 */

const MANIFEST_DIGEST = sha256(new TextEncoder().encode("manifest-bytes-under-test"));

function landingProfile() {
  return {
    version: 1,
    provider: "github",
    owner: "ayyitskevin",
    repository: "icarus-gate1-one",
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
  };
}

/** Rates that satisfy `createProviderConfig`, which requires explicit rates for
 * a remote host and accepts anything non-negative for a loopback one. */
const RATES = { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 };

function profileWith(kind: ProviderKind, baseUrl: string) {
  const base = {
    schemaVersion: 1,
    profileId: "gate1-live-v1",
    benchmarkId: "icarus-gate1",
    benchmarkRevision: "v1",
    offlineManifestDigest: MANIFEST_DIGEST,
    provider: { kind, model: "m", baseUrl, adapterVersion: "v1", ...RATES },
    budgets: { maxSpendUsd: 1, maxRuntimeSeconds: 3600 },
    authorizedEffects: [...LIVE_EVIDENCE_AUTHORIZED_EFFECTS],
    cases: [{ caseId: "case-one", landingProfile: landingProfile() }],
  };
  const seeded = decodeLiveEvidenceProfileV1({
    ...base,
    approval: {
      actor: "kevin",
      approvedAt: "2026-08-22T12:00:00.000Z",
      profileDigestSha256: "0".repeat(64),
    },
  });
  return {
    ...base,
    approval: {
      actor: "kevin",
      approvedAt: "2026-08-22T12:00:00.000Z",
      profileDigestSha256: liveEvidenceProfileApprovalDigest(seeded),
    },
  };
}

/**
 * A refusal is an answer. Anything that is not this module's own refusal means
 * the fixture stopped reaching the decoder, which is how instruments on this
 * surface have silently decayed before.
 */
function decoderAdmits(kind: ProviderKind, baseUrl: string): boolean {
  try {
    decodeLiveEvidenceProfileV1(profileWith(kind, baseUrl));
    return true;
  } catch (error) {
    if (error instanceof IcarusError && error.code === "INVALID_LIVE_EVIDENCE_PROFILE") {
      return false;
    }
    throw error;
  }
}

/** The two consumers the pinned URL actually reaches on a live run. */
function consumersAccept(kind: ProviderKind, baseUrl: string): boolean {
  try {
    const config = createProviderConfig({ kind, model: "m", baseUrl, ...RATES });
    createGateway(config, {
      OPENAI_API_KEY: "sk-0123456789abcdef",
      ANTHROPIC_API_KEY: "sk-0123456789abcdef",
    });
    return true;
  } catch {
    return false;
  }
}

const URLS: readonly (readonly [string, string])[] = [
  ["loopback IPv4", "http://127.0.0.1:11434/"],
  ["loopback IPv4, other octet", "http://127.0.0.2:11434/"],
  ["localhost", "http://localhost:11434/"],
  ["loopback IPv6", "http://[::1]:11434/"],
  ["the real OpenAI origin", "https://api.openai.com/v1/"],
  ["the real Anthropic origin", "https://api.anthropic.com/"],
  ["a remote host over HTTPS", "https://exfil.attacker.example/"],
  ["a remote host over plaintext HTTP", "http://198.51.100.9:11434/"],
  ["a remote host carrying query data", "https://exfil.attacker.example/?k=secret"],
  ["a remote host carrying a fragment", "https://exfil.attacker.example/#f"],
  ["credentials embedded in the URL", "https://user:secret@api.openai.com/v1/"],
  ["a non-HTTP scheme", "file:///etc/passwd"],
  ["the OpenAI origin on a surprising port", "https://api.openai.com:8443/v1/"],
  ["a lookalike OpenAI host", "https://api.openai.com.attacker.example/v1/"],
];

const KINDS: readonly ProviderKind[] = ["ollama", "openai", "anthropic"];

describe("the live-evidence provider pin binds the host, not just the name", () => {
  // Without this, every agreement assertion below passes when the decoder admits
  // nothing at all — an over-strict decoder and a broken fixture look identical.
  test("the corpus exercises both verdicts for every provider kind", () => {
    for (const kind of KINDS) {
      const admitted = URLS.filter(([, url]) => decoderAdmits(kind, url));
      const refused = URLS.filter(([, url]) => !decoderAdmits(kind, url));
      expect(admitted.length, `${kind} admits nothing`).toBeGreaterThan(0);
      expect(refused.length, `${kind} refuses nothing`).toBeGreaterThan(0);
    }
  });

  test("every URL the profile decoder admits is one the run's own consumers accept", () => {
    const disagreements: string[] = [];
    for (const kind of KINDS) {
      for (const [label, url] of URLS) {
        if (decoderAdmits(kind, url) && !consumersAccept(kind, url)) {
          disagreements.push(`${kind}: ${label}`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  test("an ollama pin must be loopback, which is stricter than the consumers themselves", () => {
    expect(decoderAdmits("ollama", "http://127.0.0.1:11434/")).toBe(true);
    for (const url of ["https://exfil.attacker.example/", "https://ollama.example.com/"]) {
      expect(decoderAdmits("ollama", url), url).toBe(false);
      // Both consumers WOULD have accepted these. `createProviderConfig` only
      // requires HTTPS and explicit rates for a remote host, and `OllamaGateway`
      // has no origin invariant at all — unlike the OpenAI and Anthropic
      // gateways, which each pin theirs. There is therefore no consumer
      // predicate to mirror for this kind, which is exactly why the bound has to
      // live in the authority record. This is the one rule in the decoder that
      // is deliberately stricter than its consumers rather than equal to them.
      expect(consumersAccept("ollama", url), `${url} downstream`).toBe(true);
    }
    // Plaintext HTTP to a remote host is refused on BOTH sides, so it does not
    // demonstrate the asymmetry above — `createProviderConfig` already refuses
    // it with INSECURE_PROVIDER_URL.
    expect(decoderAdmits("ollama", "http://198.51.100.9:11434/")).toBe(false);
    expect(consumersAccept("ollama", "http://198.51.100.9:11434/")).toBe(false);
  });

  test("a hosted pin must name its own API origin, mirroring the gateway that receives the key", () => {
    expect(decoderAdmits("openai", "https://api.openai.com/v1/")).toBe(true);
    expect(decoderAdmits("anthropic", "https://api.anthropic.com/")).toBe(true);
    expect(decoderAdmits("openai", "https://api.anthropic.com/")).toBe(false);
    expect(decoderAdmits("anthropic", "https://api.openai.com/v1/")).toBe(false);
    expect(decoderAdmits("openai", "https://api.openai.com.attacker.example/v1/")).toBe(false);
  });

  test("query and fragment data are refused, as parseProviderBaseUrl already refused them", () => {
    expect(decoderAdmits("openai", "https://api.openai.com/v1/?k=secret")).toBe(false);
    expect(decoderAdmits("openai", "https://api.openai.com/v1/#f")).toBe(false);
  });

  test("a remote host may not be reached over plaintext HTTP", () => {
    expect(decoderAdmits("openai", "http://api.openai.com/v1/")).toBe(false);
  });

  test("the refusal names the rule and never the URL's query or fragment", () => {
    try {
      decodeLiveEvidenceProfileV1(
        profileWith("openai", "https://api.openai.com/v1/?token=SHOULD-NOT-APPEAR"),
      );
      expect.unreachable("a URL carrying query data must refuse");
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("SHOULD-NOT-APPEAR");
    }
  });
});
