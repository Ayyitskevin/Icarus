import { createRequire } from "node:module";

import { describe, expect, test } from "vitest";

import { LANDING_EFFECT_WARNING } from "../../packages/api/src/present.js";
import type { LandingView } from "../../packages/workspace/src/api.js";
import { LandingPanel } from "../../packages/workspace/src/LandingPanel.js";

const workspaceRequire = createRequire(
  new URL("../../packages/workspace/package.json", import.meta.url),
);
const { createElement } = workspaceRequire("react") as {
  createElement(type: unknown, props: unknown): unknown;
};
const { renderToStaticMarkup } = workspaceRequire("react-dom/server") as {
  renderToStaticMarkup(element: unknown): string;
};

function landing(): LandingView {
  return {
    landingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    state: "reconciliation_required",
    resumeState: "objects_ready",
    version: 4,
    landingSha256: "a".repeat(64),
    candidateCommitSha1: "b".repeat(40),
    pullRequestTitle: "Exact <script>title()</script>",
    pullRequestBody:
      "line one\n\nline two <img src=x onerror=alert(1)>\n\n<!-- icarus-landing:v1 -->",
    decision: {
      actor: "operator <admin>",
      decision: "approve",
      createdAt: "2026-08-02T12:00:00.000Z",
    },
    errorCode: "AMBIGUOUS_REMOTE_EFFECT",
    updatedAt: "2026-08-02T12:01:00.000Z",
    directIcarusEffects: [
      "local_ref.create",
      "github.objects.upload",
      "github.ref.create",
      "github.draft_pull_request.create",
    ],
    derivativeEffectDisclosure: {
      version: 1,
      githubEvents: ["create", "pull_request.opened"],
      mayTrigger: ["actions", "webhooks", "bots", "notifications", "deployments"],
      disposition: "operator-approved",
      evidenceSha256: "c".repeat(64),
    },
    effectWarning: LANDING_EFFECT_WARNING,
  };
}

describe("workspace read-only landing panel", () => {
  test("renders the exact bounded landing projection as inert text with no controls", () => {
    const markup = renderToStaticMarkup(
      createElement(LandingPanel, { landing: landing(), landingRevision: 12 }),
    );

    expect(markup).toContain("reconciliation_required");
    expect(markup).toContain("objects_ready");
    expect(markup).toContain("a".repeat(64));
    expect(markup).toContain("b".repeat(40));
    expect(markup).toContain("Exact &lt;script&gt;title()&lt;/script&gt;");
    expect(markup).toContain(
      "line one\n\nline two &lt;img src=x onerror=alert(1)&gt;\n\n&lt;!-- icarus-landing:v1 --&gt;",
    );
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<img");
    expect(markup).not.toMatch(/<(?:a|button|form|input|select|textarea)\b/u);
    expect(markup).toContain(LANDING_EFFECT_WARNING);
    expect(markup).toContain("local_ref.create");
    expect(markup).toContain("github.draft_pull_request.create");
    expect(markup).toContain("pull_request.opened");
    expect(markup).toContain("deployments");
    expect(markup).toContain("operator-approved");
    expect(markup).toContain("c".repeat(64));
    expect(markup).toContain("AMBIGUOUS_REMOTE_EFFECT");
  });

  test("states explicitly when no landing record exists", () => {
    const markup = renderToStaticMarkup(
      createElement(LandingPanel, { landing: null, landingRevision: 0 }),
    );

    expect(markup).toContain("No landing record is present");
    expect(markup).toContain("independent landing revision is 0");
    expect(markup).not.toMatch(/<(?:a|button|form|input|select|textarea)\b/u);
  });
});
