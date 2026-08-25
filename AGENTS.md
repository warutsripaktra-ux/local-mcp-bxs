# Agent Rules

## Runtime Boundary

- Use only local MCP runtime code and OpenAI Secure MCP Tunnel.
- Do not call or add dependencies on `desktopcommander.app`, `telemetry.desktopcommander.app`, or `dc-telemetry-proxy-83847352264.europe-west1.run.app`.
- Keep `CONTROL_PLANE_TUNNEL_ID`, `CONTROL_PLANE_API_KEY`, and `TUNNEL_CLIENT_BIN` in ignored local `.env` only.
- Do not add telemetry, remote feature flags, onboarding browser launches, Supabase device channels, or third-party public tunnels.

## Git

- Never commit or push directly from `master`.
- Create a new branch from current `master` before editing.
- Commit and push only feature/fix branches.
- Never include `.env`, API keys, tokens, or generated secrets in commits.

## Verification

- Run `pnpm run build`.
- Run `pnpm run test:tunnel`.
- Run `git diff --check` before commit.
