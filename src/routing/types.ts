// Core types for multi-user project routing.
// Keep these framework-free so they can be shared by the central router,
// the local project agent, and the test suite without pulling in the MCP SDK.

export type Scope = "project:read" | "project:write" | "project:process";

// Stable user identity. Email is intentionally NOT used as primary identity
// because it can change; the issuer+sub pair from the OIDC token is stable.
export type UserSubject = {
  issuer: string;
  sub: string;
};

export function userKey(user: UserSubject): string {
  return `${user.issuer}|${user.sub}`;
}

export type AgentStatus = "online" | "offline" | "revoked";

export type AgentRegistration = {
  agentId: string;
  user: UserSubject;
  projectLabel: string;
  capabilities: Scope[];
  roots: string[];
  lastHeartbeatAt: string; // ISO timestamp
  status: AgentStatus;
  // Device credential issued by the central system, never the runtime API key.
  deviceCredential?: string;
};

// Deny-by-default project policy. Empty roots + allowRead=false is the
// production-safe default; the unrestricted `allowedDirectories: []` behavior
// of the legacy server is explicitly NOT permitted here.
export type ProjectPolicy = {
  roots: string[];
  allowRead: boolean;
  allowWrite: boolean;
  allowProcess: boolean;
  allowedCommands: string[];
  requireConfirmationFor: Scope[];
};

export function denyByDefaultPolicy(): ProjectPolicy {
  return {
    roots: [],
    allowRead: false,
    allowWrite: false,
    allowProcess: false,
    allowedCommands: [],
    requireConfirmationFor: ["project:write", "project:process"],
  };
}

// Error taxonomy returned to the router caller. Each has a stable `code` so
// the central router can emit a distinct, non-leaking message per failure.
export type RouterErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "agent_offline"
  | "agent_revoked"
  | "agent_unknown"
  | "policy_denied"
  | "timeout"
  | "confirmation_required";

export class RouterError extends Error {
  readonly code: RouterErrorCode;
  readonly correlationId: string;
  constructor(code: RouterErrorCode, message: string, correlationId: string) {
    super(message);
    this.name = "RouterError";
    this.code = code;
    this.correlationId = correlationId;
  }
}

// A minimal MCP-shaped request/response used by the router and channel so we
// don't depend on the full SDK request types in the routing layer.
export type RoutedMcpRequest = {
  correlationId: string;
  tool: string;
  args: Record<string, unknown>;
  // Identity stamped by the router after authentication, used to bind
  // search/process session identifiers to the requesting user+agent so a
  // session created by one user can never be driven by another.
  owner?: { userKey: string; agentId: string };
};

export type RoutedMcpResponse = {
  correlationId: string;
  result?: unknown;
  error?: { code: string; message: string };
};
