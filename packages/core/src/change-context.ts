import { invariant } from "./errors.js";
import type {
  ChangeContextComponent,
  ChangeContextPacket,
  ChangeContextQuestion,
  ChangeContextReceipt,
  ChangeRoomCard,
  ChangeRoomCardKind,
  ChangeRoomProjection,
  PatchsetActionStatus,
} from "./types.js";
import { CHANGE_CONTEXT_SCHEMA } from "./types.js";

export const CHANGE_CONTEXT_QUESTIONS: readonly ChangeContextQuestion[] = [
  "why_blocked",
  "what_changed",
  "what_passed",
  "what_remains_before_review",
  "why_rolled_back",
];

const COMPONENT_LIMIT = 8;

function card(room: ChangeRoomProjection, kind: ChangeRoomCardKind): ChangeRoomCard {
  const found = room.cards.find((candidate) => candidate.kind === kind);
  invariant(found !== undefined, "DATABASE_ERROR", "Change Room card is missing");
  return found;
}

function receiptsFor(...cards: readonly ChangeRoomCard[]): ChangeContextReceipt[] {
  return cards.map((entry) => ({
    cardId: entry.id,
    eventSequences: entry.refs
      .filter((ref) => ref.kind === "event_sequence")
      .map((ref) => ref.sequence),
    digests: entry.refs.flatMap((ref) => {
      if (ref.kind === "approval") return [ref.digest];
      if (ref.kind === "digest" || ref.kind === "checkpoint") return [ref.sha256];
      return [];
    }),
  }));
}

function component(statement: string, ...cards: readonly ChangeRoomCard[]): ChangeContextComponent {
  return { statement, receipts: receiptsFor(...cards) };
}

function shortDigest(value: string | null | undefined): string {
  return value === null || value === undefined ? "none recorded" : value;
}

function whyBlocked(room: ChangeRoomProjection): {
  components: ChangeContextComponent[];
  omissions: string[];
  uncertainty: string[];
} {
  const terminal = card(room, "terminal_state");
  const base = card(room, "base_context");
  const plan = card(room, "provider_plan");
  const planApproval = card(room, "plan_approval");
  const outcomes = card(room, "check_outcomes");
  const review = card(room, "review_decision");
  const omissions: string[] = [];
  const uncertainty: string[] = [];
  const components: ChangeContextComponent[] = [];
  switch (room.state) {
    case "preparing":
      components.push(
        component(
          "This run is a persisted draft. Context assembly and planning have not run, so no approval gate is active yet.",
          card(room, "task_scope"),
          terminal,
        ),
      );
      break;
    case "awaiting_egress_approval":
      components.push(
        component(
          `The run is waiting for explicit context-egress approval of context digest ${shortDigest(
            base.kind === "base_context" ? base.body.contextSha256 : null,
          )}. Approve it with run approve-egress in the CLI or through the fenced browser mutation session (ADR 0029); this read-only room cannot approve anything.`,
          base,
        ),
      );
      break;
    case "planned":
      components.push(
        component(
          "Context egress was approved, but the provider plan call has not completed. Resume the run explicitly in the CLI.",
          base,
          plan,
        ),
      );
      break;
    case "awaiting_approval":
      components.push(
        component(
          `The run is waiting for plan approval of plan digest ${shortDigest(
            plan.kind === "provider_plan" ? plan.body.planSha256 : null,
          )}. Approve it with run approve in the CLI or through the fenced browser mutation session; no private worktree, edit call, or mutation may precede it.`,
          plan,
          planApproval,
        ),
      );
      break;
    case "running":
    case "verifying":
    case "rolling_back":
    case "restoring":
    case "cancelling":
      components.push(
        component(
          `The run is in the active ${room.state} stage. No human gate blocks it; waiting is for host work, not an approval.`,
          terminal,
        ),
      );
      break;
    case "awaiting_review": {
      const outcome = outcomes.kind === "check_outcomes" ? outcomes.body.outcome : "not_run";
      components.push(
        component(
          `Verification outcome is ${outcome}; the run is waiting for a review decision bound to diff digest ${shortDigest(
            outcomes.kind === "check_outcomes" ? outcomes.body.diffSha256 : null,
          )}.`,
          outcomes,
          review,
        ),
      );
      if (outcome !== "passed") {
        components.push(
          component(
            "Because verification did not pass, the change remains reviewable but cannot be accepted; review rejection performs the bounded rollback.",
            outcomes,
          ),
        );
      }
      break;
    }
    case "failed": {
      const lastError = terminal.kind === "terminal_state" ? terminal.body.lastError : null;
      const resumeState = terminal.kind === "terminal_state" ? terminal.body.resumeState : null;
      components.push(
        component(
          `The run failed${lastError === null ? "" : ` with ${lastError.code}: ${lastError.message}`}.`,
          terminal,
        ),
        component(
          `It stays blocked until an explicit CLI resume re-enters the persisted ${resumeState ?? "unknown"} stage; resume is never automatic.`,
          terminal,
        ),
      );
      break;
    }
    case "completed":
    case "cancelled":
    case "rolled_back":
      components.push(
        component(
          `The run is not blocked. It reached its terminal state: ${room.state}.`,
          terminal,
        ),
      );
      break;
  }
  if (room.integrity.timelineTruncated) {
    uncertainty.push(
      "The browser timeline is bounded to the newest events; earlier blocking causes may be visible only in CLI run history.",
    );
  }
  return { components, omissions, uncertainty };
}

