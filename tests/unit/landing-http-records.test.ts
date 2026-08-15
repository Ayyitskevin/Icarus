import { describe, expect, it } from "vitest";

import { sha256 } from "../../packages/core/src/digest.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import {
  canonicalLandingJson,
  decodeCanonicalLandingHttpResultJsonV1,
  decodeLandingHttpResultV1,
  type PullRequestProjectionV1,
} from "../../packages/core/src/landing-records.js";

const REQUEST_ID = "66666666-6666-4666-8666-666666666666";
const BASE_COMMIT = "a".repeat(40);
const CANDIDATE_COMMIT = "d".repeat(40);
const RUN_ID = "22222222-2222-4222-8222-222222222222";

function expectIcarusCode(action: () => unknown, code = "LANDING_RECORD_INVALID"): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(IcarusError);
    expect((error as IcarusError).code).toBe(code);
  }
}

const PULL_REQUEST_PROJECTION: PullRequestProjectionV1 = {
  type: "pull_request",
  number: 17,
  state: "open",
  draft: true,
  owner: "octocat",
  repository: "icarus-target",
  headOwner: "octocat",
  headRef: `icarus/${RUN_ID}`,
  headSha1: CANDIDATE_COMMIT,
  baseRef: "main",
  baseSha1: BASE_COMMIT,
  titleSha256: sha256("title"),
  bodySha256: sha256("body"),
  markerCount: 1,
  maintainerCanModify: false,
};

function resultFixture() {
  return {
    schemaVersion: 1,
    requestId: REQUEST_ID,
    kind: "github.actor.get",
    outcome: "succeeded",
    httpStatus: 200,
    projection: { type: "actor", login: "octocat" },
    errorCode: null,
  } as const;
}

