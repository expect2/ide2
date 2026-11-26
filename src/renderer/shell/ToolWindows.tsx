import React, { useEffect, useMemo, useRef, useState } from "react";
import { compileFeedbackPromptMarkdown } from "../../shared/prompt-compiler.js";
import type {
  Annotation,
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
      return { glyph: "+", color: "var(--safe)", label: status };
    case "modified":
    case "renamed":
      return { glyph: "~", color: "var(--unknown)", label: status };
    case "deleted":
      return { glyph: "-", color: "var(--unsafe)", label: status };
    case "conflicted":
      return { glyph: "!", color: "var(--unsafe)", label: status };
    default:
      return null;
  }
}

const toolHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "8px",
  height: "34px",
  padding: "0 10px",
  background: "var(--wash)",
  borderBottom: "1px solid var(--faint)",
  fontFamily: "var(--ui-font)",
  fontSize: "12.5px",
  fontWeight: 600,
  color: "var(--ink)",
  flexShrink: 0,
  boxSizing: "border-box",
};

const headerTitleGroupStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "6px",
  minWidth: 0,
  overflow: "hidden",
};

const headerBadgeStyle: React.CSSProperties = {
  fontSize: "11px",
  fontWeight: 500,
  color: "var(--dim)",
  background: "var(--screen)",
  border: "1px solid var(--faint)",
  borderRadius: "4px",
  padding: "1px 6px",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const smallBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "4px",
  background: "transparent",
  border: "1px solid var(--faint)",
  color: "var(--dim)",
  padding: "2px 7px",
  height: "22px",
  fontFamily: "var(--ui-font)",
  fontSize: "11.5px",
  fontWeight: 500,
  cursor: "pointer",
  borderRadius: "5px",
  boxSizing: "border-box",
};

const activeSmallBtnStyle: React.CSSProperties = {
  ...smallBtnStyle,
  background: "var(--selection, #2e436e)",
  border: "1px solid rgba(61, 107, 255, 0.45)",
  color: "#ffffff",
  fontWeight: 600,
};

const searchInputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--screen)",
  border: "1px solid var(--border-strong)",
  color: "var(--ink)",
  padding: "5px 8px",
  fontFamily: "var(--ui-font)",
  fontSize: "12px",
  outline: "none",
  borderRadius: "6px",
};

/* -------------------------------------------------------------------------- */
/* 1. ProjectToolWindow (1: Project)                                          */
/* -------------------------------------------------------------------------- */

export interface ProjectToolWindowProps {
  worktreeName: string;
  files: readonly FileEntry[];
  activeFilePath?: string;
  locateRequest?: { filePath: string; seq: number } | null;
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
  locateRequest,
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

