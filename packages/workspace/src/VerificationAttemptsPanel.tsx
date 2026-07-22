import type { RefObject } from "react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type {
  RunView,
  VerificationAttemptCheckpointProvenance,
  VerificationAttemptStartProvenance,
  VerificationAttemptStatus,
  VerificationAttemptView,
  VerificationAttemptsView,
} from "./api.js";
import { ApiError, errorMessage, getRunVerificationAttempts } from "./api.js";
import {
  acceptVerificationAttempts,
  type VerificationAttemptsRequest,
  verificationAttemptsAreStale,
  verificationAttemptsRequest,
} from "./verification-attempts.js";

const SNAPSHOT_CONFLICT_CODE = "EVENT_SNAPSHOT_CONFLICT";

interface PanelError {
  readonly kind: "conflict" | "transient";
  readonly message: string;
}

interface ActiveRequest {
  readonly controller: AbortController;
  readonly generation: number;
  readonly request: VerificationAttemptsRequest;
}

export interface VerificationAttemptsPanelHandle {
  cancelForParentNavigation(): void;
  abortBeforeHistoryOpen(): void;
  abortForPersistedRunRefresh(): void;
  persistedRunRefreshSucceeded(): void;
}

interface VerificationAttemptsPanelProps {
  readonly run: Pick<RunView, "id" | "eventCursor">;
  readonly historyOpen: boolean;
  readonly focusFallbackRef: RefObject<HTMLElement | null>;
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString();
}

function attemptStatusLabel(status: VerificationAttemptStatus): string {
  switch (status) {
    case "passed":
      return "completed — passed";
    case "failed":
      return "completed — failed";
    case "unavailable":
      return "completed — unavailable";
    case "cancelled":
      return "cancellation requested while verifying";
    case "incomplete_failed":
      return "failed before verification completed";
    case "incomplete_at_snapshot":
      return "still verifying at the pinned snapshot";
  }
}

function attemptStatusClass(status: VerificationAttemptStatus): string {
  switch (status) {
    case "passed":
      return "status status--positive";
    case "failed":
    case "incomplete_failed":
      return "status status--negative";
    case "cancelled":
    case "unavailable":
    case "incomplete_at_snapshot":
      return "status status--warning";
  }
}

function startProvenanceLabel(provenance: VerificationAttemptStartProvenance): string {
  switch (provenance) {
    case "observed_initial_edit":
      return "Observed initial edit entering verification";
    case "observed_restore":
      return "Observed restore completion entering verification";
    case "observed_resume":
      return "Observed failed run resuming verification";
    case "outside_coverage":
      return "Start occurred outside this evidence suffix";
  }
}

function checkpointProvenanceLabel(provenance: VerificationAttemptCheckpointProvenance): string {
  switch (provenance) {
    case "recorded_digest_match":
      return "Completed-attempt digest matches the recorded checkpoint digest";
    case "run_checkpoint_available":
      return "Recorded for the run at this pinned snapshot; no attempt-time relation is established";
    case "not_available":
      return "No recorded checkpoint was available";
  }
}

function VerificationAttemptCard({ attempt }: { readonly attempt: VerificationAttemptView }) {
  return (
    <li>
      <article className="verification-attempt">
        <div className="verification-attempt__heading">
          <h5>Attempt anchor {attempt.anchorSequence}</h5>
          <span className={attemptStatusClass(attempt.status)}>
            {attemptStatusLabel(attempt.status)}
          </span>
        </div>
        <dl className="facts facts--compact">
          <div>
            <dt>Bounded identity</dt>
            <dd>{attempt.identity}</dd>
          </div>
          <div>
            <dt>Start evidence</dt>
            <dd>{startProvenanceLabel(attempt.startProvenance)}</dd>
          </div>
          <div>
            <dt>Start sequence</dt>
            <dd>{attempt.startSequence ?? "Outside coverage"}</dd>
          </div>
          <div>
            <dt>Started</dt>
            <dd>
              {attempt.startedAt === null ? (
                "Outside coverage"
              ) : (
                <time dateTime={attempt.startedAt}>{formatTimestamp(attempt.startedAt)}</time>
              )}
            </dd>
          </div>
          <div>
            <dt>End sequence</dt>
            <dd>{attempt.endSequence ?? "Open at snapshot"}</dd>
          </div>
          <div>
            <dt>Ended</dt>
            <dd>
              {attempt.endedAt === null ? (
                "Open at snapshot"
              ) : (
                <time dateTime={attempt.endedAt}>{formatTimestamp(attempt.endedAt)}</time>
              )}
            </dd>
          </div>
          <div>
            <dt>Diff digest</dt>
            <dd className="digest">{attempt.diffSha256 ?? "Not recorded for this status"}</dd>
          </div>
          <div>
            <dt>Checkpoint digest</dt>
            <dd className="digest">{attempt.checkpointSha256 ?? "Not available"}</dd>
          </div>
          <div>
            <dt>Checkpoint relation</dt>
            <dd>{checkpointProvenanceLabel(attempt.checkpointProvenance)}</dd>
          </div>
          <div>
            <dt>Later bounded anchor</dt>
            <dd>{attempt.laterAttemptObservedWithinCoverage ? "Observed" : "Not observed"}</dd>
          </div>
        </dl>
        {attempt.startProvenance === "observed_restore" ? (
          <p className="verification-attempt__note">
            The restore transition establishes only how this interval began. It does not prove
            rollback causality or fresh checkpoint-byte verification.
          </p>
        ) : null}
        {attempt.laterAttemptObservedWithinCoverage ? (
          <p className="verification-attempt__note">
            A later anchor appears in this bounded response. No formal supersession or review
            disposition is claimed.
          </p>
        ) : null}
      </article>
    </li>
  );
}

