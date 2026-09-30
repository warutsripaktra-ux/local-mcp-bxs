import { realpathSync } from "node:fs";
import { resolve, dirname, basename, sep, relative, isAbsolute } from "node:path";
import { RouterError, type ProjectPolicy, type Scope } from "./types.js";

// Canonicalize a path for policy comparison. Resolves symlinks along the
// existing portion of the path so a symlink pointing outside an allowed root
// is caught (symlink-escape guard). For a path that does not yet exist (e.g. a
// write target), we resolve the deepest existing ancestor and re-attach the
// trailing missing segments — this blocks `root/link/new.txt` where `link` is a
// symlink to outside root, which a pure lexical check would wrongly allow.
export function canonicalPath(input: string): string {
  const absolute = resolve(input);
  try {
    return realpathSync(absolute);
  } catch {
    let current = absolute;
    const trail: string[] = [];
    while (true) {
      try {
        const resolved = realpathSync(current);
        return trail.length ? resolve(resolved, ...trail) : resolved;
      } catch {
        const parent = dirname(current);
        if (parent === current) return absolute; // reached filesystem root
        trail.unshift(basename(current));
        current = parent;
      }
    }
  }
}

function isSubPath(child: string, root: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

// True only when canonicalPath is exactly root or nested under it.
export function isWithinRoots(path: string, roots: string[]): boolean {
  if (roots.length === 0) return false;
  const target = canonicalPath(path);
  return roots.some((root) => isSubPath(target, canonicalPath(root)));
}

// Extract every base command from a shell command string. Splits on shell
// separators (newline ; | &) and strips a leading VAR=value assignment and any
// path prefix, so `bash -c "git status; rm -rf /"` yields ["bash","git","rm"]
// and each must pass the allowlist. This defeats shell-wrapper bypass where
// only the first token was previously inspected.
export function extractBaseCommands(command: string): string[] {
  const out: string[] = [];
  for (const rawPart of command.split(/[\n;|&]+/)) {
    const part = rawPart.trim();
    if (!part) continue;
    const withoutEnv = part.replace(/^\s*\w+\s*=\s*\S+\s*/, "").trim();
    const firstToken = withoutEnv.split(/\s+/)[0];
    if (!firstToken) continue;
    out.push(firstToken.split(/[\\/]/).pop() ?? firstToken);
  }
  return out;
}

// Enforces the deny-by-default project policy. Every public method throws a
// RouterError with code "policy_denied" on violation so the router can map it
// to a clear, non-leaking response.
export class PolicyEngine {
  constructor(private readonly policy: ProjectPolicy) {}

  checkScope(scope: Scope): void {
    const granted: Record<Scope, boolean> = {
      "project:read": this.policy.allowRead,
      "project:write": this.policy.allowWrite,
      "project:process": this.policy.allowProcess,
    };
    if (!granted[scope]) {
      throw new RouterError("policy_denied", `Scope not permitted: ${scope}`, "n/a");
    }
  }

  // Roots-only check, independent of read/write scope — used by the runtime
  // path gate that must allow both reads and writes within the same roots.
  assertWithinRoots(path: string): void {
    if (this.policy.roots.length === 0) {
      throw new RouterError("policy_denied", "No project roots configured", "n/a");
    }
    if (!isWithinRoots(path, this.policy.roots)) {
      throw new RouterError("policy_denied", `Path outside allowed roots: ${path}`, "n/a");
    }
  }

  enforceRead(path: string): void {
    this.checkScope("project:read");
    this.assertWithinRoots(path);
  }

  enforceWrite(path: string): void {
    this.checkScope("project:write");
    this.assertWithinRoots(path);
  }

  enforceProcess(command: string): void {
    this.checkScope("project:process");
    if (this.policy.allowedCommands.length === 0) {
      throw new RouterError("policy_denied", "No commands allowed", "n/a");
    }
    if (this.policy.allowedCommands.includes("*")) return;
    for (const cmd of extractBaseCommands(command)) {
      if (!this.policy.allowedCommands.includes(cmd)) {
        throw new RouterError("policy_denied", `Command not in allowlist: ${cmd}`, "n/a");
      }
    }
  }

  requiresConfirmation(scope: Scope): boolean {
    return this.policy.requireConfirmationFor.includes(scope);
  }
}
