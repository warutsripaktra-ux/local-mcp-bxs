# Architecture and Protocol

## Trust zones

| Zone | Contents | Trust rule |
|---|---|---|
| OpenAI | ChatGPT, OAuth client, hosted Tunnel endpoint | Bearer token is untrusted until Router verification |
| Central host | `tunnel-client`, HTTP MCP Router, registry, queue, audit | Never trust routing/path/confirmation from model args |
| User host | Agent Controller, local policy, stdio MCP child | Execute only device-authenticated Router requests |
| IdP | Login, consent, token issuance, JWKS | Must be reachable by the browser OAuth flow |

The authorization server is not automatically exposed by Secure MCP Tunnel.

## Processes

Central host:

```text
tunnel-client -> http://127.0.0.1:${ROUTER_MCP_PORT}/mcp
central-router -> MCP HTTP + OAuth metadata + private agent endpoints
```

User host:

```text
agent-controller
  -> outbound HTTPS long-poll to central-router
  -> spawn node dist/index.js
  -> MCP JSON-RPC over child stdin/stdout
```

HTTP is required at the Router seam for bearer context, OAuth metadata, health endpoints, and independent lifecycle. User hosts expose no inbound port.

## Request flow

1. ChatGPT discovers the Router's canonical public MCP resource and authorization server.
2. ChatGPT obtains an OAuth token from the established IdP using authorization code + PKCE.
3. The IdP copies the canonical MCP resource into the token audience/resource claim.
4. Tunnel forwards the MCP request and bearer token to the Router.
5. `AuthModule` verifies signature, exact issuer, audience/resource, expiry, and scopes.
6. `AgentRegistry.resolve(iss, sub)` returns the user's active agent.
7. `ToolPolicyCatalog` validates method, tool, arguments, scope, and confirmation.
8. `AgentChannel.send(agentId, request)` queues the call.
9. The Agent polls, authenticates with its device credential, and revalidates local policy.
10. `StdioMcpRuntime` calls the local MCP child and returns the correlated response.
11. Router audits metadata and returns the response through Tunnel.

No agent/offline/error path may fall back to another machine.

## Identity provider and discovery

Use an established OAuth 2.1/OIDC provider owned or approved by the organization. This repository is an MCP resource server, not an authorization server.

Production configuration has two identity inputs:

- `OIDC_ISSUER`: exact canonical issuer returned by the provider's discovery document and token `iss` claim.
- `OIDC_AUDIENCE`: canonical public HTTPS MCP resource used in protected-resource metadata, OAuth `resource`, and token `aud`/resource validation.

The Router resolves the provider-published OAuth/OIDC discovery document from `OIDC_ISSUER`, validates that metadata `issuer` matches exactly, and obtains `jwks_uri`. A separately configured JWKS URL is allowed only as an explicit test override. Loopback, private Router, and user-agent URLs are never production audience values.

## ChatGPT OAuth linking contract

All four conditions are required:

1. `GET /.well-known/oauth-protected-resource` returns the exact `OIDC_AUDIENCE`, `authorization_servers: [OIDC_ISSUER]`, and supported scopes.
2. Every user-machine tool in `tools/list` declares `securitySchemes: [{ type: "oauth2", scopes: [...] }]` using the scope from the shared tool policy catalog.
3. An unauthenticated HTTP request returns `401` with `WWW-Authenticate: Bearer resource_metadata="<public-resource-metadata-url>"` and the required scope.
4. A protected tool auth failure returns an MCP error result with `_meta["mcp/www_authenticate"]`, including `resource_metadata`, `error`, and `error_description`.

The Router verifies the bearer token on every protected call. `initialize`, health, and metadata may be anonymous; anonymity never permits dispatch to a user machine.

## Deep modules

### `AuthModule`

```ts
interface AuthModule {
  authenticate(header?: string): Promise<AuthenticatedUser>;
  requireScope(user: AuthenticatedUser, scope: Scope): void;
}
```

Adapters: fake verifier for tests; OIDC-discovered JWKS verifier for production. A direct JWKS URL is test-only.

### `ToolPolicyCatalog`

```ts
interface ToolPolicyCatalog {
  describe(method: string, tool?: string): ToolPolicy;
  validate(policy: ToolPolicy, args: unknown): ValidatedCall;
}
```

Single source for scope, path fields, command/session rules, confirmation, timeout, and audit action. Router and Agent use the same Module. Unknown methods/tools deny.

