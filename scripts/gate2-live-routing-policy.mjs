import { createHash } from "node:crypto";

export const GATE2_LIVE_ROUTING_POLICY = Object.freeze({
  schemaVersion: 1,
  baseline: Object.freeze({ defaultModelId: "code-fast", overrides: Object.freeze({}) }),
  routed: Object.freeze({
    defaultModelId: "code",
    overrides: Object.freeze({}),
  }),
});

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

export const GATE2_LIVE_ROUTING_POLICY_SHA256 = createHash("sha256")
  .update(stableJson(GATE2_LIVE_ROUTING_POLICY))
  .digest("hex");

export function selectGate2LiveModel(mode, benchmarkClass) {
  if (mode !== "baseline" && mode !== "routed") throw new Error("Gate 2 live mode is invalid");
  const policy = GATE2_LIVE_ROUTING_POLICY[mode];
  return policy.overrides[benchmarkClass] ?? policy.defaultModelId;
}
