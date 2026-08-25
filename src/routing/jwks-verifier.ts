import { createPublicKey, createHash, type KeyObject, verify as cryptoVerify } from "node:crypto";
import { TokenVerifier, type VerifiedToken } from "./auth.js";

// Pluggable OIDC/JWKS token verifier for the central router (plan Phase 2).
// Fetches the IdP JWKS, verifies the asymmetric signature with the stdlib
// crypto module (no extra dependency), and enforces iss/aud/exp/nbf. Keys are
// cached and refetched on rotation or verification miss.

export type JwksVerifierConfig = {
  jwksUrl?: string;
  issuer: string;
  audience: string;
  discoveryUrl?: string;
  skewSeconds?: number;
  cacheMaxAgeMs?: number;
};

type Jwk = {
  kid?: string;
  kty: string;
  crv?: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
  alg?: string;
  use?: string;
};

type Jwks = { keys: Jwk[] };

function b64url(input: string): string {
  return input.replace(/-/g, "+").replace(/_/g, "/");
}

function decodeB64url(input: string): Buffer {
  return Buffer.from(b64url(input), "base64");
}

function base64UrlSha256(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}

function jwkToKeyObject(jwk: Jwk): KeyObject {
  try {
    return createPublicKey({ key: jwk as unknown as KeyLike, format: "jwk" });
  } catch {
    // Some JWKs omit alg; provide a default so Node can import them.
    return createPublicKey({ key: { ...jwk, alg: jwk.alg ?? "RS256" } as unknown as KeyLike, format: "jwk" });
  }
}

type KeyLike = Record<string, unknown>;

export class JwksTokenVerifier implements TokenVerifier {
  private cache: { keys: Map<string, KeyObject>; expiresAt: number } | null = null;
  private readonly config: Required<Omit<JwksVerifierConfig, "jwksUrl" | "discoveryUrl">> & Pick<JwksVerifierConfig, "jwksUrl" | "discoveryUrl">;
  private resolvedJwksUrl?: string;

  constructor(config: JwksVerifierConfig) {
    this.config = { skewSeconds: 0, cacheMaxAgeMs: 3_600_000, ...config };
  }

  private async resolveJwksUrl(): Promise<string> {
    if (this.config.jwksUrl) return this.config.jwksUrl;
    if (this.resolvedJwksUrl) return this.resolvedJwksUrl;
    const base = this.config.discoveryUrl ?? `${this.config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
    const res = await fetch(base, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
    const metadata = (await res.json()) as { issuer?: unknown; jwks_uri?: unknown };
    if (metadata.issuer !== this.config.issuer) throw new Error("OIDC discovery issuer mismatch");
    if (typeof metadata.jwks_uri !== "string" || !/^https:\/\//i.test(metadata.jwks_uri)) throw new Error("OIDC discovery has no HTTPS jwks_uri");
    this.resolvedJwksUrl = metadata.jwks_uri;
    return metadata.jwks_uri;
  }

  private async getKeys(): Promise<Map<string, KeyObject>> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.keys;
    const res = await fetch(await this.resolveJwksUrl(), { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
    const jwks = (await res.json()) as Jwks;
    const keys = new Map<string, KeyObject>();
    for (const jwk of jwks.keys) {
      if (jwk.use && jwk.use !== "sig") continue;
      const ko = jwkToKeyObject(jwk);
      if (jwk.kid) keys.set(jwk.kid, ko);
      // Also index by thumbprint so tokens without kid can be matched.
      try {
        const thumb = base64UrlSha256(JSON.stringify({ kty: jwk.kty, n: jwk.n, e: jwk.e, crv: jwk.crv, x: jwk.x, y: jwk.y }));
        if (!keys.has(thumb)) keys.set(thumb, ko);
      } catch {
        // ignore thumbprint indexing failures
      }
    }
    this.cache = { keys, expiresAt: now + this.config.cacheMaxAgeMs };
    return keys;
  }

  private signingAlgorithm(jwk: Jwk): string {
    if (jwk.alg) return jwk.alg;
    if (jwk.kty === "EC") return "ES256";
    return "RS256";
  }

  async verify(token: string): Promise<VerifiedToken> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("malformed JWT");
    const [headerB64, payloadB64] = parts;

    let header: Jwk;
    try {
      header = JSON.parse(decodeB64url(headerB64).toString("utf8")) as Jwk;
    } catch {
      throw new Error("malformed JWT header");
    }

    let keys = await this.getKeys();
    let key = (header.kid && keys.get(header.kid)) || (header.kid ? null : keys.values().next().value) || null;
    if (!key && header.kid) {
      this.cache = null;
      keys = await this.getKeys();
      key = keys.get(header.kid) ?? null;
    }
    if (!key) throw new Error("no matching JWK");

    const alg = this.signingAlgorithm(header);
    const verifyAlg = alg.startsWith("ES") ? "sha256" : "RSA-SHA256";
    const signature = decodeB64url(parts[2]);
    const valid = cryptoVerify(verifyAlg, Buffer.from(`${headerB64}.${payloadB64}`), key, signature);
    if (!valid) throw new Error("signature verification failed");

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(decodeB64url(payloadB64).toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new Error("malformed JWT payload");
    }

    const now = Math.floor(Date.now() / 1000);
    const iss = typeof payload.iss === "string" ? payload.iss : "";
    const aud = payload.aud;
    const audiences = Array.isArray(aud) ? aud.filter((v): v is string => typeof v === "string") : typeof aud === "string" ? [aud] : [];
    const audience = audiences.includes(this.config.audience) ? this.config.audience : "";
    const exp = typeof payload.exp === "number" ? payload.exp : 0;
    const nbf = typeof payload.nbf === "number" ? payload.nbf : 0;

    if (iss !== this.config.issuer) throw new Error("unknown issuer");
    if (!audience) throw new Error("wrong audience");
    if (exp + this.config.skewSeconds < now) throw new Error("token expired");
    if (nbf && nbf - this.config.skewSeconds > now) throw new Error("token not yet valid");

    const scopeRaw = payload.scope ?? payload.scp;
    const scope = Array.isArray(scopeRaw)
      ? (scopeRaw as string[])
      : typeof scopeRaw === "string"
        ? scopeRaw.split(/\s+/).filter(Boolean)
        : [];

    return {
      issuer: iss,
      sub: typeof payload.sub === "string" && payload.sub ? payload.sub : (() => { throw new Error("missing subject"); })(),
      audience,
      scope: scope as VerifiedToken["scope"],
      exp,
    };
  }
}
