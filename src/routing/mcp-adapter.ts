import { randomUUID } from "node:crypto";
import { zodToJsonSchema } from "zod-to-json-schema";
import { toolArgSchemas } from "../tools/schemas.js";
import { McpRouter } from "./router.js";
import { TOOL_POLICIES } from "./tool-policy-catalog.js";
import { RouterError } from "./types.js";

// Thin JSON-RPC adapter that maps MCP HTTP requests onto the central
// RouterModule. `initialize` and `tools/list` are served centrally so discovery
// never depends on an online agent; `tools/call` is forwarded through the
// router (which authenticates, resolves the agent, and enforces policy).

export type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

function fallbackInputSchema(p: (typeof TOOL_POLICIES)[string]) {
  const properties: Record<string, unknown> = {};
  const required = new Set<string>();
  for (const field of p.pathFields ?? []) {
    properties[field] = { type: "string" };
    required.add(field);
  }
  for (const field of p.pathArrays ?? []) {
    properties[field] = { type: "array", items: { type: "string" }, minItems: 1 };
    required.add(field);
  }
  if (p.commandField) {
    properties[p.commandField] = { type: "string" };
    required.add(p.commandField);
  }
  if (p.sessionField) {
    properties[p.sessionField] = { type: "string" };
    required.add(p.sessionField);
  }
  return {
    type: "object",
    properties,
    ...(required.size > 0 ? { required: [...required] } : {}),
    additionalProperties: true,
  };
}

function toolDescription(name: string, scope: string, central: boolean): string {
  if (name === "start_process") {
    return `Run a locally allowed command on the authenticated user's machine. On macOS, use open to launch applications or URLs, osascript with System Events for mouse/keyboard automation, and screencapture to capture the display before reading the image with read_file. Scope: ${scope}.`;
  }
  return `${scope}${central ? " (central)" : ""}`;
}

function toolList() {
  return Object.values(TOOL_POLICIES).map((p) => {
    const argSchema = toolArgSchemas[p.name];
    return {
      name: p.name,
      title: p.name,
      description: toolDescription(p.name, p.scope, p.owner === "router"),
      inputSchema: argSchema ? zodToJsonSchema(argSchema) : fallbackInputSchema(p),
      ...(p.owner === "agent" ? { securitySchemes: [{ type: "oauth2", scopes: [p.scope] }] } : {}),
    };
  });
}

const MCP_ERROR: Record<string, number> = {
  unauthenticated: -32001,
  forbidden: -32003,
  agent_offline: -32004,
  agent_revoked: -32005,
  agent_unknown: -32006,
  policy_denied: -32007,
  timeout: -32008,
  confirmation_required: -32009,
};

export type McpAdapterContext = {
  router: McpRouter;
  authorization?: string;
  resourceMetadataUrl?: string;
};

export async function handleMcpJsonRpc(req: JsonRpcRequest, ctx: McpAdapterContext): Promise<JsonRpcResponse> {
  const id = req.id ?? null;
  const params = req.params ?? {};
  try {
    if (req.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "local-gateway-mcp-router", version: "0.1.0" },
        },
      };
    }
    if (req.method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }
    if (req.method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: toolList() } };
    }
    if (req.method === "tools/call") {
      const tool = typeof params.name === "string" ? params.name : "";
      const args = (typeof params.arguments === "object" && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const res = await ctx.router.handleRequest(ctx.authorization, {
        correlationId: randomUUID(),
        tool,
        args,
      });
      if (res.error) {
        return { jsonrpc: "2.0", id, error: { code: -32000, message: res.error.message, data: res.error } };
      }
      return { jsonrpc: "2.0", id, result: res.result };
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${req.method}` } };
  } catch (err: unknown) {
    if (err instanceof RouterError) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: MCP_ERROR[err.code] ?? -32000,
          message: err.message,
          data: err.code === "unauthenticated" ? {
            code: err.code,
            _meta: { "mcp/www_authenticate": `Bearer resource_metadata=\"${ctx.resourceMetadataUrl ?? "/.well-known/oauth-protected-resource"}\", error=\"invalid_token\", error_description=\"${err.message.replace(/"/g, "'")}\"` },
          } : { code: err.code },
        },
      };
    }
    return { jsonrpc: "2.0", id, error: { code: -32603, message: err instanceof Error ? err.message : "internal error" } };
  }
}
