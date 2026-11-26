import { existsSync, readdirSync, realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { join, relative, resolve } from "node:path";
import { toPosixPath } from "../../shared/guard.js";
import type { WorktreeInfo } from "../../shared/protocol.js";

export interface WorktreeWatchEvent {
  worktreePath: string;
  changedFiles: string[];
}

export type WorktreeWatchListener = (event: WorktreeWatchEvent) => void;

export interface MultiWorktreeWatcherOptions {
  debounceMs?: number;
  onActivity?: (worktreePath: string, timestamp: number) => void;
}

const DEFAULT_DEBOUNCE_MS = 120;

function tryRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function shouldIgnoreRelativePath(relPosix: string): boolean {
  if (!relPosix) return false;
  const normalized = relPosix.replace(/^\/+/, "");
  if (
    normalized === "node_modules" ||
    normalized.startsWith("node_modules/") ||
    normalized.includes("/node_modules/")
  ) {
    return true;
  }
  if (normalized === ".git/index.lock" || normalized.endsWith(".git/index.lock")) {
    return true;
  }
  if (
    normalized.startsWith(".git/") &&
    normalized.endsWith(".lock")
  ) {
    return true;
  }
  if (
    normalized.startsWith(".git/") &&
    !normalized.startsWith(".git/refs") &&
    !normalized.startsWith(".git/logs") &&
    normalized !== ".git/HEAD" &&
    normalized !== ".git/index"
  ) {
    return true;
  }
  return false;
}

/**
 * Watches multiple git worktree roots and git common refs/logs,
 * coalescing filesystem bursts with a 120ms debounce and ignoring noisy
 * paths like `.git/index.lock` and `node_modules/`.
 */
export class MultiWorktreeWatcher {
  private readonly watchers: FSWatcher[] = [];
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingFiles = new Map<string, Set<string>>();
  private readonly worktrees = new Map<string, WorktreeInfo>();
  private readonly debounceMs: number;
  private readonly listener: WorktreeWatchListener;
  private readonly onActivity?: (worktreePath: string, timestamp: number) => void;
  private closed = false;

  constructor(
    worktrees: readonly WorktreeInfo[],
    repoCommonDir: string | undefined,
    listener: WorktreeWatchListener,
    options?: MultiWorktreeWatcherOptions,
  ) {
    this.listener = listener;
    this.debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.onActivity = options?.onActivity;

    this.resetWatches(worktrees, repoCommonDir);
  }

  /**
   * Replaces watched directories with a new set of worktrees (e.g. after `createWorktree`).
   */
  resetWatches(worktrees: readonly WorktreeInfo[], repoCommonDir?: string): void {
    if (this.closed) return;
    this.clearWatchers();
    this.worktrees.clear();

    for (const wt of worktrees) {
      const canonPath = tryRealpath(wt.path);
      this.worktrees.set(canonPath, wt);
      this.watchWorktreeRoot(canonPath);
    }

    if (repoCommonDir) {
      const canonCommon = tryRealpath(repoCommonDir);
      this.watchGitCommonDir(canonCommon);
    }
  }

  /** Stops all active watchers and clears pending debounce timers. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.pendingFiles.clear();
    this.clearWatchers();
  }

  private clearWatchers(): void {
    while (this.watchers.length > 0) {
      const w = this.watchers.pop();
      try {
        w?.close();
      } catch {
        // ignore close errors on already-removed paths
      }
    }
  }

  private watchWorktreeRoot(canonRoot: string): void {
    if (!existsSync(canonRoot)) return;
    const supportsRecursive = process.platform === "darwin" || process.platform === "win32";

    if (supportsRecursive) {
      this.attachWatch(canonRoot, true, (filename) => {
        const rel = filename ? toPosixPath(filename) : "";
        if (shouldIgnoreRelativePath(rel)) return;
        this.scheduleEvent(canonRoot, rel);
      });
      return;
    }

    // Linux fallback: watch top-level and subdirectories gracefully
    const dirsToWatch: string[] = [canonRoot];
    const collectSubdirs = (dir: string) => {
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          if (entry.name === "node_modules" || entry.name === ".git") continue;
          const child = join(dir, entry.name);
          dirsToWatch.push(child);
          collectSubdirs(child);
        }
      } catch {
        // ignore unreadable directories
      }
    };
    collectSubdirs(canonRoot);

    for (const dir of dirsToWatch) {
      this.attachWatch(dir, false, (filename) => {
        const relFromRoot = filename
          ? toPosixPath(relative(canonRoot, join(dir, filename)))
          : toPosixPath(relative(canonRoot, dir));
        if (shouldIgnoreRelativePath(relFromRoot)) return;
        if (filename) {
          const maybeDir = join(dir, filename);
          try {
            if (existsSync(maybeDir) && statSync(maybeDir).isDirectory()) {
              this.watchSingleLinuxSubdir(canonRoot, maybeDir);
            }
          } catch {
            // ignore transient stat errors
          }
        }
        this.scheduleEvent(canonRoot, relFromRoot);
      });
    }
  }

  private watchSingleLinuxSubdir(canonRoot: string, dir: string): void {
    const relDir = toPosixPath(relative(canonRoot, dir));
    if (shouldIgnoreRelativePath(relDir)) return;
    this.attachWatch(dir, false, (filename) => {
      const rel = filename
        ? toPosixPath(relative(canonRoot, join(dir, filename)))
        : relDir;
      if (shouldIgnoreRelativePath(rel)) return;
      this.scheduleEvent(canonRoot, rel);
    });
  }

  private watchGitCommonDir(canonCommon: string): void {
    const targets = [
      join(canonCommon, "refs"),
      join(canonCommon, "logs"),
    ];
    const supportsRecursive = process.platform === "darwin" || process.platform === "win32";

    for (const target of targets) {
      if (!existsSync(target)) continue;
      this.attachWatch(target, supportsRecursive, (filename) => {
        if (filename && (filename.endsWith(".lock") || filename.includes("index.lock"))) {
          return;
        }
        for (const wtPath of this.worktrees.keys()) {
          this.scheduleEvent(wtPath, "");
        }
      });
    }

    const headFile = join(canonCommon, "HEAD");
    if (existsSync(headFile)) {
      this.attachWatch(headFile, false, () => {
        for (const wtPath of this.worktrees.keys()) {
          this.scheduleEvent(wtPath, "");
        }
      });
    }
  }

  private attachWatch(
    targetPath: string,
    recursive: boolean,
    onChange: (filename: string | null) => void,
  ): void {
    try {
      const watcher = watch(targetPath, { recursive }, (_eventType, filename) => {
        if (this.closed) return;
        onChange(filename ? String(filename) : null);
      });
      watcher.on("error", () => {
        // Gracefully ignore watcher errors (e.g. removed worktree)
      });
      this.watchers.push(watcher);
    } catch {
      // Gracefully ignore watch setup failures
    }
  }

  private scheduleEvent(worktreePath: string, relFile: string): void {
    if (this.closed) return;
    const now = Date.now();
    const wt = this.worktrees.get(worktreePath);
    if (wt) {
      wt.lastActivityAt = now;
    }
    this.onActivity?.(worktreePath, now);

    let fileSet = this.pendingFiles.get(worktreePath);
    if (!fileSet) {
      fileSet = new Set<string>();
      this.pendingFiles.set(worktreePath, fileSet);
    }
    if (relFile) {
      fileSet.add(relFile);
    }

    const existingTimer = this.debounceTimers.get(worktreePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(worktreePath);
      const collected = this.pendingFiles.get(worktreePath);
      this.pendingFiles.delete(worktreePath);
      if (this.closed) return;
      this.listener({
        worktreePath,
        changedFiles: collected ? Array.from(collected).sort() : [],
      });
    }, this.debounceMs);

    this.debounceTimers.set(worktreePath, timer);
  }
}
