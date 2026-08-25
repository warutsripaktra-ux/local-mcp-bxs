import { AuthAdapter } from "./auth.js";
import { AgentRegistry } from "./registry.js";
import { AgentChannel } from "./agent-channel.js";
import { audit } from "./audit.js";
import { describeTool } from "./tool-policy-catalog.js";
import {
  RouterError,
  userKey,
  type RoutedMcpRequest,
  type RoutedMcpResponse,
  type Scope,
} from "./types.js";

export type McpRouterConfig = {
  forwardTimeoutMs: number;
};

// Central router. Authenticates the user, resolves their registered agent,
// rejects scope/offline/revoked conditions, then forwards over the private
// agent channel. It never reads project files itself.
export class McpRouter {
  constructor(
    private readonly auth: AuthAdapter,
    private readonly registry: AgentRegistry,
    private readonly channel: AgentChannel,
    private readonly config: McpRouterConfig = { forwardTimeoutMs: 30_000 },
  ) {}

  async handleRequest(
    authorization: string | undefined,
    request: RoutedMcpRequest,
  ): Promise<RoutedMcpResponse> {
    const user = await this.auth.authenticate(authorization);

    const agent = this.registry.getByUser(user.subject);
    if (!agent) {
      audit({ correlationId: request.correlationId, user: userKey(user.subject), tool: request.tool, action: "deny", result: "denied", errorCode: "agent_unknown" });
      throw new RouterError("agent_unknown", "No agent registered for user", request.correlationId);
    }
    if (agent.status === "revoked") {
      audit({ correlationId: request.correlationId, user: userKey(user.subject), agent: agent.agentId, tool: request.tool, action: "deny", result: "denied", errorCode: "agent_revoked" });
      throw new RouterError("agent_revoked", "Agent revoked", request.correlationId);
    }
    if (!this.registry.isOnline(agent)) {
      audit({ correlationId: request.correlationId, user: userKey(user.subject), agent: agent.agentId, tool: request.tool, action: "deny", result: "denied", errorCode: "agent_offline" });
      throw new RouterError("agent_offline", "Agent offline", request.correlationId);
    }

    const policy = describeTool(request.tool);
    if (!policy) {
      // Unknown/unclassified tool: deny by default. The catalog is the only
      // source of truth; anything absent from it must never reach a machine.
      audit({ correlationId: request.correlationId, user: userKey(user.subject), agent: agent.agentId, tool: request.tool, action: "deny", result: "denied", errorCode: "policy_denied" });
      throw new RouterError("policy_denied", `Unclassified tool: ${request.tool}`, request.correlationId);
    }

    const scope: Scope = policy.scope;
    this.auth.assertScope(user, scope);
    // Agent must actually advertise the capability for this tool.
    if (!agent.capabilities.includes(scope)) {
      audit({ correlationId: request.correlationId, user: userKey(user.subject), agent: agent.agentId, tool: request.tool, action: "deny", result: "denied", errorCode: "forbidden" });
      throw new RouterError("forbidden", `Agent lacks capability: ${scope}`, request.correlationId);
    }

    // Stamp the resolved identity so the agent can bind session identifiers.
    request.owner = { userKey: userKey(user.subject), agentId: agent.agentId };

    audit({ correlationId: request.correlationId, user: userKey(user.subject), agent: agent.agentId, tool: request.tool, action: "request" });

    const timer = new Promise<RoutedMcpResponse>((_, reject) =>
      setTimeout(
        () => reject(new RouterError("timeout", "Agent request timed out", request.correlationId)),
        this.config.forwardTimeoutMs,
      ),
    );

    try {
      const res = await Promise.race([this.channel.send(agent.agentId, request), timer]);
      audit({ correlationId: request.correlationId, user: userKey(user.subject), agent: agent.agentId, tool: request.tool, action: "forward", result: res.error ? "error" : "ok" });
      return res;
    } catch (err) {
      if (err instanceof RouterError) {
        audit({ correlationId: request.correlationId, user: userKey(user.subject), agent: agent.agentId, tool: request.tool, action: "error", result: "denied", errorCode: err.code });
        throw err;
      }
      throw new RouterError("timeout", `Forward failed: ${err instanceof Error ? err.message : "unknown"}`, request.correlationId);
    }
  }
}
