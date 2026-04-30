import * as path from "node:path";
import { SafetyStrategy } from "./runCodexExec";
import {
  MANAGED_MARKER,
  ManagedTable,
  readAndStripManagedContent,
  writeConfigFile,
} from "./codexConfigFile";

const PROXY_PROVIDER_ID = "codex-action-responses-proxy";
const BEDROCK_PROVIDER_ID = "amazon-bedrock";

const MANAGED_TABLES: ReadonlyArray<ManagedTable> = [
  { header: `[model_providers.${PROXY_PROVIDER_ID}]` },
  { header: `[model_providers.${BEDROCK_PROVIDER_ID}]` },
];

export async function writeProxyConfig(
  codexHome: string,
  port: number,
  safetyStrategy: SafetyStrategy
): Promise<void> {
  const configPath = path.join(codexHome, "config.toml");

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid proxy port: ${port}`);
  }

  const existing = await readAndStripManagedContent(configPath, MANAGED_TABLES);

  const header = `${MANAGED_MARKER}
model_provider = "${PROXY_PROVIDER_ID}"
`;
  const table = `
${MANAGED_MARKER}
[model_providers.${PROXY_PROVIDER_ID}]
name = "Codex Action Responses Proxy"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
`;

  const sections = [`${header}${table}`.trimEnd(), existing.trim()].filter(
    (s) => s.length > 0
  );
  const output = sections.join("\n\n") + "\n";

  await writeConfigFile(configPath, output, safetyStrategy);
}
