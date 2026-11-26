import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Strict read-only containment guard (modeled directly on expect2-cli's `insideRoot`).
 * Resolves `candidatePath` relative to `worktreeRoot`, follows symlinks via `realpathSync`,
 * and returns the canonical file path ONLY if it resolves strictly inside `worktreeRoot`.
 *
 * Returns `undefined` if missing, a directory, `..`, or pointing outside `worktreeRoot`.
 */
export function insideWorktree(worktreeRoot: string, candidatePath: string): string | undefined {
  try {
    const canonRoot = realpathSync(worktreeRoot);
    const resolved = resolve(canonRoot, candidatePath);
    const canonTarget = realpathSync(resolved);
    const rel = relative(canonRoot, canonTarget);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return undefined;
    }
    const st = statSync(canonTarget);
    return st.isFile() ? canonTarget : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalizes any platform path segment to forward-slash repo-relative POSIX style.
 */
export function toPosixPath(p: string): string {
  return p.split("\\").join("/");
}

/**
 * Enforces `--no-optional-locks` on every git invocation so `ide2` never acquires `.git/index.lock`
 * or interferes with a running external coding agent.
 *
 * Also blocks any git subcommand that could mutate working tree code, index, or commits.
 * (`worktree add` is explicitly gated behind `allowWorktreeAdd: true`.)
 */
const ALLOWED_GIT_SUBCOMMANDS = new Set([
  "rev-parse",
  "worktree",
  "status",
  "diff",
  "log",
  "show",
  "blame",
  "ls-files",
  "grep",
  "merge-base",
  "rev-list",
  "branch",
  "symbolic-ref",
  "for-each-ref",
  "cat-file",
]);

export function buildSafeGitArgs(
  args: readonly string[],
  options?: { allowWorktreeAdd?: boolean },
): string[] {
  const firstSubcommand = args.find((a) => !a.startsWith("-"));
  if (!firstSubcommand || !ALLOWED_GIT_SUBCOMMANDS.has(firstSubcommand)) {
    throw new Error(`Refused disallowed git subcommand in read-only IDE: ${firstSubcommand ?? "(none)"}`);
  }
  if (firstSubcommand === "worktree") {
    const action = args[args.indexOf("worktree") + 1];
    const allowedActions = options?.allowWorktreeAdd ? new Set(["list", "add"]) : new Set(["list"]);
    if (!action || !allowedActions.has(action)) {
      throw new Error(`Refused git worktree action: ${action ?? "(none)"}`);
    }
  }
  if (firstSubcommand === "branch") {
    // Only allow listing/reading branches (-a, -r, --list, --show-current, --contains), never -D/-d/-m/-c
    for (const arg of args) {
      if (["-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move", "--copy"].includes(arg)) {
        throw new Error(`Refused mutating git branch flag: ${arg}`);
      }
    }
  }
  return ["--no-optional-locks", ...args];
}
