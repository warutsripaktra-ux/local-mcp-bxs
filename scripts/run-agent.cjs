#!/usr/bin/env node

// One-command user agent bootstrap. First run performs OAuth PKCE login,
// provisions a device credential, stores it in the OS keychain (or a 0600
// fallback file), and starts the local agent. Later runs need no .env secrets.
const { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } = require("node:fs");
const { createHash, randomBytes } = require("node:crypto");
const { createServer } = require("node:http");
const { join } = require("node:path");
const { homedir, platform, hostname } = require("node:os");
const { spawn, spawnSync } = require("node:child_process");

const root = join(__dirname, "..");
const SERVICE = "futuremakers-gateway-agent";
const OAUTH_CALLBACK_HOST = "127.0.0.1";
const OAUTH_CALLBACK_PORT = Number(process.env.OAUTH_CALLBACK_PORT || 8765);
// Distribution builds should replace this with the organization's Router URL.
const DEFAULT_ROUTER_URL = process.env.FUTUREMAKERS_ROUTER_URL || "https://router.example.com";

function loadDotEnv() {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^#\s]*))\s*(?:#.*)?$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2] ?? m[3] ?? m[4] ?? "";
  }
}
function csv(value, fallback) { return value ? value.split(",").map((s) => s.trim()).filter(Boolean) : fallback; }
function bool(value, fallback) { return value === undefined ? fallback : value === "1" || value.toLowerCase() === "true"; }
function statePath() {
  return platform() === "darwin"
    ? join(homedir(), "Library", "Application Support", "Futuremakers Gateway", "agent.json")
    : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "futuremakers-gateway", "agent.json");
}
function account() { return process.env.USER || "futuremakers"; }
function keychainGet() {
  if (platform() === "darwin") { const r = spawnSync("security", ["find-generic-password", "-a", account(), "-s", SERVICE, "-w"], { encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : null; }
  if (platform() === "linux") { const r = spawnSync("secret-tool", ["lookup", "service", SERVICE, "account", account()], { encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : null; }
  return null;
}
function keychainPut(value) {
  if (platform() === "darwin") return spawnSync("security", ["add-generic-password", "-a", account(), "-s", SERVICE, "-w", value, "-U"], { stdio: "ignore" }).status === 0;
  if (platform() === "linux") return spawnSync("secret-tool", ["store", "--label", SERVICE, "service", SERVICE, "account", account()], { input: value, stdio: ["pipe", "ignore", "ignore"] }).status === 0;
  return false;
}
function readState() {
  try { return JSON.parse(keychainGet() || readFileSync(statePath(), "utf8")); } catch { return null; }
}
function writeState(value) {
  const encoded = JSON.stringify(value);
  if (keychainPut(encoded)) return;
  const path = statePath();
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, encoded, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}
function loadPolicy() {
  const roots = csv(process.env.PROJECT_ROOTS, platform() === "win32" ? [] : ["/"]);
  const policy = {
    roots,
    allowRead: bool(process.env.ALLOW_READ, true),
    allowWrite: bool(process.env.ALLOW_WRITE, true),
    allowProcess: bool(process.env.ALLOW_PROCESS, true),
    allowedCommands: csv(process.env.ALLOWED_COMMANDS, ["*"]),
    requireConfirmationFor: csv(process.env.REQUIRE_CONFIRMATION_FOR, ["project:write", "project:process"]),
  };
  if ((policy.allowRead || policy.allowWrite) && policy.roots.length === 0) throw new Error("A project root is required when file access is enabled.");
  if (policy.allowProcess && policy.allowedCommands.length === 0) throw new Error("An allowed command list is required when process access is enabled.");
  return policy;
}
function b64(value) { return Buffer.from(value).toString("base64url"); }
function challenge(value) { return createHash("sha256").update(value).digest("base64url"); }
async function openBrowser(url) {
  const command = platform() === "darwin" ? "open" : platform() === "win32" ? "cmd" : "xdg-open";
  const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" }); child.unref();
}
async function oauthLogin(config) {
  if (!config.authorizationEndpoint || !config.tokenEndpoint) {
    const discoveryUrl = `${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
    const discovery = await fetch(discoveryUrl);
    if (!discovery.ok) throw new Error(`OIDC discovery failed: ${discovery.status}`);
    const metadata = await discovery.json();
    if (metadata.issuer !== config.issuer) throw new Error("OIDC discovery issuer mismatch");
    config = { ...config, authorizationEndpoint: metadata.authorization_endpoint, tokenEndpoint: metadata.token_endpoint };
  }
  if (typeof config.authorizationEndpoint !== "string" || typeof config.tokenEndpoint !== "string") throw new Error("OIDC provider does not expose authorization/token endpoints");
  const verifier = b64(randomBytes(32));
  const state = b64(randomBytes(24));
  const callback = createServer();
  const code = await new Promise((resolve, reject) => {
    callback.on("request", (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/callback") { res.writeHead(404); res.end(); return; }
      if (url.searchParams.get("state") !== state) { res.writeHead(400); res.end("Invalid state"); reject(new Error("OAuth state mismatch")); return; }
      res.writeHead(200, { "content-type": "text/plain" }); res.end("Login complete. You may close this window."); resolve(url.searchParams.get("code"));
    });
    callback.on("error", reject);
    callback.listen(OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_HOST, async () => {
      const redirect = `http://${OAUTH_CALLBACK_HOST}:${OAUTH_CALLBACK_PORT}/callback`;
      const url = new URL(config.authorizationEndpoint);
      // Auth0 uses `audience` for the API access token. The MCP `resource`
      // parameter is needed by the ChatGPT-facing OAuth flow, but sending it
      // to Auth0 here can make the authorization request invalid.
      for (const [key, value] of Object.entries({ response_type: "code", client_id: config.clientId, redirect_uri: redirect, scope: "openid profile", state, code_challenge: challenge(verifier), code_challenge_method: "S256", audience: config.audience || config.resource })) url.searchParams.set(key, value);
      process.stderr.write(`Opening browser for company login: ${url.origin}\n`);
      try { await openBrowser(url.toString()); } catch { process.stderr.write(`Open this URL manually:\n${url}\n`); }
    });
  });
  callback.close();
  if (!code) throw new Error("OAuth login did not return an authorization code");
  const redirect = `http://${OAUTH_CALLBACK_HOST}:${OAUTH_CALLBACK_PORT}/callback`;
  const response = await fetch(config.tokenEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: config.clientId, code, redirect_uri: redirect, code_verifier: verifier }) });
  if (!response.ok) throw new Error(`OAuth token exchange failed: ${response.status}`);
  const tokens = await response.json();
  if (typeof tokens.access_token !== "string") throw new Error("OAuth response did not include access_token");
  return tokens.access_token;
}
async function bootstrap(routerUrl, token, policy, agentId) {
  const response = await fetch(`${routerUrl}/agent/v1/bootstrap`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ agentId, roots: policy.roots, capabilities: ["project:read", "project:write", "project:process"] }) });
  if (!response.ok) throw new Error(`Agent provisioning failed: ${response.status} ${await response.text()}`);
  return response.json();
}
async function rotateStoredCredential(credentials) {
  const response = await fetch(`${credentials.routerUrl}/agent/v1/rotate`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credentials.credentialId}.${credentials.secret}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  if (response.ok) {
    const rotated = await response.json();
    return { ...credentials, credentialId: rotated.credentialId, secret: rotated.secret };
  }
  if (response.status === 401) return null;
  throw new Error(`Device credential rotation failed: ${response.status} ${await response.text()}`);
}
async function main() {
  loadDotEnv();
  const policy = loadPolicy();
  const current = readState();
  const routerUrl = (current?.routerUrl || process.env.ROUTER_AGENT_URL || DEFAULT_ROUTER_URL).replace(/\/$/, "");
  const agentId = current?.agentId || `${platform()}-${hostname()}`;
  let credentials = current;
  if (credentials?.credentialId && credentials?.secret) {
    credentials = await rotateStoredCredential(credentials);
    if (credentials) {
      writeState(credentials);
      process.stderr.write("Device credential rotated.\n");
    } else {
      process.stderr.write("Stored device credential expired; login is required again.\n");
    }
  }
  if (!credentials?.credentialId || !credentials?.secret) {
    const configResponse = await fetch(`${routerUrl}/agent/v1/bootstrap-config`);
    if (!configResponse.ok) throw new Error(`Cannot load agent login configuration from ${routerUrl}: ${configResponse.status}`);
    const config = await configResponse.json();
    const provisioned = await bootstrap(routerUrl, await oauthLogin(config), policy, agentId);
    credentials = { routerUrl, agentId, credentialId: provisioned.credentialId, secret: provisioned.secret, user: provisioned.user };
    writeState(credentials);
    process.stderr.write("Agent registered. Credential stored securely.\n");
  }
  process.env.PROJECT_ROOTS = policy.roots.join(","); process.env.ALLOW_READ = String(policy.allowRead); process.env.ALLOW_WRITE = String(policy.allowWrite); process.env.ALLOW_PROCESS = String(policy.allowProcess); process.env.ALLOWED_COMMANDS = policy.allowedCommands.join(","); process.env.REQUIRE_CONFIRMATION_FOR = policy.requireConfirmationFor.join(",");
  const { AgentController } = require(join(root, "dist", "routing", "agent-controller.js"));
  const controller = new AgentController({ baseUrl: credentials.routerUrl, credentialId: credentials.credentialId, secret: credentials.secret, user: credentials.user, agentId: credentials.agentId, roots: policy.roots, capabilities: ["project:read", "project:write", "project:process"] });
  await controller.start(); process.stderr.write(`Agent running as ${credentials.agentId}.\n`);
  process.on("SIGINT", () => { controller.stop(); process.exit(0); }); process.on("SIGTERM", () => { controller.stop(); process.exit(0); });
}
main().catch((error) => { process.stderr.write(`Agent failed to start: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
