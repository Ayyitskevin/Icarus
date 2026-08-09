import { describe, expect, it } from "vitest";

import { IcarusError } from "../../packages/core/src/errors.js";
import {
  canonicalLandingJson,
  decodeCanonicalLandingReceiptJsonV1,
  decodeLandingReceiptV1,
  digestLandingRecord,
  type LandingReceiptV1,
} from "../../packages/core/src/landing-records.js";

const sha1 = (seed: string): string => seed.repeat(40).slice(0, 40);
const sha256Value = (seed: string): string => seed.repeat(64).slice(0, 64);

const RECEIPT: LandingReceiptV1 = {
  version: 1,
  landingId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  runId: "3f2504e0-4f89-11d3-9a0c-0305e82c3302",
  projectId: "3f2504e0-4f89-11d3-9a0c-0305e82c3303",
  provider: "github",
  owner: "ayyitskevin",
  repository: "icarus",
  baseRef: "refs/heads/main",
  baseCommitSha1: sha1("a"),
  headRef: "refs/heads/icarus/3f2504e0-4f89-11d3-9a0c-0305e82c3302",
  candidateTreeSha1: sha1("b"),
  candidateCommitSha1: sha1("c"),
  pullRequestNumber: 42,
  reconstructedPullRequestUrl: "https://github.com/ayyitskevin/icarus/pull/42",
  draft: true,
  landingSha256: sha256Value("1"),
  profileSha256: sha256Value("2"),
  planSha256: sha256Value("3"),
  diffSha256: sha256Value("4"),
  checkpointSha256: sha256Value("5"),
  verificationSha256: sha256Value("6"),
  reviewDecisionSha256: sha256Value("7"),
  changedPathsSha256: sha256Value("8"),
  localRefOutcome: "created",
  remoteObjectOutcome: "created_or_exact",
  remoteRefOutcome: "created",
  pullRequestOutcome: "created",
  completedAt: "2026-08-09T12:00:00.000Z",
};

function receiptWith(overrides: Record<string, unknown>): unknown {
  return { ...RECEIPT, ...overrides };
}

