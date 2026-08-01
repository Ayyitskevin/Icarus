import { invariant } from "./errors.js";
import type {
  ApprovalRecord,
  ChangeRoomAnnotationTarget,
  ChangeRoomCard,
  ChangeRoomCardIndicators,
  ChangeRoomCardKind,
  ChangeRoomCardStatus,
  ChangeRoomEvidenceRef,
  ChangeRoomProjection,
  ChangeRoomProvenanceClass,
  ChangeRoomSnapshot,
  CheckOutcomeEntry,
  EventSummaryRecord,
  PatchsetActionStatus,
  ProjectRecord,
  RollbackRestorationRecord,
  RunState,
} from "./types.js";
import { CHANGE_ROOM_SCHEMA } from "./types.js";

export const CHANGE_ROOM_CARD_ORDER: readonly ChangeRoomCardKind[] = [
  "task_scope",
  "base_context",
  "provider_plan",
  "plan_approval",
  "patchset",
  "registered_checks",
  "check_outcomes",
  "review_decision",
  "checkpoint",
  "rollback_restoration",
  "terminal_state",
];

export const CHANGE_ROOM_ANNOTATION_TARGETS: readonly ChangeRoomAnnotationTarget[] = [
  ...CHANGE_ROOM_CARD_ORDER,
  "room",
];

const CARD_TITLES: Readonly<Record<ChangeRoomCardKind, string>> = {
  task_scope: "Task and approved scope",
  base_context: "Pinned base and context egress",
  provider_plan: "Provider plan (untrusted proposal)",
  plan_approval: "Plan approval",
  patchset: "PatchSet and diff evidence",
  registered_checks: "Registered verification checks",
  check_outcomes: "Verification outcomes",
  review_decision: "Review decision",
  checkpoint: "Checkpoint",
  rollback_restoration: "Rollback and restoration",
  terminal_state: "Run state and terminal outcome",
};

const INTEGRITY_NOTE =
  "Digests in this Change Room prove only byte binding and the integrity of recorded " +
  "evidence. A digest match is not fresh authorization and does not prove semantic " +
  "correctness of the change.";

const CHECKPOINT_NOTE =
  "The checkpoint digest is a recorded byte binding between the baseline and approved " +
  "bytes captured at verification time. It is not a fresh rehash and does not prove " +
  "current worktree integrity.";

const ROLLBACK_NOTE =
  "Rollback restores baseline bytes in the Icarus-private worktree; restoration rewrites " +
  "only checkpoint-approved bytes and reruns verification. Neither commits, pushes, " +
  "merges, or deploys anything. A review rejection performs the bounded rollback without " +
  "a separate rollback approval; completion sequences mark observed completion events " +
  "rather than a causal link to one record. CLI history holds the full ordered record.";

const PATCHSET_NOTE =
  "The edit proposal is untrusted provider output until host validation and the recorded " +
  "approvals establish the relevant facts. The diff is host-generated, bounded, and " +
  "redacted evidence from the Icarus-private worktree. Nothing has been committed, " +
  "pushed, merged, or deployed.";

function indicators(partial: Partial<ChangeRoomCardIndicators> = {}): ChangeRoomCardIndicators {
  return {
    truncated: partial.truncated ?? false,
    redacted: partial.redacted ?? false,
    unavailableEvidence: partial.unavailableEvidence ?? false,
  };
}

function eventRefs(
  events: readonly EventSummaryRecord[],
  types: readonly string[],
): ChangeRoomEvidenceRef[] {
  return events
    .filter((event) => types.includes(event.type))
    .map((event) => ({ kind: "event_sequence" as const, sequence: event.sequence }));
}

function latestApproval(
  approvals: readonly ApprovalRecord[],
  kind: ApprovalRecord["kind"],
  decision?: ApprovalRecord["decision"],
): ApprovalRecord | null {
  const matches = approvals.filter(
    (approval) =>
      approval.kind === kind && (decision === undefined || approval.decision === decision),
  );
  return matches.at(-1) ?? null;
}

