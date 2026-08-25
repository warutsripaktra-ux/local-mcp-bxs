import { test } from "node:test";
import assert from "node:assert/strict";
import { symlinkSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthAdapter,
  AgentRegistry,
  PolicyEngine,
  LocalProjectAgent,
  InProcessAgentChannel,
  McpRouter,
  RouterError,
  denyByDefaultPolicy,
  audit,
  describeTool,
  isKnownTool,
  isAllowedMethod,
  makeGrant,
  userKey,
} from "../dist/routing/index.js";

const ISSUER = "https://idp.example.com";
const AUDIENCE = "futuremakers-gateway";

// Minimal test IdP verifier. The real deployment plugs in the org's OIDC
// verifier here; the router logic is identical.
function makeVerifier(tokens) {
  return {
    async verify(raw) {
      const t = tokens[raw];
      if (!t) throw new Error("unknown token");
      return Object.assign(
        {
          issuer: ISSUER,
          sub: "unknown",
          audience: AUDIENCE,
          scope: [],
          exp: Math.floor(Date.now() / 1000) + 3600,
        },
        t,
      );
    },
  };
}

const userA = { issuer: ISSUER, sub: "user-a" };
const userB = { issuer: ISSUER, sub: "user-b" };

const ROOT_A = process.platform === "win32" ? "C:\\proj-a" : "/tmp/proj-a";
const ROOT_B = process.platform === "win32" ? "C:\\proj-b" : "/tmp/proj-b";

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

// inner handler stands in for the real MCP tool dispatch
function innerEcho(request) {
  return Promise.resolve({ correlationId: request.correlationId ?? "x", result: { ok: true, tool: request.tool } });
}

function buildSystem() {
  const verifier = makeVerifier({
    tokenA: { sub: "user-a", scope: ["project:read", "project:write", "project:process"] },
    tokenB: { sub: "user-b", scope: ["project:read"] },
    capB: { sub: "user-b", scope: ["project:read", "project:write"] },
    expired: { sub: "user-a", exp: Math.floor(Date.now() / 1000) - 10 },
    readOnly: { sub: "user-a", scope: ["project:read"] },
  });
  const auth = new AuthAdapter(verifier, { expectedAudience: AUDIENCE, expectedIssuer: ISSUER });
  const registry = new AgentRegistry({ offlineAfterMs: 5000 });
  const channel = new InProcessAgentChannel();

  registry.register(
    { agentId: "agent-a", user: userA, projectLabel: "A", capabilities: ["project:read", "project:write", "project:process"], roots: [ROOT_A] },
    userA,
  );
  registry.register(
    { agentId: "agent-b", user: userB, projectLabel: "B", capabilities: ["project:read"], roots: [ROOT_B] },
    userB,
  );

  channel.registerAgent(new LocalProjectAgent(registry.get("agent-a"), new PolicyEngine(policyFor([ROOT_A], ["project:read", "project:write", "project:process"])), innerEcho));
  channel.registerAgent(new LocalProjectAgent(registry.get("agent-b"), new PolicyEngine(policyFor([ROOT_B], ["project:read"])), innerEcho));

  const router = new McpRouter(auth, registry, channel, { forwardTimeoutMs: 2000 });
  return { auth, registry, channel, router };
}

test("A reads file in project A succeeds", async () => {
  const { router } = buildSystem();
  const res = await router.handleRequest("Bearer tokenA", { correlationId: "c1", tool: "read_file", args: { path: `${ROOT_A}/x.txt` } });
  assert.equal(res.error, undefined);
  assert.equal(res.result.ok, true);
});

test("B reads file in project B succeeds", async () => {
  const { router } = buildSystem();
  const res = await router.handleRequest("Bearer tokenB", { correlationId: "c2", tool: "read_file", args: { path: `${ROOT_B}/y.txt` } });
  assert.equal(res.result.ok, true);
});

test("A requesting B's path is denied", async () => {
  const { router } = buildSystem();
  await assert.rejects(
    () => router.handleRequest("Bearer tokenA", { correlationId: "c3", tool: "read_file", args: { path: `${ROOT_B}/secret.txt` } }),
    (e) => e instanceof RouterError && e.code === "policy_denied",
  );
});

