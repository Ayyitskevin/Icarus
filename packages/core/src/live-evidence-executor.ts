import { randomUUID } from "node:crypto";

import { parseStrictJson } from "./canonical-json.js";
import { sha256 } from "./digest.js";
import { IcarusError, invariant } from "./errors.js";
import type {
  LiveEvidenceCasePinV1,
  LiveEvidenceEffect,
  LiveEvidenceProfileV1,
} from "./live-evidence-profile.js";
import {
  assertLiveEvidenceProfileApproved,
  assertLiveEvidenceProfileMatchesManifest,
} from "./live-evidence-profile.js";
import { authorizeLiveEvidenceRun, LiveEvidenceEffectLedger } from "./live-evidence-run.js";
import type { JsonValue } from "./types.js";

const RESUME_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,127}$/;

export interface LiveEvidenceTerminalReceiptV1 {
  readonly schemaVersion: 1;
  readonly type: "live_evidence_terminal";
  readonly outcome: "succeeded" | "blocked" | "interrupted" | "failed";
  readonly resumeId: string;
  readonly profileId: string;
  readonly profileDigestSha256: string;
  readonly manifestSha256: string;
  readonly caseId: string | null;
  readonly stage: string;
  readonly code: string | null;
  readonly completedCaseIds: readonly string[];
  readonly completedAt: string;
}

export interface LiveEvidenceCaseCompletionV1 {
  readonly caseId: string;
  readonly effects: readonly LiveEvidenceEffect[];
  readonly spendUsd: number;
  readonly elapsedSeconds: number;
  readonly receipt: JsonValue;
}

export interface LiveEvidenceExecutionJournalV1 {
  readonly schemaVersion: 1;
  readonly resumeId: string;
  readonly profileId: string;
  readonly profileDigestSha256: string;
  readonly manifestSha256: string;
  readonly caseOrder: readonly string[];
  readonly completedCases: readonly LiveEvidenceCaseCompletionV1[];
  readonly terminalReceipts: readonly LiveEvidenceTerminalReceiptV1[];
  readonly terminalReceipt: LiveEvidenceTerminalReceiptV1 | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LiveEvidenceJournalStore {
  load(resumeId: string): LiveEvidenceExecutionJournalV1 | null;
  create(journal: LiveEvidenceExecutionJournalV1): void;
  save(journal: LiveEvidenceExecutionJournalV1): void;
}

export interface LiveEvidenceCaseContext {
  readonly resumeId: string;
  readonly mode: "start" | "resume";
  readonly caseId: string;
  readonly caseIndex: number;
  readonly profile: LiveEvidenceProfileV1;
  readonly casePin: LiveEvidenceCasePinV1;
  readonly manifestBytes: Uint8Array;
  readonly signal?: AbortSignal;
}

export interface LiveEvidenceCaseObservation {
  readonly caseId: string;
  readonly durableStage: string;
  readonly outcome: "ready" | "complete" | "blocked";
  readonly effects: readonly LiveEvidenceEffect[];
  readonly nextEffects: readonly LiveEvidenceEffect[];
  readonly spendUsd: number;
  readonly elapsedSeconds: number;
  readonly receipt: JsonValue | null;
  readonly errorCode: string | null;
}

export interface LiveEvidenceCaseDriver {
  observe(context: LiveEvidenceCaseContext): Promise<LiveEvidenceCaseObservation>;
  advance(
    context: LiveEvidenceCaseContext,
    observation: LiveEvidenceCaseObservation,
  ): Promise<void>;
}

export type LiveEvidenceExecutionEventV1 =
  | {
      readonly schemaVersion: 1;
      readonly type: "live_evidence_case_observation";
      readonly resumeId: string;
      readonly caseId: string;
      readonly caseIndex: number;
      readonly stage: string;
      readonly outcome: LiveEvidenceCaseObservation["outcome"];
      readonly observedAt: string;
    }
  | LiveEvidenceTerminalReceiptV1;

export interface RunLiveEvidenceExecutorOptions {
  readonly mode: "start" | "resume";
  readonly resumeId?: string;
  readonly profile: LiveEvidenceProfileV1;
  readonly manifestBytes: Uint8Array;
  readonly environment: NodeJS.ProcessEnv;
  readonly journalStore: LiveEvidenceJournalStore;
  readonly driver: LiveEvidenceCaseDriver;
  readonly eventSink: (event: LiveEvidenceExecutionEventV1) => void;
  readonly createResumeId?: () => string;
  readonly now?: () => string;
  readonly signal?: AbortSignal;
}

function refuse(message: string): never {
  throw new IcarusError("LIVE_EVIDENCE_REFUSED", message);
}

function caseOrder(bytes: Uint8Array): readonly string[] {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    refuse("live-evidence manifest is not valid UTF-8");
  }
  const parsed = parseStrictJson(source);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    refuse("live-evidence manifest is not an object");
  }
  const cases = (parsed as { readonly cases?: unknown }).cases;
  if (!Array.isArray(cases) || cases.length === 0) refuse("live-evidence manifest has no cases");
  return cases.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      refuse(`live-evidence manifest case ${index} is invalid`);
    }
    const id = (entry as { readonly id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0) refuse(`manifest case ${index} has no id`);
    return id;
  });
}

