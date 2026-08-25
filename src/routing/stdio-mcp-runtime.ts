import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

// Runs the local MCP server as a child process and relays JSON-RPC over its
// stdin/stdout (plan Phase 5). Correlates responses by id, rejects pending
// calls on child exit, and supports bounded restart to avoid crash loops.

export type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

export class StdioMcpRuntime {
  private child?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string | number, { resolve: (m: JsonRpcMessage) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout }>();
  private buffer = "";
  private restarts = 0;
  private stopped = false;

  constructor(
    private readonly cmd: string,
    private readonly args: string[],
    private readonly env: NodeJS.ProcessEnv,
    private readonly maxRestarts = 5,
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.child = spawn(this.cmd, this.args, { env: this.env, stdio: ["pipe", "pipe", "pipe"] });
      this.child.stdout.setEncoding("utf8");
      this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
      this.child.stderr.on("data", (chunk: string) => process.stderr.write(`[mcp-child] ${chunk}`));
      this.child.on("exit", (code) => this.onExit(code));
      this.child.on("error", (err) => {
        if (!this.started) reject(err);
      });
      // The child is considered up once we can write; MCP handshake is lazy.
      this.started = true;
      resolve();
    });
  }

  private started = false;

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id === undefined || msg.id === null) continue; // notification/request from child: ignore
      const p = this.pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        p.resolve(msg);
      }
    }
  }

  private onExit(code: number | null): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`MCP child exited (${code})`));
    }
    this.pending.clear();
    if (this.stopped) return;
    if (this.restarts < this.maxRestarts) {
      this.restarts++;
      process.stderr.write(`[mcp-runtime] child exited (${code}); restarting (${this.restarts})\n`);
      this.started = false;
      void this.start();
    }
  }

  request(message: Omit<JsonRpcMessage, "jsonrpc">): Promise<JsonRpcMessage> {
    if (!this.child) return Promise.reject(new Error("runtime not started"));
    const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : randomUUID();
    const envelope: JsonRpcMessage = { jsonrpc: "2.0", ...message, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("MCP child request timed out"));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify(envelope) + "\n");
    });
  }

  stop(): void {
    this.stopped = true;
    this.child?.kill();
  }
}
