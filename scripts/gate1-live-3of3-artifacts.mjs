#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

import {
  GATE1_REQUIRED_STACKS,
  validateGate1BenchmarkManifest,
} from "./gate1-benchmark-contract.mjs";

const ADAPTER_VERSION = "production-ollama-api-chat-v1";
const CREDENTIAL_ENV = "ICARUS_GITHUB_TOKEN_GATE1";
const AUTHORIZED_EFFECTS = Object.freeze([
  "github.objects.upload",
  "github.ref.create.absent_only",
  "github.pull_request.create.draft",
  "github.landing.receipt",
]);
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/;
const SHA1_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function fail(message) {
  throw new Error(message);
}

function parseOptions(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (typeof key !== "string" || !key.startsWith("--") || value === undefined) {
      fail(`Expected --key value pairs, received ${JSON.stringify(argv.slice(index))}`);
    }
    const existing = values.get(key) ?? [];
    existing.push(value);
    values.set(key, existing);
  }
  return values;
}

function one(options, key) {
  const values = options.get(key);
  if (values?.length !== 1) fail(`${key} must be provided exactly once`);
  return values[0];
}

function many(options, key) {
  return options.get(key) ?? [];
}

function rejectUnknown(options, allowed) {
  for (const key of options.keys()) {
    if (!allowed.includes(key)) fail(`Unknown option: ${key}`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertPlainRecord(value, field) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${field} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${field} must have a plain prototype`);
  }
  return value;
}

function readBytes(path, secure = false) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${path} must be a regular non-symlink file`);
  if (stat.uid !== process.getuid()) fail(`${path} must be owned by the current user`);
  if (stat.nlink !== 1) fail(`${path} must have exactly one hard link`);
  if (secure && (stat.mode & 0o077) !== 0)
    fail(`${path} must not be accessible by group or others`);
  const first = readFileSync(path);
  const after = lstatSync(path);
  if (
    stat.dev !== after.dev ||
    stat.ino !== after.ino ||
    stat.size !== after.size ||
    stat.mtimeMs !== after.mtimeMs
  ) {
    fail(`${path} changed while it was being read`);
  }
  return first;
}

function parseJson(bytes, field) {
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(`${field} is not valid UTF-8`);
  }
  try {
    return JSON.parse(source);
  } catch {
    fail(`${field} is not valid JSON`);
  }
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function ensureSecureDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${path} must be a non-symlink directory`);
  if (stat.uid !== process.getuid()) fail(`${path} must be owned by the current user`);
  if ((stat.mode & 0o077) !== 0) fail(`${path} must not be accessible by group or others`);
}

function writeSecureIdempotent(path, bytes) {
  ensureSecureDirectory(dirname(path));
  try {
    const existing = readBytes(path, true);
    if (!existing.equals(bytes)) {
      fail(
        `${path} already exists with different bytes; choose a new output or inspect it manually`,
      );
    }
    return "reused";
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, bytes);
  } finally {
    closeSync(descriptor);
  }
  return "written";
}

function parseMapping(values, expectedKeys, label) {
  const result = new Map();
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) fail(`${label} must be KEY=VALUE`);
    const key = value.slice(0, separator);
    const mapped = value.slice(separator + 1);
    if (!expectedKeys.includes(key) || result.has(key))
      fail(`${label} has an invalid or duplicate key: ${key}`);
    result.set(key, mapped);
  }
  if (result.size !== expectedKeys.length) {
    fail(`${label} must provide exactly ${expectedKeys.join(", ")}`);
  }
  return result;
}

function validatedManifest(path) {
  const bytes = readBytes(path);
  const value = parseJson(bytes, path);
  validateGate1BenchmarkManifest(value);
  return { bytes, value };
}

function manifestCommand(options) {
  rejectUnknown(options, ["--source", "--output", "--owner", "--repo"]);
  const source = one(options, "--source");
  const output = one(options, "--output");
  const requestedOwner = one(options, "--owner");
  if (!OWNER_PATTERN.test(requestedOwner)) fail("--owner is not a valid GitHub owner name");
  const owner = requestedOwner.toLowerCase();
  const repositories = parseMapping(many(options, "--repo"), GATE1_REQUIRED_STACKS, "--repo");
  for (const repository of repositories.values()) {
    if (!REPOSITORY_PATTERN.test(repository) || repository === "." || repository === "..") {
      fail(`Invalid GitHub repository name: ${repository}`);
    }
  }
  if (new Set(repositories.values()).size !== repositories.size)
    fail("Repository names must be distinct");

  const { value } = validatedManifest(source);
  const live = structuredClone(value);
  for (const benchmarkCase of live.cases) {
    const repository = repositories.get(benchmarkCase.stack);
    if (repository === undefined) fail(`Unexpected manifest stack: ${benchmarkCase.stack}`);
    benchmarkCase.repository.githubOwner = owner;
    benchmarkCase.repository.githubRepository = repository;
    benchmarkCase.draftPullRequestEvidence.owner = owner;
    benchmarkCase.draftPullRequestEvidence.repository = repository;
  }
  validateGate1BenchmarkManifest(live);
  const bytes = canonicalBytes(live);
  const outcome = writeSecureIdempotent(output, bytes);
  return { kind: "manifest", outcome, output, sha256: sha256(bytes) };
}

function integerOption(options, key) {
  const raw = one(options, key);
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) fail(`${key} must be a non-negative integer`);
  return Number(raw);
}

function assessmentCommand(options) {
  const allowed = [
    "--manifest",
    "--case",
    "--output",
    "--owner",
    "--repository",
    "--assessed-at",
    "--private",
    "--actions-enabled",
    "--workflow-files",
    "--webhooks",
    "--actions-secrets",
    "--environments",
    "--deployments",
    "--remote-main-sha1",
  ];
  rejectUnknown(options, allowed);
  const { value: manifest } = validatedManifest(one(options, "--manifest"));
  const caseId = one(options, "--case");
  const benchmarkCase = manifest.cases.find((entry) => entry.id === caseId);
  if (benchmarkCase === undefined) fail(`Unknown Gate 1 case: ${caseId}`);
  const owner = one(options, "--owner");
  const repository = one(options, "--repository");
  if (
    owner !== benchmarkCase.repository.githubOwner ||
    repository !== benchmarkCase.repository.githubRepository
  ) {
    fail("Assessment repository identity does not match the live manifest");
  }
  const assessedAt = one(options, "--assessed-at");
  if (new Date(assessedAt).toISOString() !== assessedAt)
    fail("--assessed-at must be canonical ISO-8601");
  const isPrivate = one(options, "--private") === "true";
  const actionsEnabled = one(options, "--actions-enabled") === "true";
  if (!isPrivate || one(options, "--private") !== "true")
    fail("Live evidence repository must be private");
  if (actionsEnabled || one(options, "--actions-enabled") !== "false") {
    fail("GitHub Actions must be disabled before an inert-repository assessment is recorded");
  }
  const observations = {
    private: isPrivate,
    actionsEnabled,
    workflowFiles: integerOption(options, "--workflow-files"),
    webhooks: integerOption(options, "--webhooks"),
    actionsSecrets: integerOption(options, "--actions-secrets"),
    environments: integerOption(options, "--environments"),
    deployments: integerOption(options, "--deployments"),
    remoteMainSha1: one(options, "--remote-main-sha1"),
  };
  for (const key of [
    "workflowFiles",
    "webhooks",
    "actionsSecrets",
    "environments",
    "deployments",
  ]) {
    if (observations[key] !== 0) fail(`${key} must be zero for an inert repository`);
  }
  if (
    !SHA1_PATTERN.test(observations.remoteMainSha1) ||
    observations.remoteMainSha1 !== benchmarkCase.repository.sourceRevision.commitSha1
  ) {
    fail("Remote main SHA-1 does not match the pinned Gate 1 source revision");
  }
  const assessment = {
    schemaVersion: 1,
    caseId,
    owner,
    repository,
    assessedAt,
    disposition: "inert-repository",
    observations,
  };
  const output = one(options, "--output");
  const bytes = canonicalBytes(assessment);
  const outcome = writeSecureIdempotent(output, bytes);
  return { kind: "assessment", outcome, output, sha256: sha256(bytes) };
}

function decodeAssessment(path, benchmarkCase) {
  const bytes = readBytes(path, true);
  const value = assertPlainRecord(parseJson(bytes, path), path);
  const expectedKeys = [
    "schemaVersion",
    "caseId",
    "owner",
    "repository",
    "assessedAt",
    "disposition",
    "observations",
  ];
  if (JSON.stringify(Object.keys(value)) !== JSON.stringify(expectedKeys)) {
    fail(`${path} has missing, reordered, or unknown assessment fields`);
  }
  if (
    value.schemaVersion !== 1 ||
    value.caseId !== benchmarkCase.id ||
    value.owner !== benchmarkCase.repository.githubOwner ||
    value.repository !== benchmarkCase.repository.githubRepository ||
    value.disposition !== "inert-repository"
  ) {
    fail(`${path} does not bind the expected repository and disposition`);
  }
  const observations = assertPlainRecord(value.observations, `${path}.observations`);
  const observationKeys = [
    "private",
    "actionsEnabled",
    "workflowFiles",
    "webhooks",
    "actionsSecrets",
    "environments",
    "deployments",
    "remoteMainSha1",
  ];
  if (JSON.stringify(Object.keys(observations)) !== JSON.stringify(observationKeys)) {
    fail(`${path}.observations has missing, reordered, or unknown fields`);
  }
  if (
    observations.private !== true ||
    observations.actionsEnabled !== false ||
    [
      observations.workflowFiles,
      observations.webhooks,
      observations.actionsSecrets,
      observations.environments,
      observations.deployments,
    ].some((entry) => entry !== 0) ||
    observations.remoteMainSha1 !== benchmarkCase.repository.sourceRevision.commitSha1
  ) {
    fail(`${path} is not evidence of an inert pinned repository`);
  }
  return { bytes, value };
}

function profileCommand(options) {
  rejectUnknown(options, [
    "--manifest",
    "--output",
    "--profile-id",
    "--actor",
    "--model",
    "--base-url",
    "--assessment",
  ]);
  const manifestPath = one(options, "--manifest");
  const { bytes: manifestBytes, value: manifest } = validatedManifest(manifestPath);
  const assessments = parseMapping(
    many(options, "--assessment"),
    manifest.cases.map((entry) => entry.id),
    "--assessment",
  );
  const requestedActor = one(options, "--actor");
  if (!OWNER_PATTERN.test(requestedActor)) fail("--actor is not a valid GitHub actor name");
  const actor = requestedActor.toLowerCase();
  const cases = manifest.cases.map((benchmarkCase) => {
    const assessmentPath = assessments.get(benchmarkCase.id);
    const assessment = decodeAssessment(assessmentPath, benchmarkCase);
    return {
      caseId: benchmarkCase.id,
      landingProfile: {
        version: 1,
        provider: "github",
        owner: benchmarkCase.repository.githubOwner,
        repository: benchmarkCase.repository.githubRepository,
        baseBranch: benchmarkCase.repository.baseBranch,
        branchNamespace: benchmarkCase.candidate.branchNamespace,
        credentialRef: { kind: "environment", name: CREDENTIAL_ENV },
        expectedActor: actor,
        commitIdentity: structuredClone(benchmarkCase.candidate.commitIdentity),
        derivativeEffects: {
          version: 1,
          disposition: "inert-repository",
          evidenceSha256: sha256(assessment.bytes),
        },
      },
    };
  });
  const profile = {
    schemaVersion: 1,
    profileId: one(options, "--profile-id"),
    benchmarkId: manifest.benchmarkId,
    benchmarkRevision: manifest.benchmarkRevision,
    offlineManifestDigest: sha256(manifestBytes),
    provider: {
      kind: "ollama",
      model: one(options, "--model"),
      baseUrl: one(options, "--base-url"),
      adapterVersion: ADAPTER_VERSION,
      inputUsdPerMillionTokens: 0,
      outputUsdPerMillionTokens: 0,
    },
    budgets: { maxSpendUsd: 0, maxRuntimeSeconds: 3600 },
    authorizedEffects: [...AUTHORIZED_EFFECTS],
    cases,
  };
  const output = one(options, "--output");
  const bytes = canonicalBytes(profile);
  const outcome = writeSecureIdempotent(output, bytes);
  return { kind: "profile", outcome, output, sha256: sha256(bytes) };
}

function runMapCommand(options) {
  rejectUnknown(options, ["--manifest", "--profile", "--output", "--run"]);
  const { bytes: manifestBytes, value: manifest } = validatedManifest(one(options, "--manifest"));
  const profilePath = one(options, "--profile");
  const profile = assertPlainRecord(
    parseJson(readBytes(profilePath, true), profilePath),
    profilePath,
  );
  if (typeof profile.profileId !== "string" || profile.approval === undefined) {
    fail("--profile must be an approved live-evidence profile");
  }
  const runs = parseMapping(
    many(options, "--run"),
    manifest.cases.map((entry) => entry.id),
    "--run",
  );
  if (new Set(runs.values()).size !== runs.size) fail("Run IDs must be distinct");
  for (const runId of runs.values()) {
    if (!RUN_ID_PATTERN.test(runId)) fail(`Invalid Icarus run ID: ${runId}`);
  }
  const runMap = {
    schemaVersion: 1,
    profileId: profile.profileId,
    manifestSha256: sha256(manifestBytes),
    cases: manifest.cases.map((entry) => ({ caseId: entry.id, runId: runs.get(entry.id) })),
  };
  const output = one(options, "--output");
  const bytes = canonicalBytes(runMap);
  const outcome = writeSecureIdempotent(output, bytes);
  return { kind: "run-map", outcome, output, sha256: sha256(bytes) };
}

function usage() {
  return [
    "gate1-live-3of3-artifacts.mjs manifest --source FILE --output FILE --owner OWNER --repo STACK=REPO (x3)",
    "gate1-live-3of3-artifacts.mjs assessment --manifest FILE --case ID --output FILE --owner OWNER --repository REPO --assessed-at ISO --private true --actions-enabled false --workflow-files 0 --webhooks 0 --actions-secrets 0 --environments 0 --deployments 0 --remote-main-sha1 SHA1",
    "gate1-live-3of3-artifacts.mjs profile --manifest FILE --output FILE --profile-id ID --actor ACTOR --model MODEL --base-url URL --assessment CASE=FILE (x3)",
    "gate1-live-3of3-artifacts.mjs run-map --manifest FILE --profile FILE --output FILE --run CASE=UUID (x3)",
  ].join("\n");
}

function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const options = parseOptions(argv);
  let result;
  if (command === "manifest") result = manifestCommand(options);
  else if (command === "assessment") result = assessmentCommand(options);
  else if (command === "profile") result = profileCommand(options);
  else if (command === "run-map") result = runMapCommand(options);
  else fail(`Unknown command: ${command}\n${usage()}`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `gate1-live-3of3-artifacts: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