function assertObservation(value: LiveEvidenceCaseObservation, id: string): void {
  invariant(
    value.caseId === id && value.durableStage.length > 0 && value.durableStage.length <= 256,
    "LIVE_EVIDENCE_REFUSED",
    "Live-evidence driver returned an invalid observation",
  );
  invariant(
    Number.isFinite(value.spendUsd) &&
      value.spendUsd >= 0 &&
      Number.isFinite(value.elapsedSeconds) &&
      value.elapsedSeconds >= 0,
    "LIVE_EVIDENCE_REFUSED",
    "Live-evidence driver returned invalid accounting",
  );
  invariant(
    value.errorCode === null || SAFE_CODE.test(value.errorCode),
    "LIVE_EVIDENCE_REFUSED",
    "Live-evidence driver returned an unsafe error code",
  );
  invariant(
    value.outcome === "ready" || value.nextEffects.length === 0,
    "LIVE_EVIDENCE_REFUSED",
    "Live-evidence driver returned an invalid next-effect set",
  );
  invariant(
    value.outcome !== "complete" || value.receipt !== null,
    "LIVE_EVIDENCE_REFUSED",
    "Complete live-evidence case has no receipt",
  );
}

function replay(
  options: RunLiveEvidenceExecutorOptions,
  completed: readonly LiveEvidenceCaseCompletionV1[],
  observed?: LiveEvidenceCaseObservation,
): LiveEvidenceEffectLedger {
  const ledger = new LiveEvidenceEffectLedger(
    authorizeLiveEvidenceRun(options.profile, options.manifestBytes, options.environment),
  );
  for (const entry of completed) {
    for (const effect of entry.effects) ledger.recordEffect(entry.caseId, effect);
    ledger.recordSpend(entry.spendUsd);
    ledger.recordElapsed(entry.elapsedSeconds);
  }
  if (observed !== undefined) {
    for (const effect of observed.effects) ledger.recordEffect(observed.caseId, effect);
    ledger.recordSpend(observed.spendUsd);
    ledger.recordElapsed(observed.elapsedSeconds);
  }
  return ledger;
}

function replayPersistedSuccess(
  options: RunLiveEvidenceExecutorOptions,
  completed: readonly LiveEvidenceCaseCompletionV1[],
): LiveEvidenceEffectLedger {
  // This path can only verify a terminal receipt; it cannot advance the driver.
  // Revalidate every durable authority bound, but do not require credentials
  // that no effect will consume merely to read an already-successful result.
  assertLiveEvidenceProfileApproved(options.profile);
  assertLiveEvidenceProfileMatchesManifest(options.profile, options.manifestBytes);
  const ledger = new LiveEvidenceEffectLedger({
    profileId: options.profile.profileId,
    caseIds: options.profile.cases.map((entry) => entry.caseId),
    effects: [...options.profile.authorizedEffects],
    budgets: {
      maxSpendUsd: options.profile.budgets.maxSpendUsd,
      maxRuntimeSeconds: options.profile.budgets.maxRuntimeSeconds,
    },
    credentialEnvironmentNames: [],
  });
  for (const entry of completed) {
    for (const effect of entry.effects) ledger.recordEffect(entry.caseId, effect);
    ledger.recordSpend(entry.spendUsd);
    ledger.recordElapsed(entry.elapsedSeconds);
  }
  return ledger;
}