describe("landing receipt v1 record", () => {
  it("decodes the exact ADR 0027 receipt shape", () => {
    expect(decodeLandingReceiptV1(RECEIPT)).toEqual(RECEIPT);
  });

  it("round-trips through canonical bytes and binds a stable digest", () => {
    const encoded = canonicalLandingJson(RECEIPT);

    expect(decodeCanonicalLandingReceiptJsonV1(encoded)).toEqual(RECEIPT);
    // The digest must depend on the record's bytes, so the same receipt always
    // produces the same identity and any edit produces a different one.
    expect(digestLandingRecord(RECEIPT)).toBe(digestLandingRecord({ ...RECEIPT }));
    expect(digestLandingRecord(RECEIPT)).not.toBe(
      digestLandingRecord({ ...RECEIPT, pullRequestNumber: 43 }),
    );
  });

  it("rejects an unknown, missing, or reordered member rather than ignoring it", () => {
    expect(() => decodeLandingReceiptV1(receiptWith({ extra: 1 }))).toThrow(IcarusError);
    const { completedAt: _dropped, ...withoutCompletedAt } = RECEIPT;
    expect(() => decodeLandingReceiptV1(withoutCompletedAt)).toThrow(IcarusError);
  });

  it("refuses a pull request URL that does not match its own components", () => {
    // The URL is the one field a reader is likely to click, so a stored value
    // that disagrees with the validated owner, repository, and number is a
    // corrupt record rather than a display preference.
    expect(() =>
      decodeLandingReceiptV1(
        receiptWith({
          reconstructedPullRequestUrl: "https://evil.test/ayyitskevin/icarus/pull/42",
        }),
      ),
    ).toThrow(IcarusError);
    expect(() =>
      decodeLandingReceiptV1(
        receiptWith({ reconstructedPullRequestUrl: "https://github.com/other/icarus/pull/42" }),
      ),
    ).toThrow(IcarusError);
    expect(() =>
      decodeLandingReceiptV1(
        receiptWith({
          reconstructedPullRequestUrl: "https://github.com/ayyitskevin/icarus/pull/9",
        }),
      ),
    ).toThrow(IcarusError);
  });

  it("cannot record a pull request that is not a draft", () => {
    expect(() => decodeLandingReceiptV1(receiptWith({ draft: false }))).toThrow(IcarusError);
  });

  it("cannot claim a remote object was created rather than created-or-exact", () => {
    // Git objects are content-addressed, so an identical object already present
    // upstream is indistinguishable from one this landing uploaded.
    for (const outcome of ["created", "reconciled", "exact"]) {
      expect(() => decodeLandingReceiptV1(receiptWith({ remoteObjectOutcome: outcome }))).toThrow(
        IcarusError,
      );
    }
  });

  it("accepts only the evidence-derived outcome words for each delivery stage", () => {
    for (const field of ["localRefOutcome", "remoteRefOutcome", "pullRequestOutcome"]) {
      expect(decodeLandingReceiptV1(receiptWith({ [field]: "reconciled" }))).toMatchObject({
        [field]: "reconciled",
      });
      for (const invalid of ["failed", "created_or_exact", "CREATED", ""]) {
        expect(() => decodeLandingReceiptV1(receiptWith({ [field]: invalid }))).toThrow(
          IcarusError,
        );
      }
    }
  });

  it("refuses a provider other than github and a version other than 1", () => {
    expect(() => decodeLandingReceiptV1(receiptWith({ provider: "gitlab" }))).toThrow(IcarusError);
    expect(() => decodeLandingReceiptV1(receiptWith({ version: 2 }))).toThrow(IcarusError);
  });

  it("requires fully qualified references and exact object names", () => {
    expect(() => decodeLandingReceiptV1(receiptWith({ baseRef: "main" }))).toThrow(IcarusError);
    expect(() => decodeLandingReceiptV1(receiptWith({ headRef: "refs/tags/v1" }))).toThrow(
      IcarusError,
    );
    expect(() => decodeLandingReceiptV1(receiptWith({ candidateCommitSha1: "abc" }))).toThrow(
      IcarusError,
    );
  });

  it("refuses a non-canonical identity, a zero pull request number, and a bad instant", () => {
    expect(() => decodeLandingReceiptV1(receiptWith({ owner: "Ayyitskevin" }))).toThrow(
      IcarusError,
    );
    expect(() => decodeLandingReceiptV1(receiptWith({ pullRequestNumber: 0 }))).toThrow(
      IcarusError,
    );
    expect(() => decodeLandingReceiptV1(receiptWith({ completedAt: "yesterday" }))).toThrow(
      IcarusError,
    );
  });

  it("carries no path, text, credential, or raw provider content by construction", () => {
    // The receipt is retained and displayed without a redaction pass, so the
    // shape itself must be incapable of holding those classes.
    const serialized = canonicalLandingJson(RECEIPT);

    expect(Object.keys(RECEIPT).toSorted()).toEqual(
      [
        "baseCommitSha1",
        "baseRef",
        "candidateCommitSha1",
        "candidateTreeSha1",
        "changedPathsSha256",
        "checkpointSha256",
        "completedAt",
        "diffSha256",
        "draft",
        "headRef",
        "landingId",
        "landingSha256",
        "localRefOutcome",
        "owner",
        "planSha256",
        "profileSha256",
        "projectId",
        "provider",
        "pullRequestNumber",
        "pullRequestOutcome",
        "reconstructedPullRequestUrl",
        "remoteObjectOutcome",
        "remoteRefOutcome",
        "repository",
        "reviewDecisionSha256",
        "runId",
        "verificationSha256",
        "version",
      ].toSorted(),
    );
    // Every value is an identifier, digest, enumerated word, number, boolean,
    // instant, fully qualified ref, or the reconstructed URL. Nothing in the
    // shape can hold free text, so there is no field a path, message, command,
    // or credential could arrive in.
    const SAFE_VALUE =
      /^(?:[0-9a-f]{40}|[0-9a-f]{64}|[0-9a-f-]{36}|github|ayyitskevin|icarus|created|reconciled|created_or_exact|refs\/heads\/[A-Za-z0-9/._-]+|https:\/\/github\.com\/ayyitskevin\/icarus\/pull\/42|2026-08-09T12:00:00\.000Z)$/;
    for (const [field, value] of Object.entries(RECEIPT)) {
      if (typeof value === "number" || typeof value === "boolean") {
        continue;
      }
      expect(typeof value, field).toBe("string");
      expect(value as string, field).toMatch(SAFE_VALUE);
    }
    expect(serialized).not.toMatch(/\s(?:message|command|stdout|stderr|Bearer)/i);
  });
});
