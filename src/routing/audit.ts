// Minimal audit sink. Records only identity, action metadata, and outcome —
// never secrets, tokens, or file contents (per plan Phase 2 / acceptance #283).
// Logs to stderr by default; swap with setAuditSink for a persistent sink.
export type AuditEvent = {
  correlationId: string;
  user?: string; // issuer|sub
  agent?: string;
  tool: string;
  action: "request" | "deny" | "forward" | "error";
  result?: "ok" | "denied" | "error";
  errorCode?: string;
};

type AuditSink = (event: AuditEvent) => void;

let sink: AuditSink = (event: AuditEvent) => {
  try {
    process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), kind: "audit", ...event }) + "\n");
  } catch {
    // never let audit logging break request handling
  }
};

export function setAuditSink(next: AuditSink): void {
  sink = next;
}

export function audit(event: AuditEvent): void {
  try {
    sink(event);
  } catch {
    // never let audit logging break request handling
  }
}
