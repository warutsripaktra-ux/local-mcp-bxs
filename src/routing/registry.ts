import { RouterError, userKey, type AgentRegistration, type UserSubject } from "./types.js";
import { type RegistryStore, toPersisted } from "./persistence.js";

export type RegistryConfig = {
  // Heartbeat older than this (ms) marks the agent offline.
  offlineAfterMs: number;
  // Optional persistent store; registry state survives restarts when set.
  store?: RegistryStore;
};

// Maps UserSubject -> AgentRegistration and tracks liveness. Prevents one
// agent from registering for another user: registration is bound to the
// authenticated subject supplied by the caller, never to a self-asserted field
// in the registration payload.
export class AgentRegistry {
  private readonly agents = new Map<string, AgentRegistration>();
  private readonly config: RegistryConfig;

  constructor(config: RegistryConfig) {
    this.config = config;
    if (config.store) {
      for (const a of config.store.load()) {
        this.agents.set(a.agentId, a as AgentRegistration);
      }
    }
  }

  private persist(): void {
    if (this.config.store) {
      this.config.store.save(toPersisted([...this.agents.values()]));
    }
  }

  register(
    agent: Omit<AgentRegistration, "lastHeartbeatAt" | "status">,
    authenticatedUser: UserSubject,
  ): AgentRegistration {
    if (userKey(agent.user) !== userKey(authenticatedUser)) {
      throw new RouterError(
        "forbidden",
        "Agent cannot register for a different user",
        "n/a",
      );
    }
    // One active agent per user (MVP): refuse to register a second one.
    const existing = this.getByUser(authenticatedUser);
    if (existing && existing.status !== "revoked") {
      throw new RouterError("forbidden", "User already has an active agent; replace explicitly", "n/a");
    }
    const full: AgentRegistration = {
      ...agent,
      lastHeartbeatAt: new Date().toISOString(),
      status: "online",
    };
    this.agents.set(agent.agentId, full);
    this.persist();
    return full;
  }

  // Explicit replacement: revoke the current agent, then register the new one.
  replaceAgent(
    agent: Omit<AgentRegistration, "lastHeartbeatAt" | "status">,
    authenticatedUser: UserSubject,
  ): AgentRegistration {
    const existing = this.getByUser(authenticatedUser);
    if (existing) this.revoke(existing.agentId);
    return this.register(agent, authenticatedUser);
  }

  heartbeat(agentId: string): AgentRegistration {
    const existing = this.agents.get(agentId);
    if (!existing) {
      throw new RouterError("agent_unknown", `Unknown agent: ${agentId}`, "n/a");
    }
    if (existing.status === "revoked") {
      throw new RouterError("agent_revoked", `Agent revoked: ${agentId}`, "n/a");
    }
    existing.lastHeartbeatAt = new Date().toISOString();
    existing.status = "online";
    this.persist();
    return existing;
  }

  revoke(agentId: string): void {
    const existing = this.agents.get(agentId);
    if (!existing) {
      throw new RouterError("agent_unknown", `Unknown agent: ${agentId}`, "n/a");
    }
    existing.status = "revoked";
    this.persist();
  }

  get(agentId: string): AgentRegistration | undefined {
    return this.agents.get(agentId);
  }

  getByUser(user: UserSubject): AgentRegistration | undefined {
    const key = userKey(user);
    let revoked: AgentRegistration | undefined;
    for (const agent of this.agents.values()) {
      if (userKey(agent.user) === key) {
        if (agent.status !== "revoked") return agent;
        revoked = agent;
      }
    }
    return revoked;
  }

  isOnline(agent: AgentRegistration, now: number = Date.now()): boolean {
    if (agent.status === "revoked") return false;
    const last = Date.parse(agent.lastHeartbeatAt);
    return now - last <= this.config.offlineAfterMs;
  }

  list(): AgentRegistration[] {
    return [...this.agents.values()];
  }
}
