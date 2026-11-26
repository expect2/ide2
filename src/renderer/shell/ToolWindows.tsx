import React, { useEffect, useMemo, useRef, useState } from "react";
import { compileFeedbackPromptMarkdown } from "../../shared/prompt-compiler.js";
import type {
  Annotation,
  AnnotationIntent,
  AnnotationStatus,
  ChangedFileSummary,
  CodeSymbol,
  CommitEntry,
  DiffScope,
  ExportPromptOptions,
  FileEntry,
  FileGitStatus,
  SearchMatch,
  SymbolKind,
  WorktreeInfo,
} from "../../shared/protocol.js";
import { formatShortcut, type Platform } from "./keymap.js";
import { formatRelativeActivity } from "./WorktreeStrip.js";

/* -------------------------------------------------------------------------- */
/* Shared Helpers                                                             */
/* -------------------------------------------------------------------------- */

function getStatusBadge(status?: FileGitStatus): { glyph: string; color: string; label: string } | null {
  switch (status) {
    case "added":
    case "untracked":
      return { glyph: "+", color: "var(--safe, #6dffa6)", label: status };
    case "modified":
    case "renamed":
      return { glyph: "~", color: "var(--unknown, #ffe45c)", label: status };
    case "deleted":
      return { glyph: "-", color: "var(--unsafe, #ff5d4d)", label: status };
    case "conflicted":
      return { glyph: "!", color: "var(--unsafe, #ff5d4d)", label: status };
    default:
      return null;
  }
}

const toolHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "6px",
  padding: "4px 8px",
  background: "var(--paper, #05081a)",
  borderBottom: "1px solid var(--faint, #27326b)",
  fontSize: "11px",
  fontWeight: 700,
  letterSpacing: "0.04em",
  color: "var(--ink, #f4f6ff)",
  flexShrink: 0,
};

const smallBtnStyle: React.CSSProperties = {
  background: "var(--screen, #0a0f2c)",
  border: "1px solid var(--faint, #27326b)",
  color: "var(--ink, #f4f6ff)",
  padding: "2px 6px",
  fontFamily: "inherit",
  fontSize: "11px",
  cursor: "pointer",
  borderRadius: 0,
};

const searchInputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--screen, #0a0f2c)",
  border: "1px solid var(--faint, #27326b)",
  color: "var(--ink, #f4f6ff)",
  padding: "4px 6px",
  fontFamily: "inherit",
  fontSize: "12px",
  outline: "none",
  borderRadius: 0,
};

/* -------------------------------------------------------------------------- */
/* 1. ProjectToolWindow (1: Project)                                          */
/* -------------------------------------------------------------------------- */

export interface ProjectToolWindowProps {
  worktreeName: string;
  files: readonly FileEntry[];
  activeFilePath?: string;
  annotations?: readonly Annotation[];
  activeWorktreePath?: string;
  platform: Platform;
  onSelectFile: (filePath: string) => void;
  onClose?: () => void;
}

interface TreeDirNode {
  kind: "dir";
  name: string;
  path: string;
  dirs: Map<string, TreeDirNode>;
  files: FileEntry[];
}

interface FlatTreeRow {
  kind: "dir" | "file";
  key: string;
  name: string;
  path: string;
  depth: number;
  entry?: FileEntry;
  hasChildren?: boolean;
  isExpanded?: boolean;
}

function buildDirectoryTree(files: readonly FileEntry[], rootName: string): TreeDirNode {
  const root: TreeDirNode = {
    kind: "dir",
    name: rootName,
    path: "",
    dirs: new Map(),
    files: [],
  };

  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    let cursor = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!;
      let child = cursor.dirs.get(seg);
      if (!child) {
        const dirPath = cursor.path ? `${cursor.path}/${seg}` : seg;
        child = {
          kind: "dir",
          name: seg,
          path: dirPath,
          dirs: new Map(),
          files: [],
        };
        cursor.dirs.set(seg, child);
      }
      cursor = child;
    }
    cursor.files.push(file);
  }
  return root;
}

function compactSingleChildDirs(node: TreeDirNode): TreeDirNode {
  const nextDirs = new Map<string, TreeDirNode>();
  for (const [, rawChild] of node.dirs) {
    let child = compactSingleChildDirs(rawChild);
    let combinedName = child.name;
    let combinedPath = child.path;
    while (child.dirs.size === 1 && child.files.length === 0) {
      const only = child.dirs.values().next().value;
      if (!only) break;
      combinedName = `${combinedName}/${only.name}`;
      combinedPath = only.path;
      child = only;
    }
    nextDirs.set(combinedName, {
      kind: "dir",
      name: combinedName,
      path: combinedPath,
      dirs: child.dirs,
      files: child.files,
    });
  }
  return {
    ...node,
    dirs: nextDirs,
  };
}

function flattenTree(
  node: TreeDirNode,
  expanded: Set<string>,
  depth: number,
  forceExpandAll: boolean,
  out: FlatTreeRow[],
): void {
  const sortedDirs = Array.from(node.dirs.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const sortedFiles = node.files
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const dir of sortedDirs) {
    const isExpanded = forceExpandAll || expanded.has(dir.path);
    out.push({
      kind: "dir",
      key: `dir:${dir.path}`,
      name: dir.name,
      path: dir.path,
      depth,
      hasChildren: dir.dirs.size > 0 || dir.files.length > 0,
      isExpanded,
    });
    if (isExpanded) {
      flattenTree(dir, expanded, depth + 1, forceExpandAll, out);
    }
  }

  for (const file of sortedFiles) {
    out.push({
      kind: "file",
      key: `file:${file.path}`,
      name: file.name,
      path: file.path,
      depth,
      entry: file,
    });
  }
}

