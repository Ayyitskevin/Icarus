import type {
  ApprovalRecord,
  EventRecord,
  EventSummaryRecord,
  ProjectRecord,
  ProjectRepositoryStatus,
  RepositoryRecord,
  RunEventHistoryPage,
  RunEventPage,
  RunPresentationSnapshot,
  RunRecord,
  RunState,
  RunVerificationAttemptsSnapshot,
  WorkspaceRunPage,
} from "@icarus/core";

export type WorkspaceRunPhase =
  | "draft"
  | "planned"
  | "awaiting_approval"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export function workspaceRunPhase(state: RunState): WorkspaceRunPhase {
  switch (state) {
    case "preparing":
      return "draft";
    case "planned":
      return "planned";
    case "awaiting_egress_approval":
    case "awaiting_approval":
    case "awaiting_review":
      return "awaiting_approval";
    case "running":
    case "verifying":
    case "rolling_back":
    case "restoring":
    case "cancelling":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "rolled_back":
      return "cancelled";
  }
}

interface WorkspaceGate {
  readonly kind: "egress" | "plan" | "review";
  readonly status: "awaiting_approval";
  readonly label: string;
  readonly digest?: string;
  readonly reason: string;
}

export type WorkspaceEvidenceSection =
  | "summary"
  | "context"
  | "plan"
  | "action"
  | "verification"
  | "outputs"
  | "approvals"
  | "usage"
  | "activity";

function approvalGate(run: RunRecord): WorkspaceGate | null {
  const kind =
    run.state === "awaiting_egress_approval"
      ? "egress"
      : run.state === "awaiting_approval"
        ? "plan"
        : run.state === "awaiting_review"
          ? "review"
          : null;
  if (kind === null) return null;
  const digest =
    kind === "egress"
      ? run.contextSha256
      : kind === "plan"
        ? run.planSha256
        : run.verification?.diffSha256;
  const labels = {
    egress: "Context egress approval",
    plan: "Plan approval",
    review: "Change review",
  } as const;
  return {
    kind,
    status: "awaiting_approval",
    label: labels[kind],
    ...(digest === null || digest === undefined || digest.length === 0 ? {} : { digest }),
    reason: "Review the digest-bound evidence in the CLI; this browser slice cannot approve it.",
  };
}

export function presentProject(
  project: ProjectRecord,
  repository: RepositoryRecord,
): Record<string, unknown> {
  return {
    id: project.id,
    name: project.name,
    repository: {
      id: repository.id,
      name: repository.name,
      path: repository.path,
    },
    baseRef: project.baseRef,
    checks: project.checks,
    sandbox: project.sandbox,
    ceiling: project.ceiling,
    createdAt: project.createdAt,
  };
}

function evidenceSection(type: string): WorkspaceEvidenceSection {
  if (type === "run.created" || type === "base.pinned") return "summary";
  if (type === "context.assembled" || type === "egress.requested") return "context";
  if (type === "plan.created") return "plan";
  if (
    type === "egress.approved" ||
    type === "plan.approved" ||
    type.startsWith("review.") ||
    type === "rollback.approved" ||
    type === "restore.approved"
  ) {
    return "approvals";
  }
  if (
    type === "workspace.created" ||
    type.startsWith("edit.") ||
    type.startsWith("rollback.") ||
    type.startsWith("restore.") ||
    type.startsWith("cancellation.")
  ) {
    return "action";
  }
  if (type === "checkpoint.saved" || type === "verification.completed") {
    return "verification";
  }
  if (type.startsWith("operation.")) return "usage";
  return "activity";
}

export function presentTimelineEvent(
  event: Pick<EventRecord | EventSummaryRecord, "sequence" | "type" | "createdAt">,
): Record<string, unknown> {
  return {
    sequence: event.sequence,
    type: event.type,
    label: event.type.replaceAll(".", " "),
    evidenceSection: evidenceSection(event.type),
    timestamp: event.createdAt,
    createdAt: event.createdAt,
  };
}

function timeline(events: readonly EventSummaryRecord[]): readonly Record<string, unknown>[] {
  return events.map(presentTimelineEvent);
}

const REPOSITORY_ISSUE_MESSAGES: Readonly<
  Record<NonNullable<ProjectRepositoryStatus["issue"]>["code"], string>
> = {
  DIRTY_REPOSITORY: "The repository has staged, unstaged, or untracked changes.",
  REPOSITORY_IDENTITY_CHANGED: "The registered repository identity changed.",
  BASE_REF_UNRESOLVED: "The configured base ref could not be resolved.",
  BASE_REF_NOT_HEAD: "Repository HEAD does not match the configured base ref.",
  REPOSITORY_MISSING: "The registered repository path is missing.",
  REPOSITORY_UNAVAILABLE: "Repository status could not be read safely.",
};

