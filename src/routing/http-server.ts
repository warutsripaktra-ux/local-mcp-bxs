import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handleMcpJsonRpc, type JsonRpcRequest } from "./mcp-adapter.js";
import { RouterError } from "./types.js";
import type { RouterDeps } from "../router-entry.js";

// Central HTTP MCP Router. Exposes /mcp (JSON-RPC), /healthz, and /readyz.
// The tunnel is pointed at /mcp. Discovery and health are served without any
// online agent; tool calls are forwarded through the router module.

export function createRouterHttpServer(deps: RouterDeps) {
  let inflight = 0;
  const waiters: Array<() => void> = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Unref individual connections so they never block process exit after a
    // graceful shutdown; the listening socket still keeps the server alive.
    req.socket.unref();
    const url = req.url ?? "/";
    if (req.method === "GET" && (url === "/healthz" || url === "/readyz")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", ts: new Date().toISOString() }));
      return;
    }
    // OAuth protected-resource metadata (RFC 9728). No auth required.
    if (req.method === "GET" && (url === "/.well-known/oauth-protected-resource" || url === "/.well-known/oauth-protected-resource/mcp")) {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          resource: deps.resource,
          authorization_servers: [deps.issuer],
          scopes_supported: ["project:read", "project:write", "project:process"],
          bearer_methods_supported: ["header"],
        }),
      );
      return;
    }
    if (req.method === "GET" && url === "/agent/v1/bootstrap-config") {
      if (!deps.agentAuth.clientId) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "agent_oauth_not_configured" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ...deps.agentAuth, audience: deps.audience, resource: deps.resource }));
      return;
    }
    if (req.method === "POST" && url === "/agent/v1/bootstrap") {
      handleBootstrap(deps, req, res);
      return;
    }
    // Agent control plane (plan Phase 4): pair / poll / respond / rotate.
    if (req.method === "POST" && url.startsWith("/agent/v1/")) {
      handleAgent(deps, req, res);
      return;
    }
    if (req.method === "POST" && (url === "/admin/v1/pair" || url === "/admin/v1/revoke")) {
      handleAdmin(deps, req, res, url);
      return;
    }
    if (req.method === "POST" && url === "/mcp") {
      const auth = req.headers["authorization"];
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        inflight++;
        try {
          let parsed: JsonRpcRequest;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonRpcRequest;
          } catch {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
            return;
          }
          const response = await handleMcpJsonRpc(parsed, { router: deps.router, authorization: typeof auth === "string" ? auth : undefined, resourceMetadataUrl: deps.resourceMetadataUrl });
          // Surface auth failures as a proper WWW-Authenticate challenge.
          if (response.error && response.error.data && (response.error.data as { code?: string }).code === "unauthenticated") {
            res.writeHead(401, {
              "content-type": "application/json",
              "WWW-Authenticate": `Bearer resource_metadata="${deps.resource}/.well-known/oauth-protected-resource", error="invalid_token"`,
            });
          } else {
            res.writeHead(200, { "content-type": "application/json" });
          }
          res.end(JSON.stringify(response));
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: err instanceof Error ? err.message : "internal" } }));
        } finally {
          inflight--;
          if (inflight === 0) waiters.splice(0).forEach((w) => w());
        }
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32601, message: "Not found" } }));
  });

  // Graceful shutdown: stop accepting, drain in-flight requests, then close.
  function shutdown(): Promise<void> {
    return new Promise((resolve) => {
      server.close(() => resolve());
      if (inflight === 0) return;
      waiters.push(resolve);
    });
  }

  return { server, shutdown };
}

function handleAdmin(deps: RouterDeps, req: IncomingMessage, res: ServerResponse, url: string): void {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  readJsonBody(req).then(async (body) => {
    let user;
    try { user = await deps.auth.authenticate(typeof req.headers.authorization === "string" ? req.headers.authorization : undefined); }
    catch (err) { const e = err instanceof RouterError ? err : new RouterError("unauthenticated", "invalid token", "n/a"); send(401, { error: e.code, message: e.message }); return; }
    if (url === "/admin/v1/pair") {
      const pair = deps.pairing.generate(user.subject);
      send(200, { code: pair.code, expiresAt: pair.expiresAt, user: user.subject });
      return;
    }
    const credentialId = typeof body.credentialId === "string" ? body.credentialId : "";
    const credential = deps.credentials.find(credentialId);
    if (!credential || credential.userId !== `${user.subject.issuer}|${user.subject.sub}`) { send(404, { error: "not_found" }); return; }
    deps.credentials.revoke(credentialId);
    deps.registry.revoke(credential.agentId);
    send(200, { ok: true });
  }).catch((err) => send(400, { error: "invalid_request", message: err instanceof Error ? err.message : "invalid request" }));
}

