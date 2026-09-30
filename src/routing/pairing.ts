import { randomBytes, createHash } from "node:crypto";
import { RouterError, userKey, type UserSubject } from "./types.js";

// One-time, short-lived pairing code bound to the authenticated user. The code
// itself is a secret; only its hash is retained. Redeeming it returns the user
// it was issued to, so a code for user A can never register a device for B.
export type PairingRecord = {
  codeHash: string;
  userId: string;
  expiresAt: number;
  redeemed: boolean;
};

export class PairingModule {
  private readonly codes = new Map<string, PairingRecord>();

  constructor(private readonly ttlMs = 300_000) {}

  generate(user: UserSubject): { code: string; expiresAt: number } {
    const code = randomBytes(18).toString("base64url");
    const codeHash = createHash("sha256").update(code).digest("hex");
    const expiresAt = Date.now() + this.ttlMs;
    this.codes.set(codeHash, { codeHash, userId: userKey(user), expiresAt, redeemed: false });
    return { code, expiresAt };
  }

  redeem(code: string): UserSubject {
    const codeHash = createHash("sha256").update(code).digest("hex");
    const rec = this.codes.get(codeHash);
    if (!rec) throw new RouterError("forbidden", "invalid pairing code", "n/a");
    if (rec.redeemed) throw new RouterError("forbidden", "pairing code already used", "n/a");
    if (rec.expiresAt < Date.now()) {
      this.codes.delete(codeHash);
      throw new RouterError("forbidden", "pairing code expired", "n/a");
    }
    rec.redeemed = true;
    const [issuer, sub] = rec.userId.split("|");
    return { issuer, sub };
  }
}
