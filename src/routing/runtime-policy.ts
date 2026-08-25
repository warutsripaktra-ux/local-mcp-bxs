import { PolicyEngine } from "./policy.js";
import { denyByDefaultPolicy, type ProjectPolicy } from "./types.js";

// Bridge between the user-machine agent's validated ProjectPolicy (supplied via
// the DC_AGENT_POLICY env by scripts/run-agent.cjs) and the existing runtime
// filesystem/process gates. When the env is absent the runtime keeps its own
// allow/block logic; when present, deny-by-default applies: only the policy's
// roots are readable/writable and only its allowlisted commands may run.
let cached: PolicyEngine | null | undefined;

function load(): PolicyEngine | null {
  const raw = process.env.DC_AGENT_POLICY;
  if (!raw) return null;
  try {
    return new PolicyEngine(JSON.parse(raw) as ProjectPolicy);
  } catch {
    // Malformed policy env is a configuration fault: fail closed.
    return new PolicyEngine(denyByDefaultPolicy());
  }
}

export function getRuntimePolicy(): PolicyEngine | null {
  if (cached === undefined) cached = load();
  return cached;
}

// True when the path is within the agent's project roots. Returns true when no
// agent policy is active (caller applies its own rules).
export function runtimePathAllowed(p: string): boolean {
  const engine = getRuntimePolicy();
  if (!engine) return true;
  try {
    engine.assertWithinRoots(p);
    return true;
  } catch {
    return false;
  }
}

// null = not enforced by agent policy (caller applies blockedCommands etc.).
// false = explicitly denied by the agent allowlist.
export function runtimeCommandAllowed(command: string): boolean | null {
  const engine = getRuntimePolicy();
  if (!engine) return null;
  try {
    engine.enforceProcess(command);
    return true;
  } catch {
    return false;
  }
}
