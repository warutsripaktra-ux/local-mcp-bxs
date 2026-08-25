# Testing and Security

## Threat model

| Threat | Required control |
|---|---|
| Prompt injection requests secrets/destructive actions | scopes, local policy, trusted confirmation, audit |
| User A targets Agent B | OAuth subject registry lookup; no routing args |
| Stolen device credential | agent/user binding, expiry, rotation, immediate revoke |
| Stolen Tunnel API key | central-only storage, least privilege, rotation |
| Path traversal/symlink escape | canonical path checks at Router and Agent |
| Shell wrapper/injection | command parsing/allowlist; deny unknown wrappers |
| Session ID reuse across users | bind search/process sessions to user + agent |
| Unknown tool bypass | complete shared policy catalog; fail closed |
| Model fakes confirmation | signed one-time approval grant |
| Offline agent fallback | explicit offline error; never choose another agent |
| Log/archive secret leak | redaction and automated secret scans |
| Queue exhaustion/large payload | limits, deadlines, per-agent capacity, backpressure |

Whole-machine mode raises impact from project-level to user-machine-level. Security gates remain mandatory even though `/` is the configured root.

## Test layers

### Unit

- OAuth/OIDC discovery, exact issuer matching, JWKS URI validation/cache/rotation.
- Token signature, audience/resource, claims, scopes, clock skew, user key.
- Tool catalog completeness and argument extraction.
- Path canonicalization, missing targets, symlinks, multi-path operations.
- Command allowlist, shell separators/wrappers, empty/malformed commands.
- Registry ownership, liveness, replace, revoke.
- Redaction and error mapping.

### Contract

- Agent protocol schemas/versioning.
- Sequence/correlation/deadline rules.
- MCP method ownership and tool catalog parity.
- Confirmation grant binding and expiry.
- Persistence migrations and restart behavior.

### Integration

- HTTP Router with real MCP transport.
- Established IdP discovery and JWKS verifier with key rotation/error cases.
- Canonical public resource metadata, per-tool `securitySchemes`, HTTP challenge, and MCP `_meta["mcp/www_authenticate"]` challenge.
- Two Agent processes over HTTPS long-poll.
- Real stdio child for read/write/search/process.
- Disconnect, timeout, duplicate, late response, child crash, central restart.

### End-to-end

- Secure MCP Tunnel discovery and OAuth linking.
- Two ChatGPT Business users, two machines, concurrent calls.
- Workspace role allow/deny.
- Plugin install/update/revoke.

## Required matrix

| Case | Expected |
|---|---|
| A reads/writes/runs allowed command on A | success after required approval |
| B does the same on B | success after required approval |
| A supplies B path/agent/session ID | deny |
| A and B call concurrently | isolated responses/state |
| Missing/expired/wrong issuer/audience token | unauthenticated |
| Discovery issuer differs by slash/path/case/port | startup/auth fails closed |
| Public resource metadata or token audience differs | unauthenticated; no Agent contact |
| Protected tool has no `securitySchemes` or usable auth challenge | release gate fails |
| Missing scope | forbidden before Agent contact |
| Agent credential used for another Agent | deny |
| Agent offline/revoked | explicit error; no fallback |
| Pairing code reused/expired | deny |
| Traversal/symlink escape | deny |
| Source allowed, destination outside root | deny |
| Unknown tool/method | deny |
| Command outside allowlist/wrapped injection | deny |
| Fake confirmation boolean | deny |
| Valid approval reused/modified/expired | deny |
| Duplicate/late Agent response | discard and audit |
| Central/Agent restart | reconnect; mapping/revoke state correct |
| Archive contains `.env` or token pattern | packaging fails |

## Whole-machine tests

Run first on disposable/non-production machines:

- Allowed reads/writes across representative user paths.
- OS-protected paths fail cleanly without permission escalation.
- `.ssh`, cloud credentials, browser data, keychains, and `.env` are not returned unless the user explicitly requests and approves the operation.
- `sudo`, destructive commands, and commands outside `ALLOWED_COMMANDS` deny.
- Prompt-injection fixtures cannot obtain secrets or bypass confirmation.

`PROJECT_ROOTS=/` permits broad paths; it is not permission to bypass OS controls or reveal secrets implicitly.

## Audit assertions

Record:

- timestamp, correlation ID, stable user key, agent ID, tool/action, decision, duration, error code.

Never record:

- bearer/device tokens, pairing codes, file contents, command output by default, OAuth codes, cookies.

Test successful, denied, timeout, revoke, pairing, rotation, and late-response events.

## Release gates

```bash
pnpm run build
pnpm run test:tunnel
pnpm run test:routing
pnpm run test:router-http
pnpm run test:router-oauth
pnpm run test:agent-channel
pnpm run test:e2e-local
git diff --check
```

Additional gates:

- Dependency/security scan reviewed.
- Secret scan passes source and plugin archive.
- Two-user concurrency and cross-user negatives pass.
- ChatGPT linking UI opens from both missing-token and insufficient-scope paths.
- Protected-resource metadata uses the exact public HTTPS MCP resource; no loopback/private URL is advertised.
- Restart/revoke/rotation drills pass.
- Trusted confirmation verified before enabling write/process.
- Security and operations owners approve Business rollout.
