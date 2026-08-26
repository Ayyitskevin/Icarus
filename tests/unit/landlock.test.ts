import { describe, expect, test } from "vitest";

import {
  buildLandlockSandboxSpec,
  detectLandlockSupport,
  isLandlockProfileName,
  LANDLOCK_DEFAULT_PROFILE,
  LANDLOCK_NOTICE_SCHEMA,
  LANDLOCK_PROFILE_NAMES,
  LANDLOCK_SANDBOX_SPEC_SCHEMA,
  landlockHelperArgv,
  landlockUnavailableNotice,
  parseKernelMajorMinor,
} from "../../packages/core/src/landlock.js";

const RUN_ID = "123e4567-e89b-12d3-a456-426614174000";

const CONTEXT = {
  stateRoot: "/state/icarus",
  executablePath: "/usr/bin/node",
} as const;

function ruleMap(spec: ReturnType<typeof buildLandlockSandboxSpec>): Map<string, string> {
  return new Map(spec.rules.map((rule) => [rule.path, rule.access]));
}

describe("landlock profile names", () => {
  test("the three governed profiles exist with workspace as the conservative default", () => {
    expect(LANDLOCK_PROFILE_NAMES).toEqual(["workspace", "read-only", "strict"]);
    expect(LANDLOCK_DEFAULT_PROFILE).toBe("workspace");
    expect(isLandlockProfileName("strict")).toBe(true);
    expect(isLandlockProfileName("off")).toBe(false);
    expect(isLandlockProfileName("danger-full-access")).toBe(false);
  });
});

