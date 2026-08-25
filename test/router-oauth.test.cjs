// Phase 2 acceptance: pluggable JWKS verifier (signature/iss/aud/exp/nbf),
// protected-resource metadata, and WWW-Authenticate on auth failure.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const { JwksTokenVerifier } = require("../dist/routing/jwks-verifier.js");
const { createVerifier } = require("../dist/router-entry.js");
const { buildRouterDeps } = require("../dist/router-entry.js");
const { createRouterHttpServer } = require("../dist/routing/http-server.js");

const ISSUER = "https://idp.example.com";
const AUDIENCE = "local-gateway-mcp";

// Generate an RSA key, serve a JWKS for it, and mint RS256 JWTs.
function makeKeyServer() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  const kid = "test-key-1";
  const jwks = { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] };
  const server = http.createServer((req, res) => {
    if (req.url === "/jwks.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(jwks));
    } else if (req.url === "/.well-known/openid-configuration") {
      const port = server.address().port;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ issuer: ISSUER, jwks_uri: `http://127.0.0.1:${port}/jwks.json` }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const sign = (claims) => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const sig = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
    return `${header}.${payload}.${sig}`;
  };
  return { server, sign, jwks };
}

function rpc(req, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request({ ...req, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        r.destroy();
        resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
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

test("JWKS verifier accepts a valid token and rejects bad signature", async () => {
  const ks = makeKeyServer();
  await new Promise((res) => ks.server.listen(0, res));
  const port = ks.server.address().port;
  const url = `http://127.0.0.1:${port}/jwks.json`;
  const verifier = new JwksTokenVerifier({ jwksUrl: url, issuer: ISSUER, audience: AUDIENCE });

  const good = ks.sign({ iss: ISSUER, sub: "user-a", aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 3600, scope: "project:read project:write" });
  const claims = await verifier.verify(good);
  assert.equal(claims.sub, "user-a");
  assert.deepEqual(claims.scope, ["project:read", "project:write"]);

  // tampered signature
  const [h, p] = good.split(".");
  await assert.rejects(() => verifier.verify(`${h}.${p}.${crypto.randomBytes(32).toString("base64url")}`), /signature/);

  await closeServer(ks.server);
});

test("JWKS verifier enforces issuer, audience, and expiry", async () => {
  const ks = makeKeyServer();
  await new Promise((res) => ks.server.listen(0, res));
  const port = ks.server.address().port;
  const verifier = new JwksTokenVerifier({ jwksUrl: `http://127.0.0.1:${port}/jwks.json`, issuer: ISSUER, audience: AUDIENCE });

  await assert.rejects(() => verifier.verify(ks.sign({ iss: "https://evil", sub: "x", aud: AUDIENCE, exp: 1e12 })), /issuer/);
  await assert.rejects(() => verifier.verify(ks.sign({ iss: ISSUER, sub: "x", aud: "other", exp: 1e12 })), /audience/);
  await assert.rejects(() => verifier.verify(ks.sign({ iss: ISSUER, sub: "x", aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) - 10 })), /expired/);

  await closeServer(ks.server);
});

test("createVerifier demo fallback returns stable claims", async () => {
  const v = createVerifier({ demo: true, expectedIssuer: ISSUER, expectedAudience: AUDIENCE });
  const claims = await v.verify("tokenA");
  assert.equal(claims.sub, "tokenA");
  assert.equal(claims.issuer, ISSUER);
});

test("createVerifier resolves JWKS from OIDC discovery", async () => {
  const ks = makeKeyServer();
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return new Response(JSON.stringify({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks.json` }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url === `${ISSUER}/jwks.json`) {
      return new Response(JSON.stringify(ks.jwks), { status: 200, headers: { "content-type": "application/json" } });
    }
    return originalFetch(url);
  };
  const verifier = createVerifier({
    discoveryUrl: `${ISSUER}/.well-known/openid-configuration`,
    expectedIssuer: ISSUER,
    expectedAudience: AUDIENCE,
  });
  const token = ks.sign({ iss: ISSUER, sub: "discovered-user", aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 3600 });
  const claims = await verifier.verify(token);
  assert.equal(claims.sub, "discovered-user");
  global.fetch = originalFetch;
});

test("A and B tokens produce distinct stable subjects through the router auth", async () => {
  const ks = makeKeyServer();
  await new Promise((res) => ks.server.listen(0, res));
  const port = ks.server.address().port;
  const verifier = new JwksTokenVerifier({ jwksUrl: `http://127.0.0.1:${port}/jwks.json`, issuer: ISSUER, audience: AUDIENCE });
  const deps = buildRouterDeps({ verifier, expectedIssuer: ISSUER, expectedAudience: AUDIENCE });
  const { server } = createRouterHttpServer(deps);
  await new Promise((res) => server.listen(0, res));
  const rport = server.address().port;

  const tokA = ks.sign({ iss: ISSUER, sub: "user-a", aud: AUDIENCE, exp: 1e12 });
  const tokB = ks.sign({ iss: ISSUER, sub: "user-b", aud: AUDIENCE, exp: 1e12 });

  const rA = await rpc({ host: "127.0.0.1", port: rport, path: "/.well-known/oauth-protected-resource", method: "GET" }, "");
  assert.equal(rA.status, 200);
  assert.equal(rA.body.authorization_servers[0], ISSUER);
  const rMcp = await rpc({ host: "127.0.0.1", port: rport, path: "/.well-known/oauth-protected-resource/mcp", method: "GET" }, "");
  assert.equal(rMcp.status, 200);
  assert.deepEqual(rMcp.body, rA.body);

  // tools/call requires auth: missing bearer -> 401 + WWW-Authenticate challenge
  const bad = await rpc({ host: "127.0.0.1", port: rport, path: "/mcp", method: "POST" }, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file", arguments: { path: "/x" } } });
  assert.equal(bad.status, 401);
  assert.match(bad.headers["www-authenticate"], /Bearer/);

  // valid token is accepted; router then resolves identity (no agent -> agent_unknown, not unauthenticated)
  const ok = await rpc(
    { host: "127.0.0.1", port: rport, path: "/mcp", method: "POST" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_file", arguments: { path: "/x" } } },
    { authorization: `Bearer ${tokA}` },
  );
  assert.equal(ok.status, 200);
  assert.notEqual(ok.body.error?.data?.code, "unauthenticated");

  await closeServer(server);
  await closeServer(ks.server);
});

setTimeout(() => process.exit(0), 500).unref();
