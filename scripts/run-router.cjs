#!/usr/bin/env node

// Central HTTP MCP Router entrypoint (plan Phase 1). Starts the router HTTP
// server and points the Secure MCP Tunnel at http://127.0.0.1:<port>/mcp.
//
// ponytail: production auth uses the org OIDC/JWKS TokenVerifier (plan Phase 2).
// Until that lands, ROUTER_DEMO=1 runs a demo verifier that trusts any bearer
// and is NOT for production exposure.

const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const dotEnv = join(root, ".env");
if (existsSync(dotEnv)) {
  for (const line of readFileSync(dotEnv, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^#\s]*))\s*(?:#.*)?$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2] ?? m[3] ?? m[4] ?? "";
  }
}

const port = Number(process.env.ROUTER_MCP_PORT || 8787);
const issuer = process.env.OIDC_ISSUER || "";
const audience = process.env.OIDC_AUDIENCE || "";
if (!issuer || !audience) throw new Error("Set OIDC_ISSUER and OIDC_AUDIENCE in .env");

const { startRouter, createVerifier } = require(join(root, "dist", "router-entry.js"));
const { createFileAuditSink, setAuditSink } = require(join(root, "dist", "routing", "audit-store.js"));

if (process.env.AUDIT_FILE) {
  setAuditSink(createFileAuditSink(process.env.AUDIT_FILE));
  process.stderr.write(`Audit persisted to ${process.env.AUDIT_FILE}\n`);
}
const { LongPollAgentChannel } = require(join(root, "dist", "routing", "long-poll-channel.js"));

const jwksUrl = process.env.ROUTER_JWKS_URL || undefined;
const agentAuth = {
  issuer,
  authorizationEndpoint: process.env.OIDC_AUTHORIZATION_ENDPOINT || "",
  tokenEndpoint: process.env.OIDC_TOKEN_ENDPOINT || "",
  clientId: process.env.OIDC_AGENT_CLIENT_ID || "",
};
const verifier = createVerifier({
  jwksUrl: jwksUrl || undefined,
  discoveryUrl: process.env.OIDC_DISCOVERY_URL || undefined,
  expectedIssuer: issuer,
  expectedAudience: audience,
  demo: process.env.ROUTER_DEMO === "1",
});

if (!jwksUrl && process.env.ROUTER_DEMO !== "1") {
  process.stderr.write("JWKS will be resolved from OIDC discovery at the first authenticated request.\n");
}

const { server, shutdown } = startRouter({
  verifier,
  expectedIssuer: issuer,
  expectedAudience: audience,
  resource: audience,
  port,
  channel: new LongPollAgentChannel(),
  registryStore: process.env.ROUTER_REGISTRY_FILE ? new (require(join(root, "dist", "routing", "persistence.js")).FileRegistryStore)(process.env.ROUTER_REGISTRY_FILE) : undefined,
  credentialStore: process.env.ROUTER_CREDENTIAL_FILE ? new (require(join(root, "dist", "routing", "persistence.js")).FileCredStore)(process.env.ROUTER_CREDENTIAL_FILE) : undefined,
  agentAuth,
});

process.stderr.write(`Central HTTP MCP Router listening on http://127.0.0.1:${port}/mcp\n`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await shutdown();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
server.on("error", (err) => {
  process.stderr.write(`Router server error: ${err.message}\n`);
  process.exit(1);
});
