import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { SafetyStrategy } from "./runCodexExec";
import { checkOutput } from "./checkOutput";

// Marker comment placed on every line that codex-action manages in
// `config.toml`. We use this to find and strip our own previous output before
// rewriting, so that re-running the action (or switching between proxy and
// Bedrock modes) does not produce duplicate `model_provider` keys or stale
// `[model_providers.<id>]` tables that violate TOML's no-duplicate-keys rule.
export const MANAGED_MARKER = "# Added by codex-action.";

export type ManagedTable = {
  // The fully-qualified TOML table header to strip on rewrite, e.g.
  // `[model_providers.amazon-bedrock]`. The whole block (header + every key
  // line until a blank line or the next `[...]` header) is removed.
  header: string;
};

/**
 * Read the existing `config.toml` (if any) and remove any blocks previously
 * written by codex-action so the caller can prepend a fresh managed section
 * without leaving stale duplicates behind.
 *
 * - `ENOENT` is treated as "no file"; any other read error is rethrown so that
 *   permission problems aren't silently masked by overwriting the file.
 */
export async function readAndStripManagedContent(
  configPath: string,
  managedTables: ReadonlyArray<ManagedTable>
): Promise<string> {
  let existing: string;
  try {
    existing = await fs.readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw err;
  }

  return stripManagedContent(existing, managedTables);
}

export function stripManagedContent(
  contents: string,
  managedTables: ReadonlyArray<ManagedTable>
): string {
  const tableHeaders = new Set(managedTables.map((t) => t.header));
  const lines = contents.split("\n");
  const out: Array<string> = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Drop any single line we marked as managed (e.g. the
    // `model_provider = "..."` line at the top of the file along with its
    // preceding `# Added by codex-action.` comment).
    if (trimmed === MANAGED_MARKER) {
      // Skip this comment.
      i++;
      // Also skip the immediately following non-blank line, which is the
      // value (or `[table]` header) the comment annotates.
      if (i < lines.length) {
        const next = lines[i].trim();
        if (next.length > 0 && !next.startsWith("#")) {
          // If it's one of our managed `[table]` headers, drop the whole
          // table body too.
          if (tableHeaders.has(next)) {
            i = skipTableBody(lines, i + 1);
          } else {
            i++;
          }
        }
      }
      continue;
    }

    // Defensive: also drop any unmarked managed table headers (e.g. if a
    // previous version of codex-action wrote them without the marker).
    if (tableHeaders.has(trimmed)) {
      i = skipTableBody(lines, i + 1);
      continue;
    }

    out.push(line);
    i++;
  }

  // Collapse 3+ consecutive blank lines (left behind by stripping) down to
  // a single blank line, and trim leading/trailing blank lines.
  return collapseBlankLines(out.join("\n"));
}

function skipTableBody(lines: ReadonlyArray<string>, start: number): number {
  let i = start;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t.startsWith("[")) {
      return i;
    }
    i++;
  }
  return i;
}

function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");
}

/**
 * Write `contents` to `configPath`, using sudo when the codex home directory
 * is owned by another user (the `unprivileged-user` safety strategy).
 */
export async function writeConfigFile(
  configPath: string,
  contents: string,
  safetyStrategy: SafetyStrategy
): Promise<void> {
  if (safetyStrategy === "unprivileged-user") {
    // CODEX_HOME is owned by another user; stage the file in our own tmpdir
    // and move it into place with sudo.
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-config"));
    try {
      const tempConfigPath = path.join(tempDir, "config.toml");
      await fs.writeFile(tempConfigPath, contents, "utf8");
      await checkOutput(["sudo", "mv", tempConfigPath, configPath]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  } else {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, contents, "utf8");
  }
}