export const ProjectToolWindow: React.FC<ProjectToolWindowProps> = ({
  worktreeName,
  files,
  activeFilePath,
  annotations = [],
  activeWorktreePath,
  platform,
  onSelectFile,
  onClose,
}) => {
  const [filter, setFilter] = useState<string>("");
  const [compactFolders, setCompactFolders] = useState<boolean>(true);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["src"]));
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const openAnnotationCountsByFile = useMemo(() => {
    const map = new Map<string, number>();
    for (const ann of annotations) {
      if (ann.status !== "open" || !ann.filePath) continue;
      if (activeWorktreePath && ann.worktreePath !== activeWorktreePath) continue;
      map.set(ann.filePath, (map.get(ann.filePath) ?? 0) + 1);
    }
    return map;
  }, [annotations, activeWorktreePath]);

  const filteredFiles = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) => f.path.toLowerCase().includes(q));
  }, [files, filter]);

  const rows = useMemo(() => {
    const rawTree = buildDirectoryTree(filteredFiles, worktreeName);
    const tree = compactFolders ? compactSingleChildDirs(rawTree) : rawTree;
    const result: FlatTreeRow[] = [];
    flattenTree(tree, expanded, 0, filter.trim().length > 0, result);
    return result;
  }, [filteredFiles, worktreeName, compactFolders, expanded, filter]);

  const toggleDir = (dirPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
      }
      return next;
    });
  };

  const locateActiveFile = () => {
    if (!activeFilePath) return;
    const parts = activeFilePath.split("/").filter(Boolean);
    if (parts.length > 1) {
      setExpanded((prev) => {
        const next = new Set(prev);
        let prefix = "";
        for (let i = 0; i < parts.length - 1; i++) {
          prefix = prefix ? `${prefix}/${parts[i]}` : parts[i]!;
          next.add(prefix);
        }
        return next;
      });
    }
    window.setTimeout(() => {
      const el = rowRefs.current.get(activeFilePath);
      el?.scrollIntoView({ block: "nearest" });
      el?.focus();
    }, 16);
  };

  return (
    <section
      className="ide2-tool-window ide2-project-tool"
      aria-label="Project Tool Window"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--paper, #05081a)",
        color: "var(--ink, #f4f6ff)",
        fontFamily: "var(--mono, 'Kode Mono', monospace)",
        fontSize: "12px",
      }}
    >
      <div style={toolHeaderStyle}>
        <span>┌─ 1 PROJECT ({worktreeName})</span>
        <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          <button
            type="button"
            onClick={locateActiveFile}
            disabled={!activeFilePath}
            title="Locate Active File in Project Tree"
            style={{
              ...smallBtnStyle,
              opacity: activeFilePath ? 1 : 0.45,
            }}
          >
            ◎ Locate
          </button>
          <button
            type="button"
            onClick={() => setCompactFolders((v) => !v)}
            title="Toggle Compact Middle Directories"
            style={{
              ...smallBtnStyle,
              background: compactFolders ? "var(--wash-hi, #111943)" : "var(--screen, #0a0f2c)",
            }}
          >
            ⊟
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title={`Hide (${formatShortcut("tool-project", platform)})`}
              style={smallBtnStyle}
            >
              ×
            </button>
          )}
        </div>
      </div>

      <div style={{ padding: "6px", borderBottom: "1px solid var(--faint, #27326b)" }}>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter files..."
          aria-label="Filter project files"
          style={searchInputStyle}
        />
      </div>

      <div
        role="tree"
        aria-label="Files"
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "4px 0",
        }}
      >
        {rows.length === 0 ? (
          <div style={{ padding: "12px 10px", color: "var(--dim, #93a3de)" }}>
            No matching files.
          </div>
        ) : (
          rows.map((row) => {
            if (row.kind === "dir") {
              return (
                <button
                  key={row.key}
                  type="button"
                  role="treeitem"
                  aria-expanded={row.isExpanded}
                  onClick={() => toggleDir(row.path)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "5px",
                    width: "100%",
                    textAlign: "left",
                    padding: "2px 8px",
                    paddingLeft: `${8 + row.depth * 14}px`,
                    background: "transparent",
                    border: "none",
                    color: "var(--dim, #93a3de)",
                    fontFamily: "inherit",
                    fontSize: "12px",
                    cursor: "pointer",
                  }}
                >
                  <span style={{ width: "10px", display: "inline-block" }}>
                    {row.isExpanded ? "▾" : "▸"}
                  </span>
                  <span style={{ fontWeight: 600 }}>{row.name}</span>
                </button>
              );
            }

            const isSelected = row.path === activeFilePath;
            const badge = getStatusBadge(row.entry?.gitStatus);
            const annCount = openAnnotationCountsByFile.get(row.path) ?? 0;

            return (
              <button
                key={row.key}
                ref={(el) => {
                  if (el) rowRefs.current.set(row.path, el);
                  else rowRefs.current.delete(row.path);
                }}
                type="button"
                role="treeitem"
                aria-selected={isSelected}
                onClick={() => onSelectFile(row.path)}
                title={row.path}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "6px",
                  width: "100%",
                  textAlign: "left",
                  padding: "2px 8px",
                  paddingLeft: `${18 + row.depth * 14}px`,
                  background: isSelected ? "var(--ink, #f4f6ff)" : "transparent",
                  color: isSelected
                    ? "var(--knock, #05081a)"
                    : badge
                      ? badge.color
                      : "var(--ink, #f4f6ff)",
                  border: "none",
                  fontFamily: "inherit",
                  fontSize: "12px",
                  cursor: "pointer",
                  fontWeight: isSelected ? 700 : 400,
                }}
              >
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "5px",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  <span
                    style={{
                      width: "10px",
                      display: "inline-block",
                      color: isSelected ? "var(--knock, #05081a)" : badge?.color ?? "var(--off, #56659e)",
                      fontWeight: 700,
                    }}
                  >
                    {badge ? badge.glyph : " "}
                  </span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                    {row.name}
                  </span>
                </span>

                <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", flexShrink: 0, fontSize: "11px" }}>
                  {annCount > 0 && (
                    <span style={{ color: isSelected ? "var(--knock, #05081a)" : "var(--sky, #3d6bff)" }}>
                      ◆{annCount}
                    </span>
                  )}
                  {row.entry?.additions !== undefined && row.entry.additions > 0 && (
                    <span style={{ color: isSelected ? "var(--knock, #05081a)" : "var(--safe, #6dffa6)" }}>
                      +{row.entry.additions}
                    </span>
                  )}
                  {row.entry?.deletions !== undefined && row.entry.deletions > 0 && (
                    <span style={{ color: isSelected ? "var(--knock, #05081a)" : "var(--unsafe, #ff5d4d)" }}>
                      -{row.entry.deletions}
                    </span>
                  )}
                </span>
              </button>
            );
          })
        )}
      </div>
    </section>
  );
};

