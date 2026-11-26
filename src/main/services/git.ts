import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createTwoFilesPatch, diffWordsWithSpace, parsePatch } from "diff";
import { buildSafeGitArgs, insideWorktree, toPosixPath } from "../../shared/guard.js";
import type {
  ChangedFileSummary,
  CommitEntry,
  DiffRow,
  DiffScope,
  FileDiffResult,
  FileDocument,
  FileEntry,
  FileGitStatus,
  LaunchContext,
  LineBlame,
  WordDiffPart,
  WorktreeInfo,
} from "../../shared/protocol.js";

const execFileAsync = promisify(execFile);

const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const BINARY_PROBE_BYTES = 8192;

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

const EXTENSION_LANGUAGES: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  md: "markdown",
  mdx: "mdx",
  json: "json",
  jsonc: "jsonc",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  css: "css",
  scss: "scss",
  html: "html",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  swift: "swift",
  kt: "kotlin",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cc: "cpp",
  rb: "ruby",
  php: "php",
  txt: "plaintext",
};

export interface CreateWorktreeParams {
  baseWorktreePath: string;
  branchName: string;
  baseRef?: string;
  targetDir?: string;
}

interface ExecGitOptions {
  allowWorktreeAdd?: boolean;
}

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_INDEX_FILE;
  return env;
}

async function runGit(
  cwd: string,
  args: readonly string[],
  options?: ExecGitOptions,
): Promise<string> {
  const safeArgs = buildSafeGitArgs(args, options);
  const { stdout } = await execFileAsync("git", safeArgs, {
    cwd,
    env: cleanGitEnv(),
    maxBuffer: MAX_BUFFER_BYTES,
    encoding: "utf8",
  });
  return stdout;
}

async function runGitBuffer(
  cwd: string,
  args: readonly string[],
): Promise<Buffer> {
  const safeArgs = buildSafeGitArgs(args);
  const { stdout } = await execFileAsync("git", safeArgs, {
    cwd,
    env: cleanGitEnv(),
    maxBuffer: MAX_BUFFER_BYTES,
    encoding: "buffer",
  });
  return stdout;
}

async function tryRunGit(
  cwd: string,
  args: readonly string[],
): Promise<string | null> {
  try {
    return await runGit(cwd, args);
  } catch {
    return null;
  }
}

function tryRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function isBinaryBuffer(buf: Buffer): boolean {
  const limit = Math.min(buf.length, BINARY_PROBE_BYTES);
  for (let i = 0; i < limit; i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function inferLanguage(filePath: string): string {
  const base = basename(filePath).toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile") return "makefile";
  const ext = base.includes(".") ? (base.split(".").pop() ?? "") : "";
  return EXTENSION_LANGUAGES[ext] ?? "plaintext";
}

function splitLinesPreserve(text: string): string[] {
  if (text.length === 0) return [""];
  return text.split(/\r?\n/);
}

function splitLinesForDiff(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function countTextLines(buf: Buffer): number {
  if (buf.length === 0 || isBinaryBuffer(buf)) return 0;
  let count = 1;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 10) count += 1;
  }
  if (buf[buf.length - 1] === 10) {
    count -= 1;
  }
  return Math.max(0, count);
}

function sha1Hex(data: Buffer | string): string {
  return createHash("sha1").update(data).digest("hex");
}

function isLexicallyInside(root: string, candidate: string): string | undefined {
  const canonRoot = tryRealpath(root);
  const resolved = resolve(canonRoot, candidate);
  const rel = relative(canonRoot, resolved);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return undefined;
  }
  return rel;
}

