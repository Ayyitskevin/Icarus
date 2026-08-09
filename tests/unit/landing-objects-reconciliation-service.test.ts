import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactStore } from "../../packages/core/src/artifacts.js";
import type { GitController } from "../../packages/core/src/git.js";
import type {
  GitHubLandingCredentialResolverV1,
  GitHubLandingTransport,
} from "../../packages/core/src/github-landing-gateway.js";
import type { CheckRunner } from "../../packages/core/src/sandbox.js";
import { IcarusService, type LandingGitService } from "../../packages/core/src/service.js";
import { IcarusStore } from "../../packages/core/src/store.js";
import { MATERIAL_PROFILE } from "../support/landing-github-material-fixture.js";
import { UNIT_RUN_ID } from "../support/unit-fixtures.js";
import {
  createCompletedObjectScenario,
  createUnresolvedObjectScenario,
  type ObjectReconciliationScenario,
  ReconciliationDatabase,
} from "./landing-objects-reconciliation-support.js";

interface RemoteEvidenceSnapshot {
  readonly requests: number;
  readonly admittedEvents: number;
  readonly settledEvents: number;
}

interface ServiceHarness {
  readonly service: IcarusService;
  readonly poisonedCalls: string[];
}

const scenarios: ObjectReconciliationScenario[] = [];
const stores: IcarusStore[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // Restart tests may close an earlier process handle explicitly.
    }
  }
  for (const scenario of scenarios.splice(0)) {
    try {
      scenario.fixture.store.close();
    } catch {
      // Restart tests replace the fixture's original process handle.
    }
    rmSync(scenario.fixture.root, { recursive: true, force: true });
  }
});

function track<T extends ObjectReconciliationScenario>(scenario: T): T {
  scenarios.push(scenario);
  return scenario;
}

function openStore(scenario: ObjectReconciliationScenario): IcarusStore {
  const store = new IcarusStore(scenario.fixture.databasePath);
  stores.push(store);
  return store;
}

function remoteEvidence(scenario: ObjectReconciliationScenario): RemoteEvidenceSnapshot {
  const database = new ReconciliationDatabase(scenario.fixture.databasePath);
  try {
    const requests = database
      .prepare("SELECT COUNT(*) AS count FROM landing_http_requests WHERE landing_id = ?")
      .get(scenario.fixture.landingId) as { readonly count: number };
    const events = database
      .prepare(
        "SELECT " +
          "SUM(CASE WHEN type = 'landing.github.request.admitted' THEN 1 ELSE 0 END) AS admitted, " +
          "SUM(CASE WHEN type = 'landing.github.request.settled' THEN 1 ELSE 0 END) AS settled " +
          "FROM landing_events WHERE landing_id = ?",
      )
      .get(scenario.fixture.landingId) as {
      readonly admitted: number;
      readonly settled: number;
    };
    return {
      requests: requests.count,
      admittedEvents: events.admitted,
      settledEvents: events.settled,
    };
  } finally {
    database.close();
  }
}

function reconciliationHttpRows(
  scenario: ObjectReconciliationScenario,
  operationId: string,
): number {
  const database = new ReconciliationDatabase(scenario.fixture.databasePath);
  try {
    const row = database
      .prepare(
        "SELECT COUNT(*) AS count FROM landing_http_requests " +
          "WHERE landing_id = ? AND operation_id = ?",
      )
      .get(scenario.fixture.landingId, operationId) as { readonly count: number };
    return row.count;
  } finally {
    database.close();
  }
}