test("B cannot reach A's project (resolved only to own agent)", async () => {
  const { router, registry } = buildSystem();
  assert.equal(registry.getByUser(userB).agentId, "agent-b");
  await assert.rejects(
    () => router.handleRequest("Bearer tokenB", { correlationId: "c4", tool: "read_file", args: { path: `${ROOT_A}/x.txt` } }),
    (e) => e instanceof RouterError && e.code === "policy_denied",
  );
});

test("concurrent requests for A and B stay separated", async () => {
  const { router } = buildSystem();
  const aReq = router.handleRequest("Bearer tokenA", { correlationId: "ca", tool: "read_file", args: { path: `${ROOT_A}/a.txt` } });
  const bReq = router.handleRequest("Bearer tokenB", { correlationId: "cb", tool: "read_file", args: { path: `${ROOT_B}/b.txt` } });
  const [a, b] = await Promise.all([aReq, bReq]);
  assert.equal(a.result.tool, "read_file");
  assert.equal(b.result.tool, "read_file");
});

test("expired token rejected", async () => {
  const { router } = buildSystem();
  await assert.rejects(
    () => router.handleRequest("Bearer expired", { correlationId: "c5", tool: "read_file", args: { path: `${ROOT_A}/x.txt` } }),
    (e) => e instanceof RouterError && e.code === "unauthenticated",
  );
});

test("missing scope for write denied", async () => {
  const { router } = buildSystem();
  await assert.rejects(
    () => router.handleRequest("Bearer readOnly", { correlationId: "c6", tool: "write_file", args: { path: `${ROOT_A}/x.txt` } }),
    (e) => e instanceof RouterError && e.code === "forbidden",
  );
});

test("agent offline returns error, no fallback", async () => {
  const { router, registry } = buildSystem();
  const agent = registry.get("agent-a");
  agent.lastHeartbeatAt = new Date(Date.now() - 10000).toISOString();
  await assert.rejects(
    () => router.handleRequest("Bearer tokenA", { correlationId: "c7", tool: "read_file", args: { path: `${ROOT_A}/x.txt` } }),
    (e) => e instanceof RouterError && e.code === "agent_offline",
  );
});

test("path traversal/escape denied", async () => {
  const { router } = buildSystem();
  await assert.rejects(
    () => router.handleRequest("Bearer tokenA", { correlationId: "c8", tool: "read_file", args: { path: `${ROOT_A}/../proj-b/secret.txt` } }),
    (e) => e instanceof RouterError && e.code === "policy_denied",
  );
});

test("process command outside allowlist denied", async () => {
  const { router } = buildSystem();
  await assert.rejects(
    () => router.handleRequest("Bearer tokenA", { correlationId: "c9", tool: "start_process", args: { command: "rm -rf /" } }),
    (e) => e instanceof RouterError && e.code === "policy_denied",
  );
});

test("wildcard command policy allows arbitrary local commands", () => {
  const policy = policyFor([ROOT_A], ["project:process"]);
  policy.allowedCommands = ["*"];
  const engine = new PolicyEngine(policy);
  assert.doesNotThrow(() => engine.enforceProcess("cd /tmp && curl https://example.com"));
  assert.doesNotThrow(() => engine.enforceProcess("a-future-command --flag"));
});

test("revoked agent rejects new requests immediately", async () => {
  const { router, registry } = buildSystem();
  registry.revoke("agent-a");
  await assert.rejects(
    () => router.handleRequest("Bearer tokenA", { correlationId: "c10", tool: "read_file", args: { path: `${ROOT_A}/x.txt` } }),
    (e) => e instanceof RouterError && e.code === "agent_revoked",
  );
});

test("agent cannot register for a different user", async () => {
  const { registry } = buildSystem();
  assert.throws(
    () => registry.register(
      { agentId: "evil", user: userB, projectLabel: "B", capabilities: ["project:read"], roots: [ROOT_B] },
      userA,
    ),
    (e) => e instanceof RouterError && e.code === "forbidden",
  );
});

test("deny-by-default policy blocks reads with no roots", async () => {
  const engine = new PolicyEngine(denyByDefaultPolicy());
  assert.throws(() => engine.enforceRead(`${ROOT_A}/x.txt`), (e) => e.code === "policy_denied");
});

test("filesystem root allows every absolute path", () => {
  const engine = new PolicyEngine(policyFor([join(ROOT_A, "..", "..")], ["project:read"]));
  assert.doesNotThrow(() => engine.enforceRead(`${ROOT_A}/x.txt`));
});

