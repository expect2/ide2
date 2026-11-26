import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { AnnotationStore } from "../main/services/annotations.js";
import { resolveRepoContext, WorktreeService } from "../main/services/git.js";
import { insideWorktree } from "../shared/guard.js";

export interface CliExportArgs {
  cwd: string;
  target?: string;
  worktreeFilter?: string;
  resolveAfterExport?: boolean;
  storageRoot?: string;
}

/**
 * Headless fast-path for `ide2 --export`:
 * Resolves repository & worktrees, reconciles open annotations against current disk lines
 * so line numbers reflect any recent agent edits, and returns the compiled Markdown prompt.
 */
export async function runCliExport(args: CliExportArgs): Promise<string> {
  const targetInput = args.target ? resolve(args.cwd, args.target) : args.cwd;
  const ctx = await resolveRepoContext(targetInput);
  const gitService = new WorktreeService();
  const worktrees = await gitService.discoverWorktrees(ctx.initialWorktreePath);

  let selectedWt =
    worktrees.find((w) => w.path === ctx.initialWorktreePath) ?? worktrees[0];

  if (args.worktreeFilter) {
    const q = args.worktreeFilter.trim();
    const resolvedQ = resolve(args.cwd, q);
    let canonQ = resolvedQ;
    try {
      canonQ = realpathSync(resolvedQ);
    } catch {
      // ignore non-path names
    }
    const matched = worktrees.find(
      (w) =>
        w.name === q ||
        w.branch === q ||
        w.path === q ||
        w.path === resolvedQ ||
        w.path === canonQ,
    );
    if (!matched) {
      throw new Error(
        `Worktree "${q}" not found. Available: ${worktrees.map((w) => w.name).join(", ")}`,
      );
    }
    selectedWt = matched;
  }

  if (!selectedWt) {
    throw new Error("No git worktrees discovered in repository.");
  }

  const store = new AnnotationStore(ctx.repoCommonDir, args.storageRoot);
  const wtAnnotations = await store.list(selectedWt.path);

  // Reconcile open file annotations against current disk content before compiling prompt
  const uniqueFiles = new Set(
    wtAnnotations
      .filter((a) => a.filePath && a.side !== "old" && a.status !== "resolved")
      .map((a) => a.filePath!),
  );

  for (const relFile of uniqueFiles) {
    const absFile = insideWorktree(selectedWt.path, relFile);
    if (absFile && existsSync(absFile)) {
      const content = readFileSync(absFile, "utf8");
      const hash = createHash("sha1").update(content).digest("hex");
      const lines = content.split(/\r?\n/);
      await store.reconcileFile(selectedWt.path, relFile, lines, hash);
    }
  }

  const { markdown } = await store.compilePrompt(selectedWt, {
    worktreePath: selectedWt.path,
    resolveAfterExport: args.resolveAfterExport,
  });

  return markdown;
}
