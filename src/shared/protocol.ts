/**
 * Shared RPC & Domain Protocol for expect2 IDE (`ide2`).
 * Single source of truth across Main, Worker, Preload, Renderer, and CLI (`--export`).
 */

export type FileGitStatus = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted" | "clean";

export interface WorktreeInfo {
  /** Absolute canonical filesystem path to the worktree root. */
  path: string;
  /** Short human-readable label (e.g. "main", "api-v2"). */
  name: string;
  /** Checked-out branch name (short, e.g. "feat/api-v2") or "(detached)". */
  branch: string;
  /** Short 7-char HEAD commit hash. */
  headSha: string;
  /** Subject line of HEAD commit. */
  headSubject: string;
  /** Whether this is the primary/main worktree of the repository. */
  isMain: boolean;
  /** Detected default base ref (e.g. "main", "master"). */
  baseRef: string;
  /** Merge-base short SHA between baseRef and HEAD (or headSha if on base). */
  mergeBaseSha: string;
  /** Commits ahead of baseRef. */
  ahead: number;
  /** Commits behind baseRef. */
  behind: number;
  /** Working-tree + staged modified/added/deleted/untracked counts. */
  counts: {
    modified: number;
    added: number;
    deleted: number;
    untracked: number;
    conflicted: number;
    /** Total files changed between mergeBaseSha and current working tree. */
    branchChanged: number;
  };
  /** Epoch ms of most recent filesystem modification observed in this worktree. */
  lastActivityAt: number;
}

export interface FileEntry {
  /** Worktree-relative POSIX path (e.g. "src/auth/session.ts"). */
  path: string;
  /** Basename (e.g. "session.ts"). */
  name: string;
  /** Git status in working tree (or branch diff status). */
  gitStatus?: FileGitStatus;
  /** Line additions vs active diff scope, if computed. */
  additions?: number;
  /** Line deletions vs active diff scope, if computed. */
  deletions?: number;
}

export interface ChangedFileSummary {
  path: string;
  oldPath?: string;
  status: FileGitStatus;
  additions: number;
  deletions: number;
  staged: boolean;
}

export type DiffScope =
  | { kind: "branch"; baseRef?: string }          // merge-base(baseRef, HEAD) <-> Working Tree (default for reviewing agent work)
  | { kind: "working" }                           // HEAD <-> Working Tree (uncommitted + untracked)
  | { kind: "commit"; sha: string }               // Commit parent <-> Commit
  | { kind: "worktree"; otherWorktreePath: string }; // Current Worktree <-> Another Worktree

export interface TokenSpan {
  text: string;
  /** Semantic cold-tonal token class: id | decl | kw | type | lit | comment | punct */
  cls: "id" | "decl" | "kw" | "type" | "lit" | "comment" | "punct";
}

export interface LineBlame {
  sha: string;
  author: string;
  relativeTime: string;
  summary: string;
}

export interface FileDocument {
  worktreePath: string;
  filePath: string;
  language: string;
  isBinary: boolean;
  isTruncated: boolean;
  byteLength: number;
  mtimeMs: number;
  contentHash: string;
  lines: string[];
  /** Optional syntax token spans per 0-based line index (populated immediately or streamed from worker). */
  tokens?: TokenSpan[][];
  /** Per-line git change status against the active diff base ("added" | "modified") + deleted line markers. */
  lineGitMarkers?: Record<number, "added" | "modified" | "deleted-after">;
}

export interface WordDiffPart {
  text: string;
  added?: boolean;
  removed?: boolean;
}

export interface DiffRow {
  type: "context" | "add" | "del" | "modify" | "hunk";
  header?: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  oldText?: string;
  newText?: string;
  oldParts?: WordDiffPart[];
  newParts?: WordDiffPart[];
}

export interface FileDiffResult {
  worktreePath: string;
  filePath: string;
  oldPath?: string;
  scope: DiffScope;
  baseLabel: string;
  targetLabel: string;
  isBinary: boolean;
  additions: number;
  deletions: number;
  rows: DiffRow[];
  rawPatch: string;
}

export interface CommitEntry {
  sha: string;
  shortSha: string;
  author: string;
  dateIso: string;
  relativeTime: string;
  subject: string;
  refs: string[];
}

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "const"
  | "variable"
  | "property"
  | "enum"
  | "module"
  | "heading";

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  filePath: string;
  worktreePath: string;
  /** 1-based start line */
  startLine: number;
  /** 1-based end line */
  endLine: number;
  detail?: string;
  children?: CodeSymbol[];
}

export interface SearchMatch {
  worktreePath: string;
  worktreeName: string;
  filePath: string;
  /** 1-based line number */
  line: number;
  /** 1-based column */
  column: number;
  lineText: string;
  matchStart: number;
  matchEnd: number;
}

export interface FindInPathQuery {
  worktreePath: string;
  allWorktrees?: boolean;
  query: string;
  isRegex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  fileMask?: string;
  limit?: number;
}

