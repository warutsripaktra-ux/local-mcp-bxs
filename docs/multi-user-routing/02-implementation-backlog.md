# Implementation Backlog

`[x]` means scaffolded/tested in the current branch, not production-ready.

## Phase 0 — Policy hardening

Existing:

- [x] Routing types, auth seam, in-memory registry, Router core.
- [x] Path/symlink policy, command allowlist, runtime gates.
- [x] In-process AgentChannel and 30 routing tests.

Tasks:

- [x] Add `src/routing/tool-policy-catalog.ts` as the only scope/argument/confirmation source.
- [x] Remove duplicated `TOOL_SCOPE` maps.
- [ ] Inventory every tool, resource, prompt, notification, path field, command field, and process/search session.
- [x] Deny unknown/unclassified methods and tools.
- [ ] Validate all source/destination/array/nested paths.
- [x] Bind search/process session IDs to user + agent.
- [x] Replace boolean confirmation with a trusted `ConfirmationGrant` type.
- [ ] Add policy completeness, malformed payload, oversized payload, cross-session, and multi-path tests.

Gate: no unclassified MCP operation; all contract tests pass.

## Phase 1 — Central HTTP MCP Router

Add:

- [x] `src/router-entry.ts`
- [x] `src/routing/http-server.ts`
- [x] `src/routing/mcp-adapter.ts`
- [x] `scripts/run-router.cjs`
- [x] `pnpm run router`

Tasks:

- [x] Expose `/mcp`, `/healthz`, `/readyz`.
- [x] Serve `initialize` and discovery without an online Agent.
- [x] Adapt MCP HTTP requests to `RouterModule`.
- [x] Add graceful shutdown and pending-request drain.
- [x] Configure Tunnel with `--mcp-server-url http://127.0.0.1:<port>/mcp`.
- [x] Add local HTTP discovery/read-only integration tests.
- [x] Add Tunnel discovery/read-only integration tests.

Gate: a read-only test call reaches Router through Secure MCP Tunnel.

## Phase 2 — OAuth resource server

Decide:

- [ ] Established organizational IdP; this repository will not implement an authorization server.
- [ ] Exact issuer, canonical public HTTPS MCP resource/audience, scopes, and CIMD/DCR/predefined-client mode.
- [ ] IdP/browser reachability; authorization server is not tunneled automatically.

Existing scaffold:

- [x] Direct-JWKS `TokenVerifier` with JWT signature and basic claim checks.
- [x] Protected-resource metadata endpoint skeleton.
- [x] Basic bearer extraction and HTTP `401` skeleton.

Complete:

- [x] Standardize production names on `OIDC_ISSUER` and `OIDC_AUDIENCE`; remove temporary `ROUTER_ISSUER`, `ROUTER_AUDIENCE`, and production `ROUTER_JWKS_URL` usage.
- [x] Resolve provider-published OAuth/OIDC metadata from `OIDC_ISSUER`, require an exact metadata issuer match, and derive `jwks_uri` automatically.
- [x] Use `OIDC_AUDIENCE` as the exact public HTTPS `resource` in protected-resource metadata and token audience/resource validation.
- [ ] Reject loopback/private resource identifiers in production mode.
- [x] Add per-tool OAuth `securitySchemes` from the shared policy catalog.
- [x] Return HTTP `WWW-Authenticate` with the public `resource_metadata` URL and required scope.
- [x] Return `_meta["mcp/www_authenticate"]` with `resource_metadata`, `error`, and `error_description` for protected tool auth failures.
- [ ] Validate the selected CIMD/DCR/predefined-client flow, PKCE `S256`, redirect URI, and `resource` propagation end to end.

Verify:

- [ ] Discovery, exact issuer matching, signature, `iss`, `aud/resource`, `exp`, `nbf`, scopes, JWKS rotation/cache.
- [ ] `securitySchemes`, protected-resource metadata, HTTP challenge, and MCP challenge contract tests.
- [ ] Authorization header redaction.
- [ ] End-to-end OAuth linking and bearer propagation through Tunnel.

Gate: ChatGPT opens the linking UI; A/B tokens produce distinct stable subjects; canonical resource and all negative auth tests pass.

## Phase 3 — Pairing and persistence

