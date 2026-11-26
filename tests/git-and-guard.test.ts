import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSafeGitArgs, insideWorktree, toPosixPath } from "../src/shared/guard.js";
import { WorktreeService, resolveRepoContext } from "../src/main/services/git.js";
import { MultiWorktreeWatcher } from "../src/main/services/watcher.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createRepoWithWorktrees() {
  const root = makeTempDir("ide2-git-test-");
  const mainDir = join(root, "repo-main");
  const outsideDir = join(root, "outside");
  mkdirSync(mainDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  writeFileSync(join(outsideDir, "secret.txt"), "top-secret\n", "utf8");

  git(mainDir, ["init", "-b", "main"]);
  git(mainDir, ["config", "user.email", "test@example.com"]);
  git(mainDir, ["config", "user.name", "Test User"]);

  mkdirSync(join(mainDir, "src"), { recursive: true });
  writeFileSync(
    join(mainDir, "src", "app.ts"),
    [
      "export function greet(name: string): string {",
      "  const prefix = 'Hello';",
      "  return `${prefix}, ${name}!`;",
      "}",
      "",
      "export const version = 1;",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(join(mainDir, "README.md"), "# Test Repo\n![logo](assets/logo.png)\n", "utf8");
  mkdirSync(join(mainDir, "assets"), { recursive: true });
  // Minimal 1x1 PNG bytes
  const pngBytes = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
    "hex",
  );
  writeFileSync(join(mainDir, "assets", "logo.png"), pngBytes);

  git(mainDir, ["add", "."]);
  git(mainDir, ["commit", "-m", "initial commit"]);
  const rootCommitSha = git(mainDir, ["rev-parse", "HEAD"]);

  // Create linked worktree in .claude/worktrees/feat-api
  const linkedDir = join(mainDir, ".claude", "worktrees", "feat-api");
  mkdirSync(join(mainDir, ".claude", "worktrees"), { recursive: true });
  git(mainDir, ["worktree", "add", "-b", "feat/api", linkedDir, "main"]);

  // Commit a change in the linked worktree
  writeFileSync(
    join(linkedDir, "src", "committed.ts"),
    "export const committed = true;\n",
    "utf8",
  );
  git(linkedDir, ["add", "src/committed.ts"]);
  git(linkedDir, ["commit", "-m", "feat: add committed module"]);
  const featureCommitSha = git(linkedDir, ["rev-parse", "HEAD"]);

  // Uncommitted modification to tracked file in linked worktree (plus a deleted line & added line)
  writeFileSync(
    join(linkedDir, "src", "app.ts"),
    [
      "export function greet(name: string): string {",
      "  const prefix = 'Hi';",
      "  return `${prefix}, ${name}!`;",
      "}",
      "",
      "// trailing comment",
      "",
    ].join("\n"),
    "utf8",
  );

  // Untracked agent-created file in linked worktree
  writeFileSync(
    join(linkedDir, "src", "agent-new.ts"),
    ["export function helper() {", "  return 42;", "}", ""].join("\n"),
    "utf8",
  );

  // Symlink inside mainDir pointing outside
  try {
    symlinkSync(join(outsideDir, "secret.txt"), join(mainDir, "leak.txt"));
  } catch {
    // ignore on platforms without symlink permissions
  }

  return {
    root,
    mainDir: realpathSync(mainDir),
    linkedDir: realpathSync(linkedDir),
    outsideDir: realpathSync(outsideDir),
    rootCommitSha,
    featureCommitSha,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("guard.ts: buildSafeGitArgs & insideWorktree", () => {
  it("prepends --no-optional-locks and refuses mutating subcommands", () => {
    expect(buildSafeGitArgs(["status", "--porcelain=v2"])).toEqual([
      "--no-optional-locks",
      "status",
      "--porcelain=v2",
    ]);

    expect(() => buildSafeGitArgs(["commit", "-m", "x"])).toThrow(/Refused disallowed/);
    expect(() => buildSafeGitArgs(["checkout", "main"])).toThrow(/Refused disallowed/);
    expect(() => buildSafeGitArgs(["reset", "--hard"])).toThrow(/Refused disallowed/);
    expect(() => buildSafeGitArgs(["branch", "-D", "feat/x"])).toThrow(/Refused mutating/);
    expect(() => buildSafeGitArgs(["worktree", "add", "/tmp/wt"])).toThrow(/Refused git worktree/);
    expect(
      buildSafeGitArgs(["worktree", "add", "/tmp/wt", "feat/x"], { allowWorktreeAdd: true }),
    ).toEqual(["--no-optional-locks", "worktree", "add", "/tmp/wt", "feat/x"]);
  });

  it("rejects path traversal, directories, and symlinks pointing outside worktree", () => {
    const { mainDir } = createRepoWithWorktrees();

    expect(insideWorktree(mainDir, "src/app.ts")).toBe(join(mainDir, "src", "app.ts"));
    expect(insideWorktree(mainDir, "../outside/secret.txt")).toBeUndefined();
    expect(insideWorktree(mainDir, "src")).toBeUndefined();
    expect(insideWorktree(mainDir, "does-not-exist.ts")).toBeUndefined();
    expect(insideWorktree(mainDir, "leak.txt")).toBeUndefined();
    expect(toPosixPath("src\\auth\\session.ts")).toBe("src/auth/session.ts");
  });
});

describe("git.ts: resolveRepoContext & WorktreeService", () => {
  it("resolves repo context from repo root, subdir, file, and file:line:col", async () => {
    const { mainDir } = createRepoWithWorktrees();

    const fromRoot = await resolveRepoContext(mainDir);
    expect(fromRoot.initialWorktreePath).toBe(mainDir);
    expect(fromRoot.repoCommonDir).toBe(join(mainDir, ".git"));
    expect(fromRoot.repoName).toBe("repo-main");
    expect(fromRoot.initialFilePath).toBeUndefined();

    const fromNested = await resolveRepoContext(join(mainDir, "src"));
    expect(fromNested.initialWorktreePath).toBe(mainDir);
    expect(fromNested.initialFilePath).toBeUndefined();

    const fromFileLoc = await resolveRepoContext(`${join(mainDir, "src", "app.ts")}:3:11`);
    expect(fromFileLoc.initialWorktreePath).toBe(mainDir);
    expect(fromFileLoc.initialFilePath).toBe("src/app.ts");
    expect(fromFileLoc.initialLine).toBe(3);
    expect(fromFileLoc.initialColumn).toBe(11);
  });

  it("discovers multiple worktrees with counts, ahead/behind, and preserves lastActivityAt", async () => {
    const { mainDir, linkedDir } = createRepoWithWorktrees();
    const service = new WorktreeService();

    const worktrees = await service.discoverWorktrees(mainDir);
    expect(worktrees.length).toBe(2);

    const mainWt = worktrees.find((w) => w.path === mainDir);
    const linkedWt = worktrees.find((w) => w.path === linkedDir);

    expect(mainWt).toBeDefined();
    expect(mainWt?.isMain).toBe(true);
    expect(mainWt?.branch).toBe("main");
    expect(mainWt?.baseRef).toBe("main");
    expect(mainWt?.ahead).toBe(0);

    expect(linkedWt).toBeDefined();
    expect(linkedWt?.isMain).toBe(false);
    expect(linkedWt?.name).toBe("feat-api");
    expect(linkedWt?.branch).toBe("feat/api");
    expect(linkedWt?.baseRef).toBe("main");
    expect(linkedWt?.ahead).toBe(1);
    expect(linkedWt?.behind).toBe(0);
    expect(linkedWt?.counts.modified).toBe(1);
    expect(linkedWt?.counts.untracked).toBe(1);
    // committed.ts + app.ts + agent-new.ts = 3 files changed vs merge-base
    expect(linkedWt?.counts.branchChanged).toBe(3);

    // Cache read & activity preservation
    service.touchActivity(linkedDir, 1234567890);
    expect(service.getCachedWorktree(linkedDir)?.lastActivityAt).toBe(1234567890);
    const rediscovered = await service.discoverWorktrees(linkedDir);
    expect(rediscovered.find((w) => w.path === linkedDir)?.lastActivityAt).toBe(1234567890);
  });

  it("reads files with security checks, binary detection, truncation, and lineGitMarkers", async () => {
    const { mainDir, linkedDir } = createRepoWithWorktrees();
    const service = new WorktreeService();

    await expect(service.readFile(mainDir, "../outside/secret.txt")).rejects.toThrow();
    await expect(service.readFile(mainDir, "leak.txt")).rejects.toThrow();

    const doc = await service.readFile(linkedDir, "src/app.ts", { kind: "branch" });
    expect(doc.language).toBe("typescript");
    expect(doc.isBinary).toBe(false);
    expect(doc.isTruncated).toBe(false);
    expect(doc.lineGitMarkers?.[2]).toBe("modified");
    expect(doc.lineGitMarkers?.[6]).toBe("modified"); // version=1 -> // trailing comment

    // Untracked file has all lines marked added
    const untrackedDoc = await service.readFile(linkedDir, "src/agent-new.ts", { kind: "branch" });
    expect(untrackedDoc.lineGitMarkers?.[1]).toBe("added");
    expect(untrackedDoc.lineGitMarkers?.[2]).toBe("added");
    expect(untrackedDoc.lineGitMarkers?.[3]).toBe("added");

    // Binary file detection
    const binDoc = await service.readFile(mainDir, "assets/logo.png");
    expect(binDoc.isBinary).toBe(true);
    expect(binDoc.lines).toEqual([]);

    // 2MB truncation
    const bigFile = join(linkedDir, "big.txt");
    writeFileSync(bigFile, "a".repeat(2 * 1024 * 1024 + 500), "utf8");
    const bigDoc = await service.readFile(linkedDir, "big.txt", { kind: "working" });
    expect(bigDoc.isTruncated).toBe(true);

    // Asset data URL resolution
    const dataUrl = await service.readAssetDataUrl(mainDir, "README.md", "assets/logo.png");
    expect(dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(await service.readAssetDataUrl(mainDir, "README.md", "../outside/secret.txt")).toBeNull();
    expect(await service.readAssetDataUrl(mainDir, "README.md", "https://example.com/a.png")).toBeNull();
  });

  it("computes diffs across branch, working, commit (including root), and worktree scopes with word diffs", async () => {
    const { mainDir, linkedDir, rootCommitSha, featureCommitSha } = createRepoWithWorktrees();
    const service = new WorktreeService();

    // 1. Branch scope (includes committed + uncommitted + untracked)
    const branchFiles = await service.listChangedFiles(linkedDir, { kind: "branch" });
    expect(branchFiles.map((f) => f.path)).toEqual([
      "src/agent-new.ts",
      "src/app.ts",
      "src/committed.ts",
    ]);

    const appDiff = await service.getDiff(linkedDir, "src/app.ts", { kind: "branch" });
    expect(appDiff.additions).toBe(2);
    expect(appDiff.deletions).toBe(2);
    const modifyRows = appDiff.rows.filter((r) => r.type === "modify");
    expect(modifyRows.length).toBe(2);
    expect(modifyRows[0]?.oldParts?.some((p) => p.removed && p.text.includes("Hello"))).toBe(true);
    expect(modifyRows[0]?.newParts?.some((p) => p.added && p.text.includes("Hi"))).toBe(true);

    // Untracked file diff shows full green additions
    const untrackedDiff = await service.getDiff(linkedDir, "src/agent-new.ts", { kind: "working" });
    expect(untrackedDiff.additions).toBe(3);
    expect(untrackedDiff.deletions).toBe(0);
    expect(untrackedDiff.rows.filter((r) => r.type === "add").length).toBe(3);

    // 2. Commit scope (root commit + feature commit)
    const rootCommitFiles = await service.listChangedFiles(linkedDir, {
      kind: "commit",
      sha: rootCommitSha,
    });
    expect(rootCommitFiles.some((f) => f.path === "src/app.ts" && f.status === "added")).toBe(true);

    const rootAppDiff = await service.getDiff(linkedDir, "src/app.ts", {
      kind: "commit",
      sha: rootCommitSha,
    });
    expect(rootAppDiff.additions).toBeGreaterThan(0);
    expect(rootAppDiff.deletions).toBe(0);

    const featDiff = await service.getDiff(linkedDir, "src/committed.ts", {
      kind: "commit",
      sha: featureCommitSha,
    });
    expect(featDiff.additions).toBe(1);

    // 3. Worktree-to-worktree scope (in-process diff)
    const wtChanged = await service.listChangedFiles(linkedDir, {
      kind: "worktree",
      otherWorktreePath: mainDir,
    });
    expect(wtChanged.map((f) => f.path)).toEqual([
      "src/agent-new.ts",
      "src/app.ts",
      "src/committed.ts",
    ]);

    const wtAppDiff = await service.getDiff(linkedDir, "src/app.ts", {
      kind: "worktree",
      otherWorktreePath: mainDir,
    });
    expect(wtAppDiff.rows.some((r) => r.type === "modify")).toBe(true);

    // Commits & blame
    const commits = await service.listCommits(linkedDir, 10);
    expect(commits.length).toBe(2);
    expect(commits[0]?.subject).toBe("feat: add committed module");

    const blame = await service.getBlame(linkedDir, "src/committed.ts");
    expect(blame.length).toBe(1);
    expect(blame[0]?.author).toBe("Test User");
    expect(blame[0]?.summary).toBe("feat: add committed module");
  });

  it("creates a new worktree via createWorktree and watches changes with MultiWorktreeWatcher", async () => {
    const { mainDir, root } = createRepoWithWorktrees();
    const service = new WorktreeService();

    const newWtDir = join(root, "wt-created");
    const created = await service.createWorktree({
      baseWorktreePath: mainDir,
      branchName: "feat/created",
      baseRef: "main",
      targetDir: newWtDir,
    });

    expect(created.path).toBe(realpathSync(newWtDir));
    expect(created.branch).toBe("feat/created");

    const events: Array<{ worktreePath: string; changedFiles: string[] }> = [];
    const watcher = new MultiWorktreeWatcher(
      [created],
      join(mainDir, ".git"),
      (ev) => events.push(ev),
      {
        debounceMs: 60,
        onActivity: (wtPath, ts) => service.touchActivity(wtPath, ts),
      },
    );

    // Create ignored files + real file
    mkdirSync(join(newWtDir, "node_modules"), { recursive: true });
    writeFileSync(join(newWtDir, "node_modules", "ignored.js"), "x", "utf8");
    writeFileSync(join(newWtDir, "real-change.ts"), "export const x = 1;\n", "utf8");

    await new Promise((r) => setTimeout(r, 260));
    watcher.close();

    expect(events.length).toBeGreaterThan(0);
    const allChanged = events.flatMap((e) => e.changedFiles);
    expect(allChanged.some((f) => f.includes("node_modules"))).toBe(false);
  });
});
