import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import uFuzzy from "@leeoniya/ufuzzy";
import { rgPath as bundledRgPath } from "@vscode/ripgrep";
import { buildSafeGitArgs, toPosixPath } from "../../shared/guard";
import type { FileGitStatus, FindInPathQuery, FuzzyFileHit, SearchMatch } from "../../shared/protocol";

export interface SearchWorktreeInput {
  path: string;
  name: string;
  gitStatuses?: Record<string, FileGitStatus> | Map<string, FileGitStatus>;
}

export interface FuzzyFindFilesParams {
  worktreePath: string;
  query: string;
  allWorktrees?: boolean;
  limit?: number;
  worktrees?: SearchWorktreeInput[];
}

const DEFAULT_FILE_LIMIT = 60;
const DEFAULT_SEARCH_LIMIT = 500;

const ufFile = new uFuzzy({
  intraMode: 1,
  intraIns: 1,
  intraSub: 1,
  intraTrn: 1,
  intraDel: 1,
});

/**
 * Resolves the bundled ripgrep binary path, adjusting `app.asar` to `app.asar.unpacked`
 * when running inside a packaged Electron bundle.
 */
export function resolveRipgrepPath(rawPath: string = bundledRgPath): string {
  return rawPath.replace(/app\.asar([/\\])/g, "app.asar.unpacked$1");
}

interface ExecLinesResult {
  lines: string[];
  spawnError?: NodeJS.ErrnoException;
  exitCode: number | null;
}

function execCommandLines(command: string, args: readonly string[], cwd: string): Promise<ExecLinesResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const chunks: Buffer[] = [];
    let spawnError: NodeJS.ErrnoException | undefined;

    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      spawnError = err;
    });

    child.on("close", (code) => {
      if (spawnError) {
        resolve({ lines: [], spawnError, exitCode: code });
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      const lines = raw
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0);
      resolve({ lines, exitCode: code });
    });
  });
}

async function walkDirectoryFallback(rootDir: string): Promise<string[]> {
  const results: string[] = [];
  const stack: string[] = [""];

  while (stack.length > 0) {
    const relDir = stack.pop();
    if (relDir === undefined) continue;
    const absDir = relDir ? join(rootDir, relDir) : rootDir;
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        stack.push(relPath);
      } else if (entry.isFile()) {
        results.push(toPosixPath(relPath));
      }
    }
  }

  results.sort((a, b) => a.localeCompare(b));
  return results;
}

function normalizeListedPath(raw: string): string {
  const posix = toPosixPath(raw.trim());
  return posix.startsWith("./") ? posix.slice(2) : posix;
}

/**
 * Hot in-RAM file index per worktree, populated via `rg --files --hidden -g !.git`
 * with graceful fallback to `git --no-optional-locks ls-files -co --exclude-standard`.
 */
export class WorktreeFileIndex {
  private readonly cache = new Map<string, string[]>();
  private readonly inFlight = new Map<string, Promise<string[]>>();
  private readonly rgBinary: string;

  constructor(rgBinary: string = resolveRipgrepPath()) {
    this.rgBinary = rgBinary;
  }