### `AgentRegistry`

```ts
interface AgentRegistry {
  register(input: VerifiedRegistration): Promise<AgentRecord>;
  heartbeat(agentId: string, device: DeviceIdentity): Promise<void>;
  resolve(user: UserSubject): Promise<AgentRecord | null>;
  revoke(agentId: string, reason: string): Promise<void>;
}
```

Adapters: in-memory for tests; persistent store for production. The Module owns one-agent-per-user, liveness, replacement, and credential versions.

### `AgentChannel`

```ts
interface AgentChannel {
  send(agentId: string, request: RoutedRequest): Promise<RoutedResponse>;
  status(agentId: string): Promise<AgentStatus>;
  cancel(agentId: string, correlationId: string): Promise<void>;
}
```

Adapters: in-process test Adapter; HTTPS long-poll production Adapter. The Module owns queueing, deadlines, reconnect, duplicates, cancellation, and backpressure.

### `RouterModule`

```ts
interface RouterModule {
  handle(context: AuthenticatedContext, request: McpRequest): Promise<McpResponse>;
}
```

The Router orchestrates auth, registry, policy, channel, errors, and audit. It never accesses a user's filesystem or shell.

### `AgentController`

```ts
interface AgentController {
  start(config: AgentConfig): Promise<void>;
  stop(reason: string): Promise<void>;
}
```

Owns device auth, polling, heartbeat, local policy, child lifecycle, and reconnect.

### `StdioMcpRuntime`

```ts
interface StdioMcpRuntime {
  start(): Promise<void>;
  request(message: JsonRpcRequest): Promise<JsonRpcResponse>;
  stop(): Promise<void>;
}
```

Owns child stdin/stdout parsing, request IDs, pending calls, stderr logs, and child failure.

## Routing invariants

- User key is `issuer + sub`; email is display-only.
- Pairing binds the authenticated user to `agentId`; registration payload cannot self-assert ownership.
- MVP permits one active agent per user.
- OAuth tokens terminate at the Router and are never forwarded to agents.
- Device credentials are separate from OAuth and Tunnel credentials.
- Tool arguments contain no trusted routing override.
- Router and Agent both enforce policy.

## Agent protocol v1

All endpoints use private HTTPS. Agents initiate every connection.

| Endpoint | Purpose | Required checks |
|---|---|---|
| `POST /agent/v1/pair` | Exchange one-time code for device credential | Code hash, expiry, user binding, single use |
| `POST /agent/v1/poll` | Long-poll for work/heartbeat/revoke | Device auth, agent binding, protocol version |
| `POST /agent/v1/respond` | Return correlated result | Agent, sequence, correlation, deadline |
| `POST /agent/v1/rotate` | Rotate credential | Current credential and version |

Suggested defaults: 25s poll, 15s heartbeat, 45s offline threshold, 30s normal request timeout, bounded exponential reconnect with jitter.

Every message includes `protocolVersion`, `agentId`, `sequence`, `correlationId`, and deadline where applicable. Reject duplicate, stale, oversized, or mismatched messages.

## MCP ownership

| Method | Owner |
|---|---|
| `initialize`, `tools/list` | Central Router; discovery must not depend on an online agent |
| `tools/call` | Authenticated per-user Agent |
| local `resources/read` | Authenticated per-user Agent |
| central prompts/static resources | Central Router |
| cancellation | Router to the same Agent/correlation ID |

Inventory all server methods before implementation; unclassified methods deny.

## Confirmation

A model-provided `confirmed=true` is not trusted evidence.

- Read: OAuth scope + agent policy.
- Write/process: trusted one-time approval grant bound to user, agent, tool, normalized argument hash, and expiry.
- Agent verifies the grant again before execution.
- Until a trusted ChatGPT signal or organization approval UI is integrated, keep write/process disabled in end-to-end Business testing.

## Failure rules

| Failure | Result |
|---|---|
| Missing/invalid OAuth | `unauthenticated`; no anonymous fallback |
| Missing scope | `forbidden`; do not contact Agent |
| No/offline/revoked Agent | explicit error; no fallback |
| Unknown tool or invalid path/command | `policy_denied` |
| Timeout | cancel pending call; discard late response |
| Registry unavailable | fail closed |

## Future extension

Multiple devices/projects per user are post-MVP. Add registry-issued `projectId` and a trusted default selection UI; never accept raw paths or agent IDs as routing authority.
