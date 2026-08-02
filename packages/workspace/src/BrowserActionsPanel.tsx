import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  BrowserActionDescriptorView,
  BrowserActionReceiptView,
  BrowserActionRequest,
  PersistedDiffReviewView,
  PlanAuthorityView,
  RunView,
} from "./api.js";
import { errorMessage, executeBrowserAction, getBrowserActionReceipt } from "./api.js";
import {
  ACTION_RECEIPT_POLL_INTERVAL_MS,
  ACTION_RECEIPT_POLL_MAX_ATTEMPTS,
  ACTION_RECEIPT_POLL_MAX_WALL_CLOCK_MS,
  ACTION_RECEIPT_REQUEST_TIMEOUT_MS,
  type BrowserActionConfirmation,
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
  type ReviewApprovalProof,
} from "./browser-actions.js";

interface OpenConfirmation {
  readonly identity: BrowserActionConfirmation;
  readonly diff: string | null;
  readonly diffReview: PersistedDiffReviewView;
  readonly planAuthority: PlanAuthorityView | null;
}

interface TrackedActionRequest {
  readonly request: BrowserActionRequest;
  readonly phase: "submitting" | "recovering";
  readonly receipt: BrowserActionReceiptView | null;
}

interface LatestTrackedReceipt {
  readonly request: BrowserActionRequest;
  readonly receipt: BrowserActionReceiptView;
}

interface BrowserActionsPanelProps {
  readonly run: RunView;
  readonly actionSessionAvailable: boolean;
  readonly onRunChanged: (run: RunView) => Promise<void>;
  readonly onRefresh: (runId: string) => Promise<void>;
}

function displayTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function displayRate(value: number | null): string {
  return value === null ? "Not configured" : `$${value} per million tokens`;
}

function factLabel(value: string): string {
  return value
    .replaceAll(/([A-Z])/g, " $1")
    .replaceAll("_", " ")
    .toLowerCase();
}

function ValueList({
  values,
  empty,
}: {
  readonly values: readonly string[];
  readonly empty: string;
}) {
  if (values.length === 0) return <p className="empty-state">{empty}</p>;
  return (
    <ul className="plain-list">
      {values.map((value) => (
        <li key={value}>{value}</li>
      ))}
    </ul>
  );
}