function formatRelativeTimeFromUnix(unixSeconds: number, nowMs = Date.now()): string {
  const diffSec = Math.max(0, Math.floor(nowMs / 1000) - unixSeconds);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMonth = Math.floor(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth}mo ago`;
  const diffYear = Math.floor(diffDay / 365);
  return `${diffYear}y ago`;
}

function currentPlatform(): LaunchContext["platform"] {
  if (process.platform === "win32") return "win32";
  if (process.platform === "linux") return "linux";
  return "darwin";
}

function parseTargetLocation(targetPath: string): {
  fsPath: string;
  line?: number;
  column?: number;
} {
  const resolvedDirect = resolve(targetPath);
  if (existsSync(resolvedDirect)) {
    return { fsPath: resolvedDirect };
  }

  const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(targetPath);
  if (match && match[1]) {
    const line = Number.parseInt(match[2] ?? "", 10);
    const column = match[3] ? Number.parseInt(match[3], 10) : undefined;
    return {
      fsPath: resolve(match[1]),
      line: Number.isFinite(line) && line > 0 ? line : undefined,
      column: column !== undefined && Number.isFinite(column) && column > 0 ? column : undefined,
    };
  }

  return { fsPath: resolvedDirect };
}

/**
 * Resolves a CLI target path (repo root, nested dir, file, or `file.ts:line[:col]`)
 * into canonical git repository & launch context.
 */
export async function resolveRepoContext(targetPath: string): Promise<LaunchContext> {
  const parsed = parseTargetLocation(targetPath);
  if (!existsSync(parsed.fsPath)) {
    throw new Error(`Target path does not exist: ${parsed.fsPath}`);
  }

  const canonTarget = realpathSync(parsed.fsPath);
  const st = statSync(canonTarget);
  const cwdForGit = st.isFile() ? dirname(canonTarget) : canonTarget;

  const [rawToplevel, rawCommonDir] = await Promise.all([
    runGit(cwdForGit, ["rev-parse", "--show-toplevel"]),
    runGit(cwdForGit, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  ]);

  const initialWorktreePath = realpathSync(rawToplevel.trim());
  const repoCommonDir = realpathSync(rawCommonDir.trim());
  const commonBase = basename(repoCommonDir);
  const repoName =
    commonBase === ".git"
      ? basename(dirname(repoCommonDir))
      : commonBase.replace(/\.git$/i, "") || commonBase;

  let initialFilePath: string | undefined;
  let initialLine: number | undefined;
  let initialColumn: number | undefined;

  if (st.isFile()) {
    const rel = relative(initialWorktreePath, canonTarget);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
      initialFilePath = toPosixPath(rel);
      initialLine = parsed.line;
      initialColumn = parsed.column;
    }
  }

  return {
    repoCommonDir,
    repoName,
    initialWorktreePath,
    initialFilePath,
    initialLine,
    initialColumn,
    platform: currentPlatform(),
  };
}

interface ParsedWorktreeBlock {
  path: string;
  headSha: string;
  branch: string;
  bare: boolean;
  detached: boolean;
  prunable: boolean;
}

function parsePorcelainWorktrees(output: string): ParsedWorktreeBlock[] {
  const blocks: ParsedWorktreeBlock[] = [];
  const rawBlocks = output.trim().split(/\r?\n\r?\n+/);
  for (const block of rawBlocks) {
    if (!block.trim()) continue;
    let wtPath = "";
    let headSha = "";
    let branch = "(detached)";
    let bare = false;
    let detached = false;
    let prunable = false;

    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) {
        wtPath = line.slice("worktree ".length);
      } else if (line.startsWith("HEAD ")) {
        headSha = line.slice("HEAD ".length).trim();
      } else if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length).trim();
        branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
      } else if (line === "bare") {
        bare = true;
      } else if (line === "detached") {
        detached = true;
        branch = "(detached)";
      } else if (line === "prunable" || line.startsWith("prunable ")) {
        prunable = true;
      }
    }

    if (wtPath) {
      blocks.push({ path: wtPath, headSha, branch, bare, detached, prunable });
    }
  }
  return blocks;
}

function mapGitStatusLetter(letter: string): FileGitStatus {
  switch (letter) {
    case "A":
    case "C":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "U":
      return "conflicted";
    case "M":
    case "T":
      return "modified";
    default:
      return "modified";
  }
}

function computeWordParts(oldText: string, newText: string): {
  oldParts: WordDiffPart[];
  newParts: WordDiffPart[];
} {
  const changes = diffWordsWithSpace(oldText, newText);
  const oldParts: WordDiffPart[] = [];
  const newParts: WordDiffPart[] = [];

  for (const ch of changes) {
    if (ch.removed) {
      oldParts.push({ text: ch.value, removed: true });
    } else if (ch.added) {
      newParts.push({ text: ch.value, added: true });
    } else {
      oldParts.push({ text: ch.value });
      newParts.push({ text: ch.value });
    }
  }

  return { oldParts, newParts };
}

function parsePatchToRows(rawPatch: string): {
  rows: DiffRow[];
  additions: number;
  deletions: number;
  oldPath?: string;
} {
  const parsed = parsePatch(rawPatch);
  const first = parsed[0];
  if (!first) {
    return { rows: [], additions: 0, deletions: 0 };
  }

  const rows: DiffRow[] = [];
  let additions = 0;
  let deletions = 0;

  interface PendingLine {
    lineNo: number;
    text: string;
  }

  const flushBuffers = (delBuf: PendingLine[], addBuf: PendingLine[]) => {
    const pairCount = Math.min(delBuf.length, addBuf.length);
    for (let i = 0; i < pairCount; i += 1) {
      const delItem = delBuf[i]!;
      const addItem = addBuf[i]!;
      const { oldParts, newParts } = computeWordParts(delItem.text, addItem.text);
      rows.push({
        type: "modify",
        oldLineNumber: delItem.lineNo,
        newLineNumber: addItem.lineNo,
        oldText: delItem.text,
        newText: addItem.text,
        oldParts,
        newParts,
      });
      deletions += 1;
      additions += 1;
    }

    for (let i = pairCount; i < delBuf.length; i += 1) {
      const delItem = delBuf[i]!;
      rows.push({
        type: "del",
        oldLineNumber: delItem.lineNo,
        oldText: delItem.text,
      });
      deletions += 1;
    }

    for (let i = pairCount; i < addBuf.length; i += 1) {
      const addItem = addBuf[i]!;
      rows.push({
        type: "add",
        newLineNumber: addItem.lineNo,
        newText: addItem.text,
      });
      additions += 1;
    }

    delBuf.length = 0;
    addBuf.length = 0;
  };

  for (const hunk of first.hunks) {
    rows.push({
      type: "hunk",
      header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    });

    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    const delBuf: PendingLine[] = [];
    const addBuf: PendingLine[] = [];

    for (const rawLine of hunk.lines) {
      if (rawLine.startsWith("\\")) {
        continue;
      }
      const prefix = rawLine[0];
      const text = rawLine.slice(1);
      if (prefix === "-") {
        if (addBuf.length > 0) {
          flushBuffers(delBuf, addBuf);
        }
        delBuf.push({ lineNo: oldLine, text });
        oldLine += 1;
      } else if (prefix === "+") {
        addBuf.push({ lineNo: newLine, text });
        newLine += 1;
      } else {
        flushBuffers(delBuf, addBuf);
        rows.push({
          type: "context",
          oldLineNumber: oldLine,
          newLineNumber: newLine,
          oldText: text,
          newText: text,
        });
        oldLine += 1;
        newLine += 1;
      }
    }

    flushBuffers(delBuf, addBuf);
  }

  let oldPath: string | undefined;
  if (first.oldFileName && first.oldFileName !== "/dev/null") {
    const cleanedOld = first.oldFileName.replace(/^a\//, "");
    const cleanedNew = (first.newFileName ?? "").replace(/^b\//, "");
    if (cleanedOld && cleanedNew && cleanedOld !== cleanedNew) {
      oldPath = cleanedOld;
    }
  }

  return { rows, additions, deletions, oldPath };
}

function buildAddedOnlyDiff(filePath: string, newContent: string): {
  rows: DiffRow[];
  additions: number;
  rawPatch: string;
} {
  const lines = splitLinesForDiff(newContent);
  if (lines.length === 0) {
    return { rows: [], additions: 0, rawPatch: "" };
  }
  const header = `@@ -0,0 +1,${lines.length} @@`;
  const rows: DiffRow[] = [{ type: "hunk", header }];
  const patchLines = [
    `--- /dev/null`,
    `+++ b/${filePath}`,
    header,
  ];

  lines.forEach((line, idx) => {
    rows.push({
      type: "add",
      newLineNumber: idx + 1,
      newText: line,
    });
    patchLines.push(`+${line}`);
  });

  return {
    rows,
    additions: lines.length,
    rawPatch: `${patchLines.join("\n")}\n`,
  };
}

function buildDeletedOnlyDiff(filePath: string, oldContent: string): {
  rows: DiffRow[];
  deletions: number;
  rawPatch: string;
} {
  const lines = splitLinesForDiff(oldContent);
  if (lines.length === 0) {
    return { rows: [], deletions: 0, rawPatch: "" };
  }
  const header = `@@ -1,${lines.length} +0,0 @@`;
  const rows: DiffRow[] = [{ type: "hunk", header }];
  const patchLines = [
    `--- a/${filePath}`,
    `+++ /dev/null`,
    header,
  ];

  lines.forEach((line, idx) => {
    rows.push({
      type: "del",
      oldLineNumber: idx + 1,
      oldText: line,
    });
    patchLines.push(`-${line}`);
  });

  return {
    rows,
    deletions: lines.length,
    rawPatch: `${patchLines.join("\n")}\n`,
  };
}

function parseZeroContextDiffMarkers(
  patchOutput: string,
): Record<number, "added" | "modified" | "deleted-after"> {
  const markers: Record<number, "added" | "modified" | "deleted-after"> = {};
  const hunkRegex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  let match: RegExpExecArray | null;

  while ((match = hunkRegex.exec(patchOutput)) !== null) {
    const oldCount = match[2] !== undefined ? Number.parseInt(match[2], 10) : 1;
    const newStart = Number.parseInt(match[3] ?? "0", 10);
    const newCount = match[4] !== undefined ? Number.parseInt(match[4], 10) : 1;

    if (oldCount === 0 && newCount > 0) {
      for (let i = 0; i < newCount; i += 1) {
        markers[newStart + i] = "added";
      }
    } else if (oldCount > 0 && newCount === 0) {
      markers[newStart] = "deleted-after";
    } else if (oldCount > 0 && newCount > 0) {
      const modifiedCount = Math.min(oldCount, newCount);
      for (let i = 0; i < modifiedCount; i += 1) {
        markers[newStart + i] = "modified";
      }
      for (let i = modifiedCount; i < newCount; i += 1) {
        markers[newStart + i] = "added";
      }
    }
  }

  return markers;
}

/**
 * High-speed git & multi-worktree service backed by an in-memory cache
 * and strictly read-only git invocations (`--no-optional-locks`).
 */
export class WorktreeService {
  private readonly cache = new Map<string, WorktreeInfo>();
  private readonly expectedCommonDir?: string;

  constructor(expectedCommonDir?: string) {
    this.expectedCommonDir = expectedCommonDir ? tryRealpath(expectedCommonDir) : undefined;
  }

  /** Returns cached worktree metadata in O(1) without spawning git. */
  getCachedWorktree(worktreePath: string): WorktreeInfo | undefined {
    return this.cache.get(tryRealpath(worktreePath));
  }

  /** Lists all currently cached worktrees in O(n) memory time. */
  listCachedWorktrees(): WorktreeInfo[] {
    return Array.from(this.cache.values());
  }

  /** Updates `lastActivityAt` on a cached worktree when filesystem changes occur. */
  touchActivity(worktreePath: string, timestamp = Date.now()): void {
    const key = tryRealpath(worktreePath);
    const existing = this.cache.get(key);
    if (existing) {
      existing.lastActivityAt = timestamp;
    }
  }

  /**
   * Discovers all worktrees strictly belonging to the repository's `git-common-dir`,
   * excluding bare, prunable, missing, or unrelated-repository directories.
   */
  async discoverWorktrees(anyRepoPath: string): Promise<WorktreeInfo[]> {
    const canonStart = tryRealpath(anyRepoPath);
    const startDir = existsSync(canonStart) && statSync(canonStart).isFile()
      ? dirname(canonStart)
      : canonStart;

    const rawStartCommon = await runGit(startDir, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const targetCommonDir = this.expectedCommonDir ?? tryRealpath(rawStartCommon.trim());
    if (tryRealpath(rawStartCommon.trim()) !== targetCommonDir) {
      return this.listCachedWorktrees();
    }

    const rawPorcelain = await runGit(startDir, ["worktree", "list", "--porcelain"]);
    const blocks = parsePorcelainWorktrees(rawPorcelain);

    const candidateBlocks = blocks
      .map((block, idx) => ({ block, isMain: idx === 0 }))
      .filter(({ block }) => !block.bare && !block.prunable && existsSync(block.path));

    const verified = await Promise.all(
      candidateBlocks.map(async ({ block, isMain }) => {
        const canonPath = tryRealpath(block.path);
        const [wtCommonRaw, wtToplevelRaw] = await Promise.all([
          tryRunGit(canonPath, [
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          ]),
          tryRunGit(canonPath, ["rev-parse", "--show-toplevel"]),
        ]);
        if (
          !wtCommonRaw ||
          !wtToplevelRaw ||
          tryRealpath(wtCommonRaw.trim()) !== targetCommonDir ||
          tryRealpath(wtToplevelRaw.trim()) !== canonPath
        ) {
          return null;
        }
        return this.inspectWorktree(canonPath, block, isMain);
      }),
    );

    const results = verified.filter((w): w is WorktreeInfo => w !== null);

    const activePaths = new Set(results.map((r) => r.path));
    for (const existingPath of this.cache.keys()) {
      if (!activePaths.has(existingPath)) {
        this.cache.delete(existingPath);
      }
    }
    for (const info of results) {
      this.cache.set(info.path, info);
    }

    return results;
  }

  /**
   * Lists tracked and untracked files in a worktree with current git status.
   */
  async listFiles(worktreePath: string): Promise<FileEntry[]> {
    const canonRoot = realpathSync(worktreePath);
    const [trackedRaw, untrackedRaw, statusRaw] = await Promise.all([
      tryRunGit(canonRoot, ["ls-files", "-z"]),
      tryRunGit(canonRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
      tryRunGit(canonRoot, ["status", "--porcelain=v2", "-uall"]),
    ]);

    const statusMap = new Map<string, FileGitStatus>();
    if (statusRaw) {
      for (const line of statusRaw.split(/\r?\n/)) {
        if (line.startsWith("1 ")) {
          const parts = line.split(" ");
          const xy = parts[1] ?? "..";
          const filePath = parts.slice(8).join(" ");
          if (filePath) {
            const letter = xy[1] !== "." ? (xy[1] ?? "M") : (xy[0] ?? "M");
            statusMap.set(toPosixPath(filePath), mapGitStatusLetter(letter));
          }
        } else if (line.startsWith("2 ")) {
          const tabIdx = line.indexOf("\t");
          const left = tabIdx >= 0 ? line.slice(0, tabIdx) : line;
          const parts = left.split(" ");
          const filePath = parts.slice(9).join(" ");
          if (filePath) {
            statusMap.set(toPosixPath(filePath), "renamed");
          }
        } else if (line.startsWith("u ")) {
          const parts = line.split(" ");
          const filePath = parts.slice(10).join(" ");
          if (filePath) {
            statusMap.set(toPosixPath(filePath), "conflicted");
          }
        } else if (line.startsWith("? ")) {
          statusMap.set(toPosixPath(line.slice(2)), "untracked");
        }
      }
    }

    const seen = new Set<string>();
    const entries: FileEntry[] = [];

    const addEntry = (rawPath: string, defaultStatus?: FileGitStatus) => {
      const p = toPosixPath(rawPath);
      if (!p || seen.has(p)) return;
      seen.add(p);
      entries.push({
        path: p,
        name: posix.basename(p),
        gitStatus: statusMap.get(p) ?? defaultStatus ?? "clean",
      });
    };

    if (trackedRaw) {
      for (const p of trackedRaw.split("\0")) {
        if (p) addEntry(p, "clean");
      }
    }
    if (untrackedRaw) {
      for (const p of untrackedRaw.split("\0")) {
        if (p) addEntry(p, "untracked");
      }
    }

    entries.sort((a, b) => a.path.localeCompare(b.path));
    return entries;
  }

  /**
   * Reads a file strictly inside `worktreePath`, detecting binary files,
   * truncating files larger than 2MB, and computing line git markers.
   */
  async readFile(
    worktreePath: string,
    filePath: string,
    diffScope?: DiffScope,
  ): Promise<FileDocument> {
    const canonRoot = realpathSync(worktreePath);
    const canonFile = insideWorktree(canonRoot, filePath);
    if (!canonFile) {
      throw new Error(`Refused file read outside worktree or missing file: ${filePath}`);
    }

    const relPosix = toPosixPath(relative(canonRoot, canonFile));
    const [st, rawBuf] = await Promise.all([fsStat(canonFile), fsReadFile(canonFile)]);
    const binary = isBinaryBuffer(rawBuf);
    const contentHash = sha1Hex(rawBuf);
    const language = inferLanguage(relPosix);

    if (binary) {
      return {
        worktreePath: canonRoot,
        filePath: relPosix,
        language,
        isBinary: true,
        isTruncated: false,
        byteLength: st.size,
        mtimeMs: st.mtimeMs,
        contentHash,
        lines: [],
      };
    }

    const isTruncated = rawBuf.length > MAX_TEXT_BYTES;
    const textBuf = isTruncated ? rawBuf.subarray(0, MAX_TEXT_BYTES) : rawBuf;
    const text = textBuf.toString("utf8");
    const lines = splitLinesPreserve(text);

    const lineGitMarkers = await this.computeLineGitMarkers(
      canonRoot,
      relPosix,
      lines.length,
      diffScope ?? { kind: "branch" },
    );

    return {
      worktreePath: canonRoot,
      filePath: relPosix,
      language,
      isBinary: false,
      isTruncated,
      byteLength: st.size,
      mtimeMs: st.mtimeMs,
      contentHash,
      lines,
      lineGitMarkers,
    };
  }

  /**
   * Computes a structured diff with side-by-side/unified rows and intra-line
   * word diffs across any of the 4 DiffScope variants.
   */
  async getDiff(
    worktreePath: string,
    filePath: string,
    scope: DiffScope,
  ): Promise<FileDiffResult> {
    const canonRoot = realpathSync(worktreePath);
    const relOs = isLexicallyInside(canonRoot, filePath);
    if (!relOs) {
      throw new Error(`Refused diff path outside worktree: ${filePath}`);
    }
    const relPosix = toPosixPath(relOs);

    // If path exists in current worktree, also ensure it is not a symlink escaping worktree
    const diskTarget = resolve(canonRoot, relOs);
    if (existsSync(diskTarget) && !insideWorktree(canonRoot, relOs)) {
      throw new Error(`Refused diff on symlink outside worktree: ${filePath}`);
    }

    if (scope.kind === "worktree") {
      return this.diffBetweenWorktrees(canonRoot, relPosix, scope);
    }

    if (scope.kind === "commit") {
      return this.diffForCommit(canonRoot, relPosix, scope);
    }

    // "branch" or "working"
    let baseRev = "HEAD";
    let baseLabel = "HEAD";
    if (scope.kind === "branch") {
      const baseRef = scope.baseRef ?? (await this.detectBaseRef(canonRoot));
      const mergeBase = await this.resolveMergeBase(canonRoot, baseRef);
      baseRev = mergeBase ?? "HEAD";
      baseLabel = baseRef;
    }

    const existsInBase =
      baseRev === "HEAD"
        ? (await tryRunGit(canonRoot, ["cat-file", "-e", `HEAD:${relPosix}`])) !== null
        : (await tryRunGit(canonRoot, ["cat-file", "-e", `${baseRev}:${relPosix}`])) !== null;

    const existsOnDisk = insideWorktree(canonRoot, relOs) !== undefined;

    if (!existsInBase && existsOnDisk) {
      const buf = await fsReadFile(resolve(canonRoot, relOs));
      if (isBinaryBuffer(buf)) {
        return {
          worktreePath: canonRoot,
          filePath: relPosix,
          scope,
          baseLabel,
          targetLabel: "Working Tree",
          isBinary: true,
          additions: 0,
          deletions: 0,
          rows: [],
          rawPatch: "",
        };
      }
      const { rows, additions, rawPatch } = buildAddedOnlyDiff(relPosix, buf.toString("utf8"));
      return {
        worktreePath: canonRoot,
        filePath: relPosix,
        scope,
        baseLabel,
        targetLabel: "Working Tree",
        isBinary: false,
        additions,
        deletions: 0,
        rows,
        rawPatch,
      };
    }

    if (existsInBase && !existsOnDisk) {
      const oldBuf = await runGitBuffer(canonRoot, ["show", `${baseRev}:${relPosix}`]);
      if (isBinaryBuffer(oldBuf)) {
        return {
          worktreePath: canonRoot,
          filePath: relPosix,
          scope,
          baseLabel,
          targetLabel: "Working Tree",
          isBinary: true,
          additions: 0,
          deletions: 0,
          rows: [],
          rawPatch: "",
        };
      }
      const { rows, deletions, rawPatch } = buildDeletedOnlyDiff(
        relPosix,
        oldBuf.toString("utf8"),
      );
      return {
        worktreePath: canonRoot,
        filePath: relPosix,
        scope,
        baseLabel,
        targetLabel: "Working Tree",
        isBinary: false,
        additions: 0,
        deletions,
        rows,
        rawPatch,
      };
    }

    const rawPatch =
      (await tryRunGit(canonRoot, [
        "diff",
        "--no-ext-diff",
        "-M",
        "-U3",
        baseRev,
        "--",
        relPosix,
      ])) ?? "";

    if (isBinaryDiffOutput(rawPatch)) {
      return {
        worktreePath: canonRoot,
        filePath: relPosix,
        scope,
        baseLabel,
        targetLabel: "Working Tree",
        isBinary: true,
        additions: 0,
        deletions: 0,
        rows: [],
        rawPatch,
      };
    }

    const parsed = parsePatchToRows(rawPatch);
    return {
      worktreePath: canonRoot,
      filePath: relPosix,
      oldPath: parsed.oldPath,
      scope,
      baseLabel,
      targetLabel: "Working Tree",
      isBinary: false,
      additions: parsed.additions,
      deletions: parsed.deletions,
      rows: parsed.rows,
      rawPatch,
    };
  }

  /**
   * Lists all changed files for the given `DiffScope`, including untracked files
   * when comparing against the working tree.
   */
  async listChangedFiles(
    worktreePath: string,
    scope: DiffScope,
  ): Promise<ChangedFileSummary[]> {
    const canonRoot = realpathSync(worktreePath);

    if (scope.kind === "worktree") {
      return this.listChangedFilesBetweenWorktrees(canonRoot, scope.otherWorktreePath);
    }

    if (scope.kind === "commit") {
      const hasParent =
        (await tryRunGit(canonRoot, ["rev-parse", "--verify", "--quiet", `${scope.sha}^`])) !==
        null;
      const [nameStatusRaw, numstatRaw] = hasParent
        ? await Promise.all([
            runGit(canonRoot, ["diff", "--name-status", "-M", `${scope.sha}^`, scope.sha]),
            runGit(canonRoot, ["diff", "--numstat", "-M", `${scope.sha}^`, scope.sha]),
          ])
        : await Promise.all([
            runGit(canonRoot, ["show", "--format=", "--name-status", "--root", scope.sha]),
            runGit(canonRoot, ["show", "--format=", "--numstat", "--root", scope.sha]),
          ]);
      return mergeNameStatusAndNumstat(nameStatusRaw, numstatRaw, new Set());
    }

    // "branch" or "working"
    let baseRev = "HEAD";
    if (scope.kind === "branch") {
      const baseRef = scope.baseRef ?? (await this.detectBaseRef(canonRoot));
      baseRev = (await this.resolveMergeBase(canonRoot, baseRef)) ?? "HEAD";
    }

    const hasHead =
      (await tryRunGit(canonRoot, ["rev-parse", "--verify", "--quiet", "HEAD"])) !== null;

    const stagedSet = new Set<string>();
    const statusRaw = await tryRunGit(canonRoot, ["status", "--porcelain=v2", "-uall"]);
    if (statusRaw) {
      for (const line of statusRaw.split(/\r?\n/)) {
        if (line.startsWith("1 ")) {
          const parts = line.split(" ");
          const xy = parts[1] ?? "..";
          const filePath = parts.slice(8).join(" ");
          if (filePath && xy[0] && xy[0] !== ".") {
            stagedSet.add(toPosixPath(filePath));
          }
        } else if (line.startsWith("2 ")) {
          const tabIdx = line.indexOf("\t");
          const left = tabIdx >= 0 ? line.slice(0, tabIdx) : line;
          const parts = left.split(" ");
          const xy = parts[1] ?? "..";
          const filePath = parts.slice(9).join(" ");
          if (filePath && xy[0] && xy[0] !== ".") {
            stagedSet.add(toPosixPath(filePath));
          }
        }
      }
    }

    let trackedChanges: ChangedFileSummary[] = [];
    if (hasHead) {
      const [nameStatusRaw, numstatRaw] = await Promise.all([
        runGit(canonRoot, ["diff", "--name-status", "-M", baseRev]),
        runGit(canonRoot, ["diff", "--numstat", "-M", baseRev]),
      ]);
      trackedChanges = mergeNameStatusAndNumstat(nameStatusRaw, numstatRaw, stagedSet);
    } else {
      // Unborn HEAD: staged files are in index
      const [nameStatusRaw, numstatRaw] = await Promise.all([
        tryRunGit(canonRoot, ["diff", "--cached", "--name-status", "-M"]),
        tryRunGit(canonRoot, ["diff", "--cached", "--numstat", "-M"]),
      ]);
      if (nameStatusRaw && numstatRaw) {
        trackedChanges = mergeNameStatusAndNumstat(nameStatusRaw, numstatRaw, stagedSet);
      }
    }

    const trackedPathSet = new Set(trackedChanges.map((c) => c.path));
    const untrackedRaw =
      (await tryRunGit(canonRoot, ["ls-files", "--others", "--exclude-standard", "-z"])) ?? "";

    const untrackedChanges: ChangedFileSummary[] = [];
    for (const rawPath of untrackedRaw.split("\0")) {
      if (!rawPath) continue;
      const posixPath = toPosixPath(rawPath);
      if (trackedPathSet.has(posixPath)) continue;
      const safeFile = insideWorktree(canonRoot, posixPath);
      let additions = 0;
      if (safeFile) {
        try {
          const st = await fsStat(safeFile);
          if (st.size <= MAX_TEXT_BYTES) {
            const buf = await fsReadFile(safeFile);
            additions = countTextLines(buf);
          }
        } catch {
          additions = 0;
        }
      }
      untrackedChanges.push({
        path: posixPath,
        status: "untracked",
        additions,
        deletions: 0,
        staged: false,
      });
    }

    return [...trackedChanges, ...untrackedChanges].sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Lists recent commits reachable from HEAD in the given worktree.
   */
  async listCommits(worktreePath: string, limit = 60): Promise<CommitEntry[]> {
    const canonRoot = realpathSync(worktreePath);
    const raw = await tryRunGit(canonRoot, [
      "log",
      `-n`,
      String(limit),
      "--format=%H%x00%h%x00%an%x00%aI%x00%ar%x00%s%x00%D%x1e",
    ]);
    if (!raw) return [];

    const commits: CommitEntry[] = [];
    for (const record of raw.split("\x1e")) {
      const trimmed = record.trim();
      if (!trimmed) continue;
      const fields = trimmed.split("\x00");
      const sha = fields[0] ?? "";
      if (!sha) continue;
      const shortSha = fields[1] ?? sha.slice(0, 7);
      const author = fields[2] ?? "";
      const dateIso = fields[3] ?? "";
      const relativeTime = fields[4] ?? "";
      const subject = fields[5] ?? "";
      const refsRaw = fields[6] ?? "";
      const refs = refsRaw
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean);

      commits.push({
        sha,
        shortSha,
        author,
        dateIso,
        relativeTime,
        subject,
        refs,
      });
    }
    return commits;
  }

  /**
   * Runs `git blame --porcelain` for a file inside `worktreePath`.
   * Returns an empty array if the file is untracked or has no commit history.
   */
  async getBlame(worktreePath: string, filePath: string): Promise<LineBlame[]> {
    const canonRoot = realpathSync(worktreePath);
    const canonFile = insideWorktree(canonRoot, filePath);
    if (!canonFile) {
      throw new Error(`Refused blame outside worktree or missing file: ${filePath}`);
    }
    const relPosix = toPosixPath(relative(canonRoot, canonFile));
    const raw = await tryRunGit(canonRoot, ["blame", "--porcelain", "--", relPosix]);
    if (!raw) return [];

    const commitCache = new Map<
      string,
      { author: string; authorTime: number; summary: string }
    >();
    const results: LineBlame[] = [];
    const nowMs = Date.now();

    let currentSha = "";
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith("\t")) {
        const meta = commitCache.get(currentSha) ?? {
          author: "Unknown",
          authorTime: Math.floor(nowMs / 1000),
          summary: "",
        };
        const isUncommitted = /^0+$/.test(currentSha);
        results.push({
          sha: currentSha.slice(0, 7),
          author: isUncommitted ? "Not Committed Yet" : meta.author,
          relativeTime: isUncommitted ? "uncommitted" : formatRelativeTimeFromUnix(meta.authorTime, nowMs),
          summary: meta.summary,
        });
        continue;
      }

      const headerMatch = /^([0-9a-f]{40})\s+\d+\s+\d+(?:\s+\d+)?$/.exec(line);
      if (headerMatch && headerMatch[1]) {
        currentSha = headerMatch[1];
        if (!commitCache.has(currentSha)) {
          commitCache.set(currentSha, { author: "", authorTime: 0, summary: "" });
        }
        continue;
      }

      if (!currentSha) continue;
      const meta = commitCache.get(currentSha);
      if (!meta) continue;

      if (line.startsWith("author ")) {
        meta.author = line.slice("author ".length);
      } else if (line.startsWith("author-time ")) {
        meta.authorTime = Number.parseInt(line.slice("author-time ".length), 10) || 0;
      } else if (line.startsWith("summary ")) {
        meta.summary = line.slice("summary ".length);
      }
    }

    return results;
  }

  /**
   * Resolves a relative image href from a markdown/source file inside `worktreePath`
   * and returns a base64 `data:` URL if safe and supported, or `null`.
   */
  async readAssetDataUrl(
    worktreePath: string,
    relativeFromFile: string,
    rawHref: string,
  ): Promise<string | null> {
    if (!rawHref) return null;
    if (/^(?:[a-z]+:|\/\/|#)/i.test(rawHref)) {
      return null;
    }

    const stripped = rawHref.split(/[?#]/)[0] ?? "";
    if (!stripped) return null;

    let decoded: string;
    try {
      decoded = decodeURIComponent(stripped);
    } catch {
      decoded = stripped;
    }

    const fromPosix = toPosixPath(relativeFromFile);
    const baseDir = posix.dirname(fromPosix);
    const candidateRel = decoded.startsWith("/")
      ? posix.normalize(decoded.slice(1))
      : posix.normalize(posix.join(baseDir === "." ? "" : baseDir, decoded));

    const canonFile = insideWorktree(worktreePath, candidateRel);
    if (!canonFile) return null;

    const ext = extname(canonFile).slice(1).toLowerCase();
    const mime = IMAGE_MIME_TYPES[ext];
    if (!mime) return null;

    const buf = await fsReadFile(canonFile);
    return `data:${mime};base64,${buf.toString("base64")}`;
  }

  /**
   * Creates a new linked git worktree via `git worktree add` (explicitly allowed
   * by `buildSafeGitArgs(..., { allowWorktreeAdd: true })`) and returns its `WorktreeInfo`.
   */
  async createWorktree(params: CreateWorktreeParams): Promise<WorktreeInfo> {
    const branchName = params.branchName.trim();
    if (!branchName || branchName.startsWith("-")) {
      throw new Error(`Invalid git branch name: ${params.branchName}`);
    }
    const baseRef = params.baseRef?.trim();
    if (baseRef && baseRef.startsWith("-")) {
      throw new Error(`Invalid git base ref: ${params.baseRef}`);
    }
    const canonBase = realpathSync(params.baseWorktreePath);
    const sanitizedBranch = branchName.replace(/[^a-zA-Z0-9._-]+/g, "-");
    const targetDir = params.targetDir
      ? resolve(canonBase, params.targetDir)
      : resolve(dirname(canonBase), `${basename(canonBase)}-${sanitizedBranch}`);

    const branchExists =
      (await tryRunGit(canonBase, [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${branchName}`,
      ])) !== null;

    const args = branchExists
      ? ["worktree", "add", targetDir, branchName]
      : baseRef
        ? ["worktree", "add", "-b", branchName, targetDir, baseRef]
        : ["worktree", "add", "-b", branchName, targetDir];

    await runGit(canonBase, args, { allowWorktreeAdd: true });

    const canonTarget = realpathSync(targetDir);
    const worktrees = await this.discoverWorktrees(canonTarget);
    const created = worktrees.find((w) => w.path === canonTarget);
    if (!created) {
      throw new Error(`Created worktree not found after discovery: ${canonTarget}`);
    }
    return created;
  }

  private async inspectWorktree(
    canonPath: string,
    block: ParsedWorktreeBlock,
    isMain: boolean,
  ): Promise<WorktreeInfo> {
    const baseRef = await this.detectBaseRef(canonPath);
    const headFull = block.headSha;
    const headSha = headFull.slice(0, 7);

    const [headSubjectRaw, mergeBaseFull, aheadBehindRaw, statusRaw] = await Promise.all([
      headFull ? tryRunGit(canonPath, ["log", "-1", "--format=%s", "HEAD"]) : Promise.resolve(""),
      headFull ? this.resolveMergeBase(canonPath, baseRef) : Promise.resolve(null),
      headFull && baseRef !== "HEAD"
        ? tryRunGit(canonPath, ["rev-list", "--left-right", "--count", `${baseRef}...HEAD`])
        : Promise.resolve("0\t0"),
      tryRunGit(canonPath, ["status", "--porcelain=v2", "-b", "-uall"]),
    ]);

    const headSubject = (headSubjectRaw ?? "").trim();
    const mergeBaseResolved = mergeBaseFull ?? headFull;
    const mergeBaseSha = mergeBaseResolved.slice(0, 7);

    let behind = 0;
    let ahead = 0;
    if (aheadBehindRaw) {
      const parts = aheadBehindRaw.trim().split(/\s+/);
      behind = Number.parseInt(parts[0] ?? "0", 10) || 0;
      ahead = Number.parseInt(parts[1] ?? "0", 10) || 0;
    }

    let modified = 0;
    let added = 0;
    let deleted = 0;
    let untracked = 0;
    let conflicted = 0;
    const untrackedFiles = new Set<string>();

    if (statusRaw) {
      for (const line of statusRaw.split(/\r?\n/)) {
        if (!line || line.startsWith("#") || line.startsWith("!")) continue;
        if (line.startsWith("? ")) {
          untracked += 1;
          untrackedFiles.add(toPosixPath(line.slice(2)));
        } else if (line.startsWith("u ")) {
          conflicted += 1;
        } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
          const tabIdx = line.indexOf("\t");
          const left = tabIdx >= 0 ? line.slice(0, tabIdx) : line;
          const parts = left.split(" ");
          const xy = parts[1] ?? "..";
          const x = xy[0] ?? ".";
          const y = xy[1] ?? ".";
          if (x === "A" || y === "A") {
            added += 1;
          } else if (x === "D" || y === "D") {
            deleted += 1;
          } else {
            modified += 1;
          }
        }
      }
    }

    let branchChanged = untrackedFiles.size;
    if (mergeBaseResolved) {
      const diffNamesRaw = await tryRunGit(canonPath, [
        "diff",
        "--name-only",
        mergeBaseResolved,
      ]);
      if (diffNamesRaw) {
        const changedSet = new Set<string>(untrackedFiles);
        for (const name of diffNamesRaw.split(/\r?\n/)) {
          if (name.trim()) {
            changedSet.add(toPosixPath(name.trim()));
          }
        }
        branchChanged = changedSet.size;
      }
    } else {
      branchChanged = modified + added + deleted + untracked;
    }

    const prev = this.cache.get(canonPath);
    const label = isMain
      ? block.branch !== "(detached)" && (block.branch === "main" || block.branch === "master")
        ? block.branch
        : basename(canonPath)
      : basename(canonPath);

    return {
      path: canonPath,
      name: label,
      branch: block.branch,
      headSha,
      headSubject,
      isMain,
      baseRef,
      mergeBaseSha,
      ahead,
      behind,
      counts: {
        modified,
        added,
        deleted,
        untracked,
        conflicted,
        branchChanged,
      },
      lastActivityAt: prev?.lastActivityAt ?? Date.now(),
    };
  }

  private async detectBaseRef(worktreePath: string): Promise<string> {
    const candidates: Array<{ ref: string; label: string }> = [
      { ref: "refs/heads/main", label: "main" },
      { ref: "refs/heads/master", label: "master" },
      { ref: "refs/remotes/origin/main", label: "origin/main" },
      { ref: "refs/remotes/origin/master", label: "origin/master" },
    ];

    for (const cand of candidates) {
      const ok = await tryRunGit(worktreePath, ["rev-parse", "--verify", "--quiet", cand.ref]);
      if (ok !== null) return cand.label;
    }

    const originHead = await tryRunGit(worktreePath, [
      "symbolic-ref",
      "--quiet",
      "refs/remotes/origin/HEAD",
    ]);
    if (originHead) {
      return originHead.trim().replace(/^refs\/remotes\//, "");
    }

    return "HEAD";
  }

  private async resolveMergeBase(worktreePath: string, baseRef: string): Promise<string | null> {
    if (baseRef === "HEAD") {
      const head = await tryRunGit(worktreePath, ["rev-parse", "--verify", "--quiet", "HEAD"]);
      return head ? head.trim() : null;
    }
    const mb = await tryRunGit(worktreePath, ["merge-base", baseRef, "HEAD"]);
    if (mb) return mb.trim();
    const head = await tryRunGit(worktreePath, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    return head ? head.trim() : null;
  }

  private async computeLineGitMarkers(
    canonRoot: string,
    relPosix: string,
    lineCount: number,
    scope: DiffScope,
  ): Promise<Record<number, "added" | "modified" | "deleted-after"> | undefined> {
    if (scope.kind !== "branch" && scope.kind !== "working") {
      return undefined;
    }

    const untracked = await tryRunGit(canonRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      relPosix,
    ]);
    if (untracked && untracked.trim().length > 0) {
      const allAdded: Record<number, "added" | "modified" | "deleted-after"> = {};
      for (let line = 1; line <= lineCount; line += 1) {
        allAdded[line] = "added";
      }
      return allAdded;
    }

    let baseRev = "HEAD";
    if (scope.kind === "branch") {
      const baseRef = scope.baseRef ?? (await this.detectBaseRef(canonRoot));
      baseRev = (await this.resolveMergeBase(canonRoot, baseRef)) ?? "HEAD";
    }

    const patch = await tryRunGit(canonRoot, [
      "diff",
      "--no-ext-diff",
      "-U0",
      baseRev,
      "--",
      relPosix,
    ]);
    if (!patch) return {};
    return parseZeroContextDiffMarkers(patch);
  }

  private async diffForCommit(
    canonRoot: string,
    relPosix: string,
    scope: Extract<DiffScope, { kind: "commit" }>,
  ): Promise<FileDiffResult> {
    const hasParent =
      (await tryRunGit(canonRoot, ["rev-parse", "--verify", "--quiet", `${scope.sha}^`])) !==
      null;

    const rawPatch = hasParent
      ? (await tryRunGit(canonRoot, [
          "diff",
          "--no-ext-diff",
          "-M",
          "-U3",
          `${scope.sha}^`,
          scope.sha,
          "--",
          relPosix,
        ])) ?? ""
      : (await tryRunGit(canonRoot, [
          "show",
          "--format=",
          "--patch",
          "-M",
          "-U3",
          "--root",
          scope.sha,
          "--",
          relPosix,
        ])) ?? "";

    const baseLabel = hasParent ? `${scope.sha.slice(0, 7)}^` : "(root)";
    const targetLabel = scope.sha.slice(0, 7);

    if (isBinaryDiffOutput(rawPatch)) {
      return {
        worktreePath: canonRoot,
        filePath: relPosix,
        scope,
        baseLabel,
        targetLabel,
        isBinary: true,
        additions: 0,
        deletions: 0,
        rows: [],
        rawPatch,
      };
    }

    const parsed = parsePatchToRows(rawPatch);
    return {
      worktreePath: canonRoot,
      filePath: relPosix,
      oldPath: parsed.oldPath,
      scope,
      baseLabel,
      targetLabel,
      isBinary: false,
      additions: parsed.additions,
      deletions: parsed.deletions,
      rows: parsed.rows,
      rawPatch,
    };
  }

  private async diffBetweenWorktrees(
    canonRoot: string,
    relPosix: string,
    scope: Extract<DiffScope, { kind: "worktree" }>,
  ): Promise<FileDiffResult> {
    const canonOther = realpathSync(scope.otherWorktreePath);
    const baseLabel = basename(canonOther);
    const targetLabel = basename(canonRoot);

    const otherSafe = insideWorktree(canonOther, relPosix);
    const currentSafe = insideWorktree(canonRoot, relPosix);

    const [otherBuf, currentBuf] = await Promise.all([
      otherSafe ? fsReadFile(otherSafe) : Promise.resolve(Buffer.alloc(0)),
      currentSafe ? fsReadFile(currentSafe) : Promise.resolve(Buffer.alloc(0)),
    ]);

    if (isBinaryBuffer(otherBuf) || isBinaryBuffer(currentBuf)) {
      return {
        worktreePath: canonRoot,
        filePath: relPosix,
        scope,
        baseLabel,
        targetLabel,
        isBinary: true,
        additions: 0,
        deletions: 0,
        rows: [],
        rawPatch: "",
      };
    }

    const oldStr = otherBuf.toString("utf8");
    const newStr = currentBuf.toString("utf8");

    if (!otherSafe && currentSafe) {
      const added = buildAddedOnlyDiff(relPosix, newStr);
      return {
        worktreePath: canonRoot,
        filePath: relPosix,
        scope,
        baseLabel,
        targetLabel,
        isBinary: false,
        additions: added.additions,
        deletions: 0,
        rows: added.rows,
        rawPatch: added.rawPatch,
      };
    }

    if (otherSafe && !currentSafe) {
      const deleted = buildDeletedOnlyDiff(relPosix, oldStr);
      return {
        worktreePath: canonRoot,
        filePath: relPosix,
        scope,
        baseLabel,
        targetLabel,
        isBinary: false,
        additions: 0,
        deletions: deleted.deletions,
        rows: deleted.rows,
        rawPatch: deleted.rawPatch,
      };
    }

    if (oldStr === newStr) {
      return {
        worktreePath: canonRoot,
        filePath: relPosix,
        scope,
        baseLabel,
        targetLabel,
        isBinary: false,
        additions: 0,
        deletions: 0,
        rows: [],
        rawPatch: "",
      };
    }

    const rawPatch = createTwoFilesPatch(
      `a/${relPosix}`,
      `b/${relPosix}`,
      oldStr,
      newStr,
      undefined,
      undefined,
      { context: 3 },
    );
    const parsed = parsePatchToRows(rawPatch);

    return {
      worktreePath: canonRoot,
      filePath: relPosix,
      scope,
      baseLabel,
      targetLabel,
      isBinary: false,
      additions: parsed.additions,
      deletions: parsed.deletions,
      rows: parsed.rows,
      rawPatch,
    };
  }

  private async listChangedFilesBetweenWorktrees(
    canonRoot: string,
    otherWorktreePath: string,
  ): Promise<ChangedFileSummary[]> {
    const canonOther = realpathSync(otherWorktreePath);
    const [leftFiles, rightFiles] = await Promise.all([
      this.listFiles(canonOther),
      this.listFiles(canonRoot),
    ]);

    const leftSet = new Set(leftFiles.map((f) => f.path));
    const rightSet = new Set(rightFiles.map((f) => f.path));
    const allPaths = Array.from(new Set([...leftSet, ...rightSet])).sort();

    const changed: ChangedFileSummary[] = [];
    for (const relPosix of allPaths) {
      const leftPath = insideWorktree(canonOther, relPosix);
      const rightPath = insideWorktree(canonRoot, relPosix);

      if (!leftPath && rightPath) {
        const buf = await fsReadFile(rightPath);
        changed.push({
          path: relPosix,
          status: "added",
          additions: countTextLines(buf),
          deletions: 0,
          staged: false,
        });
      } else if (leftPath && !rightPath) {
        const buf = await fsReadFile(leftPath);
        changed.push({
          path: relPosix,
          status: "deleted",
          additions: 0,
          deletions: countTextLines(buf),
          staged: false,
        });
      } else if (leftPath && rightPath) {
        const [leftBuf, rightBuf] = await Promise.all([
          fsReadFile(leftPath),
          fsReadFile(rightPath),
        ]);
        if (leftBuf.equals(rightBuf)) continue;
        if (isBinaryBuffer(leftBuf) || isBinaryBuffer(rightBuf)) {
          changed.push({
            path: relPosix,
            status: "modified",
            additions: 0,
            deletions: 0,
            staged: false,
          });
        } else {
          const patch = createTwoFilesPatch(
            `a/${relPosix}`,
            `b/${relPosix}`,
            leftBuf.toString("utf8"),
            rightBuf.toString("utf8"),
            undefined,
            undefined,
            { context: 0 },
          );
          const parsed = parsePatchToRows(patch);
          changed.push({
            path: relPosix,
            status: "modified",
            additions: parsed.additions,
            deletions: parsed.deletions,
            staged: false,
          });
        }
      }
    }

    return changed;
  }
}

