import { createHash } from "node:crypto";

import {
  type IcarusRuntime,
  type LandingReceiptV1,
  type LandingStatusV1,
  LANDING_DERIVATIVE_GITHUB_EVENTS,
  LANDING_DERIVATIVE_MAY_TRIGGER,
  LANDING_DIRECT_ICARUS_EFFECTS,
  LANDING_EFFECT_WARNING,
  presentLandingApprovalV1,
  presentLandingReceiptV1,
  presentLandingStatusV1,
  type RunLandingPresentation,
} from "../../packages/core/src/index.js";
import { describe, expect, test, vi } from "vitest";

import { type CliMainOptions, runCliMain } from "../../packages/cli/src/main.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const LANDING_ID = "22222222-2222-4222-8222-222222222222";
const OPERATION_ID = "44444444-4444-4444-8444-444444444444";
const LANDING_SHA256 = "a".repeat(64);
const CANDIDATE_COMMIT_SHA1 = "b".repeat(40);
const PLAN_SHA256 = "c".repeat(64);
const DIFF_SHA256 = "d".repeat(64);
const CHECKPOINT_SHA256 = "e".repeat(64);
const DISCLOSURE_EVIDENCE_SHA256 = "f".repeat(64);
const TITLE = "Ship the bounded landing";
const BODY_PREFIX = "Operator-approved release notes.";
const NOW = "2026-08-02T12:00:00.000Z";
const TOKEN_ENV = "ICARUS_GITHUB_TOKEN_PRESENTATION_TEST";
const TOKEN_SENTINEL = "ghp_PRESENTATION_SENTINEL_MUST_NOT_LEAK";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function pullRequestBody(): string {
  return [
    BODY_PREFIX,
    "",
    "Icarus landing evidence v1",
    `run-id: ${RUN_ID}`,
    `candidate-commit-sha1: ${CANDIDATE_COMMIT_SHA1}`,
    `plan-sha256: ${PLAN_SHA256}`,
    `diff-sha256: ${DIFF_SHA256}`,
    `checkpoint-sha256: ${CHECKPOINT_SHA256}`,
    "object-format: sha1",
    "",
    `<!-- icarus-landing:v1:${LANDING_ID}:${LANDING_SHA256} -->`,
    "",
  ].join("\n");
}

function statusFixture(): LandingStatusV1 {
  const body = pullRequestBody();
  return {
    landing: {
      id: LANDING_ID,
      runId: RUN_ID,
      projectId: "55555555-5555-4555-8555-555555555555",
      policyVersion: 1,
      state: "awaiting_approval",
      resumeState: null,
      profile: {
        version: 1,
        provider: "github",
        owner: "icarus-owner",
        repository: "icarus-repository",
        baseBranch: "main",
        branchNamespace: "icarus/",
        credentialRef: {
          kind: "environment",
          name: TOKEN_ENV,
        },
        expectedActor: "operator",
        commitIdentity: {
          name: "Icarus",
          email: "icarus@example.invalid",
        },
        derivativeEffects: {
          version: 1,
          disposition: "operator-approved",
          evidenceSha256: DISCLOSURE_EVIDENCE_SHA256,
        },
      },
      profileSha256: "0".repeat(64),
      baseCommitSha1: "1".repeat(40),
      baseTreeSha1: "2".repeat(40),
      planSha256: PLAN_SHA256,
      diffSha256: DIFF_SHA256,
      checkpointSha256: CHECKPOINT_SHA256,
      verificationSha256: "3".repeat(64),
      reviewDecisionId: "66666666-6666-4666-8666-666666666666",
      reviewDecisionSha256: "4".repeat(64),
      changedPaths: ["src/bounded.ts"],
      changedPathsSha256: "5".repeat(64),
      credentialAuditSha256: "6".repeat(64),
      headRef: `refs/heads/icarus/${RUN_ID}`,
      commitMessage: "Ship bounded landing",
      commitMessageSha256: sha256("Ship bounded landing"),
      commitEpochSeconds: 1_786_000_000,
      commitIso8601: "2026-08-02T12:00:00Z",
      pullRequestTitle: TITLE,
      pullRequestTitleSha256: sha256(TITLE),
      pullRequestBodyPrefix: BODY_PREFIX,
      pullRequestBodyPrefixSha256: sha256(BODY_PREFIX),
      pullRequestBodySha256: sha256(body),
      candidateTreeSha1: "7".repeat(40),
      candidateCommitSha1: CANDIDATE_COMMIT_SHA1,
      candidateCommitPayloadSha256: "8".repeat(64),
      landingSha256: LANDING_SHA256,
      errorCode: null,
      attemptCount: 1,
      version: 2,
      createdAt: NOW,
      updatedAt: NOW,
    },
    decision: null,
    receipt: null,
    attempts: [
      {
        landingId: LANDING_ID,
        ordinal: 1,
        status: "completed",
        startedAt: NOW,
        finishedAt: NOW,
        errorCode: null,
        testEvidence: "attempt-evidence-preserved",
      },
    ],
    operations: [
      {
        id: OPERATION_ID,
        landingId: LANDING_ID,
        testEvidence: "operation-evidence-preserved",
      },
    ],
    events: [
      {
        sequence: 9,
        landingId: LANDING_ID,
        testEvidence: "event-evidence-preserved",
      },
    ],
    revision: 17,
  } as unknown as LandingStatusV1;
}