  invalidate(worktreePath: string): void {
    this.cache.delete(worktreePath);
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  has(worktreePath: string): boolean {
    return this.cache.has(worktreePath);
  }

  async getFiles(worktreePath: string): Promise<string[]> {
    const cached = this.cache.get(worktreePath);
    if (cached) return cached;
    return this.refresh(worktreePath);
  }

  async refresh(worktreePath: string): Promise<string[]> {
    const existing = this.inFlight.get(worktreePath);
    if (existing) return existing;

    const promise = this.scanFiles(worktreePath)
      .then((files) => {
        this.cache.set(worktreePath, files);
        return files;
      })
      .finally(() => {
        this.inFlight.delete(worktreePath);
      });

    this.inFlight.set(worktreePath, promise);
    return promise;
  }

  private async scanFiles(worktreePath: string): Promise<string[]> {
    if (!existsSync(worktreePath)) {
      return [];
    }

    const rgRes = await execCommandLines(
      this.rgBinary,
      ["--files", "--hidden", "-g", "!.git"],
      worktreePath,
    );

    if (!rgRes.spawnError && (rgRes.exitCode === 0 || rgRes.exitCode === 1 || rgRes.lines.length > 0)) {
      const normalized = rgRes.lines.map(normalizeListedPath).filter(Boolean);
      normalized.sort((a, b) => a.localeCompare(b));
      return normalized;
    }

    const gitArgs = buildSafeGitArgs(["ls-files", "-co", "--exclude-standard"]);
    const gitRes = await execCommandLines("git", gitArgs, worktreePath);
    if (!gitRes.spawnError && gitRes.exitCode === 0) {
      const normalized = Array.from(new Set(gitRes.lines.map(normalizeListedPath).filter(Boolean)));
      normalized.sort((a, b) => a.localeCompare(b));
      return normalized;
    }

    return walkDirectoryFallback(worktreePath);
  }
}

export const worktreeFileIndex = new WorktreeFileIndex();

function getGitStatus(
  statuses: SearchWorktreeInput["gitStatuses"],
  filePath: string,
): FileGitStatus | undefined {
  if (!statuses) return undefined;
  if (statuses instanceof Map) {
    return statuses.get(filePath);
  }
  return statuses[filePath];
}

function gitStatusBoost(status: FileGitStatus | undefined): number {
  switch (status) {
    case "conflicted":
      return 650;
    case "modified":
      return 550;
    case "added":
      return 450;
    case "renamed":
      return 350;
    case "untracked":
      return 250;
    default:
      return 0;
  }
}

function extractBoundaryInitials(text: string): string {
  const initials: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (!/[a-zA-Z0-9]/.test(ch)) continue;
    const prev = i > 0 ? text[i - 1]! : "";
    const isStart = i === 0;
    const isAfterSep = prev !== "" && !/[a-zA-Z0-9]/.test(prev);
    const isCamelBump = /[A-Z]/.test(ch) && /[a-z0-9]/.test(prev);
    if (isStart || isAfterSep || isCamelBump) {
      initials.push(ch.toLowerCase());
    }
  }
  return initials.join("");
}

/**
 * Matches uppercase/camelHump abbreviations such as `FDU` -> `findDefinitionAndUsages`
 * or `SESS` / `sAS` against camel/snake/path boundaries.
 */
function scoreCamelHumpMatch(query: string, target: string): number {
  if (query.length < 2) return 0;
  const qLower = query.toLowerCase();
  if (!/^[a-z0-9]+$/i.test(query)) return 0;

  const initials = extractBoundaryInitials(target);
  if (initials === qLower) return 9000;
  if (initials.startsWith(qLower)) return 7500;
  if (initials.includes(qLower)) return 5500;

  // Subsequence across boundary starts + contiguous characters (e.g. `seTs` -> `session.ts`)
  let qi = 0;
  let boundaryHits = 0;
  let lastMatchedIdx = -2;
  for (let ti = 0; ti < target.length && qi < qLower.length; ti++) {
    const ch = target[ti]!;
    const prev = ti > 0 ? target[ti - 1]! : "";
    const isBoundary = ti === 0 || !/[a-zA-Z0-9]/.test(prev) || (/[A-Z]/.test(ch) && /[a-z0-9]/.test(prev));
    const isContiguous = ti === lastMatchedIdx + 1;
    if ((isBoundary || isContiguous) && ch.toLowerCase() === qLower[qi]) {
      if (isBoundary) boundaryHits++;
      lastMatchedIdx = ti;
      qi++;
    }
  }
  if (qi === qLower.length) {
    return 4000 + boundaryHits * 350;
  }
  return 0;
}