test("router denies when agent lacks the capability (token has scope)", async () => {
  const { router } = buildSystem();
  // agent-b advertises only project:read, but capB token carries project:write
  await assert.rejects(
    () => router.handleRequest("Bearer capB", { correlationId: "c12", tool: "write_file", args: { path: `${ROOT_B}/x.txt` } }),
    (e) => e instanceof RouterError && e.code === "forbidden",
  );
});

test("shell-wrapper command injection is denied by allowlist", async () => {
  const { router } = buildSystem();
  await assert.rejects(
    () => router.handleRequest("Bearer tokenA", { correlationId: "c13", tool: "start_process", args: { command: "bash -c \"git status; rm -rf /\"" } }),
    (e) => e instanceof RouterError && e.code === "policy_denied",
  );
  // even a benign-looking wrapper whose base is not allowlisted is denied
  await assert.rejects(
    () => router.handleRequest("Bearer tokenA", { correlationId: "c13b", tool: "start_process", args: { command: "bash -c \"git status\"" } }),
    (e) => e instanceof RouterError && e.code === "policy_denied",
  );
});

test("symlink escape for a non-existent target is denied", async () => {
  const dir = join(tmpdir(), `routing-sym-${Date.now()}`);
  const inside = join(dir, "inside");
  const outside = join(dir, "outside");
  mkdirSync(inside, { recursive: true });
  mkdirSync(outside, { recursive: true });
  // inside/escape -> outside (symlink out of root)
  symlinkSync(outside, join(inside, "escape"));
  try {
    const engine = new PolicyEngine(policyFor([inside], ["project:read", "project:write", "project:process"]));
    assert.throws(() => engine.enforceRead(join(inside, "escape", "secret.txt")), (e) => e.code === "policy_denied");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read_multiple_files validates every path", async () => {
  const { registry } = buildSystem();
  const agent = new LocalProjectAgent(
    registry.get("agent-a"),
    new PolicyEngine(policyFor([ROOT_A], ["project:read", "project:write", "project:process"])),
    innerEcho,
  );
  // one path outside root must deny the whole call
  assert.throws(
    () => agent.enforce({ correlationId: "c14", tool: "read_multiple_files", args: { paths: [`${ROOT_A}/ok.txt`, `${ROOT_B}/secret.txt`] } }, undefined),
    (e) => e.code === "policy_denied",
  );
  // all inside root: allowed
  agent.enforce({ correlationId: "c14b", tool: "read_multiple_files", args: { paths: [`${ROOT_A}/a.txt`, `${ROOT_A}/b.txt`] } }, undefined);
});

test("read tool with no path argument is denied (deny-by-default)", async () => {
  const { registry } = buildSystem();
  const agent = new LocalProjectAgent(
    registry.get("agent-a"),
    new PolicyEngine(policyFor([ROOT_A], ["project:read", "project:write", "project:process"])),
    innerEcho,
  );
  assert.throws(
    () => agent.enforce({ correlationId: "c15", tool: "read_file", args: {} }, true),
    (e) => e.code === "policy_denied",
  );
});

test("agent reconnect after going offline", async () => {
  const { router, registry } = buildSystem();
  const agent = registry.get("agent-a");
  agent.lastHeartbeatAt = new Date(Date.now() - 10000).toISOString();
  await assert.rejects(
    () => router.handleRequest("Bearer tokenA", { correlationId: "c16", tool: "read_file", args: { path: `${ROOT_A}/x.txt` } }),
    (e) => e.code === "agent_offline",
  );
  // heartbeat re-onlines the agent
  registry.heartbeat("agent-a");
  const res = await router.handleRequest("Bearer tokenA", { correlationId: "c16b", tool: "read_file", args: { path: `${ROOT_A}/x.txt` } });
  assert.equal(res.result.ok, true);
});

test("audit logs identity and outcome without leaking secrets", async () => {
  const events = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    const s = chunk.toString();
    if (s.includes('"kind":"audit"')) events.push(JSON.parse(s));
    return true;
  };
  try {
    const { router } = buildSystem();
    await assert.rejects(
      () => router.handleRequest("Bearer tokenA", { correlationId: "c17", tool: "read_file", args: { path: `${ROOT_B}/secret.txt` } }),
      (e) => e.code === "policy_denied",
    );
  } finally {
    process.stderr.write = original;
  }
  const deny = events.find((e) => e.action === "deny" || e.errorCode === "policy_denied");
  assert.ok(deny, "expected an audit deny event");
  assert.ok(deny.user && deny.user.includes("|"), "audit should record stable user subject");
  assert.equal(deny.tool, "read_file");
  assert.equal(deny.correlationId, "c17");
});