function receiptFixture(): LandingReceiptV1 {
  return {
    version: 1,
    landingId: LANDING_ID,
    runId: RUN_ID,
    projectId: "55555555-5555-4555-8555-555555555555",
    provider: "github",
    owner: "icarus-owner",
    repository: "icarus-repository",
    baseRef: "refs/heads/main",
    baseCommitSha1: "1".repeat(40),
    headRef: `refs/heads/icarus/${RUN_ID}`,
    candidateTreeSha1: "7".repeat(40),
    candidateCommitSha1: CANDIDATE_COMMIT_SHA1,
    pullRequestNumber: 701,
    reconstructedPullRequestUrl: "https://github.com/icarus-owner/icarus-repository/pull/701",
    draft: true,
    landingSha256: LANDING_SHA256,
    profileSha256: "0".repeat(64),
    planSha256: PLAN_SHA256,
    diffSha256: DIFF_SHA256,
    checkpointSha256: CHECKPOINT_SHA256,
    verificationSha256: "3".repeat(64),
    reviewDecisionSha256: "4".repeat(64),
    changedPathsSha256: "5".repeat(64),
    localRefOutcome: "created",
    remoteObjectOutcome: "created_or_exact",
    remoteRefOutcome: "reconciled",
    pullRequestOutcome: "created",
    completedAt: NOW,
  };
}

function captureProcessWrites(): {
  readonly stdout: string[];
  readonly stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  return { stdout, stderr };
}