export interface FuzzyFileHit {
  worktreePath: string;
  worktreeName: string;
  filePath: string;
  gitStatus?: FileGitStatus;
  score: number;
}

export type AnnotationStatus = "open" | "outdated" | "resolved";

export interface Annotation {
  id: string;
  worktreePath: string;
  /** Omit filePath for general worktree-level instructions/summary note. */
  filePath?: string;
  /** "new" (current file / right diff side) or "old" (deleted line on left diff side). */
  side?: "new" | "old";
  /** 1-based inclusive start line. */
  startLine?: number;
  /** 1-based inclusive end line. */
  endLine?: number;
  comment: string;
  anchor?: {
    selectedText: string;
    contextBefore: string;
    contextAfter: string;
    contentHash: string;
    language?: string;
  };
  status: AnnotationStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAnnotationInput {
  worktreePath: string;
  filePath?: string;
  side?: "new" | "old";
  startLine?: number;
  endLine?: number;
  comment: string;
  selectedText?: string;
  contextBefore?: string;
  contextAfter?: string;
  contentHash?: string;
  language?: string;
}

export interface UpdateAnnotationInput {
  id: string;
  comment?: string;
  status?: AnnotationStatus;
}

export interface ExportPromptOptions {
  worktreePath: string;
  includeOutdated?: boolean;
  resolveAfterExport?: boolean;
}

export interface LaunchContext {
  repoCommonDir: string;
  repoName: string;
  initialWorktreePath: string;
  initialFilePath?: string;
  initialLine?: number;
  initialColumn?: number;
  initialDiffMode?: boolean;
  initialBaseRef?: string;
  platform: "darwin" | "linux" | "win32";
}

export type WorkspaceEvent =
  | {
      type: "worktrees-updated";
      worktrees: WorktreeInfo[];
      changedWorktreePath?: string;
      changedFiles?: string[];
    }
  | {
      type: "annotations-updated";
      worktreePath: string;
      annotations: Annotation[];
    }
  | {
      type: "tokens-ready";
      worktreePath: string;
      filePath: string;
      contentHash: string;
      tokens: TokenSpan[][];
      symbols: CodeSymbol[];
    }
  | {
      type: "cli-open-target";
      worktreePath: string;
      filePath?: string;
      line?: number;
      column?: number;
      diffMode?: boolean;
    }
  | {
      type: "native-shortcut";
      action: string;
    };

export interface Ide2Bridge {
  getBootstrap(): Promise<{
    context: LaunchContext;
    worktrees: WorktreeInfo[];
    annotations: Annotation[];
  }>;
  listFiles(worktreePath: string): Promise<FileEntry[]>;
  fuzzyFindFiles(params: {
    worktreePath: string;
    query: string;
    allWorktrees?: boolean;
    limit?: number;
  }): Promise<FuzzyFileHit[]>;
  readFile(worktreePath: string, filePath: string, diffScope?: DiffScope): Promise<FileDocument>;
  readAssetDataUrl(worktreePath: string, relativeFromFile: string, rawHref: string): Promise<string | null>;
  getDiff(worktreePath: string, filePath: string, scope: DiffScope): Promise<FileDiffResult>;
  listChangedFiles(worktreePath: string, scope: DiffScope): Promise<ChangedFileSummary[]>;
  listCommits(worktreePath: string, limit?: number): Promise<CommitEntry[]>;
  getBlame(worktreePath: string, filePath: string): Promise<LineBlame[]>;
  getStructure(worktreePath: string, filePath: string): Promise<CodeSymbol[]>;
  searchSymbols(params: {
    worktreePath: string;
    query: string;
    allWorktrees?: boolean;
    limit?: number;
  }): Promise<CodeSymbol[]>;
  findDefinitionAndUsages(params: {
    worktreePath: string;
    filePath: string;
    symbolName: string;
    line: number;
  }): Promise<{ definitions: SearchMatch[]; usages: SearchMatch[] }>;
  findInPath(query: FindInPathQuery): Promise<SearchMatch[]>;
  listAnnotations(worktreePath?: string): Promise<Annotation[]>;
  createAnnotation(input: CreateAnnotationInput): Promise<Annotation>;
  updateAnnotation(input: UpdateAnnotationInput): Promise<Annotation>;
  deleteAnnotation(id: string): Promise<void>;
  compileFeedbackPrompt(options: ExportPromptOptions): Promise<{ markdown: string; count: number }>;
  copyToClipboard(text: string): Promise<void>;
  openExternalUrl(url: string): Promise<void>;
  revealInOs(targetPath: string): Promise<void>;
  createWorktree(params: { baseWorktreePath: string; branchName: string; baseRef?: string; targetDir?: string }): Promise<WorktreeInfo>;
  onEvent(listener: (event: WorkspaceEvent) => void): () => void;
}