test("runtime policy deny-by-default via DC_AGENT_POLICY env", async () => {
  const prev = process.env.DC_AGENT_POLICY;
  process.env.DC_AGENT_POLICY = JSON.stringify({
    roots: [ROOT_A],
    allowRead: true,
    allowWrite: true,
    allowProcess: false,
    allowedCommands: [],
    requireConfirmationFor: ["project:write", "project:process"],
  });
  try {
    const { getRuntimePolicy, runtimePathAllowed, runtimeCommandAllowed } = await import("../dist/routing/runtime-policy.js");
    const engine = getRuntimePolicy();
    assert.ok(engine, "runtime policy should load");
    assert.equal(runtimePathAllowed(`${ROOT_A}/x.txt`), true);
    assert.equal(runtimePathAllowed(`${ROOT_B}/x.txt`), false);
    // no allowedCommands and process scope off -> any command denied
    assert.equal(runtimeCommandAllowed("ls -la"), false);
  } finally {
    if (prev === undefined) delete process.env.DC_AGENT_POLICY;
    else process.env.DC_AGENT_POLICY = prev;
  }
});

test("write requires confirmation when not yet confirmed", async () => {
  const { registry } = buildSystem();
  const agent = new LocalProjectAgent(
    registry.get("agent-a"),
    new PolicyEngine(policyFor([ROOT_A], ["project:read", "project:write", "project:process"])),
    innerEcho,
  );
  await assert.rejects(
    () => agent.handle({ correlationId: "c11", tool: "write_file", args: { path: `${ROOT_A}/x.txt` } }, undefined),
    (e) => e instanceof RouterError && e.code === "confirmation_required",
  );
  // once a trusted grant is presented, the write proceeds
  const grant = makeGrant(userKey(registry.get("agent-a").user), "agent-a", "write_file", { path: `${ROOT_A}/x.txt` });
  const res = await agent.handle({ correlationId: "c11", tool: "write_file", args: { path: `${ROOT_A}/x.txt` } }, grant);
  assert.equal(res.result.ok, true);
});

test("confirmation grant is rejected when arguments changed", async () => {
  const { registry } = buildSystem();
  const agent = new LocalProjectAgent(
    registry.get("agent-a"),
    new PolicyEngine(policyFor([ROOT_A], ["project:read", "project:write", "project:process"])),
    innerEcho,
  );
  const grant = makeGrant(userKey(registry.get("agent-a").user), "agent-a", "write_file", { path: `${ROOT_A}/x.txt` });
  await assert.rejects(
    () => agent.handle({ correlationId: "c11b", tool: "write_file", args: { path: `${ROOT_A}/other.txt` } }, grant),
    (e) => e instanceof RouterError && e.code === "confirmation_required",
  );
});

test("router denies unclassified/unknown tools", async () => {
  const { router } = buildSystem();
  await assert.rejects(
    () => router.handleRequest("Bearer tokenA", { correlationId: "c18", tool: "drop_tables", args: {} }),
    (e) => e instanceof RouterError && e.code === "policy_denied",
  );
});

test("catalog classifies every server tool and unknown tools are absent", async () => {
  const known = [
    "read_file", "read_multiple_files", "list_directory", "get_file_info",
    "start_search", "get_more_search_results", "stop_search", "list_searches",
    "write_file", "write_pdf", "create_directory", "move_file", "edit_block",
    "set_config_value", "start_process", "interact_with_process", "read_process_output",
    "force_terminate", "list_sessions", "kill_process", "list_processes",
    "get_config", "get_usage_stats", "get_recent_tool_calls",
    "give_feedback_to_desktop_commander", "get_prompts",
  ];
  for (const t of known) assert.ok(isKnownTool(t), `tool should be classified: ${t}`);
  assert.equal(isKnownTool("not_a_real_tool"), false);
  assert.equal(describeTool("write_file").scope, "project:write");
  assert.equal(describeTool("start_process").commandField, "command");
  assert.deepEqual(describeTool("move_file").pathFields, ["source", "destination"]);
  assert.deepEqual(describeTool("read_multiple_files").pathArrays, ["paths"]);
});

