import * as path from "node:path";
import { SafetyStrategy } from "./runCodexExec";
import {
  MANAGED_MARKER,
  ManagedTable,
  readAndStripManagedContent,
  writeConfigFile,
} from "./codexConfigFile";

const BEDROCK_PROVIDER_ID = "amazon-bedrock";
const PROXY_PROVIDER_ID = "codex-action-responses-proxy";

// Tables that codex-action may have written previously. We strip both so a
// re-run, or a switch from proxy mode to Bedrock mode, never produces a
// duplicate `model_provider` key or a stale `[model_providers.<id>]` table.
const MANAGED_TABLES: ReadonlyArray<ManagedTable> = [
  { header: `[model_providers.${BEDROCK_PROVIDER_ID}]` },
  { header: `[model_providers.${PROXY_PROVIDER_ID}]` },
];

export async function writeBedrockConfig(
  codexHome: string,
  safetyStrategy: SafetyStrategy,
  baseUrl: string | null
): Promise<void> {
  const configPath = path.join(codexHome, "config.toml");

  const validatedBaseUrl =
    baseUrl != null ? validateBedrockBaseUrl(baseUrl) : null;

  const existing = await readAndStripManagedContent(configPath, MANAGED_TABLES);

  const header = `${MANAGED_MARKER}
model_provider = "${BEDROCK_PROVIDER_ID}"
`;

  // The Codex CLI has a built-in `amazon-bedrock` model provider, so the
  // [model_providers.amazon-bedrock] table is only needed when the user wants
  // to override the base_url (for example, to target a non-default AWS region).
  let table = "";
  if (validatedBaseUrl != null) {
    table = `
${MANAGED_MARKER}
[model_providers.${BEDROCK_PROVIDER_ID}]
name = "Amazon Bedrock"
base_url = "${validatedBaseUrl}"
`;
  }

  const sections = [`${header}${table}`.trimEnd(), existing.trim()].filter(
    (s) => s.length > 0
  );
  const output = sections.join("\n\n") + "\n";

  await writeConfigFile(configPath, output, safetyStrategy);
}

/**
 * Validate the user-supplied `bedrock-base-url` so it cannot break out of the
 * TOML basic string we interpolate it into. We require an http(s) URL and
 * forbid any character that would terminate the string or inject a newline /
 * extra TOML key (`"`, `\`, CR, LF, or other control characters).
 *
 * Throwing here surfaces misconfiguration during the `Write Codex Bedrock
 * config` step rather than at `codex exec` time with a confusing parse error.
 */
export function validateBedrockBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("bedrock-base-url must not be empty when set.");
  }

  // Reject characters that would let the value escape the TOML basic string
  // we interpolate it into.
  // eslint-disable-next-line no-control-regex
  if (/["\\\u0000-\u001F\u007F]/.test(trimmed)) {
    throw new Error(
      `bedrock-base-url contains a disallowed character (quote, backslash, or control character): ${JSON.stringify(value)}`
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      `bedrock-base-url is not a valid URL: ${JSON.stringify(value)}`
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `bedrock-base-url must use http:// or https://, got: ${JSON.stringify(value)}`
    );
  }

  return trimmed;
}
