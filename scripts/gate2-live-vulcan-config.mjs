function fail(message) {
  throw new Error(`Gate 2 live Vulcan config: ${message}`);
}

function collectBlocks(source, header) {
  if (typeof source !== "string") fail("source must be text");
  const blocks = [];
  let current = null;
  for (const line of source.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      if (current !== null) blocks.push(current);
      current = trimmed === header ? [] : null;
    } else if (current !== null) {
      current.push(line);
    }
  }
  if (current !== null) blocks.push(current);
  return blocks;
}

function stringField(block, key, label) {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"\\s*(?:#.*)?$`, "u");
  const matches = block.map((line) => pattern.exec(line)).filter((match) => match !== null);
  if (matches.length !== 1) fail(`${label}.${key} must occur exactly once`);
  return matches[0][1];
}

export function parseGate2LiveVulcanConfig(source, expectedOllamaOrigin) {
  if (typeof source !== "string") fail("source must be text");
  if (source.includes('"""') || source.includes("'''")) {
    fail("multiline TOML strings are unsupported at this evidence boundary");
  }
  const providerBlocks = collectBlocks(source, "[providers.local-ollama]");
  if (providerBlocks.length !== 1) fail("local-ollama provider must occur exactly once");
  const provider = {
    id: "local-ollama",
    type: stringField(providerBlocks[0], "type", "local-ollama"),
    baseUrl: stringField(providerBlocks[0], "base_url", "local-ollama"),
  };
  let providerUrl;
  try {
    providerUrl = new URL(provider.baseUrl);
  } catch {
    fail("local-ollama.base_url must be an absolute URL");
  }
  if (
    provider.type !== "ollama" ||
    providerUrl.origin !== expectedOllamaOrigin ||
    providerUrl.username !== "" ||
    providerUrl.password !== "" ||
    providerUrl.pathname !== "/" ||
    providerUrl.search !== "" ||
    providerUrl.hash !== ""
  ) {
    fail("local-ollama provider must be the exact credential-free loopback Ollama origin");
  }

  const mappings = new Map();
  for (const block of collectBlocks(source, "[[models]]")) {
    const id = stringField(block, "id", "model");
    if (mappings.has(id)) fail(`model id is duplicated: ${id}`);
    mappings.set(id, {
      provider: stringField(block, "provider", `model ${id}`),
      providerModel: stringField(block, "provider_model", `model ${id}`),
    });
  }
  if (mappings.size === 0) fail("at least one model mapping is required");
  return { provider, mappings };
}