test("only allowlisted MCP methods are accepted", async () => {
  assert.equal(isAllowedMethod("tools/call"), true);
  assert.equal(isAllowedMethod("initialize"), true);
  assert.equal(isAllowedMethod("completions/xyz"), false);
});

test("malformed tool payload is denied (non-string path)", async () => {
  const { registry } = buildSystem();
  const agent = new LocalProjectAgent(
    registry.get("agent-a"),
    new PolicyEngine(policyFor([ROOT_A], ["project:read", "project:write", "project:process"])),
    innerEcho,
  );
  assert.throws(
    () => agent.enforce({ correlationId: "c19", tool: "read_file", args: { path: 12345 } }, undefined),
    (e) => e.code === "policy_denied",
  );
});

test("oversized payload argument is rejected", async () => {
  const { registry } = buildSystem();
  const agent = new LocalProjectAgent(
    registry.get("agent-a"),
    new PolicyEngine(policyFor([ROOT_A], ["project:read", "project:write", "project:process"])),
    innerEcho,
  );
  const big = "x".repeat(20_000_000);
  const grant = makeGrant(userKey(registry.get("agent-a").user), "agent-a", "write_file", { path: `${ROOT_A}/x.txt`, content: big });
  assert.throws(
    () => agent.enforce({ correlationId: "c20", tool: "write_file", args: { path: `${ROOT_A}/x.txt`, content: big } }, grant),
    (e) => e.code === "policy_denied",
  );
});

test("multi-path write validates every field including nested outputPath", async () => {
  const { registry } = buildSystem();
  const agent = new LocalProjectAgent(
    registry.get("agent-a"),
    new PolicyEngine(policyFor([ROOT_A], ["project:read", "project:write", "project:process"])),
    innerEcho,
  );
  const outside = makeGrant(userKey(registry.get("agent-a").user), "agent-a", "write_pdf", { path: `${ROOT_A}/in.pdf`, outputPath: `${ROOT_B}/out.pdf` });
  // write_pdf has both path and optional outputPath; an outside outputPath denies
  assert.throws(
    () => agent.enforce({ correlationId: "c21", tool: "write_pdf", args: { path: `${ROOT_A}/in.pdf`, outputPath: `${ROOT_B}/out.pdf` } }, outside),
    (e) => e.code === "policy_denied",
  );
  // both inside root: allowed
  const inside = makeGrant(userKey(registry.get("agent-a").user), "agent-a", "write_pdf", { path: `${ROOT_A}/in.pdf`, outputPath: `${ROOT_A}/out.pdf` });
  agent.enforce({ correlationId: "c21b", tool: "write_pdf", args: { path: `${ROOT_A}/in.pdf`, outputPath: `${ROOT_A}/out.pdf` } }, inside);
});

test("search session id is bound to the requesting user+agent", async () => {
  const { registry, router } = buildSystem();
  const ua = userKey(registry.get("agent-a").user);
  // Drive through the router so the request is stamped with owner A.
  await router.handleRequest("Bearer tokenA", { correlationId: "s1", tool: "start_search", args: { path: `${ROOT_A}/x`, pattern: "foo" } });
  // User B referencing the same session id must be denied (cross-session/cross-user).
  await assert.rejects(
    () => router.handleRequest("Bearer tokenB", { correlationId: "s2", tool: "stop_search", args: { sessionId: "s1" } }),
    (e) => e instanceof RouterError && e.code === "policy_denied",
  );
  assert.ok(ua, "userKey for agent-a");
});

test("process session tools accept numeric PID identifiers", () => {
  const { registry } = buildSystem();
  const agent = new LocalProjectAgent(
    registry.get("agent-a"),
    new PolicyEngine(policyFor([ROOT_A], ["project:process"])),
    innerEcho,
  );
  const args = { pid: 987654321 };
  const grant = makeGrant(
    userKey(registry.get("agent-a").user),
    "agent-a",
    "read_process_output",
    args,
  );

  assert.doesNotThrow(() =>
    agent.enforce(
      { correlationId: "numeric-pid", tool: "read_process_output", args },
      grant,
    ),
  );
});
