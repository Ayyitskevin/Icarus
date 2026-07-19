import { chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { ArtifactStore } from "./artifacts.js";
import { invariant } from "./errors.js";
import { GitController } from "./git.js";
import { DockerSandboxRunner } from "./sandbox.js";
import { type GatewayFactory, IcarusService } from "./service.js";
import { IcarusStore } from "./store.js";

export interface IcarusRuntime {
  readonly service: IcarusService;
  close(): void;
}

const STATE_MARKER = '{"application":"icarus","format":1}\n';

async function prepareStateRoot(requestedRoot: string): Promise<string> {
  const root = path.resolve(requestedRoot);
  invariant(root !== path.parse(root).root, "UNSAFE_STATE_ROOT", "State root must be dedicated");

  const parent = path.dirname(root);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const canonicalParent = await realpath(parent);
  invariant(
    canonicalParent === parent,
    "UNSAFE_STATE_ROOT",
    "State root may not traverse a symbolic-link parent",
  );

  let created = false;
  let stateStat = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (stateStat === null) {
    await mkdir(root, { recursive: false, mode: 0o700 });
    created = true;
    stateStat = await lstat(root);
  }
  invariant(
    stateStat.isDirectory() && !stateStat.isSymbolicLink(),
    "UNSAFE_STATE_ROOT",
    "Icarus state root is unsafe",
  );
  const currentUid = process.getuid?.();
  invariant(
    currentUid === undefined || stateStat.uid === currentUid,
    "UNSAFE_STATE_ROOT",
    "Icarus state root is owned by another user",
  );
  invariant(
    (stateStat.mode & 0o077) === 0,
    "UNSAFE_STATE_ROOT",
    "Icarus state root must not grant group or world access",
  );
  invariant(
    (await realpath(root)) === path.join(canonicalParent, path.basename(root)),
    "UNSAFE_STATE_ROOT",
    "Icarus state root changed during validation",
  );

  const markerPath = path.join(root, ".icarus-state-v1");
  let markerExists = false;
  if (!created) {
    const markerStat = await lstat(markerPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (markerStat === null) {
      invariant(
        (await readdir(root)).length === 0,
        "UNSAFE_STATE_ROOT",
        "Existing state root is not an empty dedicated directory",
      );
    } else {
      markerExists = true;
      invariant(
        markerStat.isFile() && !markerStat.isSymbolicLink() && markerStat.nlink === 1,
        "UNSAFE_STATE_ROOT",
        "Icarus state marker is unsafe",
      );
      invariant(
        currentUid === undefined || markerStat.uid === currentUid,
        "UNSAFE_STATE_ROOT",
        "Icarus state marker is owned by another user",
      );
      invariant(
        (await readFile(markerPath, "utf8")) === STATE_MARKER,
        "UNSAFE_STATE_ROOT",
        "Icarus state marker is invalid",
      );
    }
  }

  if (!markerExists) {
    await writeFile(markerPath, STATE_MARKER, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }
  await chmod(markerPath, 0o600);
  await chmod(root, 0o700);
  return root;
}

export async function createIcarusRuntime(
  stateRoot: string,
  options: { readonly dockerBinary?: string; readonly gatewayFactory?: GatewayFactory } = {},
): Promise<IcarusRuntime> {
  const root = await prepareStateRoot(stateRoot);
  const controllerHome = path.join(root, "controller-home");
  const runsRoot = path.join(root, "runs");
  await mkdir(controllerHome, { recursive: true, mode: 0o700 });
  await mkdir(runsRoot, { recursive: true, mode: 0o700 });

  const store = new IcarusStore(path.join(root, "icarus.sqlite3"));
  const artifacts = new ArtifactStore(root);
  const git = new GitController(controllerHome, runsRoot);
  const checks = new DockerSandboxRunner(root, git, options.dockerBinary ?? "docker");
  const service = new IcarusService({
    stateRoot: root,
    store,
    artifacts,
    git,
    checks,
    ...(options.gatewayFactory === undefined ? {} : { gatewayFactory: options.gatewayFactory }),
  });
  try {
    await service.initialize();
  } catch (error) {
    store.close();
    throw error;
  }
  return {
    service,
    close: () => store.close(),
  };
}