function whatChanged(room: ChangeRoomProjection): {
  components: ChangeContextComponent[];
  omissions: string[];
  uncertainty: string[];
} {
  const patchset = card(room, "patchset");
  const outcomes = card(room, "check_outcomes");
  const review = card(room, "review_decision");
  const omissions: string[] = [];
  const uncertainty: string[] = [];
  const components: ChangeContextComponent[] = [];
  if (patchset.kind !== "patchset") {
    return { components, omissions, uncertainty };
  }
  const { patchSet, actionStatus, diffSha256, diffBytes, changedPaths } = patchset.body;
  if (patchSet === null) {
    components.push(
      component(
        "No PatchSet proposal exists yet, so nothing has changed. The run has not passed the plan-approval gate.",
        card(room, "provider_plan"),
        card(room, "plan_approval"),
      ),
    );
  } else {
    const editSummary = patchSet.edits.map((edit) => `${edit.op} ${edit.path}`).join("; ");
    components.push(
      component(
        `The provider proposed a PatchSet of ${patchSet.edits.length} file-scoped edit(s): ${editSummary}. The proposal remains untrusted until host validation and recorded approvals establish it.`,
        patchset,
      ),
    );
    const statusText: Record<Exclude<PatchsetActionStatus, "not_recorded">, string> = {
      proposed: "The proposal was recorded but is not known to be materialized.",
      materialized: "The PatchSet was applied inside the Icarus-private worktree.",
      reverted: "The PatchSet was reverted; baseline bytes were restored in the private worktree.",
      completed: "The PatchSet was applied and the review accepted the verified evidence.",
      cancelled: "The run was cancelled before the proposal completed.",
      unknown:
        "Whether the proposal is currently materialized predates the bounded browser timeline; use CLI run history for complete evidence.",
    };
    if (actionStatus !== "not_recorded") {
      components.push(component(statusText[actionStatus], patchset));
    }
    if (diffSha256 !== null) {
      components.push(
        component(
          `Verification recorded diff digest ${diffSha256} (${diffBytes ?? 0} bounded redacted bytes) across ${changedPaths.length} changed path(s): ${changedPaths.join(", ")}.`,
          patchset,
          outcomes,
        ),
      );
    }
  }
  const decision = review.kind === "review_decision" ? review.body.decision : null;
  if (decision !== null && decision.decision === "approve") {
    components.push(
      component(
        "Review accepted the change. It exists in the Icarus-private worktree; any branch, commit, or draft-PR landing requires a separate recorded landing grant, which this projection does not track.",
        review,
        patchset,
      ),
    );
  }
  if (patchSet !== null && diffSha256 === null) {
    omissions.push("No verified diff evidence exists; verification has not completed.");
  }
  return { components, omissions, uncertainty };
}

