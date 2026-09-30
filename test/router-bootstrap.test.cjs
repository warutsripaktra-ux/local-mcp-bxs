const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { buildRouterDeps, createVerifier } = require("../dist/router-entry.js");
const { createRouterHttpServer } = require("../dist/routing/http-server.js");
const { LongPollAgentChannel } = require("../dist/routing/long-poll-channel.js");

const ISSUER = "https://idp.example.com";
const AUDIENCE = "local-gateway-mcp";

function request(port, path, body, authorization) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: body === undefined ? "GET" : "POST", agent: false }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    req.on("error", reject);
    if (authorization) req.setHeader("authorization", authorization);
    if (body !== undefined) { req.setHeader("content-type", "application/json"); req.end(JSON.stringify(body)); } else req.end();
  });
}

test("one-command OAuth bootstrap provisions an agent without pairing", async () => {
  const deps = buildRouterDeps({
    verifier: createVerifier({ demo: true, expectedIssuer: ISSUER, expectedAudience: AUDIENCE }),
    expectedIssuer: ISSUER,
    expectedAudience: AUDIENCE,
    resource: "https://mcp.example.com",
    agentAuth: { issuer: ISSUER, authorizationEndpoint: "https://idp.example.com/authorize", tokenEndpoint: "https://idp.example.com/token", clientId: "agent-client" },
    channel: new LongPollAgentChannel(),
  });
  const { server } = createRouterHttpServer(deps);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const config = await request(port, "/agent/v1/bootstrap-config");
  assert.equal(config.status, 200);
  assert.equal(config.body.clientId, "agent-client");
  const result = await request(port, "/agent/v1/bootstrap", { agentId: "macbook-user-a", roots: ["/tmp"], capabilities: ["project:read"] }, "Bearer tokenA");
  assert.equal(result.status, 200);
  assert.match(result.body.credentialId, /^[A-Za-z0-9_-]+$/);
  assert.ok(result.body.secret);
  assert.equal(deps.registry.get("macbook-user-a").user.sub, "tokenA");
  await new Promise((resolve) => server.close(resolve));
});
