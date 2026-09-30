import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync, chmodSync } from "node:fs";
import type { AgentRegistration } from "./types.js";

// Pluggable persistence for the central registry and device credentials.
// File-backed JSON for production; in-memory for tests. Secrets (raw device
// credentials) are never persisted — only hashes.

export type PersistedAgent = Omit<AgentRegistration, "deviceCredential">;

export interface RegistryStore {
  load(): PersistedAgent[];
  save(agents: PersistedAgent[]): void;
}

export interface CredRecord {
  credentialId: string;
  userId: string;
  agentId: string;
  hash: string;
  version: number;
  issuedAt: number;
  expiresAt: number;
  revoked: boolean;
}

export interface CredStore {
  load(): CredRecord[];
  save(creds: CredRecord[]): void;
}

function readJson<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T[];
  } catch {
    return [];
  }
}

export class MemoryRegistryStore implements RegistryStore {
  private data: PersistedAgent[] = [];
  load(): PersistedAgent[] {
    return this.data;
  }
  save(agents: PersistedAgent[]): void {
    this.data = agents.map((a) => ({ ...a }));
  }
}

export class FileRegistryStore implements RegistryStore {
  constructor(private readonly path: string) {}
  load(): PersistedAgent[] {
    return readJson<PersistedAgent>(this.path);
  }
  save(agents: PersistedAgent[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(agents, null, 2), "utf8");
    chmodSync(this.path, 0o600);
  }
}

export class MemoryCredStore implements CredStore {
  private data: CredRecord[] = [];
  load(): CredRecord[] {
    return this.data;
  }
  save(creds: CredRecord[]): void {
    this.data = creds.map((c) => ({ ...c }));
  }
}

export class FileCredStore implements CredStore {
  constructor(private readonly path: string) {}
  load(): CredRecord[] {
    return readJson<CredRecord>(this.path);
  }
  save(creds: CredRecord[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(creds, null, 2), "utf8");
    chmodSync(this.path, 0o600);
  }
}

// Strip the raw device credential before persisting an agent record.
export function toPersisted(agents: AgentRegistration[]): PersistedAgent[] {
  return agents.map(({ deviceCredential, ...rest }) => rest);
}
