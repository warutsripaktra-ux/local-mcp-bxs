// Phase 1 acceptance: a read-only tool call reaches the Router over HTTP, and
// discovery/health work without any online agent.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { buildRouterDeps } = require("../dist/router-entry.js");
const { createRouterHttpServer } = require("../dist/routing/http-server.js");
const { LocalProjectAgent } = require("../dist/routing/agent-channel.js");
const { PolicyEngine } = require("../dist/routing/policy.js");
const { denyByDefaultPolicy } = require("../dist/routing/index.js");

const ISSUER = "https://idp.example.com";
const AUDIENCE = "local-gateway-mcp";
const ROOT = process.platform === "win32" ? "C:\\proj-a" : "/tmp/proj-a";

function makeVerifier() {
  return {
    async verify(token) {
      return {
        issuer: ISSUER,
        sub: token === "tokenA" ? "user-a" : "user-b",
        audience: AUDIENCE,
        scope: ["project:read", "project:write", "project:process"],
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
    },
  };
}

function policyFor(roots, scopes) {
  const p = denyByDefaultPolicy();
  p.roots = roots;
  for (const s of scopes) {
    if (s === "project:read") p.allowRead = true;
    if (s === "project:write") p.allowWrite = true;
    if (s === "project:process") p.allowProcess = true;
  }
  p.allowedCommands = ["git", "ls"];
  return p;
}

function rpc(req, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request({ ...req, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        r.destroy();
        resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      });
    });
    r.on("error", reject);
    r.setHeader("Connection", "close");
    for (const [k, v] of Object.entries(headers)) r.setHeader(k, v);
    r.end(data);
  });
}

// Close the listening socket and forcibly drop any lingering keep-alive
// connections so the test process can exit.
function closeServer(server) {
  return new Promise((resolve) => {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    server.close(() => resolve());
  });
}

test("health and ready endpoints respond without an agent", async () => {
  const deps = buildRouterDeps({ verifier: makeVerifier(), expectedIssuer: ISSUER, expectedAudience: AUDIENCE });
  const { server } = createRouterHttpServer(deps);
  await new Promise((res) => server.listen(0, res));
  const port = server.address().port;
  const h = await rpc({ host: "127.0.0.1", port, path: "/healthz", method: "GET" }, "");
  assert.equal(h.status, 200);
  const rd = await rpc({ host: "127.0.0.1", port, path: "/readyz", method: "GET" }, "");
  assert.equal(rd.status, 200);
  await closeServer(server);
});

test("initialize and tools/list served centrally (discovery independent of agent)", async () => {
  const deps = buildRouterDeps({ verifier: makeVerifier(), expectedIssuer: ISSUER, expectedAudience: AUDIENCE });
  const { server } = createRouterHttpServer(deps);
  await new Promise((res) => server.listen(0, res));
  const port = server.address().port;

  const init = await rpc({ host: "127.0.0.1", port, path: "/mcp", method: "POST" }, { jsonrpc: "2.0", id: 1, method: "initialize" });
  assert.equal(init.body.result.serverInfo.name, "local-gateway-mcp-router");

  const list = await rpc({ host: "127.0.0.1", port, path: "/mcp", method: "POST" }, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = list.body.result.tools.map((t) => t.name);
  assert.ok(names.includes("read_file"));
  assert.ok(names.includes("write_file"));
  const readFile = list.body.result.tools.find((t) => t.name === "read_file");
  assert.deepEqual(readFile.inputSchema.properties.path, { type: "string" });
  assert.deepEqual(readFile.inputSchema.required, ["path"]);
  assert.deepEqual(readFile.inputSchema.properties.offset.type, "number");
  assert.deepEqual(readFile.inputSchema.properties.isUrl.type, "boolean");
  const startProcess = list.body.result.tools.find((t) => t.name === "start_process");
  assert.deepEqual(startProcess.inputSchema.properties.command.type, "string");
  assert.deepEqual(startProcess.inputSchema.properties.timeout_ms.type, "number");
  assert.deepEqual(startProcess.inputSchema.required, ["command", "timeout_ms"]);
  assert.match(startProcess.description, /open.*osascript.*screencapture/s);

  // unknown method denied at HTTP layer
  const bad = await rpc({ host: "127.0.0.1", port, path: "/mcp", method: "POST" }, { jsonrpc: "2.0", id: 3, method: "frobnicate" });
  assert.equal(bad.body.error.code, -32601);

  await closeServer(server);
});

test("read-only call reaches router through HTTP and is routed to the agent", async () => {
  const deps = buildRouterDeps({ verifier: makeVerifier(), expectedIssuer: ISSUER, expectedAudience: AUDIENCE });
  const { server } = createRouterHttpServer(deps);
  await new Promise((res) => server.listen(0, res));
  const port = server.address().port;

  deps.registry.register(
    { agentId: "agent-a", user: { issuer: ISSUER, sub: "user-a" }, projectLabel: "A", capabilities: ["project:read"], roots: [ROOT] },
    { issuer: ISSUER, sub: "user-a" },
  );
  deps.channel.registerAgent(
    new LocalProjectAgent(
      deps.registry.get("agent-a"),
      new PolicyEngine(policyFor([ROOT], ["project:read"])),
      (request) => Promise.resolve({ correlationId: request.correlationId, result: { ok: true, tool: request.tool } }),
    ),
  );

  const call = await rpc(
    { host: "127.0.0.1", port, path: "/mcp", method: "POST" },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "read_file", arguments: { path: `${ROOT}/x.txt` } } },
    { authorization: "Bearer tokenA" },
  );
  assert.equal(call.status, 200);
  assert.equal(call.body.result.ok, true);

  // unauthenticated call is rejected
  const noauth = await rpc(
    { host: "127.0.0.1", port, path: "/mcp", method: "POST" },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "read_file", arguments: { path: `${ROOT}/x.txt` } } },
  );
  assert.equal(noauth.body.error.data.code, "unauthenticated");

  await closeServer(server);
});
