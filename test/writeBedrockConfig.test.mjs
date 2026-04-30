import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));

function makeCodexHome() {
  const dir = mkdtempSync(join(tmpdir(), "codex-home-"));
  return dir;
}

function runWriteBedrockConfig({ codexHome, baseUrl }) {
  const args = [
    mainPath,
    "write-bedrock-config",
    "--codex-home",
    codexHome,
    "--safety-strategy",
    "drop-sudo",
  ];
  if (baseUrl !== undefined) {
    args.push("--base-url", baseUrl);
  }
  return spawnSync(process.execPath, args, { encoding: "utf8" });
}

test("writes minimal config when no base-url is provided", (t) => {
  const home = makeCodexHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const result = runWriteBedrockConfig({ codexHome: home });
  assert.equal(result.status, 0, result.stderr);

  const out = readFileSync(join(home, "config.toml"), "utf8");
  assert.match(out, /model_provider = "amazon-bedrock"/);
  assert.doesNotMatch(out, /\[model_providers\.amazon-bedrock\]/);
});

test("writes provider table when a valid base-url is provided", (t) => {
  const home = makeCodexHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const url = "https://bedrock-runtime.us-west-2.amazonaws.com";
  const result = runWriteBedrockConfig({ codexHome: home, baseUrl: url });
  assert.equal(result.status, 0, result.stderr);

  const out = readFileSync(join(home, "config.toml"), "utf8");
  assert.match(out, /model_provider = "amazon-bedrock"/);
  assert.match(out, /\[model_providers\.amazon-bedrock\]/);
  assert.match(out, /name = "Amazon Bedrock"/);
  assert.match(out, new RegExp(`base_url = "${url}"`));
});

test("rejects base-url containing a quote (TOML injection)", (t) => {
  const home = makeCodexHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const result = runWriteBedrockConfig({
    codexHome: home,
    baseUrl: 'https://example.com"; evil = "x',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /disallowed character/);
});

test("rejects base-url with non-http(s) scheme", (t) => {
  const home = makeCodexHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const result = runWriteBedrockConfig({
    codexHome: home,
    baseUrl: "file:///etc/passwd",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must use http:\/\/ or https:\/\//);
});

test("rejects malformed base-url", (t) => {
  const home = makeCodexHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const result = runWriteBedrockConfig({
    codexHome: home,
    baseUrl: "not a url",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a valid URL|disallowed character/);
});

test("preserves user-managed content and strips prior codex-action blocks", (t) => {
  const home = makeCodexHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  // Simulate a prior write-proxy-config run plus user's own settings.
  const seed = `# Added by codex-action.
model_provider = "codex-action-responses-proxy"


# my own setting
hide_agent_reasoning = true

# Added by codex-action.
[model_providers.codex-action-responses-proxy]
name = "Codex Action Responses Proxy"
base_url = "http://127.0.0.1:9999/v1"
wire_api = "responses"
`;
  writeFileSync(join(home, "config.toml"), seed);

  const result = runWriteBedrockConfig({ codexHome: home });
  assert.equal(result.status, 0, result.stderr);

  const out = readFileSync(join(home, "config.toml"), "utf8");

  // Exactly one model_provider key.
  const matches = out.match(/^model_provider\s*=/gm) ?? [];
  assert.equal(matches.length, 1, `expected one model_provider key, got:\n${out}`);
  assert.match(out, /model_provider = "amazon-bedrock"/);

  // Prior proxy table is gone.
  assert.doesNotMatch(out, /\[model_providers\.codex-action-responses-proxy\]/);
  assert.doesNotMatch(out, /codex-action-responses-proxy/);

  // User content survived.
  assert.match(out, /hide_agent_reasoning = true/);
  assert.match(out, /# my own setting/);
});

test("re-running write-bedrock-config does not duplicate keys", (t) => {
  const home = makeCodexHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const url = "https://bedrock-runtime.us-east-1.amazonaws.com";
  for (let i = 0; i < 3; i++) {
    const result = runWriteBedrockConfig({ codexHome: home, baseUrl: url });
    assert.equal(result.status, 0, result.stderr);
  }

  const out = readFileSync(join(home, "config.toml"), "utf8");
  const providerKeys = out.match(/^model_provider\s*=/gm) ?? [];
  const tables = out.match(/^\[model_providers\.amazon-bedrock\]/gm) ?? [];
  assert.equal(providerKeys.length, 1, `duplicated model_provider:\n${out}`);
  assert.equal(tables.length, 1, `duplicated provider table:\n${out}`);
});
