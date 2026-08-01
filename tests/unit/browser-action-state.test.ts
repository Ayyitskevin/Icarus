import { describe, expect, test } from "vitest";

import {
  assertBrowserActionCancellationParent,
  assertBrowserActionDescriptorFields,
  assertBrowserActionIdentity,
  assertBrowserActionRunStateEligible,
  assertBrowserActionSettlement,
  assertBrowserActionSubject,
  assertBrowserActionTransition,
  assertSameBrowserActionIdentity,
  BROWSER_ACTION_DESCRIPTOR_VERSION,
  BROWSER_ACTION_EXPECTED_STATES,
  BROWSER_ACTION_KINDS,
  BROWSER_ACTION_OUTCOMES,
  BROWSER_ACTION_STATUSES,
  type BrowserActionDescriptorFields,
  type BrowserActionIdentity,
  type BrowserActionParentSnapshot,
  type BrowserActionRecord,
  type BrowserActionSettlement,
  browserActionDescriptorDigest,
  browserActionDescriptorTuple,
  browserActionIdentityTuple,
  browserActionRequiresSubject,
  canTransitionBrowserAction,
  hasSameBrowserActionIdentity,
  isBrowserActionKind,
  isBrowserActionOutcome,
  isBrowserActionRunStateEligible,
  isBrowserActionStatus,
} from "../../packages/core/src/browser-action-state.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import type { RunState } from "../../packages/core/src/types.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_RUN_ID = "99999999-9999-4999-8999-999999999999";
const ACTION_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ACTION_ID = "44444444-4444-4444-8444-444444444444";
const ACTIVE_ACTION_ID = "33333333-3333-4333-8333-333333333333";
const OPERATION_ID = "55555555-5555-4555-8555-555555555555";
const SUBJECT_DIGEST = "a".repeat(64);
const ACTIVE_ACTION_DIGEST = "b".repeat(64);

const RUN_STATES = [
  "preparing",
  "planned",
  "awaiting_egress_approval",
  "awaiting_approval",
  "running",
  "verifying",
  "awaiting_review",
  "completed",
  "rolling_back",
  "cancelling",
  "failed",
  "cancelled",
  "rolled_back",
  "restoring",
] as const satisfies readonly RunState[];

const EXPECTED_STATES = {
  "egress.approve": ["awaiting_egress_approval"],
  "plan.approve": ["awaiting_approval"],
  "review.approve": ["awaiting_review"],
  "review.reject": ["awaiting_review"],
  "rollback.approve": ["completed"],
  "restore.approve": ["rolled_back"],
  "run.resume": [
    "preparing",
    "planned",
    "running",
    "verifying",
    "rolling_back",
    "restoring",
    "cancelling",
    "failed",
  ],
  "run.cancel": [
    "preparing",
    "planned",
    "awaiting_egress_approval",
    "awaiting_approval",
    "running",
    "verifying",
    "awaiting_review",
    "failed",
  ],
} as const;

function descriptor(
  overrides: Partial<BrowserActionDescriptorFields> = {},
): BrowserActionDescriptorFields {
  return {
    version: BROWSER_ACTION_DESCRIPTOR_VERSION,
    kind: "plan.approve",
    runId: RUN_ID,
    expectedState: "awaiting_approval",
    eventRevision: 7,
    subjectDigest: SUBJECT_DIGEST,
    activeActionId: null,
    activeActionDigest: null,
    ...overrides,
  };
}

function identity(overrides: Partial<BrowserActionIdentity> = {}): BrowserActionIdentity {
  const fields = descriptor(overrides);
  return {
    actionId: ACTION_ID,
    ...fields,
    actionDigest: browserActionDescriptorDigest(fields),
    ...overrides,
  };
}

function expectIcarusCode(callback: () => void, code: string): void {
  try {
    callback();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(IcarusError);
    expect((error as IcarusError).code).toBe(code);
  }
}