/* -------------------------------------------------------------------------- */
/* 2. StructureToolWindow (7: Structure)                                      */
/* -------------------------------------------------------------------------- */

export interface StructureToolWindowProps {
  filePath?: string;
  symbols: readonly CodeSymbol[];
  activeLine?: number;
  platform: Platform;
  onSelectSymbol: (symbol: CodeSymbol) => void;
  onClose?: () => void;
}

function getSymbolBadge(kind: SymbolKind): { tag: string; color: string } {
  switch (kind) {
    case "function":
    case "method":
      return { tag: "fn", color: "var(--syn-decl, #ffffff)" };
    case "class":
      return { tag: "cls", color: "var(--syn-type, #7ea0ff)" };
    case "interface":
      return { tag: "ifc", color: "var(--syn-type, #7ea0ff)" };
    case "type":
    case "enum":
    case "module":
      return { tag: "typ", color: "var(--syn-kw, #b4c5ff)" };
    case "const":
    case "variable":
    case "property":
      return { tag: "cst", color: "var(--syn-lit, #9fb0e3)" };
    case "heading":
      return { tag: "#", color: "var(--sky, #3d6bff)" };
  }
}

function findActiveSymbolKey(symbols: readonly CodeSymbol[], activeLine?: number): string | null {
  if (!activeLine || activeLine <= 0) return null;
  let bestKey: string | null = null;
  let bestSpan = Infinity;

  const visit = (list: readonly CodeSymbol[], prefix: string) => {
    for (let i = 0; i < list.length; i++) {
      const sym = list[i]!;
      const key = `${prefix}/${sym.name}:${sym.startLine}:${i}`;
      if (activeLine >= sym.startLine && activeLine <= sym.endLine) {
        const span = sym.endLine - sym.startLine;
        if (span <= bestSpan) {
          bestSpan = span;
          bestKey = key;
        }
      }
      if (sym.children?.length) {
        visit(sym.children, key);
      }
    }
  };

  visit(symbols, "");
  return bestKey;
}

function filterSymbols(symbols: readonly CodeSymbol[], query: string): CodeSymbol[] {
  const q = query.trim().toLowerCase();
  if (!q) return symbols.slice();
  const out: CodeSymbol[] = [];
  for (const sym of symbols) {
    const filteredChildren = sym.children ? filterSymbols(sym.children, q) : [];
    if (sym.name.toLowerCase().includes(q) || filteredChildren.length > 0) {
      out.push({
        ...sym,
        children: filteredChildren.length > 0 ? filteredChildren : sym.children,
      });
    }
  }
  return out;
}

export const StructureToolWindow: React.FC<StructureToolWindowProps> = ({
  filePath,
  symbols,
  activeLine,
  platform,
  onSelectSymbol,
  onClose,
}) => {
  const [filter, setFilter] = useState<string>("");

  const visibleSymbols = useMemo(() => filterSymbols(symbols, filter), [symbols, filter]);
  const activeKey = useMemo(
    () => findActiveSymbolKey(visibleSymbols, activeLine),
    [visibleSymbols, activeLine],
  );

  const renderNodes = (list: readonly CodeSymbol[], depth: number, prefix: string): React.ReactNode => {
    return list.map((sym, idx) => {
      const key = `${prefix}/${sym.name}:${sym.startLine}:${idx}`;
      const isCurrent = key === activeKey;
      const badge = getSymbolBadge(sym.kind);

      return (
        <React.Fragment key={key}>
          <button
            type="button"
            onClick={() => onSelectSymbol(sym)}
            title={`${sym.kind} ${sym.name} (L${sym.startLine}–L${sym.endLine})`}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "6px",
              width: "100%",
              textAlign: "left",
              padding: "3px 8px",
              paddingLeft: `${8 + depth * 14}px`,
              background: isCurrent ? "var(--ink, #f4f6ff)" : "transparent",
              color: isCurrent ? "var(--knock, #05081a)" : "var(--ink, #f4f6ff)",
              border: "none",
              fontFamily: "inherit",
              fontSize: "12px",
              cursor: "pointer",
              fontWeight: isCurrent ? 700 : 400,
            }}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              <span
                style={{
                  minWidth: "24px",
                  fontSize: "10px",
                  fontWeight: 700,
                  textAlign: "center",
                  padding: "0 3px",
                  border: isCurrent
                    ? "1px solid var(--knock, #05081a)"
                    : "1px solid var(--faint, #27326b)",
                  color: isCurrent ? "var(--knock, #05081a)" : badge.color,
                }}
              >
                {badge.tag}
              </span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                {sym.name}
              </span>
            </span>
            <span
              style={{
                fontSize: "11px",
                color: isCurrent ? "var(--knock, #05081a)" : "var(--dim, #93a3de)",
                flexShrink: 0,
              }}
            >
              :{sym.startLine}
            </span>
          </button>
          {sym.children && sym.children.length > 0 && renderNodes(sym.children, depth + 1, key)}
        </React.Fragment>
      );
    });
  };

  return (
    <section
      className="ide2-tool-window ide2-structure-tool"
      aria-label="Structure Tool Window"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--paper, #05081a)",
        color: "var(--ink, #f4f6ff)",
        fontFamily: "var(--mono, 'Kode Mono', monospace)",
        fontSize: "12px",
      }}
    >
      <div style={toolHeaderStyle}>
        <span>┌─ 7 STRUCTURE {filePath ? `· ${filePath.split("/").pop()}` : ""}</span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title={`Hide (${formatShortcut("tool-structure", platform)})`}
            style={smallBtnStyle}
          >
            ×
          </button>
        )}
      </div>

      <div style={{ padding: "6px", borderBottom: "1px solid var(--faint, #27326b)" }}>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter symbols..."
          aria-label="Filter structure symbols"
          style={searchInputStyle}
        />
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
        {!filePath ? (
          <div style={{ padding: "12px 10px", color: "var(--dim, #93a3de)" }}>
            Open a file to inspect its AST structure.
          </div>
        ) : visibleSymbols.length === 0 ? (
          <div style={{ padding: "12px 10px", color: "var(--dim, #93a3de)" }}>
            No symbols found.
          </div>
        ) : (
          renderNodes(visibleSymbols, 0, "")
        )}
      </div>
    </section>
  );
};

