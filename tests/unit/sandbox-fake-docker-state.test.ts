import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createRecordingDocker } from "../support/sandbox-fake-docker.js";

async function makeRoot(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "icarus-fake-docker-state-"));
}

/**
 * The cancellation scenarios kill the fake Docker `run` process at the exact
 * moment it records its container, so its state file must survive a signal
 * arriving mid-write.
 *
 * A direct `writeFileSync` truncates before it writes. A signal in that window
 * leaves an empty file, and the next `container inspect` then dies parsing it
 * rather than reporting "No such container". The runner reads that as
 * unconfirmed cleanup and correctly downgrades a cancelled check to
 * `unavailable` -- so a fixture that can be interrupted mid-write turns a
 * genuine product guarantee into an intermittent failure that looks like a
 * product bug.
 */
describe("fake Docker state durability", () => {
  it("leaves the committed state intact when an interrupted write is abandoned", async () => {
    const root = await makeRoot();
    const docker = await createRecordingDocker(root, {});
    const statePath = path.join(root, "fake-docker-state.json");
    // A partially written pending file is exactly what a signal mid-write
    // leaves behind. The committed state must be unaffected, which is the
    // property the rename buys and a direct truncating write does not.
    await writeFile(`${statePath}.999999.pending`, '{"containers":{"trunc');

    const inspection = spawnSync(
      docker.binary,
      ["container", "inspect", "--format", "{{json .Config.Labels}}", "icarus-absent"],
      { encoding: "utf8" },
    );

    // The runner treats a non-zero inspect as benign only when the message says
    // the container does not exist; anything else is unconfirmed cleanup, which
    // is what downgraded a cancelled check to unavailable in CI.
    expect(inspection.status).not.toBe(0);
    expect(inspection.stderr).toMatch(/No such (?:object|container)/i);
  });

  it("never leaves the state file unparseable while recording a container", async () => {
    const root = await makeRoot();
    const docker = await createRecordingDocker(root, {});
    const statePath = path.join(root, "fake-docker-state.json");

    const run = spawnSync(
      docker.binary,
      [
        "run",
        "--name",
        "icarus-durable",
        "--label",
        "icarus.managed=true",
        "--label",
        "icarus.run_id=run-1",
      ],
      { encoding: "utf8" },
    );
    expect(run.status).toBe(0);

    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      readonly containers: Record<string, { readonly labels: Record<string, string> }>;
    };
    expect(state.containers["icarus-durable"]?.labels["icarus.run_id"]).toBe("run-1");
  });

  it("writes its state through an atomic rename so a signal cannot truncate it", async () => {
    const root = await makeRoot();
    const docker = await createRecordingDocker(root, {});
    const source = await readFile(docker.binary, "utf8");

    // A rename is atomic within a directory, so an interrupted write leaves
    // either the previous complete state or the new one -- never an empty file.
    expect(source).toContain("renameSync(pending, statePath)");
    expect(source).not.toMatch(/writeFileSync\(\s*statePath/);
  });
});