export function presentRepositoryStatus(status: ProjectRepositoryStatus): Record<string, unknown> {
  return {
    projectId: status.projectId,
    repositoryId: status.repositoryId,
    checkedAt: status.checkedAt,
    availability: status.availability,
    worktree: status.worktree,
    head: status.head,
    branch: status.branch,
    baseRef: status.baseRef,
    baseCommit: status.baseCommit,
    headMatchesBaseRef: status.headMatchesBaseRef,
    issue:
      status.issue === null
        ? null
        : {
            code: status.issue.code,
            message: REPOSITORY_ISSUE_MESSAGES[status.issue.code],
          },
  };
}

export function presentRunEventPage(page: RunEventPage): Record<string, unknown> {
  return {
    runId: page.runId,
    revision: page.revision,
    nextAfter: page.nextAfter,
    hasMore: page.hasMore,
    events: page.events.map((event) => ({
      sequence: event.sequence,
      type: event.type,
      label: event.type.replaceAll(".", " "),
      evidenceSection: evidenceSection(event.type),
      timestamp: event.createdAt,
    })),
  };
}

export function presentRunEventHistoryPage(page: RunEventHistoryPage): Record<string, unknown> {
  return {
    runId: page.runId,
    before: page.before,
    snapshot: page.snapshot,
    nextBefore: page.nextBefore,
    hasMore: page.hasMore,
    events: page.events.map((event) => ({
      sequence: event.sequence,
      type: event.type,
      label: event.type.replaceAll(".", " "),
      evidenceSection: evidenceSection(event.type),
      timestamp: event.createdAt,
    })),
  };
}

export function presentRunVerificationAttempts(
  snapshot: RunVerificationAttemptsSnapshot,
): Record<string, unknown> {
  const checkpoint =
    snapshot.checkpoint.status === "not_saved"
      ? { status: "not_saved" }
      : {
          status: "saved",
          sha256: snapshot.checkpoint.sha256,
          createdAt: snapshot.checkpoint.createdAt,
          saveEvent:
            snapshot.checkpoint.saveEvent.status === "observed_in_coverage"
              ? {
                  status: "observed_in_coverage",
                  sequence: snapshot.checkpoint.saveEvent.sequence,
                  timestamp: snapshot.checkpoint.saveEvent.timestamp,
                }
              : { status: "not_observed_in_coverage" },
        };
  return {
    runId: snapshot.runId,
    snapshot: snapshot.snapshot,
    coverage: {
      firstSequence: snapshot.coverage.firstSequence,
      lastSequence: snapshot.coverage.lastSequence,
      eventCount: snapshot.coverage.eventCount,
      eventLimit: snapshot.coverage.eventLimit,
      earlierEventsExcluded: snapshot.coverage.earlierEventsExcluded,
    },
    attemptLimit: snapshot.attemptLimit,
    attemptAnchorsTruncatedWithinCoverage: snapshot.attemptAnchorsTruncatedWithinCoverage,
    checkpoint,
    attempts: snapshot.attempts.map((attempt) => ({
      identity: attempt.identity,
      anchorSequence: attempt.anchorSequence,
      startSequence: attempt.startSequence,
      startedAt: attempt.startedAt,
      startProvenance: attempt.startProvenance,
      status: attempt.status,
      endSequence: attempt.endSequence,
      endedAt: attempt.endedAt,
      diffSha256: attempt.diffSha256,
      checkpointSha256: attempt.checkpointSha256,
      checkpointProvenance: attempt.checkpointProvenance,
      laterAttemptObservedWithinCoverage: attempt.laterAttemptObservedWithinCoverage,
    })),
  };
}

export function presentWorkspaceRunPage(page: WorkspaceRunPage): Record<string, unknown> {
  return {
    before: page.before,
    snapshot: page.snapshot,
    nextBefore: page.nextBefore,
    hasMore: page.hasMore,
    runs: page.runs.map((run) => ({
      id: run.id,
      projectId: run.projectId,
      task: run.task,
      target: run.target,
      state: run.state,
      phase: workspaceRunPhase(run.state),
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    })),
  };
}

function approvals(records: readonly ApprovalRecord[]): readonly Record<string, unknown>[] {
  return records.map((approval) => ({
    kind: approval.kind,
    digest: approval.digest,
    actor: approval.actor,
    decision: approval.decision,
    createdAt: approval.createdAt,
  }));
}

