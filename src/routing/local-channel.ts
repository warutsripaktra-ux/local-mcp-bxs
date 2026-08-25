import { LocalProjectAgent, type AgentChannel } from "./agent-channel.js";
import { RouterError, userKey, type AgentRegistration, type RoutedMcpRequest, type RoutedMcpResponse } from "./types.js";
import { makeGrant } from "./tool-policy-catalog.js";

// In-process agent channel used for tests and for single-machine demos where
// the central router and a user's agent run in the same process. Production
// deployments replace this with a private-network channel implementation.
export class InProcessAgentChannel implements AgentChannel {
  private readonly agents = new Map<string, LocalProjectAgent>();

  registerAgent(agent: LocalProjectAgent): void {
    this.agents.set(agent.registration.agentId, agent);
  }

  async send(agentId: string, request: RoutedMcpRequest): Promise<RoutedMcpResponse> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new RouterError("agent_unknown", `Unknown agent: ${agentId}`, request.correlationId);
    }
    // Within this trusted single process the channel mints a grant bound to the
    // real user+agent+args. A production channel must require an externally
    // minted grant from the router/UI instead of self-approving.
    const grant = makeGrant(userKey(agent.registration.user), agent.registration.agentId, request.tool, request.args);
    const result = await agent.handle(request, grant);
    return result;
  }

  async status(agentId: string): Promise<"online" | "offline" | "revoked" | "unknown"> {
    const agent: AgentRegistration | undefined = this.agents.get(agentId)?.registration;
    if (!agent) return "unknown";
    return agent.status;
  }
}
