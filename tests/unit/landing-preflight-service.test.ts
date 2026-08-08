import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactStore } from "../../packages/core/src/artifacts.js";
import type { GitController } from "../../packages/core/src/git.js";
import {
  type GitHubLandingCredentialResolverV1,
  GitHubLandingGatewayV1,
  type GitHubLandingTransport,
  type GitHubLandingTransportOutcome,
  type GitHubLandingTransportRequest,
} from "../../packages/core/src/github-landing-gateway.js";
import type {
  LandingGitHubRequestAdmittedEventV1,
  LandingGitHubRequestSettledEventV1,
} from "../../packages/core/src/landing-records.js";
import type { CheckRunner } from "../../packages/core/src/sandbox.js";
import {
  IcarusService,
  type IcarusServiceOptions,
  type LandingGitService,
} from "../../packages/core/src/service.js";
import {
  createLandingGitHubMaterialFixture,
  type LandingGitHubMaterialFixture,
  MATERIAL_PROFILE,
} from "../support/landing-github-material-fixture.js";
import { UNIT_BASE_COMMIT, UNIT_RUN_ID } from "../support/unit-fixtures.js";

const FAKE_CREDENTIAL = "fake-preflight-token-do-not-persist";
const ENVIRONMENT_SENTINEL = "environment-token-sentinel-do-not-persist";

interface TestDatabase {
  prepare(sql: string): { run(): unknown };
  close(): void;
}

const Database = createRequire(new URL("../../packages/core/package.json", import.meta.url))(
  "better-sqlite3",
) as new (
  filename: string,
) => TestDatabase;

const fixtures: LandingGitHubMaterialFixture[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) {
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function jsonResponse(status: number, value: unknown): GitHubLandingTransportOutcome {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  return {
    kind: "response",
    status,
    headers: [
      ["content-type", "application/json; charset=utf-8"],
      ["content-length", String(body.byteLength)],
    ],
    body,
  };
}

function successfulResponse(request: GitHubLandingTransportRequest): GitHubLandingTransportOutcome {
  if (request.path === "/user") {
    return jsonResponse(200, { login: MATERIAL_PROFILE.expectedActor });
  }
  if (
    request.path ===
    `/repos/${MATERIAL_PROFILE.owner}/${MATERIAL_PROFILE.repository}/git/ref/heads/${MATERIAL_PROFILE.baseBranch}`
  ) {
    return jsonResponse(200, {
      ref: `refs/heads/${MATERIAL_PROFILE.baseBranch}`,
      object: { type: "commit", sha: UNIT_BASE_COMMIT },
    });
  }
  if (
    request.path ===
    `/repos/${MATERIAL_PROFILE.owner}/${MATERIAL_PROFILE.repository}/git/ref/heads/icarus/${UNIT_RUN_ID}`
  ) {
    return jsonResponse(404, {
      message: "Not Found",
      documentation_url: "https://docs.github.com/rest/git/refs#get-a-reference",
      status: "404",
    });
  }
  throw new Error(`Unexpected fake GitHub route: ${request.path}`);
}

interface ServiceHarness {
  readonly service: IcarusService;
  readonly stateRoot: string;
  readonly poisonedCalls: string[];
}

async function serviceFor(
  fixture: LandingGitHubMaterialFixture,
  options: {
    readonly stateRoot?: string;
    readonly store?: IcarusServiceOptions["store"];
    readonly fakeGitHubPreflightSessionFactory?: IcarusServiceOptions["fakeGitHubPreflightSessionFactory"];
  } = {},
): Promise<ServiceHarness> {
  const stateRoot = options.stateRoot ?? path.join(fixture.root, "preflight-service-state");
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const poisonedCalls: string[] = [];
  const unexpected = (name: string): never => {
    poisonedCalls.push(name);
    throw new Error(`Unexpected collaborator call: ${name}`);
  };
  const git = new Proxy(
    {},
    {
      get: (_target, property) => () => unexpected(`git.${String(property)}`),
    },
  ) as GitController;
  const landingGit: LandingGitService = {
    inspectBase: async () => unexpected("landingGit.inspectBase"),
    prepareCandidate: async () => unexpected("landingGit.prepareCandidate"),
    observeLocalRef: async () => unexpected("landingGit.observeLocalRef"),
    createAbsentLocalRef: async () => unexpected("landingGit.createAbsentLocalRef"),
  };
  const checks: CheckRunner = {
    reconcile: async () => unexpected("checks.reconcile"),
    runChecks: async () => unexpected("checks.runChecks"),
  };
  const service = new IcarusService({
    stateRoot,
    store: options.store ?? fixture.store,
    artifacts: new ArtifactStore(stateRoot),
    git,
    landingGit,
    landingCredentialEnvironmentNames: [MATERIAL_PROFILE.credentialRef.name],
    checks,
    gatewayFactory: () => unexpected("gatewayFactory"),
    ...(options.fakeGitHubPreflightSessionFactory === undefined
      ? {}
      : { fakeGitHubPreflightSessionFactory: options.fakeGitHubPreflightSessionFactory }),
    platform: "linux",
  });
  await service.initialize();
  return { service, stateRoot, poisonedCalls };
}

function admittedEvents(fixture: LandingGitHubMaterialFixture) {
  return fixture.store
    .getLandingStatus(fixture.landingId)
    .events.filter((event) => event.type === "landing.github.request.admitted") as readonly {
    readonly payload: LandingGitHubRequestAdmittedEventV1;
  }[];
}

function settledEvents(fixture: LandingGitHubMaterialFixture) {
  return fixture.store
    .getLandingStatus(fixture.landingId)
    .events.filter((event) => event.type === "landing.github.request.settled") as readonly {
    readonly payload: LandingGitHubRequestSettledEventV1;
  }[];
}

function persistedFiles(root: string): readonly string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(root, entry.name);
    return entry.isDirectory() ? persistedFiles(candidate) : [candidate];
  });
}