function isBinaryDiffOutput(rawPatch: string): boolean {
  return (
    /^Binary files .* differ$/m.test(rawPatch) ||
    /^GIT binary patch$/m.test(rawPatch)
  );
}

function mergeNameStatusAndNumstat(
  nameStatusRaw: string,
  numstatRaw: string,
  stagedSet: Set<string>,
): ChangedFileSummary[] {
  const numstatMap = new Map<string, { additions: number; deletions: number }>();
  for (const line of numstatRaw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const adds = parts[0] === "-" ? 0 : Number.parseInt(parts[0] ?? "0", 10) || 0;
    const dels = parts[1] === "-" ? 0 : Number.parseInt(parts[1] ?? "0", 10) || 0;
    const filePath = parts[parts.length - 1] ?? "";
    if (filePath) {
      numstatMap.set(toPosixPath(filePath), { additions: adds, deletions: dels });
    }
  }

  const results: ChangedFileSummary[] = [];
  for (const line of nameStatusRaw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const statusCode = parts[0] ?? "M";
    const letter = statusCode[0] ?? "M";
    if ((letter === "R" || letter === "C") && parts.length >= 3) {
      const oldPath = toPosixPath(parts[1] ?? "");
      const newPath = toPosixPath(parts[2] ?? "");
      const counts = numstatMap.get(newPath) ?? { additions: 0, deletions: 0 };
      results.push({
        path: newPath,
        oldPath,
        status: mapGitStatusLetter(letter),
        additions: counts.additions,
        deletions: counts.deletions,
        staged: stagedSet.has(newPath),
      });
    } else if (parts.length >= 2) {
      const filePath = toPosixPath(parts[1] ?? "");
      const counts = numstatMap.get(filePath) ?? { additions: 0, deletions: 0 };
      results.push({
        path: filePath,
        status: mapGitStatusLetter(letter),
        additions: counts.additions,
        deletions: counts.deletions,
        staged: stagedSet.has(filePath),
      });
    }
  }

  return results;
}
