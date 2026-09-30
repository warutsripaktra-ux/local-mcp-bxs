# Multi-User Routing Plan

Updated: 2026-08-21
Goal: one ChatGPT Business App that automatically routes each authenticated user to the agent running on that user's machine.

## Target

```text
ChatGPT Business App
  -> OAuth user identity
  -> OpenAI Secure MCP Tunnel
  -> Central HTTP MCP Router (one central host)
  -> authenticated outbound agent channel
  -> User Agent A/B/... -> local filesystem and processes
```

Required behavior:

- One workspace App and one central `tunnel-client`.
- Route only by verified OAuth `iss + sub`; model/user arguments cannot select an agent.
- One active agent per user in MVP.
- User machines never receive `CONTROL_PLANE_API_KEY`.
- Concurrent users remain isolated; no offline fallback to another agent.
- Workspace-only publishing; no public plugin submission.
- Agent defaults remain whole-machine on macOS/Linux as requested:

  ```dotenv
  PROJECT_ROOTS=/
  ALLOW_READ=true
  ALLOW_WRITE=true
  ALLOW_PROCESS=true
  ALLOWED_COMMANDS=*
  REQUIRE_CONFIRMATION_FOR=project:write,project:process
  ```

## Decisions

- Central Router: HTTP MCP server behind Secure MCP Tunnel.
- Agent transport: outbound HTTPS long-poll; user machines expose no inbound port.
- Identity: OAuth 2.1/OIDC for users; separate short-lived/rotatable device credentials for agents.
- Identity provider: use an established organizational IdP; do not build an authorization server in this repository.
- Discovery: configure `OIDC_ISSUER`; resolve its published OAuth/OIDC metadata and `jwks_uri` automatically.
- Resource identity: `OIDC_AUDIENCE` is the canonical public HTTPS MCP resource seen by ChatGPT, not a loopback or private Router URL.
- Linking: every protected tool advertises OAuth, and auth failures return both the HTTP and MCP challenges required to open ChatGPT's linking UI.
- Local runtime: existing MCP server as a stdio child controlled by the Agent process.
- Authorization: one shared fail-closed tool policy catalog enforced at Router and Agent.
- Persistence: persistent registry/audit adapters; in-memory adapters remain test-only.
- Confirmation: write/process require a trusted approval grant; a model-provided boolean is invalid.

## Current baseline

Implemented in the current branch:

- `AuthAdapter`, in-memory `AgentRegistry`, `McpRouter`, `ProjectPolicy`, and `InProcessAgentChannel`.
- Shared tool policy catalog, fail-closed unknown-tool handling, session ownership, and typed confirmation grants.
- HTTP Router with `/mcp`, health/readiness, protected-resource metadata skeleton, and graceful shutdown.
- JWT/JWKS verifier with OIDC discovery, exact issuer validation, signature/claim checks, and rotation refetch.
- File/memory persistence adapters connected to the production composition root.
- Runtime filesystem/process gates through `DC_AGENT_POLICY`.
- `pnpm run agent` performs OAuth PKCE bootstrap on first run, stores the device credential securely, then starts the piped stdio runtime plus outbound agent channel; users do not edit `.env`.
- Routing, Router HTTP, OAuth, pairing, relay, tunnel, audit, and package tests pass.

Still requires deployment-specific acceptance:

- The actual organizational IdP, public HTTPS resource, ChatGPT OAuth client/linking configuration, and private network TLS are not testable in this repository.
- Pairing codes are intentionally short-lived in Router memory and are only for operator recovery; normal users use OAuth bootstrap.
- Tool inventory and nested/multi-path validation are not yet proven complete.
- Confirmation remains local policy/grant based; configure the file audit sink and complete operational service/package rollout before Business pilot.

## Documents

1. [Architecture and Protocol](multi-user-routing/01-architecture-and-protocol.md)
2. [Implementation Backlog](multi-user-routing/02-implementation-backlog.md)
3. [Configuration and Secrets](multi-user-routing/03-configuration-and-secrets.md)
4. [Testing and Security](multi-user-routing/04-testing-and-security.md)
5. [Deployment and Operations](multi-user-routing/05-deployment-and-operations.md)

## Phase gates

| Phase | Deliverable | Gate |
|---|---|---|
| 0 | Shared policy catalog and hardened routing core | Unknown methods deny; contract tests pass |
| 1 | Central HTTP MCP Router | Discovery/read-only call works through Tunnel |
| 2 | OAuth resource server | ChatGPT linking, A/B identity, canonical resource, and negative auth tests pass |
| 3 | Pairing and persistence | Mapping/revocation survives restart |
| 4 | Production AgentChannel | Two external agents route/reconnect/revoke correctly |
| 5 | Real local stdio relay | Filesystem/process integration tests pass |
| 6 | Audit, health, packaging | Restart/rotation/archive checks pass |
| 7 | Two-user Business pilot | Full acceptance matrix passes |
| 8 | Workspace rollout | Security and operations sign-off |

## Definition of done

- A cannot route to B by prompt, path, user ID, or agent ID.
- User/agent token expiry and revocation are enforced.
- Router/agent restarts preserve mapping and revocation state.
- Every MCP method/tool has scope, argument, confirmation, timeout, and audit policy.
- Whole-machine mode passes prompt-injection, path, command, and secret-leak tests.
- Audit stores metadata only; no bearer/device secrets or file contents.
- Plugin archive contains no `.env`, credentials, local paths, or generated secrets.
- Authorized workspace roles can use the App; unauthorized accounts cannot.
- All build, tunnel, routing, integration, archive, and `git diff --check` gates pass.

## Non-goals for MVP

- Multiple active agents/projects per user.
- Agent selection from model arguments.
- Public user-agent endpoints or third-party tunnels.
- Public Plugins Directory submission.
- Telemetry, remote feature flags, onboarding launches, or Supabase device channels.

## Official references

- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Plugin authentication](https://developers.openai.com/plugins/build/auth)
- [Plugin packaging and workspace publishing](https://developers.openai.com/plugins/build/plugins)

## Immediate next task

Complete the remaining Phase 0 policy inventory and Phase 1 Tunnel integration in the [Implementation Backlog](multi-user-routing/02-implementation-backlog.md). Before Phase 2, choose the established IdP and canonical public MCP resource; do not implement a custom authorization server.
