import { denyByDefaultPolicy, type ProjectPolicy, type Scope } from "./types.js";

// Loads the deny-by-default agent policy from the environment (plan Phase 5).
// Mirrors the validation in scripts/run-agent.cjs so the controller and the
// launcher agree on what is permitted.
export function loadAgentPolicy(env: NodeJS.ProcessEnv = process.env): ProjectPolicy {
  const roots = (env.PROJECT_ROOTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const bool = (v: string | undefined, fallback: boolean) => (v === undefined ? fallback : v === "1" || v.toLowerCase() === "true");
  const p = denyByDefaultPolicy();
  p.roots = roots;
  p.allowRead = bool(env.ALLOW_READ, false);
  p.allowWrite = bool(env.ALLOW_WRITE, false);
  p.allowProcess = bool(env.ALLOW_PROCESS, false);
  p.allowedCommands = (env.ALLOWED_COMMANDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  p.requireConfirmationFor = ((env.REQUIRE_CONFIRMATION_FOR ?? "project:write,project:process") as string)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as Scope[];
  return p;
}

// Deny-by-default guard: never start an agent that is a wide-open gateway.
export function assertSafePolicy(p: ProjectPolicy): void {
  if (p.allowRead && p.roots.length === 0) throw new Error("ALLOW_READ requires PROJECT_ROOTS (deny-by-default).");
  if (p.allowWrite && p.roots.length === 0) throw new Error("ALLOW_WRITE requires PROJECT_ROOTS (deny-by-default).");
  if (p.allowProcess && p.allowedCommands.length === 0) throw new Error("ALLOW_PROCESS requires ALLOWED_COMMANDS (deny-by-default).");
}
