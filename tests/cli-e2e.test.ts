import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runCliExport } from "../src/cli/export.js";
import { AnnotationStore } from "../src/main/services/annotations.js";
import { resolveRepoContext, WorktreeService } from "../src/main/services/git.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, "..");
const IDE2_BIN = resolve(APP_ROOT, "bin/ide2.mjs");
const PKG_JSON = JSON.parse(readFileSync(resolve(APP_ROOT, "package.json"), "utf8")) as {
  version: string;
};

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function sha1(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function runIde2Cli(
  args: string[],
  options: { cwd?: string; homeDir?: string } = {},
): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (options.homeDir) {
    env.HOME = options.homeDir;
  }
  const result = spawnSync(process.execPath, [IDE2_BIN, ...args], {
    cwd: options.cwd ?? APP_ROOT,
    env,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * Snapshots every file (tracked + untracked) inside a worktree excluding `.git`
 * and `.claude/worktrees` (which is a separate nested worktree snapshotted independently).
 */
function snapshotWorktreeFiles(worktreeDir: string): Record<string, string> {
  const snapshot: Record<string, string> = {};

  function walk(currentDir: string): void {
    const entries = readdirSync(currentDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      const rel = relative(worktreeDir, fullPath).replace(/\\/g, "/");
      if (rel === ".git" || rel.startsWith(".git/") || rel === ".claude/worktrees") {
        continue;
      }
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const bytes = readFileSync(fullPath);
        snapshot[rel] = createHash("sha256").update(bytes).digest("hex");
      }
    }
  }

  walk(worktreeDir);
  return snapshot;
}

/** Recursively finds any `*.lock` files inside a directory (e.g. `.git/index.lock`). */
function findLockFiles(rootDir: string): string[] {
  const found: string[] = [];
  if (!existsSync(rootDir)) return found;

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".lock")) {
        found.push(fullPath);
      }
    }
  }

  if (statSync(rootDir).isDirectory()) {
    walk(rootDir);
  }
  return found;
}

interface MultiWorktreeFixture {
  root: string;
  fakeHome: string;
  mainDir: string;
  wtAgentADir: string;
  wtAgentBDir: string;
  repoCommonDir: string;
  authFileInitialWtA: string;
  specFileWtA: string;
}