async function serviceFor(
  scenario: ObjectReconciliationScenario,
  store: IcarusStore,
  stateRoot = path.join(scenario.fixture.root, "object-reconciliation-service-state"),
): Promise<ServiceHarness> {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const poisonedCalls: string[] = [];
  const unexpected = (name: string): never => {
    poisonedCalls.push(name);
    throw new Error(`Unexpected external collaborator call: ${name}`);
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
  const credentialResolver: GitHubLandingCredentialResolverV1 = {
    resolve: async () => unexpected("credentialResolver.resolve"),
  };
  const transport: GitHubLandingTransport = {
    dispatch: async () => unexpected("transport.dispatch"),
  };
  const service = new IcarusService({
    stateRoot,
    store,
    artifacts: new ArtifactStore(stateRoot),
    git,
    landingGit,
    landingCredentialEnvironmentNames: [MATERIAL_PROFILE.credentialRef.name],
    checks,
    gatewayFactory: () => unexpected("gatewayFactory"),
    fakeGitHubPreflightSessionFactory: () => {
      poisonedCalls.push("fakeGitHubPreflightSessionFactory");
      return { credentialResolver, transport };
    },
    platform: "linux",
  });
  await service.initialize();
  return { service, poisonedCalls };
}

describe("zero-HTTP GitHub object reconciliation service dispatch", () => {
  it("reopens the durable boundary and settles only its exact object subject", async () => {
    const scenario = track(await createUnresolvedObjectScenario(true));
    const before = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    const remoteBefore = remoteEvidence(scenario);
    scenario.fixture.store.close();
    const reopened = openStore(scenario);
    const harness = await serviceFor(scenario, reopened);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Global fetch is forbidden during reconciliation"));

    const settled = await harness.service.resumeLanding(UNIT_RUN_ID);

    expect(settled.landing).toMatchObject({
      state: "local_ready",
      resumeState: null,
      errorCode: null,
      version: before.landing.version + 1,
    });
    expect(settled.attempts.at(-1)).toMatchObject({ ordinal: 4, status: "completed" });
    const reconciliation = settled.operations.at(-1);
    expect(reconciliation).toMatchObject({
      kind: "landing.reconcile",
      status: "completed",
      request: {
        expectedState: "reconciliation_required",
        input: {
          subjectOperationId: scenario.operation.operationId,
          resumeState: "local_ready",
        },
      },
      result: {
        outcome: "completed",
        boundary: "retry_stage_proven",
        value: {
          subjectOperationId: scenario.operation.operationId,
          nextState: "local_ready",
          remoteResidue: "none",
          stageValue: null,
        },
      },
    });
    expect(settled.events.slice(before.events.length).map((event) => event.type)).toEqual([
      "landing.attempt.started",
      "landing.operation.started",
      "landing.operation.settled",
      "landing.attempt.settled",
      "landing.state.changed",
    ]);
    expect(remoteEvidence(scenario)).toEqual(remoteBefore);
    expect(reconciliationHttpRows(scenario, reconciliation?.id ?? "")).toBe(0);
    expect(harness.poisonedCalls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();

    reopened.close();
    const verifiedAfterRestart = openStore(scenario);
    expect(verifiedAfterRestart.getLandingStatus(scenario.fixture.landingId)).toEqual(settled);
  });

  it("keeps objects-ready inert after preserving a completed object operation", async () => {
    const scenario = track(await createCompletedObjectScenario());
    const before = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    const completedObject = before.operations.at(-1);
    const remoteBefore = remoteEvidence(scenario);
    const harness = await serviceFor(scenario, scenario.fixture.store);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Global fetch is forbidden during objects-ready recovery"));

    const recovered = await harness.service.resumeLanding(UNIT_RUN_ID);

    expect(recovered.landing).toMatchObject({
      state: before.landing.state,
      version: before.landing.version,
      attemptCount: before.landing.attemptCount + 1,
    });
    expect(recovered.operations.at(-1)).toEqual(completedObject);
    expect(recovered.attempts.slice(-2)).toMatchObject([
      { ordinal: 3, status: "interrupted", errorCode: "LANDING_COORDINATOR_TAKEOVER" },
      { ordinal: 4, status: "started", errorCode: null },
    ]);
    expect(recovered.events.slice(-2).map((event) => event.type)).toEqual([
      "landing.attempt.settled",
      "landing.attempt.started",
    ]);
    await expect(harness.service.resumeLanding(UNIT_RUN_ID)).resolves.toEqual(recovered);
    expect(remoteEvidence(scenario)).toEqual(remoteBefore);
    expect(harness.poisonedCalls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed on settlement rollback and resumes after a process restart without external fallback", async () => {
    const scenario = track(await createUnresolvedObjectScenario());
    const remoteBefore = remoteEvidence(scenario);
    const stateRoot = path.join(scenario.fixture.root, "object-reconciliation-restart-state");
    const firstHarness = await serviceFor(scenario, scenario.fixture.store, stateRoot);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Global fetch is forbidden during rollback recovery"));
    const database = new ReconciliationDatabase(scenario.fixture.databasePath);
    try {
      database
        .prepare(
          "CREATE TRIGGER object_reconciliation_service_fault " +
            "BEFORE UPDATE OF state ON landings " +
            `WHEN OLD.id = '${scenario.fixture.landingId}' AND NEW.state = 'local_ready' ` +
            "BEGIN SELECT RAISE(ABORT, 'injected service reconciliation fault'); END",
        )
        .run();
    } finally {
      database.close();
    }

    await expect(firstHarness.service.resumeLanding(UNIT_RUN_ID)).rejects.toThrow(
      "injected service reconciliation fault",
    );
    const afterFailure = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    expect(afterFailure.landing.state).toBe("reconciliation_required");
    expect(afterFailure.attempts.at(-1)).toMatchObject({ ordinal: 4, status: "started" });
    expect(afterFailure.operations.at(-1)).toMatchObject({
      kind: "landing.reconcile",
      status: "started",
      observation: null,
      result: null,
    });
    expect(remoteEvidence(scenario)).toEqual(remoteBefore);
    expect(firstHarness.poisonedCalls).toEqual([]);

    const cleanup = new ReconciliationDatabase(scenario.fixture.databasePath);
    try {
      cleanup.prepare("DROP TRIGGER object_reconciliation_service_fault").run();
    } finally {
      cleanup.close();
    }
    scenario.fixture.store.close();
    const reopened = openStore(scenario);
    const restartedHarness = await serviceFor(scenario, reopened, stateRoot);

    const recovered = await restartedHarness.service.resumeLanding(UNIT_RUN_ID);

    expect(recovered.landing).toMatchObject({ state: "local_ready", errorCode: null });
    expect(recovered.attempts.at(-1)).toMatchObject({ ordinal: 5, status: "completed" });
    expect(recovered.operations.slice(-2)).toMatchObject([
      {
        kind: "landing.reconcile",
        status: "interrupted",
        result: { outcome: "reconciliation_required" },
      },
      {
        kind: "landing.reconcile",
        status: "completed",
        result: { outcome: "completed", boundary: "retry_stage_proven" },
      },
    ]);
    expect(remoteEvidence(scenario)).toEqual(remoteBefore);
    expect(restartedHarness.poisonedCalls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