function whatPassed(room: ChangeRoomProjection): {
  components: ChangeContextComponent[];
  omissions: string[];
  uncertainty: string[];
} {
  const outcomes = card(room, "check_outcomes");
  const omissions: string[] = [];
  const uncertainty: string[] = [];
  const components: ChangeContextComponent[] = [];
  if (outcomes.kind !== "check_outcomes") {
    return { components, omissions, uncertainty };
  }
  if (outcomes.body.outcome === "not_run") {
    components.push(
      component(
        "No verification has run, so no check has passed. An absent result is never presented as a pass.",
        outcomes,
        card(room, "registered_checks"),
      ),
    );
  } else {
    components.push(
      component(
        `Latest verification outcome: ${outcomes.body.outcome}, recorded in the no-network sandbox against the private worktree export.`,
        outcomes,
      ),
    );
    for (const entry of outcomes.body.checks) {
      components.push(
        component(
          `Check ${entry.id} (${entry.name}): ${entry.outcome}${
            entry.exitCode === null ? "" : `, exit ${entry.exitCode}`
          }${entry.truncated ? "; output was truncated and redacted" : ""}.`,
          outcomes,
        ),
      );
    }
  }
  if (outcomes.body.checks.some((entry) => entry.truncated)) {
    omissions.push("Some check output was truncated and redacted at persistence time.");
  }
  uncertainty.push(
    "Earlier verification attempts are not replayed here; the bounded verification-attempt provenance view and CLI history retain them.",
  );
  return { components, omissions, uncertainty };
}

function whatRemains(room: ChangeRoomProjection): {
  components: ChangeContextComponent[];
  omissions: string[];
  uncertainty: string[];
} {
  const base = card(room, "base_context");
  const plan = card(room, "provider_plan");
  const planApproval = card(room, "plan_approval");
  const patchset = card(room, "patchset");
  const outcomes = card(room, "check_outcomes");
  const review = card(room, "review_decision");
  const terminal = card(room, "terminal_state");
  const omissions: string[] = [];
  const uncertainty: string[] = [];
  const components: ChangeContextComponent[] = [];
  switch (room.state) {
    case "preparing":
      components.push(
        component(
          "Planning must run first: context assembly, provider plan, and the plan digest.",
          card(room, "task_scope"),
          plan,
        ),
      );
      break;
    case "awaiting_egress_approval":
      components.push(
        component("Context-egress approval is required before any bytes leave the host.", base),
      );
      break;
    case "planned":
    case "awaiting_approval":
      components.push(
        component(
          "Plan approval bound to the recorded plan digest is required before a private worktree, edit call, or mutation.",
          plan,
          planApproval,
        ),
      );
      break;
    case "running":
    case "verifying":
      components.push(
        component(
          "The active execution stage must finish: private worktree edit, no-network sandbox verification, and persisted diff evidence.",
          patchset,
          outcomes,
        ),
      );
      break;
    case "awaiting_review": {
      const outcome = outcomes.kind === "check_outcomes" ? outcomes.body.outcome : "not_run";
      components.push(
        component(
          "Nothing remains before review: verification evidence is persisted and the run awaits a review decision (CLI or fenced browser session).",
          outcomes,
          review,
        ),
      );
      if (outcome !== "passed") {
        components.push(
          component(
            "Review approval is impossible because verification did not pass; only rejection (bounded rollback) or rollback remains.",
            outcomes,
            review,
          ),
        );
      }
      break;
    }
    case "rolling_back":
    case "restoring":
    case "cancelling":
      components.push(
        component(
          `The run is landing through the active ${room.state} recovery stage; review follows only after it completes.`,
          terminal,
        ),
      );
      break;
    case "failed":
      components.push(
        component(
          "The run must be explicitly resumed in the CLI before any further stage can complete.",
          terminal,
        ),
      );
      break;
    case "completed":
    case "cancelled":
    case "rolled_back":
      components.push(component(`Nothing remains. The run is terminal (${room.state}).`, terminal));
      break;
  }
  return { components, omissions, uncertainty };
}