/**
 * Matches JetBrains-style slash-separated path abbreviations like `s/a/sess` -> `src/auth/session.ts`.
 */
function scorePathSegmentsMatch(querySegments: string[], pathSegments: string[]): number {
  if (querySegments.length < 2 || querySegments.length > pathSegments.length) return 0;

  // Prefer matching the last query segment against the basename
  let pIdx = 0;
  let score = 0;
  let contiguous = true;
  let prevMatchedPIdx = -1;

  for (let qIdx = 0; qIdx < querySegments.length; qIdx++) {
    const qSeg = querySegments[qIdx]!;
    const isLastQuerySeg = qIdx === querySegments.length - 1;
    let matched = false;

    const startSearch = isLastQuerySeg ? Math.max(pIdx, pathSegments.length - 1) : pIdx;
    for (let candidateIdx = startSearch; candidateIdx < pathSegments.length; candidateIdx++) {
      const pSeg = pathSegments[candidateIdx]!;
      const pSegLower = pSeg.toLowerCase();
      if (pSegLower === qSeg) {
        score += 3000;
        matched = true;
      } else if (pSegLower.startsWith(qSeg)) {
        score += 2200;
        matched = true;
      } else if (pSegLower.includes(qSeg)) {
        score += 1200;
        matched = true;
      }

      if (matched) {
        if (prevMatchedPIdx !== -1 && candidateIdx !== prevMatchedPIdx + 1) {
          contiguous = false;
        }
        prevMatchedPIdx = candidateIdx;
        pIdx = candidateIdx + 1;
        break;
      }
    }

    if (!matched) {
      return 0;
    }
  }

  if (prevMatchedPIdx === pathSegments.length - 1) {
    score += 4500;
  }
  if (contiguous) {
    score += 1500;
  }
  return score;
}

function stripLineSuffix(rawQuery: string): string {
  return rawQuery.trim().replace(/:\d+(?::\d+)?$/, "");
}

function scoreFileCandidate(
  cleanQuery: string,
  queryLower: string,
  querySegments: string[],
  filePath: string,
  gitStatus: FileGitStatus | undefined,
  uFuzzyRankBonus: number,
): number {
  const pathLower = filePath.toLowerCase();
  const slashIdx = filePath.lastIndexOf("/");
  const baseName = slashIdx === -1 ? filePath : filePath.slice(slashIdx + 1);
  const baseLower = baseName.toLowerCase();
  const dotIdx = baseLower.lastIndexOf(".");
  const stemLower = dotIdx > 0 ? baseLower.slice(0, dotIdx) : baseLower;

  let score = uFuzzyRankBonus;
  let matchedDirectly = uFuzzyRankBonus > 0;

  if (baseName === cleanQuery) {
    score += 22000;
    matchedDirectly = true;
  } else if (baseLower === queryLower) {
    score += 20000;
    matchedDirectly = true;
  } else if (stemLower === queryLower) {
    score += 16000;
    matchedDirectly = true;
  } else if (baseLower.startsWith(queryLower)) {
    score += 10500;
    matchedDirectly = true;
  } else if (baseLower.includes(queryLower)) {
    score += 5500;
    matchedDirectly = true;
  } else if (pathLower === queryLower) {
    score += 19000;
    matchedDirectly = true;
  } else if (pathLower.includes(queryLower)) {
    score += 3200;
    matchedDirectly = true;
  }

  if (querySegments.length >= 2) {
    const segScore = scorePathSegmentsMatch(querySegments, filePath.split("/"));
    if (segScore > 0) {
      score += segScore;
      matchedDirectly = true;
    }
  }

  const camelBaseScore = scoreCamelHumpMatch(cleanQuery, baseName);
  if (camelBaseScore > 0) {
    score += camelBaseScore + 1500;
    matchedDirectly = true;
  } else {
    const camelPathScore = scoreCamelHumpMatch(cleanQuery, filePath);
    if (camelPathScore > 0) {
      score += camelPathScore;
      matchedDirectly = true;
    }
  }

  if (!matchedDirectly) {
    return -1;
  }

  score += gitStatusBoost(gitStatus);
  score -= filePath.length * 0.5 + baseName.length * 0.25;
  return score;
}

