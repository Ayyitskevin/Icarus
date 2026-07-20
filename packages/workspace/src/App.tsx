import type { FormEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CapabilityView,
  CheckEvidenceView,
  ContextMetadataView,
  CreateProjectInput,
  ProjectView,
  RunView,
  WorkspaceView,
} from "./api.js";
import {
  createProject,
  createRun,
  errorMessage,
  getRun,
  getWorkspace,
  planRun,
  previewProjectContext,
  unwrapContextPreview,
} from "./api.js";

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

function ContextSummary({ context }: { context: ContextMetadataView }) {
  const digest = context.sha256 ?? context.digest;
  return (
    <section className="evidence-block" aria-labelledby="context-summary-heading">
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

      {run.context === null ? (
        <section className="evidence-block">
          <h3>Context summary</h3>
          <p className="empty-state">Context has not been assembled for this draft.</p>
        </section>
      ) : (
        <ContextSummary context={run.context} />
      )}

      <section className="evidence-block" aria-labelledby="plan-heading">
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

      <section className="evidence-block" aria-labelledby="action-heading">
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

      <section className="evidence-block" aria-labelledby="verification-heading">
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

      <section className="evidence-block" aria-labelledby="outputs-heading">
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

      <section className="evidence-block" aria-labelledby="warnings-heading">
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

      <section className="evidence-block" aria-labelledby="usage-heading">
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

      <section className="evidence-block" aria-labelledby="timeline-heading">
        <div className="evidence-block__heading">
          <h3 id="timeline-heading">Timeline</h3>
          <span className="count">{run.timeline.length}</span>
        </div>
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
                  <strong>
                    {entry.label ?? entry.phase?.replaceAll("_", " ") ?? entry.state ?? "Run event"}
                  </strong>
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

  const loadWorkspace = useCallback(async (initial = false): Promise<WorkspaceView | null> => {
    if (initial) setLoading(true);
    else setRefreshing(true);
    setWorkspaceError(null);
    try {
      const next = await getWorkspace();
      setWorkspace(next);
      setSelectedProjectId((current) => {
        if (current !== null && next.projects.some((project) => project.id === current)) {
          return current;
        }
        return next.projects.at(0)?.id ?? null;
      });
      setSelectedRun((current) => {
        if (current === null) return null;
        return next.runs.find((run) => run.id === current.id) ?? current;
      });
      return next;
    } catch (error) {
      setWorkspaceError(errorMessage(error));
      return null;
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkspace(true);
  }, [loadWorkspace]);

  const selectedProject =
    workspace?.projects.find((project) => project.id === selectedProjectId) ?? null;
  const projectRuns = workspace?.runs.filter((run) => run.projectId === selectedProjectId) ?? [];

  const selectProject = (projectId: string): void => {
    setSelectedProjectId(projectId);
    setSelectedRun(null);
  };

  const selectRun = async (runId: string): Promise<void> => {
    try {
      const run = await getRun(runId);
      setSelectedRun(run);
      setSelectedProjectId(run.projectId);
    } catch (error) {
      setWorkspaceError(errorMessage(error));
    }
  };

  const mergeRun = async (run: RunView): Promise<void> => {
    setSelectedRun(run);
    setSelectedProjectId(run.projectId);
    setWorkspace((current) =>
      current === null
        ? current
        : {
            ...current,
            runs: [run, ...current.runs.filter((candidate) => candidate.id !== run.id)],
          },
    );
  };

  const projectCreated = async (project: ProjectView): Promise<void> => {
    const next = await loadWorkspace();
    setSelectedProjectId(
      next?.projects.some((candidate) => candidate.id === project.id)
        ? project.id
        : (next?.projects.at(-1)?.id ?? null),
    );
    setSelectedRun(null);
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
                    onRunCreated={mergeRun}
                  />
                  <ProjectRegistrationForm busy={refreshing} onCreated={projectCreated} />
                </>
              )
            ) : (
              <div className="stack">
                <button type="button" className="back-button" onClick={() => setSelectedRun(null)}>
                  ← Back to project
                </button>
                <RunEvidence
                  run={selectedRun}
                  planningCapability={workspace.capabilities.planning}
                  onRunChanged={mergeRun}
                  onRefresh={selectRun}
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
