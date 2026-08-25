const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const home = mkdtempSync(join(tmpdir(), 'futuremakers-tunnel-'));
const bin = join(home, 'tunnel-client');
const calls = join(home, 'calls');

try {
  writeFileSync(bin, `#!/bin/sh
printf '%s\\n' "$*" >> "${calls}"
if [ "$1" = init ]; then mkdir -p "$HOME/.config/tunnel-client"; touch "$HOME/.config/tunnel-client/futuremakers-gateway.yaml"; fi
`);
  require('node:fs').chmodSync(bin, 0o755);
  assert.ok(existsSync(join(process.cwd(), 'dist', 'index.js')), 'Build the MCP before running this test');
  const result = spawnSync(process.execPath, ['scripts/run-tunnel.cjs'], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, TUNNEL_CLIENT_BIN: bin, CONTROL_PLANE_TUNNEL_ID: 'tunnel_test', CONTROL_PLANE_API_KEY: 'key_test' },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const invocation = readFileSync(calls, 'utf8');
  assert.match(invocation, /init --force --profile futuremakers-gateway --tunnel-id tunnel_test --mcp-server-url http:\/\/127\.0\.0\.1:8787\/mcp/);
  assert.match(invocation, /doctor --profile futuremakers-gateway --explain/);
  assert.match(invocation, /run --profile futuremakers-gateway/);
} finally {
  rmSync(home, { recursive: true, force: true });
}