  const locateFilePath = (targetPath?: string) => {
    if (!targetPath) return;
    const parts = targetPath.split("/").filter(Boolean);
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
      const el = rowRefs.current.get(targetPath);
      el?.scrollIntoView({ block: "nearest" });
      el?.focus();
    }, 24);
  };

  const locateActiveFile = () => locateFilePath(activeFilePath);

  useEffect(() => {
    if (locateRequest?.filePath) {
      locateFilePath(locateRequest.filePath);
    }
  }, [locateRequest?.seq, locateRequest?.filePath]);

  return (
    <section
      className="ide2-tool-window ide2-project-tool"
      aria-label="Project Tool Window"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--wash)",
        color: "var(--ink)",
        fontFamily: "var(--ui-font)",
        fontSize: "12.5px",
      }}
    >
      <div style={toolHeaderStyle}>
        <span style={headerTitleGroupStyle}>
          <span>Project</span>
          <span style={headerBadgeStyle}>{worktreeName}</span>
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: "4px", flexShrink: 0 }}>
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
            style={compactFolders ? activeSmallBtnStyle : smallBtnStyle}
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

      <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--faint)" }}>
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
          <div style={{ padding: "12px 10px", color: "var(--dim)" }}>
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
                    width: "calc(100% - 8px)",
                    margin: "1px 4px",
                    height: "24px",
                    borderRadius: "5px",
                    textAlign: "left",
                    padding: "0 8px",
                    paddingLeft: `${8 + row.depth * 14}px`,
                    background: "transparent",
                    border: "none",
                    color: "var(--ink)",
                    fontFamily: "var(--ui-font)",
                    fontSize: "12.5px",
                    cursor: "pointer",
                    boxSizing: "border-box",
                  }}
                >
                  <span
                    style={{
                      width: "12px",
                      display: "inline-flex",
                      justifyContent: "center",
                      color: "var(--dim)",
                      fontSize: "10px",
                      flexShrink: 0,
                    }}
                  >
                    {row.isExpanded ? "▾" : "▸"}
                  </span>
                  <span
                    style={{
                      fontWeight: 500,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {row.name}
                  </span>
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
                  width: "calc(100% - 8px)",
                  margin: "1px 4px",
                  height: "24px",
                  borderRadius: "5px",
                  textAlign: "left",
                  padding: "0 8px",
                  paddingLeft: `${20 + row.depth * 14}px`,
                  background: isSelected ? "var(--selection, #2e436e)" : "transparent",
                  color: isSelected
                    ? "#ffffff"
                    : badge
                      ? badge.color
                      : "var(--ink)",
                  border: "none",
                  fontFamily: "var(--ui-font)",
                  fontSize: "12.5px",
                  cursor: "pointer",
                  fontWeight: isSelected ? 500 : 400,
                  boxSizing: "border-box",
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
                      fontFamily: "var(--mono)",
                      fontSize: "11px",
                      color: isSelected ? "#ffffff" : badge?.color ?? "var(--off)",
                      opacity: isSelected && !badge ? 0.4 : 1,
                      fontWeight: 700,
                      flexShrink: 0,
                    }}
                  >
                    {badge ? badge.glyph : "·"}
                  </span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                    {row.name}
                  </span>
                </span>

                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "5px",
                    flexShrink: 0,
                    fontFamily: "var(--mono)",
                    fontSize: "11px",
                  }}
                >
                  {annCount > 0 && (
                    <span style={{ color: isSelected ? "#b8d0ff" : "#7fa4ff" }}>
                      ◆{annCount}
                    </span>
                  )}
                  {row.entry?.additions !== undefined && row.entry.additions > 0 && (
                    <span style={{ color: isSelected ? "#a3f7c4" : "var(--safe)" }}>
                      +{row.entry.additions}
                    </span>
                  )}
                  {row.entry?.deletions !== undefined && row.entry.deletions > 0 && (
                    <span style={{ color: isSelected ? "#ffa096" : "var(--unsafe)" }}>
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
      return { tag: "fn", color: "var(--syn-decl)" };
    case "class":
      return { tag: "cls", color: "var(--syn-type)" };
    case "interface":
      return { tag: "ifc", color: "var(--syn-type)" };
    case "type":
    case "enum":
    case "module":
      return { tag: "typ", color: "var(--syn-kw)" };
    case "const":
    case "variable":
    case "property":
      return { tag: "cst", color: "var(--syn-lit)" };
    case "heading":
      return { tag: "#", color: "var(--sky)" };
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
              width: "calc(100% - 8px)",
              margin: "1px 4px",
              height: "24px",
              borderRadius: "5px",
              textAlign: "left",
              padding: "0 8px",
              paddingLeft: `${8 + depth * 14}px`,
              background: isCurrent ? "var(--selection, #2e436e)" : "transparent",
              color: isCurrent ? "#ffffff" : "var(--ink)",
              border: "none",
              fontFamily: "var(--ui-font)",
              fontSize: "12.5px",
              cursor: "pointer",
              fontWeight: isCurrent ? 500 : 400,
              boxSizing: "border-box",
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
                  fontFamily: "var(--mono)",
                  fontSize: "10px",
                  fontWeight: 600,
                  textAlign: "center",
                  padding: "0 4px",
                  borderRadius: "4px",
                  background: isCurrent ? "rgba(255, 255, 255, 0.14)" : "var(--screen)",
                  border: isCurrent
                    ? "1px solid rgba(255, 255, 255, 0.25)"
                    : "1px solid var(--faint)",
                  color: isCurrent ? "#ffffff" : badge.color,
                  flexShrink: 0,
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
                fontFamily: "var(--mono)",
                fontSize: "11px",
                color: isCurrent ? "rgba(255, 255, 255, 0.78)" : "var(--dim)",
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
        background: "var(--wash)",
        color: "var(--ink)",
        fontFamily: "var(--ui-font)",
        fontSize: "12.5px",
      }}
    >
      <div style={toolHeaderStyle}>
        <span style={headerTitleGroupStyle}>
          <span>Structure</span>
          {filePath && (
            <span style={headerBadgeStyle}>{filePath.split("/").pop()}</span>
          )}
        </span>
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

      <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--faint)" }}>
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
          <div style={{ padding: "12px 10px", color: "var(--dim)" }}>
            Open a file to inspect its AST structure.
          </div>
        ) : visibleSymbols.length === 0 ? (
          <div style={{ padding: "12px 10px", color: "var(--dim)" }}>
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
        background: "var(--wash)",
        color: "var(--ink)",
        fontFamily: "var(--ui-font)",
        fontSize: "12.5px",
      }}
    >
      <div style={toolHeaderStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
          <span style={headerTitleGroupStyle}>
            <span>Git</span>
            <span style={headerBadgeStyle}>{activeWorktree.name}</span>
          </span>
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
                    ...(isActive ? activeSmallBtnStyle : smallBtnStyle),
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

        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
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
            <span>Open Diff</span>
            <span style={{ fontFamily: "var(--mono)", fontSize: "10.5px", opacity: 0.8 }}>
              {formatShortcut("toggle-diff", platform)}
            </span>
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
              padding: "6px 10px",
              borderBottom: "1px solid var(--faint)",
              background: "var(--screen)",
              gap: "8px",
            }}
          >
            <div style={{ display: "inline-flex", gap: "4px" }}>
              <button
                type="button"
                onClick={() => onChangeDiffScope({ kind: "branch", baseRef: activeWorktree.baseRef })}
                style={diffScope.kind === "branch" ? activeSmallBtnStyle : smallBtnStyle}
              >
                Branch vs {activeWorktree.baseRef || "base"}
              </button>
              <button
                type="button"
                onClick={() => onChangeDiffScope({ kind: "working" })}
                style={diffScope.kind === "working" ? activeSmallBtnStyle : smallBtnStyle}
              >
                Working Tree
              </button>
            </div>
            <span style={{ color: "var(--dim)", fontFamily: "var(--mono)", fontSize: "11px" }}>
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
              <div style={{ padding: "12px 10px", color: "var(--safe)" }}>
                Working scope is clean — no changed files.
              </div>
            ) : (
              changedFiles.map((file) => {
                const badge = getStatusBadge(file.status);
                const isSelected = file.path === activeFilePath;
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
                      width: "calc(100% - 8px)",
                      margin: "1px 4px",
                      height: "24px",
                      borderRadius: "5px",
                      textAlign: "left",
                      padding: "0 8px",
                      background: isSelected ? "var(--selection, #2e436e)" : "transparent",
                      border: "none",
                      color: isSelected ? "#ffffff" : "var(--ink)",
                      fontFamily: "var(--ui-font)",
                      fontSize: "12.5px",
                      cursor: "pointer",
                      boxSizing: "border-box",
                    }}
                  >
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "7px",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <span
                        style={{
                          fontFamily: "var(--mono)",
                          fontSize: "11px",
                          color: isSelected ? "#ffffff" : badge?.color ?? "var(--dim)",
                          fontWeight: 700,
                          width: "10px",
                          flexShrink: 0,
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
                            fontWeight: 600,
                            color: isSelected ? "#ffffff" : "var(--dim)",
                            background: isSelected ? "rgba(255,255,255,0.16)" : "var(--screen)",
                            border: isSelected
                              ? "1px solid rgba(255,255,255,0.24)"
                              : "1px solid var(--faint)",
                            borderRadius: "4px",
                            padding: "0 4px",
                          }}
                        >
                          STAGED
                        </span>
                      )}
                    </span>

                    <span
                      style={{
                        display: "inline-flex",
                        gap: "6px",
                        flexShrink: 0,
                        fontFamily: "var(--mono)",
                        fontSize: "11px",
                      }}
                    >
                      <span style={{ color: isSelected ? "#a3f7c4" : "var(--safe)" }}>
                        +{file.additions}
                      </span>
                      <span style={{ color: isSelected ? "#ffa096" : "var(--unsafe)" }}>
                        -{file.deletions}
                      </span>
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
        <div style={{ flex: 1, overflow: "auto", padding: "6px 10px" }}>
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
                  borderBottom: "1px solid var(--faint)",
                  color: "var(--dim)",
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
                      borderBottom: "1px solid var(--faint)",
                      background: isCurrent ? "var(--selection, #2e436e)" : "transparent",
                      color: isCurrent ? "#ffffff" : "var(--ink)",
                    }}
                  >
                    <td style={tdStyle}>
                      <span style={{ fontWeight: isCurrent ? 600 : 500 }}>
                        {isCurrent ? `● ${wt.name}` : wt.name}
                      </span>
                    </td>
                    <td style={{ ...tdStyle, fontFamily: "var(--mono)", fontSize: "11.5px" }}>
                      {wt.branch}
                      {wt.ahead > 0 ? ` ↑${wt.ahead}` : ""}
                      {wt.behind > 0 ? ` ↓${wt.behind}` : ""}
                    </td>
                    <td
                      style={{
                        ...tdStyle,
                        fontFamily: "var(--mono)",
                        fontSize: "11.5px",
                        color: isCurrent ? "rgba(255, 255, 255, 0.78)" : "var(--dim)",
                      }}
                    >
                      {wt.baseRef}
                    </td>
                    <td
                      style={{
                        ...tdStyle,
                        fontFamily: "var(--mono)",
                        fontSize: "11.5px",
                        color: isCurrent ? "#b8d0ff" : "var(--syn-decl)",
                      }}
                    >
                      {wt.headSha.slice(0, 7)}
                    </td>
                    <td style={{ ...tdStyle, fontFamily: "var(--mono)", fontSize: "11.5px" }}>
                      <span style={{ color: "var(--unknown)" }}>~{wt.counts.modified}</span>{" "}
                      <span style={{ color: isCurrent ? "#a3f7c4" : "var(--safe)" }}>
                        +{wt.counts.added + wt.counts.untracked}
                      </span>{" "}
                      <span style={{ color: isCurrent ? "#ffa096" : "var(--unsafe)" }}>
                        -{wt.counts.deleted}
                      </span>
                    </td>
                    <td
                      style={{
                        ...tdStyle,
                        color: isLive
                          ? "var(--unknown)"
                          : isCurrent
                            ? "rgba(255, 255, 255, 0.78)"
                            : "var(--dim)",
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
                          style={
                            isCurrent
                              ? {
                                  ...smallBtnStyle,
                                  borderColor: "rgba(255, 255, 255, 0.25)",
                                  color: "#ffffff",
                                }
                              : smallBtnStyle
                          }
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
              padding: "4px 0",
              borderRight: selectedCommit ? "1px solid var(--faint)" : "none",
            }}
          >
            {commits.length === 0 ? (
              <div style={{ padding: "12px 10px", color: "var(--dim)" }}>
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
                      width: "calc(100% - 8px)",
                      margin: "1px 4px",
                      borderRadius: "5px",
                      textAlign: "left",
                      padding: "5px 8px",
                      background: isSelected ? "var(--selection, #2e436e)" : "transparent",
                      color: isSelected ? "#ffffff" : "var(--ink)",
                      border: "none",
                      fontFamily: "var(--ui-font)",
                      fontSize: "12.5px",
                      cursor: "pointer",
                      boxSizing: "border-box",
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
                          fontFamily: "var(--mono)",
                          fontSize: "11.5px",
                          color: isSelected ? "#b8d0ff" : "var(--syn-decl)",
                          fontWeight: 600,
                          flexShrink: 0,
                        }}
                      >
                        {commit.shortSha}
                      </span>
                      {commit.refs.map((r) => (
                        <span
                          key={r}
                          style={{
                            fontFamily: "var(--mono)",
                            fontSize: "10px",
                            padding: "0 5px",
                            borderRadius: "4px",
                            background: isSelected
                              ? "rgba(255, 255, 255, 0.16)"
                              : "var(--sky-bg)",
                            border: isSelected
                              ? "1px solid rgba(255, 255, 255, 0.25)"
                              : "1px solid rgba(61, 107, 255, 0.35)",
                            color: isSelected ? "#ffffff" : "#8cb4ff",
                            flexShrink: 0,
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
                        color: isSelected ? "rgba(255, 255, 255, 0.78)" : "var(--dim)",
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
                background: "var(--screen)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "6px 10px",
                  borderBottom: "1px solid var(--faint)",
                  fontSize: "12px",
                  color: "var(--dim)",
                }}
              >
                <span>
                  Commit{" "}
                  <strong style={{ fontFamily: "var(--mono)", color: "var(--ink)" }}>
                    {selectedCommit.shortSha}
                  </strong>{" "}
                  changed files
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
                  <div style={{ padding: "8px 10px", color: "var(--dim)" }}>
                    Loading commit changes...
                  </div>
                ) : commitFiles.length === 0 ? (
                  <div style={{ padding: "8px 10px", color: "var(--dim)" }}>
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
                          width: "calc(100% - 8px)",
                          margin: "1px 4px",
                          height: "24px",
                          borderRadius: "5px",
                          textAlign: "left",
                          padding: "0 8px",
                          background: "transparent",
                          border: "none",
                          color: "var(--ink)",
                          fontFamily: "var(--ui-font)",
                          fontSize: "12px",
                          cursor: "pointer",
                          boxSizing: "border-box",
                        }}
                      >
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          <span
                            style={{
                              fontFamily: "var(--mono)",
                              color: badge?.color ?? "var(--dim)",
                              marginRight: "6px",
                              fontWeight: 700,
                            }}
                          >
                            {badge?.glyph ?? "~"}
                          </span>
                          {file.path}
                        </span>
                        <span
                          style={{
                            fontFamily: "var(--mono)",
                            fontSize: "11px",
                            flexShrink: 0,
                          }}
                        >
                          <span style={{ color: "var(--safe)" }}>+{file.additions}</span>{" "}
                          <span style={{ color: "var(--unsafe)" }}>-{file.deletions}</span>
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
  padding: "6px 8px",
  fontWeight: 600,
  fontSize: "11.5px",
};

