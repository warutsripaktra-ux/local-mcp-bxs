import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { RouterError, type UserSubject } from "./types.js";
import { type CredRecord, type CredStore, MemoryCredStore } from "./persistence.js";

// Rotatable device credentials issued to a user's agent after a successful
// pairing. Only the hash is stored; the raw secret is returned once at issue
// time and never logged. Rotation increments the version and invalidates the
// previous secret. The default lifetime is long enough for a continuously
// running desktop agent; credentials are rotated whenever the agent starts.
export class DeviceCredentialModule {
  private readonly creds: CredStore;

  constructor(
    private readonly ttlMs = 30 * 24 * 60 * 60 * 1000,
    store?: CredStore,
  ) {
    this.creds = store ?? new MemoryCredStore();
  }

  private static hash(secret: string): string {
    return createHash("sha256").update(secret).digest("hex");
  }

  private loadAll(): CredRecord[] {
    return this.creds.load();
  }

  private saveAll(records: CredRecord[]): void {
    this.creds.save(records);
  }

  issue(user: UserSubject, agentId: string): { credentialId: string; secret: string; version: number } {
    const records = this.loadAll();
    for (const record of records) {
      if (record.userId === userKeyOf(user) && record.agentId === agentId) record.revoked = true;
    }
    const prior = records.filter((r) => r.userId === userKeyOf(user) && r.agentId === agentId);
    const version = prior.length ? Math.max(...prior.map((r) => r.version)) + 1 : 1;
    const credentialId = randomBytes(16).toString("base64url");
    const secret = randomBytes(32).toString("base64url");
    const now = Date.now();
    const record: CredRecord = {
      credentialId,
      userId: userKeyOf(user),
      agentId,
      hash: DeviceCredentialModule.hash(secret),
      version,
      issuedAt: now,
      expiresAt: now + this.ttlMs,
      revoked: false,
    };
    records.push(record);
    this.saveAll(records);
    return { credentialId, secret, version };
  }

  verify(credentialId: string, secret: string): { userId: string; agentId: string; version: number } {
    const records = this.loadAll();
    const rec = records.find((r) => r.credentialId === credentialId && !r.revoked);
    if (!rec) throw new RouterError("unauthenticated", "unknown device credential", "n/a");
    if (rec.expiresAt < Date.now()) throw new RouterError("unauthenticated", "device credential expired", "n/a");
    const given = DeviceCredentialModule.hash(secret);
    const a = Buffer.from(rec.hash);
    const b = Buffer.from(given);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new RouterError("unauthenticated", "device credential mismatch", "n/a");
    }
    const [issuer, sub] = rec.userId.split("|");
    return { userId: rec.userId, agentId: rec.agentId, version: rec.version };
  }

  rotate(credentialId: string): { credentialId: string; secret: string; version: number } {
    const records = this.loadAll();
    const rec = records.find((r) => r.credentialId === credentialId && !r.revoked);
    if (!rec) throw new RouterError("unauthenticated", "unknown device credential", "n/a");
    rec.revoked = true; // invalidate the previous secret
    this.saveAll(records);
    const [issuer, sub] = rec.userId.split("|");
    const user: UserSubject = { issuer, sub };
    return this.issue(user, rec.agentId);
  }

  revoke(credentialId: string): void {
    const records = this.loadAll();
    const rec = records.find((r) => r.credentialId === credentialId);
    if (rec) rec.revoked = true;
    this.saveAll(records);
  }

  find(credentialId: string): CredRecord | undefined {
    return this.loadAll().find((r) => r.credentialId === credentialId && !r.revoked);
  }
}

function userKeyOf(user: UserSubject): string {
  return `${user.issuer}|${user.sub}`;
}
