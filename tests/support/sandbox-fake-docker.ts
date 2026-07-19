import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface FakeDockerScenario {
  readonly securityOptions?: unknown;
  readonly infoStdout?: string;
  readonly infoExitCode?: number;
  readonly imageConfig?: unknown;
  readonly imageInspectStdout?: string;
  readonly imageInspectExitCode?: number;
  readonly listedContainerIds?: readonly string[];
  readonly cleanupFails?: boolean;
  readonly cleanupLeavesContainer?: boolean;
  readonly run?: {
    readonly delayMs?: number;
    readonly exitCode?: number;
    readonly stdout?: string;
    readonly stderr?: string;
  };
  readonly observePaths?: readonly string[];
}

export interface FakeDockerCall {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly snapshot?: {
    readonly root: string;
    readonly entries: Readonly<
      Record<string, { readonly content: string; readonly mode: number; readonly error?: string }>
    >;
  };
}

export interface RecordingDocker {
  readonly binary: string;
  readonly callsPath: string;
  calls(): Promise<readonly FakeDockerCall[]>;
  waitForCall(predicate: (call: FakeDockerCall) => boolean): Promise<FakeDockerCall>;
}

export async function createRecordingDocker(
  root: string,
  scenario: FakeDockerScenario = {},
): Promise<RecordingDocker> {
  const controlPath = path.join(root, "fake-docker-control.json");
  const statePath = path.join(root, "fake-docker-state.json");
  const callsPath = path.join(root, "fake-docker-calls.jsonl");
  const binary = path.join(root, "fake-docker");
  await writeFile(controlPath, `${JSON.stringify(scenario)}\n`, { mode: 0o600 });
  await writeFile(statePath, '{"containers":{}}\n', { mode: 0o600 });
  await writeFile(callsPath, "", { mode: 0o600 });

  const source = `#!${process.execPath}
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";

const controlPath = ${JSON.stringify(controlPath)};
const statePath = ${JSON.stringify(statePath)};
const callsPath = ${JSON.stringify(callsPath)};
const scenario = JSON.parse(readFileSync(controlPath, "utf8"));
const argv = process.argv.slice(2);
const readState = () => JSON.parse(readFileSync(statePath, "utf8"));
const writeState = (state) => writeFileSync(statePath, JSON.stringify(state) + "\\n", { mode: 0o600 });
const valueAfter = (flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};
const valuesAfter = (flag) => argv.flatMap((value, index) => value === flag ? [argv[index + 1]] : []).filter(Boolean);
const record = {
  argv,
  cwd: process.cwd(),
  env: Object.fromEntries(Object.entries(process.env).sort(([left], [right]) => left.localeCompare(right))),
};

if (argv[0] === "run") {
  const mount = valueAfter("--mount");
  const match = typeof mount === "string" ? /^type=bind,source=(.*),target=\\/workspace,readonly$/.exec(mount) : null;
  if (match) {
    const snapshotRoot = match[1];
    const entries = {};
    for (const relativePath of scenario.observePaths ?? []) {
      try {
        const absolutePath = snapshotRoot + "/" + relativePath;
        entries[relativePath] = {
          content: readFileSync(absolutePath, "utf8"),
          mode: statSync(absolutePath).mode & 0o777,
        };
      } catch (error) {
        entries[relativePath] = { content: "", mode: 0, error: String(error) };
      }
    }
    record.snapshot = { root: snapshotRoot, entries };
  }
}
appendFileSync(callsPath, JSON.stringify(record) + "\\n", { mode: 0o600 });

const writeOutput = (stdout = "", stderr = "") => {
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
};

if (argv[0] === "info") {
  const stdout = scenario.infoStdout ?? JSON.stringify(scenario.securityOptions ?? ["name=seccomp,profile=default"]);
  writeOutput(stdout + (stdout.endsWith("\\n") ? "" : "\\n"));
  process.exit(scenario.infoExitCode ?? 0);
}

if (argv[0] === "image" && argv[1] === "inspect") {
  const stdout = scenario.imageInspectStdout ?? JSON.stringify(scenario.imageConfig ?? {});
  writeOutput(stdout + (stdout.endsWith("\\n") ? "" : "\\n"), scenario.imageInspectExitCode ? "image missing\\n" : "");
  process.exit(scenario.imageInspectExitCode ?? 0);
}

if (argv[0] === "container" && argv[1] === "list") {
  writeOutput((scenario.listedContainerIds ?? []).join("\\n") + ((scenario.listedContainerIds ?? []).length ? "\\n" : ""));
  process.exit(0);
}

if (argv[0] === "container" && argv[1] === "inspect") {
  const name = argv.at(-1);
  const state = readState();
  const container = state.containers[name];
  if (!container) {
    writeOutput("", "Error: No such container: " + name + "\\n");
    process.exit(1);
  }
  writeOutput(JSON.stringify(container.labels) + "\\n");
  process.exit(0);
}

if (argv[0] === "container" && argv[1] === "rm") {
  const name = argv.at(-1);
  if (scenario.cleanupFails) {
    writeOutput("", "forced cleanup failure\\n");
    process.exit(1);
  }
  const state = readState();
  if (!scenario.cleanupLeavesContainer) delete state.containers[name];
  writeState(state);
  writeOutput(name + "\\n");
  process.exit(0);
}

if (argv[0] === "run") {
  const name = valueAfter("--name");
  const labels = Object.fromEntries(valuesAfter("--label").map((label) => {
    const separator = label.indexOf("=");
    return [label.slice(0, separator), label.slice(separator + 1)];
  }));
  const state = readState();
  state.containers[name] = { labels };
  writeState(state);
  const behavior = scenario.run ?? {};
  if ((behavior.delayMs ?? 0) > 0) await new Promise((resolve) => setTimeout(resolve, behavior.delayMs));
  writeOutput(behavior.stdout ?? "", behavior.stderr ?? "");
  process.exit(behavior.exitCode ?? 0);
}

writeOutput("", "unexpected fake Docker argv: " + JSON.stringify(argv) + "\\n");
process.exit(97);
`;
  await writeFile(binary, source, { mode: 0o700 });
  await chmod(binary, 0o700);

  const calls = async (): Promise<readonly FakeDockerCall[]> => {
    const text = await readFile(callsPath, "utf8");
    return text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as FakeDockerCall);
  };

  return {
    binary,
    callsPath,
    calls,
    async waitForCall(predicate: (call: FakeDockerCall) => boolean): Promise<FakeDockerCall> {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const match = (await calls()).find(predicate);
        if (match !== undefined) {
          return match;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("Timed out waiting for fake Docker invocation");
    },
  };
}