- [x] Add `PairingModule`, `DeviceCredentialModule`, and persistent `RegistryStore` Adapter.
- [x] Generate short-lived, one-time pairing codes bound to authenticated `iss/sub`.
- [x] Store pairing/device verifiers as hashes; never log raw secrets.
- [x] Enforce one active agent per user; replacement requires explicit action.
- [x] Persist heartbeat, offline, revoke, and credential version state.
- [x] Add authenticated admin pair/revoke endpoints.
- [ ] Add restart, reuse, expiry, cross-user, rotation, and revoke tests.

Gate: mapping/revocation survives restart and credentials cannot cross users.

## Phase 4 — Production AgentChannel

- [x] Add Router endpoints for pair/poll/respond/rotate and authenticated admin revoke.
- [x] Add `LongPollAgentChannel` and Agent HTTP client.
- [ ] Authenticate every call; bind credential to agent/user/version.
- [ ] Implement sequence IDs, correlation IDs, deadlines, cancellation, duplicate rejection.
- [ ] Add queue limits, per-agent capacity, payload limits, and backpressure.
- [ ] Add bounded reconnect with jitter and old-connection fencing.
- [ ] Use TLS/mTLS on the private network; no plain HTTP between machines.
- [ ] Add two-process A/B concurrency, disconnect, delay, duplicate, and restart tests.

Gate: two external Agents route concurrently, reconnect, and revoke correctly.

## Phase 5 — Agent Controller and stdio relay

Current `run-agent.cjs` performs OAuth PKCE bootstrap, stores the device
credential securely, and starts the piped stdio relay.

- [x] Add agent config/controller/client/stdio runtime modules.
- [x] Pipe child stdin/stdout; keep logs on stderr.
- [x] Initialize one MCP child per Agent lifecycle.
- [x] Correlate JSON-RPC IDs and reject pending calls on child exit.
- [x] Add bounded child restart; prevent crash loops.
- [x] Enforce shared policy and trusted confirmation locally.
- [ ] Preserve local search/process state and bind sessions to the Agent.
- [ ] Add real-child read/write/search/process/cancel/crash tests.
- [ ] Test requested whole-machine defaults.

Gate: real local tools execute through Router with A/B state isolation.

## Phase 6 — Audit, operations, and package

- [ ] Add persistent, redacted audit Adapter and retention policy.
- [ ] Add metrics for agents, queue, latency, auth failures, policy denies, timeouts.
- [ ] Add central/agent service definitions and reboot recovery.
- [ ] Add registry backup/restore and all credential rotation runbooks.
- [ ] Register the Tunnel-backed MCP App in ChatGPT developer mode.
- [ ] Add plugin `.codex-plugin/plugin.json`, `.app.json`, assets, and version metadata.
- [ ] Add an allowlist-based `.zip` packaging script.
- [ ] Validate archive structure and scan for `.env`, secrets, local paths, and symlinks.

Gate: restart/backup/rotation drills pass; clean archive installs successfully.

## Phase 7 — Business pilot

- [ ] Associate Tunnel with the target ChatGPT workspace.
- [ ] Verify creator permissions: Tunnels Read + Use and required workspace access.
- [ ] Pilot with two real users and two machines.
- [ ] Validate authorized and unauthorized workspace roles.
- [ ] Enable read first; enable write/process only after trusted confirmation passes.
- [ ] Test whole-machine mode on non-production machines first.
- [ ] Review audit, latency, offline behavior, and support workflow.

Gate: full matrix in `04-testing-and-security.md` passes.

## Phase 8 — Workspace rollout

- [ ] Obtain security and operations sign-off.
- [ ] Publish to selected workspace roles; do not submit publicly.
- [ ] Verify allowed/denied roles after publication.
- [ ] Document support, revoke, offboarding, rollback, and incident ownership.

Gate: approved roles can use the App, denied roles cannot, and operations owners accept the runbooks.

## Verification commands

```bash
pnpm run build
pnpm run test:tunnel
pnpm run test:routing
pnpm run test:router-http
pnpm run test:router-oauth
git diff --check
```

Add phase-specific scripts: `test:agent-channel` and `test:e2e-local`.

## Suggested PR order

1. Policy catalog/hardening
2. HTTP Router
3. OAuth/JWKS
4. Registry/pairing
5. Long-poll AgentChannel
6. Agent Controller/stdio relay
7. Audit/operations
8. Plugin package/Business rollout

Each PR must keep incomplete capabilities unreachable from production paths.
