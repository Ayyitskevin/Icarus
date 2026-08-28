export const GATE2_LIVE_ROUTING_POLICY: Readonly<{
  schemaVersion: 1;
  baseline: Readonly<{ defaultModelId: "code-fast"; overrides: Readonly<Record<string, never>> }>;
  routed: Readonly<{
    defaultModelId: "code";
    overrides: Readonly<Record<string, never>>;
  }>;
}>;
export const GATE2_LIVE_ROUTING_POLICY_SHA256: string;
export function selectGate2LiveModel(
  mode: "baseline" | "routed",
  benchmarkClass: string,
): "code" | "code-fast";
