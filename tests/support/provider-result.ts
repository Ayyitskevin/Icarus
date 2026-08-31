import type { ProviderReportedIdentity } from "../../packages/core/src/provider.js";

/** Test providers must assert identity too; otherwise they could hide a missing
 * production-adapter capture behind structurally incomplete fixtures. */
export function syntheticReportedIdentity(
  model = "synthetic-provider-model",
): ProviderReportedIdentity {
  return {
    model,
    responseId: null,
    requestId: null,
    providerId: null,
    upstreamModel: null,
    upstreamHost: null,
  };
}
