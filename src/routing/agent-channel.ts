import { RouterError, userKey, type AgentRegistration, type RoutedMcpRequest, type RoutedMcpResponse } from "./types.js";
import { PolicyEngine } from "./policy.js";
import {
  describeTool,
  verifyGrant,
  MAX_ARGS_BYTES,
  type ConfirmationGrant,
} from "./tool-policy-catalog.js";

// Transport between the central router and a user-machine agent. The concrete
// implementation owns the private authenticated channel (corporate LAN / VPN /
// tunnel). The router only depends on this interface.
export interface AgentChannel {
  send(agentId: string, request: RoutedMcpRequest): Promise<RoutedMcpResponse>;
  status(agentId: string): Promise<"online" | "offline" | "revoked" | "unknown">;
}

// Binds a search/process session identifier to the user+agent that first used
// it, so a session created by one user can never be driven by another within
// the same agent process. Keyed by sessionId -> ownerKey.
const SESSION_OWNERS = new Map<string, string>();

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asSessionIdentifier(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return asString(value);
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

// Runs on the user's machine. Enforces the project policy as the final, local
// gate before any filesystem/process tool runs — defense in depth behind the
// router. Does not open a public port; it is reached only via the AgentChannel.
export class LocalProjectAgent {
  readonly registration: AgentRegistration;
  private readonly policy: PolicyEngine;
  private readonly inner: (request: RoutedMcpRequest) => Promise<RoutedMcpResponse>;

  constructor(
    registration: AgentRegistration,
    policy: PolicyEngine,
    inner: (request: RoutedMcpRequest) => Promise<RoutedMcpResponse>,
  ) {
    this.registration = registration;
    this.policy = policy;
    this.inner = inner;
  }

  private ownerKey(request: RoutedMcpRequest): string {
    if (request.owner) return request.owner.userKey;
    return userKey(this.registration.user);
  }

  // Apply deny-by-default policy for one tool call using the shared catalog.
  // `grant` is a trusted, router/UI-minted approval for confirmation-gated
  // operations; a model-provided boolean is never accepted.
  enforce(request: RoutedMcpRequest, grant: ConfirmationGrant | undefined): void {
    const policy = describeTool(request.tool);
    if (!policy) {
      // Unknown tool must never run on the user's machine.
      throw new RouterError("policy_denied", `Unclassified tool: ${request.tool}`, request.correlationId);
    }

    if (Buffer.byteLength(JSON.stringify(request.args), "utf8") > MAX_ARGS_BYTES) {
      throw new RouterError("policy_denied", "Tool arguments exceed maximum size", request.correlationId);
    }

    if (this.policy.requiresConfirmation(policy.scope)) {
      verifyGrant(grant, this.ownerKey(request), this.registration.agentId, request.tool, request.args);
    }

    switch (policy.scope) {
      case "project:read": {
        const paths = [
          ...(policy.pathFields ?? []).map((k) => asString(request.args[k])).filter((v): v is string => v !== undefined),
          ...(policy.pathArrays ?? []).flatMap((k) => arrayOfStrings(request.args[k])),
        ];
        if (paths.length === 0) {
          throw new RouterError("policy_denied", "Read tool missing path argument", request.correlationId);
        }
        for (const p of paths) this.policy.enforceRead(p);
        break;
      }
      case "project:write": {
        const paths = [
          ...(policy.pathFields ?? []).map((k) => asString(request.args[k])).filter((v): v is string => v !== undefined),
          ...(policy.pathArrays ?? []).flatMap((k) => arrayOfStrings(request.args[k])),
        ];
        if (paths.length === 0) {
          throw new RouterError("policy_denied", "Write tool missing path argument", request.correlationId);
        }
        for (const p of paths) this.policy.enforceWrite(p);
        break;
      }
      case "project:process": {
        if (policy.commandField) {
          const cmd = asString(request.args[policy.commandField]);
          if (!cmd) throw new RouterError("policy_denied", "Process tool missing command argument", request.correlationId);
          this.policy.enforceProcess(cmd);
        }
        break;
      }
    }

    // Bind session identifiers (search sessionId / process pid) to this
    // user+agent. Reuse by a different owner is rejected.
    if (policy.sessionField) {
      const sid = asSessionIdentifier(request.args[policy.sessionField]);
      if (!sid) throw new RouterError("policy_denied", "Session tool missing session identifier", request.correlationId);
      const owner = this.ownerKey(request);
      const prev = SESSION_OWNERS.get(sid);
      if (prev && prev !== owner) {
        throw new RouterError("policy_denied", "Session belongs to a different user/agent", request.correlationId);
      }
      SESSION_OWNERS.set(sid, owner);
    }
  }

  async handle(request: RoutedMcpRequest, grant?: ConfirmationGrant): Promise<RoutedMcpResponse> {
    this.enforce(request, grant);
    return this.inner(request);
  }
}