function receipt(
  journal: LiveEvidenceExecutionJournalV1,
  profile: LiveEvidenceProfileV1,
  outcome: LiveEvidenceTerminalReceiptV1["outcome"],
  at: string,
  detail: { readonly caseId: string | null; readonly stage: string; readonly code: string | null },
): LiveEvidenceTerminalReceiptV1 {
  return {
    schemaVersion: 1,
    type: "live_evidence_terminal",
    outcome,
    resumeId: journal.resumeId,
    profileId: profile.profileId,
    profileDigestSha256: profile.approval.profileDigestSha256,
    manifestSha256: journal.manifestSha256,
    ...detail,
    completedCaseIds: journal.completedCases.map((entry) => entry.caseId),
    completedAt: at,
  };
}

function saveReceipt(
  store: LiveEvidenceJournalStore,
  journal: LiveEvidenceExecutionJournalV1,
  terminal: LiveEvidenceTerminalReceiptV1,
): LiveEvidenceExecutionJournalV1 {
  const next = {
    ...journal,
    terminalReceipts: [...journal.terminalReceipts, terminal],
    terminalReceipt: terminal,
    updatedAt: terminal.completedAt,
  };
  store.save(next);
  return next;
}

export async function runLiveEvidenceExecutor(
  options: RunLiveEvidenceExecutorOptions,
): Promise<LiveEvidenceTerminalReceiptV1> {
  const now = options.now ?? (() => new Date().toISOString());
  const order = caseOrder(options.manifestBytes);
  const manifestSha256 = sha256(options.manifestBytes);
  const resumeId =
    options.mode === "start" ? (options.createResumeId ?? randomUUID)() : options.resumeId;
  if (resumeId === undefined || !RESUME_ID.test(resumeId)) refuse("invalid resume id");

  let journal: LiveEvidenceExecutionJournalV1;
  if (options.mode === "start") {
    invariant(
      options.resumeId === undefined,
      "LIVE_EVIDENCE_REFUSED",
      "start cannot select resume id",
    );
    const createdAt = now();
    journal = {
      schemaVersion: 1,
      resumeId,
      profileId: options.profile.profileId,
      profileDigestSha256: options.profile.approval.profileDigestSha256,
      manifestSha256,
      caseOrder: order,
      completedCases: [],
      terminalReceipts: [],
      terminalReceipt: null,
      createdAt,
      updatedAt: createdAt,
    };
    options.journalStore.create(journal);
  } else {
    const loaded = options.journalStore.load(resumeId);
    invariant(loaded !== null, "LIVE_EVIDENCE_RESUME_NOT_FOUND", "Resume id was not found");
    journal = loaded;
  }
  invariant(
    journal.profileId === options.profile.profileId &&
      journal.resumeId === resumeId &&
      journal.profileDigestSha256 === options.profile.approval.profileDigestSha256 &&
      journal.manifestSha256 === manifestSha256 &&
      JSON.stringify(journal.caseOrder) === JSON.stringify(order) &&
      journal.completedCases.every((entry, index) => entry.caseId === order[index]),
    "LIVE_EVIDENCE_RESUME_MISMATCH",
    "Resume state does not bind the supplied authority",
  );
  if (journal.terminalReceipt?.outcome === "succeeded") {
    invariant(
      journal.terminalReceipt.resumeId === resumeId &&
        journal.terminalReceipt.profileId === options.profile.profileId &&
        journal.terminalReceipt.profileDigestSha256 ===
          options.profile.approval.profileDigestSha256 &&
        journal.terminalReceipt.manifestSha256 === manifestSha256 &&
        JSON.stringify(journal.terminalReceipt.completedCaseIds) === JSON.stringify(order),
      "LIVE_EVIDENCE_RESUME_MISMATCH",
      "Successful terminal receipt does not bind the supplied authority",
    );
    replayPersistedSuccess(options, journal.completedCases).assertComplete();
    options.eventSink(journal.terminalReceipt);
    return journal.terminalReceipt;
  }
  try {
    authorizeLiveEvidenceRun(options.profile, options.manifestBytes, options.environment);
  } catch (error) {
    const terminal = receipt(journal, options.profile, "blocked", now(), {
      caseId: null,
      stage: "authority.preflight",
      code:
        error instanceof IcarusError && SAFE_CODE.test(error.code)
          ? error.code
          : "LIVE_EVIDENCE_REFUSED",
    });
    journal = saveReceipt(options.journalStore, journal, terminal);
    options.eventSink(terminal);
    return terminal;
  }

  const pins = new Map(options.profile.cases.map((entry) => [entry.caseId, entry]));
  let transitions = 0;
  while (journal.completedCases.length < order.length) {
    const caseIndex = journal.completedCases.length;
    const caseId = order[caseIndex];
    invariant(caseId !== undefined, "LIVE_EVIDENCE_REFUSED", "Invalid case order");
    if (options.signal?.aborted === true) {
      const terminal = receipt(journal, options.profile, "interrupted", now(), {
        caseId,
        stage: "signal",
        code: "LIVE_EVIDENCE_INTERRUPTED",
      });
      journal = saveReceipt(options.journalStore, journal, terminal);
      options.eventSink(terminal);
      return terminal;
    }
    transitions += 1;
    invariant(transitions <= 1_024, "LIVE_EVIDENCE_REFUSED", "Transition ceiling exceeded");
    const casePin = pins.get(caseId);
    invariant(casePin !== undefined, "LIVE_EVIDENCE_REFUSED", "Profile case is absent");
    const context: LiveEvidenceCaseContext = {
      resumeId,
      mode: options.mode,
      caseId,
      caseIndex,
      profile: options.profile,
      casePin,
      manifestBytes: options.manifestBytes,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    const observed = await options.driver.observe(context);
    assertObservation(observed, caseId);
    options.eventSink({
      schemaVersion: 1,
      type: "live_evidence_case_observation",
      resumeId,
      caseId,
      caseIndex,
      stage: observed.durableStage,
      outcome: observed.outcome,
      observedAt: now(),
    });
    const ledger = replay(options, journal.completedCases, observed);
    if (observed.outcome === "blocked") {
      const terminal = receipt(journal, options.profile, "blocked", now(), {
        caseId,
        stage: observed.durableStage,
        code: observed.errorCode ?? "LIVE_EVIDENCE_BLOCKED",
      });
      journal = saveReceipt(options.journalStore, journal, terminal);
      options.eventSink(terminal);
      return terminal;
    }
    if (observed.outcome === "complete") {
      journal = {
        ...journal,
        completedCases: [
          ...journal.completedCases,
          {
            caseId,
            effects: [...observed.effects],
            spendUsd: observed.spendUsd,
            elapsedSeconds: observed.elapsedSeconds,
            receipt: observed.receipt as JsonValue,
          },
        ],
        updatedAt: now(),
      };
      options.journalStore.save(journal);
      continue;
    }
    for (const effect of observed.nextEffects) ledger.recordEffect(caseId, effect);
    try {
      await options.driver.advance(context, observed);
    } catch (error) {
      // A mutation that failed in this process is never reconciled in-process,
      // even when this invocation began as a resume. Only a later explicit
      // resume receives read-based recovery authority.
      const recovered = await options.driver.observe({ ...context, mode: "start" });
      assertObservation(recovered, caseId);
      if (recovered.outcome !== "blocked") throw error;
      replay(options, journal.completedCases, recovered);
      options.eventSink({
        schemaVersion: 1,
        type: "live_evidence_case_observation",
        resumeId,
        caseId,
        caseIndex,
        stage: recovered.durableStage,
        outcome: recovered.outcome,
        observedAt: now(),
      });
      const terminal = receipt(journal, options.profile, "blocked", now(), {
        caseId,
        stage: recovered.durableStage,
        code: recovered.errorCode ?? "LIVE_EVIDENCE_BLOCKED",
      });
      journal = saveReceipt(options.journalStore, journal, terminal);
      options.eventSink(terminal);
      return terminal;
    }
  }
  replay(options, journal.completedCases).assertComplete();
  const terminal = receipt(journal, options.profile, "succeeded", now(), {
    caseId: null,
    stage: "complete",
    code: null,
  });
  journal = saveReceipt(options.journalStore, journal, terminal);
  options.eventSink(terminal);
  return terminal;
}