function LoadedAttempts({
  run,
  view,
}: {
  readonly run: Pick<RunView, "id" | "eventCursor">;
  readonly view: VerificationAttemptsView;
}) {
  const stale = verificationAttemptsAreStale(run, view);
  return (
    <>
      {stale ? (
        <p className="message message--warning verification-attempts__notice">
          Newer persisted activity exists. These facts remain pinned to revision {view.snapshot}.
          Refresh this evidence explicitly to request a new pinned view.
        </p>
      ) : null}
      <dl className="facts facts--compact verification-attempts__facts">
        <div>
          <dt>Pinned revision</dt>
          <dd>{view.snapshot}</dd>
        </div>
        <div>
          <dt>Sequence coverage</dt>
          <dd>
            {view.coverage.firstSequence}–{view.coverage.lastSequence}
          </dd>
        </div>
        <div>
          <dt>Events examined</dt>
          <dd>
            {view.coverage.eventCount} of {view.coverage.eventLimit} maximum
          </dd>
        </div>
        <div>
          <dt>Attempt intervals</dt>
          <dd>
            {view.attempts.length} of {view.attemptLimit} maximum
          </dd>
        </div>
        <div>
          <dt>Earlier events</dt>
          <dd>
            {view.coverage.earlierEventsExcluded ? "Excluded" : "Fully covered from sequence 1"}
          </dd>
        </div>
        <div>
          <dt>Additional suffix anchors</dt>
          <dd>{view.attemptAnchorsTruncatedWithinCoverage ? "Excluded" : "Not observed"}</dd>
        </div>
      </dl>

      {view.coverage.earlierEventsExcluded || view.attemptAnchorsTruncatedWithinCoverage ? (
        <p className="message message--warning verification-attempts__notice">
          This view is incomplete:{" "}
          {view.coverage.earlierEventsExcluded
            ? "events before the fixed suffix are excluded"
            : "additional attempt-shaped anchors were excluded"}
          {view.coverage.earlierEventsExcluded && view.attemptAnchorsTruncatedWithinCoverage
            ? ", and additional attempt-shaped anchors were excluded"
            : ""}
          .
        </p>
      ) : null}

      <section
        className="verification-checkpoint"
        aria-labelledby="verification-checkpoint-heading"
      >
        <h5 id="verification-checkpoint-heading">Recorded checkpoint</h5>
        {view.checkpoint.status === "not_saved" ? (
          <p className="empty-state">
            No immutable checkpoint row was recorded. This is not evidence of recovery success.
          </p>
        ) : (
          <>
            <dl className="facts facts--compact">
              <div>
                <dt>Digest</dt>
                <dd className="digest">{view.checkpoint.sha256}</dd>
              </div>
              <div>
                <dt>Recorded</dt>
                <dd>
                  <time dateTime={view.checkpoint.createdAt}>
                    {formatTimestamp(view.checkpoint.createdAt)}
                  </time>
                </dd>
              </div>
              <div>
                <dt>Save event</dt>
                <dd>
                  {view.checkpoint.saveEvent.status === "observed_in_coverage"
                    ? `Observed at sequence ${view.checkpoint.saveEvent.sequence}`
                    : "Not observed in this suffix"}
                </dd>
              </div>
              {view.checkpoint.saveEvent.status === "observed_in_coverage" ? (
                <div>
                  <dt>Save event time</dt>
                  <dd>
                    <time dateTime={view.checkpoint.saveEvent.timestamp}>
                      {formatTimestamp(view.checkpoint.saveEvent.timestamp)}
                    </time>
                  </dd>
                </div>
              ) : null}
            </dl>
            <p className="verification-attempts__note">
              This is recorded digest metadata. The browser did not receive or rehash checkpoint
              bytes, so current byte integrity is not proven.
            </p>
          </>
        )}
      </section>

      <section aria-labelledby="verification-attempt-list-heading">
        <div className="verification-attempts__subheading">
          <h5 id="verification-attempt-list-heading">Observed verification intervals</h5>
          <span className="count">{view.attempts.length}</span>
        </div>
        {view.attempts.length === 0 ? (
          <p className="empty-state">
            No verification interval was observed in this exact suffix. An empty result does not
            imply a successful verification.
          </p>
        ) : (
          <ol className="verification-attempt-list">
            {view.attempts.map((attempt) => (
              <VerificationAttemptCard key={attempt.identity} attempt={attempt} />
            ))}
          </ol>
        )}
      </section>
    </>
  );
}

