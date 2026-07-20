import type { FormEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CapabilityView,
  CheckEvidenceView,
  ContextMetadataView,
  CreateProjectInput,
  ProjectView,
  RepositoryStatusView,
  RunView,
  TimelineEntryView,
  WorkspaceView,
} from "./api.js";
import {
  createProject,
  createRun,
  errorMessage,
  getRepositoryStatus,
  getRun,
  getRunEvents,
  getWorkspace,
  planRun,
  previewProjectContext,
  unwrapContextPreview,
} from "./api.js";
import {
  advanceEventPoll,
  eventPollDelayMs,
  evidenceTarget,
  liveEventAnnouncement,
  snapshotIncludesObservedRevision,
} from "./live-poll.js";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatTimestamp(value: string | undefined): string {
  if (value === undefined || value.length === 0) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function shortCommit(value: string | null): string {
  return value === null ? "Not available" : value.slice(0, 12);
}

function runEventCursor(run: RunView): number {
  if (Number.isSafeInteger(run.eventCursor) && run.eventCursor >= 0) return run.eventCursor;
  return run.timeline.reduce(
    (cursor, entry) =>
      entry.sequence === undefined || !Number.isSafeInteger(entry.sequence)
        ? cursor
        : Math.max(cursor, entry.sequence),
    0,
  );
}

function newestRun(current: RunView | undefined, candidate: RunView): RunView {
  return current !== undefined && runEventCursor(current) > runEventCursor(candidate)
    ? current
    : candidate;
}

function workspaceWithRun(current: WorkspaceView | null, run: RunView): WorkspaceView | null {
  if (current === null) return current;
  const existing = current.runs.find((candidate) => candidate.id === run.id);
  const merged = newestRun(existing, run);
  return {
    ...current,
    runs: [merged, ...current.runs.filter((candidate) => candidate.id !== run.id)],
  };
}

const EVIDENCE_LINKS = [
  ["run-summary", "Summary"],
  ["run-context", "Context"],
  ["run-plan", "Plan"],
  ["run-action", "Action & files"],
  ["run-verification", "Verification"],
  ["run-outputs", "Outputs"],
  ["run-approvals", "Warnings & approvals"],
  ["run-usage", "Usage"],
  ["run-activity", "Activity"],
] as const;

const EVENT_POLL_MAX_PAGES = 8;

function pageIsVisible(): boolean {
  return document.visibilityState !== "hidden";
}

type LivePollState = "checking" | "current" | "catching_up" | "paused" | "stale";

function livePollLabel(state: LivePollState): string {
  switch (state) {
    case "checking":
      return "checking for events";
    case "current":
      return "auto-refresh on";
    case "catching_up":
      return "catching up";
    case "paused":
      return "paused while hidden";
    case "stale":
      return "evidence may be stale";
  }
}

function timelineLabel(entry: TimelineEntryView): string {
  return entry.label ?? entry.phase?.replaceAll("_", " ") ?? entry.state ?? "Run event";
}

function statusClass(status: string): string {
  const normalized = status.toLowerCase();
  if (
    normalized.includes("failed") ||
    normalized.includes("unavailable") ||
    normalized.includes("unsupported") ||
    normalized.includes("cancelled") ||
    normalized.includes("unconfigured") ||
    normalized.includes("error")
  ) {
    return "status status--negative";
  }
  if (
    normalized.includes("available") ||
    normalized.includes("ready") ||
    normalized.includes("completed") ||
    normalized.includes("passed")
  ) {
    return "status status--positive";
  }
  return "status status--neutral";
}

function CapabilityCard({ label, capability }: { label: string; capability: CapabilityView }) {
  return (
    <article className="capability-card">
      <div className="capability-card__heading">
        <h3>{label}</h3>
        <span className={statusClass(capability.status)}>{capability.status}</span>
      </div>
      <p>{capability.reason ?? "No limitation was reported by the local API."}</p>
    </article>
  );
}

function repositoryStatusLabel(
  status: RepositoryStatusView | null,
  checking: boolean,
  statusError: string | null,
): string {
  if (status === null) return checking && statusError === null ? "checking" : "not observed";
  if (status.availability === "identity_changed") return "identity changed";
  if (status.availability !== "available") return status.availability;
  if (status.worktree === "dirty") return "changes present";
  if (status.headMatchesBaseRef === false) return "head differs";
  if (status.issue !== null) return "attention needed";
  if (status.worktree === "clean" && status.headMatchesBaseRef === true) return "clean";
  return status.worktree;
}

function repositoryStatusClass(
  status: RepositoryStatusView | null,
  statusError: string | null,
): string {
  if (status === null) {
    return statusError === null ? "status status--neutral" : "status status--negative";
  }
  if (status.availability !== "available") return "status status--negative";
  if (status.issue !== null || status.worktree === "dirty" || status.headMatchesBaseRef === false) {
    return "status status--warning";
  }
  return status.worktree === "clean" ? "status status--positive" : "status status--neutral";
}

function RepositoryStatusPanel({ project }: { readonly project: ProjectView }) {
  const [statusSnapshot, setStatusSnapshot] = useState<{
    readonly projectId: string;
    readonly value: RepositoryStatusView;
  } | null>(null);
  const [statusErrorSnapshot, setStatusErrorSnapshot] = useState<{
    readonly projectId: string;
    readonly message: string;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  const requestRef = useRef<AbortController | null>(null);

  const status = statusSnapshot?.projectId === project.id ? statusSnapshot.value : null;
  const statusError =
    statusErrorSnapshot?.projectId === project.id ? statusErrorSnapshot.message : null;

  const loadStatus = useCallback(async (): Promise<void> => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setChecking(true);
    setStatusErrorSnapshot(null);
    try {
      const next = await getRepositoryStatus(project.id, controller.signal);
      if (next.projectId !== project.id || next.repositoryId !== project.repository.id) {
        throw new Error("The repository status response did not match the selected project.");
      }
      if (!controller.signal.aborted) {
        setStatusSnapshot({ projectId: project.id, value: next });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setStatusErrorSnapshot({ projectId: project.id, message: errorMessage(error) });
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setChecking(false);
      }
    }
  }, [project.id, project.repository.id]);

  useEffect(() => {
    void loadStatus();
    return () => {
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [loadStatus]);

  const label = repositoryStatusLabel(status, checking, statusError);
  return (
    <section
      className="repository-status"
      aria-labelledby="repository-status-heading"
      aria-busy={checking}
    >
      <div className="evidence-block__heading">
        <div>
          <p className="eyebrow">Live read-only observation</p>
          <h3 id="repository-status-heading">Repository status</h3>
        </div>
        <span className={repositoryStatusClass(status, statusError)}>{label}</span>
      </div>
      {status === null ? (
        <p className="empty-state">
          {checking
            ? "Inspecting the registered source checkout…"
            : "No repository observation is available."}
        </p>
      ) : (
        <dl className="facts facts--compact">
          <div>
            <dt>Availability</dt>
            <dd>{status.availability.replaceAll("_", " ")}</dd>
          </div>
          <div>
            <dt>Observed worktree</dt>
            <dd>{status.worktree}</dd>
          </div>
          <div>
            <dt>HEAD</dt>
            <dd className="digest" title={status.head ?? undefined}>
              {shortCommit(status.head)}
            </dd>
          </div>
          <div>
            <dt>Branch</dt>
            <dd>{status.branch ?? "Detached or unavailable"}</dd>
          </div>
          <div>
            <dt>Base ref</dt>
            <dd>{status.baseRef}</dd>
          </div>
          <div>
            <dt>Base commit</dt>
            <dd className="digest" title={status.baseCommit ?? undefined}>
              {shortCommit(status.baseCommit)}
            </dd>
          </div>
          <div>
            <dt>HEAD matches base ref</dt>
            <dd>
              {status.headMatchesBaseRef === null
                ? "Unknown"
                : status.headMatchesBaseRef
                  ? "Yes"
                  : "No"}
            </dd>
          </div>
          <div>
            <dt>Checked</dt>
            <dd>
              <time dateTime={status.checkedAt} title={status.checkedAt}>
                {formatTimestamp(status.checkedAt)}
              </time>
            </dd>
          </div>
        </dl>
      )}
      {status?.issue === null || status?.issue === undefined ? null : (
        <p className="message message--warning" role="status">
          {status.issue.code}: {status.issue.message}
        </p>
      )}
      {statusError === null ? null : (
        <p className="message message--error" role="status">
          {status === null ? "Repository was not observed" : "Repository observation may be stale"}
          {` — ${statusError}`}
        </p>
      )}
      <div className="repository-status__actions">
        <p className="empty-state">
          Observation only. Icarus does not clean, checkout, stage, or modify this repository.
        </p>
        <button
          type="button"
          className="button--secondary"
          disabled={checking}
          onClick={() => void loadStatus()}
        >
          {checking ? "Checking repository…" : "Refresh repository status"}
        </button>
      </div>
    </section>
  );
}

interface ProjectRegistrationFormProps {
  readonly busy: boolean;
  readonly onCreated: (project: ProjectView) => Promise<void>;
}

function ProjectRegistrationForm({ busy, onCreated }: ProjectRegistrationFormProps) {
  const [repositoryName, setRepositoryName] = useState("");
  const [repositoryPath, setRepositoryPath] = useState("");
  const [projectName, setProjectName] = useState("");
  const [baseRef, setBaseRef] = useState("main");
  const [sandboxImage, setSandboxImage] = useState("");
  const [checkId, setCheckId] = useState("verify");
  const [checkName, setCheckName] = useState("Project verification");
  const [checkArgv, setCheckArgv] = useState("[]");
  const [localError, setLocalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setLocalError(null);
    let argv: unknown;
    try {
      argv = JSON.parse(checkArgv) as unknown;
    } catch {
      setLocalError("Check argv must be a valid JSON array of strings.");
      return;
    }
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      !argv.every((part) => typeof part === "string" && part.length > 0)
    ) {
      setLocalError("Check argv must contain at least one non-empty string.");
      return;
    }
    const input: CreateProjectInput = {
      repository: { name: repositoryName.trim(), path: repositoryPath.trim() },
      project: {
        name: projectName.trim(),
        baseRef: baseRef.trim(),
        sandboxImage: sandboxImage.trim(),
        checks: [
          {
            id: checkId.trim(),
            name: checkName.trim(),
            argv: argv as string[],
          },
        ],
      },
    };
    setSubmitting(true);
    try {
      const project = await createProject(input);
      await onCreated(project);
      setRepositoryName("");
      setRepositoryPath("");
      setProjectName("");
      setSandboxImage("");
      setCheckArgv("[]");
    } catch (error) {
      setLocalError(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="register-project-heading">
      <div className="panel__heading">
        <div>
          <p className="eyebrow">Local persisted state</p>
          <h2 id="register-project-heading">Register a project</h2>
        </div>
      </div>
      <p className="panel__intro">
        Enter an absolute path. The browser does not scan your filesystem, and registration does not
        execute repository code.
      </p>
      <form className="form-grid" onSubmit={(event) => void submit(event)}>
        <label>
          Repository name
          <input
            required
            maxLength={100}
            value={repositoryName}
            onChange={(event) => setRepositoryName(event.target.value)}
            placeholder="icarus"
          />
        </label>
        <label>
          Absolute repository path
          <input
            required
            value={repositoryPath}
            onChange={(event) => setRepositoryPath(event.target.value)}
            placeholder="/absolute/path/to/repository"
          />
        </label>
        <label>
          Project name
          <input
            required
            maxLength={100}
            value={projectName}
            onChange={(event) => setProjectName(event.target.value)}
            placeholder="local-workspace"
          />
        </label>
        <label>
          Base ref
          <input required value={baseRef} onChange={(event) => setBaseRef(event.target.value)} />
        </label>
        <label className="form-grid__wide">
          Digest-pinned sandbox image
          <input
            required
            value={sandboxImage}
            onChange={(event) => setSandboxImage(event.target.value)}
            placeholder="image:tag@sha256:..."
          />
        </label>
        <label>
          Check ID
          <input required value={checkId} onChange={(event) => setCheckId(event.target.value)} />
        </label>
        <label>
          Check name
          <input
            required
            value={checkName}
            onChange={(event) => setCheckName(event.target.value)}
          />
        </label>
        <label className="form-grid__wide">
          Exact check argv (JSON array, never shell text)
          <input
            required
            value={checkArgv}
            onChange={(event) => setCheckArgv(event.target.value)}
            placeholder={'["pnpm","test"]'}
          />
        </label>
        {localError === null ? null : (
          <p className="message message--error form-grid__wide" role="alert">
            {localError}
          </p>
        )}
        <div className="form-actions form-grid__wide">
          <button type="submit" disabled={busy || submitting}>
            {submitting ? "Registering…" : "Register project"}
          </button>
        </div>
      </form>
    </section>
  );
}

function ContextSummary({
  context,
  sectionId,
}: {
  readonly context: ContextMetadataView;
  readonly sectionId?: string;
}) {
  const digest = context.sha256 ?? context.digest;
  return (
    <section
      id={sectionId}
      className="evidence-block"
      aria-labelledby="context-summary-heading"
      tabIndex={sectionId === undefined ? undefined : -1}
    >
      <div className="evidence-block__heading">
        <h3 id="context-summary-heading">Context summary</h3>
        <span className="status status--neutral">metadata only</span>
      </div>
      <dl className="facts">
        <div>
          <dt>Target</dt>
          <dd>{context.target}</dd>
        </div>
        <div>
          <dt>Total selected bytes</dt>
          <dd>{formatBytes(context.totalBytes)}</dd>
        </div>
        <div>
          <dt>Digest</dt>
          <dd className="digest">{digest ?? "Not recorded"}</dd>
        </div>
        <div>
          <dt>Base commit</dt>
          <dd className="digest">{context.baseCommit ?? "Not recorded"}</dd>
        </div>
        {context.repositoryDigest === undefined ? null : (
          <div>
            <dt>Repository digest</dt>
            <dd className="digest">{context.repositoryDigest}</dd>
          </div>
        )}
      </dl>
      {context.entries.length === 0 ? (
        <p className="empty-state">No context entries were selected.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Path</th>
                <th>Reason</th>
                <th>Bytes</th>
                <th>SHA-256</th>
              </tr>
            </thead>
            <tbody>
              {context.entries.map((entry) => (
                <tr key={`${entry.reason}:${entry.path}`}>
                  <td>{entry.path}</td>
                  <td>{entry.reason}</td>
                  <td>{formatBytes(entry.bytes)}</td>
                  <td className="digest">{entry.sha256}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {context.repositoryMap === undefined ? null : (
        <details>
          <summary>Provider repository map ({context.repositoryMap.length})</summary>
          {context.repositoryMap.length === 0 ? (
            <p className="empty-state">No repository-map paths were sent to the provider.</p>
          ) : (
            <ul className="plain-list">
              {context.repositoryMap.map((filePath) => (
                <li key={`provider-map:${filePath}`}>{filePath}</li>
              ))}
            </ul>
          )}
        </details>
      )}
      {context.map === undefined ? null : (
        <details>
          <summary>Bounded repository map ({context.map.length})</summary>
          {context.map.length === 0 ? (
            <p className="empty-state">No repository-map entries were included.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Path</th>
                    <th>Bytes</th>
                    <th>SHA-256</th>
                  </tr>
                </thead>
                <tbody>
                  {context.map.map((entry) => (
                    <tr key={`map:${entry.path}`}>
                      <td>{entry.path}</td>
                      <td>{formatBytes(entry.bytes)}</td>
                      <td className="digest">{entry.sha256}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </details>
      )}
      {context.excluded === undefined || context.excluded.length === 0 ? null : (
        <details>
          <summary>Excluded context ({context.excluded.length})</summary>
          <ul className="plain-list">
            {context.excluded.map((entry, index) => (
              <li key={`${entry.reason}:${entry.path ?? index}`}>
                {entry.path === undefined ? "Filtered entries" : entry.path}: {entry.reason}
                {entry.count === undefined ? "" : ` (${entry.count})`}
              </li>
            ))}
          </ul>
        </details>
      )}
      {context.counts === undefined ? null : (
        <details>
          <summary>Preview accounting</summary>
          <dl className="facts facts--compact">
            <div>
              <dt>Tracked files</dt>
              <dd>{context.counts.trackedFiles}</dd>
            </div>
            <div>
              <dt>Included files</dt>
              <dd>{context.counts.includedFiles}</dd>
            </div>
            <div>
              <dt>Excluded files</dt>
              <dd>{context.counts.excludedFiles}</dd>
            </div>
            <div>
              <dt>Scanned bytes</dt>
              <dd>{formatBytes(context.counts.scannedBytes)}</dd>
            </div>
          </dl>
        </details>
      )}
      {context.warnings === undefined || context.warnings.length === 0 ? null : (
        <ul className="warning-list">
          {context.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface ProjectDetailProps {
  readonly project: ProjectView;
  readonly planningCapability: CapabilityView;
  readonly runs: readonly RunView[];
  readonly onSelectRun: (runId: string) => Promise<void>;
  readonly onRunCreated: (run: RunView) => Promise<void>;
}

function ProjectDetail({
  project,
  planningCapability,
  runs,
  onSelectRun,
  onRunCreated,
}: ProjectDetailProps) {
  const [previewTarget, setPreviewTarget] = useState("");
  const [preview, setPreview] = useState<ContextMetadataView | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [task, setTask] = useState("");
  const [target, setTarget] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [creatingDraft, setCreatingDraft] = useState(false);

  const providerValidation = useMemo(() => {
    if (model.trim().length === 0 || baseUrl.trim().length === 0) {
      return { configured: false, reason: "Enter both a model and a loopback provider URL." };
    }
    try {
      const url = new URL(baseUrl);
      const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
      const loopback =
        hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
      if (
        !loopback ||
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.username.length > 0 ||
        url.password.length > 0 ||
        url.search.length > 0 ||
        url.hash.length > 0
      ) {
        return {
          configured: false,
          reason: "The first workspace slice accepts only credential-free loopback HTTP(S) URLs.",
        };
      }
      return { configured: true, reason: "Provider configuration is ready for a guarded plan." };
    } catch {
      return { configured: false, reason: "Provider URL is invalid." };
    }
  }, [baseUrl, model]);

  const requestPreview = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setPreviewError(null);
    setPreviewing(true);
    try {
      const result = await previewProjectContext(project.id, previewTarget.trim());
      setPreview(unwrapContextPreview(result));
    } catch (error) {
      setPreview(null);
      setPreviewError(errorMessage(error));
    } finally {
      setPreviewing(false);
    }
  };

  const submitDraft = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!providerValidation.configured || planningCapability.status !== "available") return;
    setDraftError(null);
    setCreatingDraft(true);
    try {
      const run = await createRun({
        projectId: project.id,
        task: task.trim(),
        target: target.trim(),
        provider: { model: model.trim(), baseUrl: new URL(baseUrl).toString() },
      });
      await onRunCreated(run);
    } catch (error) {
      setDraftError(errorMessage(error));
    } finally {
      setCreatingDraft(false);
    }
  };

  return (
    <div className="stack">
      <section className="panel" aria-labelledby="project-detail-heading">
        <div className="panel__heading">
          <div>
            <p className="eyebrow">Persisted project</p>
            <h2 id="project-detail-heading">{project.name}</h2>
          </div>
          <span className="status status--positive">registered</span>
        </div>
        <dl className="facts">
          <div>
            <dt>Repository</dt>
            <dd>{project.repository.name}</dd>
          </div>
          <div>
            <dt>Path</dt>
            <dd>{project.repository.path}</dd>
          </div>
          <div>
            <dt>Base ref</dt>
            <dd>{project.baseRef}</dd>
          </div>
          <div>
            <dt>Sandbox image</dt>
            <dd className="digest">
              {project.sandboxImage ?? project.sandbox?.image ?? "Missing"}
            </dd>
          </div>
        </dl>
        <RepositoryStatusPanel project={project} />
        <h3>Registered checks</h3>
        {project.checks.length === 0 ? (
          <p className="empty-state">
            No checks are registered. Execution must remain unavailable.
          </p>
        ) : (
          <ul className="plain-list">
            {project.checks.map((check) => (
              <li key={check.id}>
                <strong>{check.name}</strong> <code>{JSON.stringify(check.argv)}</code>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" aria-labelledby="context-preview-heading">
        <div className="panel__heading">
          <div>
            <p className="eyebrow">Read-only</p>
            <h2 id="context-preview-heading">Strict context preview</h2>
          </div>
        </div>
        <p className="panel__intro">
          The API returns deterministic metadata and exclusion reasons. Repository contents are
          rendered only as text and this action does not invoke a provider or project check.
        </p>
        <form className="inline-form" onSubmit={(event) => void requestPreview(event)}>
          <label>
            Tracked target path
            <input
              required
              value={previewTarget}
              onChange={(event) => setPreviewTarget(event.target.value)}
              placeholder="src/example.ts"
            />
          </label>
          <button type="submit" disabled={previewing || previewTarget.trim().length === 0}>
            {previewing ? "Inspecting…" : "Preview context"}
          </button>
        </form>
        {previewError === null ? null : (
          <p className="message message--error" role="alert">
            {previewError}
          </p>
        )}
        {preview === null ? (
          <p className="empty-state">No context preview has been requested.</p>
        ) : (
          <ContextSummary context={preview} />
        )}
      </section>

      <section className="panel" aria-labelledby="task-draft-heading">
        <div className="panel__heading">
          <div>
            <p className="eyebrow">Guarded run request</p>
            <h2 id="task-draft-heading">Create a task draft</h2>
          </div>
          <span
            className={
              providerValidation.configured ? "status status--positive" : "status status--negative"
            }
          >
            {providerValidation.configured ? "provider configured" : "provider unconfigured"}
          </span>
        </div>
        {planningCapability.status === "available" ? null : (
          <p className="message message--warning" role="status">
            {planningCapability.reason ??
              "New guarded run drafts are unavailable on this platform."}
          </p>
        )}
        <p
          className={
            providerValidation.configured ? "message message--info" : "message message--warning"
          }
          role="status"
        >
          {providerValidation.reason}
        </p>
        <form className="form-grid" onSubmit={(event) => void submitDraft(event)}>
          <label className="form-grid__wide">
            Task
            <textarea
              required
              rows={4}
              value={task}
              onChange={(event) => setTask(event.target.value)}
              placeholder="Describe the bounded change to plan."
            />
          </label>
          <label>
            Tracked target
            <input
              required
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder="src/example.ts"
            />
          </label>
          <label>
            Model
            <input
              required
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder="configured-local-model"
            />
          </label>
          <label className="form-grid__wide">
            Loopback provider URL
            <input
              required
              inputMode="url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="http://127.0.0.1:11434/"
            />
          </label>
          {draftError === null ? null : (
            <p className="message message--error form-grid__wide" role="alert">
              {draftError}
            </p>
          )}
          <div className="form-actions form-grid__wide">
            <button
              type="submit"
              disabled={
                creatingDraft ||
                planningCapability.status !== "available" ||
                !providerValidation.configured ||
                task.trim().length === 0 ||
                target.trim().length === 0
              }
            >
              {creatingDraft ? "Saving draft…" : "Create persisted draft"}
            </button>
          </div>
        </form>
      </section>

      <section className="panel" aria-labelledby="project-runs-heading">
        <div className="panel__heading">
          <div>
            <p className="eyebrow">Persisted history</p>
            <h2 id="project-runs-heading">Project runs</h2>
          </div>
          <span className="count">{runs.length}</span>
        </div>
        {runs.length === 0 ? (
          <p className="empty-state">No run requests exist for this project.</p>
        ) : (
          <ul className="selection-list">
            {runs.map((run) => (
              <li key={run.id}>
                <button type="button" onClick={() => void onSelectRun(run.id)}>
                  <span>
                    <strong>{run.task}</strong>
                    <small>{run.target}</small>
                  </span>
                  <span className={statusClass(run.phase)}>{run.phase.replaceAll("_", " ")}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function CheckEvidence({ check }: { check: CheckEvidenceView }) {
  const outcome = check.outcome ?? check.status ?? "not_run";
  const identifier = check.name ?? check.checkId ?? check.id ?? "Registered check";
  const wasRun = outcome !== "not_run";
  return (
    <article className="check-card">
      <div className="check-card__heading">
        <h4>{identifier}</h4>
        <span className={statusClass(outcome)}>{outcome.replaceAll("_", " ")}</span>
      </div>
      {check.argv === undefined ? null : <code>{JSON.stringify(check.argv)}</code>}
      <dl className="facts facts--compact">
        <div>
          <dt>Exit code</dt>
          <dd>
            {!wasRun
              ? "Not run"
              : check.exitCode === undefined || check.exitCode === null
                ? "Not recorded"
                : check.exitCode}
          </dd>
        </div>
        <div>
          <dt>Signal</dt>
          <dd>{wasRun ? (check.signal ?? "None") : "Not run"}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>
            {!wasRun
              ? "Not run"
              : check.durationMs === undefined || check.durationMs === null
                ? "Not recorded"
                : `${check.durationMs} ms`}
          </dd>
        </div>
        <div>
          <dt>Output</dt>
          <dd>
            {!wasRun
              ? "Not run — no output exists"
              : check.truncated
                ? "Truncated at configured ceiling"
                : "Complete within ceiling"}
          </dd>
        </div>
      </dl>
      {!wasRun || check.output === undefined ? null : (
        <details>
          <summary>Combined output</summary>
          <pre>{check.output.length === 0 ? "(empty output)" : check.output}</pre>
        </details>
      )}
      {!wasRun || check.stdout === undefined ? null : (
        <details>
          <summary>Standard output</summary>
          <pre>{check.stdout.length === 0 ? "(empty output)" : check.stdout}</pre>
        </details>
      )}
      {!wasRun || check.stderr === undefined ? null : (
        <details>
          <summary>Standard error</summary>
          <pre>{check.stderr.length === 0 ? "(empty output)" : check.stderr}</pre>
        </details>
      )}
    </article>
  );
}

interface RunEvidenceProps {
  readonly run: RunView;
  readonly planningCapability: CapabilityView;
  readonly onRunChanged: (run: RunView) => Promise<void>;
  readonly onRefresh: (runId: string) => Promise<void>;
}

function RunEvidence({ run, planningCapability, onRunChanged, onRefresh }: RunEvidenceProps) {
  const [planning, setPlanning] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [liveState, setLiveState] = useState<LivePollState>("checking");
  const [liveError, setLiveError] = useState<string | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = useState(
    "Automatic persisted-event refresh is starting.",
  );
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const cursorRef = useRef(runEventCursor(run));
  const cursorRunIdRef = useRef(run.id);

  useEffect(() => {
    if (cursorRunIdRef.current !== run.id) {
      cursorRunIdRef.current = run.id;
      cursorRef.current = runEventCursor(run);
      return;
    }
    cursorRef.current = Math.max(cursorRef.current, runEventCursor(run));
  }, [run]);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | null = null;
    let failureCount = 0;
    let hasSynced = false;

    if (retryGeneration > 0) {
      setLiveAnnouncement("Retrying automatic persisted-event refresh.");
    }

    const schedule = (delayMs: number): void => {
      if (timer !== undefined) clearTimeout(timer);
      if (disposed || !pageIsVisible()) return;
      timer = setTimeout(() => void poll(), delayMs);
    };

    async function poll(): Promise<void> {
      if (disposed || !pageIsVisible() || request !== null) return;
      const controller = new AbortController();
      request = controller;
      let cursor = cursorRef.current;
      let observedEvents = 0;
      let latestLabel: string | null = null;
      let observedRevision = cursor;
      let pageCount = 0;
      let drainCapped = false;
      try {
        let hasMore: boolean;
        do {
          const page = await getRunEvents(run.id, cursor, controller.signal);
          pageCount += 1;
          const progress = advanceEventPoll(run.id, cursor, observedRevision, page);
          cursor = progress.cursor;
          observedRevision = progress.observedRevision;
          observedEvents += progress.eventCount;
          if (progress.lastEvent !== null) latestLabel = timelineLabel(progress.lastEvent);
          hasMore = page.hasMore;
          if (hasMore && pageCount >= EVENT_POLL_MAX_PAGES) {
            drainCapped = true;
            break;
          }
          if (hasMore && !disposed) setLiveState("catching_up");
        } while (hasMore && !disposed);

        if (disposed) return;
        if (observedEvents > 0 || drainCapped) {
          const nextRun = await getRun(run.id, controller.signal);
          if (!snapshotIncludesObservedRevision(runEventCursor(nextRun), observedRevision)) {
            throw new Error("The run evidence snapshot is older than its event cursor.");
          }
          if (disposed) return;
          await onRunChanged(nextRun);
          cursorRef.current = Math.max(cursorRef.current, runEventCursor(nextRun));
          setLiveAnnouncement(
            liveEventAnnouncement(observedEvents, drainCapped, latestLabel ?? "run activity"),
          );
        } else {
          cursorRef.current = cursor;
          if (!hasSynced) setLiveAnnouncement("Persisted run evidence is current.");
        }
        hasSynced = true;
        failureCount = 0;
        setLiveError(null);
        setLiveState("current");
        setLastSyncedAt(new Date().toISOString());
      } catch (error) {
        if (controller.signal.aborted || disposed) return;
        failureCount += 1;
        setLiveError(errorMessage(error));
        setLiveState("stale");
        setLiveAnnouncement("Automatic refresh failed; the last known evidence remains visible.");
      } finally {
        if (request === controller) request = null;
        if (!disposed && pageIsVisible()) {
          schedule(eventPollDelayMs(failureCount));
        }
      }
    }

    const visibilityChanged = (): void => {
      if (document.visibilityState === "hidden") {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        request?.abort();
        setLiveState("paused");
        setLiveAnnouncement("Automatic event refresh is paused while this tab is hidden.");
      } else {
        setLiveState("checking");
        setLiveAnnouncement("Automatic event refresh resumed.");
        schedule(0);
      }
    };

    setLiveState(pageIsVisible() ? "checking" : "paused");
    document.addEventListener("visibilitychange", visibilityChanged);
    schedule(0);
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      request?.abort();
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [onRunChanged, retryGeneration, run.id]);

  const requestPlan = async (): Promise<void> => {
    setActionError(null);
    setPlanning(true);
    try {
      await onRunChanged(await planRun(run.id));
    } catch (error) {
      setActionError(errorMessage(error));
      await onRefresh(run.id);
    } finally {
      setPlanning(false);
    }
  };

  const refresh = async (): Promise<void> => {
    setActionError(null);
    setRefreshing(true);
    try {
      await onRefresh(run.id);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setRefreshing(false);
    }
  };

  const liveStatusClass =
    liveState === "current"
      ? "status status--positive"
      : liveState === "stale"
        ? "status status--negative"
        : "status status--neutral";

  return (
    <section className="panel run-evidence" aria-labelledby="run-evidence-heading">
      <div className="panel__heading">
        <div>
          <p className="eyebrow">Run evidence</p>
          <h2 id="run-evidence-heading">{run.task}</h2>
        </div>
        <span className={statusClass(run.phase)}>{run.phase.replaceAll("_", " ")}</span>
      </div>
      <div className="run-toolbar">
        <button
          type="button"
          className="button--secondary"
          onClick={() => void refresh()}
          disabled={refreshing}
        >
          {refreshing ? "Refreshing…" : "Refresh persisted run"}
        </button>
        {run.phase === "draft" ? (
          <button
            type="button"
            onClick={() => void requestPlan()}
            disabled={planning || planningCapability.status !== "available"}
          >
            {planning ? "Planning…" : "Create guarded plan"}
          </button>
        ) : null}
      </div>
      <nav className="evidence-nav" aria-label="Run evidence">
        <span>Evidence</span>
        <ul>
          {EVIDENCE_LINKS.map(([id, label]) => (
            <li key={id}>
              <a href={`#${id}`}>{label}</a>
            </li>
          ))}
        </ul>
      </nav>
      <div
        className="live-refresh"
        aria-busy={liveState === "checking" || liveState === "catching_up"}
      >
        <span className={liveStatusClass}>{livePollLabel(liveState)}</span>
        <span className="live-refresh__time" aria-hidden="true">
          {lastSyncedAt === null
            ? "No successful event check yet"
            : `Checked ${formatTimestamp(lastSyncedAt)}`}
        </span>
        <span className="visually-hidden" aria-live="polite" aria-atomic="true">
          {liveAnnouncement}
        </span>
      </div>
      {liveError === null ? null : (
        <div className="message message--warning live-refresh__error" role="status">
          <span>Last-known evidence is preserved — {liveError}</span>
          <button
            type="button"
            className="button--secondary"
            onClick={() => setRetryGeneration((current) => current + 1)}
          >
            Retry event refresh
          </button>
        </div>
      )}
      {run.phase === "draft" && planningCapability.status !== "available" ? (
        <p className="message message--warning" role="status">
          {planningCapability.reason ?? "Guarded planning is unavailable on this platform."}
        </p>
      ) : null}
      {actionError === null ? null : (
        <p className="message message--error" role="alert">
          {actionError}
        </p>
      )}
      {run.lastError === null ? null : (
        <p className="message message--error" role="alert">
          Persisted failure — {run.lastError.code}: {run.lastError.message}
        </p>
      )}
      <section
        id="run-summary"
        className="evidence-block"
        aria-labelledby="run-summary-heading"
        tabIndex={-1}
      >
        <h3 id="run-summary-heading">Run summary</h3>
        <dl className="facts">
          <div>
            <dt>Run ID</dt>
            <dd className="digest">{run.id}</dd>
          </div>
          <div>
            <dt>Product phase</dt>
            <dd>{run.phase.replaceAll("_", " ")}</dd>
          </div>
          <div>
            <dt>Exact persisted state</dt>
            <dd>{run.state}</dd>
          </div>
          <div>
            <dt>Target</dt>
            <dd>{run.target}</dd>
          </div>
          <div>
            <dt>Provider model</dt>
            <dd>{run.provider.model}</dd>
          </div>
          <div>
            <dt>Provider endpoint</dt>
            <dd>{run.provider.baseUrl}</dd>
          </div>
        </dl>

        {run.gate === null ? (
          <p className="message message--info">No human gate is currently reported.</p>
        ) : (
          <section className="gate" aria-labelledby="gate-heading">
            <div>
              <p className="eyebrow">Human gate</p>
              <h3 id="gate-heading">{run.gate.label ?? run.gate.kind}</h3>
            </div>
            <p>{run.gate.reason ?? "Review the exact persisted evidence before continuing."}</p>
            <dl className="facts facts--compact">
              <div>
                <dt>Status</dt>
                <dd>{run.gate.status ?? "awaiting approval"}</dd>
              </div>
              <div>
                <dt>Bound digest</dt>
                <dd className="digest">{run.gate.digest ?? "Not supplied"}</dd>
              </div>
            </dl>
          </section>
        )}
      </section>

      {run.context === null ? (
        <section id="run-context" className="evidence-block" tabIndex={-1}>
          <h3>Context summary</h3>
          <p className="empty-state">Context has not been assembled for this draft.</p>
        </section>
      ) : (
        <ContextSummary context={run.context} sectionId="run-context" />
      )}

      <section
        id="run-plan"
        className="evidence-block"
        aria-labelledby="plan-heading"
        tabIndex={-1}
      >
        <h3 id="plan-heading">Plan</h3>
        {run.plan === null ? (
          <p className="empty-state">No plan exists. This is not a completed agent run.</p>
        ) : (
          <div className="stack stack--small">
            <p>{run.plan.summary}</p>
            <div>
              <h4>Steps</h4>
              <ol>
                {run.plan.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </div>
            <div>
              <h4>Risks</h4>
              {run.plan.risks.length === 0 ? (
                <p>No plan risks were reported.</p>
              ) : (
                <ul>
                  {run.plan.risks.map((risk) => (
                    <li key={risk}>{risk}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </section>

      <section
        id="run-action"
        className="evidence-block"
        aria-labelledby="action-heading"
        tabIndex={-1}
      >
        <h3 id="action-heading">Allowed or proposed action</h3>
        {run.action === null ? (
          <p className="empty-state">No action was proposed or allowed.</p>
        ) : (
          <div className="stack stack--small">
            <div className="evidence-block__heading">
              <strong>{run.action.summary ?? run.action.kind ?? "Bounded action"}</strong>
              <span className={statusClass(run.action.status)}>{run.action.status}</span>
            </div>
            <p>{run.action.rationale ?? "No rationale was recorded."}</p>
            <p>
              <strong>Path:</strong> {run.action.path ?? run.target}
            </p>
            <p>
              <strong>Browser execution allowed:</strong> {run.action.allowed ? "Yes" : "No"}
            </p>
            {run.action.files === undefined || run.action.files.length === 0 ? null : (
              <ul>
                {run.action.files.map((file) => (
                  <li key={file}>{file}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section className="evidence-block" aria-labelledby="files-heading">
        <h3 id="files-heading">Files</h3>
        <dl className="facts facts--compact">
          <div>
            <dt>Involved</dt>
            <dd>{run.files.involved.length}</dd>
          </div>
          <div>
            <dt>Changed</dt>
            <dd>{run.files.changed.length}</dd>
          </div>
        </dl>
        {run.files.involved.length === 0 ? (
          <p className="empty-state">No files are recorded as involved.</p>
        ) : (
          <ul>
            {run.files.involved.map((file) => (
              <li key={file}>
                {file}
                {run.files.changed.includes(file) ? " — changed" : ""}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        id="run-verification"
        className="evidence-block"
        aria-labelledby="verification-heading"
        tabIndex={-1}
      >
        <div className="evidence-block__heading">
          <h3 id="verification-heading">Verification</h3>
          <span className={statusClass(run.verification.outcome)}>
            {run.verification.outcome.replaceAll("_", " ")}
          </span>
        </div>
        <dl className="facts facts--compact">
          <div>
            <dt>Diff digest</dt>
            <dd className="digest">{run.verification.diffSha256 ?? "Not produced"}</dd>
          </div>
          <div>
            <dt>Checkpoint digest</dt>
            <dd className="digest">{run.verification.checkpointSha256 ?? "Not produced"}</dd>
          </div>
        </dl>
      </section>

      <section className="evidence-block" aria-labelledby="checks-heading">
        <div className="evidence-block__heading">
          <h3 id="checks-heading">Checks</h3>
          <span className="count">{run.checks.length}</span>
        </div>
        {run.checks.length === 0 ? (
          <p className="empty-state">Checks: not run. No passing result is implied.</p>
        ) : (
          <div className="card-grid">
            {run.checks.map((check, index) => (
              <CheckEvidence key={check.checkId ?? check.id ?? index} check={check} />
            ))}
          </div>
        )}
      </section>

      <section className="evidence-block" aria-labelledby="diff-heading">
        <h3 id="diff-heading">Diff</h3>
        <pre>{run.diff === null || run.diff.length === 0 ? "No diff was produced." : run.diff}</pre>
      </section>

      <section
        id="run-outputs"
        className="evidence-block"
        aria-labelledby="outputs-heading"
        tabIndex={-1}
      >
        <div className="evidence-block__heading">
          <h3 id="outputs-heading">Outputs</h3>
          <span className="count">{run.outputs.length}</span>
        </div>
        {run.outputs.length === 0 ? (
          <p className="empty-state">No output was recorded.</p>
        ) : (
          run.outputs.map((output, index) => (
            <details
              key={`${output.label ?? output.stream ?? "output"}:${output.text}`}
              open={index === 0}
            >
              <summary>
                {output.label ?? output.stream ?? "Output"}
                {output.truncated ? " — truncated" : ""}
              </summary>
              <pre>{output.text.length === 0 ? "(empty output)" : output.text}</pre>
            </details>
          ))
        )}
      </section>

      <section
        id="run-approvals"
        className="evidence-block"
        aria-labelledby="warnings-heading"
        tabIndex={-1}
      >
        <div className="evidence-block__heading">
          <h3 id="warnings-heading">Warnings</h3>
          <span className="count">{run.warnings.length}</span>
        </div>
        {run.warnings.length === 0 ? (
          <p>No warnings were recorded.</p>
        ) : (
          <ul className="warning-list">
            {run.warnings.map((warning) => {
              const message = typeof warning === "string" ? warning : warning.message;
              const code = typeof warning === "string" ? undefined : warning.code;
              return (
                <li key={`${code ?? "warning"}:${message}`}>
                  {code === undefined ? message : `${code}: ${message}`}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="evidence-block" aria-labelledby="approvals-heading">
        <div className="evidence-block__heading">
          <h3 id="approvals-heading">Approval history</h3>
          <span className="count">{run.approvals.length}</span>
        </div>
        {run.approvals.length === 0 ? (
          <p className="empty-state">No approval decisions are recorded.</p>
        ) : (
          <ol className="timeline">
            {run.approvals.map((approval) => (
              <li key={`${approval.kind}:${approval.digest}:${approval.createdAt}`}>
                <div>
                  <strong>
                    {approval.kind} — {approval.decision}
                  </strong>
                  <time dateTime={approval.createdAt}>{formatTimestamp(approval.createdAt)}</time>
                </div>
                <p>
                  Actor: {approval.actor} · Digest:{" "}
                  <span className="digest">{approval.digest}</span>
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section
        id="run-usage"
        className="evidence-block"
        aria-labelledby="usage-heading"
        tabIndex={-1}
      >
        <h3 id="usage-heading">Measured usage</h3>
        <dl className="facts">
          <div>
            <dt>Tool calls</dt>
            <dd>{run.usage.toolCalls}</dd>
          </div>
          <div>
            <dt>Input tokens</dt>
            <dd>{run.usage.inputTokens}</dd>
          </div>
          <div>
            <dt>Output tokens</dt>
            <dd>{run.usage.outputTokens}</dd>
          </div>
          <div>
            <dt>Active runtime</dt>
            <dd>{run.usage.activeRuntimeMs} ms</dd>
          </div>
          <div>
            <dt>Estimated cost</dt>
            <dd>${run.usage.estimatedCostUsd.toFixed(6)}</dd>
          </div>
          <div>
            <dt>Reserved cost</dt>
            <dd>${run.usage.reservedCostUsd.toFixed(6)}</dd>
          </div>
        </dl>
      </section>

      <section
        id="run-activity"
        className="evidence-block"
        aria-labelledby="timeline-heading"
        tabIndex={-1}
      >
        <div className="evidence-block__heading">
          <h3 id="timeline-heading">Timeline</h3>
          <span
            className="count"
            title={
              run.timelineTruncated
                ? `${run.timeline.length} most recent of ${run.timelineTotal} persisted events`
                : `${run.timelineTotal} persisted events`
            }
          >
            {run.timelineTruncated
              ? `${run.timeline.length} of ${run.timelineTotal}`
              : run.timelineTotal}
          </span>
        </div>
        {run.timelineTruncated ? (
          <p className="message message--info">
            Showing the {run.timeline.length} most recent of {run.timelineTotal} persisted events.
          </p>
        ) : null}
        {run.timeline.length === 0 ? (
          <p className="empty-state">No timeline events were returned.</p>
        ) : (
          <ol className="timeline">
            {run.timeline.map((entry, index) => (
              <li
                key={
                  entry.id ??
                  `${entry.sequence ?? index}:${entry.timestamp ?? entry.createdAt ?? "event"}`
                }
              >
                <div>
                  <a
                    className="timeline__evidence-link"
                    href={`#${evidenceTarget(entry.evidenceSection)}`}
                  >
                    {timelineLabel(entry)}
                  </a>
                  <time dateTime={entry.timestamp ?? entry.createdAt}>
                    {formatTimestamp(entry.timestamp ?? entry.createdAt)}
                  </time>
                </div>
                {entry.detail === undefined ? null : <p>{entry.detail}</p>}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="evidence-block" aria-labelledby="timestamps-heading">
        <h3 id="timestamps-heading">Timestamps</h3>
        <dl className="facts">
          {Object.entries(run.timestamps).map(([name, value]) => (
            <div key={name}>
              <dt>{name.replaceAll(/([A-Z])/g, " $1").toLowerCase()}</dt>
              <dd>{formatTimestamp(value)}</dd>
            </div>
          ))}
        </dl>
      </section>
    </section>
  );
}

export function App() {
  const [workspace, setWorkspace] = useState<WorkspaceView | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<RunView | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const workspaceRequestRef = useRef<AbortController | null>(null);
  const workspaceGenerationRef = useRef(0);
  const selectionRequestRef = useRef<AbortController | null>(null);
  const selectionGenerationRef = useRef(0);

  const cancelPendingRunSelection = useCallback((): void => {
    selectionGenerationRef.current += 1;
    selectionRequestRef.current?.abort();
    selectionRequestRef.current = null;
  }, []);

  const loadWorkspace = useCallback(async (initial = false): Promise<WorkspaceView | null> => {
    workspaceRequestRef.current?.abort();
    const controller = new AbortController();
    const generation = workspaceGenerationRef.current + 1;
    const selectionGeneration = selectionGenerationRef.current;
    workspaceGenerationRef.current = generation;
    workspaceRequestRef.current = controller;
    if (initial) setLoading(true);
    else setRefreshing(true);
    setWorkspaceError(null);
    try {
      const next = await getWorkspace(controller.signal);
      if (controller.signal.aborted || workspaceGenerationRef.current !== generation) return null;
      setWorkspace((current) => {
        if (current === null) return next;
        const incomingIds = new Set(next.runs.map((run) => run.id));
        return {
          ...next,
          runs: [
            ...next.runs.map((run) =>
              newestRun(
                current.runs.find((candidate) => candidate.id === run.id),
                run,
              ),
            ),
            ...current.runs.filter((run) => !incomingIds.has(run.id)),
          ],
        };
      });
      if (selectionGenerationRef.current === selectionGeneration) {
        setSelectedProjectId((current) => {
          if (current !== null && next.projects.some((project) => project.id === current)) {
            return current;
          }
          return next.projects.at(0)?.id ?? null;
        });
        setSelectedRun((current) => {
          if (current === null) return null;
          const candidate = next.runs.find((run) => run.id === current.id);
          return candidate === undefined ? current : newestRun(current, candidate);
        });
      }
      return next;
    } catch (error) {
      if (
        !controller.signal.aborted &&
        workspaceGenerationRef.current === generation &&
        selectionGenerationRef.current === selectionGeneration
      ) {
        setWorkspaceError(errorMessage(error));
      }
      return null;
    } finally {
      if (workspaceRequestRef.current === controller) workspaceRequestRef.current = null;
      if (workspaceGenerationRef.current === generation) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadWorkspace(true);
    return () => {
      workspaceGenerationRef.current += 1;
      workspaceRequestRef.current?.abort();
      workspaceRequestRef.current = null;
    };
  }, [loadWorkspace]);

  useEffect(
    () => () => {
      cancelPendingRunSelection();
    },
    [cancelPendingRunSelection],
  );

  const selectedProject =
    workspace?.projects.find((project) => project.id === selectedProjectId) ?? null;
  const projectRuns = workspace?.runs.filter((run) => run.projectId === selectedProjectId) ?? [];

  const mergeRun = useCallback(async (run: RunView): Promise<void> => {
    setSelectedRun((current) => (current?.id === run.id ? newestRun(current, run) : current));
    setWorkspace((current) => workspaceWithRun(current, run));
  }, []);

  const openRun = useCallback(async (run: RunView): Promise<void> => {
    setSelectedRun((current) => (current?.id === run.id ? newestRun(current, run) : run));
    setSelectedProjectId(run.projectId);
    setWorkspace((current) => workspaceWithRun(current, run));
  }, []);

  const openCreatedRun = useCallback(
    async (run: RunView): Promise<void> => {
      cancelPendingRunSelection();
      await openRun(run);
    },
    [cancelPendingRunSelection, openRun],
  );

  const refreshRun = useCallback(
    async (runId: string): Promise<void> => {
      await mergeRun(await getRun(runId));
    },
    [mergeRun],
  );

  const selectRun = useCallback(
    async (runId: string): Promise<void> => {
      selectionRequestRef.current?.abort();
      const controller = new AbortController();
      const generation = selectionGenerationRef.current + 1;
      selectionGenerationRef.current = generation;
      selectionRequestRef.current = controller;
      setWorkspaceError(null);
      try {
        const run = await getRun(runId, controller.signal);
        if (controller.signal.aborted || selectionGenerationRef.current !== generation) return;
        selectionRequestRef.current = null;
        await openRun(run);
      } catch (error) {
        if (!controller.signal.aborted && selectionGenerationRef.current === generation) {
          setWorkspaceError(errorMessage(error));
        }
      } finally {
        if (selectionRequestRef.current === controller) selectionRequestRef.current = null;
      }
    },
    [openRun],
  );

  const selectProject = useCallback(
    (projectId: string): void => {
      cancelPendingRunSelection();
      setSelectedProjectId(projectId);
      setSelectedRun(null);
    },
    [cancelPendingRunSelection],
  );

  const closeRun = useCallback((): void => {
    cancelPendingRunSelection();
    setSelectedRun(null);
  }, [cancelPendingRunSelection]);

  const projectCreated = async (project: ProjectView): Promise<void> => {
    cancelPendingRunSelection();
    setWorkspace((current) =>
      current === null
        ? current
        : {
            ...current,
            projects: [
              ...current.projects.filter((candidate) => candidate.id !== project.id),
              project,
            ],
          },
    );
    setSelectedProjectId(project.id);
    setSelectedRun(null);
    await loadWorkspace();
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Loopback-only control surface</p>
          <h1>Icarus local workspace</h1>
          <p>Idea → persisted project → strict context → guarded plan → inspectable evidence.</p>
        </div>
        <button
          type="button"
          className="button--secondary"
          disabled={refreshing}
          onClick={() => void loadWorkspace()}
        >
          {refreshing ? "Refreshing…" : "Refresh workspace"}
        </button>
      </header>

      {workspaceError === null ? null : (
        <div className="message message--error app-message" role="alert">
          <span>{workspaceError}</span>
          <button type="button" className="button--secondary" onClick={() => void loadWorkspace()}>
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <main className="loading-state" aria-live="polite">
          <div className="spinner" aria-hidden="true" />
          <p>Loading persisted local state…</p>
        </main>
      ) : workspace === null ? (
        <main className="loading-state">
          <h2>Workspace unavailable</h2>
          <p>Start the local API on 127.0.0.1:8787, then retry.</p>
        </main>
      ) : (
        <main className="workspace-layout">
          <aside className="sidebar">
            <section aria-labelledby="capabilities-heading">
              <h2 id="capabilities-heading">Capabilities</h2>
              <div className="stack stack--small">
                <CapabilityCard label="Provider" capability={workspace.capabilities.provider} />
                <CapabilityCard label="Planning" capability={workspace.capabilities.planning} />
                <CapabilityCard label="Execution" capability={workspace.capabilities.execution} />
              </div>
            </section>

            <section aria-labelledby="projects-heading">
              <div className="sidebar__heading">
                <h2 id="projects-heading">Projects</h2>
                <span className="count">{workspace.projects.length}</span>
              </div>
              {workspace.projects.length === 0 ? (
                <p className="empty-state">No projects are registered.</p>
              ) : (
                <ul className="selection-list">
                  {workspace.projects.map((project) => (
                    <li key={project.id}>
                      <button
                        type="button"
                        className={selectedProjectId === project.id ? "is-selected" : undefined}
                        aria-pressed={selectedProjectId === project.id}
                        onClick={() => selectProject(project.id)}
                      >
                        <span>
                          <strong>{project.name}</strong>
                          <small>{project.repository.path}</small>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="all-runs-heading">
              <div className="sidebar__heading">
                <h2 id="all-runs-heading">Recent runs</h2>
                <span className="count">{workspace.runs.length}</span>
              </div>
              {workspace.runs.length === 0 ? (
                <p className="empty-state">No run records exist.</p>
              ) : (
                <ul className="selection-list selection-list--compact">
                  {workspace.runs.slice(0, 12).map((run) => (
                    <li key={run.id}>
                      <button
                        type="button"
                        className={selectedRun?.id === run.id ? "is-selected" : undefined}
                        aria-pressed={selectedRun?.id === run.id}
                        onClick={() => void selectRun(run.id)}
                      >
                        <span>
                          <strong>{run.task}</strong>
                          <small>{run.target}</small>
                        </span>
                        <span className={statusClass(run.phase)}>
                          {run.phase.replaceAll("_", " ")}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </aside>

          <div className="content">
            {selectedRun === null ? (
              selectedProject === null ? (
                <ProjectRegistrationForm busy={refreshing} onCreated={projectCreated} />
              ) : (
                <>
                  <ProjectDetail
                    key={selectedProject.id}
                    project={selectedProject}
                    planningCapability={workspace.capabilities.planning}
                    runs={projectRuns}
                    onSelectRun={selectRun}
                    onRunCreated={openCreatedRun}
                  />
                  <ProjectRegistrationForm busy={refreshing} onCreated={projectCreated} />
                </>
              )
            ) : (
              <div className="stack">
                <button type="button" className="back-button" onClick={closeRun}>
                  ← Back to project
                </button>
                <RunEvidence
                  key={selectedRun.id}
                  run={selectedRun}
                  planningCapability={workspace.capabilities.planning}
                  onRunChanged={mergeRun}
                  onRefresh={refreshRun}
                />
              </div>
            )}
          </div>
        </main>
      )}

      <footer>
        <p>
          Icarus renders persisted API data as text. Missing checks, plans, diffs, and outputs
          remain explicitly missing.
        </p>
      </footer>
    </div>
  );
}
