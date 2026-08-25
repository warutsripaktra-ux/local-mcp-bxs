import { createHash } from "node:crypto";
import { RouterError, type Scope } from "./types.js";

// Single source of truth for tool authorization. The router and the local
// agent both consult this catalog so scope, path fields, command fields,
// session binding, and confirmation rules can never drift between them.
// Every tool the server exposes must appear here; any tool missing from the
// catalog is treated as unclassified and denied (fail-closed).

export type ToolPolicy = {
  name: string;
  scope: Scope;
  // "router" tools are served centrally (discovery, prompts, static
  // resources) and never forwarded to a user's machine. "agent" tools run on
  // the user's machine behind the local policy.
  owner: "router" | "agent";
  // Flat string path arguments validated against the project roots.
  pathFields?: string[];
  // Array path arguments; every element is validated against the roots.
  pathArrays?: string[];
  // Process command argument (validated against the command allowlist).
  commandField?: string;
  // Search/process session identifier bound to the requesting user+agent.
  sessionField?: string;
};

const READ: Scope = "project:read";
const WRITE: Scope = "project:write";
const PROCESS: Scope = "project:process";

export const TOOL_POLICIES: Record<string, ToolPolicy> = {
  // --- read-scoped filesystem/search tools ---
  read_file: { name: "read_file", scope: READ, owner: "agent", pathFields: ["path"] },
  read_multiple_files: { name: "read_multiple_files", scope: READ, owner: "agent", pathArrays: ["paths"] },
  list_directory: { name: "list_directory", scope: READ, owner: "agent", pathFields: ["path"] },
  get_file_info: { name: "get_file_info", scope: READ, owner: "agent", pathFields: ["path"] },
  start_search: { name: "start_search", scope: READ, owner: "agent", pathFields: ["path"] },
  get_more_search_results: { name: "get_more_search_results", scope: READ, owner: "agent", sessionField: "sessionId" },
  stop_search: { name: "stop_search", scope: READ, owner: "agent", sessionField: "sessionId" },
  list_searches: { name: "list_searches", scope: READ, owner: "agent" },
  get_config: { name: "get_config", scope: READ, owner: "agent" },
  get_usage_stats: { name: "get_usage_stats", scope: READ, owner: "agent" },
  get_recent_tool_calls: { name: "get_recent_tool_calls", scope: READ, owner: "agent" },
  give_feedback_to_desktop_commander: { name: "give_feedback_to_desktop_commander", scope: READ, owner: "agent" },

  // --- write-scoped filesystem tools ---
  write_file: { name: "write_file", scope: WRITE, owner: "agent", pathFields: ["path"] },
  write_pdf: { name: "write_pdf", scope: WRITE, owner: "agent", pathFields: ["path", "outputPath"] },
  create_directory: { name: "create_directory", scope: WRITE, owner: "agent", pathFields: ["path"] },
  move_file: { name: "move_file", scope: WRITE, owner: "agent", pathFields: ["source", "destination"] },
  edit_block: { name: "edit_block", scope: WRITE, owner: "agent", pathFields: ["file_path"] },
  set_config_value: { name: "set_config_value", scope: WRITE, owner: "agent" },

  // --- process-scoped tools ---
  start_process: { name: "start_process", scope: PROCESS, owner: "agent", commandField: "command" },
  interact_with_process: { name: "interact_with_process", scope: PROCESS, owner: "agent", sessionField: "pid" },
  read_process_output: { name: "read_process_output", scope: PROCESS, owner: "agent", sessionField: "pid" },
  force_terminate: { name: "force_terminate", scope: PROCESS, owner: "agent", sessionField: "pid" },
  list_sessions: { name: "list_sessions", scope: PROCESS, owner: "agent" },
  kill_process: { name: "kill_process", scope: PROCESS, owner: "agent", sessionField: "pid" },
  list_processes: { name: "list_processes", scope: PROCESS, owner: "agent" },

  // --- centrally owned ---
  get_prompts: { name: "get_prompts", scope: READ, owner: "router" },
};

// Allowed top-level MCP methods. Anything else is unclassified and denied.
export const ALLOWED_MCP_METHODS = new Set<string>([
  "initialize",
  "ping",
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/read",
  "resources/templates/list",
  "prompts/list",
  "prompts/get",
  "completion/complete",
  "logging/setLevel",
  "notifications/initialized",
  "notifications/roots/list_changed",
  "notifications/message",
]);

export function describeTool(tool: string): ToolPolicy | null {
  return TOOL_POLICIES[tool] ?? null;
}

export function isKnownTool(tool: string): boolean {
  return tool in TOOL_POLICIES;
}

export function isAllowedMethod(method: string): boolean {
  return ALLOWED_MCP_METHODS.has(method);
}

// Upper bound on serialized tool arguments. Larger payloads are rejected
// before any filesystem/process work, protecting the agent from oversized or
// abusive requests.
export const MAX_ARGS_BYTES = 1_000_000;

// Trusted, one-time approval grant. A model-provided boolean is never accepted
// as evidence of user approval; the router/UI must mint a grant bound to the
// user, agent, tool, and a normalized hash of the arguments, with a short TTL.
export type ConfirmationGrant = {
  userKey: string;
  agentId: string;
  tool: string;
  argHash: string;
  exp: number; // epoch seconds
};

// Stable hash of the tool arguments so a grant cannot be replayed against a
// different call. Includes the tool name to prevent cross-tool reuse.
export function hashArgs(tool: string, args: Record<string, unknown>): string {
  const canonical = JSON.stringify({ tool, args });
  return createHash("sha256").update(canonical).digest("hex");
}

export function makeGrant(
  userKey: string,
  agentId: string,
  tool: string,
  args: Record<string, unknown>,
  ttlSeconds = 60,
): ConfirmationGrant {
  return {
    userKey,
    agentId,
    tool,
    argHash: hashArgs(tool, args),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
}

// Re-verify a grant at the agent before executing a confirmation-gated call.
// Throws RouterError("confirmation_required") when the grant is missing or
// does not match the current request.
export function verifyGrant(
  grant: ConfirmationGrant | undefined,
  userKey: string,
  agentId: string,
  tool: string,
  args: Record<string, unknown>,
  nowSeconds = Math.floor(Date.now() / 1000),
): void {
  if (!grant) {
    throw new RouterError("confirmation_required", `Operation requires confirmation: ${tool}`, "n/a");
  }
  if (grant.exp < nowSeconds) {
    throw new RouterError("confirmation_required", "Confirmation grant expired", "n/a");
  }
  if (grant.userKey !== userKey || grant.agentId !== agentId || grant.tool !== tool) {
    throw new RouterError("confirmation_required", "Confirmation grant does not match this request", "n/a");
  }
  if (grant.argHash !== hashArgs(tool, args)) {
    throw new RouterError("confirmation_required", "Confirmation grant arguments changed", "n/a");
  }
}
