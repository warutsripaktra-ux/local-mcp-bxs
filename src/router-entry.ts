import { AuthAdapter, type TokenVerifier, type VerifiedToken } from "./routing/auth.js";
import { AgentRegistry } from "./routing/registry.js";
import { InProcessAgentChannel } from "./routing/local-channel.js";
import { type AgentChannel } from "./routing/agent-channel.js";
import { McpRouter } from "./routing/router.js";
import { createRouterHttpServer } from "./routing/http-server.js";
import { JwksTokenVerifier } from "./routing/jwks-verifier.js";
import { DeviceCredentialModule } from "./routing/device-credential.js";
import { PairingModule } from "./routing/pairing.js";
import type { RegistryStore, CredStore } from "./routing/persistence.js";

// Composition root for the central HTTP MCP Router. Builds the authenticated
// router stack from a pluggable TokenVerifier (a test/fake verifier in unit
// tests, the org OIDC/JWKS verifier in production — see Phase 2).

export type RouterDeps = {
  auth: AuthAdapter;
  registry: AgentRegistry;
  channel: AgentChannel;
  router: McpRouter;
  credentials: DeviceCredentialModule;
  pairing: PairingModule;
  issuer: string;
  audience: string;
  resource: string;
  resourceMetadataUrl: string;
  agentAuth: {
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    clientId: string;
  };
};

export type BuildOptions = {
  verifier: TokenVerifier;
  expectedIssuer: string;
  expectedAudience: string;
  offlineAfterMs?: number;
  forwardTimeoutMs?: number;
  channel?: AgentChannel;
  resource?: string;
  registryStore?: RegistryStore;
  credentialStore?: CredStore;
  deviceCredentialTtlMs?: number;
  agentAuth?: RouterDeps["agentAuth"];
};

// Production verifier selection (plan Phase 2). JWKS wins when configured;
// ROUTER_DEMO=1 keeps a local-only demo verifier for testing.
export function createVerifier(opts: {
  jwksUrl?: string;
  discoveryUrl?: string;
  expectedIssuer: string;
  expectedAudience: string;
  demo?: boolean;
  demoScopes?: string[];
}): TokenVerifier {
  if (opts.demo) {
    const scopes = opts.demoScopes ?? ["project:read", "project:write", "project:process"];
    return {
      async verify(token: string) {
        // Demo only: trusts any bearer and returns claims from the configured
        // issuer/audience. Never used in production.
        return {
          issuer: opts.expectedIssuer,
          sub: token || "demo-user",
          audience: opts.expectedAudience,
          scope: scopes as VerifiedToken["scope"],
          exp: Math.floor(Date.now() / 1000) + 3600,
        };
      },
    };
  }
  if (opts.jwksUrl || opts.discoveryUrl || opts.expectedIssuer) {
    return new JwksTokenVerifier({
      jwksUrl: opts.jwksUrl,
      discoveryUrl: opts.discoveryUrl,
      issuer: opts.expectedIssuer,
      audience: opts.expectedAudience,
    });
  }
  throw new Error("No TokenVerifier configured. Set OIDC_ISSUER or ROUTER_DEMO=1.");
}

export function buildRouterDeps(opts: BuildOptions): RouterDeps {
  const auth = new AuthAdapter(opts.verifier, {
    expectedAudience: opts.expectedAudience,
    expectedIssuer: opts.expectedIssuer,
  });
  const registry = new AgentRegistry({ offlineAfterMs: opts.offlineAfterMs ?? 30_000, store: opts.registryStore });
  const channel = opts.channel ?? new InProcessAgentChannel();
  const credentials = new DeviceCredentialModule(opts.deviceCredentialTtlMs ?? 30 * 24 * 60 * 60 * 1000, opts.credentialStore);
  const pairing = new PairingModule();
  const router = new McpRouter(auth, registry, channel, { forwardTimeoutMs: opts.forwardTimeoutMs ?? 30_000 });
  const resource = opts.resource ?? opts.expectedAudience;
  const resourceMetadataUrl = (() => {
    try { return new URL("/.well-known/oauth-protected-resource", resource).toString(); }
    catch { return `${resource.replace(/\/$/, "")}/.well-known/oauth-protected-resource`; }
  })();
  return {
    auth, registry, channel, router, credentials, pairing,
    issuer: opts.expectedIssuer, audience: opts.expectedAudience, resource, resourceMetadataUrl,
    agentAuth: opts.agentAuth ?? { issuer: opts.expectedIssuer, authorizationEndpoint: "", tokenEndpoint: "", clientId: "" },
  };
}

export function startRouter(opts: BuildOptions & { port: number }): {
  server: ReturnType<typeof createRouterHttpServer>["server"];
  shutdown: () => Promise<void>;
  deps: RouterDeps;
} {
  const deps = buildRouterDeps(opts);
  const { server, shutdown } = createRouterHttpServer(deps);
  server.listen(opts.port);
  return { server, shutdown, deps };
}
