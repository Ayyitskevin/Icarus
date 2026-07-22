import { createHash } from "node:crypto";

import {
  type ApprovalRecord,
  type EventRecord,
  type EventSummaryRecord,
  IcarusError,
  type ProjectRecord,
  type ProjectRepositoryStatus,
  type RepositoryRecord,
  type RunEventHistoryPage,
  type RunEventPage,
  type RunPresentationSnapshot,
  type RunRecord,
  type RunState,
  type RunVerificationAttemptsSnapshot,
  type WorkspaceProjectPage,
  type WorkspaceRunPage,
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
  | "diff"
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

export function presentWorkspaceProjectPage(page: WorkspaceProjectPage): Record<string, unknown> {
  return {
    before: page.before,
    snapshot: page.snapshot,
    nextBefore: page.nextBefore,
    hasMore: page.hasMore,
    projects: page.projects.map(({ project, repository }) => presentProject(project, repository)),
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
  if (type === "checkpoint.saved") return "verification";
  if (type === "verification.completed") return "diff";
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

export const WORKSPACE_DIFF_DISPLAY_MAX_BYTES = 256 * 1024;

type PersistedDiffReview =
  | {
      readonly status: "not_produced";
      readonly path: null;
      readonly sha256: null;
      readonly byteCount: 0;
      readonly lineCount: 0;
      readonly addedLines: 0;
      readonly deletedLines: 0;
      readonly hunkCount: 0;
      readonly browserByteLimit: typeof WORKSPACE_DIFF_DISPLAY_MAX_BYTES;
      readonly digestProvenance: "not_available";
    }
  | {
      readonly status: "available";
      readonly path: string;
      readonly sha256: string;
      readonly byteCount: number;
      readonly lineCount: number;
      readonly addedLines: number;
      readonly deletedLines: number;
      readonly hunkCount: number;
      readonly browserByteLimit: typeof WORKSPACE_DIFF_DISPLAY_MAX_BYTES;
      readonly digestProvenance: "displayed_text_rehash_match";
    }
  | {
      readonly status: "outside_browser_bound";
      readonly path: string;
      readonly sha256: string;
      readonly byteCount: number;
      readonly lineCount: null;
      readonly addedLines: null;
      readonly deletedLines: null;
      readonly hunkCount: null;
      readonly browserByteLimit: typeof WORKSPACE_DIFF_DISPLAY_MAX_BYTES;
      readonly digestProvenance: "recorded_only";
    };

interface PresentedPersistedDiff {
  readonly text: string | null;
  readonly review: PersistedDiffReview;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DIFF_HUNK_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;
const DIFF_INDEX_PATTERN = /^index [a-f0-9]{7,64}\.\.[a-f0-9]{7,64} [0-7]{6}$/;
const DIFF_NO_NEWLINE_MARKER = "\\ No newline at end of file";
const VERIFICATION_OUTCOMES = new Set(["passed", "failed", "unavailable"]);

function invalidPersistedDiff(): never {
  throw new IcarusError("DATABASE_ERROR", "Persisted diff evidence is invalid");
}

function decodeGitPathToken(token: string): string {
  if (!token.startsWith('"')) {
    if (token.length === 0 || /[\s"]/u.test(token)) invalidPersistedDiff();
    return token;
  }
  if (token.length < 2 || token.at(-1) !== '"') invalidPersistedDiff();

  const bytes: number[] = [];
  const simpleEscapes: Readonly<Record<string, string>> = {
    '"': '"',
    "\\": "\\",
    a: "\u0007",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
  };
  for (let index = 1; index < token.length - 1; ) {
    const codePoint = token.codePointAt(index);
    if (codePoint === undefined) invalidPersistedDiff();
    const character = String.fromCodePoint(codePoint);
    if (character !== "\\") {
      if (character === '"') invalidPersistedDiff();
      bytes.push(...Buffer.from(character, "utf8"));
      index += character.length;
      continue;
    }

    const escaped = token[index + 1];
    if (escaped === undefined || index + 1 >= token.length - 1) invalidPersistedDiff();
    if (/[0-7]/u.test(escaped)) {
      const octal = token.slice(index + 1, index + 4);
      if (!/^[0-7]{3}$/u.test(octal) || index + 4 > token.length - 1) {
        invalidPersistedDiff();
      }
      bytes.push(Number.parseInt(octal, 8));
      index += 4;
      continue;
    }
    const decoded = simpleEscapes[escaped];
    if (decoded === undefined) invalidPersistedDiff();
    bytes.push(...Buffer.from(decoded, "utf8"));
    index += 2;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return invalidPersistedDiff();
  }
}

function parseGitPathFields(value: string, count: number): readonly string[] {
  const fields: string[] = [];
  let index = 0;
  while (fields.length < count) {
    if (index >= value.length || value[index] === " ") invalidPersistedDiff();
    const start = index;
    if (value[index] === '"') {
      index += 1;
      let closed = false;
      while (index < value.length) {
        if (value[index] === "\\") {
          index += 2;
          continue;
        }
        if (value[index] === '"') {
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) invalidPersistedDiff();
    } else {
      while (index < value.length && value[index] !== " ") index += 1;
    }
    fields.push(decodeGitPathToken(value.slice(start, index)));
    if (fields.length < count) {
      if (value[index] !== " " || value[index + 1] === " ") invalidPersistedDiff();
      index += 1;
    }
  }
  if (index !== value.length) invalidPersistedDiff();
  return fields;
}

function assertDiffHeaderTarget(value: string, target: string): void {
  if (value === `a/${target} b/${target}`) return;
  const [oldPath, newPath] = parseGitPathFields(value, 2);
  if (oldPath !== `a/${target}` || newPath !== `b/${target}`) invalidPersistedDiff();
}

function assertFileHeaderTarget(line: string, prefix: "--- " | "+++ ", target: string): void {
  if (!line.startsWith(prefix)) invalidPersistedDiff();
  const expected = `${prefix === "--- " ? "a" : "b"}/${target}`;
  const value = line.slice(prefix.length);
  if (value === expected || value === `${expected}\t`) return;
  const quotedValue = value.endsWith("\t") ? value.slice(0, -1) : value;
  const [decoded] = parseGitPathFields(quotedValue, 1);
  if (decoded !== expected) invalidPersistedDiff();
}

function parseHunkNumber(value: string | undefined, fallback?: number): number {
  const parsed = value === undefined ? fallback : Number.parseInt(value, 10);
  if (parsed === undefined || !Number.isSafeInteger(parsed) || parsed < 0) {
    invalidPersistedDiff();
  }
  return parsed;
}

function inspectDisplayedPatch(
  diff: string,
  target: string,
): {
  readonly lineCount: number;
  readonly addedLines: number;
  readonly deletedLines: number;
  readonly hunkCount: number;
} {
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length < 7 || !lines[0]?.startsWith("diff --git ")) invalidPersistedDiff();

  assertDiffHeaderTarget(lines[0].slice(11), target);
  if (!DIFF_INDEX_PATTERN.test(lines[1] ?? "")) invalidPersistedDiff();
  assertFileHeaderTarget(lines[2] ?? "", "--- ", target);
  assertFileHeaderTarget(lines[3] ?? "", "+++ ", target);

  let index = 4;
  let hunkCount = 0;
  let addedLines = 0;
  let deletedLines = 0;
  while (index < lines.length) {
    const match = DIFF_HUNK_PATTERN.exec(lines[index] ?? "");
    if (match === null) invalidPersistedDiff();
    parseHunkNumber(match[1]);
    const expectedOldLines = parseHunkNumber(match[2], 1);
    parseHunkNumber(match[3]);
    const expectedNewLines = parseHunkNumber(match[4], 1);
    hunkCount += 1;
    index += 1;

    let oldLines = 0;
    let newLines = 0;
    let mayHaveNoNewlineMarker = false;
    while (oldLines < expectedOldLines || newLines < expectedNewLines) {
      const line = lines[index];
      if (line === undefined) invalidPersistedDiff();
      if (line === DIFF_NO_NEWLINE_MARKER) {
        if (!mayHaveNoNewlineMarker) invalidPersistedDiff();
        mayHaveNoNewlineMarker = false;
        index += 1;
        continue;
      }
      mayHaveNoNewlineMarker = false;
      const prefix = line[0];
      if (prefix === " ") {
        oldLines += 1;
        newLines += 1;
      } else if (prefix === "-") {
        oldLines += 1;
        deletedLines += 1;
      } else if (prefix === "+") {
        newLines += 1;
        addedLines += 1;
      } else {
        invalidPersistedDiff();
      }
      if (oldLines > expectedOldLines || newLines > expectedNewLines) invalidPersistedDiff();
      mayHaveNoNewlineMarker = true;
      index += 1;
    }
    if (lines[index] === DIFF_NO_NEWLINE_MARKER) {
      if (!mayHaveNoNewlineMarker) invalidPersistedDiff();
      index += 1;
    }
  }
  if (hunkCount === 0 || addedLines + deletedLines === 0) invalidPersistedDiff();
  return { lineCount: lines.length, addedLines, deletedLines, hunkCount };
}

function presentPersistedDiff(project: ProjectRecord, run: RunRecord): PresentedPersistedDiff {
  if (run.diff === null) {
    if (run.verification !== null) invalidPersistedDiff();
    return {
      text: null,
      review: {
        status: "not_produced",
        path: null,
        sha256: null,
        byteCount: 0,
        lineCount: 0,
        addedLines: 0,
        deletedLines: 0,
        hunkCount: 0,
        browserByteLimit: WORKSPACE_DIFF_DISPLAY_MAX_BYTES,
        digestProvenance: "not_available",
      },
    };
  }

  const verification = run.verification;
  if (
    verification === null ||
    typeof verification !== "object" ||
    Array.isArray(verification) ||
    run.diff.length === 0 ||
    run.diff.includes("\0") ||
    typeof verification.outcome !== "string" ||
    !VERIFICATION_OUTCOMES.has(verification.outcome) ||
    !Array.isArray(verification.checks) ||
    !Array.isArray(verification.changedPaths) ||
    typeof verification.diffSha256 !== "string" ||
    !SHA256_PATTERN.test(verification.diffSha256) ||
    typeof verification.checkpointSha256 !== "string" ||
    !SHA256_PATTERN.test(verification.checkpointSha256) ||
    verification.changedPaths.length !== 1 ||
    verification.changedPaths[0] !== run.target
  ) {
    invalidPersistedDiff();
  }
  const byteCount = Buffer.byteLength(run.diff, "utf8");
  if (byteCount <= 0 || byteCount > project.ceiling.maxDiffBytes) invalidPersistedDiff();

  if (byteCount > WORKSPACE_DIFF_DISPLAY_MAX_BYTES) {
    return {
      text: null,
      review: {
        status: "outside_browser_bound",
        path: run.target,
        sha256: verification.diffSha256,
        byteCount,
        lineCount: null,
        addedLines: null,
        deletedLines: null,
        hunkCount: null,
        browserByteLimit: WORKSPACE_DIFF_DISPLAY_MAX_BYTES,
        digestProvenance: "recorded_only",
      },
    };
  }

  const displayedSha256 = createHash("sha256").update(run.diff, "utf8").digest("hex");
  if (displayedSha256 !== verification.diffSha256) invalidPersistedDiff();

  const { lineCount, addedLines, deletedLines, hunkCount } = inspectDisplayedPatch(
    run.diff,
    run.target,
  );

  return {
    text: run.diff,
    review: {
      status: "available",
      path: run.target,
      sha256: verification.diffSha256,
      byteCount,
      lineCount,
      addedLines,
      deletedLines,
      hunkCount,
      browserByteLimit: WORKSPACE_DIFF_DISPLAY_MAX_BYTES,
      digestProvenance: "displayed_text_rehash_match",
    },
  };
}

export function presentRun(
  project: ProjectRecord,
  snapshot: RunPresentationSnapshot,
): Record<string, unknown> {
  const run: RunRecord = snapshot.run;
  const persistedDiff = presentPersistedDiff(project, run);
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
    diff: persistedDiff.text,
    diffReview: persistedDiff.review,
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