function createMultiWorktreeFixture(): MultiWorktreeFixture {
  const root = makeTempDir("ide2-cli-e2e-");
  const fakeHome = join(root, "fake-home");
  const mainDir = join(root, "repo-main");
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(mainDir, { recursive: true });

  git(mainDir, ["init", "-b", "main"]);
  git(mainDir, ["config", "user.email", "test@example.com"]);
  git(mainDir, ["config", "user.name", "E2E Tester"]);

  mkdirSync(join(mainDir, "src"), { recursive: true });
  mkdirSync(join(mainDir, "docs"), { recursive: true });

  writeFileSync(join(mainDir, ".gitignore"), ".claude/\n", "utf8");

  writeFileSync(
    join(mainDir, "src", "auth.ts"),
    [
      "export interface Session { userId: string; role: string; }",
      "export function verifyAuth(header: string | undefined): Session | null {",
      "  if (!header) return { userId: 'legacy-anon', role: 'guest' };",
      "  const parts = header.split(' ');",
      "  return { userId: parts[1] ?? '', role: 'user' };",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  writeFileSync(
    join(mainDir, "docs", "spec.md"),
    [
      "# Auth Specification",
      "",
      "## Security Invariants",
      "",
      "- All endpoints must reject missing Authorization headers.",
      "- Read-only review tooling must never mutate worktree files.",
      "",
    ].join("\n"),
    "utf8",
  );

  git(mainDir, ["add", "."]);
  git(mainDir, ["commit", "-m", "chore: initial main commit"]);

  // Nested worktree under .claude/worktrees/wt-agent-a
  const wtAgentADir = join(mainDir, ".claude", "worktrees", "wt-agent-a");
  mkdirSync(join(mainDir, ".claude", "worktrees"), { recursive: true });
  git(mainDir, ["worktree", "add", "-b", "feat/agent-a", wtAgentADir, "main"]);

  // Sibling worktree wt-agent-b
  const wtAgentBDir = join(root, "wt-agent-b");
  git(mainDir, ["worktree", "add", "-b", "feat/agent-b", wtAgentBDir, "main"]);

  // Agent A edits src/auth.ts (removes legacy anonymous fallback, adds multi-line token parsing)
  const authFileInitialWtA = [
    "export interface Session { userId: string; role: string; }",
    "",
    "export function verifyAuth(header: string | undefined): Session | null {",
    "  if (!header) return null;",
    "  const trimmed = header.trim();",
    "  const [scheme, token] = trimmed.split(' ');",
    "  if (scheme !== 'Bearer') return null;",
    "  return { userId: token.slice(0, 12), role: 'user' };",
    "}",
    "",
  ].join("\n");
  writeFileSync(join(wtAgentADir, "src", "auth.ts"), authFileInitialWtA, "utf8");

  // Agent A updates docs/spec.md
  const specFileWtA = [
    "# Auth Specification",
    "",
    "## Security Invariants",
    "",
    "- All endpoints must reject missing or malformed Bearer tokens.",
    "- Read-only review tooling must never mutate worktree files or acquire git locks.",
    "- Worktree annotations are stored strictly outside the repository.",
    "",
  ].join("\n");
  writeFileSync(join(wtAgentADir, "docs", "spec.md"), specFileWtA, "utf8");

  // Agent A also leaves an untracked file in its worktree
  writeFileSync(join(wtAgentADir, "src", "agent-draft.txt"), "untracked draft note\n", "utf8");

  git(wtAgentADir, ["add", "src/auth.ts", "docs/spec.md"]);
  git(wtAgentADir, ["commit", "-m", "feat(auth): tighten bearer verification"]);

  // Agent B works on a separate billing module in sibling worktree
  writeFileSync(
    join(wtAgentBDir, "src", "billing.ts"),
    [
      "export function chargeInvoice(invoiceId: string, cents: number): boolean {",
      "  if (cents <= 0) return false;",
      "  return invoiceId.length > 0;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  git(wtAgentBDir, ["add", "src/billing.ts"]);
  git(wtAgentBDir, ["commit", "-m", "feat(billing): add invoice charge stub"]);

  return {
    root,
    fakeHome: realpathSync(fakeHome),
    mainDir: realpathSync(mainDir),
    wtAgentADir: realpathSync(wtAgentADir),
    wtAgentBDir: realpathSync(wtAgentBDir),
    repoCommonDir: realpathSync(join(mainDir, ".git")),
    authFileInitialWtA,
    specFileWtA,
  };
}

async function seedAnnotations(
  store: AnnotationStore,
  fixture: MultiWorktreeFixture,
): Promise<{
  wtAIds: { overall: string; bugCode: string; deletedDiff: string; keepSpec: string };
  wtBIds: { overall: string; billingBug: string };
}> {
  const authHash = sha1(fixture.authFileInitialWtA);
  const specHash = sha1(fixture.specFileWtA);

  // 1. Overall worktree note on wt-agent-a
  const overall = await store.create({
    worktreePath: fixture.wtAgentADir,
    intent: "change",
    comment: "Ensure all auth middleware paths enforce strict Bearer token validation.",
  });

  // 2. [BUG] multi-line code annotation on wt-agent-a (lines 6-8 BEFORE 10-line shift)
  const bugCode = await store.create({
    worktreePath: fixture.wtAgentADir,
    filePath: "src/auth.ts",
    side: "new",
    startLine: 6,
    endLine: 8,
    intent: "bug",
    comment: "Guard against undefined `token` before calling `token.slice(0, 12)`.",
    selectedText: [
      "  const [scheme, token] = trimmed.split(' ');",
      "  if (scheme !== 'Bearer') return null;",
      "  return { userId: token.slice(0, 12), role: 'user' };",
    ].join("\n"),
    contextBefore: "  const trimmed = header.trim();",
    contextAfter: "}",
    contentHash: authHash,
    language: "typescript",
  });

  // 3. [QUESTION] deleted-line diff annotation (side: "old") on wt-agent-a
  const deletedDiff = await store.create({
    worktreePath: fixture.wtAgentADir,
    filePath: "src/auth.ts",
    side: "old",
    startLine: 3,
    endLine: 3,
    intent: "question",
    comment: "Was removing the legacy anonymous guest fallback coordinated with mobile clients?",
    selectedText: "  if (!header) return { userId: 'legacy-anon', role: 'guest' };",
    contentHash: authHash,
    language: "typescript",
  });

  // 4. [KEEP] Markdown spec annotation on wt-agent-a (lines 5-6)
  const keepSpec = await store.create({
    worktreePath: fixture.wtAgentADir,
    filePath: "docs/spec.md",
    side: "new",
    startLine: 5,
    endLine: 6,
    intent: "keep",
    comment: "Keep this zero-mutation guarantee verbatim in the final specification.",
    selectedText: [
      "- All endpoints must reject missing or malformed Bearer tokens.",
      "- Read-only review tooling must never mutate worktree files or acquire git locks.",
    ].join("\n"),
    contextBefore: "## Security Invariants\n",
    contextAfter: "- Worktree annotations are stored strictly outside the repository.",
    contentHash: specHash,
    language: "markdown",
  });

  // Separate annotations on sibling worktree wt-agent-b (must NEVER leak into wt-agent-a)
  const wtBOverall = await store.create({
    worktreePath: fixture.wtAgentBDir,
    intent: "change",
    comment: "WT_AGENT_B_OVERALL_SECRET: Enforce idempotency keys across billing endpoints.",
  });

  const wtBBillingBug = await store.create({
    worktreePath: fixture.wtAgentBDir,
    filePath: "src/billing.ts",
    side: "new",
    startLine: 1,
    endLine: 3,
    intent: "bug",
    comment: "WT_AGENT_B_BILLING_BUG: Reject negative or NaN invoice amounts explicitly.",
    selectedText: [
      "export function chargeInvoice(invoiceId: string, cents: number): boolean {",
      "  if (cents <= 0) return false;",
      "  return invoiceId.length > 0;",
    ].join("\n"),
    contentHash: sha1(readFileSync(join(fixture.wtAgentBDir, "src", "billing.ts"), "utf8")),
    language: "typescript",
  });

  return {
    wtAIds: {
      overall: overall.id,
      bugCode: bugCode.id,
      deletedDiff: deletedDiff.id,
      keepSpec: keepSpec.id,
    },
    wtBIds: {
      overall: wtBOverall.id,
      billingBug: wtBBillingBug.id,
    },
  };
}

function assertExpectedWtAPrompt(markdown: string, fixture: MultiWorktreeFixture): void {
  // Header & worktree metadata
  expect(markdown).toContain("# Code Review Feedback — `wt-agent-a`");
  expect(markdown).toContain(`- **Worktree:** \`${fixture.wtAgentADir}\``);
  expect(markdown).toContain("- **Branch:** `feat/agent-a`");
  expect(markdown).toContain("(base: `main`");

  // 1. Overall worktree note
  expect(markdown).toContain("## Overall Notes");
  expect(markdown).toContain(
    "Ensure all auth middleware paths enforce strict Bearer token validation.",
  );

  // 2. [KEEP] Markdown spec annotation (lines 5-6, unchanged)
  expect(markdown).toContain("## 1. `[KEEP]` `docs/spec.md:5-6`");
  expect(markdown).toContain("5 | - All endpoints must reject missing or malformed Bearer tokens.");
  expect(markdown).toContain(
    "6 | - Read-only review tooling must never mutate worktree files or acquire git locks.",
  );
  expect(markdown).toContain(
    "Keep this zero-mutation guarantee verbatim in the final specification.",
  );

  // 3. [QUESTION] deleted-line diff annotation (side: "old", line 3 preserved)
  expect(markdown).toContain("## 2. `[QUESTION]` `src/auth.ts:3` *(deleted in diff)*");
  expect(markdown).toContain("```diff");
  expect(markdown).toContain("-   if (!header) return { userId: 'legacy-anon', role: 'guest' };");
  expect(markdown).toContain(
    "Was removing the legacy anonymous guest fallback coordinated with mobile clients?",
  );

  // 4. [BUG] multi-line code annotation shifted by +10 (from 6-8 to 16-18!)
  expect(markdown).toContain("## 3. `[BUG]` `src/auth.ts:16-18`");
  expect(markdown).not.toContain("`src/auth.ts:6-8`");
  expect(markdown).toContain("16 |   const [scheme, token] = trimmed.split(' ');");
  expect(markdown).toContain("17 |   if (scheme !== 'Bearer') return null;");
  expect(markdown).toContain("18 |   return { userId: token.slice(0, 12), role: 'user' };");
  expect(markdown).toContain(
    "Guard against undefined `token` before calling `token.slice(0, 12)`.",
  );

  // Zero leakage from wt-agent-b
  expect(markdown).not.toContain("WT_AGENT_B_OVERALL_SECRET");
  expect(markdown).not.toContain("WT_AGENT_B_BILLING_BUG");
  expect(markdown).not.toContain("src/billing.ts");
  expect(markdown).not.toContain("wt-agent-b");
  expect(markdown).not.toContain("feat/agent-b");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("ide2 CLI & Multi-Worktree E2E", () => {
  it("supports --help / -h and --version / -v via node bin/ide2.mjs", () => {
    const helpRes = runIde2Cli(["--help"]);
    expect(helpRes.status).toBe(0);
    expect(helpRes.stderr).toBe("");
    expect(helpRes.stdout).toContain("ide2 — read-only IDE");
    expect(helpRes.stdout).toContain("Usage:");
    expect(helpRes.stdout).toContain("--diff");
    expect(helpRes.stdout).toContain("--base");
    expect(helpRes.stdout).toContain("--worktree");
    expect(helpRes.stdout).toContain("--export");
    expect(helpRes.stdout).toContain("--resolve");
    expect(helpRes.stdout).toContain("--version");
    expect(helpRes.stdout).toContain("--help");

    const shortHelpRes = runIde2Cli(["-h"]);
    expect(shortHelpRes.status).toBe(0);
    expect(shortHelpRes.stdout).toBe(helpRes.stdout);

    const versionRes = runIde2Cli(["--version"]);
    expect(versionRes.status).toBe(0);
    expect(versionRes.stderr).toBe("");
    expect(versionRes.stdout).toBe(`ide2 ${PKG_JSON.version}\n`);

    const shortVersionRes = runIde2Cli(["-v"]);
    expect(shortVersionRes.status).toBe(0);
    expect(shortVersionRes.stdout).toBe(`ide2 ${PKG_JSON.version}\n`);
  });

  it("re-anchors +10 shifted code lines, isolates worktrees, resolves on --resolve, and leaves all worktrees & .git untouched", async () => {
    const fixture = createMultiWorktreeFixture();

    // Confirm repo context & multi-worktree discovery (main + nested .claude/worktrees/wt-agent-a + sibling wt-agent-b)
    const repoCtx = await resolveRepoContext(fixture.mainDir);
    expect(repoCtx.repoCommonDir).toBe(fixture.repoCommonDir);

    const wtService = new WorktreeService();
    const discovered = await wtService.discoverWorktrees(fixture.mainDir);
    expect(discovered.map((w) => w.name).sort()).toEqual(["main", "wt-agent-a", "wt-agent-b"]);
    expect(discovered.find((w) => w.name === "wt-agent-a")?.path).toBe(fixture.wtAgentADir);
    expect(discovered.find((w) => w.name === "wt-agent-b")?.path).toBe(fixture.wtAgentBDir);

    // Seed identical un-reconciled annotations into TWO isolated storage roots:
    // 1) directStorageRoot -> exercises `runCliExport()` directly
    // 2) fakeHome/.expect2-ide -> exercises `node bin/ide2.mjs` subprocess with HOME=fakeHome
    const directStorageRoot = join(fixture.root, "direct-storage");
    const cliStorageRoot = join(fixture.fakeHome, ".expect2-ide");

    const directStore = new AnnotationStore(fixture.repoCommonDir, directStorageRoot);
    const cliStore = new AnnotationStore(fixture.repoCommonDir, cliStorageRoot);

    const directSeeded = await seedAnnotations(directStore, fixture);
    const cliSeeded = await seedAnnotations(cliStore, fixture);

    // Confirm annotation storage lives strictly outside the repo/worktrees
    expect(cliStore.getStorageFilePath().startsWith(cliStorageRoot)).toBe(true);
    expect(cliStore.getStorageFilePath().startsWith(fixture.mainDir)).toBe(false);

    // Simulate an external coding agent inserting 10 new lines above the annotated code in wt-agent-a
    const tenPrependedLines = [
      "// Agent-inserted header 01",
      "// Agent-inserted header 02",
      "// Agent-inserted header 03",
      "// Agent-inserted header 04",
      "// Agent-inserted header 05",
      "// Agent-inserted header 06",
      "// Agent-inserted header 07",
      "// Agent-inserted header 08",
      "// Agent-inserted header 09",
      "// Agent-inserted header 10",
    ];
    const shiftedAuthContent = [...tenPrependedLines, fixture.authFileInitialWtA].join("\n");
    writeFileSync(join(fixture.wtAgentADir, "src", "auth.ts"), shiftedAuthContent, "utf8");

    // Snapshot filesystem state and git status across ALL 3 worktrees BEFORE running ide2 / runCliExport
    const beforeFiles = {
      main: snapshotWorktreeFiles(fixture.mainDir),
      wtA: snapshotWorktreeFiles(fixture.wtAgentADir),
      wtB: snapshotWorktreeFiles(fixture.wtAgentBDir),
    };
    const beforeGitStatus = {
      main: git(fixture.mainDir, ["status", "--porcelain=v2", "-uall"]),
      wtA: git(fixture.wtAgentADir, ["status", "--porcelain=v2", "-uall"]),
      wtB: git(fixture.wtAgentBDir, ["status", "--porcelain=v2", "-uall"]),
    };

    // --- Path 1: Direct `runCliExport` ---
    const directExported = await runCliExport({
      cwd: fixture.mainDir,
      worktreeFilter: "wt-agent-a",
      resolveAfterExport: false,
      storageRoot: directStorageRoot,
    });
    assertExpectedWtAPrompt(directExported, fixture);

    // Verify shifted line numbers persisted in directStorageRoot
    const directStoreReloaded = new AnnotationStore(fixture.repoCommonDir, directStorageRoot);
    const directWtAAnns = await directStoreReloaded.list(fixture.wtAgentADir);
    const directBugAnn = directWtAAnns.find((a) => a.id === directSeeded.wtAIds.bugCode);
    expect(directBugAnn?.startLine).toBe(16);
    expect(directBugAnn?.endLine).toBe(18);
    expect(directBugAnn?.status).toBe("open");

    // Resolve via `runCliExport(..., resolveAfterExport: true)`
    const directResolvedExport = await runCliExport({
      cwd: fixture.mainDir,
      worktreeFilter: "wt-agent-a",
      resolveAfterExport: true,
      storageRoot: directStorageRoot,
    });
    expect(directResolvedExport).toBe(directExported);

    // Subsequent export after resolve returns empty
    const directAfterResolve = await runCliExport({
      cwd: fixture.mainDir,
      worktreeFilter: "wt-agent-a",
      resolveAfterExport: false,
      storageRoot: directStorageRoot,
    });
    expect(directAfterResolve).toBe("");

    // --- Path 2: Subprocess `node bin/ide2.mjs --worktree wt-agent-a --export` with isolated HOME ---
    const cliExportRes = runIde2Cli(["--worktree", "wt-agent-a", "--export"], {
      cwd: fixture.mainDir,
      homeDir: fixture.fakeHome,
    });
    expect(cliExportRes.status).toBe(0);
    expect(cliExportRes.stderr).toBe("");
    assertExpectedWtAPrompt(cliExportRes.stdout, fixture);
    expect(cliExportRes.stdout).toBe(directExported);

    // Export with `--resolve` via CLI subprocess
    const cliResolveRes = runIde2Cli(["--worktree", "wt-agent-a", "--export", "--resolve"], {
      cwd: fixture.mainDir,
      homeDir: fixture.fakeHome,
    });
    expect(cliResolveRes.status).toBe(0);
    expect(cliResolveRes.stderr).toBe("");
    expect(cliResolveRes.stdout).toBe(cliExportRes.stdout);

    // Confirm all wt-agent-a annotations are now marked "resolved" in fakeHome storage,
    // while wt-agent-b annotations remain "open"
    const cliStoreAfterResolve = new AnnotationStore(fixture.repoCommonDir, cliStorageRoot);
    const cliWtAAnns = await cliStoreAfterResolve.list(fixture.wtAgentADir);
    expect(cliWtAAnns).toHaveLength(4);
    for (const ann of cliWtAAnns) {
      expect(ann.status).toBe("resolved");
    }
    const cliShiftedBug = cliWtAAnns.find((a) => a.id === cliSeeded.wtAIds.bugCode);
    expect(cliShiftedBug?.startLine).toBe(16);
    expect(cliShiftedBug?.endLine).toBe(18);

    const cliWtBAnns = await cliStoreAfterResolve.list(fixture.wtAgentBDir);
    expect(cliWtBAnns).toHaveLength(2);
    for (const ann of cliWtBAnns) {
      expect(ann.status).toBe("open");
    }

    // Subsequent `--export` on wt-agent-a outputs empty stdout!
    const cliAfterResolveRes = runIde2Cli(["--worktree", "wt-agent-a", "--export"], {
      cwd: fixture.mainDir,
      homeDir: fixture.fakeHome,
    });
    expect(cliAfterResolveRes.status).toBe(0);
    expect(cliAfterResolveRes.stderr).toBe("");
    expect(cliAfterResolveRes.stdout).toBe("");

    // Meanwhile wt-agent-b still exports its own open annotations cleanly via CLI
    const cliWtBExportRes = runIde2Cli(["--worktree=wt-agent-b", "--export"], {
      cwd: fixture.mainDir,
      homeDir: fixture.fakeHome,
    });
    expect(cliWtBExportRes.status).toBe(0);
    expect(cliWtBExportRes.stderr).toBe("");
    expect(cliWtBExportRes.stdout).toContain("# Code Review Feedback — `wt-agent-b`");
    expect(cliWtBExportRes.stdout).toContain("WT_AGENT_B_OVERALL_SECRET");
    expect(cliWtBExportRes.stdout).toContain("WT_AGENT_B_BILLING_BUG");
    expect(cliWtBExportRes.stdout).toContain("`[BUG]` `src/billing.ts:1-3`");
    expect(cliWtBExportRes.stdout).not.toContain("wt-agent-a");

    // Nonexistent worktree fails cleanly with exit code 1 and lists available worktrees
    const missingWtRes = runIde2Cli(["--worktree", "does-not-exist", "--export"], {
      cwd: fixture.mainDir,
      homeDir: fixture.fakeHome,
    });
    expect(missingWtRes.status).toBe(1);
    expect(missingWtRes.stderr).toContain('Worktree "does-not-exist" not found');
    expect(missingWtRes.stderr).toContain("wt-agent-a");
    expect(missingWtRes.stderr).toContain("wt-agent-b");

    // --- Zero-mutation & zero-lock invariant checks across ALL worktrees and .git ---
    const afterFiles = {
      main: snapshotWorktreeFiles(fixture.mainDir),
      wtA: snapshotWorktreeFiles(fixture.wtAgentADir),
      wtB: snapshotWorktreeFiles(fixture.wtAgentBDir),
    };
    expect(afterFiles).toEqual(beforeFiles);

    const afterGitStatus = {
      main: git(fixture.mainDir, ["status", "--porcelain=v2", "-uall"]),
      wtA: git(fixture.wtAgentADir, ["status", "--porcelain=v2", "-uall"]),
      wtB: git(fixture.wtAgentBDir, ["status", "--porcelain=v2", "-uall"]),
    };
    expect(afterGitStatus).toEqual(beforeGitStatus);

    expect(existsSync(join(fixture.repoCommonDir, "index.lock"))).toBe(false);
    expect(findLockFiles(fixture.repoCommonDir)).toEqual([]);
    expect(findLockFiles(fixture.wtAgentADir)).toEqual([]);
    expect(findLockFiles(fixture.wtAgentBDir)).toEqual([]);
  });
});