export function presentRun(
  project: ProjectRecord,
  snapshot: RunPresentationSnapshot,
): Record<string, unknown> {
  const run: RunRecord = snapshot.run;
  const checks = project.checks.map((check) => {
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
  const outputs = (run.verification?.checks ?? []).flatMap((evidence) => {
    const checkName =
      project.checks.find((check) => check.id === evidence.checkId)?.name ?? evidence.checkId;
    return [
      {
        label: `${checkName} standard output`,
        stream: "stdout",
        text: evidence.stdout,
        truncated: evidence.truncated,
      },
      {
        label: `${checkName} standard error`,
        stream: "stderr",
        text: evidence.stderr,
        truncated: evidence.truncated,
      },
    ];
  });
  const warnings: string[] = [];
  if (run.state === "preparing") {
    warnings.push("Draft only: context and plan generation have not run.");
  }
  const gate = approvalGate(run);
  if (gate !== null) {
    warnings.push(
      `Human ${gate.kind} approval is required before the guarded lifecycle can continue.`,
    );
  }
  if (run.verification === null) {
    warnings.push("Verification has not run; no test result is being claimed.");
  } else if (run.verification.outcome !== "passed") {
    warnings.push(`Verification outcome is ${run.verification.outcome}.`);
  }
  if (run.lastError !== null) {
    warnings.push(`${run.lastError.code}: ${run.lastError.message}`);
  }
  warnings.push(
    "This workspace slice is review-only: approving plans or executing project commands remains unavailable in the browser.",
  );

  type ActionPresentationState = {
    readonly status:
      | "proposed"
      | "materialized"
      | "reverted"
      | "completed"
      | "cancelled"
      | "unknown";
    readonly materialized: boolean | null;
  };
  const actionState = snapshot.actionEvents.reduce<ActionPresentationState>(
    (state, event) => {
      if (event.type === "edit.materialized" || event.type === "restore.completed") {
        return { status: "materialized", materialized: true };
      }
      if (event.type === "rollback.completed") {
        return { status: "reverted", materialized: false };
      }
      if (event.type === "cancellation.completed") {
        if (state.materialized === null) {
          return { status: "unknown", materialized: null };
        }
        return {
          status: state.materialized ? "reverted" : "cancelled",
          materialized: false,
        };
      }
      if (event.type === "review.accepted") {
        return { status: "completed", materialized: true };
      }
      return state;
    },
    snapshot.eventCount === snapshot.events.length
      ? { status: "proposed", materialized: false }
      : { status: "unknown", materialized: null },
  );
  if (run.edit !== null && actionState.status === "unknown") {
    warnings.push(
      "Action status predates the bounded browser timeline; use the CLI for complete history.",
    );
  }
  const action =
    run.edit === null
      ? null
      : {
          status: actionState.status,
          kind: "one_exact_replacement",
          summary: "One exact replacement in the selected tracked text file",
          path: run.edit.path,
          files: [run.edit.path],
          rationale: run.edit.rationale,
          allowed: false,
        };

  return {
    id: run.id,
    projectId: run.projectId,
    task: run.task,
    target: run.target,
    phase: workspaceRunPhase(run.state),
    state: run.state,
    resumeState: run.resumeState,
    gate,
    provider: {
      kind: run.provider.kind,
      model: run.provider.model,
      baseUrl: run.provider.baseUrl,
      status: "configured",
      locality: run.provider.capabilities.locality,
      privacyClass: run.provider.capabilities.privacyClass,
    },
    baseCommit: run.baseCommit.length === 0 ? null : run.baseCommit,
    context:
      run.contextSha256.length === 0
        ? null
        : {
            target: run.context.target,
            baseCommit: run.context.baseCommit,
            sha256: run.contextSha256,
            totalBytes: run.context.totalBytes,
            repositoryMap: run.context.repositoryMap,
            entries: run.context.entries.map((entry) => ({
              path: entry.path,
              reason: entry.reason,
              bytes: entry.bytes,
              sha256: entry.sha256,
            })),
          },
    plan: run.plan,
    planSha256: run.planSha256,
    action,
    files: {
      involved: Array.from(
        new Set([
          ...run.context.repositoryMap,
          ...run.context.entries
            .filter((entry) => entry.path !== "<repository-map>")
            .map((entry) => entry.path),
          ...(run.verification?.changedPaths ?? []),
        ]),
      ),
      changed: run.verification?.changedPaths ?? [],
    },
    checks,
    verification:
      run.verification === null
        ? { outcome: "not_run", diffSha256: null, checkpointSha256: null }
        : {
            outcome: run.verification.outcome,
            diffSha256: run.verification.diffSha256,
            checkpointSha256: run.verification.checkpointSha256,
          },
    diff: run.diff,
    outputs,
    usage: run.usage,
    lastError: run.lastError,
    warnings,
    approvals: approvals(snapshot.approvals),
    approvalCoverage: {
      limit: snapshot.approvalCoverage.limit,
      loaded: snapshot.approvalCoverage.loaded,
      earlierApprovalsExcluded: snapshot.approvalCoverage.earlierApprovalsExcluded,
    },
    eventCursor: snapshot.eventCursor,
    timelineTotal: snapshot.eventCount,
    timelineTruncated: snapshot.eventCount > snapshot.events.length,
    timeline: timeline(snapshot.events),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    timestamps: {
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    },
  };
}
