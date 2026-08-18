import { createRequire } from "node:module";

import { afterEach, describe, expect, test, vi } from "vitest";
import { LANDING_EFFECT_WARNING } from "../../packages/api/src/present.js";
import { ACTION_SESSION_STORAGE_KEY } from "../../packages/workspace/src/action-session.js";
import type {
  BrowserActionDescriptorView,
  BrowserActionReceiptView,
  LandingView,
  PersistedDiffReviewView,
  PlanAuthorityView,
  RunView,
} from "../../packages/workspace/src/api.js";
import {
  ApiError,
  executeBrowserAction,
  getBrowserActionReceipt,
  planRun,
} from "../../packages/workspace/src/api.js";
import {
  BrowserActionsPanel,
  PlanAuthorityDetails,
} from "../../packages/workspace/src/BrowserActionsPanel.js";
import {
  ACTION_RECEIPT_POLL_INTERVAL_MS,
  ACTION_RECEIPT_POLL_MAX_ATTEMPTS,
  ACTION_RECEIPT_POLL_MAX_WALL_CLOCK_MS,
  ACTION_RECEIPT_REQUEST_TIMEOUT_MS,
  BrowserActionResponseIdentityError,
  browserActionCanStart,
  browserActionConfirmationIsCurrent,
  browserActionExecutionMatchesRequest,
  browserActionOutcomeIsUncertain,
  browserActionReceiptMatchesRequest,
  browserActionReceiptPollRemainingMs,
  browserActionRequest,
  browserActionSessionShouldDemote,
  createBrowserActionConfirmation,
  createBrowserActionReceiptRequestGuard,
  proveDisplayedReviewDiff,
  sha256DisplayedText,
} from "../../packages/workspace/src/browser-actions.js";

const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACTION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACTION_SESSION = "A".repeat(43);

const workspaceRequire = createRequire(
  new URL("../../packages/workspace/package.json", import.meta.url),
);
const { createElement } = workspaceRequire("react") as {
  createElement(type: unknown, props: unknown): unknown;
};
const { renderToStaticMarkup } = workspaceRequire("react-dom/server") as {
  renderToStaticMarkup(element: unknown): string;
};

const DIFF_NOT_PRODUCED = {
  status: "not_produced",
  path: null,
  sha256: null,
  byteCount: 0,
  lineCount: 0,
  addedLines: 0,
  deletedLines: 0,
  hunkCount: 0,
  browserByteLimit: 262_144,
  digestProvenance: "not_available",
} as const satisfies PersistedDiffReviewView;

function descriptor(
  overrides: Partial<BrowserActionDescriptorView> = {},
): BrowserActionDescriptorView {
  return {
    version: 1,
    kind: "run.cancel",
    runId: RUN_ID,
    expectedState: "running",
    eventRevision: 17,
    subjectDigest: null,
    activeActionId: null,
    activeActionDigest: null,
    actionDigest: "d".repeat(64),
    label: "Cancel run",
    consequence: "Persist cancellation intent without Git or deployment effects.",
    ...overrides,
  };
}