/* -------------------------------------------------------------------------- */
/* 3. GitToolWindow (9: Git)                                                  */
/* -------------------------------------------------------------------------- */

export type GitSubTab = "changes" | "worktrees" | "log";

export interface GitToolWindowProps {
  worktrees: readonly WorktreeInfo[];
  activeWorktree: WorktreeInfo;
  changedFiles: readonly ChangedFileSummary[];
  diffScope: DiffScope;
  commits: readonly CommitEntry[];
  activeFilePath?: string;
  platform: Platform;
  initialTab?: GitSubTab;
  onChangeDiffScope: (scope: DiffScope) => void;
  onOpenDiff: (filePath: string, scope: DiffScope) => void;
  onOpenActiveFileDiff?: () => void;
  onSwitchWorktree: (worktreePath: string) => void;
  onCompareWorktrees: (otherWorktreePath: string) => void;
  onCopyText: (text: string) => void | Promise<void>;
  onLoadCommitChanges?: (sha: string) => Promise<ChangedFileSummary[]>;
  onClose?: () => void;
}

export const GitToolWindow: React.FC<GitToolWindowProps> = ({
  worktrees,
  activeWorktree,
  changedFiles,
  diffScope,
  commits,
  activeFilePath,
  platform,
  initialTab = "changes",
  onChangeDiffScope,
  onOpenDiff,
  onOpenActiveFileDiff,
  onSwitchWorktree,
  onCompareWorktrees,
  onCopyText,
  onLoadCommitChanges,
  onClose,
}) => {
  const [subTab, setSubTab] = useState<GitSubTab>(initialTab);
  const [selectedCommit, setSelectedCommit] = useState<CommitEntry | null>(null);
  const [commitFiles, setCommitFiles] = useState<ChangedFileSummary[]>([]);
  const [loadingCommit, setLoadingCommit] = useState<boolean>(false);
  const [now] = useState<number>(() => Date.now());

  const handleSelectCommit = async (commit: CommitEntry) => {
    setSelectedCommit(commit);
    if (!onLoadCommitChanges) {
      setCommitFiles([]);
      return;
    }
    setLoadingCommit(true);
    try {
      const files = await onLoadCommitChanges(commit.sha);
      setCommitFiles(files);
    } catch {
      setCommitFiles([]);
    } finally {
      setLoadingCommit(false);
    }
  };

  return (
    <section
      className="ide2-tool-window ide2-git-tool"
      aria-label="Git Tool Window"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--paper, #05081a)",
        color: "var(--ink, #f4f6ff)",
        fontFamily: "var(--mono, 'Kode Mono', monospace)",
        fontSize: "12px",
      }}
    >
      <div style={toolHeaderStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span>┌─ 9 GIT: {activeWorktree.name}</span>
          <div role="tablist" style={{ display: "inline-flex", gap: "4px" }}>
            {(["changes", "worktrees", "log"] as const).map((tab) => {
              const isActive = subTab === tab;
              return (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setSubTab(tab)}
                  style={{
                    ...smallBtnStyle,
                    background: isActive ? "var(--ink, #f4f6ff)" : "var(--screen, #0a0f2c)",
                    color: isActive ? "var(--knock, #05081a)" : "var(--dim, #93a3de)",
                    fontWeight: isActive ? 700 : 500,
                    textTransform: "capitalize",
                  }}
                >
                  {tab}
                  {tab === "changes" ? ` (${changedFiles.length})` : ""}
                  {tab === "worktrees" ? ` (${worktrees.length})` : ""}
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <button
            type="button"
            onClick={() => {
              if (onOpenActiveFileDiff) {
                onOpenActiveFileDiff();
              } else if (activeFilePath) {
                onOpenDiff(activeFilePath, diffScope);
              } else if (changedFiles[0]) {
                onOpenDiff(changedFiles[0].path, diffScope);
              }
            }}
            style={smallBtnStyle}
          >
            Open Diff {formatShortcut("toggle-diff", platform)}
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title={`Hide (${formatShortcut("tool-git", platform)})`}
              style={smallBtnStyle}
            >
              ×
            </button>
          )}
        </div>
      </div>

      {/* Sub-tab 1: Changes */}
      {subTab === "changes" && (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "5px 8px",
              borderBottom: "1px solid var(--faint, #27326b)",
              background: "var(--screen, #0a0f2c)",
              gap: "8px",
            }}
          >
            <div style={{ display: "inline-flex", gap: "4px" }}>
              <button
                type="button"
                onClick={() => onChangeDiffScope({ kind: "branch", baseRef: activeWorktree.baseRef })}
                style={{
                  ...smallBtnStyle,
                  background:
                    diffScope.kind === "branch"
                      ? "var(--ink, #f4f6ff)"
                      : "var(--paper, #05081a)",
                  color:
                    diffScope.kind === "branch"
                      ? "var(--knock, #05081a)"
                      : "var(--dim, #93a3de)",
                  fontWeight: diffScope.kind === "branch" ? 700 : 400,
                }}
              >
                Branch vs {activeWorktree.baseRef || "base"}
              </button>
              <button
                type="button"
                onClick={() => onChangeDiffScope({ kind: "working" })}
                style={{
                  ...smallBtnStyle,
                  background:
                    diffScope.kind === "working"
                      ? "var(--ink, #f4f6ff)"
                      : "var(--paper, #05081a)",
                  color:
                    diffScope.kind === "working"
                      ? "var(--knock, #05081a)"
                      : "var(--dim, #93a3de)",
                  fontWeight: diffScope.kind === "working" ? 700 : 400,
                }}
              >
                Working Tree
              </button>
            </div>
            <span style={{ color: "var(--dim, #93a3de)", fontSize: "11px" }}>
              {diffScope.kind === "branch"
                ? `merge-base(${activeWorktree.baseRef}) ↔ working tree`
                : diffScope.kind === "working"
                  ? "HEAD ↔ working tree"
                  : diffScope.kind === "commit"
                    ? `commit ${diffScope.sha.slice(0, 7)}`
                    : `compare ↔ ${diffScope.otherWorktreePath.split("/").pop()}`}
            </span>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
            {changedFiles.length === 0 ? (
              <div style={{ padding: "12px 10px", color: "var(--safe, #6dffa6)" }}>
                Working scope is clean — no changed files.
              </div>
            ) : (
              changedFiles.map((file) => {
                const badge = getStatusBadge(file.status);
                return (
                  <button
                    key={`${file.status}:${file.path}`}
                    type="button"
                    onClick={() => onOpenDiff(file.path, diffScope)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "8px",
                      width: "100%",
                      textAlign: "left",
                      padding: "3px 10px",
                      background:
                        file.path === activeFilePath ? "var(--wash-hi, #111943)" : "transparent",
                      border: "none",
                      color: "var(--ink, #f4f6ff)",
                      fontFamily: "inherit",
                      fontSize: "12px",
                      cursor: "pointer",
                    }}
                  >
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "8px",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <span
                        style={{
                          color: badge?.color ?? "var(--dim, #93a3de)",
                          fontWeight: 700,
                          width: "10px",
                        }}
                      >
                        {badge?.glyph ?? "~"}
                      </span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                        {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                      </span>
                      {file.staged && (
                        <span
                          style={{
                            fontSize: "10px",
                            color: "var(--dim, #93a3de)",
                            border: "1px solid var(--faint, #27326b)",
                            padding: "0 3px",
                          }}
                        >
                          STAGED
                        </span>
                      )}
                    </span>

                    <span style={{ display: "inline-flex", gap: "6px", flexShrink: 0, fontSize: "11px" }}>
                      <span style={{ color: "var(--safe, #6dffa6)" }}>+{file.additions}</span>
                      <span style={{ color: "var(--unsafe, #ff5d4d)" }}>-{file.deletions}</span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* Sub-tab 2: Worktrees */}
      {subTab === "worktrees" && (
        <div style={{ flex: 1, overflow: "auto", padding: "6px 8px" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "12px",
            }}
          >
            <thead>
              <tr
                style={{
                  borderBottom: "1px solid var(--faint, #27326b)",
                  color: "var(--dim, #93a3de)",
                  textAlign: "left",
                }}
              >
                <th style={thStyle}>Worktree</th>
                <th style={thStyle}>Branch</th>
                <th style={thStyle}>Base</th>
                <th style={thStyle}>HEAD</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Activity</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {worktrees.map((wt) => {
                const isCurrent = wt.path === activeWorktree.path;
                const isLive = now - wt.lastActivityAt < 8000;
                return (
                  <tr
                    key={wt.path}
                    style={{
                      borderBottom: "1px solid var(--faint, #27326b)",
                      background: isCurrent ? "var(--wash-hi, #111943)" : "transparent",
                    }}
                  >
                    <td style={tdStyle}>
                      <strong>{isCurrent ? `■ ${wt.name}` : wt.name}</strong>
                    </td>
                    <td style={tdStyle}>
                      {wt.branch}
                      {wt.ahead > 0 ? ` ↑${wt.ahead}` : ""}
                      {wt.behind > 0 ? ` ↓${wt.behind}` : ""}
                    </td>
                    <td style={{ ...tdStyle, color: "var(--dim, #93a3de)" }}>{wt.baseRef}</td>
                    <td style={{ ...tdStyle, color: "var(--syn-type, #7ea0ff)" }}>
                      {wt.headSha.slice(0, 7)}
                    </td>
                    <td style={tdStyle}>
                      <span style={{ color: "var(--unknown, #ffe45c)" }}>
                        ~{wt.counts.modified}
                      </span>{" "}
                      <span style={{ color: "var(--safe, #6dffa6)" }}>
                        +{wt.counts.added + wt.counts.untracked}
                      </span>{" "}
                      <span style={{ color: "var(--unsafe, #ff5d4d)" }}>
                        -{wt.counts.deleted}
                      </span>
                    </td>
                    <td
                      style={{
                        ...tdStyle,
                        color: isLive ? "var(--unknown, #ffe45c)" : "var(--dim, #93a3de)",
                      }}
                    >
                      {isLive ? "▣ active" : formatRelativeActivity(wt.lastActivityAt, now)}
                    </td>
                    <td style={tdStyle}>
                      <div style={{ display: "inline-flex", gap: "4px" }}>
                        {!isCurrent && (
                          <>
                            <button
                              type="button"
                              onClick={() => onSwitchWorktree(wt.path)}
                              style={smallBtnStyle}
                            >
                              Switch
                            </button>
                            <button
                              type="button"
                              onClick={() => onCompareWorktrees(wt.path)}
                              style={smallBtnStyle}
                            >
                              Compare with Current
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          onClick={() => void onCopyText(`cd "${wt.path.replace(/"/g, '\\"')}"`)}
                          style={smallBtnStyle}
                        >
                          Copy cd command
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Sub-tab 3: Log */}
      {subTab === "log" && (
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <div
            style={{
              flex: selectedCommit ? "1 1 58%" : "1 1 100%",
              overflowY: "auto",
              borderRight: selectedCommit ? "1px solid var(--faint, #27326b)" : "none",
            }}
          >
            {commits.length === 0 ? (
              <div style={{ padding: "12px 10px", color: "var(--dim, #93a3de)" }}>
                No commits loaded.
              </div>
            ) : (
              commits.map((commit) => {
                const isSelected = selectedCommit?.sha === commit.sha;
                return (
                  <button
                    key={commit.sha}
                    type="button"
                    onClick={() => void handleSelectCommit(commit)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "8px",
                      width: "100%",
                      textAlign: "left",
                      padding: "4px 10px",
                      background: isSelected ? "var(--ink, #f4f6ff)" : "transparent",
                      color: isSelected ? "var(--knock, #05081a)" : "var(--ink, #f4f6ff)",
                      border: "none",
                      borderBottom: "1px solid var(--faint, #27326b)",
                      fontFamily: "inherit",
                      fontSize: "12px",
                      cursor: "pointer",
                    }}
                  >
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "8px",
                        overflow: "hidden",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <span
                        style={{
                          color: isSelected ? "var(--knock, #05081a)" : "var(--syn-type, #7ea0ff)",
                          fontWeight: 700,
                        }}
                      >
                        {commit.shortSha}
                      </span>
                      {commit.refs.map((r) => (
                        <span
                          key={r}
                          style={{
                            fontSize: "10px",
                            padding: "0 4px",
                            border: isSelected
                              ? "1px solid var(--knock, #05081a)"
                              : "1px solid var(--sky, #3d6bff)",
                            color: isSelected ? "var(--knock, #05081a)" : "var(--sky, #3d6bff)",
                          }}
                        >
                          {r}
                        </span>
                      ))}
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                        {commit.subject}
                      </span>
                    </span>
                    <span
                      style={{
                        flexShrink: 0,
                        fontSize: "11px",
                        color: isSelected ? "var(--knock, #05081a)" : "var(--dim, #93a3de)",
                      }}
                    >
                      {commit.author} · {commit.relativeTime}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          {selectedCommit && (
            <div
              style={{
                flex: "1 1 42%",
                display: "flex",
                flexDirection: "column",
                minWidth: 0,
                background: "var(--screen, #0a0f2c)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "4px 8px",
                  borderBottom: "1px solid var(--faint, #27326b)",
                  fontSize: "11px",
                }}
              >
                <span>
                  Commit <strong>{selectedCommit.shortSha}</strong> changed files
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedCommit(null)}
                  style={smallBtnStyle}
                >
                  ×
                </button>
              </div>
              <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
                {loadingCommit ? (
                  <div style={{ padding: "8px", color: "var(--dim, #93a3de)" }}>
                    Loading commit changes...
                  </div>
                ) : commitFiles.length === 0 ? (
                  <div style={{ padding: "8px", color: "var(--dim, #93a3de)" }}>
                    No file changes found in commit.
                  </div>
                ) : (
                  commitFiles.map((file) => {
                    const badge = getStatusBadge(file.status);
                    return (
                      <button
                        key={file.path}
                        type="button"
                        onClick={() =>
                          onOpenDiff(file.path, { kind: "commit", sha: selectedCommit.sha })
                        }
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          width: "100%",
                          textAlign: "left",
                          padding: "3px 8px",
                          background: "transparent",
                          border: "none",
                          color: "var(--ink, #f4f6ff)",
                          fontFamily: "inherit",
                          fontSize: "12px",
                          cursor: "pointer",
                        }}
                      >
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          <span style={{ color: badge?.color ?? "var(--dim, #93a3de)", marginRight: "6px" }}>
                            {badge?.glyph ?? "~"}
                          </span>
                          {file.path}
                        </span>
                        <span style={{ fontSize: "11px", flexShrink: 0 }}>
                          <span style={{ color: "var(--safe, #6dffa6)" }}>+{file.additions}</span>{" "}
                          <span style={{ color: "var(--unsafe, #ff5d4d)" }}>-{file.deletions}</span>
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
};

const thStyle: React.CSSProperties = {
  padding: "4px 6px",
  fontWeight: 600,
};

const tdStyle: React.CSSProperties = {
  padding: "5px 6px",
  whiteSpace: "nowrap",
};

/* -------------------------------------------------------------------------- */
/* 4. AnnotationsToolWindow (6: Annotations)                                  */
/* -------------------------------------------------------------------------- */

export interface AnnotationsToolWindowProps {
  worktree: WorktreeInfo;
  annotations: readonly Annotation[];
  platform: Platform;
  onJumpToAnnotation: (annotation: Annotation) => void;
  onSaveWorktreeNote: (comment: string, existingNote?: Annotation) => Promise<void> | void;
  onUpdateAnnotationStatus: (id: string, status: AnnotationStatus) => Promise<void> | void;
  onDeleteAnnotation: (id: string) => Promise<void> | void;
  onCopyFeedbackPrompt: (options: ExportPromptOptions) => Promise<void> | void;
  onClose?: () => void;
}

const INTENT_COLORS: Record<AnnotationIntent, string> = {
  bug: "var(--unsafe, #ff5d4d)",
  change: "var(--unknown, #ffe45c)",
  question: "var(--unknown, #ffe45c)",
  keep: "var(--safe, #6dffa6)",
};

export const AnnotationsToolWindow: React.FC<AnnotationsToolWindowProps> = ({
  worktree,
  annotations,
  platform,
  onJumpToAnnotation,
  onSaveWorktreeNote,
  onUpdateAnnotationStatus,
  onDeleteAnnotation,
  onCopyFeedbackPrompt,
  onClose,
}) => {
  const [statusFilter, setStatusFilter] = useState<AnnotationStatus | "all">("open");
  const [previewExpanded, setPreviewExpanded] = useState<boolean>(false);
  const [resolveOnCopy, setResolveOnCopy] = useState<boolean>(false);
  const [copiedNotice, setCopiedNotice] = useState<boolean>(false);

  const worktreeAnnotations = useMemo(
    () => annotations.filter((a) => a.worktreePath === worktree.path),
    [annotations, worktree.path],
  );

  const generalNote = useMemo(
    () => worktreeAnnotations.find((a) => !a.filePath && a.status !== "resolved"),
    [worktreeAnnotations],
  );

  const [noteDraft, setNoteDraft] = useState<string>(generalNote?.comment ?? "");
  useEffect(() => {
    setNoteDraft(generalNote?.comment ?? "");
  }, [generalNote?.id, generalNote?.comment, worktree.path]);

  const filteredList = useMemo(() => {
    return worktreeAnnotations.filter((a) => {
      if (!a.filePath) return false;
      if (statusFilter !== "all" && a.status !== statusFilter) return false;
      return true;
    });
  }, [worktreeAnnotations, statusFilter]);

  const compiled = useMemo(
    () =>
      compileFeedbackPromptMarkdown({
        worktree,
        annotations: worktreeAnnotations,
        includeOutdated: false,
      }),
    [worktree, worktreeAnnotations],
  );

  const handleCopyPrompt = async () => {
    await onCopyFeedbackPrompt({
      worktreePath: worktree.path,
      resolveAfterExport: resolveOnCopy,
    });
    setCopiedNotice(true);
    window.setTimeout(() => setCopiedNotice(false), 1800);
  };

  return (
    <section
      className="ide2-tool-window ide2-annotations-tool"
      aria-label="Annotations Tool Window"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--paper, #05081a)",
        color: "var(--ink, #f4f6ff)",
        fontFamily: "var(--mono, 'Kode Mono', monospace)",
        fontSize: "12px",
      }}
    >
      <div style={toolHeaderStyle}>
        <span>┌─ 6 ANNOTATIONS ({worktree.name})</span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title={`Hide (${formatShortcut("tool-annotations", platform)})`}
            style={smallBtnStyle}
          >
            ×
          </button>
        )}
      </div>

      {/* Overall Worktree Instructions */}
      <div
        style={{
          padding: "8px",
          borderBottom: "1px solid var(--faint, #27326b)",
          background: "var(--screen, #0a0f2c)",
          display: "flex",
          flexDirection: "column",
          gap: "6px",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ color: "var(--dim, #93a3de)", fontSize: "11px", fontWeight: 700 }}>
            OVERALL WORKTREE INSTRUCTIONS
          </span>
          <button
            type="button"
            onClick={() => void onSaveWorktreeNote(noteDraft, generalNote)}
            style={smallBtnStyle}
          >
            Save Note
          </button>
        </div>
        <textarea
          rows={2}
          value={noteDraft}
          onChange={(e) => setNoteDraft(e.target.value)}
          placeholder="High-level guidance for the coding agent on this worktree..."
          style={{
            ...searchInputStyle,
            resize: "vertical",
            minHeight: "42px",
          }}
        />
      </div>

      {/* Status Filter Bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "4px",
          padding: "6px 8px",
          borderBottom: "1px solid var(--faint, #27326b)",
        }}
      >
        {(["open", "outdated", "resolved", "all"] as const).map((status) => {
          const isActive = statusFilter === status;
          const count = worktreeAnnotations.filter((a) =>
            Boolean(a.filePath) && (status === "all" || a.status === status),
          ).length;
          return (
            <button
              key={status}
              type="button"
              onClick={() => setStatusFilter(status)}
              style={{
                ...smallBtnStyle,
                background: isActive ? "var(--ink, #f4f6ff)" : "var(--screen, #0a0f2c)",
                color: isActive ? "var(--knock, #05081a)" : "var(--dim, #93a3de)",
                fontWeight: isActive ? 700 : 400,
                textTransform: "capitalize",
              }}
            >
              {status} ({count})
            </button>
          );
        })}
      </div>

      {/* Annotation List */}
      <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
        {filteredList.length === 0 ? (
          <div style={{ padding: "12px 10px", color: "var(--dim, #93a3de)" }}>
            No {statusFilter === "all" ? "" : statusFilter} file annotations in {worktree.name}.
            <br />
            Press {formatShortcut("annotate", platform)} on any line to annotate.
          </div>
        ) : (
          filteredList.map((ann) => (
            <div
              key={ann.id}
              style={{
                padding: "6px 8px",
                borderBottom: "1px solid var(--faint, #27326b)",
                opacity: ann.status === "resolved" ? 0.6 : 1,
                display: "flex",
                flexDirection: "column",
                gap: "4px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px" }}>
                <button
                  type="button"
                  onClick={() => onJumpToAnnotation(ann)}
                  style={{
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    color: "var(--ink, #f4f6ff)",
                    fontFamily: "inherit",
                    fontSize: "12px",
                    cursor: "pointer",
                    textAlign: "left",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  <span style={{ color: INTENT_COLORS[ann.intent], fontWeight: 700 }}>
                    [{ann.intent.toUpperCase()}]
                  </span>
                  <span>
                    {ann.filePath}
                    {ann.startLine ? `:${ann.startLine}` : ""}
                  </span>
                </button>

                <div style={{ display: "inline-flex", gap: "4px", flexShrink: 0 }}>
                  {ann.status !== "resolved" ? (
                    <button
                      type="button"
                      onClick={() => void onUpdateAnnotationStatus(ann.id, "resolved")}
                      style={smallBtnStyle}
                    >
                      Resolve
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void onUpdateAnnotationStatus(ann.id, "open")}
                      style={smallBtnStyle}
                    >
                      Reopen
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void onDeleteAnnotation(ann.id)}
                    title="Delete annotation"
                    style={smallBtnStyle}
                  >
                    ×
                  </button>
                </div>
              </div>
              <div style={{ color: "var(--dim, #93a3de)", fontSize: "11px", whiteSpace: "pre-wrap" }}>
                {ann.comment}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Collapsible Live Prompt Preview + Copy Footer */}
      <div
        style={{
          borderTop: "1px solid var(--faint, #27326b)",
          background: "var(--screen, #0a0f2c)",
          padding: "8px",
          display: "flex",
          flexDirection: "column",
          gap: "6px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
          <button
            type="button"
            onClick={() => setPreviewExpanded((v) => !v)}
            style={smallBtnStyle}
          >
            {previewExpanded ? "▾ Hide" : "▸ Preview"} Markdown Prompt ({compiled.includedIds.length})
          </button>

          <label style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "11px", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={resolveOnCopy}
              onChange={(e) => setResolveOnCopy(e.target.checked)}
            />
            <span>Resolve annotations on copy</span>
          </label>
        </div>

        {previewExpanded && (
          <pre
            style={{
              margin: 0,
              maxHeight: "160px",
              overflow: "auto",
              padding: "6px",
              background: "var(--paper, #05081a)",
              border: "1px solid var(--faint, #27326b)",
              fontSize: "11px",
              whiteSpace: "pre-wrap",
              color: "var(--ink, #f4f6ff)",
            }}
          >
            {compiled.markdown || "(No open annotations yet)"}
          </pre>
        )}

        <button
          type="button"
          onClick={() => void handleCopyPrompt()}
          disabled={compiled.includedIds.length === 0}
          style={{
            background: "var(--ink, #f4f6ff)",
            color: "var(--knock, #05081a)",
            border: "1px solid var(--ink, #f4f6ff)",
            padding: "5px 10px",
            fontFamily: "inherit",
            fontSize: "12px",
            fontWeight: 700,
            cursor: compiled.includedIds.length === 0 ? "not-allowed" : "pointer",
            opacity: compiled.includedIds.length === 0 ? 0.45 : 1,
          }}
        >
          {copiedNotice
            ? "Copied Feedback Prompt!"
            : `Copy Feedback Prompt (${formatShortcut("copy-feedback-prompt", platform)})`}
        </button>
      </div>
    </section>
  );
};

/* -------------------------------------------------------------------------- */
/* 5. UsagesToolWindow (Alt+F7 / Cmd+B Multiple Hits)                         */
/* -------------------------------------------------------------------------- */

export interface UsagesToolWindowProps {
  symbolName: string;
  definitions: readonly SearchMatch[];
  usages: readonly SearchMatch[];
  platform: Platform;
  onJumpToMatch: (match: SearchMatch) => void;
  onClose?: () => void;
}

function groupMatchesByFile(matches: readonly SearchMatch[]): Array<{ filePath: string; items: SearchMatch[] }> {
  const map = new Map<string, SearchMatch[]>();
  for (const m of matches) {
    const existing = map.get(m.filePath);
    if (existing) existing.push(m);
    else map.set(m.filePath, [m]);
  }
  return Array.from(map.entries()).map(([filePath, items]) => ({ filePath, items }));
}

export const UsagesToolWindow: React.FC<UsagesToolWindowProps> = ({
  symbolName,
  definitions,
  usages,
  platform,
  onJumpToMatch,
  onClose,
}) => {
  const defGroups = useMemo(() => groupMatchesByFile(definitions), [definitions]);
  const usageGroups = useMemo(() => groupMatchesByFile(usages), [usages]);

  const renderMatchButton = (match: SearchMatch, idx: number, badge?: string) => {
    const before = match.lineText.slice(0, match.matchStart);
    const hit = match.lineText.slice(match.matchStart, match.matchEnd);
    const after = match.lineText.slice(match.matchEnd);

    return (
      <button
        key={`${match.filePath}:${match.line}:${match.column}:${idx}`}
        type="button"
        onClick={() => onJumpToMatch(match)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          width: "100%",
          textAlign: "left",
          padding: "2px 10px 2px 20px",
          background: "transparent",
          border: "none",
          color: "var(--ink, #f4f6ff)",
          fontFamily: "inherit",
          fontSize: "12px",
          cursor: "pointer",
          whiteSpace: "nowrap",
          overflow: "hidden",
        }}
      >
        <span style={{ color: "var(--dim, #93a3de)", minWidth: "40px", flexShrink: 0 }}>
          :{match.line}
        </span>
        {badge && (
          <span
            style={{
              fontSize: "10px",
              padding: "0 3px",
              border: "1px solid var(--sky, #3d6bff)",
              color: "var(--sky, #3d6bff)",
              flexShrink: 0,
            }}
          >
            {badge}
          </span>
        )}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
          <span>{before}</span>
          <mark
            style={{
              background: "var(--ink, #f4f6ff)",
              color: "var(--knock, #05081a)",
              padding: "0 1px",
            }}
          >
            {hit}
          </mark>
          <span>{after}</span>
        </span>
      </button>
    );
  };

  return (
    <section
      className="ide2-tool-window ide2-usages-tool"
      aria-label="Usages Tool Window"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--paper, #05081a)",
        color: "var(--ink, #f4f6ff)",
        fontFamily: "var(--mono, 'Kode Mono', monospace)",
        fontSize: "12px",
      }}
    >
      <div style={toolHeaderStyle}>
        <span>
          ┌─ USAGES OF `{symbolName}` ({definitions.length} def, {usages.length} usage)
        </span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title={`Close (${formatShortcut("escape", platform)})`}
            style={smallBtnStyle}
          >
            ×
          </button>
        )}
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
        {definitions.length === 0 && usages.length === 0 ? (
          <div style={{ padding: "12px 10px", color: "var(--dim, #93a3de)" }}>
            No definitions or usages found for `{symbolName}`.
          </div>
        ) : (
          <>
            {defGroups.map((grp) => (
              <div key={`def:${grp.filePath}`} style={{ marginBottom: "4px" }}>
                <div style={{ padding: "3px 8px", color: "var(--syn-type, #7ea0ff)", fontWeight: 700 }}>
                  ▸ {grp.filePath} ({grp.items.length} definition{grp.items.length === 1 ? "" : "s"})
                </div>
                {grp.items.map((m, i) => renderMatchButton(m, i, "DEF"))}
              </div>
            ))}

            {usageGroups.map((grp) => (
              <div key={`use:${grp.filePath}`} style={{ marginBottom: "4px" }}>
                <div style={{ padding: "3px 8px", color: "var(--dim, #93a3de)", fontWeight: 700 }}>
                  ▸ {grp.filePath} ({grp.items.length})
                </div>
                {grp.items.map((m, i) => renderMatchButton(m, i))}
              </div>
            ))}
          </>
        )}
      </div>
    </section>
  );
};