describe("landing approval presentation", () => {
  test("derives the complete bounded approval and preserves durable status evidence", () => {
    process.env[TOKEN_ENV] = TOKEN_SENTINEL;
    try {
      const status = statusFixture();
      const result = presentLandingStatusV1(status);

      expect(result).toEqual({
        landingRevision: 17,
        approval: {
          landingId: LANDING_ID,
          state: "awaiting_approval",
          resumeState: null,
          version: 2,
          landingSha256: LANDING_SHA256,
          candidateCommitSha1: CANDIDATE_COMMIT_SHA1,
          pullRequestTitle: TITLE,
          pullRequestBody: pullRequestBody(),
          receipt: null,
          decision: null,
          errorCode: null,
          updatedAt: NOW,
          directIcarusEffects: LANDING_DIRECT_ICARUS_EFFECTS,
          derivativeEffectDisclosure: {
            version: 1,
            githubEvents: LANDING_DERIVATIVE_GITHUB_EVENTS,
            mayTrigger: LANDING_DERIVATIVE_MAY_TRIGGER,
            disposition: "operator-approved",
            evidenceSha256: DISCLOSURE_EVIDENCE_SHA256,
          },
          effectWarning: LANDING_EFFECT_WARNING,
        },
        receipt: null,
        status,
      });
      expect(result.status).toBe(status);
      const encoded = JSON.stringify(result);
      expect(encoded).toContain("attempt-evidence-preserved");
      expect(encoded).toContain("operation-evidence-preserved");
      expect(encoded).toContain("event-evidence-preserved");
      expect(encoded).toContain(TOKEN_ENV);
      expect(encoded).not.toContain(TOKEN_SENTINEL);
    } finally {
      delete process.env[TOKEN_ENV];
    }
  });

  test("projects only the fixed approval schema and never forwards injected credential values", () => {
    const input = {
      landingId: LANDING_ID,
      state: "awaiting_approval",
      resumeState: null,
      version: 2,
      landingSha256: LANDING_SHA256,
      candidateCommitSha1: CANDIDATE_COMMIT_SHA1,
      pullRequestTitle: TITLE,
      pullRequestBody: pullRequestBody(),
      receipt: null,
      derivativeEffects: {
        version: 1,
        disposition: "operator-approved",
        evidenceSha256: DISCLOSURE_EVIDENCE_SHA256,
        credentialValue: TOKEN_SENTINEL,
      },
      decision: null,
      errorCode: null,
      updatedAt: NOW,
      credentialValue: TOKEN_SENTINEL,
    } as unknown as RunLandingPresentation;

    const result = presentLandingApprovalV1(input);
    expect(Object.keys(result)).toEqual([
      "landingId",
      "state",
      "resumeState",
      "version",
      "landingSha256",
      "candidateCommitSha1",
      "pullRequestTitle",
      "pullRequestBody",
      "receipt",
      "decision",
      "errorCode",
      "updatedAt",
      "directIcarusEffects",
      "derivativeEffectDisclosure",
      "effectWarning",
    ]);
    expect(JSON.stringify(result)).not.toContain(TOKEN_SENTINEL);
  });

  test("uses revision zero for an absent landing and rejects mismatched derived body evidence", () => {
    expect(presentLandingStatusV1(null)).toEqual({
      landingRevision: 0,
      approval: null,
      receipt: null,
      status: null,
    });

    const status = statusFixture();
    const mismatched = {
      ...status,
      landing: {
        ...status.landing,
        pullRequestBodySha256: "9".repeat(64),
      },
    } as LandingStatusV1;
    expect(() => presentLandingStatusV1(mismatched)).toThrowError(
      expect.objectContaining({ code: "LANDING_RECORD_INVALID" }),
    );
  });

  test("projects the landed receipt lockstep with its exact key order and no credential", () => {
    process.env[TOKEN_ENV] = TOKEN_SENTINEL;
    try {
      const status = {
        ...statusFixture(),
        landing: { ...statusFixture().landing, state: "landed" },
        receipt: receiptFixture(),
      } as LandingStatusV1;

      const receipt = presentLandingReceiptV1(receiptFixture());
      expect(receipt).toEqual(receiptFixture());
      expect(Object.keys(receipt)).toEqual([
        "version",
        "landingId",
        "runId",
        "projectId",
        "provider",
        "owner",
        "repository",
        "baseRef",
        "baseCommitSha1",
        "headRef",
        "candidateTreeSha1",
        "candidateCommitSha1",
        "pullRequestNumber",
        "reconstructedPullRequestUrl",
        "draft",
        "landingSha256",
        "profileSha256",
        "planSha256",
        "diffSha256",
        "checkpointSha256",
        "verificationSha256",
        "reviewDecisionSha256",
        "changedPathsSha256",
        "localRefOutcome",
        "remoteObjectOutcome",
        "remoteRefOutcome",
        "pullRequestOutcome",
        "completedAt",
      ]);

      const result = presentLandingStatusV1(status);
      expect(result.receipt).toEqual(receiptFixture());
      expect(result.approval?.receipt).toEqual(receiptFixture());
      expect(JSON.stringify(result)).not.toContain(TOKEN_SENTINEL);
    } finally {
      delete process.env[TOKEN_ENV];
    }
  });
});

