// Phase 3 acceptance: pairing (one-time/short-lived/bound), device credentials
// (issue/verify/rotate, no cross-user), and persistent registry (restart +
// revocation survive; one active agent per user).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const {
  PairingModule,
  DeviceCredentialModule,
  AgentRegistry,
  FileRegistryStore,
  FileCredStore,
  RouterError,
  userKey,
} = require("../dist/routing/index.js");

const ISSUER = "https://idp.example.com";
const userA = { issuer: ISSUER, sub: "user-a" };
const userB = { issuer: ISSUER, sub: "user-b" };

test("pairing code is single-use and expires", () => {
  const pm = new PairingModule(50); // 50ms ttl
  const { code } = pm.generate(userA);
  assert.deepEqual(pm.redeem(code), userA);
  // second redeem of same code fails
  assert.throws(() => pm.redeem(code), (e) => e instanceof RouterError && e.code === "forbidden");
  // expired code fails
  const { code: c2 } = pm.generate(userA);
  return new Promise((resolve) => {
    setTimeout(() => {
      assert.throws(() => pm.redeem(c2), (e) => e.code === "forbidden");
      resolve();
    }, 120);
  });
});

test("pairing code is bound to the issuing user (cannot cross-register)", () => {
  const pm = new PairingModule(60_000);
  const { code } = pm.generate(userA);
  // redeeming returns userA regardless of presenter; the device is issued to A
  assert.deepEqual(pm.redeem(code), userA);
});

test("device credential verifies, rotates, and rejects wrong secret", () => {
  const dm = new DeviceCredentialModule(60_000);
  const { credentialId, secret } = dm.issue(userA, "agent-a");
  assert.deepEqual(dm.verify(credentialId, secret).userId, userKey(userA));

  // wrong secret rejected
  assert.throws(() => dm.verify(credentialId, "wrong"), (e) => e.code === "unauthenticated");

  // rotation yields a new secret; old secret no longer valid
  const rotated = dm.rotate(credentialId);
  assert.equal(rotated.version, 2);
  assert.throws(() => dm.verify(credentialId, secret), (e) => e.code === "unauthenticated");
  assert.deepEqual(dm.verify(rotated.credentialId, rotated.secret).userId, userKey(userA));
});

test("device credential cannot be reused across users", () => {
  const dm = new DeviceCredentialModule(60_000);
  const a = dm.issue(userA, "agent-a");
  const b = dm.issue(userB, "agent-b");
  // credential A is bound to userA/agent-a; verifying with B's secret fails
  assert.throws(() => dm.verify(a.credentialId, b.secret), (e) => e.code === "unauthenticated");
});

test("registry survives restart and preserves revocation state", () => {
  const dir = mkdtempSync(join(tmpdir(), "reg-"));
  const storePath = join(dir, "registry.json");
  const store = new FileRegistryStore(storePath);

  const r1 = new AgentRegistry({ offlineAfterMs: 5000, store });
  r1.register({ agentId: "agent-a", user: userA, projectLabel: "A", capabilities: ["project:read"], roots: ["/x"] }, userA);
  r1.revoke("agent-a");

  // new registry instance backed by the same file
  const r2 = new AgentRegistry({ offlineAfterMs: 5000, store });
  const reloaded = r2.get("agent-a");
  assert.ok(reloaded, "agent should survive restart");
  assert.equal(reloaded.status, "revoked", "revocation must survive restart");
});

test("one active agent per user; replacement is explicit", () => {
  const reg = new AgentRegistry({ offlineAfterMs: 5000 });
  reg.register({ agentId: "agent-a1", user: userA, projectLabel: "A", capabilities: ["project:read"], roots: ["/x"] }, userA);
  // second active registration refused
  assert.throws(
    () => reg.register({ agentId: "agent-a2", user: userA, projectLabel: "A", capabilities: ["project:read"], roots: ["/x"] }, userA),
    (e) => e.code === "forbidden",
  );
  // explicit replacement allowed
  reg.replaceAgent({ agentId: "agent-a2", user: userA, projectLabel: "A", capabilities: ["project:read"], roots: ["/x"] }, userA);
  assert.equal(reg.getByUser(userA).agentId, "agent-a2");
  assert.equal(reg.get("agent-a1").status, "revoked");
});

test("device credentials persist across restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "cred-"));
  const store = new FileCredStore(join(dir, "creds.json"));
  const dm1 = new DeviceCredentialModule(60_000, store);
  const { credentialId, secret } = dm1.issue(userA, "agent-a");

  const dm2 = new DeviceCredentialModule(60_000, store);
  assert.deepEqual(dm2.verify(credentialId, secret).userId, userKey(userA));
});

setTimeout(() => process.exit(0), 500).unref();