function authority(overrides: Partial<PlanAuthorityView> = {}): PlanAuthorityView {
  return {
    planDigest: "a".repeat(64),
    targets: ["src/index.ts", "src/view.tsx"],
    checkIds: ["typecheck", "unit"],
    grants: [
      { kind: "read.manifest", scope: ["src"], maxCalls: 2 },
      { kind: "mutation.patchset", scope: ["src/index.ts", "src/view.tsx"], maxCalls: 1 },
    ],
    iterationCeiling: 2,
    readableManifest: {
      digest: "b".repeat(64),
      entries: [
        { path: "src/index.ts", sha256: "c".repeat(64) },
        { path: "src/view.tsx", sha256: "e".repeat(64) },
      ],
    },
    contextDigest: "f".repeat(64),
    baseCommit: "1".repeat(40),
    checks: [
      { id: "typecheck", name: "TypeScript", argv: ["pnpm", "typecheck"] },
      { id: "unit", name: "Unit tests", argv: ["pnpm", "test", "--", "unit"] },
    ],
    sandbox: {
      image: `registry.example/icarus@sha256:${"2".repeat(64)}`,
      cpus: 2,
      memoryMb: 2048,
      pids: 128,
      tmpfsMb: 512,
    },
    provider: {
      kind: "openai-compatible",
      model: "hostile <img src=x onerror=alert(1)>",
      capabilities: {
        contextSize: 32_768,
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
      locality: "remote",
      baseUrl: "https://provider.invalid/<script>alert(1)</script>",
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 2,
    },
    ceiling: {
      maxToolCalls: 8,
      maxActiveRuntimeMs: 60_000,
      maxContextBytes: 1_000_000,
      maxOutputTokensPerCall: 2_000,
      maxTotalTokens: 8_000,
      maxCostUsd: 1,
      maxFilesChanged: 4,
      maxFileBytes: 262_144,
      maxDiffBytes: 524_288,
      maxCommandOutputBytes: 65_536,
      maxRawCommandOutputBytes: 262_144,
      providerTimeoutMs: 30_000,
      commandTimeoutMs: 120_000,
    },
    execution: {
      platform: "linux",
      checksRequireSandbox: true,
      consequence:
        "Create only private cache/worktree state, run exact checks, and stop at review; never commit, push, merge, or deploy.",
    },
    ...overrides,
  };
}

function settledReceipt(): BrowserActionReceiptView {
  return {
    actionId: ACTION_ID,
    kind: "run.cancel",
    status: "settled",
    outcome: "succeeded",
    errorCode: null,
    updatedAt: "2026-08-02T12:00:00.000Z",
  };
}

function landingView(): LandingView {
  return {
    landingId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    state: "awaiting_approval",
    resumeState: null,
    version: 1,
    landingSha256: "a".repeat(64),
    candidateCommitSha1: "b".repeat(40),
    pullRequestTitle: "Exact title",
    pullRequestBody: "Exact complete body",
    receipt: null,
    decision: null,
    errorCode: null,
    updatedAt: "2026-08-02T12:00:00.000Z",
    directIcarusEffects: [
      "local_ref.create",
      "github.objects.upload",
      "github.ref.create",
      "github.draft_pull_request.create",
    ],
    derivativeEffectDisclosure: {
      version: 1,
      githubEvents: ["create", "pull_request.opened"],
      mayTrigger: ["actions", "webhooks", "bots", "notifications", "deployments"],
      disposition: "inert-repository",
      evidenceSha256: "c".repeat(64),
    },
    effectWarning: LANDING_EFFECT_WARNING,
  };
}

function landingReceiptView(): NonNullable<LandingView["receipt"]> {
  return {
    version: 1,
    landingId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    runId: "11111111-1111-4111-8111-111111111111",
    projectId: "55555555-5555-4555-8555-555555555555",
    provider: "github",
    owner: "icarus-owner",
    repository: "icarus-repository",
    baseRef: "refs/heads/main",
    baseCommitSha1: "1".repeat(40),
    headRef: "refs/heads/icarus/11111111-1111-4111-8111-111111111111",
    candidateTreeSha1: "7".repeat(40),
    candidateCommitSha1: "b".repeat(40),
    pullRequestNumber: 701,
    reconstructedPullRequestUrl: "https://github.com/icarus-owner/icarus-repository/pull/701",
    draft: true,
    landingSha256: "a".repeat(64),
    profileSha256: "0".repeat(64),
    planSha256: "2".repeat(64),
    diffSha256: "3".repeat(64),
    checkpointSha256: "4".repeat(64),
    verificationSha256: "5".repeat(64),
    reviewDecisionSha256: "6".repeat(64),
    changedPathsSha256: "8".repeat(64),
    localRefOutcome: "created",
    remoteObjectOutcome: "created_or_exact",
    remoteRefOutcome: "reconciled",
    pullRequestOutcome: "created",
    completedAt: "2026-08-02T12:03:00.000Z",
  };
}

function executionRun(receipt: BrowserActionReceiptView = settledReceipt()): RunView {
  return {
    id: RUN_ID,
    eventCursor: 18,
    landingRevision: 0,
    landing: null,
    timelineTotal: 0,
    timelineTruncated: false,
    phase: "cancelled",
    state: "cancelled",
    resumeState: null,
    gate: null,
    projectId: "project-1",
    task: "Cancel the run",
    target: "src/index.ts",
    baseCommit: null,
    provider: { model: "test-model", baseUrl: "http://127.0.0.1:11434" },
    context: null,
    plan: null,
    planSha256: null,
    action: null,
    files: { involved: [], changed: [] },
    checks: [],
    verification: { outcome: "cancelled", diffSha256: null, checkpointSha256: null },
    diff: null,
    diffReview: DIFF_NOT_PRODUCED,
    outputs: [],
    warnings: [],
    approvals: [],
    approvalCoverage: { limit: 12, loaded: 0, earlierApprovalsExcluded: false },
    usage: {
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      activeRuntimeMs: 0,
      estimatedCostUsd: 0,
      reservedCostUsd: 0,
    },
    lastError: null,
    timeline: [],
    timestamps: {
      createdAt: "2026-08-02T12:00:00.000Z",
      updatedAt: "2026-08-02T12:00:00.000Z",
    },
    createdAt: "2026-08-02T12:00:00.000Z",
    updatedAt: "2026-08-02T12:00:00.000Z",
    browserActions: [],
    browserActionRecovery: receipt,
    planAuthority: null,
  };
}

function installActionSession(): void {
  const values = new Map<string, string>([[ACTION_SESSION_STORAGE_KEY, ACTION_SESSION]]);
  const events = new EventTarget();
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    history: { state: null, replaceState: vi.fn() },
    location: { pathname: "/", search: "", hash: "" },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("workspace guarded browser actions", () => {
  test("creates one immutable UUID and emits the exact ten-key body without actor or copy", () => {
    let uuidCalls = 0;
    const source = descriptor();
    const confirmation = createBrowserActionConfirmation(
      source,
      null,
      DIFF_NOT_PRODUCED,
      null,
      () => {
        uuidCalls += 1;
        return ACTION_ID;
      },
    );
    const request = browserActionRequest(confirmation);

    expect(uuidCalls).toBe(1);
    expect(Object.keys(request)).toEqual([
      "actionId",
      "version",
      "kind",
      "runId",
      "expectedState",
      "eventRevision",
      "subjectDigest",
      "activeActionId",
      "activeActionDigest",
      "actionDigest",
    ]);
    expect(request).toEqual({
      actionId: ACTION_ID,
      version: 1,
      kind: "run.cancel",
      runId: RUN_ID,
      expectedState: "running",
      eventRevision: 17,
      subjectDigest: null,
      activeActionId: null,
      activeActionDigest: null,
      actionDigest: "d".repeat(64),
    });
    expect(request).not.toHaveProperty("actor");
    expect(request).not.toHaveProperty("label");
    expect(request).not.toHaveProperty("consequence");

    (source as { label: string }).label = "mutated";
    expect(confirmation.descriptor.label).toBe("Cancel run");
  });

  test("closes an immutable confirmation on descriptor or displayed-authority drift", () => {
    const plan = authority();
    const planDescriptor = descriptor({
      kind: "plan.approve",
      expectedState: "awaiting_approval",
      subjectDigest: plan.planDigest,
    });
    const confirmation = createBrowserActionConfirmation(
      planDescriptor,
      null,
      DIFF_NOT_PRODUCED,
      plan,
      () => ACTION_ID,
    );

    expect(
      browserActionConfirmationIsCurrent(
        confirmation,
        [{ ...planDescriptor }],
        null,
        DIFF_NOT_PRODUCED,
        plan,
      ),
    ).toBe(true);
    expect(
      browserActionConfirmationIsCurrent(
        confirmation,
        [{ ...planDescriptor, eventRevision: 18 }],
        null,
        DIFF_NOT_PRODUCED,
        plan,
      ),
    ).toBe(false);
    expect(
      browserActionConfirmationIsCurrent(
        confirmation,
        [{ ...planDescriptor, consequence: "changed host copy" }],
        null,
        DIFF_NOT_PRODUCED,
        plan,
      ),
    ).toBe(false);
    expect(
      browserActionConfirmationIsCurrent(
        confirmation,
        [{ ...planDescriptor }],
        null,
        DIFF_NOT_PRODUCED,
        authority({ iterationCeiling: 3 }),
      ),
    ).toBe(false);
  });

  test("uses WebCrypto over the exact displayed UTF-8 diff and disables mismatches", async () => {
    const diff = "diff --git a/café.ts b/café.ts\n+const ready = true;\n";
    const digest = await sha256DisplayedText(diff);
    const review = descriptor({
      kind: "review.approve",
      expectedState: "awaiting_review",
      subjectDigest: digest,
      actionDigest: "9".repeat(64),
    });
    const diffReview = {
      status: "available",
      path: "artifacts/review.diff",
      sha256: digest,
      byteCount: new TextEncoder().encode(diff).byteLength,
      lineCount: 2,
      addedLines: 1,
      deletedLines: 0,
      hunkCount: 1,
      browserByteLimit: 262_144,
      digestProvenance: "displayed_text_rehash_match",
    } as const satisfies PersistedDiffReviewView;

    await expect(proveDisplayedReviewDiff(review, diff, diffReview)).resolves.toEqual({
      status: "match",
      computedDigest: digest,
    });
    await expect(proveDisplayedReviewDiff(review, `${diff}changed`, diffReview)).resolves.toEqual(
      expect.objectContaining({ status: "mismatch" }),
    );
    await expect(proveDisplayedReviewDiff(review, null, DIFF_NOT_PRODUCED)).resolves.toEqual({
      status: "unavailable",
      computedDigest: null,
    });

    const confirmation = createBrowserActionConfirmation(
      review,
      diff,
      diffReview,
      null,
      () => ACTION_ID,
    );
    expect(
      browserActionConfirmationIsCurrent(
        confirmation,
        [review],
        `${diff}changed`,
        diffReview,
        null,
      ),
    ).toBe(false);
  });

  test("uses route-specific POST headers while preserving workspace.mutate and read-only receipt GET", async () => {
    installActionSession();
    const receipt = settledReceipt();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ action: receipt, run: { id: RUN_ID } }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: RUN_ID }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const confirmation = createBrowserActionConfirmation(
      descriptor(),
      null,
      DIFF_NOT_PRODUCED,
      null,
      () => ACTION_ID,
    );
    const request = browserActionRequest(confirmation);
    await executeBrowserAction(request);
    await planRun(RUN_ID);
    await getBrowserActionReceipt(RUN_ID, ACTION_ID);

    const actionCall = fetchMock.mock.calls[0];
    const actionHeaders = new Headers(actionCall?.[1]?.headers);
    expect(actionCall?.[0]).toBe(`/api/runs/${RUN_ID}/actions`);
    expect(actionCall?.[1]?.method).toBe("POST");
    expect(actionHeaders.get("authorization")).toBe(`Bearer ${ACTION_SESSION}`);
    expect(actionHeaders.get("x-icarus-action")).toBe("run.cancel");
    expect(actionHeaders.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(actionCall?.[1]?.body))).toEqual(request);
    expect(JSON.parse(String(actionCall?.[1]?.body))).not.toHaveProperty("actor");

    const planningHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(planningHeaders.get("x-icarus-action")).toBe("workspace.mutate");

    const receiptCall = fetchMock.mock.calls[2];
    const receiptHeaders = new Headers(receiptCall?.[1]?.headers);
    expect(receiptCall?.[0]).toBe(`/api/runs/${RUN_ID}/actions/${ACTION_ID}`);
    expect(receiptCall?.[1]?.method).toBeUndefined();
    expect(receiptHeaders.has("authorization")).toBe(false);
    expect(receiptHeaders.has("x-icarus-action")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("renders complete authority and hostile provider or descriptor text only as inert text", () => {
    const planMarkup = renderToStaticMarkup(
      createElement(PlanAuthorityDetails, { authority: authority() }),
    );
    expect(planMarkup).toContain("Complete bounded authority");
    expect(planMarkup).toContain("read.manifest");
    expect(planMarkup).toContain("mutation.patchset");
    expect(planMarkup).toContain("pnpm&quot;,&quot;typecheck");
    expect(planMarkup).toContain("max tool calls");
    expect(planMarkup).toContain("never commit, push, merge, or deploy");
    expect(planMarkup).toContain("&lt;img");
    expect(planMarkup).toContain("&lt;script&gt;");
    expect(planMarkup).not.toContain("<img");
    expect(planMarkup).not.toContain("<script");

    const hostile = descriptor({
      label: '<img data-hostile-label="true">',
      consequence: '<script data-hostile-consequence="true">alert(1)</script>',
    });
    const run = {
      id: RUN_ID,
      diff: null,
      diffReview: DIFF_NOT_PRODUCED,
      browserActions: [hostile],
      browserActionRecovery: null,
      planAuthority: null,
    } as unknown as RunView;
    const actionMarkup = renderToStaticMarkup(
      createElement(BrowserActionsPanel, {
        run,
        actionSessionAvailable: true,
        onRunChanged: async () => undefined,
        onRefresh: async () => undefined,
      }),
    );
    expect(actionMarkup).toContain("&lt;img");
    expect(actionMarkup).toContain("&lt;script");
    expect(actionMarkup).not.toContain("<img");
    expect(actionMarkup).not.toContain("<script");
    expect(actionMarkup.match(/<button/g)).toHaveLength(1);
    expect(actionMarkup).toContain(">Review this action</button>");
    expect(actionMarkup).not.toContain("actor=");
  });

  test("allows only a coordinator-bound cancellation alongside its active parent request", () => {
    const parentDescriptor = descriptor({
      kind: "plan.approve",
      expectedState: "awaiting_approval",
      subjectDigest: "a".repeat(64),
      actionDigest: "p".repeat(64),
    });
    const parentRequest = browserActionRequest(
      createBrowserActionConfirmation(
        parentDescriptor,
        null,
        DIFF_NOT_PRODUCED,
        null,
        () => ACTION_ID,
      ),
    );
    const cancel = descriptor({
      activeActionId: parentRequest.actionId,
      activeActionDigest: parentRequest.actionDigest,
      actionDigest: "c".repeat(64),
    });

    expect(browserActionCanStart(cancel, [parentRequest])).toBe(true);
    expect(
      browserActionCanStart({ ...cancel, activeActionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, [
        parentRequest,
      ]),
    ).toBe(false);
    expect(browserActionCanStart(descriptor({ kind: "review.reject" }), [parentRequest])).toBe(
      false,
    );

    const cancelRequest = browserActionRequest(
      createBrowserActionConfirmation(
        cancel,
        null,
        DIFF_NOT_PRODUCED,
        null,
        () => "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      ),
    );
    expect(browserActionCanStart(cancel, [parentRequest, cancelRequest])).toBe(false);
  });

  test("accepts only exact receipt and execution identities and classifies ambiguous outcomes", () => {
    const request = browserActionRequest(
      createBrowserActionConfirmation(descriptor(), null, DIFF_NOT_PRODUCED, null, () => ACTION_ID),
    );
    const receipt = settledReceipt();
    const run = executionRun(receipt);

    expect(browserActionReceiptMatchesRequest(receipt, request)).toBe(true);
    expect(
      browserActionReceiptMatchesRequest(
        { ...receipt, actionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
        request,
      ),
    ).toBe(false);
    expect(browserActionReceiptMatchesRequest({ ...receipt, unexpected: true }, request)).toBe(
      false,
    );
    expect(browserActionExecutionMatchesRequest({ action: receipt, run }, request)).toBe(true);
    const runWithLanding = { ...run, landingRevision: 3, landing: landingView() };
    expect(
      browserActionExecutionMatchesRequest({ action: receipt, run: runWithLanding }, request),
    ).toBe(true);
    expect(
      browserActionExecutionMatchesRequest(
        {
          action: receipt,
          run: {
            ...runWithLanding,
            landing: {
              ...landingView(),
              state: "preparing_candidate",
              version: 0,
              landingSha256: null,
              candidateCommitSha1: null,
              pullRequestBody: null,
            },
          },
        },
        request,
      ),
    ).toBe(true);
    expect(
      browserActionExecutionMatchesRequest(
        {
          action: receipt,
          run: {
            ...runWithLanding,
            landing: { ...landingView(), credentialEnv: "MUST_NOT_BE_ACCEPTED" },
          },
        },
        request,
      ),
    ).toBe(false);
    // A landed run carries its receipt: the exact 28-key projection is
    // accepted, and any widened or dropped receipt key fails closed.
    expect(
      browserActionExecutionMatchesRequest(
        {
          action: receipt,
          run: {
            ...runWithLanding,
            landing: { ...landingView(), state: "landed", receipt: landingReceiptView() },
          },
        },
        request,
      ),
    ).toBe(true);
    expect(
      browserActionExecutionMatchesRequest(
        {
          action: receipt,
          run: {
            ...runWithLanding,
            landing: {
              ...landingView(),
              state: "landed",
              receipt: { ...landingReceiptView(), credentialValue: "MUST_NOT_BE_ACCEPTED" },
            },
          },
        },
        request,
      ),
    ).toBe(false);
    expect(
      browserActionExecutionMatchesRequest(
        {
          action: receipt,
          run: {
            ...runWithLanding,
            landing: {
              ...landingView(),
              state: "landed",
              receipt: { ...landingReceiptView(), draft: false },
            },
          },
        },
        request,
      ),
    ).toBe(false);
    expect(
      browserActionExecutionMatchesRequest(
        { action: receipt, run: { ...run, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" } },
        request,
      ),
    ).toBe(false);
    expect(
      browserActionExecutionMatchesRequest({ action: receipt, run: { id: RUN_ID } }, request),
    ).toBe(false);

    expect(browserActionOutcomeIsUncertain(new BrowserActionResponseIdentityError())).toBe(true);
    expect(browserActionOutcomeIsUncertain(new ApiError(200, "INVALID_API_RESPONSE", "bad"))).toBe(
      true,
    );
    expect(
      browserActionOutcomeIsUncertain(new ApiError(503, "ACTION_SESSION_REQUIRED", "bad")),
    ).toBe(true);
    expect(browserActionOutcomeIsUncertain(new ApiError(409, "ACTION_STALE", "stale"))).toBe(false);
    expect(browserActionSessionShouldDemote(new ApiError(0, "API_UNREACHABLE", "down"))).toBe(true);
    expect(browserActionSessionShouldDemote(new ApiError(503, "API_ERROR", "down"))).toBe(false);
  });

  test("bounds each receipt GET by timeout, attempts, and wall clock", () => {
    vi.useFakeTimers();
    expect(ACTION_RECEIPT_POLL_INTERVAL_MS).toBe(2_000);
    expect(ACTION_RECEIPT_POLL_MAX_ATTEMPTS).toBe(15);
    expect(ACTION_RECEIPT_REQUEST_TIMEOUT_MS).toBe(1_000);
    expect(ACTION_RECEIPT_POLL_MAX_WALL_CLOCK_MS).toBe(30_000);
    expect(browserActionReceiptPollRemainingMs(1_000, 1_000, 0)).toBe(30_000);
    expect(browserActionReceiptPollRemainingMs(1_000, 30_999, 14)).toBe(1);
    expect(browserActionReceiptPollRemainingMs(1_000, 31_000, 14)).toBe(0);
    expect(browserActionReceiptPollRemainingMs(1_000, 1_000, 15)).toBe(0);

    const guard = createBrowserActionReceiptRequestGuard(ACTION_RECEIPT_REQUEST_TIMEOUT_MS);
    expect(guard.signal.aborted).toBe(false);
    vi.advanceTimersByTime(ACTION_RECEIPT_REQUEST_TIMEOUT_MS - 1);
    expect(guard.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(guard.signal.aborted).toBe(true);
    expect(guard.timedOut()).toBe(true);
    expect((guard.signal.reason as DOMException).name).toBe("TimeoutError");
    guard.dispose();
  });

  test("clears the action session on an unreachable API but not on intentional GET abort", async () => {
    installActionSession();
    const request = browserActionRequest(
      createBrowserActionConfirmation(descriptor(), null, DIFF_NOT_PRODUCED, null, () => ACTION_ID),
    );
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("connection refused"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(executeBrowserAction(request)).rejects.toMatchObject({
      code: "API_UNREACHABLE",
      status: 0,
    });
    expect(window.sessionStorage.getItem(ACTION_SESSION_STORAGE_KEY)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    installActionSession();
    const controller = new AbortController();
    controller.abort();
    const abortMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new DOMException("cancelled", "AbortError"));
    vi.stubGlobal("fetch", abortMock);
    await expect(
      getBrowserActionReceipt(RUN_ID, ACTION_ID, controller.signal),
    ).rejects.toMatchObject({
      code: "REQUEST_ABORTED",
      status: 0,
    });
    expect(window.sessionStorage.getItem(ACTION_SESSION_STORAGE_KEY)).toBe(ACTION_SESSION);
  });

  test("preserves the session for abort-shaped Chromium cancellations on cancellable GETs", async () => {
    installActionSession();
    const fetchController = new AbortController();
    const fetchAbortMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new DOMException("request cancelled", "AbortError"));
    vi.stubGlobal("fetch", fetchAbortMock);

    expect(fetchController.signal.aborted).toBe(false);
    await expect(
      getBrowserActionReceipt(RUN_ID, ACTION_ID, fetchController.signal),
    ).rejects.toMatchObject({ code: "REQUEST_ABORTED", status: 0 });
    expect(window.sessionStorage.getItem(ACTION_SESSION_STORAGE_KEY)).toBe(ACTION_SESSION);

    installActionSession();
    const bodyController = new AbortController();
    const response = new Response(JSON.stringify(settledReceipt()));
    vi.spyOn(response, "text").mockRejectedValue(
      new DOMException("response body cancelled", "AbortError"),
    );
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response));

    expect(bodyController.signal.aborted).toBe(false);
    await expect(
      getBrowserActionReceipt(RUN_ID, ACTION_ID, bodyController.signal),
    ).rejects.toMatchObject({ code: "REQUEST_ABORTED", status: 0 });
    expect(window.sessionStorage.getItem(ACTION_SESSION_STORAGE_KEY)).toBe(ACTION_SESSION);

    installActionSession();
    const networkController = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError("connection refused")),
    );
    await expect(
      getBrowserActionReceipt(RUN_ID, ACTION_ID, networkController.signal),
    ).rejects.toMatchObject({ code: "API_UNREACHABLE", status: 0 });
    expect(window.sessionStorage.getItem(ACTION_SESSION_STORAGE_KEY)).toBeNull();

    installActionSession();
    const timeoutController = new AbortController();
    timeoutController.abort(new DOMException("receipt GET timed out", "TimeoutError"));
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValue(new DOMException("request cancelled", "AbortError")),
    );
    await expect(
      getBrowserActionReceipt(RUN_ID, ACTION_ID, timeoutController.signal),
    ).rejects.toMatchObject({ code: "API_UNREACHABLE", status: 0 });
    expect(window.sessionStorage.getItem(ACTION_SESSION_STORAGE_KEY)).toBeNull();
  });

  test("treats pagehide as cancellation only until pageshow and never overrides timeouts", async () => {
    installActionSession();
    const controller = new AbortController();
    let rejectFetch: ((reason?: unknown) => void) | undefined;
    const pendingFetch = new Promise<Response>((_resolve, reject) => {
      rejectFetch = reject;
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockReturnValue(pendingFetch));

    const request = getBrowserActionReceipt(RUN_ID, ACTION_ID, controller.signal);
    window.dispatchEvent(new Event("pagehide"));
    if (rejectFetch === undefined)
      throw new Error("The pending fetch rejection was not installed.");
    rejectFetch(new TypeError("Failed to fetch"));
    await expect(request).rejects.toMatchObject({ code: "REQUEST_ABORTED", status: 0 });
    expect(window.sessionStorage.getItem(ACTION_SESSION_STORAGE_KEY)).toBe(ACTION_SESSION);

    window.dispatchEvent(new Event("pageshow"));
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError("connection refused")),
    );
    await expect(
      getBrowserActionReceipt(RUN_ID, ACTION_ID, new AbortController().signal),
    ).rejects.toMatchObject({ code: "API_UNREACHABLE", status: 0 });
    expect(window.sessionStorage.getItem(ACTION_SESSION_STORAGE_KEY)).toBeNull();

    window.sessionStorage.setItem(ACTION_SESSION_STORAGE_KEY, ACTION_SESSION);
    const timeoutController = new AbortController();
    timeoutController.abort(new DOMException("receipt GET timed out", "TimeoutError"));
    window.dispatchEvent(new Event("pagehide"));
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValue(new DOMException("request cancelled", "AbortError")),
    );
    await expect(
      getBrowserActionReceipt(RUN_ID, ACTION_ID, timeoutController.signal),
    ).rejects.toMatchObject({ code: "API_UNREACHABLE", status: 0 });
    expect(window.sessionStorage.getItem(ACTION_SESSION_STORAGE_KEY)).toBeNull();
    window.dispatchEvent(new Event("pageshow"));
  });

  test("preserves only the exact bounded stale-action 409 execution envelope", async () => {
    installActionSession();
    const request = browserActionRequest(
      createBrowserActionConfirmation(descriptor(), null, DIFF_NOT_PRODUCED, null, () => ACTION_ID),
    );
    const staleReceipt: BrowserActionReceiptView = {
      ...settledReceipt(),
      outcome: "refused",
      errorCode: "STALE_ACTION",
    };
    const execution = { action: staleReceipt, run: executionRun(staleReceipt) };
    const validFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(execution), { status: 409 }));
    vi.stubGlobal("fetch", validFetch);

    await expect(executeBrowserAction(request)).resolves.toEqual(execution);
    expect(validFetch).toHaveBeenCalledTimes(1);

    const landingExecution = {
      action: staleReceipt,
      run: {
        ...executionRun(staleReceipt),
        landingRevision: 3,
        landing: landingView(),
      },
    };
    const landingFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(landingExecution), { status: 409 }));
    vi.stubGlobal("fetch", landingFetch);
    await expect(executeBrowserAction(request)).resolves.toEqual(landingExecution);

    const malformedLandingFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          action: staleReceipt,
          run: {
            ...landingExecution.run,
            landing: { ...landingView(), credentialEnv: "MUST_NOT_BE_ACCEPTED" },
          },
        }),
        { status: 409 },
      ),
    );
    vi.stubGlobal("fetch", malformedLandingFetch);
    await expect(executeBrowserAction(request)).rejects.toMatchObject({
      code: "API_ERROR",
      status: 409,
    });

    const malformedFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ action: staleReceipt, run: { id: RUN_ID } }), {
        status: 409,
      }),
    );
    vi.stubGlobal("fetch", malformedFetch);
    await expect(executeBrowserAction(request)).rejects.toMatchObject({
      code: "API_ERROR",
      status: 409,
    });
    expect(malformedFetch).toHaveBeenCalledTimes(1);

    const genericFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "STALE_ACTION", message: "stale" } }), {
        status: 409,
      }),
    );
    vi.stubGlobal("fetch", genericFetch);
    await expect(executeBrowserAction(request)).rejects.toMatchObject({
      code: "STALE_ACTION",
      status: 409,
    });
    expect(genericFetch).toHaveBeenCalledTimes(1);
  });

  test("classifies malformed 2xx and ambiguous 5xx without issuing a follow-up POST", async () => {
    installActionSession();
    const request = browserActionRequest(
      createBrowserActionConfirmation(descriptor(), null, DIFF_NOT_PRODUCED, null, () => ACTION_ID),
    );
    const malformedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{", { status: 200 }));
    vi.stubGlobal("fetch", malformedFetch);
    let malformedError: unknown;
    try {
      await executeBrowserAction(request);
    } catch (error) {
      malformedError = error;
    }
    expect(malformedError).toMatchObject({ code: "INVALID_API_RESPONSE", status: 200 });
    expect(browserActionOutcomeIsUncertain(malformedError)).toBe(true);
    expect(malformedFetch).toHaveBeenCalledTimes(1);

    const unavailableFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "ACTION_SESSION_REQUIRED", message: "ambiguous upstream failure" },
        }),
        { status: 503 },
      ),
    );
    vi.stubGlobal("fetch", unavailableFetch);
    let unavailableError: unknown;
    try {
      await executeBrowserAction(request);
    } catch (error) {
      unavailableError = error;
    }
    expect(unavailableError).toMatchObject({ code: "ACTION_SESSION_REQUIRED", status: 503 });
    expect(browserActionOutcomeIsUncertain(unavailableError)).toBe(true);
    expect(unavailableFetch).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(ACTION_SESSION_STORAGE_KEY)).toBe(ACTION_SESSION);
  });
});
