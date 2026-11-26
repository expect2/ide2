import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AnnotationStore } from "../src/main/services/annotations.js";
import type { WorktreeInfo } from "../src/shared/protocol.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("AnnotationStore", () => {
  it("persists CRUD operations atomically under storageRoot and reloads from disk", async () => {
    const root = makeTempDir("ide2-ann-test-");
    const repoCommonDir = join(root, "repo", ".git");
    const wtPath = join(root, "repo");
    const storageRoot = join(root, "storage");

    const store = new AnnotationStore(repoCommonDir, storageRoot);

    const created = await store.create({
      worktreePath: wtPath,
      filePath: "src\\auth.ts",
      startLine: 2,
      endLine: 3,
      comment: "Missing null check before reading token",
      selectedText: "const token = req.headers.authorization;\nreturn token.split(' ')[1];",
      contextBefore: "export function parseAuth(req: Req) {",
      contextAfter: "}",
      contentHash: "hash-v1",
      language: "typescript",
    });

    expect(created.filePath).toBe("src/auth.ts");
    expect(created.status).toBe("open");
    expect(existsSync(store.getStorageFilePath())).toBe(true);

    const updated = await store.update({
      id: created.id,
      comment: "Validate authorization header presence",
    });
    expect(updated.comment).toBe("Validate authorization header presence");

    // Reload from a fresh AnnotationStore instance
    const reloadedStore = new AnnotationStore(repoCommonDir, storageRoot);
    const loaded = await reloadedStore.list(wtPath);
    expect(loaded.length).toBe(1);
    expect(loaded[0]?.id).toBe(created.id);
    expect(loaded[0]?.comment).toBe("Validate authorization header presence");

    await reloadedStore.delete(created.id);
    expect(await reloadedStore.list(wtPath)).toEqual([]);
  });

  it("re-anchors annotations when lines shift above and marks outdated when code is rewritten", async () => {
    const root = makeTempDir("ide2-ann-drift-");
    const store = new AnnotationStore(join(root, ".git"), root);
    const wtPath = join(root, "wt");

    const originalLines = [
      "function a() {",
      "  return 1;",
      "}",
      "function b() {",
      "  const target = compute();",
      "  return target;",
      "}",
      "function c() {",
      "  const target = compute();",
      "  return target;",
      "}",
    ];

    const ann = await store.create({
      worktreePath: wtPath,
      filePath: "src/calc.ts",
      startLine: 5,
      endLine: 6,
      comment: "Extract helper",
      selectedText: "  const target = compute();\n  return target;",
      contextBefore: "function b() {",
      contextAfter: "}",
      contentHash: "h1",
    });

    const oldSideAnn = await store.create({
      worktreePath: wtPath,
      filePath: "src/calc.ts",
      side: "old",
      startLine: 2,
      endLine: 2,
      comment: "Why was this removed?",
      selectedText: "  return 1;",
      contentHash: "h1",
    });

    // Insert 3 lines at the top of the file -> annotation at 5-6 should shift to 8-9
    // Even though function c also has identical selectedText, contextBefore ("function b() {") disambiguates!
    const shiftedLines = [
      "// header line 1",
      "// header line 2",
      "// header line 3",
      ...originalLines,
    ];
    await store.reconcileFile(wtPath, "src/calc.ts", shiftedLines, "h2");

    const afterShift = await store.list(wtPath);
    const shiftedAnn = afterShift.find((a) => a.id === ann.id);
    expect(shiftedAnn?.status).toBe("open");
    expect(shiftedAnn?.startLine).toBe(8);
    expect(shiftedAnn?.endLine).toBe(9);
    expect(shiftedAnn?.anchor?.contentHash).toBe("h2");

    // Old-side diff annotation must NOT be touched by reconcileFile
    const unchangedOld = afterShift.find((a) => a.id === oldSideAnn.id);
    expect(unchangedOld?.status).toBe("open");
    expect(unchangedOld?.startLine).toBe(2);

    // Rewrite the anchored snippet -> status becomes "outdated"
    const rewrittenLines = shiftedLines.map((l) =>
      l.includes("compute()") ? "  return computeDirect();" : l,
    );
    await store.reconcileFile(wtPath, "src/calc.ts", rewrittenLines, "h3");

    const afterRewrite = await store.list(wtPath);
    expect(afterRewrite.find((a) => a.id === ann.id)?.status).toBe("outdated");
  });

  it("compiles Markdown feedback prompt and marks included annotations resolved when requested", async () => {
    const root = makeTempDir("ide2-ann-export-");
    const store = new AnnotationStore(join(root, ".git"), root);
    const wtPath = join(root, "wt-api");

    const worktree: WorktreeInfo = {
      path: wtPath,
      name: "wt-api",
      branch: "feat/api",
      headSha: "abcdef1",
      headSubject: "wip",
      isMain: false,
      baseRef: "main",
      mergeBaseSha: "1234567",
      ahead: 1,
      behind: 0,
      counts: {
        modified: 1,
        added: 0,
        deleted: 0,
        untracked: 0,
        conflicted: 0,
        branchChanged: 1,
      },
      lastActivityAt: Date.now(),
    };

    const note = await store.create({
      worktreePath: wtPath,
      comment: "Overall structure looks great.",
    });

    const bug = await store.create({
      worktreePath: wtPath,
      filePath: "src/server.ts",
      startLine: 12,
      endLine: 12,
      comment: "Handle timeout errors",
      selectedText: "await fetch(url);",
      contentHash: "h1",
    });

    const compiled = await store.compilePrompt(worktree, {
      worktreePath: wtPath,
      resolveAfterExport: true,
    });

    expect(compiled.count).toBe(2);
    expect(compiled.markdown).toContain("# Code Review Feedback — `wt-api`");
    expect(compiled.markdown).toContain("## Overall Notes\n\nOverall structure looks great.");
    expect(compiled.markdown).toContain("## 1. `src/server.ts:12`");
    expect(compiled.markdown).toContain("Handle timeout errors");
    expect(compiled.markdown).not.toMatch(/\[(BUG|CHANGE|QUESTION|KEEP)\]/);

    const remaining = await store.list(wtPath);
    expect(remaining.find((a) => a.id === note.id)?.status).toBe("resolved");
    expect(remaining.find((a) => a.id === bug.id)?.status).toBe("resolved");

    // Re-exporting when all are resolved returns count 0
    const secondExport = await store.compilePrompt(worktree, { worktreePath: wtPath });
    expect(secondExport.count).toBe(0);
    expect(secondExport.markdown).toBe("");
  });
});