function whyRolledBack(room: ChangeRoomProjection): {
  components: ChangeContextComponent[];
  omissions: string[];
  uncertainty: string[];
} {
  const recovery = card(room, "rollback_restoration");
  const review = card(room, "review_decision");
  const terminal = card(room, "terminal_state");
  const outcomes = card(room, "check_outcomes");
  const omissions: string[] = [];
  const uncertainty: string[] = [];
  const components: ChangeContextComponent[] = [];
  const records = recovery.kind === "rollback_restoration" ? recovery.body.records : [];
  const rollbackRecord = records.find((record) => record.kind === "rollback");
  const decision = review.kind === "review_decision" ? review.body.decision : null;
  if (
    rollbackRecord === undefined &&
    room.state !== "rolled_back" &&
    room.state !== "rolling_back"
  ) {
    components.push(
      component(
        `No rollback is recorded for this run; its current state is ${room.state}.`,
        recovery,
        terminal,
      ),
    );
    omissions.push("The question assumes a rollback that this run has not recorded.");
  } else {
    if (decision !== null && decision.decision === "reject") {
      components.push(
        component(
          `Review rejected the change by operator decision (actor ${decision.actor}); rejection performed the bounded rollback of baseline bytes in the private worktree.`,
          review,
          recovery,
        ),
      );
    } else if (rollbackRecord !== undefined) {
      components.push(
        component(
          `An explicit operator rollback was approved (actor ${rollbackRecord.actor}) and baseline bytes were restored in the private worktree.`,
          recovery,
        ),
      );
    }
    const outcome = outcomes.kind === "check_outcomes" ? outcomes.body.outcome : "not_run";
    if (outcome !== "not_run") {
      components.push(
        component(
          `The latest recorded verification outcome before rollback was ${outcome}.`,
          outcomes,
        ),
      );
    }
    if (room.state === "rolled_back") {
      components.push(
        component(
          "The run is terminally rolled_back. The recorded checkpoint is preserved, so an explicit CLI restore can still rewrite only the approved bytes and rerun verification.",
          terminal,
          card(room, "checkpoint"),
        ),
      );
    }
    uncertainty.push(
      "Recorded evidence shows who decided and what bytes were restored, not a free-text reason; no reason field exists in the authoritative record.",
    );
  }
  return { components, omissions, uncertainty };
}

export function buildChangeContext(
  room: ChangeRoomProjection,
  question: ChangeContextQuestion,
): ChangeContextPacket {
  invariant(
    CHANGE_CONTEXT_QUESTIONS.includes(question),
    "INVALID_REQUEST",
    "Change-context question is invalid",
  );
  const answered =
    question === "why_blocked"
      ? whyBlocked(room)
      : question === "what_changed"
        ? whatChanged(room)
        : question === "what_passed"
          ? whatPassed(room)
          : question === "what_remains_before_review"
            ? whatRemains(room)
            : whyRolledBack(room);
  return {
    schema: CHANGE_CONTEXT_SCHEMA,
    roomId: room.roomId,
    eventCursor: room.integrity.eventCursor,
    question,
    components: answered.components.slice(0, COMPONENT_LIMIT),
    omissions: answered.omissions,
    uncertainty: answered.uncertainty,
    generatedBy: "deterministic_host_projection",
  };
}
