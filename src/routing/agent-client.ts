import { makeGrant } from "./tool-policy-catalog.js";
import type { LocalProjectAgent } from "./agent-channel.js";
import { RouterError, type RoutedMcpRequest, type RoutedMcpResponse } from "./types.js";

// Agent-side client (plan Phase 5). Long-polls the central router for work,
// enforces the local policy via the LocalProjectAgent (which relays to the
// stdio MCP runtime), and returns the correlated result. Reconnects with
// bounded exponential backoff + jitter so a transient router outage does not
// hot-loop.

export type AgentClientOptions = {
  baseUrl: string;
  credentialId: string;
  secret: string;
  agent: LocalProjectAgent;
  pollTimeoutMs?: number;
  maxBackoffMs?: number;
};

export class AgentClient {
  private stopped = false;
  private readonly opts: Required<AgentClientOptions>;

  constructor(opts: AgentClientOptions) {
    this.opts = { pollTimeoutMs: 25_000, maxBackoffMs: 30_000, ...opts };
  }

  stop(): void {
    this.stopped = true;
  }

  async run(): Promise<void> {
    let backoff = 500;
    while (!this.stopped) {
      try {
        const res = await fetch(`${this.opts.baseUrl}/agent/v1/poll`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.opts.credentialId}.${this.opts.secret}`, "content-type": "application/json" },
          body: JSON.stringify({ timeoutMs: this.opts.pollTimeoutMs }),
        });
        if (!res.ok) {
          this.logError("poll", new Error(`HTTP ${res.status}`));
          await this.backoffSleep(backoff);
          backoff = Math.min(backoff * 2, this.opts.maxBackoffMs);
          continue;
        }
        backoff = 500;
        const body = (await res.json()) as { request?: RoutedMcpRequest & { seq?: number } };
        const req = body.request;
        if (!req) continue;
        const grant = makeGrant(req.owner?.userKey ?? "local", req.owner?.agentId ?? "agent", req.tool, req.args);
        let out: RoutedMcpResponse;
        try {
          out = await this.opts.agent.handle(req, grant);
        } catch (error) {
          const code = error instanceof RouterError ? error.code : "agent_error";
          const message = this.errorMessage(error);
          this.logError("tool", error, { tool: req.tool, correlationId: req.correlationId, code });
          out = { correlationId: req.correlationId, error: { code, message } };
        }
        const respond = await fetch(`${this.opts.baseUrl}/agent/v1/respond`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.opts.credentialId}.${this.opts.secret}`, "content-type": "application/json" },
          body: JSON.stringify({ correlationId: req.correlationId, sequence: req.seq ?? 0, result: out }),
        });
        if (!respond.ok) throw new Error(`respond HTTP ${respond.status}`);
      } catch (error) {
        this.logError("connection", error);
        await this.backoffSleep(backoff);
        backoff = Math.min(backoff * 2, this.opts.maxBackoffMs);
      }
    }
  }

  private backoffSleep(ms: number): Promise<void> {
    const jitter = Math.floor(Math.random() * ms * 0.3);
    return new Promise((r) => setTimeout(r, Math.min(ms + jitter, this.opts.maxBackoffMs)));
  }

  private errorMessage(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ");
  }

  private logError(event: string, error: unknown, fields: Record<string, string> = {}): void {
    const details = Object.entries(fields).map(([key, value]) => `${key}=${value}`).join(" ");
    process.stderr.write(`[agent] ${event} failed${details ? ` ${details}` : ""} message=${this.errorMessage(error)}\n`);
  }
}