describe("landing CLI presentation", () => {
  test("all four status-producing routes print the shared complete projection without token values", async () => {
    const previousExitCode = process.exitCode;
    const previousHome = process.env.ICARUS_HOME;
    const previousAllowlist = process.env.ICARUS_GITHUB_TOKEN_ALLOWLIST;
    const previousMigration = process.env.ICARUS_APPROVE_SCHEMA_MIGRATION;
    const previousToken = process.env[TOKEN_ENV];
    const output = captureProcessWrites();
    const status = statusFixture();
    const service = {
      prepareLanding: vi.fn(async () => status),
      getLandingStatus: vi.fn(() => status),
      decideLanding: vi.fn(async () => status),
      resumeLanding: vi.fn(async () => status),
    };
    const close = vi.fn();
    const runtime = { service, close } as unknown as IcarusRuntime;
    let runtimeCreations = 0;
    const createRuntime: NonNullable<CliMainOptions["createRuntime"]> = async () => {
      runtimeCreations += 1;
      return runtime;
    };
    const commands = [
      [
        "landing",
        "prepare",
        RUN_ID,
        "--commit-message",
        "Ship bounded landing",
        "--pr-title",
        TITLE,
        "--pr-body-prefix",
        BODY_PREFIX,
      ],
      ["landing", "status", RUN_ID],
      [
        "landing",
        "decide",
        RUN_ID,
        "--landing-sha",
        LANDING_SHA256,
        "--decision",
        "approve",
        "--actor",
        "operator",
      ],
      ["landing", "resume", RUN_ID],
    ] as const;

    process.env.ICARUS_HOME = "/tmp/icarus-landing-presentation-cli";
    process.env.ICARUS_GITHUB_TOKEN_ALLOWLIST = TOKEN_ENV;
    process.env[TOKEN_ENV] = TOKEN_SENTINEL;
    delete process.env.ICARUS_APPROVE_SCHEMA_MIGRATION;
    process.exitCode = undefined;
    try {
      for (const args of commands) {
        output.stdout.length = 0;
        output.stderr.length = 0;
        await runCliMain({ args, platform: "linux", createRuntime });
        const encoded = output.stdout.join("");
        expect(output.stderr).toEqual([]);
        expect(encoded).not.toContain(TOKEN_SENTINEL);
        expect(JSON.parse(encoded)).toEqual(presentLandingStatusV1(status));
      }
      expect(runtimeCreations).toBe(4);
      expect(service.prepareLanding).toHaveBeenCalledTimes(1);
      expect(service.getLandingStatus).toHaveBeenCalledTimes(1);
      expect(service.decideLanding).toHaveBeenCalledTimes(1);
      expect(service.resumeLanding).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(4);
    } finally {
      process.exitCode = previousExitCode;
      if (previousHome === undefined) delete process.env.ICARUS_HOME;
      else process.env.ICARUS_HOME = previousHome;
      if (previousAllowlist === undefined) delete process.env.ICARUS_GITHUB_TOKEN_ALLOWLIST;
      else process.env.ICARUS_GITHUB_TOKEN_ALLOWLIST = previousAllowlist;
      if (previousMigration === undefined) delete process.env.ICARUS_APPROVE_SCHEMA_MIGRATION;
      else process.env.ICARUS_APPROVE_SCHEMA_MIGRATION = previousMigration;
      if (previousToken === undefined) delete process.env[TOKEN_ENV];
      else process.env[TOKEN_ENV] = previousToken;
    }
  });

  test.each(["darwin", "win32"] as const)(
    "rejects every landing mutation on %s before runtime or store construction",
    async (platform) => {
      const previousExitCode = process.exitCode;
      const output = captureProcessWrites();
      let runtimeCreations = 0;
      const createRuntime: NonNullable<CliMainOptions["createRuntime"]> = async () => {
        runtimeCreations += 1;
        throw new Error("runtime construction must not be reached");
      };

      try {
        for (const action of ["profile-set", "prepare", "decide", "resume"] as const) {
          output.stdout.length = 0;
          output.stderr.length = 0;
          process.exitCode = undefined;
          await runCliMain({
            args: ["landing", action],
            platform,
            createRuntime,
          });
          expect(output.stdout).toEqual([]);
          expect(JSON.parse(output.stderr.join(""))).toEqual({
            error: {
              code: "UNSUPPORTED_PLATFORM",
              message: "Git landing mutations require Linux",
            },
          });
          expect(process.exitCode).toBe(1);
        }
        expect(runtimeCreations).toBe(0);
      } finally {
        process.exitCode = previousExitCode;
      }
    },
  );
});
