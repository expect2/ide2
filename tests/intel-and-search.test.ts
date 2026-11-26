import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IntelClient } from "../src/main/intel/client";
import {
  COLD_TONAL_COLORS,
  ColdTonalHighlighter,
  EXPECT2_RETROFUTURE_NIGHT_THEME,
  highlightLines,
} from "../src/main/intel/highlight";
import {
  WorktreeFileIndex,
  findInPath,
  fuzzyFindFiles,
  resolveRipgrepPath,
} from "../src/main/intel/search";
import {
  WorktreeSymbolIndex,
  extractMarkdownHeadings,
  extractRegexSymbols,
  findDefinitionAndUsages,
  getStructure,
  searchSymbols,
} from "../src/main/intel/symbols";

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeFileRel(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
}

function initGitRepo(dir: string): void {
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@expect2.dev"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Expect2 Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
}

describe("expect2-ide intel & search subsystem", () => {
  let wtMain: string;
  let wtFeature: string;

  beforeAll(() => {
    wtMain = createTempDir("ide2-wt-main-");
    wtFeature = createTempDir("ide2-wt-feat-");

    writeFileRel(
      wtMain,
      "src/auth/session.ts",
      [
        "// Session manager for expect2",
        "export interface SessionToken {",
        "  id: string;",
        "  expiresAt: number;",
        "}",
        "",
        "export class SessionService {",
        "  validateSession(token: SessionToken): boolean {",
        '    return token.id.length > 0 && token.expiresAt > 0;',
        "  }",
        "}",
        "",
        "export function createSession(userId: string): SessionToken {",
        '  const prefix = "sess_";',
        "  return { id: prefix + userId, expiresAt: 9999 };",
        "}",
      ].join("\n"),
    );

    writeFileRel(
      wtMain,
      "src/auth/login.ts",
      [
        'import { createSession, SessionService } from "./session";',
        "",
        "export function loginUser(userId: string) {",
        "  const svc = new SessionService();",
        "  const tok = createSession(userId);",
        "  return svc.validateSession(tok);",
        "}",
      ].join("\n"),
    );

    writeFileRel(
      wtMain,
      "src/search/findDefinitionAndUsages.ts",
      [
        "// Unicode test: café ☕",
        "export function findDefinitionAndUsagesHelper(name: string): string {",
        '  const label = "café:" + name;',
        "  return label;",
        "}",
      ].join("\n"),
    );

    writeFileRel(
      wtMain,
      "scripts/worker.py",
      [
        "MAX_RETRIES = 3",
        "",
        "class TaskRunner:",
        "    def run_job(self, name: str) -> str:",
        '        return f"job:{name}"',
        "",
        "def compute_score(value: int) -> int:",
        "    return value * 2",
      ].join("\n"),
    );

    writeFileRel(
      wtMain,
      "README.md",
      [
        "# Architecture",
        "",
        "## Search Engine",
        "",
        "```bash",
        "# Not a markdown heading inside fenced code",
        "rg --files",
        "```",
        "",
        "### Fuzzy Ranking",
        "",
        "~~~python",
        "# Also not a heading",
        "def noop(): pass",
        "~~~",
        "",
        "## Syntax Highlighting",
      ].join("\n"),
    );

    initGitRepo(wtMain);

    writeFileRel(
      wtFeature,
      "src/auth/session.ts",
      "export function createSession() { return null; }\n",
    );
    writeFileRel(
      wtFeature,
      "src/billing/invoice.ts",
      "export const invoiceTotal = (amount: number) => amount * 2;\n",
    );
    initGitRepo(wtFeature);
  });

  afterAll(() => {
    rmSync(wtMain, { recursive: true, force: true });
    rmSync(wtFeature, { recursive: true, force: true });
  });

  describe("resolveRipgrepPath & WorktreeFileIndex", () => {
    it("rewrites app.asar to app.asar.unpacked for packaged Electron", () => {
      expect(resolveRipgrepPath("/Applications/ide2.app/Contents/Resources/app.asar/node_modules/@vscode/ripgrep/bin/rg")).toBe(
        "/Applications/ide2.app/Contents/Resources/app.asar.unpacked/node_modules/@vscode/ripgrep/bin/rg",
      );
    });

    it("caches POSIX relative files and falls back to git ls-files when rg fails to spawn", async () => {
      const idx = new WorktreeFileIndex();
      const files = await idx.getFiles(wtMain);
      expect(files).toContain("src/auth/session.ts");
      expect(files).toContain("scripts/worker.py");
      expect(idx.has(wtMain)).toBe(true);

      idx.invalidate(wtMain);
      expect(idx.has(wtMain)).toBe(false);

      const fallbackIdx = new WorktreeFileIndex("/nonexistent/rg-binary-path");
      const gitFiles = await fallbackIdx.getFiles(wtMain);
      expect(gitFiles).toContain("src/auth/session.ts");
      expect(gitFiles).toContain("README.md");
    });
  });

  describe("fuzzyFindFiles", () => {
    it("matches path abbreviations like s/a/sess and uppercase SESS / camelHump FDU", async () => {
      const idx = new WorktreeFileIndex();

      const slashHits = await fuzzyFindFiles({ worktreePath: wtMain, query: "s/a/sess" }, idx);
      expect(slashHits[0]?.filePath).toBe("src/auth/session.ts");

      const upperHits = await fuzzyFindFiles({ worktreePath: wtMain, query: "SESS" }, idx);
      expect(upperHits[0]?.filePath).toBe("src/auth/session.ts");

      const camelHits = await fuzzyFindFiles({ worktreePath: wtMain, query: "fDU" }, idx);
      expect(camelHits[0]?.filePath).toBe("src/search/findDefinitionAndUsages.ts");
    });

    it("strips :line suffixes and boosts git-modified files", async () => {
      const idx = new WorktreeFileIndex();
      const lineHits = await fuzzyFindFiles(
        {
          worktreePath: wtMain,
          query: "session.ts:42",
          worktrees: [
            {
              path: wtMain,
              name: "main",
              gitStatuses: { "src/auth/session.ts": "modified" },
            },
          ],
        },
        idx,
      );
      expect(lineHits[0]?.filePath).toBe("src/auth/session.ts");
      expect(lineHits[0]?.gitStatus).toBe("modified");
    });

    it("searches across allWorktrees when enabled", async () => {
      const idx = new WorktreeFileIndex();
      const hits = await fuzzyFindFiles(
        {
          worktreePath: wtMain,
          query: "invoice",
          allWorktrees: true,
          worktrees: [
            { path: wtMain, name: "main" },
            { path: wtFeature, name: "feature", gitStatuses: { "src/billing/invoice.ts": "added" } },
          ],
        },
        idx,
      );
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.worktreeName).toBe("feature");
      expect(hits[0]?.filePath).toBe("src/billing/invoice.ts");
      expect(hits[0]?.gitStatus).toBe("added");
    });
  });

  describe("findInPath", () => {
    it("supports fixed-string, regex, wholeWord, fileMask, and exact match offsets", async () => {
      const worktrees = [
        { path: wtMain, name: "main" },
        { path: wtFeature, name: "feature" },
      ];

      const fixedHits = await findInPath(
        { worktreePath: wtMain, query: "createSession", fileMask: "*.ts" },
        worktrees,
      );
      expect(fixedHits.length).toBe(3); // 1 def + 1 import + 1 call
      const defHit = fixedHits.find((m) => m.filePath === "src/auth/session.ts");
      expect(defHit).toBeDefined();
      expect(defHit!.line).toBe(13);
      expect(defHit!.lineText.slice(defHit!.matchStart, defHit!.matchEnd)).toBe("createSession");
      expect(defHit!.column).toBe(defHit!.matchStart + 1);

      const regexHits = await findInPath(
        {
          worktreePath: wtMain,
          query: "validate(Session|Token)",
          isRegex: true,
          caseSensitive: true,
        },
        worktrees,
      );
      expect(regexHits.length).toBeGreaterThanOrEqual(2);

      const allWtHits = await findInPath(
        {
          worktreePath: wtMain,
          allWorktrees: true,
          query: "createSession",
          wholeWord: true,
        },
        worktrees,
      );
      const wtNames = new Set(allWtHits.map((m) => m.worktreeName));
      expect(wtNames.has("main")).toBe(true);
      expect(wtNames.has("feature")).toBe(true);
    });

    it("computes accurate UTF-16 offsets after multi-byte characters and supports git grep fallback", async () => {
      const worktrees = [{ path: wtMain, name: "main" }];
      const unicodeHits = await findInPath(
        { worktreePath: wtMain, query: "name", fileMask: "*findDefinitionAndUsages.ts" },
        worktrees,
      );
      const line3 = unicodeHits.find((m) => m.line === 3);
      expect(line3).toBeDefined();
      expect(line3!.lineText.slice(line3!.matchStart, line3!.matchEnd)).toBe("name");

      const fallbackHits = await findInPath(
        { worktreePath: wtMain, query: "createSession", wholeWord: true },
        worktrees,
        "/nonexistent/rg-binary-path",
      );
      expect(fallbackHits.length).toBeGreaterThanOrEqual(2);
      expect(fallbackHits.every((h) => h.lineText.slice(h.matchStart, h.matchEnd) === "createSession")).toBe(true);
    });
  });

  describe("ColdTonalHighlighter (expect2 Retrofuture Night)", () => {
    it("emits strictly cold-tonal TokenSpan classes and never green, red, or yellow colors", async () => {
      const sample = [
        "// Cold tonal comment",
        "export interface Config { timeout: number; }",
        'export function bootApp(cfg: Config): string {',
        '  const label = "retrofuture";',
        "  return label;",
        "}",
      ].join("\n");

      const lines = await highlightLines(sample, "ts", "hash-sample-1");
      expect(lines.length).toBe(6);

      const validClasses = new Set(["id", "decl", "kw", "type", "lit", "comment", "punct"]);
      for (const row of lines) {
        for (const span of row) {
          expect(validClasses.has(span.cls)).toBe(true);
        }
      }

      const findClass = (lineIdx: number, substr: string) =>
        lines[lineIdx]!.find((s) => s.text.includes(substr))?.cls;

      expect(findClass(0, "Cold tonal")).toBe("comment");
      expect(findClass(1, "interface")).toBe("kw");
      expect(findClass(1, "number")).toBe("type");
      expect(findClass(2, "function")).toBe("kw");
      expect(findClass(2, "bootApp")).toBe("decl");
      expect(findClass(3, "const")).toBe("kw");
      expect(findClass(3, "retrofuture")).toBe("lit");

      // Verify theme & color palette contain only cold hues (blue channel >= red and blue >= green)
      const allHexes = [
        ...Object.values(COLD_TONAL_COLORS),
        ...(EXPECT2_RETROFUTURE_NIGHT_THEME.tokenColors?.map((t) => t.settings.foreground).filter(Boolean) as string[]),
      ];
      for (const hex of allHexes) {
        const r = Number.parseInt(hex.slice(1, 3), 16);
        const g = Number.parseInt(hex.slice(3, 5), 16);
        const b = Number.parseInt(hex.slice(5, 7), 16);
        expect(b).toBeGreaterThanOrEqual(r);
        expect(b).toBeGreaterThanOrEqual(g);
      }
    });

    it("caches by contentHash (LRU 120) and handles >4000-line files quickly via lexical fallback", async () => {
      const hl = new ColdTonalHighlighter();
      const first = await hl.highlightLines("const x = 1;", "ts", "h1");
      const second = await hl.highlightLines("const x = 1;", "ts", "h1");
      expect(second).toBe(first);
      expect(hl.cacheSize).toBe(1);

      const bigLines = Array.from({ length: 12000 }, (_, i) => `const item_${i} = ${i}; // line`);
      const t0 = performance.now();
      const bigTokens = await hl.highlightLines(bigLines, "ts", "big-12k");
      const elapsed = performance.now() - t0;
      expect(bigTokens.length).toBe(12000);
      expect(elapsed).toBeLessThan(250);
    });
  });

  describe("AST symbols, Markdown outline & findDefinitionAndUsages", () => {
    it("extracts Markdown ATX heading hierarchy and ignores # inside fenced code blocks", () => {
      const md = [
        "# Architecture",
        "## Search Engine",
        "```bash",
        "# Ignored heading",
        "```",
        "### Fuzzy Ranking",
        "## Syntax Highlighting",
      ].join("\n");

      const outline = extractMarkdownHeadings(wtMain, "README.md", md);
      expect(outline.length).toBe(1);
      expect(outline[0]!.name).toBe("Architecture");
      expect(outline[0]!.kind).toBe("heading");
      expect(outline[0]!.children?.length).toBe(2);
      expect(outline[0]!.children?.[0]?.name).toBe("Search Engine");
      expect(outline[0]!.children?.[0]?.children?.[0]?.name).toBe("Fuzzy Ranking");
      expect(outline[0]!.children?.[1]?.name).toBe("Syntax Highlighting");
    });

    it("extracts TypeScript & Python Tree-sitter AST symbols and regex fallback", async () => {
      const symIdx = new WorktreeSymbolIndex();

      const tsSymbols = await getStructure(wtMain, "src/auth/session.ts", undefined, symIdx);
      const tsNames = tsSymbols.map((s) => `${s.kind}:${s.name}`);
      expect(tsNames).toContain("interface:SessionToken");
      expect(tsNames).toContain("class:SessionService");
      expect(tsNames).toContain("function:createSession");
      const cls = tsSymbols.find((s) => s.name === "SessionService");
      expect(cls?.children?.some((c) => c.kind === "method" && c.name === "validateSession")).toBe(true);

      const pySymbols = await getStructure(wtMain, "scripts/worker.py", undefined, symIdx);
      expect(pySymbols.some((s) => s.kind === "const" && s.name === "MAX_RETRIES")).toBe(true);
      expect(pySymbols.some((s) => s.kind === "class" && s.name === "TaskRunner")).toBe(true);
      expect(pySymbols.some((s) => s.kind === "function" && s.name === "compute_score")).toBe(true);

      const swiftFallback = extractRegexSymbols(
        wtMain,
        "App.swift",
        "struct AppState {\n}\nfunc startApp() {}\n",
      );
      expect(swiftFallback.some((s) => s.name === "AppState" && s.kind === "class")).toBe(true);
      expect(swiftFallback.some((s) => s.name === "startApp" && s.kind === "function")).toBe(true);
    });

    it("ranks symbols with searchSymbols and separates definitions from usages", async () => {
      const symIdx = new WorktreeSymbolIndex();
      const syms = await searchSymbols({ worktreePath: wtMain, query: "Session" }, symIdx);
      expect(syms.some((s) => s.name === "SessionService")).toBe(true);
      expect(syms.some((s) => s.name === "createSession")).toBe(true);

      const { definitions, usages } = await findDefinitionAndUsages(
        {
          worktreePath: wtMain,
          filePath: "src/auth/login.ts",
          symbolName: "createSession",
          line: 5,
        },
        symIdx,
      );
      expect(definitions.length).toBe(1);
      expect(definitions[0]?.filePath).toBe("src/auth/session.ts");
      expect(definitions[0]?.line).toBe(13);

      expect(usages.length).toBe(2);
      expect(usages.every((u) => u.filePath === "src/auth/login.ts")).toBe(true);
    });
  });

  describe("IntelClient facade", () => {
    it("runs analyzeFile, search, and invalidation cleanly in-process", async () => {
      const client = new IntelClient();
      const analyzed = await client.analyzeFile(
        wtMain,
        "src/auth/session.ts",
        "session-v1",
        "export function ping(): boolean { return true; }\n",
      );
      expect(analyzed.tokens.length).toBeGreaterThan(0);
      expect(analyzed.symbols.some((s) => s.name === "ping" && s.kind === "function")).toBe(true);

      const hits = await client.fuzzyFindFiles({ worktreePath: wtMain, query: "login" });
      expect(hits[0]?.filePath).toBe("src/auth/login.ts");

      client.invalidateWorktree(wtMain);
      await client.dispose();
    });
  });
});
