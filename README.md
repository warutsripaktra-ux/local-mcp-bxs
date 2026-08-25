# Futuremakers Gateway MCP

Local MCP server with filesystem, search, file editing, process, PDF, DOCX, and Excel tools. ChatGPT Web reaches the central MCP runtime through OpenAI Secure MCP Tunnel. A user-machine agent can apply a separate project policy before local tools run.

## Central machine

```bash
pnpm install
pnpm run build
pnpm run tunnel
```

Run `pnpm run build` after source changes. `pnpm run tunnel` refreshes the
`tunnel-client` profile, runs `doctor`, and starts the prebuilt runtime without
compiling TypeScript. Keep the terminal open. Do not run `pnpm start` or
`pnpm gateway mcp` separately.

## Setup

```bash
cp .env.example .env
```

Set values in `.env`:

```dotenv
CONTROL_PLANE_TUNNEL_ID=tunnel_...
CONTROL_PLANE_API_KEY=sk-...
TUNNEL_CLIENT_BIN=/absolute/path/to/tunnel-client
TUNNEL_PROFILE=futuremakers-gateway
OIDC_ISSUER=https://idp.example.com/
OIDC_AUDIENCE=https://mcp.example.com
OIDC_AGENT_CLIENT_ID=futuremakers-local-agent
# macOS:
ROUTER_REGISTRY_FILE=/Users/your-user/.futuremakers-gateway/agents.json
ROUTER_CREDENTIAL_FILE=/Users/your-user/.futuremakers-gateway/credentials.json
# Linux alternative:
# ROUTER_REGISTRY_FILE=/var/lib/futuremakers-gateway/agents.json
# ROUTER_CREDENTIAL_FILE=/var/lib/futuremakers-gateway/credentials.json
```

Choose only one OS-specific path. The Router creates the parent directory and
JSON files automatically. On macOS, the directory can be prepared with
`mkdir -p ~/.futuremakers-gateway && chmod 700 ~/.futuremakers-gateway`. On
Linux service deployments, ensure the service user can write to
`/var/lib/futuremakers-gateway`.

`CONTROL_PLANE_API_KEY` must be Runtime API key with `Tunnels Read` and `Tunnels Use`. Never commit or share it. Revoke exposed keys.

Create a tunnel at [OpenAI Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels), then create the runtime key at [OpenAI Platform API keys](https://platform.openai.com/settings/organization/api-keys).

Use the same OpenAI Organization for both values. The key must have `Tunnels Read` and `Tunnels Use`; `Tunnels Manage` is needed only for creating or editing tunnels. Do not use the tunnel ID as the API key, and do not use an Admin API key for the long-running client.

1. Create or select a tunnel at [Tunnels settings](https://platform.openai.com/settings/organization/tunnels) and copy its `tunnel_...` ID.
2. Open [API keys](https://platform.openai.com/settings/organization/api-keys) and create a Runtime API key.
3. Grant or select `Tunnels Read` and `Tunnels Use` permissions.
4. Put both values in local `.env` only.

For `tunnel-client`, you can use the bundled macOS binary from this repository:

```dotenv
TUNNEL_CLIENT_BIN=/absolute/path/to/local-gateway-mcp/tunnel-client/macOS/tunnel-client
```

For a Debian/Ubuntu x86_64 host, use the bundled Linux amd64 full client:

```dotenv
TUNNEL_CLIENT_BIN=/absolute/path/to/local-gateway-mcp/tunnel-client/linux/tunnel-client
```

The bundled Linux client is the full client required by `pnpm run tunnel`
(`init`, `doctor`, and `run`). ARM hosts must download the matching Linux
arm64 release artifact instead.

Or download `tunnel-client` from the [official releases](https://github.com/openai/tunnel-client/releases/latest) and point `TUNNEL_CLIENT_BIN` to that binary. If `TUNNEL_CLIENT_BIN` is not set, the launcher also searches for `tunnel-client` on your `PATH`.

After `pnpm run build` passes, run `pnpm run tunnel`, then open ChatGPT Web Developer mode, go to [Connectors](https://chatgpt.com/#settings/Connectors), add a Tunnel connector, and select `CONTROL_PLANE_TUNNEL_ID`. The Router uses the organization's existing OIDC provider; configure the public PKCE client `OIDC_AGENT_CLIENT_ID` and the ChatGPT OAuth/resource settings with that provider.

## User-machine agent

On a user machine, run the policy-bound agent:

```bash
pnpm run build
pnpm run agent
```

Minimum project-scoped configuration:

On first run, the command opens the organization's OAuth login in a browser,
provisions the machine automatically, stores its device credential in the OS
keychain, and starts the agent. Users do not edit `.env` or handle device
credentials. Later runs reuse the stored credential.

`PROJECT_ROOTS` accepts comma-separated absolute paths. The agent is deny-by-default: enabling `ALLOW_READ` or `ALLOW_WRITE` without a project root fails, and process execution requires an explicit `ALLOWED_COMMANDS` list. Do not set `DC_AGENT_POLICY` or `DC_REMOTE_DEVICE` manually; `scripts/run-agent.cjs` creates them for the child MCP process.

The default `ALLOWED_COMMANDS=*` enables every local command so the connected ChatGPT App can use the complete process tool surface. On macOS, `open`, `osascript`, and `screencapture` allow it to open applications or URLs, send System Events mouse/keyboard actions, capture the screen, and inspect the resulting image with `read_file`. This is equivalent to granting the authenticated user a remote shell; replace `*` with a comma-separated allowlist in restricted deployments. macOS must also grant Accessibility and Screen Recording permissions to the terminal or Node.js process running `pnpm agent`.

The `.env.example` file currently uses whole-machine defaults (`PROJECT_ROOTS=/`, read/write/process enabled) for local single-user development. Review and narrow these values before connecting the agent to a shared ChatGPT Business App.

For macOS/Linux, whole-machine mode can use `PROJECT_ROOTS=/`, but this exposes sensitive files such as SSH keys, credentials, and other user data. It is strongly discouraged for a shared ChatGPT Business App. Use the narrowest project root that satisfies the task.

The pairing endpoints remain available only for operator-driven recovery. The
normal user-facing flow is OAuth bootstrap through
`GET /agent/v1/bootstrap-config` and `POST /agent/v1/bootstrap`.

## MCP Tools

Server exposes local tools for:

- Read/write/create/move files and directories
- Search files and content
- Edit blocks and code
- Start, inspect, interact with, and stop processes
- Read and create PDF, DOCX, Excel, and text files
- Inspect machine and project state

## Commands

```bash
pnpm run tunnel
pnpm run build
pnpm run agent
pnpm run test:tunnel
pnpm run test:routing
```

`pnpm run tunnel` is for starting a prebuilt Central runtime. Use
`pnpm run build` after source changes or on the development machine.
`pnpm run agent` is for a user machine and starts the local policy-bound runtime.

## Security

Tunnel uses outbound HTTPS. No public MCP port opens. Never share `CONTROL_PLANE_API_KEY` with user machines or other users. ChatGPT can invoke every tool exposed by the connected runtime, including file writes and process execution; keep `PROJECT_ROOTS` narrow, use an explicit process allowlist, and review prompts and tool confirmations carefully. Whole-machine mode increases the impact of prompt injection or a compromised account.
