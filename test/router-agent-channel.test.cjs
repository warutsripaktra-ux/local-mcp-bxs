// Phase 4 acceptance: two agents (A/B) route concurrently through the long-poll
// channel, disconnect/delay/duplicate/restart scenarios. Uses a demo verifier
// so bearer "tokenA"/"tokenB" map to sub user-a/user-b.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { buildRouterDeps, createVerifier } = require("../dist/router-entry.js");
const { createRouterHttpServer } = require("../dist/routing/http-server.js");
const { LongPollAgentChannel } = require("../dist/routing/long-poll-channel.js");

const ISSUER = "https://idp.example.com";
const AUD = "local-gateway-mcp";
const userA = { issuer: ISSUER, sub: "tokenA" };
const userB = { issuer: ISSUER, sub: "tokenB" };

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

function mkServer() {
  const deps = buildRouterDeps({ verifier: createVerifier({ demo: true, expectedIssuer: ISSUER, expectedAudience: AUD }), expectedIssuer: ISSUER, expectedAudience: AUD, channel: new LongPollAgentChannel() });
  const { server } = createRouterHttpServer(deps);
  return { deps, server };
}

async function pair(server, port, user) {
  const code = server.__deps.pairing.generate(user).code;
  const res = await rpc({ host: "127.0.0.1", port, path: "/agent/v1/pair", method: "POST" }, { code, agentId: `agent-${user.sub}`, capabilities: ["project:read", "project:write"] });
  assert.equal(res.status, 200);
  return res.body; // { credentialId, secret, version }
}

async function poll(server, port, cred) {
  return rpc({ host: "127.0.0.1", port, path: "/agent/v1/poll", method: "POST" }, { timeoutMs: 5000 }, { authorization: `Bearer ${cred.credentialId}.${cred.secret}` });
}

async function respond(server, port, cred, correlationId, sequence, result) {
  return rpc({ host: "127.0.0.1", port, path: "/agent/v1/respond", method: "POST" }, { correlationId, sequence, result }, { authorization: `Bearer ${cred.credentialId}.${cred.secret}` });
}

test("agent pairs, polls, and fulfills a router tool call", { timeout: 2000 }, async () => {
  const { deps, server } = mkServer();
  server.__deps = deps;
  await new Promise((res) => server.listen(0, res));
  const port = server.address().port;
  const cred = await pair(server, port, userA);

  // Fire a router tools/call; it enqueues on the channel and waits for poll/respond.
  const callPromise = rpc(
    { host: "127.0.0.1", port, path: "/mcp", method: "POST" },
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file", arguments: { path: "/x/y.txt" } } },
    { authorization: "Bearer tokenA" },
  );

  // Agent polls, gets the pending request, and responds.
  const polled = await poll(server, port, cred);
  assert.equal(polled.status, 200);
  assert.ok(polled.body.request, "agent should receive a pending request");
  const req = polled.body.request;
  await respond(server, port, cred, req.correlationId, req.seq, { correlationId: req.correlationId, result: { ok: true, tool: "read_file" } });

  const callRes = await callPromise;
  assert.equal(callRes.status, 200);
  assert.equal(callRes.body.result.ok, true);

  await closeServer(server);
});

test("two agents A and B stay isolated concurrently", async () => {
  const { deps, server } = mkServer();
  server.__deps = deps;
  await new Promise((res) => server.listen(0, res));
  const port = server.address().port;
  const credA = await pair(server, port, userA);
  const credB = await pair(server, port, userB);

  const callA = rpc({ host: "127.0.0.1", port, path: "/mcp", method: "POST" }, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file", arguments: { path: "/a.txt" } } }, { authorization: "Bearer tokenA" });
  const callB = rpc({ host: "127.0.0.1", port, path: "/mcp", method: "POST" }, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_file", arguments: { path: "/b.txt" } } }, { authorization: "Bearer tokenB" });

  const [pa, pb] = await Promise.all([poll(server, port, credA), poll(server, port, credB)]);
  assert.equal(pa.body.request.args.path, "/a.txt");
  assert.equal(pb.body.request.args.path, "/b.txt");

  await respond(server, port, credA, pa.body.request.correlationId, pa.body.request.seq, { correlationId: pa.body.request.correlationId, result: { ok: true, who: "A" } });
  await respond(server, port, credB, pb.body.request.correlationId, pb.body.request.seq, { correlationId: pb.body.request.correlationId, result: { ok: true, who: "B" } });

  const [ra, rb] = await Promise.all([callA, callB]);
  assert.equal(ra.body.result.who, "A");
  assert.equal(rb.body.result.who, "B");

  await closeServer(server);
});

test("duplicate response for the same correlation is rejected", async () => {
  const { deps, server } = mkServer();
  server.__deps = deps;
  await new Promise((res) => server.listen(0, res));
  const port = server.address().port;
  const cred = await pair(server, port, userA);

  const callPromise = rpc({ host: "127.0.0.1", port, path: "/mcp", method: "POST" }, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file", arguments: { path: "/x.txt" } } }, { authorization: "Bearer tokenA" });
  const polled = await poll(server, port, cred);
  const req = polled.body.request;
  const first = await respond(server, port, cred, req.correlationId, req.seq, { correlationId: req.correlationId, result: { ok: true } });
  assert.equal(first.status, 200);
  const dup = await respond(server, port, cred, req.correlationId, req.seq, { correlationId: req.correlationId, result: { ok: true } });
  assert.equal(dup.status, 400);
  await callPromise;

  await closeServer(server);
});

test("agent without valid device credential is rejected", async () => {
  const { deps, server } = mkServer();
  server.__deps = deps;
  await new Promise((res) => server.listen(0, res));
  const port = server.address().port;
  const bad = await rpc({ host: "127.0.0.1", port, path: "/agent/v1/poll", method: "POST" }, { timeoutMs: 100 }, { authorization: "Bearer nope.bad" });
  assert.equal(bad.status, 401);

  await closeServer(server);
});

test("OAuth bootstrap provisions a device credential without a pairing code", async () => {
  const deps = buildRouterDeps({
    verifier: createVerifier({ demo: true, expectedIssuer: ISSUER, expectedAudience: AUD }),
    expectedIssuer: ISSUER,
    expectedAudience: AUD,
    resource: "https://mcp.example.com",
    agentAuth: {
      issuer: ISSUER,
      authorizationEndpoint: "https://idp.example.com/authorize",
      tokenEndpoint: "https://idp.example.com/token",
      clientId: "agent-client",
    },
    channel: new LongPollAgentChannel(),
  });
  const { server } = createRouterHttpServer(deps);
  await new Promise((res) => server.listen(0, res));
  const port = server.address().port;
  const config = await rpc({ host: "127.0.0.1", port, path: "/agent/v1/bootstrap-config", method: "GET" }, "");
  assert.equal(config.status, 200);
  assert.equal(config.body.clientId, "agent-client");
  const provisioned = await rpc(
    { host: "127.0.0.1", port, path: "/agent/v1/bootstrap", method: "POST" },
    { agentId: "agent-tokenA", roots: ["/tmp"], capabilities: ["project:read"] },
    { authorization: "Bearer tokenA" },
  );
  assert.equal(provisioned.status, 200);
  assert.ok(provisioned.body.credentialId);
  assert.ok(provisioned.body.secret);
  assert.equal(deps.registry.get("agent-tokenA").user.sub, "tokenA");
  await closeServer(server);
});
