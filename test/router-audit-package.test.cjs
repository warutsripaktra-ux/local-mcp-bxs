// Phase 6 acceptance: audit persists metadata only (no secrets), and the
// plugin packaging scan rejects files that leak secrets.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync, existsSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createFileAuditSink, setAuditSink } = require("../dist/routing/audit-store.js");
const { scanForSecrets, walk } = require("../scripts/package-plugin.cjs");

const ISSUER = "https://idp.example.com";
const AUD = "local-gateway-mcp";

test("audit writes identity/action metadata without leaking the bearer token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-"));
  const path = join(dir, "audit.jsonl");
  setAuditSink(createFileAuditSink(path));
  const { audit } = require("../dist/routing/audit.js");
  audit({ correlationId: "c1", user: `${ISSUER}|user-a`, agent: "agent-a", tool: "read_file", action: "deny", result: "denied", errorCode: "policy_denied" });

  const text = readFileSync(path, "utf8");
  assert.match(text, /policy_denied/);
  assert.match(text, /user-a/);
  assert.ok(!text.includes("Bearer"), "audit must not contain bearer tokens");
  assert.ok(!text.includes("sk-"), "audit must not contain secrets");
  setAuditSink(null); // restore default
});

test("package scan rejects files containing a control-plane secret", () => {
  const dir = mkdtempSync(join(tmpdir(), "pkg-"));
  const bad = join(dir, "leak.txt");
  writeFileSync(bad, "CONTROL_PLANE_API_KEY=super-secret-value\n");
  assert.throws(() => scanForSecrets([bad]), /Secret pattern/);
});

test("package scan accepts clean files", () => {
  const dir = mkdtempSync(join(tmpdir(), "pkg-"));
  const ok = join(dir, "readme.md");
  writeFileSync(ok, "# Local Gateway\nSafe documentation.\n");
  assert.doesNotThrow(() => scanForSecrets([ok]));
});

test("walk excludes node_modules and .env", () => {
  const root = mkdtempSync(join(tmpdir(), "walk-"));
  writeFileSync(join(root, "keep.md"), "ok");
  writeFileSync(join(root, ".env"), "CONTROL_PLANE_API_KEY=x");
  require("node:fs").mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(join(root, "node_modules", "x.js"), "CONTROL_PLANE_API_KEY=leak");
  const files = walk(root, root);
  const rels = files.map((f) => require("node:path").relative(root, f));
  assert.ok(!rels.includes(".env"), ".env must be excluded");
  assert.ok(!rels.some((r) => r.startsWith("node_modules" + require("node:path").sep)), "node_modules excluded");
  assert.ok(rels.includes("keep.md"));
});

setTimeout(() => process.exit(0), 500).unref();
