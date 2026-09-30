import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { setAuditSink, type AuditEvent } from "./audit.js";

// Persistent, redacted audit sink (plan Phase 6). Writes only metadata (never
// secrets/tokens/file contents) as JSONL. An optional retention cap rotates the
// file once it exceeds maxBytes. Install via setAuditSink.

export function createFileAuditSink(path: string, opts: { maxBytes?: number } = {}): (event: AuditEvent) => void {
  mkdirSync(dirname(path), { recursive: true });
  const maxBytes = opts.maxBytes ?? 5_000_000;
  return (event: AuditEvent) => {
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), kind: "audit", ...event }) + "\n";
      if (existsSync(path) && readFileSync(path, "utf8").length > maxBytes) {
        writeFileSync(path + ".1", readFileSync(path));
        writeFileSync(path, "");
      }
      appendFileSync(path, line);
    } catch {
      // never let audit logging break request handling
    }
  };
}

export { setAuditSink };
