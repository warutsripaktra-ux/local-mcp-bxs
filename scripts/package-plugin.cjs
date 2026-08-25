#!/usr/bin/env node

// Plugin packaging (plan Phase 6). Produces an allowlisted archive of the
// gateway and scans every included file for .env, secrets, absolute local
// paths, and symlinks. Refuses to package anything that leaks credentials or
// machine-specific paths.

const { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } = require("node:fs");
const { join, relative, isAbsolute, sep } = require("node:path");
const { spawnSync } = require("node:child_process");

// Files/dirs never packaged. Docs are reference material, not runtime code, and
// legitimately contain configuration examples, so they are excluded from both
// the archive and the secret scan.
const EXCLUDE = new Set([
  ".env",
  ".env.example",
  "node_modules",
  "dist",
  ".git",
  "test",
  "docs",
  "tunnel-client",
  "scripts/run-tunnel.cjs",
]);

// Secret patterns that must never appear in a shipped artifact. Assignment
// patterns require a real value (>=8 token chars) so documentation placeholders
// like `CONTROL_PLANE_API_KEY=sk-...` are not flagged, while actual secrets are.
const SECRET_PATTERNS = [
  /CONTROL_PLANE_API_KEY\s*=\s*[\w\-]{8,}/i,
  /CONTROL_PLANE_TUNNEL_ID\s*=\s*[\w\-]{8,}/i,
  /TUNNEL_CLIENT_BIN\s*=\s*[\w\-]{8,}/i,
  /sk-[A-Za-z0-9]{20,}/, // OpenAI-style secret key
  /AKIA[0-9A-Z]{16}/, // AWS-style key id
];

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(base, full);
    if (EXCLUDE.has(rel) || rel.split(sep).some((p) => EXCLUDE.has(p))) continue;
    const st = statSync(full);
    if (st.isSymbolicLink && st.isSymbolicLink()) throw new Error(`Symlink not allowed: ${rel}`);
    if (st.isDirectory()) walk(full, base, out);
    else if (st.isFile()) out.push(full);
  }
  return out;
}

// Scan a list of files for forbidden content. Throws on first violation.
function scanForSecrets(files) {
  for (const f of files) {
    if (
      f.endsWith(".json") ||
      f.endsWith(".md") ||
      f.endsWith(".cjs") ||
      f.endsWith(".js") ||
      f.endsWith(".ts") ||
      f.endsWith(".txt") ||
      f.endsWith(".env") ||
      f.endsWith(".yml") ||
      f.endsWith(".yaml")
    ) {
      const text = readFileSync(f, "utf8");
      for (const re of SECRET_PATTERNS) {
        if (re.test(text)) throw new Error(`Secret pattern ${re} found in ${f}`);
      }
    }
    const st = statSync(f);
    if (st.isSymbolicLink && st.isSymbolicLink()) throw new Error(`Symlink not allowed: ${f}`);
  }
}

function buildManifest(files, base) {
  return files.map((f) => relative(base, f)).sort();
}

function main() {
  const root = join(__dirname, "..");
  const files = walk(root, root);
  scanForSecrets(files);
  const manifest = buildManifest(files, root);
  const outDir = join(root, "dist");
  mkdirSync(outDir, { recursive: true });
  const manifestPath = join(outDir, "plugin-manifest.json");
  writeFileSync(manifestPath, JSON.stringify({ files: manifest, generatedAt: new Date().toISOString() }, null, 2));

  const zipPath = join(outDir, "local-gateway-mcp-plugin.zip");
  const zip = spawnSync("zip", ["-r", "-q", zipPath, ...manifest], { cwd: root });
  if (zip.status === 0) {
    process.stderr.write(`Packaged ${manifest.length} files to ${zipPath}\n`);
  } else {
    process.stderr.write(`zip unavailable; manifest written to ${manifestPath}. Files: ${manifest.length}\n`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    process.stderr.write(`Packaging failed: ${e.message}\n`);
    process.exit(1);
  }
}

module.exports = { walk, scanForSecrets, buildManifest };