function resolveTargetWorktrees(
  primaryWorktreePath: string,
  allWorktrees: boolean | undefined,
  worktrees?: SearchWorktreeInput[],
): SearchWorktreeInput[] {
  if (worktrees && worktrees.length > 0) {
    if (allWorktrees) {
      return worktrees;
    }
    const matching = worktrees.filter((wt) => wt.path === primaryWorktreePath);
    if (matching.length > 0) {
      return matching;
    }
  }
  return [{ path: primaryWorktreePath, name: basename(primaryWorktreePath) || primaryWorktreePath }];
}

/**
 * JetBrains-style fuzzy file finder powered by `@leeoniya/ufuzzy` + path-segment abbreviation,
 * camelHump initials, exact basename boosting, and git status boosting.
 */
export async function fuzzyFindFiles(
  params: FuzzyFindFilesParams,
  index: WorktreeFileIndex = worktreeFileIndex,
): Promise<FuzzyFileHit[]> {
  const limit = params.limit && params.limit > 0 ? params.limit : DEFAULT_FILE_LIMIT;
  const cleanQuery = stripLineSuffix(params.query);
  const targets = resolveTargetWorktrees(params.worktreePath, params.allWorktrees, params.worktrees);

  const fileLists = await Promise.all(
    targets.map(async (wt) => ({
      wt,
      files: await index.getFiles(wt.path),
    })),
  );

  interface CandidateItem {
    worktreePath: string;
    worktreeName: string;
    filePath: string;
    gitStatus?: FileGitStatus;
  }

  const items: CandidateItem[] = [];
  for (const { wt, files } of fileLists) {
    for (const filePath of files) {
      items.push({
        worktreePath: wt.path,
        worktreeName: wt.name,
        filePath,
        gitStatus: getGitStatus(wt.gitStatuses, filePath),
      });
    }
  }

  if (items.length === 0) return [];

  if (cleanQuery.length === 0) {
    const hits: FuzzyFileHit[] = items.map((item) => ({
      worktreePath: item.worktreePath,
      worktreeName: item.worktreeName,
      filePath: item.filePath,
      gitStatus: item.gitStatus,
      score: gitStatusBoost(item.gitStatus) - item.filePath.length * 0.5,
    }));
    hits.sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath));
    return hits.slice(0, limit);
  }

  const haystack = items.map((item) => item.filePath);
  const spaceQuery = cleanQuery.replace(/[/\\]+/g, " ").trim();
  const uFuzzyBonusByIdx = new Map<number, number>();

  if (spaceQuery.length > 0) {
    const [idxs, info, order] = ufFile.search(haystack, spaceQuery, 0, 2e3);
    if (order && info) {
      const total = order.length;
      for (let rank = 0; rank < total; rank++) {
        const infoIdx = order[rank]!;
        const itemIdx = info.idx[infoIdx]!;
        uFuzzyBonusByIdx.set(itemIdx, 2500 + ((total - rank) / Math.max(1, total)) * 1000);
      }
    } else if (idxs) {
      for (let i = 0; i < idxs.length; i++) {
        uFuzzyBonusByIdx.set(idxs[i]!, 2000);
      }
    }
  }

  const queryLower = cleanQuery.toLowerCase();
  const querySegments = queryLower.split(/[/\\]+/).filter((s) => s.length > 0);
  const scored: FuzzyFileHit[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const uBonus = uFuzzyBonusByIdx.get(i) ?? 0;
    const score = scoreFileCandidate(
      cleanQuery,
      queryLower,
      querySegments,
      item.filePath,
      item.gitStatus,
      uBonus,
    );
    if (score >= 0) {
      scored.push({
        worktreePath: item.worktreePath,
        worktreeName: item.worktreeName,
        filePath: item.filePath,
        gitStatus: item.gitStatus,
        score,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath));
  return scored.slice(0, limit);
}

/**
 * Converts a UTF-8 byte offset within `lineText` into a UTF-16 code-unit index.
 */
function utf8ByteOffsetToCharIndex(lineText: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  let bytesSeen = 0;
  let i = 0;
  while (i < lineText.length && bytesSeen < byteOffset) {
    const code = lineText.codePointAt(i)!;
    const utf8Len = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    const utf16Len = code > 0xffff ? 2 : 1;
    bytesSeen += utf8Len;
    i += utf16Len;
  }
  return i;
}

function splitFileMaskGlobs(fileMask?: string): string[] {
  if (!fileMask) return [];
  return fileMask
    .split(/[,;]+/)
    .map((g) => g.trim())
    .filter((g) => g.length > 0);
}

interface RgSubmatch {
  start: number;
  end: number;
}

interface RgMatchEvent {
  type: "match";
  data: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
    submatches?: RgSubmatch[];
  };
}