function actionStatus(snapshot: ChangeRoomSnapshot): Exclude<PatchsetActionStatus, "not_recorded"> {
  const ACTION_TYPES = [
    "edit.materialized",
    "restore.completed",
    "rollback.completed",
    "cancellation.completed",
    "review.accepted",
  ] as const;
  const actionEvents = snapshot.events
    .filter((event) => (ACTION_TYPES as readonly string[]).includes(event.type))
    .slice(-2);
  type Derived = {
    readonly status: Exclude<PatchsetActionStatus, "not_recorded">;
    readonly materialized: boolean | null;
  };
  const initial: Derived =
    snapshot.eventCount === snapshot.events.length
      ? { status: "proposed", materialized: false }
      : { status: "unknown", materialized: null };
  const reduced = actionEvents.reduce<Derived>((state, event) => {
    if (event.type === "edit.materialized" || event.type === "restore.completed") {
      return { status: "materialized", materialized: true };
    }
    if (event.type === "rollback.completed") {
      return { status: "reverted", materialized: false };
    }
    if (event.type === "cancellation.completed") {
      if (state.materialized === null) return { status: "unknown", materialized: null };
      return {
        status: state.materialized ? "reverted" : "cancelled",
        materialized: false,
      };
    }
    if (event.type === "review.accepted") {
      return { status: "completed", materialized: true };
    }
    return state;
  }, initial);
  return reduced.status;
}

export function changeRoomTerminalReason(state: RunState, errorCode: string | null): string | null {
  switch (state) {
    case "completed":
      return "completed";
    case "failed":
      return errorCode === null ? "failed" : `failed:${errorCode}`;
    case "cancelled":
      return "cancelled";
    case "rolled_back":
      return "rolled_back";
    default:
      return null;
  }
}

