import { RouterError, type Scope, type UserSubject } from "./types.js";

// Verified claims extracted from a bearer token by a TokenVerifier.
export type VerifiedToken = {
  issuer: string;
  sub: string;
  audience: string;
  scope: Scope[];
  exp: number; // epoch seconds
};

// Pluggable verifier so the router works with any IdP (the org's OIDC provider
// in production) and with a test verifier in unit tests. No network calls are
// made here; the concrete implementation owns fetching JWKS / introspection.
export interface TokenVerifier {
  verify(token: string): Promise<VerifiedToken>;
}

export type AuthAdapterConfig = {
  expectedAudience: string;
  expectedIssuer: string;
  // Clock skew tolerance in seconds for exp/iat checks.
  skewSeconds?: number;
};

export type AuthenticatedUser = {
  subject: UserSubject;
  scopes: Scope[];
};

// Validates every bearer token in an MCP request and produces a stable user
// subject. Never trusts email as identity (see types.ts).
export class AuthAdapter {
  private readonly verifier: TokenVerifier;
  private readonly config: Required<AuthAdapterConfig>;

  constructor(verifier: TokenVerifier, config: AuthAdapterConfig) {
    this.verifier = verifier;
    this.config = { skewSeconds: 0, ...config };
  }

  static bearerFromHeader(header: string | undefined): string | null {
    if (!header) return null;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match ? match[1] : null;
  }

  async authenticate(authorization: string | undefined): Promise<AuthenticatedUser> {
    const token = AuthAdapter.bearerFromHeader(authorization);
    if (!token) {
      throw new RouterError("unauthenticated", "Missing bearer token", "n/a");
    }

    let claims: VerifiedToken;
    try {
      claims = await this.verifier.verify(token);
    } catch (err) {
      throw new RouterError(
        "unauthenticated",
        `Token verification failed: ${err instanceof Error ? err.message : "unknown"}`,
        "n/a",
      );
    }

    if (claims.issuer !== this.config.expectedIssuer) {
      throw new RouterError("unauthenticated", "Unknown issuer", "n/a");
    }
    if (claims.audience !== this.config.expectedAudience) {
      throw new RouterError("unauthenticated", "Wrong audience", "n/a");
    }

    const now = Math.floor(Date.now() / 1000);
    if (claims.exp + this.config.skewSeconds < now) {
      throw new RouterError("unauthenticated", "Token expired", "n/a");
    }

    return {
      subject: { issuer: claims.issuer, sub: claims.sub },
      scopes: claims.scope,
    };
  }

  assertScope(user: AuthenticatedUser, scope: Scope): void {
    if (!user.scopes.includes(scope)) {
      throw new RouterError(
        "forbidden",
        `Missing required scope: ${scope}`,
        "n/a",
      );
    }
  }
}
