import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type {
  ChangeContextPacketView,
  ChangeContextQuestion,
  ChangeRoomAnnotationView,
  ChangeRoomApprovalView,
  ChangeRoomCardStatus,
  ChangeRoomCardView,
  ChangeRoomDetailView,
  ChangeRoomEvidenceRefView,
  ChangeRoomProvenanceClass,
  ChangeRoomSummaryView,
  CheckOutcomeStatusView,
  ProjectView,
  RunStateView,
} from "./api.js";
import { errorMessage, getChangeContext, getChangeRoom, getChangeRoomPage } from "./api.js";
import type {
  ChangeRoomPageDirection,
  ChangeRoomPageRequest,
  ChangeRoomPageSession,
} from "./change-room.js";
import {
  acceptChangeContextPacket,
  acceptChangeRoom,
  acceptChangeRoomPage,
  canNavigateToNewerRooms,
  canNavigateToOlderRooms,
  CHANGE_ROOM_PAGE_MAX_PAGES,
  CHANGE_ROOM_PAGE_SIZE,
  changeRoomPageDepth,
  changeRoomPageRequest,
  createChangeRoomPageSession,
} from "./change-room.js";

const QUESTIONS: readonly { readonly value: ChangeContextQuestion; readonly label: string }[] = [
  { value: "why_blocked", label: "Why is it blocked?" },
  { value: "what_changed", label: "What changed?" },
  { value: "what_passed", label: "What passed?" },
  { value: "what_remains_before_review", label: "What remains before review?" },
  { value: "why_rolled_back", label: "Why was it rolled back?" },
];

function questionLabel(question: ChangeContextQuestion): string {
  return QUESTIONS.find((entry) => entry.value === question)?.label ?? question;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString();
}

function shortDigest(value: string): string {
  return `${value.slice(0, 12)}…`;
}

function stateLabel(state: RunStateView): string {
  return state.replaceAll("_", " ");
}

function verificationOutcomeClass(outcome: string): string {
  if (outcome === "passed") return "status status--positive";
  if (outcome === "failed" || outcome === "unavailable") return "status status--negative";
  return "status status--neutral";
}

function cardStatusLabel(status: ChangeRoomCardStatus): string {
  switch (status) {
    case "available":
      return "evidence available";
    case "pending":
      return "pending — not yet recorded";
    case "not_applicable":
      return "not applicable";
    case "unavailable":
      return "evidence unavailable";
  }
}

function cardStatusClass(status: ChangeRoomCardStatus): string {
  switch (status) {
    case "available":
      return "status status--info";
    case "pending":
      return "status status--warning";
    case "not_applicable":
      return "status status--neutral";
    case "unavailable":
      return "status status--negative";
  }
}

function provenanceLabel(provenance: ChangeRoomProvenanceClass): string {
  switch (provenance) {
    case "operator_assertion":
      return "Operator assertion";
    case "provider_output":
      return "Provider output — untrusted until host checks and approvals";
    case "host_fact":
      return "Host-derived fact";
    case "approval_decision":
      return "Recorded approval decision";
    case "verification_evidence":
      return "Sandbox verification evidence";
    case "system_failure":
      return "Recorded system failure";
  }
}

function decisionClass(decision: string): string {
  return decision === "approve" ? "status status--positive" : "status status--negative";
}

function checkOutcomeClass(outcome: CheckOutcomeStatusView): string {
  switch (outcome) {
    case "passed":
      return "status status--positive";
    case "failed":
      return "status status--negative";
    case "unavailable":
    case "cancelled":
    case "not_run":
      return "status status--warning";
  }
}

function refKey(ref: ChangeRoomEvidenceRefView, index: number): string {
  switch (ref.kind) {
    case "event_sequence":
      return `event-${ref.sequence}`;
    case "approval":
      return `approval-${ref.approvalKind}-${ref.digest}`;
    case "digest":
      return `digest-${ref.label}-${ref.sha256}`;
    case "checkpoint":
      return `checkpoint-${ref.sha256}-${index}`;
  }
}