describe("fake-only GitHub preflight service loop", () => {
  it("keeps the existing local-ready resume exactly inert without the test-only factory", async () => {
    const fixture = await createLandingGitHubMaterialFixture();
    fixtures.push(fixture);
    const before = fixture.store.getLandingStatus(fixture.landingId);
    const harness = await serviceFor(fixture);

    await expect(harness.service.resumeLanding(UNIT_RUN_ID)).resolves.toEqual(before);

    expect(fixture.store.getLandingStatus(fixture.landingId)).toEqual(before);
    expect(harness.poisonedCalls).toEqual([]);
  });

  it("runs the exact admitted actor, base-ref, and absent-head preflight through the real gateway", async () => {
    const fixture = await createLandingGitHubMaterialFixture();
    fixtures.push(fixture);
    const requests: GitHubLandingTransportRequest[] = [];
    const durableOrder: {
      readonly admitted: number;
      readonly settled: number;
      readonly requestId: string;
    }[] = [];
    let credentialReads = 0;
    let factoryCalls = 0;
    const factoryArguments: unknown[][] = [];
    const credentialResolver: GitHubLandingCredentialResolverV1 = {
      resolve: async (reference) => {
        credentialReads += 1;
        expect(reference).toEqual(MATERIAL_PROFILE.credentialRef);
        return FAKE_CREDENTIAL;
      },
    };
    const transport: GitHubLandingTransport = {
      dispatch: async (request) => {
        requests.push(request);
        const admitted = admittedEvents(fixture);
        const settled = settledEvents(fixture);
        const requestId = admitted.at(-1)?.payload.requestId;
        if (requestId === undefined) throw new Error("Dispatch preceded durable admission");
        durableOrder.push({ admitted: admitted.length, settled: settled.length, requestId });
        return successfulResponse(request);
      },
    };
    const closeSpy = vi.spyOn(GitHubLandingGatewayV1.prototype, "closeOperation");
    const harness = await serviceFor(fixture, {
      fakeGitHubPreflightSessionFactory: (...args: unknown[]) => {
        factoryCalls += 1;
        factoryArguments.push(args);
        return { transport, credentialResolver };
      },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch forbidden"));

    const completed = await harness.service.resumeLanding(UNIT_RUN_ID);

    expect(factoryCalls).toBe(1);
    expect(factoryArguments).toEqual([[]]);
    expect(credentialReads).toBe(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(requests.map((request) => request.path)).toEqual([
      "/user",
      `/repos/${MATERIAL_PROFILE.owner}/${MATERIAL_PROFILE.repository}/git/ref/heads/${MATERIAL_PROFILE.baseBranch}`,
      `/repos/${MATERIAL_PROFILE.owner}/${MATERIAL_PROFILE.repository}/git/ref/heads/icarus/${UNIT_RUN_ID}`,
    ]);
    expect(requests.map((request) => request.headers.authorization)).toEqual([
      `Bearer ${FAKE_CREDENTIAL}`,
      `Bearer ${FAKE_CREDENTIAL}`,
      `Bearer ${FAKE_CREDENTIAL}`,
    ]);
    expect(durableOrder.map(({ admitted, settled }) => ({ admitted, settled }))).toEqual([
      { admitted: 1, settled: 0 },
      { admitted: 2, settled: 1 },
      { admitted: 3, settled: 2 },
    ]);
    expect(new Set(durableOrder.map((entry) => entry.requestId))).toHaveProperty("size", 3);
    expect(completed.landing).toMatchObject({ state: "local_ready", errorCode: null });
    expect(completed.attempts.at(-1)?.status).toBe("started");
    expect(completed.operations.at(-1)).toMatchObject({
      kind: "github.preflight",
      status: "completed",
      result: { outcome: "completed", boundary: "preflight_exact" },
    });
    expect(completed.events.slice(-2).map((event) => event.type)).toEqual([
      "landing.github.request.settled",
      "landing.operation.settled",
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(harness.poisonedCalls).toEqual([]);
  });

  it.each([
    {
      name: "permission loss",
      outcome: jsonResponse(403, { message: "forbidden" }),
      operationStatus: "failed",
      attemptStatus: "failed",
      landingState: "failed",
      errorCode: "GITHUB_PERMISSION_DENIED",
      suffix: [
        "landing.github.request.settled",
        "landing.operation.settled",
        "landing.attempt.settled",
        "landing.state.changed",
      ],
    },
    {
      name: "rate limiting",
      outcome: jsonResponse(429, { message: "rate limited" }),
      operationStatus: "failed",
      attemptStatus: "failed",
      landingState: "failed",
      errorCode: "GITHUB_RATE_LIMITED",
      suffix: [
        "landing.github.request.settled",
        "landing.operation.settled",
        "landing.attempt.settled",
        "landing.state.changed",
      ],
    },
    {
      name: "timeout before dispatch",
      outcome: { kind: "failure", phase: "before_dispatch", reason: "timeout" } as const,
      operationStatus: "failed",
      attemptStatus: "failed",
      landingState: "failed",
      errorCode: "GITHUB_REQUEST_TIMEOUT",
      suffix: [
        "landing.github.request.settled",
        "landing.operation.settled",
        "landing.attempt.settled",
        "landing.state.changed",
      ],
    },
    {
      name: "timeout after dispatch",
      outcome: { kind: "failure", phase: "after_dispatch", reason: "timeout" } as const,
      operationStatus: "interrupted",
      attemptStatus: "interrupted",
      landingState: "local_ready",
      errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
      suffix: [
        "landing.github.request.settled",
        "landing.operation.settled",
        "landing.attempt.settled",
      ],
    },
  ])("durably stops after one $name result with only its terminal suffix", async (entry) => {
    const fixture = await createLandingGitHubMaterialFixture();
    fixtures.push(fixture);
    const dispatch = vi.fn(async () => entry.outcome);
    const resolve = vi.fn(async () => FAKE_CREDENTIAL);
    const harness = await serviceFor(fixture, {
      fakeGitHubPreflightSessionFactory: () => ({
        transport: { dispatch },
        credentialResolver: { resolve },
      }),
    });

    const terminal = await harness.service.resumeLanding(UNIT_RUN_ID);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(admittedEvents(fixture)).toHaveLength(1);
    expect(settledEvents(fixture)).toHaveLength(1);
    expect(terminal.landing).toMatchObject({
      state: entry.landingState,
      resumeState: entry.landingState === "failed" ? "local_ready" : null,
      errorCode: entry.landingState === "failed" ? entry.errorCode : null,
    });
    expect(terminal.attempts.at(-1)?.status).toBe(entry.attemptStatus);
    expect(terminal.operations.at(-1)).toMatchObject({
      kind: "github.preflight",
      status: entry.operationStatus,
      errorCode: entry.errorCode,
    });
    expect(terminal.events.slice(-entry.suffix.length).map((event) => event.type)).toEqual(
      entry.suffix,
    );
    expect(harness.poisonedCalls).toEqual([]);
  });

  it.each(["factory", "claim", "credential", "material"] as const)(
    "leaves a claimed-or-admitted tail after a %s error and recovers only through fresh takeover IDs",
    async (failurePoint) => {
      const fixture = await createLandingGitHubMaterialFixture();
      fixtures.push(fixture);
      let firstDispatches = 0;
      let firstCredentialReads = 0;
      const firstFactory = () => {
        if (failurePoint === "factory") throw new Error("fake session factory failed");
        return {
          transport: {
            dispatch: async (request: GitHubLandingTransportRequest) => {
              firstDispatches += 1;
              return successfulResponse(request);
            },
          },
          credentialResolver: {
            resolve: async () => {
              firstCredentialReads += 1;
              if (failurePoint === "credential") throw new Error(FAKE_CREDENTIAL);
              return FAKE_CREDENTIAL;
            },
          },
        };
      };
      const firstStore =
        failurePoint === "material" || failurePoint === "claim"
          ? new Proxy(fixture.store, {
              get(target, property) {
                if (
                  failurePoint === "claim" &&
                  property === "claimAdmittedGitHubPreflightRequestWithMaterial"
                ) {
                  return async () => {
                    throw new Error("claim failed");
                  };
                }
                if (property === "readClaimedGitHubLandingMaterial") {
                  return async () => {
                    throw new Error("material failed");
                  };
                }
                const value = Reflect.get(target, property, target) as unknown;
                return typeof value === "function" ? value.bind(target) : value;
              },
            })
          : fixture.store;
      const first = await serviceFor(fixture, {
        store: firstStore,
        fakeGitHubPreflightSessionFactory: firstFactory,
      });

      await expect(first.service.resumeLanding(UNIT_RUN_ID)).rejects.toMatchObject(
        failurePoint === "factory"
          ? { message: "fake session factory failed" }
          : {
              code:
                failurePoint === "claim"
                  ? "GITHUB_ADMITTED_REQUEST_UNAVAILABLE"
                  : failurePoint === "credential"
                    ? "GITHUB_CREDENTIAL_UNAVAILABLE"
                    : "GITHUB_GATEWAY_MATERIAL_UNAVAILABLE",
            },
      );

      expect(firstDispatches).toBe(0);
      expect(firstCredentialReads).toBe(failurePoint === "credential" ? 1 : 0);
      const stranded = fixture.store.getLandingStatus(fixture.landingId);
      const oldAdmission = admittedEvents(fixture).at(-1)?.payload;
      if (oldAdmission === undefined) throw new Error("Expected a stranded admitted request");
      expect(stranded.landing.state).toBe("local_ready");
      expect(stranded.attempts.at(-1)?.status).toBe("started");
      expect(stranded.operations.at(-1)).toMatchObject({
        id: oldAdmission.operationId,
        kind: "github.preflight",
        status: "started",
      });
      expect(stranded.events.at(-1)?.type).toBe("landing.github.request.admitted");
      expect(settledEvents(fixture)).toHaveLength(0);

      const recoveryDispatchIds: string[] = [];
      const recovery = await serviceFor(fixture, {
        stateRoot: first.stateRoot,
        fakeGitHubPreflightSessionFactory: () => ({
          credentialResolver: { resolve: async () => FAKE_CREDENTIAL },
          transport: {
            dispatch: async (request) => {
              const requestId = admittedEvents(fixture).at(-1)?.payload.requestId;
              if (requestId === undefined) throw new Error("Recovery dispatch lacked admission");
              recoveryDispatchIds.push(requestId);
              return successfulResponse(request);
            },
          },
        }),
      });

      const recovered = await recovery.service.resumeLanding(UNIT_RUN_ID);

      expect(recoveryDispatchIds).toHaveLength(3);
      expect(recoveryDispatchIds).not.toContain(oldAdmission.requestId);
      expect(new Set(recoveryDispatchIds)).toHaveProperty("size", 3);
      expect(
        recovered.operations.find((operation) => operation.id === oldAdmission.operationId),
      ).toMatchObject({
        status: "interrupted",
        errorCode: "LANDING_COORDINATOR_TAKEOVER",
      });
      expect(recovered.operations.at(-1)).toMatchObject({
        kind: "github.preflight",
        status: "completed",
        result: { outcome: "completed", boundary: "preflight_exact" },
      });
      expect(recovered.landing.state).toBe("local_ready");
      expect(first.poisonedCalls).toEqual([]);
      expect(recovery.poisonedCalls).toEqual([]);
    },
  );

  it("rolls back a trigger-aborted actor settlement, admits no base request, and takes over without redispatch", async () => {
    const fixture = await createLandingGitHubMaterialFixture();
    fixtures.push(fixture);
    const database = new Database(fixture.databasePath);
    database
      .prepare(
        "CREATE TRIGGER corrupt_preflight_service_settlement AFTER UPDATE OF status " +
          "ON landing_http_requests WHEN NEW.status = 'settled' BEGIN " +
          "INSERT INTO landing_events (landing_id, sequence, type, payload_json, created_at) " +
          "VALUES (NEW.landing_id, " +
          "(SELECT COALESCE(MAX(sequence), 0) + 1 FROM landing_events WHERE landing_id = NEW.landing_id), " +
          "'landing.github.request.settled', '{}', '2026-08-08T12:00:00.000Z'); END",
      )
      .run();
    database.close();
    const firstDispatch = vi.fn(async (request: GitHubLandingTransportRequest) =>
      successfulResponse(request),
    );
    const first = await serviceFor(fixture, {
      fakeGitHubPreflightSessionFactory: () => ({
        credentialResolver: { resolve: async () => FAKE_CREDENTIAL },
        transport: { dispatch: firstDispatch },
      }),
    });

    await expect(first.service.resumeLanding(UNIT_RUN_ID)).rejects.toMatchObject({
      code: "LANDING_RECORD_INVALID",
    });

    expect(firstDispatch).toHaveBeenCalledTimes(1);
    expect(firstDispatch.mock.calls[0]?.[0].path).toBe("/user");
    const oldAdmission = admittedEvents(fixture).at(-1)?.payload;
    if (oldAdmission === undefined) throw new Error("Expected rolled-back actor admission");
    expect(admittedEvents(fixture)).toHaveLength(1);
    expect(settledEvents(fixture)).toHaveLength(0);
    expect(fixture.store.getLandingStatus(fixture.landingId).events.at(-1)?.type).toBe(
      "landing.github.request.admitted",
    );

    const recoveryDatabase = new Database(fixture.databasePath);
    recoveryDatabase.prepare("DROP TRIGGER corrupt_preflight_service_settlement").run();
    recoveryDatabase.close();
    const recoveryDispatchIds: string[] = [];
    const recovery = await serviceFor(fixture, {
      stateRoot: first.stateRoot,
      fakeGitHubPreflightSessionFactory: () => ({
        credentialResolver: { resolve: async () => FAKE_CREDENTIAL },
        transport: {
          dispatch: async (request) => {
            const requestId = admittedEvents(fixture).at(-1)?.payload.requestId;
            if (requestId === undefined) throw new Error("Recovery dispatch lacked admission");
            recoveryDispatchIds.push(requestId);
            return successfulResponse(request);
          },
        },
      }),
    });

    const completed = await recovery.service.resumeLanding(UNIT_RUN_ID);

    expect(recoveryDispatchIds).toHaveLength(3);
    expect(recoveryDispatchIds).not.toContain(oldAdmission.requestId);
    expect(completed.operations.at(-1)).toMatchObject({
      kind: "github.preflight",
      status: "completed",
    });
    expect(first.poisonedCalls).toEqual([]);
    expect(recovery.poisonedCalls).toEqual([]);
  });

  it("fences concurrent services sharing one state root while the fake transport is blocked", async () => {
    const fixture = await createLandingGitHubMaterialFixture();
    fixtures.push(fixture);
    const stateRoot = path.join(fixture.root, "shared-preflight-service-state");
    let enterDispatch: (() => void) | undefined;
    let releaseDispatch: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enterDispatch = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    let dispatchCount = 0;
    const first = await serviceFor(fixture, {
      stateRoot,
      fakeGitHubPreflightSessionFactory: () => ({
        credentialResolver: { resolve: async () => FAKE_CREDENTIAL },
        transport: {
          dispatch: async (request) => {
            dispatchCount += 1;
            if (dispatchCount === 1) {
              enterDispatch?.();
              await released;
            }
            return successfulResponse(request);
          },
        },
      }),
    });
    const secondFactory = vi.fn(() => ({
      credentialResolver: { resolve: async () => FAKE_CREDENTIAL },
      transport: {
        dispatch: async (request: GitHubLandingTransportRequest) => successfulResponse(request),
      },
    }));
    const second = await serviceFor(fixture, {
      stateRoot,
      fakeGitHubPreflightSessionFactory: secondFactory,
    });

    const active = first.service.resumeLanding(UNIT_RUN_ID);
    await entered;
    await expect(second.service.resumeLanding(UNIT_RUN_ID)).rejects.toMatchObject({
      code: "RUN_BUSY",
    });
    expect(secondFactory).not.toHaveBeenCalled();
    releaseDispatch?.();

    await expect(active).resolves.toMatchObject({ landing: { state: "local_ready" } });
    expect(dispatchCount).toBe(3);
    expect(first.poisonedCalls).toEqual([]);
    expect(second.poisonedCalls).toEqual([]);
  });

  it("keeps injected credentials and ambient environment sentinels out of durable state", async () => {
    const fixture = await createLandingGitHubMaterialFixture();
    fixtures.push(fixture);
    const credentialName = MATERIAL_PROFILE.credentialRef.name;
    const previous = process.env[credentialName];
    process.env[credentialName] = ENVIRONMENT_SENTINEL;
    try {
      const harness = await serviceFor(fixture, {
        fakeGitHubPreflightSessionFactory: () => ({
          credentialResolver: { resolve: async () => FAKE_CREDENTIAL },
          transport: { dispatch: async (request) => successfulResponse(request) },
        }),
      });

      const completed = await harness.service.resumeLanding(UNIT_RUN_ID);

      expect(process.env[credentialName]).toBe(ENVIRONMENT_SENTINEL);
      expect(JSON.stringify(completed)).not.toContain(FAKE_CREDENTIAL);
      expect(JSON.stringify(completed)).not.toContain(ENVIRONMENT_SENTINEL);
      for (const file of persistedFiles(fixture.root)) {
        const contents = readFileSync(file);
        expect(contents.includes(Buffer.from(FAKE_CREDENTIAL)), file).toBe(false);
        expect(contents.includes(Buffer.from(ENVIRONMENT_SENTINEL)), file).toBe(false);
      }
      expect(harness.poisonedCalls).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env[credentialName];
      else process.env[credentialName] = previous;
    }
  });
});
