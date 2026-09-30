import { join } from "node:path";
import { PolicyEngine } from "./policy.js";
import { LocalProjectAgent } from "./agent-channel.js";
import { StdioMcpRuntime, type JsonRpcMessage } from "./stdio-mcp-runtime.js";
import { AgentClient } from "./agent-client.js";
import { loadAgentPolicy, assertSafePolicy } from "./agent-config.js";
import type { AgentRegistration, RoutedMcpRequest, RoutedMcpResponse, Scope, UserSubject } from "./types.js";

// Ties together the local stdio MCP runtime, the deny-by-default policy, and
// the outbound router client (plan Phase 5). One controller per agent
// lifecycle: it owns device auth, polling, heartbeat (via poll), local policy,
// child lifecycle, and reconnect.

export type AgentControllerOptions = {
  baseUrl: string;
  credentialId: string;
  secret: string;
  user: UserSubject;
  agentId: string;
  roots: string[];
  capabilities?: Scope[];
  childEntry?: string;
  pollTimeoutMs?: number;
};

export class AgentController {
  private readonly runtime: StdioMcpRuntime;
  private readonly agent: LocalProjectAgent;
  private readonly client: AgentClient;

  constructor(opts: AgentControllerOptions) {
    const policy = loadAgentPolicy();
    assertSafePolicy(policy);
    const entry = opts.childEntry ?? join(process.cwd(), "dist", "index.js");
    const childEnv = { ...process.env };
    for (const secretName of ["CONTROL_PLANE_TUNNEL_ID", "CONTROL_PLANE_API_KEY", "TUNNEL_CLIENT_BIN"]) delete childEnv[secretName];
    this.runtime = new StdioMcpRuntime(process.execPath, [entry], {
      ...childEnv,
      DC_AGENT_POLICY: JSON.stringify(policy),
      DC_REMOTE_DEVICE: "true",
    });

    const capabilities: Scope[] = opts.capabilities ?? ["project:read", "project:write", "project:process"];
    const registration: AgentRegistration = {
      agentId: opts.agentId,
      user: opts.user,
      projectLabel: opts.agentId,
      capabilities,
      roots: opts.roots,
      lastHeartbeatAt: new Date().toISOString(),
      status: "online",
    };
    const engine = new PolicyEngine(policy);
    this.agent = new LocalProjectAgent(registration, engine, (req: RoutedMcpRequest) => this.relay(req));
    this.client = new AgentClient({ baseUrl: opts.baseUrl, credentialId: opts.credentialId, secret: opts.secret, agent: this.agent, pollTimeoutMs: opts.pollTimeoutMs });
  }

  private async relay(req: RoutedMcpRequest): Promise<RoutedMcpResponse> {
    const msg: JsonRpcMessage = await this.runtime.request({ method: "tools/call", params: { name: req.tool, arguments: req.args } });
    return {
      correlationId: req.correlationId,
      result: msg.result,
      error: msg.error ? { code: String((msg.error as { code?: unknown }).code ?? "error"), message: String((msg.error as { message?: unknown }).message ?? "error") } : undefined,
    };
  }

  async start(): Promise<void> {
    await this.runtime.start();
    // Initialize the child MCP session so it accepts subsequent tool calls.
    try {
      await this.runtime.request({ method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "local-agent", version: "1" } } });
      await this.runtime.request({ method: "notifications/initialized" });
    } catch {
      // some runtimes accept tool calls without an explicit handshake
    }
    void this.client.run();
  }

  stop(): void {
    this.client.stop();
    this.runtime.stop();
  }
}