function handleBootstrap(deps: RouterDeps, req: IncomingMessage, res: ServerResponse): void {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  readJsonBody(req).then(async (body) => {
    let user;
    try { user = await deps.auth.authenticate(typeof req.headers.authorization === "string" ? req.headers.authorization : undefined); }
    catch (err) { const e = err instanceof RouterError ? err : new RouterError("unauthenticated", "invalid token", "n/a"); send(401, { error: e.code, message: e.message }); return; }
    const agentId = typeof body.agentId === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(body.agentId) ? body.agentId : "";
    if (!agentId) { send(400, { error: "invalid_agent_id" }); return; }
    const knownScopes = new Set(["project:read", "project:write", "project:process"]);
    const capabilities = Array.isArray(body.capabilities) ? body.capabilities.filter((v): v is string => typeof v === "string" && knownScopes.has(v)) : ["project:read"];
    const roots = Array.isArray(body.roots) ? body.roots.filter((v): v is string => typeof v === "string") : [];
    deps.registry.replaceAgent({ agentId, user: user.subject, projectLabel: agentId, capabilities: capabilities as never, roots }, user.subject);
    const issued = deps.credentials.issue(user.subject, agentId);
    send(200, { credentialId: issued.credentialId, secret: issued.secret, version: issued.version, user: user.subject });
  }).catch((err) => send(400, { error: "invalid_request", message: err instanceof Error ? err.message : "invalid request" }));
}

// Agent control-plane handlers. Each request authenticates with the device
// credential (Authorization: Bearer <credentialId>.<secret>) except /pair,
// which redeems a one-time pairing code bound to the authenticated user.
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch {
        reject(new RouterError("policy_denied", "Invalid JSON body", "n/a"));
      }
    });
    req.on("error", reject);
  });
}

function deviceAuth(deps: RouterDeps, authorization: string | undefined): { credentialId: string; userId: string; agentId: string; version: number } {
  const header = typeof authorization === "string" ? authorization : "";
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) throw new RouterError("unauthenticated", "Missing device credential", "n/a");
  const [credentialId, secret] = m[1].split(".");
  if (!secret) throw new RouterError("unauthenticated", "Malformed device credential", "n/a");
  const v = deps.credentials.verify(credentialId, secret);
  return { credentialId, ...v };
}

function handleAgent(deps: RouterDeps, req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? "/";
  let sent = false;
  const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    if (sent) return;
    sent = true;
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  readJsonBody(req)
    .then(async (body) => {
      if (url === "/agent/v1/pair") {
        const code = typeof body.code === "string" ? body.code : "";
        const user = deps.pairing.redeem(code); // throws if invalid/expired/used
        const agentId = typeof body.agentId === "string" ? body.agentId : `agent-${user.sub}`;
        const capabilities = Array.isArray(body.capabilities) ? (body.capabilities as string[]) : ["project:read"];
        const roots = Array.isArray(body.roots) ? (body.roots as string[]) : [];
        deps.registry.register(
          { agentId, user, projectLabel: typeof body.projectLabel === "string" ? body.projectLabel : agentId, capabilities: capabilities as never, roots },
          user,
        );
        const issued = deps.credentials.issue(user, agentId);
        send(200, { credentialId: issued.credentialId, secret: issued.secret, version: issued.version });
        return;
      }
      // All other agent endpoints require device auth.
      const auth = deviceAuth(deps, req.headers["authorization"]);
      if (url === "/agent/v1/poll") {
        deps.registry.heartbeat(auth.agentId);
        const timeoutMs = typeof body.timeoutMs === "number" ? body.timeoutMs : 25_000;
        const pending = await (deps.channel as { poll?: (a: string, v: number, t: number) => Promise<unknown> }).poll?.(auth.agentId, auth.version, timeoutMs) ?? null;
        // LongPollAgentChannel returns an internal Pending record containing
        // callbacks and a circular Timeout handle. Only the routed request and
        // its sequence number belong on the wire.
        const delivery = pending as { request?: Record<string, unknown>; seq?: number } | null;
        send(200, { request: delivery ? { ...delivery.request, seq: delivery.seq } : null });
        return;
      }
      if (url === "/agent/v1/respond") {
        deps.registry.heartbeat(auth.agentId);
        const correlationId = typeof body.correlationId === "string" ? body.correlationId : "";
        const sequence = typeof body.sequence === "number" ? body.sequence : 0;
        const result = (body.result ?? {}) as { correlationId?: string; result?: unknown; error?: unknown };
        (deps.channel as { respond?: (a: string, c: string, s: number, r: unknown) => void }).respond?.(auth.agentId, correlationId, sequence, result as never);
        send(200, { ok: true });
        return;
      }
      if (url === "/agent/v1/rotate") {
        const rotated = deps.credentials.rotate(auth.credentialId);
        send(200, { credentialId: rotated.credentialId, secret: rotated.secret, version: rotated.version });
        return;
      }
      send(404, { error: "unknown agent endpoint" });
    })
    .catch((err) => {
      if (err instanceof RouterError) send(err.code === "unauthenticated" ? 401 : 400, { error: err.code, message: err.message }, err.code === "unauthenticated" ? { "WWW-Authenticate": 'Bearer error="invalid_token"' } : {});
      else send(500, { error: "internal", message: err instanceof Error ? err.message : "unknown" });
    });
}