function runRipgrepSearch(
  rgBinary: string,
  wt: { path: string; name: string },
  query: FindInPathQuery,
  remainingLimit: number,
): Promise<{ matches: SearchMatch[]; spawnFailed: boolean }> {
  return new Promise((resolve) => {
    const args: string[] = ["--json", "--max-filesize", "1M", "-g", "!.git"];
    if (!query.isRegex) {
      args.push("--fixed-strings");
    }
    args.push(query.caseSensitive ? "--case-sensitive" : "--ignore-case");
    if (query.wholeWord) {
      args.push("--word-regexp");
    }
    for (const glob of splitFileMaskGlobs(query.fileMask)) {
      args.push("-g", glob);
    }
    args.push("--", query.query, ".");

    const child = spawn(rgBinary, args, {
      cwd: wt.path,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const matches: SearchMatch[] = [];
    let buffer = "";
    let spawnFailed = false;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({ matches, spawnFailed });
    };

    const processLine = (line: string) => {
      if (!line || matches.length >= remainingLimit) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object" || (parsed as { type?: string }).type !== "match") {
        return;
      }
      const ev = parsed as RgMatchEvent;
      const rawPath = ev.data.path?.text;
      const lineNum = ev.data.line_number;
      const rawLine = ev.data.lines?.text;
      if (!rawPath || typeof lineNum !== "number" || typeof rawLine !== "string") {
        return;
      }

      const filePath = normalizeListedPath(rawPath);
      const lineText = rawLine.replace(/\r?\n$/, "");
      const submatches = ev.data.submatches ?? [];

      if (submatches.length === 0) {
        matches.push({
          worktreePath: wt.path,
          worktreeName: wt.name,
          filePath,
          line: lineNum,
          column: 1,
          lineText,
          matchStart: 0,
          matchEnd: 0,
        });
      } else {
        for (const sub of submatches) {
          if (matches.length >= remainingLimit) break;
          const matchStart = utf8ByteOffsetToCharIndex(lineText, sub.start);
          const matchEnd = utf8ByteOffsetToCharIndex(lineText, sub.end);
          matches.push({
            worktreePath: wt.path,
            worktreeName: wt.name,
            filePath,
            line: lineNum,
            column: matchStart + 1,
            lineText,
            matchStart,
            matchEnd,
          });
        }
      }

      if (matches.length >= remainingLimit) {
        child.kill();
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nlIdx = buffer.indexOf("\n");
      while (nlIdx !== -1) {
        const line = buffer.slice(0, nlIdx);
        buffer = buffer.slice(nlIdx + 1);
        processLine(line);
        nlIdx = buffer.indexOf("\n");
      }
    });

    child.on("error", () => {
      spawnFailed = true;
      finish();
    });

    child.on("close", () => {
      if (buffer.length > 0) {
        processLine(buffer);
        buffer = "";
      }
      finish();
    });
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSearchMatcherRegex(query: FindInPathQuery): RegExp | null {
  try {
    let source = query.isRegex ? query.query : escapeRegExp(query.query);
    if (query.wholeWord) {
      source = `\\b(?:${source})\\b`;
    }
    const flags = query.caseSensitive ? "g" : "gi";
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

async function runGitGrepFallback(
  wt: { path: string; name: string },
  query: FindInPathQuery,
  remainingLimit: number,
): Promise<SearchMatch[]> {
  const rawArgs: string[] = ["grep", "-nI", "--untracked"];
  if (!query.isRegex) {
    rawArgs.push("-F");
  } else {
    rawArgs.push("-E");
  }
  if (!query.caseSensitive) {
    rawArgs.push("-i");
  }
  if (query.wholeWord) {
    rawArgs.push("-w");
  }
  rawArgs.push("-e", query.query);
  const masks = splitFileMaskGlobs(query.fileMask);
  if (masks.length > 0) {
    rawArgs.push("--", ...masks);
  }

  const gitArgs = buildSafeGitArgs(rawArgs);
  const res = await execCommandLines("git", gitArgs, wt.path);
  if (res.spawnError) return [];

  const matcher = buildSearchMatcherRegex(query);
  const matches: SearchMatch[] = [];

  for (const row of res.lines) {
    if (matches.length >= remainingLimit) break;
    const firstColon = row.indexOf(":");
    if (firstColon === -1) continue;
    const secondColon = row.indexOf(":", firstColon + 1);
    if (secondColon === -1) continue;

    const filePath = normalizeListedPath(row.slice(0, firstColon));
    const lineNum = Number.parseInt(row.slice(firstColon + 1, secondColon), 10);
    if (!Number.isFinite(lineNum)) continue;
    const lineText = row.slice(secondColon + 1);

    if (matcher) {
      matcher.lastIndex = 0;
      let hit = matcher.exec(lineText);
      if (!hit) {
        matches.push({
          worktreePath: wt.path,
          worktreeName: wt.name,
          filePath,
          line: lineNum,
          column: 1,
          lineText,
          matchStart: 0,
          matchEnd: 0,
        });
      } else {
        while (hit && matches.length < remainingLimit) {
          matches.push({
            worktreePath: wt.path,
            worktreeName: wt.name,
            filePath,
            line: lineNum,
            column: hit.index + 1,
            lineText,
            matchStart: hit.index,
            matchEnd: hit.index + hit[0].length,
          });
          if (hit[0].length === 0) {
            matcher.lastIndex++;
          }
          hit = matcher.exec(lineText);
        }
      }
    }
  }

  return matches;
}

/**
 * Runs ripgrep (`rg --json`) across the requested worktree(s) with graceful fallback to
 * `git --no-optional-locks grep -nI --untracked` if `rg` fails to spawn.
 */
export async function findInPath(
  query: FindInPathQuery,
  worktrees: { path: string; name: string }[] = [],
  rgBinary: string = resolveRipgrepPath(),
): Promise<SearchMatch[]> {
  if (!query.query) return [];

  const limit = query.limit && query.limit > 0 ? query.limit : DEFAULT_SEARCH_LIMIT;
  const targets = resolveTargetWorktrees(query.worktreePath, query.allWorktrees, worktrees);
  const allMatches: SearchMatch[] = [];

  for (const wt of targets) {
    if (allMatches.length >= limit) break;
    if (!existsSync(wt.path)) continue;

    const remaining = limit - allMatches.length;
    const rgRes = await runRipgrepSearch(rgBinary, wt, query, remaining);
    if (!rgRes.spawnFailed) {
      allMatches.push(...rgRes.matches);
    } else {
      const gitMatches = await runGitGrepFallback(wt, query, remaining);
      allMatches.push(...gitMatches);
    }
  }

  return allMatches.slice(0, limit);
}
