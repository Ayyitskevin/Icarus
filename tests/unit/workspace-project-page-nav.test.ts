import { describe, expect, test } from "vitest";

import type { ProjectPageView, ProjectView } from "../../packages/workspace/src/api.js";
import {
  acceptProjectPage,
  canNavigateToNewerProjects,
  canNavigateToOlderProjects,
  createProjectPageSession,
  PROJECT_CHECKS_MAX_BYTES,
  PROJECT_PAGE_MAX_NEWER_CURSORS,
  PROJECT_PAGE_MAX_PAGES,
  PROJECT_PAGE_SIZE,
  projectPageDepth,
  projectPageRequest,
} from "../../packages/workspace/src/project-page-nav.js";

const IMAGE = `python@sha256:${"c".repeat(64)}`;

function project(index: number): ProjectView {
  return {
    id: `20000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    name: `project-${index}`,
    repository: {
      id: "30000000-0000-4000-8000-000000000001",
      name: "catalog-repository",
      path: "/tmp/catalog-repository",
    },
    baseRef: "main",
    checks: [{ id: "unit", name: "Unit check", argv: ["node", "--test"] }],
    sandbox: { image: IMAGE, cpus: 2, memoryMb: 4_096, pids: 256, tmpfsMb: 1_024 },
    ceiling: {
      maxToolCalls: 40,
      maxActiveRuntimeMs: 1_200_000,
      maxContextBytes: 196_608,
      maxOutputTokensPerCall: 8_192,
      maxTotalTokens: 100_000,
      maxCostUsd: 2,
      maxFilesChanged: 1,
      maxFileBytes: 262_144,
      maxDiffBytes: 262_144,
      maxCommandOutputBytes: 262_144,
      maxRawCommandOutputBytes: 8_388_608,
      providerTimeoutMs: 300_000,
      commandTimeoutMs: 300_000,
    },
    createdAt: "2026-07-22T12:00:00.000Z",
  };
}

function page(
  before: number,
  snapshot: number,
  count: number,
  hasMore: boolean,
  nextBefore: number,
  offset = 0,
): ProjectPageView {
  return {
    before,
    snapshot,
    nextBefore,
    hasMore,
    projects: Array.from({ length: count }, (_, index) => project(offset + index + 1)),
  };
}

describe("workspace bounded project-page navigation", () => {
  test("accepts the exact empty newest-page contract", () => {
    const empty: ProjectPageView = {
      before: 1,
      snapshot: 0,
      nextBefore: 1,
      hasMore: false,
      projects: [],
    };
    const session = createProjectPageSession(empty);

    expect(session).toEqual({ snapshot: 0, initialBefore: 1, page: empty, newerBefore: [] });
    expect(projectPageDepth(session)).toBe(1);
    expect(canNavigateToOlderProjects(session)).toBe(false);
    expect(canNavigateToNewerProjects(session)).toBe(false);
  });

  test("replaces pages and retains only three newer cursors", () => {
    let session = createProjectPageSession(page(501, 500, 12, true, 489));
    expect(PROJECT_PAGE_SIZE).toBe(12);

    for (const [before, nextBefore, offset] of [
      [489, 477, 12],
      [477, 465, 24],
      [465, 453, 36],
    ] as const) {
      const request = projectPageRequest(session, "older");
      expect(request.before).toBe(before);
      session = acceptProjectPage(
        session,
        request,
        page(before, 500, 12, true, nextBefore, offset),
      );
    }

    expect(PROJECT_PAGE_MAX_PAGES).toBe(4);
    expect(PROJECT_PAGE_MAX_NEWER_CURSORS).toBe(3);
    expect(session.newerBefore).toEqual([501, 489, 477]);
    expect(projectPageDepth(session)).toBe(4);
    expect(canNavigateToOlderProjects(session)).toBe(false);
    expect(() => projectPageRequest(session, "older")).toThrow("cannot navigate farther back");

    const newer = projectPageRequest(session, "newer");
    session = acceptProjectPage(session, newer, page(477, 500, 12, true, 465, 24));
    expect(session.newerBefore).toEqual([501, 489]);
    expect(projectPageDepth(session)).toBe(3);
  });

  test("rejects mismatched, malformed, oversized, and stale pages", () => {
    const initialPage = page(101, 100, 12, true, 89);
    const session = createProjectPageSession(initialPage);
    const request = projectPageRequest(session, "older");
    const valid = page(89, 100, 12, true, 77, 12);
    const first = valid.projects[0];
    if (first === undefined) throw new Error("Fixture project is missing");

    const invalid: readonly unknown[] = [
      { ...valid, before: 88 },
      { ...valid, snapshot: 99 },
      { ...valid, nextBefore: 89 },
      { ...valid, projects: [...valid.projects, project(99)] },
      { ...valid, projects: valid.projects.slice(0, 11) },
      { ...valid, projects: [first, first, ...valid.projects.slice(2)] },
      { ...valid, unexpected: true },
      { ...valid, projects: [{ ...first, privateDetail: true }, ...valid.projects.slice(1)] },
      {
        ...valid,
        projects: [
          { ...first, repository: { ...first.repository, unexpected: true } },
          ...valid.projects.slice(1),
        ],
      },
      {
        ...valid,
        projects: [{ ...first, id: first.id.toUpperCase() }, ...valid.projects.slice(1)],
      },
      { ...valid, projects: [{ ...first, baseRef: "-main" }, ...valid.projects.slice(1)] },
      {
        ...valid,
        projects: [
          { ...first, checks: [{ ...first.checks[0], argv: ["node\n--test"] }] },
          ...valid.projects.slice(1),
        ],
      },
      {
        ...valid,
        projects: [
          {
            ...first,
            checks: [{ id: "huge", name: "Huge", argv: ["x".repeat(PROJECT_CHECKS_MAX_BYTES)] }],
          },
          ...valid.projects.slice(1),
        ],
      },
      {
        ...valid,
        projects: [
          { ...first, ceiling: { ...first.ceiling, maxFilesChanged: 2 } },
          ...valid.projects.slice(1),
        ],
      },
      { ...valid, projects: [{ ...first, createdAt: "not-a-time" }, ...valid.projects.slice(1)] },
    ];

    for (const candidate of invalid) {
      expect(() => acceptProjectPage(session, request, candidate)).toThrow();
      expect(session.page).toBe(initialPage);
      expect(session.newerBefore).toEqual([]);
    }

    const accepted = acceptProjectPage(session, request, valid);
    expect(() => acceptProjectPage(accepted, request, valid)).toThrow("cursor is stale");
  });

  test("preserves the last page and exact retry request after rejection", () => {
    const first = page(101, 100, 12, true, 89);
    const session = createProjectPageSession(first);
    const request = projectPageRequest(session, "older");

    expect(() =>
      acceptProjectPage(session, request, { ...page(89, 100, 12, true, 77), before: 88 }),
    ).toThrow();
    expect(session.page).toBe(first);
    expect(projectPageRequest(session, "older")).toEqual(request);
  });
});
