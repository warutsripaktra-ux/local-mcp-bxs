import { RouterError, type AgentRegistration, type RoutedMcpRequest, type RoutedMcpResponse } from "./types.js";
import { type AgentChannel } from "./agent-channel.js";
import { MAX_ARGS_BYTES } from "./tool-policy-catalog.js";

// Router-side production agent channel (plan Phase 4). Agents connect outbound
// over HTTPS and long-poll for work; the router enqueues requests, hands them
// to a polling agent, and resolves the pending call when the agent responds.
// Owns sequence IDs, correlation, deadlines, cancellation, duplicate rejection,
// queue limits, and per-agent capacity.

type Pending = {
  correlationId: string;
  agentId: string;
  seq: number;
  request: RoutedMcpRequest;
  resolve: (r: RoutedMcpResponse) => void;
  reject: (e: unknown) => void;
  timer: NodeJS.Timeout;
};

type Poller = {
  resolve: (p: Pending | null) => void;
  timer: NodeJS.Timeout;
};

export type LongPollChannelConfig = {
  maxQueuePerAgent?: number;
  requestTimeoutMs?: number;
};

export class LongPollAgentChannel implements AgentChannel {
  private readonly queues = new Map<string, Pending[]>();
  private readonly inFlight = new Map<string, Map<string, Pending>>();
  private readonly pollers = new Map<string, Poller[]>();
  private readonly seq = new Map<string, number>();
  // Remember responded correlation IDs briefly to reject duplicate responses.
  private readonly responded = new Set<string>();
  private readonly cfg: Required<LongPollChannelConfig>;

  constructor(config: LongPollChannelConfig = {}) {
    this.cfg = { maxQueuePerAgent: 100, requestTimeoutMs: 30_000, ...config };
  }

  async send(agentId: string, request: RoutedMcpRequest): Promise<RoutedMcpResponse> {
    const queue = this.queues.get(agentId) ?? [];
    if (queue.length >= this.cfg.maxQueuePerAgent) {
      throw new RouterError("timeout", "Agent queue full (backpressure)", request.correlationId);
    }
    const nextSeq = (this.seq.get(agentId) ?? 0) + 1;
    this.seq.set(agentId, nextSeq);

    return new Promise<RoutedMcpResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.remove(agentId, request.correlationId);
        reject(new RouterError("timeout", "Agent request timed out", request.correlationId));
      }, this.cfg.requestTimeoutMs);
      const pending: Pending = { correlationId: request.correlationId, agentId, seq: nextSeq, request, resolve, reject, timer };
      queue.push(pending);
      this.queues.set(agentId, queue);
      this.dispatch(agentId);
    });
  }

  status(agentId: string): Promise<"online" | "offline" | "revoked" | "unknown"> {
    const q = this.queues.get(agentId);
    return Promise.resolve(q ? (q.length > 0 ? "online" : "online") : "unknown");
  }

  // Agent long-polls for the next pending request (or waits up to timeoutMs).
  poll(agentId: string, _credentialVersion: number, timeoutMs: number): Promise<Pending | null> {
    const queued = this.dequeue(agentId);
    if (queued) return Promise.resolve(queued);
    return new Promise<Pending | null>((resolve) => {
      const timer = setTimeout(() => {
        const list = this.pollers.get(agentId);
        if (list) this.pollers.set(agentId, list.filter((p) => p !== poller));
        resolve(null);
      }, timeoutMs);
      const poller: Poller = { resolve, timer };
      const list = this.pollers.get(agentId) ?? [];
      list.push(poller);
      this.pollers.set(agentId, list);
    });
  }

  // Agent returns a correlated result. Duplicate/unknown correlation rejected.
  respond(agentId: string, correlationId: string, _sequence: number, result: RoutedMcpResponse): void {
    if (this.responded.has(correlationId)) {
      throw new RouterError("policy_denied", "Duplicate response for correlation", correlationId);
    }
    const active = this.inFlight.get(agentId);
    const pending = active?.get(correlationId);
    if (!pending) throw new RouterError("policy_denied", "Unknown correlation for agent", correlationId);
    active!.delete(correlationId);
    if (active!.size === 0) this.inFlight.delete(agentId);
    clearTimeout(pending.timer);
    this.responded.add(correlationId);
    setTimeout(() => this.responded.delete(correlationId), 60_000);
    pending.resolve(result);
  }

  cancel(agentId: string, correlationId: string): void {
    this.remove(agentId, correlationId);
  }

  private dequeue(agentId: string): Pending | null {
    const queue = this.queues.get(agentId);
    if (!queue || queue.length === 0) return null;
    const [p] = queue.splice(0, 1);
    this.queues.set(agentId, queue);
    const active = this.inFlight.get(agentId) ?? new Map<string, Pending>();
    active.set(p.correlationId, p);
    this.inFlight.set(agentId, active);
    return p;
  }

  private dispatch(agentId: string): void {
    const list = this.pollers.get(agentId);
    if (!list || list.length === 0) return;
    const pending = this.dequeue(agentId);
    if (!pending) return;
    const poller = list.shift()!;
    if (list.length === 0) this.pollers.delete(agentId);
    else this.pollers.set(agentId, list);
    clearTimeout(poller.timer);
    poller.resolve(pending);
  }

  private remove(agentId: string, correlationId: string): void {
    const queue = this.queues.get(agentId);
    const idx = queue?.findIndex((p) => p.correlationId === correlationId) ?? -1;
    let pending: Pending | undefined;
    if (queue && idx !== -1) {
      [pending] = queue.splice(idx, 1);
      this.queues.set(agentId, queue);
    } else {
      const active = this.inFlight.get(agentId);
      pending = active?.get(correlationId);
      if (pending) {
        active!.delete(correlationId);
        if (active!.size === 0) this.inFlight.delete(agentId);
      }
    }
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.reject(new RouterError("timeout", "Request cancelled", correlationId));
  }
}
