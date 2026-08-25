# Deployment and Operations

## Prerequisites

- Central host reachable from user machines over organization-controlled private networking.
- Outbound HTTPS from central host to OpenAI.
- Established organizational OAuth/OIDC provider reachable by the browser flow; this repository does not host the authorization server.
- Provider discovery issuer exactly matches `OIDC_ISSUER` and supplies a valid `jwks_uri`.
- `OIDC_AUDIENCE` is the canonical public HTTPS MCP resource configured for ChatGPT and the IdP.
- Tunnel associated with the target ChatGPT workspace.
- Operator has Tunnels Read + Use; workspace admin can publish plugins.
- TLS/mTLS material and persistent registry/audit storage.

## Central deployment order

1. Create service account and restricted state/log directories.
2. Configure central variables from `03-configuration-and-secrets.md`.
3. Fetch the provider discovery document; verify exact issuer, endpoints, PKCE `S256`, registration mode, and `jwks_uri`.
4. Start persistent registry/audit dependencies.
5. Start Central HTTP Router.
6. Verify `/healthz` and `/readyz` locally.
7. Initialize Tunnel profile with Router `/mcp` URL.
8. Run `tunnel-client doctor --profile <name> --explain`.
9. Start `tunnel-client` under the service manager.
10. Verify Tunnel health/admin surfaces from the operator host only.
11. Fetch the public protected-resource metadata and confirm its `resource` exactly equals `OIDC_AUDIENCE` and contains `OIDC_ISSUER`.
12. Verify `tools/list` OAuth `securitySchemes` and both HTTP/MCP auth challenges before onboarding users.

Router and Tunnel must be separate managed processes with automatic restart and bounded backoff.

## User onboarding

1. Install dependencies and build the Agent package.
2. Create local Agent configuration; never copy central Tunnel secrets.
3. User runs `pnpm run agent` and signs in with the same organizational identity used in ChatGPT.
4. The Agent exchanges the OAuth token for a device credential and stores it in the OS keychain.
5. The Agent starts the local stdio relay and reconnects automatically on later runs.
6. Start Agent under launchd/systemd or the approved desktop service manager.
7. Verify online status and last heartbeat centrally.
8. Run a read-only test from ChatGPT.
9. Enable write/process only after trusted confirmation is verified.

For requested whole-machine mode, present a clear warning and start on a non-production machine.

## App and plugin packaging

The ChatGPT App is the registered Tunnel-backed MCP connection. The plugin package references that App and supplies workspace distribution metadata.

Expected package:

```text
futuremakers-plugin/
  .codex-plugin/plugin.json
  .app.json
  assets/
    icon.png
    logo.png
```

Process:

1. Register the Tunnel connection in ChatGPT developer mode.
2. Configure the selected OAuth client mode and copy the exact redirect URI shown by ChatGPT into the IdP allowlist.
3. Complete a real linking flow and verify bearer audience/resource before packaging.
4. Copy the resulting `plugin_asdk_app...` technical ID.
5. Reference it from `.app.json`.
6. Add `.codex-plugin/plugin.json` metadata and workspace-facing assets.
7. Build a `.zip` from an explicit file allowlist.
8. Reject archives containing `.env`, credentials, state databases, logs, absolute local paths, symlinks, source maps with secrets, or `node_modules`.
9. Install/test the archive as a personal plugin.
10. Workspace admin publishes it to selected roles.
11. Verify an allowed and denied account.

Secure MCP Tunnel is for private connectivity and workspace testing/use; do not use this plan for public Plugins Directory submission.

## Pilot

Use two users and two machines:

1. Read-only identity/routing tests.
2. Concurrent calls and state isolation.
3. Offline/reconnect/revoke tests.
4. Trusted write confirmation.
5. Trusted process confirmation and command allowlist.
6. Whole-machine prompt-injection/security tests.
7. Audit and support review.

Publish broadly only after the full matrix passes.

## Health and alerts

Monitor:

- Router liveness/readiness.
- Tunnel client connected/polling state.
- Registry/store availability.
- Online/offline/revoked agents and heartbeat age.
- Queue depth, request latency, timeout, duplicate/late response.
- OAuth failures, scope denies, policy denies, pairing/revoke events.

Alert on:

- Router/Tunnel unavailable.
- Registry failure.
- Sustained queue growth or timeout rate.
- Repeated auth failures for one user/device.
- Agent flapping or unexpected replacement.
- Secret scan/audit persistence failure.

## Backup and restore

- Back up registry, credential versions, revocation state, and required audit metadata.
- Encrypt backups and restrict access to operators.
- Never back up raw pairing codes.
- Test restore to an isolated host.
- After restore, verify revoked devices remain revoked and rotate central secrets if host identity changed.

## Credential rotation

Tunnel API key:

1. Create replacement runtime key with Tunnels Read + Use.
2. Update central secret store and restart Tunnel.
3. Verify health, then revoke old key.

Device credential:

1. Issue new credential version over authenticated channel.
2. Agent confirms use of new version.
3. Fence old version; revoke immediately on loss/compromise.

OAuth signing keys are handled through JWKS rotation/cache policy; unknown or retired keys must fail closed.

## Incident runbooks

### Lost/compromised user machine

1. Revoke Agent centrally.
2. Invalidate device credential version.
3. Review recent audit events.
4. Remove/disable user App access if needed.
5. Re-pair only after device remediation.

### Tunnel API key exposure

1. Revoke/rotate the key immediately.
2. Restart Tunnel with replacement key.
3. Review Platform and local audit metadata.
4. Confirm no key exists in Git, archives, logs, or chat history.

### Cross-user routing suspicion

1. Disable write/process and stop Agent dispatch.
2. Preserve redacted audit/state evidence.
3. Revoke affected devices/tokens.
4. Reproduce with A/B isolation tests.
5. Resume only after root cause and regression test are complete.

### Router/registry failure

Fail closed. Do not use an unverified cached/fallback Agent mapping. Restore service/state, verify revocations, then reopen traffic.

## Update and rollback

- Version Router, Agent protocol, plugin, and state schema independently.
- Support only explicitly listed protocol versions.
- Deploy Router backward-compatible with current Agents before Agent rollout.
- Roll Agents gradually; monitor errors.
- Plugin updates follow personal install test, workspace pilot, then role rollout.
- Rollback must not restore revoked credentials or weaken policy/confirmation.

## Operational sign-off

- Services recover after reboot.
- Health/alerts reach an owner.
- Backup/restore and revoke/rotation drills pass.
- Onboarding/offboarding instructions are tested.
- Plugin access roles are documented.
- Security owner accepts whole-machine risk and confirmation model.
