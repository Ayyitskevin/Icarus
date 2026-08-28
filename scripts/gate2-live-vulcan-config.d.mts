export interface Gate2LiveVulcanConfig {
  provider: { id: "local-ollama"; type: string; baseUrl: string };
  mappings: Map<string, { provider: string; providerModel: string }>;
}

export function parseGate2LiveVulcanConfig(
  source: string,
  expectedOllamaOrigin: string,
): Gate2LiveVulcanConfig;