describe("landing HTTPS result record (ADR 0027 record contract)", () => {
  it("decodes every succeeded GET projection shape and round-trips canonically", () => {
    const actor = resultFixture();
    expect(decodeLandingHttpResultV1(actor)).toEqual(actor);
    expect(decodeCanonicalLandingHttpResultJsonV1(canonicalLandingJson(actor))).toEqual(actor);

    const baseRef = {
      ...resultFixture(),
      kind: "github.base_ref.get",
      projection: { type: "ref", state: "direct", ref: "refs/heads/main", sha1: BASE_COMMIT },
    };
    expect(decodeLandingHttpResultV1(baseRef)).toEqual(baseRef);

    // The one closed exception: the head-ref GET's documented 404 is semantic
    // success carrying the absent projection.
    const headAbsent = {
      ...resultFixture(),
      kind: "github.head_ref.get",
      httpStatus: 404,
      projection: {
        type: "ref",
        state: "absent",
        ref: `refs/heads/icarus/${RUN_ID}`,
        sha1: null,
      },
    };
    expect(decodeLandingHttpResultV1(headAbsent)).toEqual(headAbsent);

    const headDirect = {
      ...resultFixture(),
      kind: "github.head_ref.get",
      projection: {
        type: "ref",
        state: "direct",
        ref: `refs/heads/icarus/${RUN_ID}`,
        sha1: CANDIDATE_COMMIT,
      },
    };
    expect(decodeLandingHttpResultV1(headDirect)).toEqual(headDirect);

    const emptyList = {
      ...resultFixture(),
      kind: "github.pull_requests.get",
      projection: { type: "pull_request_list", complete: true, count: 0, objects: [] },
    };
    expect(decodeLandingHttpResultV1(emptyList)).toEqual(emptyList);
  });

  it("decodes the object and pull-request POST projections by owning kind", () => {
    for (const [kind, objectKind, wrongKind] of [
      ["github.blob.post", "blob", "tree"],
      ["github.tree.post", "tree", "blob"],
      ["github.commit.post", "commit", "blob"],
      ["github.ref.post", "ref", "blob"],
    ] as const) {
      const value = {
        ...resultFixture(),
        kind,
        httpStatus: 201,
        projection: { type: "object", objectKind, sha1: CANDIDATE_COMMIT },
      };
      expect(decodeLandingHttpResultV1(value)).toEqual(value);
      expectIcarusCode(() =>
        decodeLandingHttpResultV1({
          ...value,
          projection: { type: "object", objectKind: wrongKind, sha1: CANDIDATE_COMMIT },
        }),
      );
    }
    const pullRequest = {
      ...resultFixture(),
      kind: "github.pull_request.post",
      httpStatus: 201,
      projection: PULL_REQUEST_PROJECTION,
    };
    expect(decodeLandingHttpResultV1(pullRequest)).toEqual(pullRequest);
  });

  it("rejects unknown kinds, wrong shapes, and missing or extra keys", () => {
    expectIcarusCode(() => decodeLandingHttpResultV1({ ...resultFixture(), kind: "github.push" }));
    expectIcarusCode(() => decodeLandingHttpResultV1({ ...resultFixture(), outcome: "retryable" }));
    expectIcarusCode(() => decodeLandingHttpResultV1({ ...resultFixture(), extra: true }));
    const { projection: _omitted, ...missingProjection } = resultFixture();
    expectIcarusCode(() => decodeLandingHttpResultV1(missingProjection));
    expectIcarusCode(() =>
      decodeLandingHttpResultV1({ ...resultFixture(), requestId: REQUEST_ID.replace("6", "g") }),
    );
  });

  it("rejects a success outside the kind's status envelope or carrying an error", () => {
    expectIcarusCode(() => decodeLandingHttpResultV1({ ...resultFixture(), httpStatus: 404 }));
    expectIcarusCode(() => decodeLandingHttpResultV1({ ...resultFixture(), httpStatus: 301 }));
    expectIcarusCode(() => decodeLandingHttpResultV1({ ...resultFixture(), httpStatus: 99 }));
    expectIcarusCode(() => decodeLandingHttpResultV1({ ...resultFixture(), httpStatus: 600 }));
    expectIcarusCode(() =>
      decodeLandingHttpResultV1({ ...resultFixture(), errorCode: "GITHUB_HTTP_ERROR" }),
    );
    expectIcarusCode(() => decodeLandingHttpResultV1({ ...resultFixture(), projection: null }));
    // The head-ref 404 exception is closed: no other kind may use it, and the
    // projection must agree with the status in both directions.
    expectIcarusCode(() =>
      decodeLandingHttpResultV1({
        ...resultFixture(),
        kind: "github.head_ref.get",
        httpStatus: 200,
        projection: {
          type: "ref",
          state: "absent",
          ref: `refs/heads/icarus/${RUN_ID}`,
          sha1: null,
        },
      }),
    );
    expectIcarusCode(() =>
      decodeLandingHttpResultV1({
        ...resultFixture(),
        kind: "github.head_ref.get",
        httpStatus: 404,
        projection: {
          type: "ref",
          state: "direct",
          ref: `refs/heads/icarus/${RUN_ID}`,
          sha1: CANDIDATE_COMMIT,
        },
      }),
    );
  });

  it("never treats a base-ref 404 as a provable absence", () => {
    expectIcarusCode(() =>
      decodeLandingHttpResultV1({
        ...resultFixture(),
        kind: "github.base_ref.get",
        httpStatus: 404,
        projection: { type: "ref", state: "absent", ref: "refs/heads/main", sha1: null },
      }),
    );
    // The honest shape for a missing base: a failed outcome with the known
    // status, no projection, and a safe host error.
    const failed = {
      ...resultFixture(),
      kind: "github.base_ref.get",
      outcome: "failed",
      httpStatus: 404,
      projection: null,
      errorCode: "LANDING_REMOTE_BASE_MISSING",
    };
    expect(decodeLandingHttpResultV1(failed)).toEqual(failed);
  });

  it("rejects a failed outcome carrying a projection or no safe error", () => {
    const failed = {
      ...resultFixture(),
      outcome: "failed",
      httpStatus: null,
      projection: null,
      errorCode: "GITHUB_TRANSPORT_ERROR",
    };
    expect(decodeLandingHttpResultV1(failed)).toEqual(failed);
    expectIcarusCode(() =>
      decodeLandingHttpResultV1({ ...failed, projection: { type: "actor", login: "octocat" } }),
    );
    expectIcarusCode(() => decodeLandingHttpResultV1({ ...failed, errorCode: null }));
    expectIcarusCode(() => decodeLandingHttpResultV1({ ...failed, errorCode: "lowercase" }));
    expectIcarusCode(() => decodeLandingHttpResultV1({ ...failed, httpStatus: 700 }));
  });

  it("pins ambiguity to the one honest code with no status or projection", () => {
    const ambiguous = {
      ...resultFixture(),
      outcome: "ambiguous",
      httpStatus: null,
      projection: null,
      errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
    };
    expect(decodeLandingHttpResultV1(ambiguous)).toEqual(ambiguous);
    // A settled-ambiguous row must never infer failure from an absent
    // response, so no other error code can carry the ambiguity.
    expectIcarusCode(() =>
      decodeLandingHttpResultV1({ ...ambiguous, errorCode: "GITHUB_TIMEOUT" }),
    );
    expectIcarusCode(() => decodeLandingHttpResultV1({ ...ambiguous, httpStatus: 200 }));
    expectIcarusCode(() =>
      decodeLandingHttpResultV1({
        ...ambiguous,
        projection: { type: "actor", login: "octocat" },
      }),
    );
  });

  it("enforces the pull-request list's count, order, uniqueness, and page rule", () => {
    const list = {
      ...resultFixture(),
      kind: "github.pull_requests.get",
      projection: {
        type: "pull_request_list",
        complete: true,
        count: 1,
        objects: [PULL_REQUEST_PROJECTION],
      },
    };
    expect(decodeLandingHttpResultV1(list)).toEqual(list);
    expectIcarusCode(() =>
      decodeLandingHttpResultV1({
        ...list,
        projection: { ...list.projection, count: 0 },
      }),
    );
    expectIcarusCode(() =>
      decodeLandingHttpResultV1({
        ...list,
        projection: {
          ...list.projection,
          objects: [
            { ...PULL_REQUEST_PROJECTION, number: 9 },
            { ...PULL_REQUEST_PROJECTION, number: 3 },
          ],
          count: 2,
        },
      }),
    );
    expectIcarusCode(() =>
      decodeLandingHttpResultV1({
        ...list,
        projection: {
          ...list.projection,
          objects: [PULL_REQUEST_PROJECTION, PULL_REQUEST_PROJECTION],
          count: 2,
        },
      }),
    );
    // A list marked complete at the pinned page size could hide a next page;
    // it can never prove absence or uniqueness.
    const fullPage = {
      ...list.projection,
      complete: true,
      count: 100,
      objects: Array.from({ length: 100 }, (_entry, index) => ({
        ...PULL_REQUEST_PROJECTION,
        number: index + 1,
      })),
    };
    expectIcarusCode(() => decodeLandingHttpResultV1({ ...list, projection: fullPage }));
    // The same page marked incomplete is honest and decodes.
    expect(
      decodeLandingHttpResultV1({
        ...list,
        projection: { ...fullPage, complete: false },
      }).projection,
    ).toMatchObject({ complete: false, count: 100 });
  });

  it("rejects non-canonical persisted bytes and provider-side identity drift", () => {
    const encoded = canonicalLandingJson(resultFixture());
    expectIcarusCode(() => decodeCanonicalLandingHttpResultJsonV1(`${encoded}\n`));
    expectIcarusCode(() =>
      decodeCanonicalLandingHttpResultJsonV1(encoded.replace('"actor"', '"actorx"')),
    );
    expectIcarusCode(() =>
      decodeLandingHttpResultV1({
        ...resultFixture(),
        projection: { type: "actor", login: "Octocat" },
      }),
    );
  });
});