export function PlanAuthorityDetails({
  authority,
  headingId = "plan-authority-heading",
}: {
  readonly authority: PlanAuthorityView;
  readonly headingId?: string;
}) {
  return (
    <section className="plan-authority" aria-labelledby={headingId}>
      <div className="evidence-block__heading">
        <div>
          <p className="eyebrow">Complete bounded authority</p>
          <h4 id={headingId}>What plan approval permits</h4>
        </div>
        <span className="status status--warning">human decision required</span>
      </div>
      <p className="plan-authority__consequence">{authority.execution.consequence}</p>
      <dl className="facts facts--compact">
        <div>
          <dt>Plan digest</dt>
          <dd className="digest">{authority.planDigest}</dd>
        </div>
        <div>
          <dt>Context digest</dt>
          <dd className="digest">{authority.contextDigest}</dd>
        </div>
        <div>
          <dt>Base commit</dt>
          <dd className="digest">{authority.baseCommit}</dd>
        </div>
        <div>
          <dt>Iteration ceiling</dt>
          <dd>{authority.iterationCeiling}</dd>
        </div>
        <div>
          <dt>Execution platform</dt>
          <dd>{authority.execution.platform}</dd>
        </div>
        <div>
          <dt>Checks require sandbox</dt>
          <dd>{authority.execution.checksRequireSandbox ? "Yes" : "No"}</dd>
        </div>
      </dl>

      <div className="plan-authority__grid">
        <section>
          <h5>Exact mutation targets</h5>
          <ValueList values={authority.targets} empty="No mutation targets are approved." />
        </section>
        <section>
          <h5>Registered check IDs</h5>
          <ValueList values={authority.checkIds} empty="No checks are approved." />
        </section>
      </div>

      <section>
        <h5>Capability grants</h5>
        {authority.grants.length === 0 ? (
          <p className="empty-state">No capability grants are approved.</p>
        ) : (
          <div className="card-grid">
            {authority.grants.map((grant) => (
              <article className="authority-card" key={grant.kind}>
                <strong>{grant.kind}</strong>
                <p>Maximum calls: {grant.maxCalls}</p>
                <ValueList values={grant.scope} empty="This grant has an empty scope." />
              </article>
            ))}
          </div>
        )}
      </section>

      <section>
        <h5>Resolved readable manifest</h5>
        {authority.readableManifest === null ? (
          <p className="empty-state">Absent — this plan approves no readable manifest.</p>
        ) : (
          <>
            <p>
              Manifest digest: <span className="digest">{authority.readableManifest.digest}</span>
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Approved path</th>
                    <th scope="col">Content digest</th>
                  </tr>
                </thead>
                <tbody>
                  {authority.readableManifest.entries.map((entry) => (
                    <tr key={entry.path}>
                      <td>{entry.path}</td>
                      <td className="digest">{entry.sha256}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section>
        <h5>Registered checks and exact commands</h5>
        {authority.checks.length === 0 ? (
          <p className="empty-state">No registered checks are bound to this approval.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">ID</th>
                  <th scope="col">Name</th>
                  <th scope="col">Exact argv</th>
                </tr>
              </thead>
              <tbody>
                {authority.checks.map((check) => (
                  <tr key={check.id}>
                    <td>{check.id}</td>
                    <td>{check.name}</td>
                    <td>
                      <code>{JSON.stringify(check.argv)}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h5>Digest-pinned sandbox</h5>
        <dl className="facts facts--compact">
          <div>
            <dt>Image</dt>
            <dd className="digest">{authority.sandbox.image}</dd>
          </div>
          <div>
            <dt>CPUs</dt>
            <dd>{authority.sandbox.cpus}</dd>
          </div>
          <div>
            <dt>Memory</dt>
            <dd>{authority.sandbox.memoryMb} MiB</dd>
          </div>
          <div>
            <dt>PIDs</dt>
            <dd>{authority.sandbox.pids}</dd>
          </div>
          <div>
            <dt>Tmpfs</dt>
            <dd>{authority.sandbox.tmpfsMb} MiB</dd>
          </div>
        </dl>
      </section>

      <section>
        <h5>Configured provider</h5>
        <dl className="facts facts--compact">
          <div>
            <dt>Kind</dt>
            <dd>{authority.provider.kind}</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>{authority.provider.model}</dd>
          </div>
          <div>
            <dt>Locality</dt>
            <dd>{authority.provider.locality}</dd>
          </div>
          <div>
            <dt>Endpoint</dt>
            <dd>{authority.provider.baseUrl}</dd>
          </div>
          <div>
            <dt>Input rate</dt>
            <dd>{displayRate(authority.provider.inputUsdPerMillionTokens)}</dd>
          </div>
          <div>
            <dt>Output rate</dt>
            <dd>{displayRate(authority.provider.outputUsdPerMillionTokens)}</dd>
          </div>
        </dl>
        <dl className="facts facts--compact">
          {Object.entries(authority.provider.capabilities).map(([name, value]) => (
            <div key={name}>
              <dt>{factLabel(name)}</dt>
              <dd>{value === null ? "Not reported" : String(value)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section>
        <h5>Project ceilings and timeouts</h5>
        <dl className="facts facts--compact">
          {Object.entries(authority.ceiling).map(([name, value]) => (
            <div key={name}>
              <dt>{factLabel(name)}</dt>
              <dd>{String(value)}</dd>
            </div>
          ))}
        </dl>
      </section>
    </section>
  );
}

function Receipt({ receipt }: { readonly receipt: BrowserActionReceiptView }) {
  const outcome = receipt.outcome ?? "pending";
  const statusClass =
    outcome === "succeeded"
      ? "status status--positive"
      : outcome === "pending"
        ? "status status--neutral"
        : "status status--warning";
  return (
    <dl className="facts facts--compact browser-action-receipt">
      <div>
        <dt>Action ID</dt>
        <dd className="digest">{receipt.actionId}</dd>
      </div>
      <div>
        <dt>Kind</dt>
        <dd>{receipt.kind}</dd>
      </div>
      <div>
        <dt>Status</dt>
        <dd>{receipt.status}</dd>
      </div>
      <div>
        <dt>Outcome</dt>
        <dd>
          <span className={statusClass}>{outcome.replaceAll("_", " ")}</span>
        </dd>
      </div>
      <div>
        <dt>Safe error code</dt>
        <dd>{receipt.errorCode ?? "None"}</dd>
      </div>
      <div>
        <dt>Updated</dt>
        <dd>
          <time dateTime={receipt.updatedAt}>{displayTimestamp(receipt.updatedAt)}</time>
        </dd>
      </div>
    </dl>
  );
}

function browserActionReceiptsEqual(
  left: BrowserActionReceiptView,
  right: BrowserActionReceiptView,
): boolean {
  return (
    left.actionId === right.actionId &&
    left.kind === right.kind &&
    left.status === right.status &&
    left.outcome === right.outcome &&
    left.errorCode === right.errorCode &&
    left.updatedAt === right.updatedAt
  );
}

function TrackedActionRecovery({
  tracked,
  onReceipt,
  onRefresh,
  onError,
  onSessionDemoted,
}: {
  readonly tracked: TrackedActionRequest;
  readonly onReceipt: (request: BrowserActionRequest, receipt: BrowserActionReceiptView) => void;
  readonly onRefresh: (runId: string) => Promise<void>;
  readonly onError: (message: string) => void;
  readonly onSessionDemoted: () => void;
}) {
  const { request, phase, receipt } = tracked;
  const [pollAttempt, setPollAttempt] = useState(0);
  const [pollError, setPollError] = useState<string | null>(null);
  const [pollExhausted, setPollExhausted] = useState(false);
  const [retryGeneration, setRetryGeneration] = useState(0);

  useEffect(() => {
    if (phase !== "recovering") return;
    void retryGeneration;
    const startedAt = Date.now();
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let activeGuard: ReturnType<typeof createBrowserActionReceiptRequestGuard> | null = null;
    let attempts = 0;

    setPollAttempt(0);
    setPollError(null);
    setPollExhausted(false);

    const exhaust = (): void => {
      setPollExhausted(true);
    };

    const schedule = (): void => {
      const remaining = browserActionReceiptPollRemainingMs(startedAt, Date.now(), attempts);
      if (remaining <= 0) {
        exhaust();
        return;
      }
      timer = setTimeout(() => void poll(), Math.min(ACTION_RECEIPT_POLL_INTERVAL_MS, remaining));
    };

    async function poll(): Promise<void> {
      if (disposed || activeGuard !== null) return;
      const remaining = browserActionReceiptPollRemainingMs(startedAt, Date.now(), attempts);
      if (remaining <= 0) {
        exhaust();
        return;
      }
      attempts += 1;
      setPollAttempt(attempts);
      const guard = createBrowserActionReceiptRequestGuard(
        Math.min(ACTION_RECEIPT_REQUEST_TIMEOUT_MS, remaining),
      );
      activeGuard = guard;
      try {
        const nextReceipt = await getBrowserActionReceipt(
          request.runId,
          request.actionId,
          guard.signal,
        );
        if (!browserActionReceiptMatchesRequest(nextReceipt, request)) {
          throw new BrowserActionResponseIdentityError();
        }
        if (disposed) return;
        onReceipt(request, nextReceipt);
        setPollError(null);
        if (nextReceipt.status === "settled") {
          try {
            await onRefresh(request.runId);
          } catch (error) {
            if (!disposed) onError(errorMessage(error));
          }
          return;
        }
      } catch (error) {
        if (disposed || (guard.signal.aborted && !guard.timedOut())) return;
        if (browserActionSessionShouldDemote(error)) onSessionDemoted();
        setPollError(errorMessage(error));
      } finally {
        guard.dispose();
        if (activeGuard === guard) activeGuard = null;
      }
      if (disposed) return;
      if (browserActionReceiptPollRemainingMs(startedAt, Date.now(), attempts) <= 0) {
        exhaust();
        return;
      }
      schedule();
    }

    timer = setTimeout(() => void poll(), 0);
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      activeGuard?.abort();
    };
  }, [onError, onReceipt, onRefresh, onSessionDemoted, phase, request, retryGeneration]);

  const headingId = `browser-action-recovery-${request.actionId}`;
  return (
    <section className="browser-action-recovery" aria-labelledby={headingId}>
      <div className="evidence-block__heading">
        <h4 id={headingId}>Bounded action recovery</h4>
        <span className="status status--neutral">
          {phase === "submitting" ? "one POST in flight" : "read-only receipt polling"}
        </span>
      </div>
      {receipt === null ? (
        <p className="empty-state">
          Waiting for the durable receipt for action {request.actionId}. No second POST will be
          sent.
        </p>
      ) : (
        <Receipt receipt={receipt} />
      )}
      {phase === "submitting" ? (
        <p className="empty-state">
          The request remains active independently of this dialog. A freshly published,
          coordinator-bound cancellation may be confirmed separately.
        </p>
      ) : (
        <>
          <p className="empty-state">
            Receipt GET attempt {pollAttempt} of {ACTION_RECEIPT_POLL_MAX_ATTEMPTS}. Polling is
            bound to action <span className="digest">{request.actionId}</span> and stops within{" "}
            {ACTION_RECEIPT_POLL_MAX_WALL_CLOCK_MS / 1_000} seconds.
          </p>
          {pollError === null ? null : (
            <p className="message message--warning" role="status">
              Receipt status is still unknown — {pollError}
            </p>
          )}
          {pollExhausted ? (
            <div className="message message--warning" role="status">
              <span>
                Bounded polling stopped. The action was not resubmitted; its outcome remains unknown
                until durable evidence is available.
              </span>
              <button
                type="button"
                className="button--secondary"
                onClick={() => setRetryGeneration((current) => current + 1)}
              >
                Poll this receipt again
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

export function BrowserActionsPanel({
  run,
  actionSessionAvailable,
  onRunChanged,
  onRefresh,
}: BrowserActionsPanelProps) {
  const [confirmation, setConfirmation] = useState<OpenConfirmation | null>(null);
  const [reviewProof, setReviewProof] = useState<ReviewApprovalProof | null>(null);
  const [reviewProofError, setReviewProofError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [latestReceipt, setLatestReceipt] = useState<LatestTrackedReceipt | null>(null);
  const [trackedRequests, setTrackedRequests] = useState<readonly TrackedActionRequest[]>([]);
  const [sessionDemoted, setSessionDemoted] = useState(!actionSessionAvailable);
  const panelRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const submittedActionIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    setSessionDemoted(!actionSessionAvailable);
  }, [actionSessionAvailable]);

  const restoreTriggerFocus = useCallback((): void => {
    window.setTimeout(() => {
      const trigger = triggerRef.current;
      if (trigger?.isConnected === true && !trigger.disabled) trigger.focus();
      else panelRef.current?.focus();
    }, 0);
  }, []);

  const closeConfirmation = useCallback((): void => {
    setConfirmation(null);
    setReviewProof(null);
    setReviewProofError(null);
    restoreTriggerFocus();
  }, [restoreTriggerFocus]);

  const openConfirmation = (
    descriptor: BrowserActionDescriptorView,
    trigger: HTMLButtonElement,
  ): void => {
    const activeRequests = trackedRequests.map((entry) => entry.request);
    if (descriptor.runId !== run.id || !browserActionCanStart(descriptor, activeRequests)) {
      return;
    }
    triggerRef.current = trigger;
    setActionError(null);
    setNotice(null);
    setReviewProof(null);
    setReviewProofError(null);
    setConfirmation({
      identity: createBrowserActionConfirmation(
        descriptor,
        run.diff,
        run.diffReview,
        run.planAuthority,
      ),
      diff: run.diff,
      diffReview: run.diffReview,
      planAuthority: run.planAuthority,
    });
  };

  useEffect(() => {
    if (confirmation === null) return;
    closeButtonRef.current?.focus();
  }, [confirmation]);

  useEffect(() => {
    if (
      confirmation === null ||
      browserActionConfirmationIsCurrent(
        confirmation.identity,
        run.browserActions,
        run.diff,
        run.diffReview,
        run.planAuthority,
      )
    ) {
      return;
    }
    setConfirmation(null);
    setReviewProof(null);
    setReviewProofError(null);
    setNotice(
      "The persisted action identity or displayed authority changed while confirmation was open. Nothing was submitted; review the fresh descriptor.",
    );
    restoreTriggerFocus();
  }, [
    confirmation,
    restoreTriggerFocus,
    run.browserActions,
    run.diff,
    run.diffReview,
    run.planAuthority,
  ]);

  useEffect(() => {
    if (confirmation === null || confirmation.identity.descriptor.kind !== "review.approve") {
      setReviewProof(null);
      setReviewProofError(null);
      return;
    }
    let cancelled = false;
    setReviewProof(null);
    setReviewProofError(null);
    void proveDisplayedReviewDiff(
      confirmation.identity.descriptor,
      confirmation.diff,
      confirmation.diffReview,
    )
      .then((proof) => {
        if (!cancelled) setReviewProof(proof);
      })
      .catch(() => {
        if (!cancelled) {
          setReviewProofError(
            "This browser could not rehash the exact displayed diff. Review approval remains disabled.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [confirmation]);

  const storeTrackedReceipt = useCallback(
    (request: BrowserActionRequest, receipt: BrowserActionReceiptView): void => {
      if (!browserActionReceiptMatchesRequest(receipt, request)) return;
      setLatestReceipt((current) =>
        current !== null &&
        current.request.runId === request.runId &&
        browserActionReceiptsEqual(current.receipt, receipt)
          ? current
          : { request, receipt },
      );
      setTrackedRequests((current) => {
        const tracked = current.find(
          (entry) =>
            entry.request.actionId === request.actionId &&
            entry.request.runId === request.runId &&
            entry.request.kind === request.kind,
        );
        if (tracked === undefined) return current;
        if (receipt.status === "settled") {
          return current.filter((entry) => entry !== tracked);
        }
        if (tracked.receipt !== null && browserActionReceiptsEqual(tracked.receipt, receipt)) {
          return current;
        }
        return current.map((entry) => (entry === tracked ? { ...entry, receipt } : entry));
      });
    },
    [],
  );

  const markTrackedRecovering = useCallback(
    (request: BrowserActionRequest, receipt: BrowserActionReceiptView | null = null): void => {
      const matchedReceipt =
        receipt !== null && browserActionReceiptMatchesRequest(receipt, request) ? receipt : null;
      setTrackedRequests((current) => {
        const tracked = current.find(
          (entry) =>
            entry.request.actionId === request.actionId &&
            entry.request.runId === request.runId &&
            entry.request.kind === request.kind,
        );
        if (tracked === undefined) {
          return [...current, { request, phase: "recovering", receipt: matchedReceipt }];
        }
        const nextReceipt = matchedReceipt ?? tracked.receipt;
        if (
          tracked.phase === "recovering" &&
          ((tracked.receipt === null && nextReceipt === null) ||
            (tracked.receipt !== null &&
              nextReceipt !== null &&
              browserActionReceiptsEqual(tracked.receipt, nextReceipt)))
        ) {
          return current;
        }
        return current.map((entry) =>
          entry === tracked ? { ...entry, phase: "recovering", receipt: nextReceipt } : entry,
        );
      });
    },
    [],
  );

  const removeTrackedRequest = useCallback((request: BrowserActionRequest): void => {
    setTrackedRequests((current) =>
      current.filter(
        (entry) =>
          entry.request.actionId !== request.actionId ||
          entry.request.runId !== request.runId ||
          entry.request.kind !== request.kind,
      ),
    );
  }, []);

  const reportRecoveryError = useCallback((message: string): void => {
    setActionError(message);
  }, []);

  const demoteActionSession = useCallback((): void => {
    setSessionDemoted(true);
  }, []);

  useEffect(() => {
    const recovery = run.browserActionRecovery;
    if (recovery === null) return;
    const tracked = trackedRequests.find(
      (entry) =>
        entry.request.runId === run.id &&
        browserActionReceiptMatchesRequest(recovery, entry.request),
    );
    if (tracked !== undefined) storeTrackedReceipt(tracked.request, recovery);
  }, [run.browserActionRecovery, run.id, storeTrackedReceipt, trackedRequests]);

  const submitConfirmation = async (): Promise<void> => {
    const current = confirmation;
    if (current === null) return;
    const descriptor = current.identity.descriptor;
    const activeRequests = trackedRequests.map((entry) => entry.request);
    if (
      sessionDemoted ||
      !actionSessionAvailable ||
      submittedActionIdsRef.current.has(current.identity.actionId) ||
      !browserActionCanStart(descriptor, activeRequests) ||
      !browserActionConfirmationIsCurrent(
        current.identity,
        run.browserActions,
        run.diff,
        run.diffReview,
        run.planAuthority,
      )
    ) {
      return;
    }
    if (
      descriptor.kind === "review.approve" &&
      (reviewProof?.status !== "match" || reviewProofError !== null)
    ) {
      return;
    }
    if (
      descriptor.kind === "plan.approve" &&
      (current.planAuthority === null ||
        current.planAuthority.planDigest !== descriptor.subjectDigest)
    ) {
      return;
    }

    const request = browserActionRequest(current.identity);
    submittedActionIdsRef.current.add(request.actionId);
    setLatestReceipt(null);
    setTrackedRequests((tracked) => [...tracked, { request, phase: "submitting", receipt: null }]);
    setActionError(null);
    setNotice(
      "The action was submitted exactly once. Its request and any recovery are tracked independently below.",
    );
    setConfirmation(null);
    setReviewProof(null);
    setReviewProofError(null);
    restoreTriggerFocus();

    try {
      const result = await executeBrowserAction(request);
      if (!browserActionExecutionMatchesRequest(result, request)) {
        throw new BrowserActionResponseIdentityError();
      }
      if (result.action.status === "settled") {
        storeTrackedReceipt(request, result.action);
      } else {
        storeTrackedReceipt(request, result.action);
        markTrackedRecovering(request, result.action);
      }
      try {
        await onRunChanged(result.run);
      } catch (error) {
        setActionError(errorMessage(error));
        try {
          await onRefresh(request.runId);
        } catch {
          // Preserve the update error; the normal run refresh remains available.
        }
      }
    } catch (error) {
      if (browserActionSessionShouldDemote(error)) setSessionDemoted(true);
      if (browserActionOutcomeIsUncertain(error)) {
        markTrackedRecovering(request);
        setNotice(
          "The POST outcome is unknown. Icarus will issue bounded GETs for only this immutable action ID; it will never send a second POST.",
        );
      } else {
        removeTrackedRequest(request);
        setActionError(errorMessage(error));
        try {
          await onRefresh(request.runId);
        } catch {
          // Preserve the original bounded action error; the normal run refresh remains available.
        }
      }
    }
  };

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeConfirmation();
      return;
    }
    if (event.key !== "Tab") return;
    const buttons = Array.from(
      dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
    );
    if (buttons.length === 0) return;
    const first = buttons[0];
    const last = buttons.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  const descriptor = confirmation?.identity.descriptor ?? null;
  const activeRequests = trackedRequests.map((entry) => entry.request);
  const canUseActionSession = actionSessionAvailable && !sessionDemoted;
  const planApprovalReady =
    descriptor?.kind !== "plan.approve" ||
    (confirmation?.planAuthority !== null &&
      confirmation?.planAuthority.planDigest === descriptor.subjectDigest);
  const reviewApprovalReady =
    descriptor?.kind !== "review.approve" || reviewProof?.status === "match";
  const confirmEnabled =
    descriptor !== null &&
    canUseActionSession &&
    browserActionCanStart(descriptor, activeRequests) &&
    !submittedActionIdsRef.current.has(confirmation?.identity.actionId ?? "") &&
    planApprovalReady &&
    reviewApprovalReady &&
    reviewProofError === null;
  const visibleReceipt =
    latestReceipt !== null &&
    latestReceipt.request.runId === run.id &&
    browserActionReceiptMatchesRequest(latestReceipt.receipt, latestReceipt.request)
      ? latestReceipt.receipt
      : null;

  return (
    <section
      ref={panelRef}
      id="run-browser-actions"
      className="evidence-block browser-actions"
      aria-labelledby="browser-actions-heading"
      tabIndex={-1}
    >
      <div className="evidence-block__heading">
        <div>
          <p className="eyebrow">Guarded local authority</p>
          <h3 id="browser-actions-heading">Available run actions</h3>
        </div>
        <span className="count">{run.browserActions.length}</span>
      </div>
      <p className="panel__intro">
        Actions come only from the current persisted run. The browser cannot supply an actor,
        command, path, endpoint, Git operation, migration, deployment, or future action kind.
      </p>

      {!canUseActionSession ? (
        <p className="message message--warning" role="status">
          {sessionDemoted
            ? "The local API became unreachable, so this tab was demoted to review-only. Use a fresh action-session launch URL after the host is available."
            : "This tab is review-only. Open a fresh action-session launch URL to use a guarded action."}
        </p>
      ) : null}
      {notice === null ? null : (
        <p className="message message--info" role="status">
          {notice}
        </p>
      )}
      {actionError === null ? null : (
        <p className="message message--error" role="alert">
          {actionError}
        </p>
      )}

      {run.browserActions.length === 0 ? (
        <p className="empty-state">
          No guarded action is currently published. Availability is not inferred from product phase
          or browser state.
        </p>
      ) : (
        <ul className="browser-action-list">
          {run.browserActions.map((action) => (
            <li key={`${action.kind}:${action.actionDigest}`}>
              <div>
                <strong>{action.label}</strong>
                <span className="status status--neutral">{action.kind}</span>
              </div>
              <p>{action.consequence}</p>
              <button
                type="button"
                onClick={(event) => openConfirmation(action, event.currentTarget)}
                disabled={
                  !canUseActionSession ||
                  action.runId !== run.id ||
                  !browserActionCanStart(action, activeRequests)
                }
              >
                Review this action
              </button>
            </li>
          ))}
        </ul>
      )}

      {trackedRequests.map((tracked) => (
        <TrackedActionRecovery
          key={`${tracked.request.runId}:${tracked.request.actionId}`}
          tracked={tracked}
          onReceipt={storeTrackedReceipt}
          onRefresh={onRefresh}
          onError={reportRecoveryError}
          onSessionDemoted={demoteActionSession}
        />
      ))}

      {trackedRequests.length === 0 && visibleReceipt !== null ? (
        <section
          className="browser-action-recovery"
          aria-labelledby="browser-action-latest-receipt-heading"
        >
          <div className="evidence-block__heading">
            <h4 id="browser-action-latest-receipt-heading">Latest verified action receipt</h4>
            <span className="status status--neutral">immutable identity matched</span>
          </div>
          <Receipt receipt={visibleReceipt} />
        </section>
      ) : null}

      {confirmation === null || descriptor === null ? null : (
        <div className="browser-action-dialog-backdrop">
          <div
            ref={dialogRef}
            className="browser-action-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="browser-action-confirmation-heading"
            aria-describedby="browser-action-confirmation-consequence"
            onKeyDown={handleDialogKeyDown}
          >
            <div className="evidence-block__heading">
              <div>
                <p className="eyebrow">Immutable confirmation</p>
                <h3 id="browser-action-confirmation-heading">{descriptor.label}</h3>
              </div>
              <span className="status status--warning">deliberate action</span>
            </div>
            <p id="browser-action-confirmation-consequence">{descriptor.consequence}</p>
            <p className="message message--info">
              The actor is fixed by the host at startup. This browser request contains no actor.
            </p>
            <dl className="facts facts--compact">
              <div>
                <dt>Action ID</dt>
                <dd className="digest">{confirmation.identity.actionId}</dd>
              </div>
              <div>
                <dt>Kind</dt>
                <dd>{descriptor.kind}</dd>
              </div>
              <div>
                <dt>Exact state</dt>
                <dd>{descriptor.expectedState}</dd>
              </div>
              <div>
                <dt>Event revision</dt>
                <dd>{descriptor.eventRevision}</dd>
              </div>
              <div>
                <dt>Subject digest</dt>
                <dd className="digest">{descriptor.subjectDigest ?? "None"}</dd>
              </div>
              <div>
                <dt>Action digest</dt>
                <dd className="digest">{descriptor.actionDigest}</dd>
              </div>
              <div>
                <dt>Bound active action ID</dt>
                <dd className="digest">{descriptor.activeActionId ?? "None"}</dd>
              </div>
              <div>
                <dt>Bound active action digest</dt>
                <dd className="digest">{descriptor.activeActionDigest ?? "None"}</dd>
              </div>
            </dl>

            {descriptor.kind === "plan.approve" ? (
              confirmation.planAuthority === null ? (
                <p className="message message--error" role="alert">
                  Complete plan authority is unavailable. Plan approval remains disabled.
                </p>
              ) : (
                <PlanAuthorityDetails
                  authority={confirmation.planAuthority}
                  headingId="plan-authority-confirmation-heading"
                />
              )
            ) : null}

            {descriptor.kind === "review.approve" ? (
              <section className="review-diff-proof" aria-labelledby="review-diff-proof-heading">
                <h4 id="review-diff-proof-heading">Browser rehash of exact displayed diff</h4>
                {reviewProofError !== null ? (
                  <p className="message message--error" role="alert">
                    {reviewProofError}
                  </p>
                ) : reviewProof === null ? (
                  <p className="message message--info" role="status">
                    Computing SHA-256 with browser WebCrypto…
                  </p>
                ) : reviewProof.status === "match" ? (
                  <p className="message message--info" role="status">
                    WebCrypto matched the descriptor subject digest: {reviewProof.computedDigest}
                  </p>
                ) : (
                  <p className="message message--error" role="alert">
                    The complete displayed diff is unavailable or its WebCrypto digest does not
                    match. Review approval remains disabled.
                  </p>
                )}
              </section>
            ) : null}

            <div className="browser-action-dialog__actions">
              <button
                ref={closeButtonRef}
                type="button"
                className="button--secondary"
                onClick={closeConfirmation}
              >
                Close without submitting
              </button>
              <button
                type="button"
                disabled={!confirmEnabled}
                onClick={() => void submitConfirmation()}
              >
                {descriptor.label}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