export function buildChangeRoom(
  snapshot: ChangeRoomSnapshot,
  project: ProjectRecord,
): ChangeRoomProjection {
  const { run, approvals, events } = snapshot;
  invariant(run.projectId === project.id, "DATABASE_ERROR", "Change Room project is invalid");
  const truncated = snapshot.eventCount > snapshot.events.length;

  const cards: ChangeRoomCard[] = [];

  const cardBase = (
    kind: ChangeRoomCardKind,
    provenanceClass: ChangeRoomProvenanceClass,
    status: ChangeRoomCardStatus,
    refs: readonly ChangeRoomEvidenceRef[],
    cardIndicators: ChangeRoomCardIndicators,
  ): Omit<ChangeRoomCard, "kind" | "body"> => ({
    id: `card-${kind.replaceAll("_", "-")}`,
    title: CARD_TITLES[kind],
    provenanceClass,
    status,
    refs,
    indicators: cardIndicators,
  });

  // 1. Task and approved scope — operator assertion persisted at run creation.
  const taskScopeRefs = eventRefs(events, ["run.created"]);
  cards.push({
    ...cardBase(
      "task_scope",
      "operator_assertion",
      "available",
      taskScopeRefs,
      indicators({ unavailableEvidence: truncated && taskScopeRefs.length === 0 }),
    ),
    kind: "task_scope",
    body: {
      task: run.task,
      target: run.target,
      projectId: project.id,
      projectName: project.name,
      baseRef: project.baseRef,
    },
  });

  // 2. Pinned base and context egress — host-derived facts.
  const egressApproval = latestApproval(approvals, "egress", "approve");
  const egressState =
    run.provider.capabilities.locality === "loopback"
      ? ("not_required_loopback" as const)
      : run.state === "awaiting_egress_approval"
        ? ("awaiting_approval" as const)
        : egressApproval !== null
          ? ("approved" as const)
          : ("not_reached" as const);
  const baseRefs = [
    ...eventRefs(events, ["base.pinned", "context.assembled", "egress.requested"]),
    ...(run.contextSha256.length > 0
      ? [{ kind: "digest" as const, label: "context", sha256: run.contextSha256 }]
      : []),
  ];
  const baseStatus: ChangeRoomCardStatus = run.contextSha256.length > 0 ? "available" : "pending";
  cards.push({
    ...cardBase(
      "base_context",
      "host_fact",
      baseStatus,
      baseRefs,
      indicators({ unavailableEvidence: truncated && baseRefs.length === 0 }),
    ),
    kind: "base_context",
    body: {
      baseCommit: run.baseCommit.length === 0 ? null : run.baseCommit,
      contextSha256: run.contextSha256.length === 0 ? null : run.contextSha256,
      target: run.contextSha256.length === 0 ? null : run.context.target,
      totalBytes: run.contextSha256.length === 0 ? null : run.context.totalBytes,
      auditPolicyVersion: run.contextSha256.length === 0 ? null : run.context.auditPolicyVersion,
      repositoryMap: run.contextSha256.length === 0 ? [] : run.context.repositoryMap,
      entries: run.contextSha256.length === 0 ? [] : run.context.entries,
      egress: {
        state: egressState,
        approval:
          egressApproval === null
            ? null
            : {
                actor: egressApproval.actor,
                digest: egressApproval.digest,
                createdAt: egressApproval.createdAt,
              },
      },
    },
  });

  // 3. Provider plan — untrusted provider output until host checks and approvals land.
  const planRefs = [
    ...eventRefs(events, ["plan.created"]),
    ...(run.planSha256 === null
      ? []
      : [{ kind: "digest" as const, label: "plan", sha256: run.planSha256 }]),
  ];
  cards.push({
    ...cardBase(
      "provider_plan",
      "provider_output",
      run.plan === null ? "pending" : "available",
      planRefs,
      indicators({ unavailableEvidence: run.plan !== null && planRefs.length === 0 }),
    ),
    kind: "provider_plan",
    body: {
      provider: {
        kind: run.provider.kind,
        model: run.provider.model,
        locality: run.provider.capabilities.locality,
        privacyClass: run.provider.capabilities.privacyClass,
      },
      trustLabel: "untrusted_proposal",
      plan: run.plan,
      planSha256: run.planSha256,
    },
  });

  // 4. Plan approval — explicit operator decision bound to the plan digest.
  const planApproval = latestApproval(approvals, "plan", "approve");
  const planApprovalRefs: ChangeRoomEvidenceRef[] = [
    ...(planApproval === null
      ? []
      : [
          {
            kind: "approval" as const,
            approvalKind: "plan" as const,
            digest: planApproval.digest,
          },
        ]),
    ...eventRefs(events, ["plan.approved"]),
  ];
  cards.push({
    ...cardBase(
      "plan_approval",
      "approval_decision",
      planApproval === null ? "pending" : "available",
      planApprovalRefs,
      indicators({
        unavailableEvidence: planApproval !== null && planApprovalRefs.length === 0,
      }),
    ),
    kind: "plan_approval",
    body: {
      approval:
        planApproval === null
          ? null
          : {
              actor: planApproval.actor,
              decision: planApproval.decision,
              digest: planApproval.digest,
              createdAt: planApproval.createdAt,
            },
    },
  });

  // 5. PatchSet and diff evidence.
  const status = run.edit === null ? "not_recorded" : actionStatus(snapshot);
  const patchsetRefs = [
    ...eventRefs(events, [
      "edit.intent_recorded",
      "edit.materialized",
      "rollback.completed",
      "restore.completed",
    ]),
    ...(run.verification === null
      ? []
      : [{ kind: "digest" as const, label: "diff", sha256: run.verification.diffSha256 }]),
  ];
  const patchsetStatus: ChangeRoomCardStatus =
    run.edit !== null || run.diff !== null
      ? "available"
      : run.state === "preparing" ||
          run.state === "awaiting_egress_approval" ||
          run.state === "planned" ||
          run.state === "awaiting_approval"
        ? "pending"
        : "unavailable";
  cards.push({
    ...cardBase(
      "patchset",
      "provider_output",
      patchsetStatus,
      patchsetRefs,
      indicators({
        redacted: run.diff !== null,
        unavailableEvidence:
          patchsetStatus === "unavailable" || (truncated && patchsetRefs.length === 0),
      }),
    ),
    kind: "patchset",
    body: {
      action:
        run.edit === null
          ? null
          : {
              path: run.edit.path,
              expectedPreimageSha256: run.edit.expectedPreimageSha256,
              rationale: run.edit.rationale,
            },
      actionStatus: status,
      diffSha256: run.verification?.diffSha256 ?? null,
      diffBytes: run.diff === null ? null : Buffer.byteLength(run.diff, "utf8"),
      diff: run.diff,
      changedPaths: run.verification?.changedPaths ?? [],
      note: PATCHSET_NOTE,
    },
  });

  // 6. Registered verification checks — operator-registered project configuration.
  cards.push({
    ...cardBase("registered_checks", "operator_assertion", "available", [], indicators()),
    kind: "registered_checks",
    body: { checks: project.checks, sandbox: project.sandbox },
  });

  // 7. Verification outcomes — bounded, redacted sandbox evidence.
  const checkEntries: CheckOutcomeEntry[] = project.checks.map((check) => {
    const evidence = run.verification?.checks.find((entry) => entry.checkId === check.id);
    return evidence === undefined
      ? {
          id: check.id,
          name: check.name,
          argv: check.argv,
          outcome: "not_run",
          exitCode: null,
          signal: null,
          durationMs: null,
          stdout: "",
          stderr: "",
          truncated: false,
        }
      : {
          id: check.id,
          name: check.name,
          argv: evidence.argv,
          outcome: evidence.outcome,
          exitCode: evidence.exitCode,
          signal: evidence.signal,
          durationMs: evidence.durationMs,
          stdout: evidence.stdout,
          stderr: evidence.stderr,
          truncated: evidence.truncated,
        };
  });
  const verificationRefs = [
    ...eventRefs(events, ["verification.completed"]),
    ...(run.verification === null
      ? []
      : [{ kind: "digest" as const, label: "diff", sha256: run.verification.diffSha256 }]),
  ];
  cards.push({
    ...cardBase(
      "check_outcomes",
      "verification_evidence",
      run.verification === null ? "pending" : "available",
      verificationRefs,
      indicators({
        truncated: checkEntries.some((entry) => entry.truncated),
        redacted: run.verification !== null,
        unavailableEvidence:
          run.verification !== null && truncated && verificationRefs.length === 0,
      }),
    ),
    kind: "check_outcomes",
    body: {
      outcome: run.verification?.outcome ?? "not_run",
      checks: checkEntries,
      diffSha256: run.verification?.diffSha256 ?? null,
      checkpointSha256: run.verification?.checkpointSha256 ?? null,
    },
  });

  // 8. Review decision — the merge-style gate, CLI only.
  const reviewApproval = latestApproval(approvals, "review");
  const reviewRefs: ChangeRoomEvidenceRef[] = [
    ...(reviewApproval === null
      ? []
      : [
          {
            kind: "approval" as const,
            approvalKind: "review" as const,
            digest: reviewApproval.digest,
          },
        ]),
    ...eventRefs(events, ["review.accepted", "review.rejected"]),
  ];
  cards.push({
    ...cardBase(
      "review_decision",
      "approval_decision",
      reviewApproval === null ? "pending" : "available",
      reviewRefs,
      indicators({
        unavailableEvidence: reviewApproval !== null && reviewRefs.length === 0,
      }),
    ),
    kind: "review_decision",
    body: {
      decision:
        reviewApproval === null
          ? null
          : {
              actor: reviewApproval.actor,
              decision: reviewApproval.decision,
              digest: reviewApproval.digest,
              createdAt: reviewApproval.createdAt,
            },
    },
  });

  // 9. Checkpoint — immutable recorded byte binding, never a fresh rehash.
  const checkpointRefs: ChangeRoomEvidenceRef[] = [
    ...(snapshot.checkpoint === null
      ? []
      : [{ kind: "checkpoint" as const, sha256: snapshot.checkpoint.sha256 }]),
    ...eventRefs(events, ["checkpoint.saved"]),
  ];
  cards.push({
    ...cardBase(
      "checkpoint",
      "host_fact",
      snapshot.checkpoint === null ? "pending" : "available",
      checkpointRefs,
      indicators({
        unavailableEvidence: snapshot.checkpoint !== null && truncated && checkpointRefs.length < 2,
      }),
    ),
    kind: "checkpoint",
    body: {
      status: snapshot.checkpoint === null ? "not_saved" : "saved",
      sha256: snapshot.checkpoint?.sha256 ?? null,
      createdAt: snapshot.checkpoint?.createdAt ?? null,
      note: CHECKPOINT_NOTE,
    },
  });

  // 10. Rollback and restoration — safe landing and recovery evidence. A review
  // rejection performs the bounded rollback without a separate rollback approval,
  // so it is projected as a rollback record carrying the rejecting decision.
  const rollbackCompletedEvents = events.filter((event) => event.type === "rollback.completed");
  const restoreCompletedEvents = events.filter((event) => event.type === "restore.completed");
  const rollbackRecords: RollbackRestorationRecord[] = approvals.flatMap((approval) => {
    if (approval.kind === "rollback" || approval.kind === "restore") {
      const completions =
        approval.kind === "rollback" ? rollbackCompletedEvents : restoreCompletedEvents;
      return [
        {
          kind: approval.kind,
          actor: approval.actor,
          decision: approval.decision,
          digest: approval.digest,
          createdAt: approval.createdAt,
          completed:
            completions.length > 0 || (approval.kind === "rollback" && run.state === "rolled_back"),
          completedSequence: completions.at(-1)?.sequence ?? null,
        },
      ];
    }
    if (
      approval.kind === "review" &&
      approval.decision === "reject" &&
      (rollbackCompletedEvents.length > 0 ||
        run.state === "rolled_back" ||
        run.state === "rolling_back")
    ) {
      return [
        {
          kind: "rollback" as const,
          actor: approval.actor,
          decision: approval.decision,
          digest: approval.digest,
          createdAt: approval.createdAt,
          completed: rollbackCompletedEvents.length > 0 || run.state === "rolled_back",
          completedSequence: rollbackCompletedEvents.at(-1)?.sequence ?? null,
        },
      ];
    }
    return [];
  });
  const recoveryActive = run.state === "rolling_back" || run.state === "restoring";
  cards.push({
    ...cardBase(
      "rollback_restoration",
      "approval_decision",
      rollbackRecords.length > 0 ? "available" : recoveryActive ? "pending" : "not_applicable",
      eventRefs(events, [
        "rollback.approved",
        "rollback.completed",
        "restore.approved",
        "restore.completed",
      ]),
      indicators({
        unavailableEvidence: rollbackRecords.some((record) => !record.completed) && !recoveryActive,
      }),
    ),
    kind: "rollback_restoration",
    body: { records: rollbackRecords, note: ROLLBACK_NOTE },
  });

  // 11. Run state and terminal outcome.
  const failureRefs = eventRefs(events, ["run.failed", "cancellation.completed"]);
  cards.push({
    ...cardBase(
      "terminal_state",
      run.lastError === null ? "host_fact" : "system_failure",
      "available",
      failureRefs,
      indicators({ unavailableEvidence: run.lastError !== null && failureRefs.length === 0 }),
    ),
    kind: "terminal_state",
    body: {
      state: run.state,
      resumeState: run.resumeState,
      terminal: changeRoomTerminalReason(run.state, run.lastError?.code ?? null) !== null,
      terminalReason: changeRoomTerminalReason(run.state, run.lastError?.code ?? null),
      lastError: run.lastError,
      updatedAt: run.updatedAt,
    },
  });

  return {
    schema: CHANGE_ROOM_SCHEMA,
    roomId: run.id,
    projectId: project.id,
    state: run.state,
    cards,
    annotations: snapshot.annotations,
    timeline: snapshot.events,
    integrity: {
      eventCursor: snapshot.eventCursor,
      eventCount: snapshot.eventCount,
      timelineTruncated: truncated,
      digestSemantics: "byte_binding_only",
      note: INTEGRITY_NOTE,
    },
    generatedBy: "deterministic_host_projection",
  };
}
