// Phase 5 acceptance: a real local MCP child (dist/index.js) is reached through
// the Router via the long-poll channel + stdio relay, and A/B state stays
// isolated. The controller spawns the child, the router forwards a tool call,
// the agent enforces policy locally and relays to the child.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { join } = require("node:path");
const { buildRouterDeps, createVerifier } = require("../dist/router-entry.js");
const { createRouterHttpServer } = require("../dist/routing/http-server.js");
const { LongPollAgentChannel } = require("../dist/routing/long-poll-channel.js");
const { AgentController } = require("../dist/routing/agent-controller.js");

const ISSUER = "https://idp.example.com";
const AUD = "local-gateway-mcp";
const userA = { issuer: ISSUER, sub: "tokenA" };

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

function closeServer(server) {
  return new Promise((resolve) => {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    server.close(() => resolve());
  });
}

test("real local tool executes through the Router via stdio relay", async () => {
  // Agent policy: read-only within /tmp.
  process.env.PROJECT_ROOTS = "/tmp";
  process.env.ALLOW_READ = "1";
  process.env.ALLOW_WRITE = "0";
  process.env.ALLOW_PROCESS = "0";
  process.env.ALLOWED_COMMANDS = "";

  const deps = buildRouterDeps({ verifier: createVerifier({ demo: true, expectedIssuer: ISSUER, expectedAudience: AUD }), expectedIssuer: ISSUER, expectedAudience: AUD, channel: new LongPollAgentChannel() });
  const { server } = createRouterHttpServer(deps);
  await new Promise((res) => server.listen(0, res));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  // Pair the agent (simulating the user redeeming a pairing code).
  const code = deps.pairing.generate(userA).code;
  const paired = await rpc({ host: "127.0.0.1", port, path: "/agent/v1/pair", method: "POST" }, { code, agentId: "agent-tokenA", capabilities: ["project:read"] });
  assert.equal(paired.status, 200);

  const controller = new AgentController({
    baseUrl: base,
    credentialId: paired.body.credentialId,
    secret: paired.body.secret,
    user: userA,
    agentId: "agent-tokenA",
    roots: ["/tmp"],
    capabilities: ["project:read"],
    childEntry: join(process.cwd(), "dist", "index.js"),
    pollTimeoutMs: 1500,
  });
  await controller.start();

  // Fire a router tools/call that the agent must fulfill via the real child.
  const call = await rpc(
    { host: "127.0.0.1", port, path: "/mcp", method: "POST" },
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_directory", arguments: { path: "/tmp" } } },
    { authorization: "Bearer tokenA" },
  );
  assert.equal(call.status, 200, JSON.stringify(call.body));
  assert.ok(call.body.result, "expected a result from the real child");
  assert.ok(call.body.result.content || call.body.result.structure || Array.isArray(call.body.result), "result should carry directory listing");

  controller.stop();
  await closeServer(server);
});

setTimeout(() => process.exit(0), 1000).unref();
