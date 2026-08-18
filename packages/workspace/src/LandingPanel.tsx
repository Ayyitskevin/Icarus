import type { LandingView } from "./api.js";

export interface LandingPanelProps {
  readonly landing: LandingView | null;
  readonly landingRevision: number;
}

export function LandingPanel({ landing, landingRevision }: LandingPanelProps) {
  return (
    <section
      id="run-landing"
      className="evidence-block landing-panel"
      aria-labelledby="run-landing-heading"
      tabIndex={-1}
    >
      <div className="evidence-block__heading">
        <div>
          <p className="eyebrow">Read-only landing evidence</p>
          <h3 id="run-landing-heading">Git landing</h3>
        </div>
        <span className="count">revision {landingRevision}</span>
      </div>

      {landing === null ? (
        <p className="empty-state">
          No landing record is present. The independent landing revision is {landingRevision}.
        </p>
      ) : (
        <>
          <dl className="facts">
            <div>
              <dt>Exact landing state</dt>
              <dd>{landing.state}</dd>
            </div>
            <div>
              <dt>Exact resume state</dt>
              <dd>{landing.resumeState ?? "Not applicable"}</dd>
            </div>
            <div>
              <dt>Landing ID</dt>
              <dd className="digest">{landing.landingId}</dd>
            </div>
            <div>
              <dt>Record version</dt>
              <dd>{landing.version}</dd>
            </div>
            <div>
              <dt>Landing revision</dt>
              <dd>{landingRevision}</dd>
            </div>
            <div>
              <dt>Landing SHA-256</dt>
              <dd className="digest">{landing.landingSha256 ?? "Not available"}</dd>
            </div>
            <div>
              <dt>Candidate commit SHA-1</dt>
              <dd className="digest">{landing.candidateCommitSha1 ?? "Not available"}</dd>
            </div>
            <div>
              <dt>Recorded decision</dt>
              <dd>
                {landing.decision === null
                  ? "Not recorded"
                  : `${landing.decision.decision} by ${landing.decision.actor} at ${landing.decision.createdAt}`}
              </dd>
            </div>
            <div>
              <dt>Error code</dt>
              <dd>{landing.errorCode ?? "None recorded"}</dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>
                <time dateTime={landing.updatedAt}>{landing.updatedAt}</time>
              </dd>
            </div>
          </dl>

          <section className="landing-panel__pull-request" aria-labelledby="landing-pr-heading">
            <h4 id="landing-pr-heading">Exact draft pull request</h4>
            <dl className="facts facts--compact">
              <div>
                <dt>Title</dt>
                <dd className="landing-panel__title">{landing.pullRequestTitle}</dd>
              </div>
            </dl>
            <h5>Complete derived body</h5>
            {landing.pullRequestBody === null ? (
              <p className="empty-state">
                The complete derived pull-request body is not available until the landing digest is
                reconstructable.
              </p>
            ) : (
              <pre className="landing-panel__body">{landing.pullRequestBody}</pre>
            )}
          </section>

          <section className="landing-panel__receipt" aria-labelledby="landing-receipt-heading">
            <h4 id="landing-receipt-heading">Landing receipt</h4>
            {landing.receipt === null ? (
              <p className="empty-state">
                No receipt is recorded. The receipt exists only after the landing lands.
              </p>
            ) : (
              <dl className="facts facts--compact">
                <div>
                  <dt>Draft pull request</dt>
                  <dd>
                    #{landing.receipt.pullRequestNumber} ({landing.receipt.pullRequestOutcome}) —{" "}
                    {landing.receipt.reconstructedPullRequestUrl}
                  </dd>
                </div>
                <div>
                  <dt>Head reference</dt>
                  <dd className="digest">{landing.receipt.headRef}</dd>
                </div>
                <div>
                  <dt>Base</dt>
                  <dd>
                    {landing.receipt.baseRef} at{" "}
                    <span className="digest">{landing.receipt.baseCommitSha1}</span>
                  </dd>
                </div>
                <div>
                  <dt>Candidate commit SHA-1</dt>
                  <dd className="digest">{landing.receipt.candidateCommitSha1}</dd>
                </div>
                <div>
                  <dt>Local ref outcome</dt>
                  <dd>{landing.receipt.localRefOutcome}</dd>
                </div>
                <div>
                  <dt>Remote object outcome</dt>
                  <dd>{landing.receipt.remoteObjectOutcome}</dd>
                </div>
                <div>
                  <dt>Remote ref outcome</dt>
                  <dd>{landing.receipt.remoteRefOutcome}</dd>
                </div>
                <div>
                  <dt>Landing SHA-256</dt>
                  <dd className="digest">{landing.receipt.landingSha256}</dd>
                </div>
                <div>
                  <dt>Completed</dt>
                  <dd>
                    <time dateTime={landing.receipt.completedAt}>
                      {landing.receipt.completedAt}
                    </time>
                  </dd>
                </div>
              </dl>
            )}
          </section>

          <section className="landing-panel__effects" aria-labelledby="landing-effects-heading">
            <h4 id="landing-effects-heading">Landing effects</h4>
            <p className="message message--warning" role="note">
              {landing.effectWarning}
            </p>

            <h5>Direct Icarus effects</h5>
            <ul>
              {landing.directIcarusEffects.map((effect) => (
                <li key={effect}>
                  <code>{effect}</code>
                </li>
              ))}
            </ul>

            <h5>Derivative GitHub events</h5>
            <ul>
              {landing.derivativeEffectDisclosure.githubEvents.map((event) => (
                <li key={event}>
                  <code>{event}</code>
                </li>
              ))}
            </ul>

            <h5>Repository-configured systems that may react</h5>
            <ul>
              {landing.derivativeEffectDisclosure.mayTrigger.map((effect) => (
                <li key={effect}>{effect}</li>
              ))}
            </ul>

            <dl className="facts facts--compact">
              <div>
                <dt>Assessment disposition</dt>
                <dd>{landing.derivativeEffectDisclosure.disposition}</dd>
              </div>
              <div>
                <dt>Assessment evidence SHA-256</dt>
                <dd className="digest">{landing.derivativeEffectDisclosure.evidenceSha256}</dd>
              </div>
            </dl>
          </section>
        </>
      )}
    </section>
  );
}