describe("ADR 0029 browser action contract", () => {
  test("exports only the closed action, status, and outcome sets", () => {
    expect(BROWSER_ACTION_KINDS).toEqual([
      "egress.approve",
      "plan.approve",
      "review.approve",
      "review.reject",
      "rollback.approve",
      "restore.approve",
      "run.resume",
      "run.cancel",
    ]);
    expect(BROWSER_ACTION_STATUSES).toEqual(["prepared", "admitted", "settled"]);
    expect(BROWSER_ACTION_OUTCOMES).toEqual([
      "succeeded",
      "refused",
      "failed",
      "cancelled",
      "reconciliation_required",
    ]);

    for (const kind of BROWSER_ACTION_KINDS) expect(isBrowserActionKind(kind)).toBe(true);
    for (const status of BROWSER_ACTION_STATUSES) expect(isBrowserActionStatus(status)).toBe(true);
    for (const outcome of BROWSER_ACTION_OUTCOMES)
      expect(isBrowserActionOutcome(outcome)).toBe(true);
    expect(isBrowserActionKind("landing.approve")).toBe(false);
    expect(isBrowserActionKind("run.execute")).toBe(false);
    expect(isBrowserActionStatus("started")).toBe(false);
    expect(isBrowserActionOutcome("approved")).toBe(false);
  });

  test("pins every allowed and denied kind/state pairing without claiming other prerequisites", () => {
    expect(BROWSER_ACTION_EXPECTED_STATES).toEqual(EXPECTED_STATES);

    for (const kind of BROWSER_ACTION_KINDS) {
      for (const state of RUN_STATES) {
        const allowed = (EXPECTED_STATES[kind] as readonly RunState[]).includes(state);
        expect(isBrowserActionRunStateEligible(kind, state), `${kind} at ${state}`).toBe(allowed);
        if (allowed) {
          expect(
            () => assertBrowserActionRunStateEligible(kind, state),
            `${kind} at ${state}`,
          ).not.toThrow();
        } else {
          expectIcarusCode(
            () => assertBrowserActionRunStateEligible(kind, state),
            "INVALID_BROWSER_ACTION",
          );
        }
      }
    }
  });

  test("requires the exact subject shape for gate actions and null for resume or cancel", () => {
    const subjectKinds = new Set([
      "egress.approve",
      "plan.approve",
      "review.approve",
      "review.reject",
      "rollback.approve",
      "restore.approve",
    ]);

    for (const kind of BROWSER_ACTION_KINDS) {
      const requiresSubject = subjectKinds.has(kind);
      expect(browserActionRequiresSubject(kind), kind).toBe(requiresSubject);
      if (requiresSubject) {
        expect(() => assertBrowserActionSubject(kind, SUBJECT_DIGEST), kind).not.toThrow();
        for (const invalid of [null, "a".repeat(63), "A".repeat(64), `${"a".repeat(63)}g`]) {
          expectIcarusCode(
            () => assertBrowserActionSubject(kind, invalid),
            "INVALID_BROWSER_ACTION",
          );
        }
      } else {
        expect(() => assertBrowserActionSubject(kind, null), kind).not.toThrow();
        expectIcarusCode(
          () => assertBrowserActionSubject(kind, SUBJECT_DIGEST),
          "INVALID_BROWSER_ACTION",
        );
      }
    }
  });

  test("serializes and hashes exactly the normative descriptor tuple", () => {
    const fields = descriptor();
    const tuple = browserActionDescriptorTuple(fields);
    expect(tuple).toEqual([
      1,
      "plan.approve",
      RUN_ID,
      "awaiting_approval",
      7,
      SUBJECT_DIGEST,
      null,
      null,
    ]);
    expect(JSON.stringify(tuple)).toBe(
      `[1,"plan.approve","${RUN_ID}","awaiting_approval",7,"${SUBJECT_DIGEST}",null,null]`,
    );
    expect(browserActionDescriptorDigest(fields)).toBe(
      "d729887b08a4b6c288607df87e93fecd8d3cd8cc0242d68ed5b236b87e191810",
    );

    const withExcludedCopy = {
      ...fields,
      actionId: ACTION_ID,
      label: "Attacker-controlled-looking copy is not digest input",
      actor: "operator",
      bearer: "not-digest-input",
    };
    expect(browserActionDescriptorDigest(withExcludedCopy)).toBe(
      browserActionDescriptorDigest(fields),
    );
    expect(
      browserActionDescriptorDigest(
        descriptor({ kind: "review.approve", expectedState: "awaiting_review" }),
      ),
    ).not.toBe(
      browserActionDescriptorDigest(
        descriptor({ kind: "review.reject", expectedState: "awaiting_review" }),
      ),
    );
  });

  test("validates the descriptor and immutable body identity without adding actor authority", () => {
    const request = identity();
    expect(() => assertBrowserActionIdentity(request)).not.toThrow();
    expect(browserActionIdentityTuple(request)).toEqual([
      ACTION_ID,
      1,
      "plan.approve",
      RUN_ID,
      "awaiting_approval",
      7,
      SUBJECT_DIGEST,
      null,
      null,
      request.actionDigest,
    ]);
    expect(hasSameBrowserActionIdentity(request, { ...request })).toBe(true);
    expect(() => assertSameBrowserActionIdentity(request, { ...request })).not.toThrow();

    const changedFields: readonly BrowserActionIdentity[] = [
      { ...request, actionId: OTHER_ACTION_ID },
      { ...request, version: 2 } as unknown as BrowserActionIdentity,
      { ...request, kind: "review.approve" },
      { ...request, runId: OTHER_RUN_ID },
      { ...request, expectedState: "awaiting_review" },
      { ...request, eventRevision: 8 },
      { ...request, subjectDigest: "c".repeat(64) },
      { ...request, activeActionId: ACTIVE_ACTION_ID },
      { ...request, activeActionDigest: ACTIVE_ACTION_DIGEST },
      { ...request, actionDigest: "d".repeat(64) },
    ];
    for (const changed of changedFields) {
      expect(hasSameBrowserActionIdentity(request, changed)).toBe(false);
      expectIcarusCode(
        () => assertSameBrowserActionIdentity(request, changed),
        "ACTION_ID_CONFLICT",
      );
    }

    expectIcarusCode(
      () => assertBrowserActionIdentity({ ...request, actionDigest: "f".repeat(64) }),
      "INVALID_BROWSER_ACTION",
    );
    expectIcarusCode(
      () =>
        assertBrowserActionIdentity({
          ...request,
          actionId: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF",
        }),
      "INVALID_BROWSER_ACTION",
    );
  });

  test("fails malformed or internally inconsistent descriptor fields closed", () => {
    const invalid: readonly BrowserActionDescriptorFields[] = [
      descriptor({ runId: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF" }),
      descriptor({ eventRevision: 0 }),
      descriptor({ eventRevision: Number.MAX_SAFE_INTEGER + 1 }),
      descriptor({ expectedState: "running" }),
      descriptor({ subjectDigest: null }),
      descriptor({ activeActionId: ACTIVE_ACTION_ID }),
      descriptor({ activeActionDigest: ACTIVE_ACTION_DIGEST }),
      descriptor({ activeActionId: ACTIVE_ACTION_ID, activeActionDigest: ACTIVE_ACTION_DIGEST }),
    ];
    for (const candidate of invalid) {
      expectIcarusCode(
        () => assertBrowserActionDescriptorFields(candidate),
        "INVALID_BROWSER_ACTION",
      );
    }

    expectIcarusCode(
      () =>
        assertBrowserActionDescriptorFields({
          ...descriptor(),
          version: 2,
        } as unknown as BrowserActionDescriptorFields),
      "INVALID_BROWSER_ACTION",
    );
  });

  test("accepts only null state-based parents or the exact admitted same-run non-cancel parent", () => {
    const stateBasedCancel = descriptor({
      kind: "run.cancel",
      expectedState: "running",
      subjectDigest: null,
    });
    expect(() => assertBrowserActionCancellationParent(stateBasedCancel, null)).not.toThrow();
    expectIcarusCode(
      () =>
        assertBrowserActionCancellationParent(stateBasedCancel, {
          actionId: ACTIVE_ACTION_ID,
          runId: RUN_ID,
          kind: "plan.approve",
          status: "admitted",
          actionDigest: ACTIVE_ACTION_DIGEST,
        }),
      "INVALID_BROWSER_ACTION",
    );

    const boundCancel = descriptor({
      kind: "run.cancel",
      expectedState: "running",
      subjectDigest: null,
      activeActionId: ACTIVE_ACTION_ID,
      activeActionDigest: ACTIVE_ACTION_DIGEST,
    });
    const parent: BrowserActionParentSnapshot = {
      actionId: ACTIVE_ACTION_ID,
      runId: RUN_ID,
      kind: "plan.approve",
      status: "admitted",
      actionDigest: ACTIVE_ACTION_DIGEST,
    };
    expect(() => assertBrowserActionCancellationParent(boundCancel, parent)).not.toThrow();
    expectIcarusCode(
      () => assertBrowserActionCancellationParent(boundCancel, null),
      "INVALID_BROWSER_ACTION",
    );

    const invalidParents: readonly BrowserActionParentSnapshot[] = [
      { ...parent, actionId: OTHER_ACTION_ID },
      { ...parent, runId: OTHER_RUN_ID },
      { ...parent, kind: "run.cancel" },
      { ...parent, status: "prepared" },
      { ...parent, status: "settled" },
      { ...parent, kind: "not-an-action" } as unknown as BrowserActionParentSnapshot,
      { ...parent, actionDigest: "c".repeat(64) },
    ];
    for (const invalidParent of invalidParents) {
      expectIcarusCode(
        () => assertBrowserActionCancellationParent(boundCancel, invalidParent),
        "INVALID_BROWSER_ACTION",
      );
    }
  });

  test("enumerates the monotone lifecycle and makes settled terminal", () => {
    const outcomes = [null, ...BROWSER_ACTION_OUTCOMES] as const;
    const allowed = new Set([
      "prepared:admitted:null",
      "prepared:settled:refused",
      "admitted:settled:succeeded",
      "admitted:settled:failed",
      "admitted:settled:cancelled",
      "admitted:settled:reconciliation_required",
    ]);

    for (const from of BROWSER_ACTION_STATUSES) {
      for (const to of BROWSER_ACTION_STATUSES) {
        for (const outcome of outcomes) {
          const key = `${from}:${to}:${outcome}`;
          const expected = allowed.has(key);
          expect(canTransitionBrowserAction(from, to, outcome), key).toBe(expected);
          if (expected) {
            expect(() => assertBrowserActionTransition(from, to, outcome), key).not.toThrow();
          } else {
            expectIcarusCode(
              () => assertBrowserActionTransition(from, to, outcome),
              "INVALID_BROWSER_ACTION_TRANSITION",
            );
          }
        }
      }
    }
  });

  test("enforces terminal anchor and error-code shapes for each settlement outcome", () => {
    const refused = {
      outcome: "refused",
      admissionEventSequence: null,
      domainEventSequence: null,
      domainOperationId: null,
      errorCode: "ACTION_NOT_ADMITTED",
    } as const satisfies BrowserActionSettlement;
    const succeeded = {
      outcome: "succeeded",
      admissionEventSequence: 10,
      domainEventSequence: 11,
      domainOperationId: null,
      errorCode: null,
    } as const satisfies BrowserActionSettlement;
    const cancelled = {
      ...succeeded,
      outcome: "cancelled",
    } as const satisfies BrowserActionSettlement;
    const failed = {
      outcome: "failed",
      admissionEventSequence: 10,
      domainEventSequence: null,
      domainOperationId: null,
      errorCode: "DOMAIN_ACTION_FAILED",
    } as const satisfies BrowserActionSettlement;
    const reconciliation = {
      outcome: "reconciliation_required",
      admissionEventSequence: 10,
      domainEventSequence: 11,
      domainOperationId: OPERATION_ID,
      errorCode: "ACTION_RECOVERY_REQUIRED",
    } as const satisfies BrowserActionSettlement;

    expect(() => assertBrowserActionSettlement("prepared", refused)).not.toThrow();
    for (const settlement of [succeeded, cancelled, failed, reconciliation]) {
      expect(() => assertBrowserActionSettlement("admitted", settlement)).not.toThrow();
    }

    const malformed: readonly [string, BrowserActionSettlement][] = [
      ["prepared", { ...refused, admissionEventSequence: 1 } as unknown as BrowserActionSettlement],
      [
        "admitted",
        { ...succeeded, domainEventSequence: null } as unknown as BrowserActionSettlement,
      ],
      ["admitted", { ...failed, admissionEventSequence: 0 } as unknown as BrowserActionSettlement],
      ["admitted", { ...failed, errorCode: "unsafe-error" } as unknown as BrowserActionSettlement],
      [
        "admitted",
        { ...reconciliation, domainOperationId: "not-a-uuid" } as BrowserActionSettlement,
      ],
    ];
    for (const [from, settlement] of malformed) {
      expectIcarusCode(
        () => assertBrowserActionSettlement(from as "prepared" | "admitted", settlement),
        "INVALID_BROWSER_ACTION_SETTLEMENT",
      );
    }

    expectIcarusCode(
      () => assertBrowserActionSettlement("admitted", refused),
      "INVALID_BROWSER_ACTION_TRANSITION",
    );
    expectIcarusCode(
      () => assertBrowserActionSettlement("prepared", failed),
      "INVALID_BROWSER_ACTION_TRANSITION",
    );
    expectIcarusCode(
      () => assertBrowserActionSettlement("settled", succeeded),
      "INVALID_BROWSER_ACTION_TRANSITION",
    );
  });

  test("models prepared, admitted, and settled records without optional lifecycle ambiguity", () => {
    const request = identity();
    const base = {
      ...request,
      actor: "operator",
      createdAt: "2026-07-31T12:00:00.000Z",
      updatedAt: "2026-07-31T12:00:00.000Z",
    };
    const records: readonly BrowserActionRecord[] = [
      {
        ...base,
        status: "prepared",
        outcome: null,
        admissionEventSequence: null,
        domainEventSequence: null,
        domainOperationId: null,
        errorCode: null,
      },
      {
        ...base,
        status: "admitted",
        outcome: null,
        admissionEventSequence: 10,
        domainEventSequence: null,
        domainOperationId: null,
        errorCode: null,
      },
      {
        ...base,
        status: "settled",
        outcome: "succeeded",
        admissionEventSequence: 10,
        domainEventSequence: 11,
        domainOperationId: null,
        errorCode: null,
      },
      {
        ...base,
        status: "settled",
        outcome: "reconciliation_required",
        admissionEventSequence: 10,
        domainEventSequence: null,
        domainOperationId: OPERATION_ID,
        errorCode: "ACTION_RECOVERY_REQUIRED",
      },
    ];
    expect(records.map(({ status, outcome }) => [status, outcome])).toEqual([
      ["prepared", null],
      ["admitted", null],
      ["settled", "succeeded"],
      ["settled", "reconciliation_required"],
    ]);
  });
});