describe("buildLandlockSandboxSpec", () => {
  test("workspace confines writes to Icarus state and keeps the host read-only", () => {
    const spec = buildLandlockSandboxSpec("workspace", CONTEXT);
    const rules = ruleMap(spec);
    expect(rules.get("/state/icarus")).toBe("rw");
    expect(rules.get("/")).toBe("ro");
    expect(rules.get("/dev/null")).toBe("rw");
    // The interpreter rule is subsumed by the read-only root and pruned.
    expect(spec.rules.some((rule) => rule.path === "/usr/bin/node")).toBe(false);
    expect(spec.schema).toBe(LANDLOCK_SANDBOX_SPEC_SCHEMA);
    expect(spec.profile).toBe("workspace");
  });

  test("read-only shrinks the read surface to an explicit allowlist", () => {
    const spec = buildLandlockSandboxSpec("read-only", {
      ...CONTEXT,
      sourceRepository: "/srv/repos/project",
    });
    const rules = ruleMap(spec);
    expect(rules.get("/state/icarus")).toBe("rw");
    expect(rules.get("/")).toBeUndefined();
    expect(rules.get("/home")).toBeUndefined();
    expect(rules.get("/tmp")).toBeUndefined();
    expect(rules.get("/usr")).toBe("ro");
    expect(rules.get("/etc")).toBe("ro");
    expect(rules.get("/proc")).toBe("ro");
    expect(rules.get("/dev")).toBe("ro");
    expect(rules.get("/srv/repos/project")).toBe("ro");
    expect(rules.get("/dev/null")).toBe("rw");
  });

  test("strict confines file-content writes to the run scratch and store, meta on state root", () => {
    const spec = buildLandlockSandboxSpec("strict", {
      ...CONTEXT,
      runId: RUN_ID,
      sourceRepository: "/srv/repos/project",
    });
    const rules = ruleMap(spec);
    expect(rules.get("/state/icarus")).toBe("meta");
    expect(rules.get("/state/icarus/icarus.sqlite3")).toBe("rw");
    expect(rules.get("/state/icarus/icarus.sqlite3-wal")).toBe("rw");
    expect(rules.get("/state/icarus/icarus.sqlite3-shm")).toBe("rw");
    expect(rules.get("/state/icarus/snapshots")).toBe("rw");
    expect(rules.get("/state/icarus/artifacts")).toBe("rw");
    expect(rules.get("/state/icarus/controller-home")).toBe("rw");
    expect(rules.get("/state/icarus/tmp")).toBe("rw");
    expect(rules.get("/state/icarus/locks")).toBe("rw");
    expect(rules.get(`/state/icarus/runs/${RUN_ID}`)).toBe("rw");
    expect(rules.get("/state/icarus/runs")).toBeUndefined();
    expect(rules.get("/usr")).toBe("ro");
    expect(rules.get("/srv/repos/project")).toBe("ro");
  });

  test("strict refuses a missing or malformed run ID", () => {
    expect(() => buildLandlockSandboxSpec("strict", CONTEXT)).toThrowError(/run ID/);
    expect(() =>
      buildLandlockSandboxSpec("strict", { ...CONTEXT, runId: "not-a-run-id" }),
    ).toThrowError(/run ID/);
  });

  test("specs are deterministic and digests change with the profile", () => {
    const first = buildLandlockSandboxSpec("read-only", CONTEXT);
    const second = buildLandlockSandboxSpec("read-only", CONTEXT);
    expect(first).toEqual(second);
    const other = buildLandlockSandboxSpec("workspace", CONTEXT);
    expect(first.digestSha256).not.toEqual(other.digestSha256);
    expect(first.digestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("rules are sorted and no rule is subsumed by an equal-or-broader ancestor", () => {
    const rank = { ro: 0, meta: 1, rw: 2 } as const;
    const spec = buildLandlockSandboxSpec("strict", { ...CONTEXT, runId: RUN_ID });
    const paths = spec.rules.map((rule) => rule.path);
    expect(paths).toEqual([...paths].sort());
    for (const rule of spec.rules) {
      for (const other of spec.rules) {
        if (rule === other) continue;
        const prefix = other.path === "/" ? "/" : `${other.path}/`;
        const subsumed =
          other.path !== rule.path &&
          rule.path.startsWith(prefix) &&
          rank[other.access] >= rank[rule.access];
        expect(subsumed).toBe(false);
      }
    }
  });
});

describe("detectLandlockSupport", () => {
  const supported = { platform: "linux", kernelRelease: "6.8.0-51-generic", abi: 3 } as const;

  test("linux with a capable kernel and probed ABI is supported", () => {
    expect(detectLandlockSupport(supported)).toEqual({ status: "supported", abi: 3 });
    expect(detectLandlockSupport({ ...supported, kernelRelease: "5.13.0" })).toEqual({
      status: "supported",
      abi: 3,
    });
  });

  test("non-linux platforms degrade with a documented reason", () => {
    const result = detectLandlockSupport({ ...supported, platform: "darwin" });
    expect(result.status).toBe("unsupported");
    if (result.status === "unsupported") expect(result.reason).toMatch(/Linux-only/);
  });

  test("kernels older than 5.13 degrade with a documented reason", () => {
    const result = detectLandlockSupport({ ...supported, kernelRelease: "5.12.19" });
    expect(result.status).toBe("unsupported");
    if (result.status === "unsupported") expect(result.reason).toMatch(/5\.13/);
    expect(detectLandlockSupport({ ...supported, kernelRelease: "4.19.0" }).status).toBe(
      "unsupported",
    );
  });

  test("a missing helper or zero ABI degrades with a documented reason", () => {
    expect(detectLandlockSupport({ ...supported, abi: null }).status).toBe("unsupported");
    expect(detectLandlockSupport({ ...supported, abi: 0 }).status).toBe("unsupported");
  });
});

describe("parseKernelMajorMinor", () => {
  test("parses ordinary and decorated kernel releases", () => {
    expect(parseKernelMajorMinor("6.8.0-51-generic")).toEqual({ major: 6, minor: 8 });
    expect(parseKernelMajorMinor("5.13")).toEqual({ major: 5, minor: 13 });
    expect(parseKernelMajorMinor("rolling")).toBeNull();
  });
});

describe("landlockUnavailableNotice", () => {
  test("is a canonical single-line warning record", () => {
    const notice = landlockUnavailableNotice("workspace", "no Landlock ABI");
    expect(notice).toEqual({
      schema: LANDLOCK_NOTICE_SCHEMA,
      status: "unavailable",
      profile: "workspace",
      reason: "no Landlock ABI",
    });
  });
});

describe("landlockHelperArgv", () => {
  test("emits rules in spec order followed by the wrapped command", () => {
    const spec = buildLandlockSandboxSpec("workspace", CONTEXT);
    const argv = landlockHelperArgv("/tmp/helper", spec, ["/usr/bin/node", "main.js", "run"]);
    expect(argv[0]).toBe("/tmp/helper");
    const separator = argv.indexOf("--");
    expect(separator).toBeGreaterThan(0);
    expect(argv.slice(separator + 1)).toEqual(["/usr/bin/node", "main.js", "run"]);
    const ruleArgs = argv.slice(1, separator);
    expect(ruleArgs.length % 2).toBe(0);
    for (let index = 0; index < ruleArgs.length; index += 2) {
      expect(["--ro", "--rw", "--meta"]).toContain(ruleArgs[index]);
    }
    expect(ruleArgs).toContain("--rw");
    expect(ruleArgs).toContain("/state/icarus");
  });

  test("refuses an empty wrapped command", () => {
    const spec = buildLandlockSandboxSpec("workspace", CONTEXT);
    expect(() => landlockHelperArgv("/tmp/helper", spec, [])).toThrowError(/command/);
  });
});