export const VerificationAttemptsPanel = forwardRef<
  VerificationAttemptsPanelHandle,
  VerificationAttemptsPanelProps
>(function VerificationAttemptsPanel({ run, historyOpen, focusFallbackRef }, forwardedRef) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<VerificationAttemptsView | null>(null);
  const [panelError, setPanelError] = useState<PanelError | null>(null);
  const [conflictLocked, setConflictLocked] = useState(false);
  const runRef = useRef(run);
  const historyOpenRef = useRef(historyOpen);
  const openRef = useRef(false);
  const conflictLockedRef = useRef(false);
  const requestRef = useRef<ActiveRequest | null>(null);
  const generationRef = useRef(0);
  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = useRef(false);
  const previousOpenRef = useRef(false);
  runRef.current = run;
  historyOpenRef.current = historyOpen;

  const invalidateRequest = useCallback((): boolean => {
    generationRef.current += 1;
    const active = requestRef.current;
    requestRef.current = null;
    active?.controller.abort();
    return active !== null;
  }, []);

  const abortRetainingView = useCallback(
    (message: string): void => {
      if (!invalidateRequest()) return;
      setBusy(false);
      if (openRef.current) setPanelError({ kind: "transient", message });
    },
    [invalidateRequest],
  );

  const cancelForParentNavigation = useCallback((): void => {
    restoreFocusRef.current = false;
    openRef.current = false;
    invalidateRequest();
    setOpen(false);
    setBusy(false);
    setView(null);
    setPanelError(null);
    conflictLockedRef.current = false;
    setConflictLocked(false);
  }, [invalidateRequest]);

  const abortBeforeHistoryOpen = useCallback((): void => {
    abortRetainingView(
      "Verification evidence loading was cancelled before older activity opened. Retry after closing older activity.",
    );
  }, [abortRetainingView]);

  const abortForPersistedRunRefresh = useCallback((): void => {
    abortRetainingView(
      "Verification evidence loading was cancelled by the persisted-run refresh. Retry explicitly.",
    );
  }, [abortRetainingView]);

  const persistedRunRefreshSucceeded = useCallback((): void => {
    conflictLockedRef.current = false;
    setConflictLocked(false);
    setPanelError((current) => (current?.kind === "conflict" ? null : current));
  }, []);

  useImperativeHandle(
    forwardedRef,
    () => ({
      cancelForParentNavigation,
      abortBeforeHistoryOpen,
      abortForPersistedRunRefresh,
      persistedRunRefreshSucceeded,
    }),
    [
      abortBeforeHistoryOpen,
      abortForPersistedRunRefresh,
      cancelForParentNavigation,
      persistedRunRefreshSucceeded,
    ],
  );

  useEffect(() => {
    const visibilityChanged = (): void => {
      if (document.visibilityState !== "hidden") return;
      abortRetainingView(
        "Verification evidence loading was cancelled while this tab was hidden. Retry when visible.",
      );
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => document.removeEventListener("visibilitychange", visibilityChanged);
  }, [abortRetainingView]);

  useEffect(
    () => () => {
      openRef.current = false;
      invalidateRequest();
    },
    [invalidateRequest],
  );

  const launcherDisabled = busy || historyOpen || conflictLocked;

  useEffect(() => {
    const wasOpen = previousOpenRef.current;
    previousOpenRef.current = open;
    if (open && !wasOpen) {
      closeButtonRef.current?.focus();
      return;
    }
    if (open || !wasOpen || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    if (!launcherDisabled) {
      launcherRef.current?.focus();
    } else {
      focusFallbackRef.current?.focus();
    }
  }, [focusFallbackRef, launcherDisabled, open]);

  const load = useCallback(async (): Promise<void> => {
    if (requestRef.current !== null || historyOpenRef.current || conflictLockedRef.current) {
      return;
    }

    openRef.current = true;
    restoreFocusRef.current = false;
    setOpen(true);
    let request: VerificationAttemptsRequest;
    try {
      request = verificationAttemptsRequest(runRef.current);
    } catch (error) {
      setPanelError({ kind: "transient", message: errorMessage(error) });
      return;
    }
    if (document.visibilityState === "hidden") {
      setPanelError({
        kind: "transient",
        message: "Verification evidence can load only while this tab is visible.",
      });
      return;
    }

    const controller = new AbortController();
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const active = { controller, generation, request };
    requestRef.current = active;
    setBusy(true);
    setPanelError(null);
    try {
      const value = await getRunVerificationAttempts(
        request.runId,
        request.snapshot,
        controller.signal,
      );
      const current = requestRef.current;
      if (
        controller.signal.aborted ||
        generationRef.current !== generation ||
        current?.controller !== controller ||
        current.request.runId !== request.runId ||
        current.request.snapshot !== request.snapshot ||
        !openRef.current
      ) {
        return;
      }
      setView(acceptVerificationAttempts(request, value));
      setPanelError(null);
    } catch (error) {
      if (controller.signal.aborted || generationRef.current !== generation) return;
      if (error instanceof ApiError && error.code === SNAPSHOT_CONFLICT_CODE) {
        conflictLockedRef.current = true;
        setConflictLocked(true);
        setPanelError({
          kind: "conflict",
          message:
            "The run advanced before this pinned read began. Refresh the persisted run, then retry this evidence explicitly.",
        });
      } else {
        setPanelError({ kind: "transient", message: errorMessage(error) });
      }
    } finally {
      if (requestRef.current?.controller === controller && generationRef.current === generation) {
        requestRef.current = null;
        setBusy(false);
      }
    }
  }, []);

  const closePanel = (): void => {
    restoreFocusRef.current = true;
    openRef.current = false;
    invalidateRequest();
    setOpen(false);
    setBusy(false);
    setView(null);
    setPanelError(null);
  };

  const statusText = busy
    ? "Loading pinned verification evidence."
    : (panelError?.message ??
      (view === null
        ? "Verification evidence has not been loaded."
        : `Loaded ${view.attempts.length} verification intervals at revision ${view.snapshot}.`));

  return (
    <section
      id="verification-attempts"
      className="verification-attempts"
      aria-labelledby="verification-attempts-heading"
      aria-busy={busy}
    >
      <div className="verification-attempts__heading">
        <div>
          <p className="eyebrow">Bounded, read-only provenance</p>
          <h4 id="verification-attempts-heading">Verification &amp; Recovery Evidence</h4>
        </div>
        {open ? (
          <button
            ref={closeButtonRef}
            type="button"
            className="button--secondary"
            onClick={closePanel}
          >
            Close
          </button>
        ) : null}
      </div>
      <p>
        Each explicit request reads one pinned suffix of at most 200 persisted events and returns at
        most the newest 8 attempt anchors within that suffix.
      </p>
      <p className="verification-attempts__omissions">
        Raw event payloads, diffs, paths, checks, commands, output, actors, error detail, provider
        data, and checkpoint bytes are omitted.
      </p>

      {!open ? (
        <button
          ref={launcherRef}
          type="button"
          disabled={launcherDisabled}
          onClick={() => void load()}
        >
          Load verification evidence
        </button>
      ) : (
        <div className="verification-attempts__actions">
          <button
            ref={launcherRef}
            type="button"
            disabled={launcherDisabled}
            onClick={() => void load()}
          >
            {busy
              ? "Loading…"
              : panelError === null
                ? view === null
                  ? "Load evidence"
                  : "Refresh evidence"
                : "Retry evidence"}
          </button>
        </div>
      )}

      {historyOpen ? (
        <p className="verification-attempts__notice">
          Close older activity before loading or refreshing this independent pinned view.
        </p>
      ) : null}
      {conflictLocked ? (
        <p className="message message--warning verification-attempts__notice">
          A successful persisted-run refresh is required before this evidence can be retried.
        </p>
      ) : null}
      <p className="visually-hidden" role="status" aria-live="polite">
        {statusText}
      </p>
      {open && panelError !== null ? (
        <p className="message message--error verification-attempts__notice">{panelError.message}</p>
      ) : null}
      {open && view !== null ? <LoadedAttempts run={run} view={view} /> : null}
      <p className="verification-attempts__guidance">
        For complete history, per-check attempts, timeout or failure reasons, and events outside
        these fixed bounds, use <code>icarus run history {run.id}</code>.
      </p>
    </section>
  );
});