function RefList({ refs }: { readonly refs: readonly ChangeRoomEvidenceRefView[] }) {
  if (refs.length === 0) return null;
  return (
    <ul className="change-room-card__refs">
      {refs.map((ref, index) => (
        <li key={refKey(ref, index)}>
          {ref.kind === "event_sequence" ? (
            <>event #{ref.sequence}</>
          ) : ref.kind === "approval" ? (
            <>
              {ref.approvalKind} approval{" "}
              <code className="digest" title={ref.digest}>
                {shortDigest(ref.digest)}
              </code>
            </>
          ) : ref.kind === "digest" ? (
            <>
              {ref.label} digest{" "}
              <code className="digest" title={ref.sha256}>
                {shortDigest(ref.sha256)}
              </code>
            </>
          ) : (
            <>
              checkpoint{" "}
              <code className="digest" title={ref.sha256}>
                {shortDigest(ref.sha256)}
              </code>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

function IndicatorBadges({ card }: { readonly card: ChangeRoomCardView }) {
  const badges: string[] = [];
  if (card.indicators.truncated) badges.push("truncated");
  if (card.indicators.redacted) badges.push("redacted");
  if (card.indicators.unavailableEvidence) badges.push("unavailable evidence");
  if (badges.length === 0) return null;
  return (
    <span className="change-room-card__badges">
      {badges.map((badge) => (
        <span key={badge} className="status status--warning">
          {badge}
        </span>
      ))}
    </span>
  );
}

function ApprovalFacts({
  approval,
  emptyMessage,
}: {
  readonly approval: ChangeRoomApprovalView | null;
  readonly emptyMessage: string;
}) {
  if (approval === null) {
    return <p className="empty-state">{emptyMessage}</p>;
  }
  return (
    <dl className="facts facts--compact">
      <div>
        <dt>Actor</dt>
        <dd>{approval.actor}</dd>
      </div>
      <div>
        <dt>Decision</dt>
        <dd>
          <span className={decisionClass(approval.decision)}>{approval.decision}</span>
        </dd>
      </div>
      <div>
        <dt>Bound digest</dt>
        <dd className="digest">{approval.digest}</dd>
      </div>
      <div>
        <dt>Recorded</dt>
        <dd>
          <time dateTime={approval.createdAt}>{formatTimestamp(approval.createdAt)}</time>
        </dd>
      </div>
    </dl>
  );
}

function AnnotationList({
  annotations,
}: {
  readonly annotations: readonly ChangeRoomAnnotationView[];
}) {
  if (annotations.length === 0) return null;
  return (
    <ul className="change-room-annotations">
      {annotations.map((annotation) => (
        <li key={annotation.id}>
          <p>{annotation.body}</p>
          <small>
            {annotation.actor} ·{" "}
            <time dateTime={annotation.createdAt}>{formatTimestamp(annotation.createdAt)}</time>
          </small>
        </li>
      ))}
    </ul>
  );
}

function CardBody({ card }: { readonly card: ChangeRoomCardView }) {
  switch (card.kind) {
    case "task_scope":
      return (
        <dl className="facts facts--compact">
          <div>
            <dt>Task</dt>
            <dd>{card.body.task}</dd>
          </div>
          <div>
            <dt>Target</dt>
            <dd>{card.body.target}</dd>
          </div>
          <div>
            <dt>Project</dt>
            <dd>
              {card.body.projectName} <small>({card.body.projectId})</small>
            </dd>
          </div>
          <div>
            <dt>Base ref</dt>
            <dd>{card.body.baseRef}</dd>
          </div>
        </dl>
      );
    case "base_context": {
      const body = card.body;
      return (
        <>
          <dl className="facts facts--compact">
            <div>
              <dt>Base commit</dt>
              <dd className="digest">{body.baseCommit ?? "Not pinned"}</dd>
            </div>
            <div>
              <dt>Context digest</dt>
              <dd className="digest">{body.contextSha256 ?? "Not pinned"}</dd>
            </div>
            <div>
              <dt>Context target</dt>
              <dd>{body.target ?? "Not pinned"}</dd>
            </div>
            <div>
              <dt>Context size</dt>
              <dd>{body.totalBytes === null ? "Not pinned" : formatBytes(body.totalBytes)}</dd>
            </div>
            <div>
              <dt>Audit policy</dt>
              <dd>{body.auditPolicyVersion ?? "Not pinned"}</dd>
            </div>
            <div>
              <dt>Context egress</dt>
              <dd>
                <span
                  className={
                    body.egress.state === "approved" ||
                    body.egress.state === "not_required_loopback"
                      ? "status status--info"
                      : body.egress.state === "awaiting_approval"
                        ? "status status--warning"
                        : "status status--neutral"
                  }
                >
                  {body.egress.state.replaceAll("_", " ")}
                </span>
              </dd>
            </div>
          </dl>
          {body.egress.approval === null ? null : (
            <dl className="facts facts--compact">
              <div>
                <dt>Egress approved by</dt>
                <dd>{body.egress.approval.actor}</dd>
              </div>
              <div>
                <dt>Context digest bound</dt>
                <dd className="digest">{body.egress.approval.digest}</dd>
              </div>
              <div>
                <dt>Recorded</dt>
                <dd>
                  <time dateTime={body.egress.approval.createdAt}>
                    {formatTimestamp(body.egress.approval.createdAt)}
                  </time>
                </dd>
              </div>
            </dl>
          )}
          {body.repositoryMap.length === 0 ? null : (
            <details>
              <summary>Repository map ({body.repositoryMap.length} paths)</summary>
              <ul className="plain-list">
                {body.repositoryMap.map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
            </details>
          )}
          {body.entries.length === 0 ? null : (
            <details>
              <summary>Context entries ({body.entries.length} files)</summary>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Path</th>
                      <th>Reason</th>
                      <th>Bytes</th>
                      <th>Digest</th>
                    </tr>
                  </thead>
                  <tbody>
                    {body.entries.map((entry) => (
                      <tr key={entry.path}>
                        <td>{entry.path}</td>
                        <td>{entry.reason.replaceAll("_", " ")}</td>
                        <td>{entry.bytes}</td>
                        <td>
                          <code className="digest" title={entry.sha256}>
                            {shortDigest(entry.sha256)}
                          </code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </>
      );
    }
    case "provider_plan": {
      const body = card.body;
      return (
        <>
          <p className="change-room-card__note">
            <span className="status status--warning">untrusted proposal</span> This plan is provider
            output. It is not host-validated truth and implies no approval, edit, or execution.
          </p>
          <dl className="facts facts--compact">
            <div>
              <dt>Provider</dt>
              <dd>
                {body.provider.kind} · {body.provider.model}
              </dd>
            </div>
            <div>
              <dt>Locality</dt>
              <dd>{body.provider.locality}</dd>
            </div>
            <div>
              <dt>Privacy class</dt>
              <dd>{body.provider.privacyClass.replaceAll("_", " ")}</dd>
            </div>
            <div>
              <dt>Plan digest</dt>
              <dd className="digest">{body.planSha256 ?? "Not recorded"}</dd>
            </div>
          </dl>
          {body.plan === null ? (
            <p className="empty-state">No provider plan is recorded for this run.</p>
          ) : (
            <>
              <p>{body.plan.summary}</p>
              <h5>Proposed steps</h5>
              <ol className="plain-list">
                {body.plan.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              {body.plan.risks.length === 0 ? null : (
                <>
                  <h5>Declared risks</h5>
                  <ul className="plain-list">
                    {body.plan.risks.map((risk) => (
                      <li key={risk}>{risk}</li>
                    ))}
                  </ul>
                </>
              )}
              <dl className="facts facts--compact">
                <div>
                  <dt>Plan target</dt>
                  <dd>{body.plan.target}</dd>
                </div>
                <div>
                  <dt>Selected checks</dt>
                  <dd>{body.plan.checkIds.join(", ")}</dd>
                </div>
              </dl>
            </>
          )}
        </>
      );
    }
    case "plan_approval":
      return (
        <ApprovalFacts
          approval={card.body.approval}
          emptyMessage="No plan approval is recorded. Approvals happen only in the CLI; the browser cannot approve."
        />
      );
    case "patchset": {
      const body = card.body;
      return (
        <>
          <dl className="facts facts--compact">
            <div>
              <dt>Action status</dt>
              <dd>
                <span
                  className={
                    body.actionStatus === "not_recorded" || body.actionStatus === "unknown"
                      ? "status status--neutral"
                      : body.actionStatus === "reverted" || body.actionStatus === "cancelled"
                        ? "status status--warning"
                        : "status status--info"
                  }
                >
                  {body.actionStatus.replaceAll("_", " ")}
                </span>
              </dd>
            </div>
            <div>
              <dt>Diff digest</dt>
              <dd className="digest">{body.diffSha256 ?? "Not recorded"}</dd>
            </div>
            <div>
              <dt>Diff size</dt>
              <dd>{body.diffBytes === null ? "Not recorded" : formatBytes(body.diffBytes)}</dd>
            </div>
            <div>
              <dt>Changed paths</dt>
              <dd>
                {body.changedPaths.length === 0 ? "None recorded" : body.changedPaths.join(", ")}
              </dd>
            </div>
          </dl>
          {body.action === null ? (
            <p className="empty-state">No edit proposal is recorded for this run.</p>
          ) : (
            <dl className="facts facts--compact">
              <div>
                <dt>Proposal path</dt>
                <dd>{body.action.path}</dd>
              </div>
              <div>
                <dt>Expected preimage digest</dt>
                <dd className="digest">{body.action.expectedPreimageSha256}</dd>
              </div>
              <div>
                <dt>Provider rationale</dt>
                <dd>{body.action.rationale}</dd>
              </div>
            </dl>
          )}
          {body.diff === null ? null : (
            <details>
              <summary>
                Bounded redacted diff ({body.diffBytes ?? 0} bytes) — plain text, review only
              </summary>
              <pre>{body.diff}</pre>
            </details>
          )}
          <p className="change-room-card__note">{body.note}</p>
        </>
      );
    }
    case "registered_checks": {
      const body = card.body;
      return (
        <>
          {body.checks.length === 0 ? (
            <p className="empty-state">No verification checks are registered for this project.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Check</th>
                    <th>Name</th>
                    <th>Command</th>
                  </tr>
                </thead>
                <tbody>
                  {body.checks.map((check) => (
                    <tr key={check.id}>
                      <td>{check.id}</td>
                      <td>{check.name}</td>
                      <td>
                        <code>{check.argv.join(" ")}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <dl className="facts facts--compact">
            <div>
              <dt>Sandbox image</dt>
              <dd>{body.sandbox.image}</dd>
            </div>
            <div>
              <dt>CPUs</dt>
              <dd>{body.sandbox.cpus}</dd>
            </div>
            <div>
              <dt>Memory</dt>
              <dd>{body.sandbox.memoryMb} MiB</dd>
            </div>
            <div>
              <dt>Pids</dt>
              <dd>{body.sandbox.pids}</dd>
            </div>
            <div>
              <dt>Tmpfs</dt>
              <dd>{body.sandbox.tmpfsMb} MiB</dd>
            </div>
          </dl>
        </>
      );
    }
    case "check_outcomes": {
      const body = card.body;
      return (
        <>
          <dl className="facts facts--compact">
            <div>
              <dt>Latest outcome</dt>
              <dd>
                <span className={verificationOutcomeClass(body.outcome)}>
                  {body.outcome.replaceAll("_", " ")}
                </span>
              </dd>
            </div>
            <div>
              <dt>Diff digest</dt>
              <dd className="digest">{body.diffSha256 ?? "Not recorded"}</dd>
            </div>
            <div>
              <dt>Checkpoint digest</dt>
              <dd className="digest">{body.checkpointSha256 ?? "Not recorded"}</dd>
            </div>
          </dl>
          {body.checks.length === 0 ? (
            <p className="empty-state">No check results are recorded.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Check</th>
                    <th>Outcome</th>
                    <th>Exit</th>
                    <th>Signal</th>
                    <th>Duration</th>
                    <th>Output</th>
                  </tr>
                </thead>
                <tbody>
                  {body.checks.map((check) => {
                    const hasOutput = check.stdout.length > 0 || check.stderr.length > 0;
                    return (
                      <Fragment key={check.id}>
                        <tr>
                          <td>
                            {check.id}
                            <br />
                            <small>{check.name}</small>
                          </td>
                          <td>
                            <span className={checkOutcomeClass(check.outcome)}>
                              {check.outcome.replaceAll("_", " ")}
                            </span>
                          </td>
                          <td>{check.exitCode ?? "—"}</td>
                          <td>{check.signal ?? "—"}</td>
                          <td>
                            {check.durationMs === null ? "—" : `${Math.round(check.durationMs)} ms`}
                          </td>
                          <td>
                            {check.truncated ? (
                              <span className="status status--warning">truncated</span>
                            ) : (
                              "complete"
                            )}
                          </td>
                        </tr>
                        {hasOutput ? (
                          <tr className="change-room-check-output">
                            <td colSpan={6}>
                              <details>
                                <summary>Captured stdout and stderr for {check.id}</summary>
                                {check.stdout.length === 0 ? null : (
                                  <>
                                    <h5>stdout</h5>
                                    <pre>{check.stdout}</pre>
                                  </>
                                )}
                                {check.stderr.length === 0 ? null : (
                                  <>
                                    <h5>stderr</h5>
                                    <pre>{check.stderr}</pre>
                                  </>
                                )}
                              </details>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {body.outcome === "not_run" ? (
            <p className="change-room-card__note">
              Verification has not run for this run. An absent result is never evidence of a pass.
            </p>
          ) : null}
        </>
      );
    }
    case "review_decision":
      return (
        <ApprovalFacts
          approval={card.body.decision}
          emptyMessage="No review decision is recorded. Review happens only in the CLI; the browser cannot decide."
        />
      );
    case "checkpoint": {
      const body = card.body;
      return (
        <>
          <dl className="facts facts--compact">
            <div>
              <dt>Status</dt>
              <dd>
                <span
                  className={
                    body.status === "saved" ? "status status--info" : "status status--neutral"
                  }
                >
                  {body.status.replaceAll("_", " ")}
                </span>
              </dd>
            </div>
            <div>
              <dt>Digest</dt>
              <dd className="digest">{body.sha256 ?? "Not recorded"}</dd>
            </div>
            <div>
              <dt>Recorded</dt>
              <dd>
                {body.createdAt === null ? (
                  "Not recorded"
                ) : (
                  <time dateTime={body.createdAt}>{formatTimestamp(body.createdAt)}</time>
                )}
              </dd>
            </div>
          </dl>
          <p className="change-room-card__note">{body.note}</p>
        </>
      );
    }
    case "rollback_restoration": {
      const body = card.body;
      return (
        <>
          {body.records.length === 0 ? (
            <p className="empty-state">
              No rollback or restoration is recorded for this run. This is not evidence of recovery
              success or failure.
            </p>
          ) : (
            <ul className="plain-list">
              {body.records.map((record) => (
                <li key={`${record.kind}-${record.digest}`}>
                  <span
                    className={
                      record.kind === "rollback" ? "status status--warning" : "status status--info"
                    }
                  >
                    {record.kind}
                  </span>{" "}
                  <span className={decisionClass(record.decision)}>{record.decision}</span> by{" "}
                  {record.actor} ·{" "}
                  <time dateTime={record.createdAt}>{formatTimestamp(record.createdAt)}</time>
                  <br />
                  <code className="digest" title={record.digest}>
                    {record.digest}
                  </code>
                  <br />
                  <small>
                    {record.completed
                      ? record.completedSequence === null
                        ? "Completion inferred from the terminal rolled-back state"
                        : `Completion observed at event #${record.completedSequence}`
                      : "No completion is recorded in this bounded view"}
                  </small>
                </li>
              ))}
            </ul>
          )}
          <p className="change-room-card__note">{body.note}</p>
        </>
      );
    }
    case "terminal_state": {
      const body = card.body;
      return (
        <>
          <dl className="facts facts--compact">
            <div>
              <dt>Run state</dt>
              <dd>
                <span
                  className={
                    body.terminal
                      ? body.state === "completed"
                        ? "status status--positive"
                        : "status status--negative"
                      : "status status--info"
                  }
                >
                  {stateLabel(body.state)}
                </span>
              </dd>
            </div>
            <div>
              <dt>Terminal</dt>
              <dd>{body.terminal ? "Yes — no further transitions" : "No — run is not terminal"}</dd>
            </div>
            <div>
              <dt>Terminal reason</dt>
              <dd>{body.terminalReason ?? "None — run is not terminal"}</dd>
            </div>
            <div>
              <dt>Resume stage</dt>
              <dd>{body.resumeState === null ? "Not recorded" : stateLabel(body.resumeState)}</dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>
                <time dateTime={body.updatedAt}>{formatTimestamp(body.updatedAt)}</time>
              </dd>
            </div>
          </dl>
          {body.lastError === null ? null : (
            <div className="message message--error">
              <span>
                {body.lastError.code}: {body.lastError.message}
              </span>
            </div>
          )}
        </>
      );
    }
  }
}

function EvidenceCard({
  card,
  annotations,
}: {
  readonly card: ChangeRoomCardView;
  readonly annotations: readonly ChangeRoomAnnotationView[];
}) {
  return (
    <article className="change-room-card" aria-labelledby={`${card.id}-title`}>
      <div className="change-room-card__heading">
        <h4 id={`${card.id}-title`}>{card.title}</h4>
        <span className={cardStatusClass(card.status)}>{cardStatusLabel(card.status)}</span>
      </div>
      <div className="change-room-card__meta">
        <span className="status status--neutral">{provenanceLabel(card.provenanceClass)}</span>
        <IndicatorBadges card={card} />
      </div>
      <RefList refs={card.refs} />
      <CardBody card={card} />
      {annotations.length === 0 ? null : (
        <section aria-label={`Operator annotations for ${card.title}`}>
          <h5>Operator annotations</h5>
          <AnnotationList annotations={annotations} />
        </section>
      )}
    </article>
  );
}

interface ActivePageRequest {
  readonly controller: AbortController;
  readonly request: ChangeRoomPageRequest | null;
}

interface ActiveRoomRequest {
  readonly controller: AbortController;
  readonly roomId: string;
}

interface ActivePacketRequest {
  readonly controller: AbortController;
  readonly roomId: string;
  readonly question: ChangeContextQuestion;
}

export interface ChangeRoomViewProps {
  readonly projects: readonly ProjectView[];
}

export function ChangeRoomView({ projects }: ChangeRoomViewProps) {
  const [session, setSession] = useState<ChangeRoomPageSession | null>(null);
  const [pageBusy, setPageBusy] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [pageRetry, setPageRetry] = useState<ChangeRoomPageRequest | "newest" | null>(null);
  const sessionRef = useRef<ChangeRoomPageSession | null>(null);
  const pageRequestRef = useRef<ActivePageRequest | null>(null);
  const pageGenerationRef = useRef(0);

  const [selectedSummary, setSelectedSummary] = useState<ChangeRoomSummaryView | null>(null);
  const [room, setRoom] = useState<ChangeRoomDetailView | null>(null);
  const [roomBusy, setRoomBusy] = useState(false);
  const [roomError, setRoomError] = useState<string | null>(null);
  const roomRequestRef = useRef<ActiveRoomRequest | null>(null);
  const roomGenerationRef = useRef(0);

  const [packet, setPacket] = useState<ChangeContextPacketView | null>(null);
  const [packetBusy, setPacketBusy] = useState<ChangeContextQuestion | null>(null);
  const [packetError, setPacketError] = useState<string | null>(null);
  const packetRequestRef = useRef<ActivePacketRequest | null>(null);
  const packetGenerationRef = useRef(0);

  const invalidatePageRequest = useCallback((): void => {
    pageGenerationRef.current += 1;
    const active = pageRequestRef.current;
    pageRequestRef.current = null;
    active?.controller.abort();
  }, []);

  const invalidateRoomRequest = useCallback((): void => {
    roomGenerationRef.current += 1;
    const active = roomRequestRef.current;
    roomRequestRef.current = null;
    active?.controller.abort();
  }, []);

  const invalidatePacketRequest = useCallback((): void => {
    packetGenerationRef.current += 1;
    const active = packetRequestRef.current;
    packetRequestRef.current = null;
    active?.controller.abort();
  }, []);

  useEffect(
    () => () => {
      invalidatePageRequest();
      invalidateRoomRequest();
      invalidatePacketRequest();
    },
    [invalidatePageRequest, invalidateRoomRequest, invalidatePacketRequest],
  );

  const fetchPage = useCallback(
    async (request: ChangeRoomPageRequest | null): Promise<void> => {
      invalidatePageRequest();
      const controller = new AbortController();
      const generation = pageGenerationRef.current;
      pageRequestRef.current = { controller, request };
      setPageBusy(true);
      setPageError(null);
      setPageRetry(null);
      try {
        const value = await getChangeRoomPage(request, controller.signal);
        if (controller.signal.aborted || pageGenerationRef.current !== generation) return;
        const next =
          request === null
            ? createChangeRoomPageSession(value)
            : acceptChangeRoomPage(requireSession(sessionRef.current), request, value);
        sessionRef.current = next;
        setSession(next);
      } catch (error) {
        if (!controller.signal.aborted && pageGenerationRef.current === generation) {
          setPageError(errorMessage(error));
          setPageRetry(request === null ? "newest" : request);
        }
      } finally {
        if (pageRequestRef.current?.controller === controller) pageRequestRef.current = null;
        if (pageGenerationRef.current === generation) setPageBusy(false);
      }
    },
    [invalidatePageRequest],
  );

  const navigatePage = useCallback(
    (direction: ChangeRoomPageDirection): void => {
      const current = sessionRef.current;
      if (current === null) return;
      try {
        void fetchPage(changeRoomPageRequest(current, direction));
      } catch (error) {
        setPageError(errorMessage(error));
        setPageRetry(null);
      }
    },
    [fetchPage],
  );

  const retryPage = useCallback((): void => {
    if (pageRetry === null) return;
    void fetchPage(pageRetry === "newest" ? null : pageRetry);
  }, [fetchPage, pageRetry]);

  const loadRoom = useCallback(
    async (roomId: string): Promise<void> => {
      invalidateRoomRequest();
      const controller = new AbortController();
      const generation = roomGenerationRef.current;
      roomRequestRef.current = { controller, roomId };
      setRoomBusy(true);
      setRoomError(null);
      try {
        const value = await getChangeRoom(roomId, controller.signal);
        if (controller.signal.aborted || roomGenerationRef.current !== generation) return;
        setRoom(acceptChangeRoom(roomId, value));
      } catch (error) {
        if (!controller.signal.aborted && roomGenerationRef.current !== generation) {
          setRoomError(errorMessage(error));
        }
      } finally {
        if (roomRequestRef.current?.controller === controller) roomRequestRef.current = null;
        if (roomGenerationRef.current === generation) setRoomBusy(false);
      }
    },
    [invalidateRoomRequest],
  );

  const selectRoom = useCallback(
    (summary: ChangeRoomSummaryView): void => {
      if (summary.roomId === selectedSummary?.roomId) return;
      invalidateRoomRequest();
      invalidatePacketRequest();
      setSelectedSummary(summary);
      setRoom(null);
      setRoomBusy(false);
      setRoomError(null);
      setPacket(null);
      setPacketBusy(null);
      setPacketError(null);
    },
    [invalidatePacketRequest, invalidateRoomRequest, selectedSummary?.roomId],
  );

  const closeRoom = useCallback((): void => {
    invalidateRoomRequest();
    invalidatePacketRequest();
    setSelectedSummary(null);
    setRoom(null);
    setRoomBusy(false);
    setRoomError(null);
    setPacket(null);
    setPacketBusy(null);
    setPacketError(null);
  }, [invalidatePacketRequest, invalidateRoomRequest]);

  const loadContext = useCallback(
    async (question: ChangeContextQuestion): Promise<void> => {
      const currentRoom = room;
      if (currentRoom === null) return;
      invalidatePacketRequest();
      const controller = new AbortController();
      const generation = packetGenerationRef.current;
      packetRequestRef.current = { controller, roomId: currentRoom.roomId, question };
      setPacketBusy(question);
      setPacketError(null);
      try {
        const value = await getChangeContext(currentRoom.roomId, question, controller.signal);
        if (controller.signal.aborted || packetGenerationRef.current !== generation) return;
        setPacket(acceptChangeContextPacket(currentRoom, question, value));
      } catch (error) {
        if (!controller.signal.aborted && packetGenerationRef.current !== generation) {
          setPacketError(errorMessage(error));
        }
      } finally {
        if (packetRequestRef.current?.controller === controller) packetRequestRef.current = null;
        if (packetGenerationRef.current === generation) setPacketBusy(null);
      }
    },
    [invalidatePacketRequest, room],
  );

  const projectName = useCallback(
    (projectId: string): string =>
      projects.find((project) => project.id === projectId)?.name ?? projectId,
    [projects],
  );

  const roomAnnotations =
    room?.annotations.filter((annotation) => annotation.card === "room") ?? [];

  const pageStatusText = pageBusy
    ? "Loading change rooms."
    : (pageError ??
      (session === null
        ? "Change rooms have not been loaded."
        : `Loaded ${session.page.rooms.length} change rooms on page ${changeRoomPageDepth(session)}.`));

  const roomStatusText = roomBusy
    ? "Loading change room evidence."
    : (roomError ??
      (room === null
        ? "Change room evidence has not been loaded."
        : `Change room loaded at event revision ${room.integrity.eventCursor}.`));

  const depth = session === null ? 0 : changeRoomPageDepth(session);
  const canLoadOlder = session !== null && canNavigateToOlderRooms(session);
  const canLoadNewer = session !== null && canNavigateToNewerRooms(session);
  const depthCapped = session?.page.hasMore === true && depth === CHANGE_ROOM_PAGE_MAX_PAGES;

  return (
    <div className="stack">
      <section
        id="change-rooms"
        className="change-rooms"
        aria-labelledby="change-rooms-heading"
        aria-busy={pageBusy}
      >
        <div className="change-rooms__heading">
          <div>
            <p className="eyebrow">Read-only run projections</p>
            <h2 id="change-rooms-heading">Change Rooms</h2>
          </div>
          {session === null ? null : <span className="count">{session.page.rooms.length}</span>}
        </div>
        <p>
          A Change Room is the canonical read-only explanation of one guarded run: task and scope,
          pinned base and context, provider plan, approvals, PatchSet and diff evidence,
          verification, review decision, checkpoint, recovery, and terminal state. Nothing here
          mutates anything; approvals, review, rollback, and restore happen only in the CLI.
        </p>
        <p className="change-rooms__bounds">
          Pages hold at most {CHANGE_ROOM_PAGE_SIZE} rooms, newest first, and this session keeps a
          bounded window of at most {CHANGE_ROOM_PAGE_MAX_PAGES} pages.
        </p>

        {session === null ? (
          <button type="button" disabled={pageBusy} onClick={() => void fetchPage(null)}>
            {pageBusy ? "Loading…" : "Load change rooms"}
          </button>
        ) : null}

        {pageError === null ? null : (
          <div className="message message--error" role="alert">
            <span>{pageError}</span>
            <button
              type="button"
              className="button--secondary"
              disabled={pageBusy || pageRetry === null}
              onClick={retryPage}
            >
              Retry change rooms
            </button>
          </div>
        )}

        {session === null ? null : session.page.rooms.length === 0 ? (
          <p className="empty-state">No run records exist in this pinned workspace page.</p>
        ) : (
          <ul className="selection-list selection-list--compact">
            {session.page.rooms.map((summary) => (
              <li key={summary.roomId}>
                <button
                  type="button"
                  className={selectedSummary?.roomId === summary.roomId ? "is-selected" : undefined}
                  aria-pressed={selectedSummary?.roomId === summary.roomId}
                  aria-label={`Open change room for ${summary.task}`}
                  onClick={() => selectRoom(summary)}
                >
                  <span>
                    <strong>{summary.task}</strong>
                    <small>
                      {summary.target} · {projectName(summary.projectId)} · {summary.provider.kind}/
                      {summary.provider.model} ·{" "}
                      <time dateTime={summary.lastActivity}>
                        {formatTimestamp(summary.lastActivity)}
                      </time>
                    </small>
                    {summary.terminalReason === null ? null : (
                      <small>terminal: {summary.terminalReason}</small>
                    )}
                  </span>
                  <span className="change-room-list__badges">
                    <span className="status status--info">{stateLabel(summary.state)}</span>
                    <span className="status status--neutral">
                      {summary.phase.replaceAll("_", " ")}
                    </span>
                    <span className={verificationOutcomeClass(summary.verificationOutcome)}>
                      verification: {summary.verificationOutcome.replaceAll("_", " ")}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {session === null ? null : (
          <>
            <p className="run-page__status" role="status">
              Page {depth} in a pinned session window of at most {CHANGE_ROOM_PAGE_MAX_PAGES}.
              Membership is pinned; room facts reflect when this page was read.
            </p>
            <nav className="run-page__navigation" aria-label="Change room page navigation">
              <button
                type="button"
                className="button--secondary"
                disabled={pageBusy || !canLoadNewer}
                onClick={() => navigatePage("newer")}
              >
                Newer rooms
              </button>
              <button
                type="button"
                className="button--secondary"
                disabled={pageBusy || !canLoadOlder}
                onClick={() => navigatePage("older")}
              >
                Older rooms
              </button>
            </nav>
            {depthCapped ? (
              <p className="run-page__guidance">
                This browser session keeps {CHANGE_ROOM_PAGE_MAX_PAGES} change room pages. Use{" "}
                <code>icarus run list</code> and <code>icarus run history RUN</code> for complete
                history beyond this window.
              </p>
            ) : session.page.hasMore ? null : (
              <p className="run-page__guidance">
                No older rooms remain in this pinned session. Use <code>icarus run list</code> for a
                complete run listing.
              </p>
            )}
          </>
        )}
        <p className="visually-hidden" role="status" aria-live="polite">
          {pageStatusText}
        </p>
      </section>

      {selectedSummary === null ? null : (
        <section
          id="change-room-detail"
          className="change-room-detail"
          aria-labelledby="change-room-detail-heading"
          aria-busy={roomBusy}
        >
          <div className="change-rooms__heading">
            <div>
              <p className="eyebrow">Change Room detail</p>
              <h2 id="change-room-detail-heading">{selectedSummary.task}</h2>
            </div>
            <button type="button" className="button--secondary" onClick={closeRoom}>
              Close room
            </button>
          </div>
          <dl className="facts facts--compact">
            <div>
              <dt>Target</dt>
              <dd>{selectedSummary.target}</dd>
            </div>
            <div>
              <dt>Project</dt>
              <dd>
                {projectName(selectedSummary.projectId)}{" "}
                <small>({selectedSummary.projectId})</small>
              </dd>
            </div>
            <div>
              <dt>Room</dt>
              <dd className="digest">{selectedSummary.roomId}</dd>
            </div>
            <div>
              <dt>State</dt>
              <dd>
                <span className="status status--info">{stateLabel(selectedSummary.state)}</span>{" "}
                <span className="status status--neutral">
                  {selectedSummary.phase.replaceAll("_", " ")}
                </span>
              </dd>
            </div>
            <div>
              <dt>Provider</dt>
              <dd>
                {selectedSummary.provider.kind} · {selectedSummary.provider.model} ·{" "}
                {selectedSummary.provider.locality} ·{" "}
                {selectedSummary.provider.privacyClass.replaceAll("_", " ")}
              </dd>
            </div>
            <div>
              <dt>Verification</dt>
              <dd>
                <span className={verificationOutcomeClass(selectedSummary.verificationOutcome)}>
                  {selectedSummary.verificationOutcome.replaceAll("_", " ")}
                </span>
              </dd>
            </div>
          </dl>

          <div className="change-room-detail__actions">
            <button
              type="button"
              disabled={roomBusy}
              onClick={() => void loadRoom(selectedSummary.roomId)}
            >
              {roomBusy
                ? "Loading…"
                : room === null
                  ? roomError === null
                    ? "Load change room evidence"
                    : "Retry change room evidence"
                  : "Refresh change room evidence"}
            </button>
          </div>

          {roomError === null ? null : (
            <p className="message message--error" role="alert">
              {roomError}
              {room === null ? null : " The last successfully loaded evidence remains below."}
            </p>
          )}
          <p className="visually-hidden" role="status" aria-live="polite">
            {roomStatusText}
          </p>

          {room === null ? (
            <p className="empty-state">
              Room evidence loads only on an explicit request. It is never polled.
            </p>
          ) : (
            <>
              <p className="change-room-detail__pinned">
                Loaded at event revision {room.integrity.eventCursor} of {room.integrity.eventCount}
                ; refresh to reconcile.
                {room.integrity.timelineTruncated
                  ? ` The timeline shows the newest ${room.timeline.length} events only.`
                  : ""}
              </p>
              <p className="change-room-card__note">{room.integrity.note}</p>

              {roomAnnotations.length === 0 ? null : (
                <section
                  className="change-room-annotations-block"
                  aria-labelledby="change-room-annotations-heading"
                >
                  <h3 id="change-room-annotations-heading">Room annotations</h3>
                  <p className="change-room-card__note">
                    Annotations are operator context recorded through the CLI (
                    <code>icarus run annotate</code>). They are never approval, plan, or execution
                    input.
                  </p>
                  <AnnotationList annotations={roomAnnotations} />
                </section>
              )}

              <ol className="change-room-card-list">
                {room.cards.map((card) => (
                  <li key={card.id}>
                    <EvidenceCard
                      card={card}
                      annotations={room.annotations.filter(
                        (annotation) => annotation.card === card.kind,
                      )}
                    />
                  </li>
                ))}
              </ol>

              <details className="change-room-timeline">
                <summary>
                  Bounded event timeline ({room.timeline.length} of {room.integrity.eventCount}{" "}
                  events)
                </summary>
                <ol className="timeline">
                  {room.timeline.map((entry) => (
                    <li key={entry.sequence} value={entry.sequence}>
                      <div>
                        <span>
                          {entry.label} · {entry.evidenceSection}
                        </span>
                        <time dateTime={entry.timestamp}>{formatTimestamp(entry.timestamp)}</time>
                      </div>
                    </li>
                  ))}
                </ol>
              </details>

              <section
                className="change-room-explain"
                aria-labelledby="change-room-explain-heading"
                aria-busy={packetBusy !== null}
              >
                <h3 id="change-room-explain-heading">Explain this change</h3>
                <p>
                  Answers are a deterministic local projection of the recorded evidence above. No
                  model is involved in generating them, and every statement cites its evidence
                  receipts.
                </p>
                <div className="change-room-explain__questions">
                  {QUESTIONS.map((question) => (
                    <button
                      key={question.value}
                      type="button"
                      className="button--secondary"
                      disabled={packetBusy !== null}
                      onClick={() => void loadContext(question.value)}
                    >
                      {packetBusy === question.value ? "Loading…" : question.label}
                    </button>
                  ))}
                </div>
                {packetError === null ? null : (
                  <p className="message message--error" role="alert">
                    {packetError}
                    {packet === null ? null : " The last successfully loaded answer remains below."}
                  </p>
                )}
                {packet !== null && packet.eventCursor !== room.integrity.eventCursor ? (
                  <p className="message message--warning">
                    This answer was projected at event revision {packet.eventCursor}, but the room
                    was reloaded at revision {room.integrity.eventCursor}. Re-ask the question to
                    reconcile.
                  </p>
                ) : null}
                {packet === null ? (
                  <p className="empty-state">Choose a question to load its explanation.</p>
                ) : (
                  <div className="change-room-explain__packet">
                    <h4>{questionLabel(packet.question)}</h4>
                    {packet.components.length === 0 ? (
                      <p className="empty-state">No statements were produced for this question.</p>
                    ) : (
                      <ol className="plain-list">
                        {packet.components.map((component) => (
                          <li key={component.statement}>
                            <p>{component.statement}</p>
                            {component.receipts.length === 0 ? null : (
                              <ul className="change-room-explain__receipts">
                                {component.receipts.map((receipt) => (
                                  <li key={receipt.cardId}>
                                    receipt: {receipt.cardId.replaceAll("-", " ")}
                                    {receipt.eventSequences.length === 0
                                      ? ""
                                      : ` · events ${receipt.eventSequences
                                          .map((sequence) => `#${sequence}`)
                                          .join(", ")}`}
                                    {receipt.digests.map((digest) => (
                                      <Fragment key={digest}>
                                        {" · "}
                                        <code className="digest" title={digest}>
                                          {shortDigest(digest)}
                                        </code>
                                      </Fragment>
                                    ))}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </li>
                        ))}
                      </ol>
                    )}
                    {packet.omissions.length === 0 ? null : (
                      <>
                        <h4>Omissions</h4>
                        <ul className="warning-list">
                          {packet.omissions.map((omission) => (
                            <li key={omission}>{omission}</li>
                          ))}
                        </ul>
                      </>
                    )}
                    {packet.uncertainty.length === 0 ? null : (
                      <>
                        <h4>Uncertainty</h4>
                        <ul className="plain-list">
                          {packet.uncertainty.map((entry) => (
                            <li key={entry}>{entry}</li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                )}
              </section>
            </>
          )}
        </section>
      )}
    </div>
  );
}

function requireSession(session: ChangeRoomPageSession | null): ChangeRoomPageSession {
  if (session === null) {
    throw new Error("The change room page session is unavailable.");
  }
  return session;
}
