#!/usr/bin/env node

const { existsSync, readFileSync } = require('node:fs');
const { delimiter, join } = require('node:path');
const { spawnSync } = require('node:child_process');

const root = join(__dirname, '..');
const profile = process.env.TUNNEL_PROFILE || 'futuremakers-gateway';
const routerEntrypoint = join(root, 'scripts', 'run-router.cjs');

function loadDotEnv() {
  const envPath = join(root, '.env');
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^#\s]*))\s*(?:#.*)?$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
    }
  }
}

function findTunnelClient() {
  if (process.env.TUNNEL_CLIENT_BIN) return process.env.TUNNEL_CLIENT_BIN;
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    for (const name of process.platform === 'win32' ? ['tunnel-client.exe', 'tunnel-client'] : ['tunnel-client']) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error('tunnel-client was not found. Set TUNNEL_CLIENT_BIN to its full path.');
}

function run(tunnelClient, args) {
  const result = spawnSync(tunnelClient, args, { cwd: root, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

try {
  loadDotEnv();
  if (!process.env.CONTROL_PLANE_TUNNEL_ID || !process.env.CONTROL_PLANE_API_KEY) {
    throw new Error('Set CONTROL_PLANE_TUNNEL_ID and CONTROL_PLANE_API_KEY in .env. See .env.example.');
  }
  if (!existsSync(join(root, 'dist', 'router-entry.js'))) throw new Error('Missing router build. Run pnpm run build first.');

  const tunnelClient = findTunnelClient();
  const router = require('node:child_process').spawn(process.execPath, [routerEntrypoint], {
    cwd: root, env: process.env, stdio: 'inherit',
  });
  const stopRouter = () => { if (!router.killed) router.kill('SIGTERM'); };
  process.on('SIGINT', stopRouter);
  process.on('SIGTERM', stopRouter);
  run(tunnelClient, [
    'init',
    '--force',
    '--profile', profile,
    '--tunnel-id', process.env.CONTROL_PLANE_TUNNEL_ID,
    '--mcp-server-url', `http://127.0.0.1:${process.env.ROUTER_MCP_PORT || 8787}/mcp`,
  ]);
  run(tunnelClient, ['doctor', '--profile', profile, '--explain']);
  run(tunnelClient, ['run', '--profile', profile]);
} catch (error) {
  process.stderr.write(`Tunnel setup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