const tdStyle: React.CSSProperties = {
  padding: "6px 8px",
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
        background: "var(--wash)",
        color: "var(--ink)",
        fontFamily: "var(--ui-font)",
        fontSize: "12.5px",
      }}
    >
      <div style={toolHeaderStyle}>
        <span style={headerTitleGroupStyle}>
          <span>Annotations</span>
          <span style={headerBadgeStyle}>{worktree.name}</span>
        </span>
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
          padding: "10px",
          borderBottom: "1px solid var(--faint)",
          background: "var(--screen)",
          display: "flex",
          flexDirection: "column",
          gap: "6px",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ color: "var(--dim)", fontSize: "11.5px", fontWeight: 600 }}>
            Overall Worktree Instructions
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
            background: "var(--wash)",
            resize: "vertical",
            minHeight: "46px",
            lineHeight: 1.45,
          }}
        />
      </div>

      {/* Status Filter Bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "4px",
          padding: "7px 10px",
          borderBottom: "1px solid var(--faint)",
          flexWrap: "wrap",
        }}
      >
        {(["open", "outdated", "resolved", "all"] as const).map((status) => {
          const isActive = statusFilter === status;
          const count = worktreeAnnotations.filter(
            (a) => Boolean(a.filePath) && (status === "all" || a.status === status),
          ).length;
          return (
            <button
              key={status}
              type="button"
              onClick={() => setStatusFilter(status)}
              style={{
                ...(isActive ? activeSmallBtnStyle : smallBtnStyle),
                textTransform: "capitalize",
              }}
            >
              {status} ({count})
            </button>
          );
        })}
      </div>

      {/* Annotation List */}
      <div style={{ flex: 1, overflowY: "auto", padding: "6px 0" }}>
        {filteredList.length === 0 ? (
          <div style={{ padding: "12px 12px", color: "var(--dim)", lineHeight: 1.5 }}>
            No {statusFilter === "all" ? "" : statusFilter} file annotations in {worktree.name}.
            <br />
            Press{" "}
            <span style={{ fontFamily: "var(--mono)", color: "var(--ink)" }}>
              {formatShortcut("annotate", platform)}
            </span>{" "}
            on any line to annotate.
          </div>
        ) : (
          filteredList.map((ann) => {
            const lineLabel = ann.startLine
              ? ann.endLine && ann.endLine !== ann.startLine
                ? `:${ann.startLine}-${ann.endLine}`
                : `:${ann.startLine}`
              : "";
            return (
              <div
                key={ann.id}
                style={{
                  margin: "4px 8px",
                  padding: "8px 10px",
                  background: "var(--screen)",
                  border: "1px solid var(--faint)",
                  borderRadius: "6px",
                  opacity: ann.status === "resolved" ? 0.6 : 1,
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "6px",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => onJumpToAnnotation(ann)}
                    style={{
                      background: "transparent",
                      border: "none",
                      padding: 0,
                      color: "var(--ink)",
                      fontFamily: "var(--ui-font)",
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
                    <span
                      style={{
                        color: ann.status === "resolved" ? "var(--off)" : "var(--sky)",
                        fontSize: "11px",
                        flexShrink: 0,
                      }}
                    >
                      ◆
                    </span>
                    <span
                      style={{
                        fontFamily: "var(--mono)",
                        fontSize: "11.5px",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {ann.filePath}
                      {lineLabel}
                    </span>
                    {ann.status === "outdated" && (
                      <span
                        style={{
                          fontFamily: "var(--mono)",
                          fontSize: "10px",
                          fontWeight: 600,
                          color: "var(--unknown)",
                          background: "var(--unknown-bg)",
                          padding: "1px 5px",
                          borderRadius: "4px",
                          flexShrink: 0,
                        }}
                      >
                        OUTDATED
                      </span>
                    )}
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
                <div
                  style={{
                    color: "var(--dim)",
                    fontSize: "12px",
                    lineHeight: 1.45,
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {ann.comment}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Collapsible Live Prompt Preview + Copy Footer */}
      <div
        style={{
          borderTop: "1px solid var(--faint)",
          background: "var(--screen)",
          padding: "10px",
          display: "flex",
          flexDirection: "column",
          gap: "8px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "8px",
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            onClick={() => setPreviewExpanded((v) => !v)}
            style={previewExpanded ? activeSmallBtnStyle : smallBtnStyle}
          >
            {previewExpanded ? "▾ Hide" : "▸ Preview"} Markdown Prompt ({compiled.includedIds.length})
          </button>

          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "5px",
              fontSize: "11.5px",
              color: "var(--dim)",
              cursor: "pointer",
            }}
          >
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
              padding: "8px 10px",
              background: "var(--paper)",
              border: "1px solid var(--faint)",
              borderRadius: "6px",
              fontFamily: "var(--mono)",
              fontSize: "11.5px",
              lineHeight: 1.48,
              whiteSpace: "pre-wrap",
              color: "var(--ink)",
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
            background: copiedNotice ? "var(--safe)" : "var(--accent, #3574f0)",
            color: copiedNotice ? "var(--knock)" : "#ffffff",
            border: "none",
            borderRadius: "6px",
            padding: "7px 12px",
            fontFamily: "var(--ui-font)",
            fontSize: "12.5px",
            fontWeight: 600,
            cursor: compiled.includedIds.length === 0 ? "not-allowed" : "pointer",
            opacity: compiled.includedIds.length === 0 ? 0.45 : 1,
          }}
        >
          {copiedNotice ? (
            "Copied Feedback Prompt!"
          ) : (
            <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
              <span>Copy Feedback Prompt</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: "11px", opacity: 0.85 }}>
                {formatShortcut("copy-feedback-prompt", platform)}
              </span>
            </span>
          )}
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
  const [selectedMatchKey, setSelectedMatchKey] = useState<string | null>(null);

  const renderMatchButton = (match: SearchMatch, idx: number, badge?: string) => {
    const matchKey = `${match.filePath}:${match.line}:${match.column}:${idx}`;
    const isSelected = selectedMatchKey === matchKey;
    const before = match.lineText.slice(0, match.matchStart);
    const hit = match.lineText.slice(match.matchStart, match.matchEnd);
    const after = match.lineText.slice(match.matchEnd);

    return (
      <button
        key={matchKey}
        type="button"
        onClick={() => {
          setSelectedMatchKey(matchKey);
          onJumpToMatch(match);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          width: "calc(100% - 8px)",
          margin: "1px 4px",
          height: "24px",
          borderRadius: "5px",
          textAlign: "left",
          padding: "0 10px 0 22px",
          background: isSelected ? "var(--selection, #2e436e)" : "transparent",
          border: "none",
          color: isSelected ? "#ffffff" : "var(--ink)",
          fontFamily: "var(--mono)",
          fontSize: "12px",
          cursor: "pointer",
          whiteSpace: "nowrap",
          overflow: "hidden",
          boxSizing: "border-box",
        }}
      >
        <span
          style={{
            color: isSelected ? "rgba(255, 255, 255, 0.78)" : "var(--dim)",
            minWidth: "40px",
            flexShrink: 0,
            fontSize: "11px",
          }}
        >
          :{match.line}
        </span>
        {badge && (
          <span
            style={{
              fontSize: "10px",
              fontWeight: 600,
              padding: "0 5px",
              borderRadius: "4px",
              background: isSelected ? "rgba(255, 255, 255, 0.16)" : "var(--sky-bg)",
              border: isSelected
                ? "1px solid rgba(255, 255, 255, 0.25)"
                : "1px solid rgba(61, 107, 255, 0.35)",
              color: isSelected ? "#ffffff" : "#8cb4ff",
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
              background: isSelected ? "rgba(255, 228, 92, 0.28)" : "var(--unknown-bg-hi)",
              color: "var(--unknown)",
              padding: "0 2px",
              borderRadius: "3px",
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
        background: "var(--wash)",
        color: "var(--ink)",
        fontFamily: "var(--ui-font)",
        fontSize: "12.5px",
      }}
    >
      <div style={toolHeaderStyle}>
        <span style={headerTitleGroupStyle}>
          <span>Usages</span>
          <span style={{ ...headerBadgeStyle, fontFamily: "var(--mono)", color: "var(--ink)" }}>
            {symbolName}
          </span>
          <span style={{ color: "var(--dim)", fontSize: "11.5px", fontWeight: 400 }}>
            {definitions.length} def, {usages.length} usage
          </span>
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

      <div style={{ flex: 1, overflowY: "auto", padding: "6px 0" }}>
        {definitions.length === 0 && usages.length === 0 ? (
          <div style={{ padding: "12px 12px", color: "var(--dim)" }}>
            No definitions or usages found for{" "}
            <span style={{ fontFamily: "var(--mono)", color: "var(--ink)" }}>{symbolName}</span>.
          </div>
        ) : (
          <>
            {defGroups.map((grp) => (
              <div key={`def:${grp.filePath}`} style={{ marginBottom: "6px" }}>
                <div
                  style={{
                    padding: "4px 10px",
                    color: "var(--syn-decl)",
                    fontWeight: 600,
                    fontSize: "12px",
                  }}
                >
                  ▸ {grp.filePath}{" "}
                  <span style={{ color: "var(--dim)", fontWeight: 400 }}>
                    ({grp.items.length} definition{grp.items.length === 1 ? "" : "s"})
                  </span>
                </div>
                {grp.items.map((m, i) => renderMatchButton(m, i, "DEF"))}
              </div>
            ))}

            {usageGroups.map((grp) => (
              <div key={`use:${grp.filePath}`} style={{ marginBottom: "6px" }}>
                <div
                  style={{
                    padding: "4px 10px",
                    color: "var(--ink)",
                    fontWeight: 600,
                    fontSize: "12px",
                  }}
                >
                  ▸ {grp.filePath}{" "}
                  <span style={{ color: "var(--dim)", fontWeight: 400 }}>
                    ({grp.items.length})
                  </span>
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
