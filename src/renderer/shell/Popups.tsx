import React, { useEffect, useMemo, useRef, useState } from "react";
import { compileFeedbackPromptMarkdown } from "../../shared/prompt-compiler.js";
import type {
  Annotation,
  AnnotationIntent,
  CodeSymbol,
  ExportPromptOptions,
  FileDocument,
  FileGitStatus,
  FindInPathQuery,
  FuzzyFileHit,
  SearchMatch,
  WorktreeInfo,
} from "../../shared/protocol.js";
import {
  formatShortcut,
  IDE_ACTIONS,
  matchShortcut,
  type IdeAction,
  type Platform,
} from "./keymap.js";

/* -------------------------------------------------------------------------- */
/* Shared Popup Chrome                                                        */
/* -------------------------------------------------------------------------- */

const backdropStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(5, 8, 26, 0.72)",
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  paddingTop: "64px",
  zIndex: 1000,
};

const modalBoxStyle: React.CSSProperties = {
  background: "var(--wash, #0c1230)",
  border: "2px solid var(--ink, #f4f6ff)",
  boxShadow: "4px 4px 0 var(--sky, #3d6bff)",
  color: "var(--ink, #f4f6ff)",
  fontFamily: "var(--mono, 'Kode Mono', monospace)",
  fontSize: "12px",
  display: "flex",
  flexDirection: "column",
  borderRadius: 0,
};

const modalInputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--screen, #0a0f2c)",
  border: "1px solid var(--faint, #27326b)",
  color: "var(--ink, #f4f6ff)",
  padding: "7px 9px",
  fontFamily: "inherit",
  fontSize: "13px",
  outline: "none",
  borderRadius: 0,
};

const pillBtnStyle: React.CSSProperties = {
  background: "var(--screen, #0a0f2c)",
  border: "1px solid var(--faint, #27326b)",
  color: "var(--dim, #93a3de)",
  padding: "2px 7px",
  fontFamily: "inherit",
  fontSize: "11px",
  cursor: "pointer",
  borderRadius: 0,
};

/* -------------------------------------------------------------------------- */
/* 1. SearchEverywherePopup (Shift+Shift / Cmd+Shift+O / Cmd+Alt+O)          */
/* -------------------------------------------------------------------------- */

export type SearchEverywhereTab = "all" | "files" | "symbols" | "worktrees" | "actions";

export interface SearchEverywherePopupProps {
  open: boolean;
  initialTab?: SearchEverywhereTab;
  initialQuery?: string;
  activeWorktree: WorktreeInfo;
  worktrees: readonly WorktreeInfo[];
  platform: Platform;
  onSearchFiles: (params: {
    worktreePath: string;
    query: string;
    allWorktrees: boolean;
  }) => Promise<FuzzyFileHit[]>;
  onSearchSymbols: (params: {
    worktreePath: string;
    query: string;
    allWorktrees: boolean;
  }) => Promise<CodeSymbol[]>;
  onOpenFile: (worktreePath: string, filePath: string, line?: number, column?: number) => void;
  onSelectWorktree: (worktreePath: string) => void;
  onRunAction: (action: IdeAction) => void;
  onClose: () => void;
}

type SearchResultItem =
  | {
      kind: "file";
      key: string;
      title: string;
      subtitle: string;
      worktreePath: string;
      filePath: string;
      line?: number;
      column?: number;
      gitStatus?: FileGitStatus;
    }
  | {
      kind: "symbol";
      key: string;
      title: string;
      subtitle: string;
      symbol: CodeSymbol;
    }
  | {
      kind: "worktree";
      key: string;
      title: string;
      subtitle: string;
      worktree: WorktreeInfo;
    }
  | {
      kind: "action";
      key: string;
      title: string;
      subtitle: string;
      action: IdeAction;
      shortcut: string;
    };

function parseFileLineQuery(raw: string): { text: string; line?: number; column?: number } {
  const match = raw.match(/^(.*?):(\d+)(?::(\d+))?$/);
  if (!match) return { text: raw };
  return {
    text: match[1] ?? "",
    line: Number.parseInt(match[2]!, 10),
    column: match[3] ? Number.parseInt(match[3], 10) : undefined,
  };
}

const SE_TABS: readonly { id: SearchEverywhereTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "files", label: "Files" },
  { id: "symbols", label: "Symbols" },
  { id: "worktrees", label: "Worktrees" },
  { id: "actions", label: "Actions" },
];

export const SearchEverywherePopup: React.FC<SearchEverywherePopupProps> = ({
  open,
  initialTab = "all",
  initialQuery = "",
  activeWorktree,
  worktrees,
  platform,
  onSearchFiles,
  onSearchSymbols,
  onOpenFile,
  onSelectWorktree,
  onRunAction,
  onClose,
}) => {
  const [tab, setTab] = useState<SearchEverywhereTab>(initialTab);
  const [query, setQuery] = useState<string>(initialQuery);
  const [allWorktrees, setAllWorktrees] = useState<boolean>(false);
  const [fileHits, setFileHits] = useState<FuzzyFileHit[]>([]);
  const [symbolHits, setSymbolHits] = useState<CodeSymbol[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setQuery(initialQuery);
      setAllWorktrees(false);
      setSelectedIndex(0);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open, initialTab, initialQuery]);

  const parsed = useMemo(() => parseFileLineQuery(query.trim()), [query]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const cleanQuery = parsed.text;

    const run = async () => {
      const promises: Promise<void>[] = [];
      if (tab === "all" || tab === "files") {
        promises.push(
          onSearchFiles({
            worktreePath: activeWorktree.path,
            query: cleanQuery,
            allWorktrees,
          })
            .then((hits) => {
              if (!cancelled) setFileHits(hits);
            })
            .catch(() => {
              if (!cancelled) setFileHits([]);
            }),
        );
      } else {
        setFileHits([]);
      }

      if ((tab === "all" || tab === "symbols") && cleanQuery.length > 0) {
        promises.push(
          onSearchSymbols({
            worktreePath: activeWorktree.path,
            query: cleanQuery,
            allWorktrees,
          })
            .then((syms) => {
              if (!cancelled) setSymbolHits(syms);
            })
            .catch(() => {
              if (!cancelled) setSymbolHits([]);
            }),
        );
      } else {
        setSymbolHits([]);
      }

      await Promise.all(promises);
    };

    const timer = window.setTimeout(() => void run(), 45);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, tab, parsed.text, allWorktrees, activeWorktree.path, onSearchFiles, onSearchSymbols]);

  const items = useMemo<SearchResultItem[]>(() => {
    const q = parsed.text.toLowerCase();
    const out: SearchResultItem[] = [];

    if (tab === "all" || tab === "files") {
      for (const hit of fileHits.slice(0, tab === "all" ? 12 : 40)) {
        out.push({
          kind: "file",
          key: `file:${hit.worktreePath}:${hit.filePath}`,
          title: hit.filePath,
          subtitle: hit.worktreeName,
          worktreePath: hit.worktreePath,
          filePath: hit.filePath,
          line: parsed.line,
          column: parsed.column,
          gitStatus: hit.gitStatus,
        });
      }
    }

    if (tab === "all" || tab === "symbols") {
      for (const sym of symbolHits.slice(0, tab === "all" ? 10 : 40)) {
        out.push({
          kind: "symbol",
          key: `sym:${sym.worktreePath}:${sym.filePath}:${sym.startLine}:${sym.name}`,
          title: sym.name,
          subtitle: `${sym.kind} · ${sym.filePath}:${sym.startLine}`,
          symbol: sym,
        });
      }
    }

    if (tab === "all" || tab === "worktrees") {
      const matchedWts = worktrees.filter(
        (wt) =>
          !q ||
          wt.name.toLowerCase().includes(q) ||
          wt.branch.toLowerCase().includes(q),
      );
      for (const wt of matchedWts) {
        out.push({
          kind: "worktree",
          key: `wt:${wt.path}`,
          title: wt.name,
          subtitle: `${wt.branch} · ${wt.path}`,
          worktree: wt,
        });
      }
    }

    if (tab === "all" || tab === "actions") {
      const matchedActions = IDE_ACTIONS.filter(
        (a) =>
          !q ||
          a.label.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q) ||
          a.action.toLowerCase().includes(q),
      );
      for (const act of matchedActions.slice(0, tab === "all" ? 8 : 40)) {
        out.push({
          kind: "action",
          key: `act:${act.action}`,
          title: act.label,
          subtitle: act.description,
          action: act.action,
          shortcut: formatShortcut(act.action, platform),
        });
      }
    }

    return out;
  }, [tab, fileHits, symbolHits, worktrees, parsed.text, parsed.line, parsed.column, platform]);

  useEffect(() => {
    setSelectedIndex((prev) => (items.length === 0 ? 0 : Math.min(prev, items.length - 1)));
  }, [items.length]);

  if (!open) return null;

  const activateItem = (item: SearchResultItem) => {
    switch (item.kind) {
      case "file":
        onOpenFile(item.worktreePath, item.filePath, item.line, item.column);
        onClose();
        break;
      case "symbol":
        onOpenFile(item.symbol.worktreePath, item.symbol.filePath, item.symbol.startLine);
        onClose();
        break;
      case "worktree":
        onSelectWorktree(item.worktree.path);
        onClose();
        break;
      case "action":
        onClose();
        onRunAction(item.action);
        break;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const matched = matchShortcut(
      {
        key: e.key,
        code: e.code,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
      },
      platform,
    );
    // Double-tap Go to File / Go to Symbol expands scope to All Worktrees (JetBrains behavior)
    if (matched === "go-to-file" || matched === "go-to-symbol") {
      e.preventDefault();
      e.stopPropagation();
      setAllWorktrees((v) => !v);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const idx = SE_TABS.findIndex((t) => t.id === tab);
      const delta = e.shiftKey ? -1 : 1;
      const nextIdx = (idx + delta + SE_TABS.length) % SE_TABS.length;
      setTab(SE_TABS[nextIdx]!.id);
      setSelectedIndex(0);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (items.length > 0) setSelectedIndex((i) => (i + 1) % items.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length > 0) setSelectedIndex((i) => (i - 1 + items.length) % items.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const current = items[selectedIndex];
      if (current) activateItem(current);
    }
  };

  return (
    <div
      className="ide2-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Search Everywhere"
      onClick={onClose}
      style={backdropStyle}
    >
      <div
        className="ide2-popup ide2-search-everywhere"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        style={{
          ...modalBoxStyle,
          width: "680px",
          maxWidth: "94vw",
          maxHeight: "75vh",
        }}
      >
        {/* Tabs + Scope Pill */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "6px 8px",
            borderBottom: "1px solid var(--faint, #27326b)",
            background: "var(--paper, #05081a)",
            gap: "8px",
          }}
        >
          <div role="tablist" style={{ display: "inline-flex", gap: "4px" }}>
            {SE_TABS.map((t) => {
              const active = t.id === tab;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => {
                    setTab(t.id);
                    setSelectedIndex(0);
                  }}
                  style={{
                    ...pillBtnStyle,
                    background: active ? "var(--ink, #f4f6ff)" : "var(--screen, #0a0f2c)",
                    color: active ? "var(--knock, #05081a)" : "var(--dim, #93a3de)",
                    fontWeight: active ? 700 : 500,
                  }}
                >
                  {t.label}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => setAllWorktrees((v) => !v)}
            title={`Press ${formatShortcut("go-to-file", platform)} again to toggle scope`}
            style={{
              ...pillBtnStyle,
              borderColor: allWorktrees ? "var(--sky, #3d6bff)" : "var(--faint, #27326b)",
              color: allWorktrees ? "var(--ink, #f4f6ff)" : "var(--dim, #93a3de)",
            }}
          >
            {allWorktrees ? "[All Worktrees]" : `[Current Worktree: ${activeWorktree.name}]`}
          </button>
        </div>

        {/* Search Input */}
        <div style={{ padding: "8px", borderBottom: "1px solid var(--faint, #27326b)" }}>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            placeholder="Search files (e.g. session.ts:141), symbols, worktrees, or actions..."
            style={modalInputStyle}
          />
        </div>

        {/* Results */}
        <div style={{ flex: 1, overflowY: "auto", maxHeight: "420px" }}>
          {items.length === 0 ? (
            <div style={{ padding: "14px 12px", color: "var(--dim, #93a3de)" }}>
              No matches found.
            </div>
          ) : (
            items.map((item, idx) => {
              const selected = idx === selectedIndex;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => activateItem(item)}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "10px",
                    width: "100%",
                    textAlign: "left",
                    padding: "6px 10px",
                    background: selected ? "var(--ink, #f4f6ff)" : "transparent",
                    color: selected ? "var(--knock, #05081a)" : "var(--ink, #f4f6ff)",
                    border: "none",
                    borderBottom: "1px solid var(--faint, #27326b)",
                    fontFamily: "inherit",
                    fontSize: "12px",
                    cursor: "pointer",
                  }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                    <span
                      style={{
                        fontSize: "10px",
                        padding: "0 4px",
                        border: selected
                          ? "1px solid var(--knock, #05081a)"
                          : "1px solid var(--faint, #27326b)",
                        textTransform: "uppercase",
                        flexShrink: 0,
                      }}
                    >
                      {item.kind}
                    </span>
                    <span
                      style={{
                        fontWeight: 600,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {item.title}
                      {item.kind === "file" && item.line ? `:${item.line}` : ""}
                    </span>
                  </span>

                  <span
                    style={{
                      color: selected ? "var(--knock, #05081a)" : "var(--dim, #93a3de)",
                      fontSize: "11px",
                      flexShrink: 0,
                    }}
                  >
                    {item.kind === "action" ? item.shortcut : item.subtitle}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* 2. RecentFilesPopup (Cmd/Ctrl+E Switcher)                                  */
/* -------------------------------------------------------------------------- */

export interface RecentFileEntry {
  worktreePath: string;
  worktreeName: string;
  filePath: string;
  gitStatus?: FileGitStatus;
}

export interface RecentFilesPopupProps {
  open: boolean;
  worktrees: readonly WorktreeInfo[];
  activeWorktreePath: string;
  recentFiles: readonly RecentFileEntry[];
  platform: Platform;
  onOpenFile: (worktreePath: string, filePath: string) => void;
  onSelectWorktree: (worktreePath: string) => void;
  onRunAction: (action: IdeAction) => void;
  onClose: () => void;
}

type LeftSwitcherItem =
  | { kind: "tool"; key: string; label: string; action: IdeAction; shortcut: string }
  | { kind: "worktree"; key: string; label: string; worktree: WorktreeInfo };

export const RecentFilesPopup: React.FC<RecentFilesPopupProps> = ({
  open,
  worktrees,
  activeWorktreePath,
  recentFiles,
  platform,
  onOpenFile,
  onSelectWorktree,
  onRunAction,
  onClose,
}) => {
  const [column, setColumn] = useState<"left" | "right">("right");
  const [leftIdx, setLeftIdx] = useState<number>(0);
  const [rightIdx, setRightIdx] = useState<number>(0);
  const [filter, setFilter] = useState<string>("");
  const containerRef = useRef<HTMLDivElement | null>(null);

  const leftItems = useMemo<LeftSwitcherItem[]>(() => {
    const q = filter.trim().toLowerCase();
    const tools: LeftSwitcherItem[] = (
      [
        { action: "tool-project", label: "1: Project" },
        { action: "tool-annotations", label: "6: Annotations" },
        { action: "tool-structure", label: "7: Structure" },
        { action: "tool-git", label: "9: Git & Worktrees" },
        { action: "toggle-diff", label: "Diff Viewer" },
        { action: "export-prompt-preview", label: "Export Feedback Prompt" },
      ] as const
    )
      .filter((t) => !q || t.label.toLowerCase().includes(q))
      .map((t) => ({
        kind: "tool" as const,
        key: `tool:${t.action}`,
        label: t.label,
        action: t.action,
        shortcut: formatShortcut(t.action, platform),
      }));

    const wtItems: LeftSwitcherItem[] = worktrees
      .filter((w) => !q || w.name.toLowerCase().includes(q) || w.branch.toLowerCase().includes(q))
      .map((w) => ({
        kind: "worktree" as const,
        key: `wt:${w.path}`,
        label: `${w.path === activeWorktreePath ? "■ " : ""}${w.name} (${w.branch})`,
        worktree: w,
      }));

    return [...tools, ...wtItems];
  }, [filter, platform, worktrees, activeWorktreePath]);

  const filteredRecent = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return recentFiles.slice();
    return recentFiles.filter(
      (f) => f.filePath.toLowerCase().includes(q) || f.worktreeName.toLowerCase().includes(q),
    );
  }, [recentFiles, filter]);

  useEffect(() => {
    if (open) {
      setFilter("");
      setColumn(recentFiles.length > 0 ? "right" : "left");
      setLeftIdx(0);
      setRightIdx(0);
      window.setTimeout(() => containerRef.current?.focus(), 0);
    }
  }, [open, recentFiles.length]);

  if (!open) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "Tab" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      setColumn((c) => (c === "left" ? "right" : "left"));
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (column === "left" && leftItems.length > 0) {
        setLeftIdx((i) => (i + 1) % leftItems.length);
      } else if (column === "right" && filteredRecent.length > 0) {
        setRightIdx((i) => (i + 1) % filteredRecent.length);
      }
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (column === "left" && leftItems.length > 0) {
        setLeftIdx((i) => (i - 1 + leftItems.length) % leftItems.length);
      } else if (column === "right" && filteredRecent.length > 0) {
        setRightIdx((i) => (i - 1 + filteredRecent.length) % filteredRecent.length);
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (column === "left") {
        const item = leftItems[leftIdx];
        if (!item) return;
        onClose();
        if (item.kind === "tool") onRunAction(item.action);
        else onSelectWorktree(item.worktree.path);
      } else {
        const file = filteredRecent[rightIdx];
        if (!file) return;
        onOpenFile(file.worktreePath, file.filePath);
        onClose();
      }
    }
  };

  return (
    <div
      className="ide2-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Recent Files & Switcher"
      onClick={onClose}
      style={backdropStyle}
    >
      <div
        ref={containerRef}
        tabIndex={-1}
        className="ide2-popup ide2-recent-files"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        style={{
          ...modalBoxStyle,
          width: "660px",
          maxWidth: "94vw",
          maxHeight: "70vh",
          outline: "none",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "6px 10px",
            borderBottom: "1px solid var(--faint, #27326b)",
            background: "var(--paper, #05081a)",
            fontWeight: 700,
          }}
        >
          <span>SWITCHER ({formatShortcut("recent-files", platform)})</span>
          <input
            type="text"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setLeftIdx(0);
              setRightIdx(0);
            }}
            placeholder="Filter..."
            style={{
              ...modalInputStyle,
              width: "220px",
              padding: "2px 6px",
              fontSize: "12px",
            }}
          />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1.35fr", minHeight: "280px", maxHeight: "420px" }}>
          {/* Left Column: Tool Windows + Worktrees */}
          <div
            style={{
              borderRight: "1px solid var(--faint, #27326b)",
              overflowY: "auto",
              padding: "4px 0",
            }}
          >
            <div style={{ padding: "2px 10px", fontSize: "10px", color: "var(--dim, #93a3de)" }}>
              TOOL WINDOWS & WORKTREES
            </div>
            {leftItems.map((item, idx) => {
              const selected = column === "left" && idx === leftIdx;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => {
                    onClose();
                    if (item.kind === "tool") onRunAction(item.action);
                    else onSelectWorktree(item.worktree.path);
                  }}
                  onMouseEnter={() => {
                    setColumn("left");
                    setLeftIdx(idx);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    width: "100%",
                    textAlign: "left",
                    padding: "4px 10px",
                    background: selected ? "var(--ink, #f4f6ff)" : "transparent",
                    color: selected ? "var(--knock, #05081a)" : "var(--ink, #f4f6ff)",
                    border: "none",
                    fontFamily: "inherit",
                    fontSize: "12px",
                    cursor: "pointer",
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {item.label}
                  </span>
                  {item.kind === "tool" && (
                    <span
                      style={{
                        fontSize: "11px",
                        color: selected ? "var(--knock, #05081a)" : "var(--dim, #93a3de)",
                      }}
                    >
                      {item.shortcut}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Right Column: Recent Files */}
          <div style={{ overflowY: "auto", padding: "4px 0" }}>
            <div style={{ padding: "2px 10px", fontSize: "10px", color: "var(--dim, #93a3de)" }}>
              RECENT FILES
            </div>
            {filteredRecent.length === 0 ? (
              <div style={{ padding: "10px", color: "var(--dim, #93a3de)" }}>
                No recent files yet.
              </div>
            ) : (
              filteredRecent.map((file, idx) => {
                const selected = column === "right" && idx === rightIdx;
                return (
                  <button
                    key={`${file.worktreePath}:${file.filePath}`}
                    type="button"
                    onClick={() => {
                      onOpenFile(file.worktreePath, file.filePath);
                      onClose();
                    }}
                    onMouseEnter={() => {
                      setColumn("right");
                      setRightIdx(idx);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "8px",
                      width: "100%",
                      textAlign: "left",
                      padding: "4px 10px",
                      background: selected ? "var(--ink, #f4f6ff)" : "transparent",
                      color: selected ? "var(--knock, #05081a)" : "var(--ink, #f4f6ff)",
                      border: "none",
                      fontFamily: "inherit",
                      fontSize: "12px",
                      cursor: "pointer",
                    }}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {file.filePath}
                    </span>
                    <span
                      style={{
                        fontSize: "11px",
                        color: selected ? "var(--knock, #05081a)" : "var(--dim, #93a3de)",
                        flexShrink: 0,
                      }}
                    >
                      {file.worktreeName}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* 3. FindInPathPopup (Cmd/Ctrl+Shift+F)                                      */
/* -------------------------------------------------------------------------- */

export interface FindInPathPopupProps {
  open: boolean;
  activeWorktree: WorktreeInfo;
  platform: Platform;
  onSearch: (query: FindInPathQuery) => Promise<SearchMatch[]>;
  onLoadFilePreview?: (worktreePath: string, filePath: string) => Promise<FileDocument | null>;
  onSelectMatch: (match: SearchMatch) => void;
  onClose: () => void;
}

export const FindInPathPopup: React.FC<FindInPathPopupProps> = ({
  open,
  activeWorktree,
  platform,
  onSearch,
  onLoadFilePreview,
  onSelectMatch,
  onClose,
}) => {
  const [query, setQuery] = useState<string>("");
  const [caseSensitive, setCaseSensitive] = useState<boolean>(false);
  const [wholeWord, setWholeWord] = useState<boolean>(false);
  const [isRegex, setIsRegex] = useState<boolean>(false);
  const [fileMask, setFileMask] = useState<string>("");
  const [allWorktrees, setAllWorktrees] = useState<boolean>(false);
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [previewDoc, setPreviewDoc] = useState<FileDocument | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setMatches([]);
      setPreviewDoc(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void onSearch({
        worktreePath: activeWorktree.path,
        allWorktrees,
        query: trimmed,
        isRegex,
        caseSensitive,
        wholeWord,
        fileMask: fileMask.trim() || undefined,
        limit: 200,
      })
        .then((res) => {
          if (!cancelled) {
            setMatches(res);
            setSelectedIndex(0);
          }
        })
        .catch(() => {
          if (!cancelled) setMatches([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    open,
    query,
    caseSensitive,
    wholeWord,
    isRegex,
    fileMask,
    allWorktrees,
    activeWorktree.path,
    onSearch,
  ]);

  const activeMatch = matches[selectedIndex];

  useEffect(() => {
    if (!open || !activeMatch || !onLoadFilePreview) {
      setPreviewDoc(null);
      return;
    }
    let cancelled = false;
    void onLoadFilePreview(activeMatch.worktreePath, activeMatch.filePath)
      .then((doc) => {
        if (!cancelled) setPreviewDoc(doc);
      })
      .catch(() => {
        if (!cancelled) setPreviewDoc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, activeMatch?.worktreePath, activeMatch?.filePath, onLoadFilePreview]);

  const previewLines = useMemo(() => {
    if (!activeMatch) return [];
    if (!previewDoc) {
      return [{ lineNumber: activeMatch.line, text: activeMatch.lineText, isTarget: true }];
    }
    const start = Math.max(1, activeMatch.line - 3);
    const end = Math.min(previewDoc.lines.length, activeMatch.line + 3);
    const slice: Array<{ lineNumber: number; text: string; isTarget: boolean }> = [];
    for (let ln = start; ln <= end; ln++) {
      slice.push({
        lineNumber: ln,
        text: previewDoc.lines[ln - 1] ?? "",
        isTarget: ln === activeMatch.line,
      });
    }
    return slice;
  }, [activeMatch, previewDoc]);

  if (!open) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (matches.length > 0) setSelectedIndex((i) => (i + 1) % matches.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (matches.length > 0) setSelectedIndex((i) => (i - 1 + matches.length) % matches.length);
      return;
    }
    if (e.key === "Enter" && activeMatch) {
      e.preventDefault();
      onSelectMatch(activeMatch);
      onClose();
    }
  };

  return (
    <div
      className="ide2-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Find in Path"
      onClick={onClose}
      style={backdropStyle}
    >
      <div
        className="ide2-popup ide2-find-in-path"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        style={{
          ...modalBoxStyle,
          width: "820px",
          maxWidth: "95vw",
          height: "76vh",
        }}
      >
        {/* Header & Search Options */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            padding: "8px",
            borderBottom: "1px solid var(--faint, #27326b)",
            background: "var(--paper, #05081a)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
            <span style={{ fontWeight: 700 }}>
              FIND IN PATH ({formatShortcut("find-in-path", platform)})
            </span>
            <div style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
              <button
                type="button"
                aria-pressed={caseSensitive}
                onClick={() => setCaseSensitive((v) => !v)}
                title="Match Case"
                style={{
                  ...pillBtnStyle,
                  background: caseSensitive ? "var(--ink, #f4f6ff)" : "var(--screen, #0a0f2c)",
                  color: caseSensitive ? "var(--knock, #05081a)" : "var(--dim, #93a3de)",
                  fontWeight: caseSensitive ? 700 : 400,
                }}
              >
                Cc
              </button>
              <button
                type="button"
                aria-pressed={wholeWord}
                onClick={() => setWholeWord((v) => !v)}
                title="Whole Words"
                style={{
                  ...pillBtnStyle,
                  background: wholeWord ? "var(--ink, #f4f6ff)" : "var(--screen, #0a0f2c)",
                  color: wholeWord ? "var(--knock, #05081a)" : "var(--dim, #93a3de)",
                  fontWeight: wholeWord ? 700 : 400,
                }}
              >
                W
              </button>
              <button
                type="button"
                aria-pressed={isRegex}
                onClick={() => setIsRegex((v) => !v)}
                title="Regular Expression"
                style={{
                  ...pillBtnStyle,
                  background: isRegex ? "var(--ink, #f4f6ff)" : "var(--screen, #0a0f2c)",
                  color: isRegex ? "var(--knock, #05081a)" : "var(--dim, #93a3de)",
                  fontWeight: isRegex ? 700 : 400,
                }}
              >
                .*
              </button>
              <input
                type="text"
                value={fileMask}
                onChange={(e) => setFileMask(e.target.value)}
                placeholder="*.ts"
                aria-label="File mask"
                style={{
                  ...modalInputStyle,
                  width: "110px",
                  padding: "2px 6px",
                  fontSize: "11px",
                }}
              />
              <button
                type="button"
                aria-pressed={allWorktrees}
                onClick={() => setAllWorktrees((v) => !v)}
                style={{
                  ...pillBtnStyle,
                  background: allWorktrees ? "var(--ink, #f4f6ff)" : "var(--screen, #0a0f2c)",
                  color: allWorktrees ? "var(--knock, #05081a)" : "var(--dim, #93a3de)",
                  fontWeight: allWorktrees ? 700 : 400,
                }}
              >
                {allWorktrees ? "All Worktrees" : `Worktree: ${activeWorktree.name}`}
              </button>
            </div>
          </div>

          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search across files..."
            style={modalInputStyle}
          />
        </div>

        {/* Top: Match List */}
        <div style={{ flex: "1 1 55%", overflowY: "auto", borderBottom: "1px solid var(--faint, #27326b)" }}>
          {loading ? (
            <div style={{ padding: "12px", color: "var(--dim, #93a3de)" }}>Searching...</div>
          ) : matches.length === 0 ? (
            <div style={{ padding: "12px", color: "var(--dim, #93a3de)" }}>
              {query.trim() ? "No matches found." : "Type to search repository files."}
            </div>
          ) : (
            matches.map((m, idx) => {
              const selected = idx === selectedIndex;
              const before = m.lineText.slice(0, m.matchStart);
              const hit = m.lineText.slice(m.matchStart, m.matchEnd);
              const after = m.lineText.slice(m.matchEnd);

              return (
                <button
                  key={`${m.worktreePath}:${m.filePath}:${m.line}:${m.column}:${idx}`}
                  type="button"
                  onClick={() => {
                    onSelectMatch(m);
                    onClose();
                  }}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "12px",
                    width: "100%",
                    textAlign: "left",
                    padding: "4px 10px",
                    background: selected ? "var(--ink, #f4f6ff)" : "transparent",
                    color: selected ? "var(--knock, #05081a)" : "var(--ink, #f4f6ff)",
                    border: "none",
                    borderBottom: "1px solid var(--faint, #27326b)",
                    fontFamily: "inherit",
                    fontSize: "12px",
                    cursor: "pointer",
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    <span>{before}</span>
                    <mark
                      style={{
                        background: selected ? "var(--sky, #3d6bff)" : "var(--unknown, #ffe45c)",
                        color: selected ? "var(--ink, #f4f6ff)" : "var(--knock, #05081a)",
                        padding: "0 2px",
                      }}
                    >
                      {hit}
                    </mark>
                    <span>{after}</span>
                  </span>
                  <span
                    style={{
                      flexShrink: 0,
                      fontSize: "11px",
                      color: selected ? "var(--knock, #05081a)" : "var(--dim, #93a3de)",
                    }}
                  >
                    {allWorktrees ? `[${m.worktreeName}] ` : ""}
                    {m.filePath}:{m.line}
                  </span>
                </button>
              );
            })
          )}
        </div>

        {/* Bottom: Surrounding Line Preview */}
        <div
          style={{
            flex: "1 1 45%",
            overflow: "auto",
            background: "var(--screen, #0a0f2c)",
            padding: "8px",
          }}
        >
          {activeMatch ? (
            <>
              <div
                style={{
                  fontSize: "11px",
                  color: "var(--dim, #93a3de)",
                  marginBottom: "6px",
                  borderBottom: "1px solid var(--faint, #27326b)",
                  paddingBottom: "4px",
                }}
              >
                {activeMatch.worktreeName} · {activeMatch.filePath}:{activeMatch.line}:{activeMatch.column}
              </div>
              <pre style={{ margin: 0, fontFamily: "inherit", fontSize: "12px", lineHeight: 1.5 }}>
                {previewLines.map((ln) => (
                  <div
                    key={ln.lineNumber}
                    style={{
                      display: "flex",
                      gap: "10px",
                      padding: "0 4px",
                      background: ln.isTarget ? "var(--wash-hi, #111943)" : "transparent",
                    }}
                  >
                    <span
                      style={{
                        minWidth: "42px",
                        textAlign: "right",
                        color: ln.isTarget ? "var(--unknown, #ffe45c)" : "var(--dim, #93a3de)",
                        userSelect: "none",
                      }}
                    >
                      {ln.lineNumber}
                    </span>
                    <span style={{ whiteSpace: "pre" }}>{ln.text}</span>
                  </div>
                ))}
              </pre>
            </>
          ) : (
            <div style={{ color: "var(--dim, #93a3de)" }}>Select a match to preview context.</div>
          )}
        </div>
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* 4. GoToLinePopup (Cmd/Ctrl+L)                                              */
/* -------------------------------------------------------------------------- */

export interface GoToLinePopupProps {
  open: boolean;
  currentLine?: number;
  maxLine?: number;
  platform: Platform;
  onJump: (line: number, column?: number) => void;
  onClose: () => void;
}

export const GoToLinePopup: React.FC<GoToLinePopupProps> = ({
  open,
  currentLine,
  maxLine,
  platform,
  onJump,
  onClose,
}) => {
  const [value, setValue] = useState<string>("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setValue(currentLine ? String(currentLine) : "");
      window.setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
    }
  }, [open, currentLine]);

  if (!open) return null;

  const parsed = value.trim().match(/^(\d+)(?::(\d+))?$/);
  const lineNum = parsed ? Number.parseInt(parsed[1]!, 10) : null;
  const colNum = parsed?.[2] ? Number.parseInt(parsed[2], 10) : undefined;
  const valid = lineNum !== null && lineNum >= 1 && (!maxLine || lineNum <= maxLine);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || lineNum === null) return;
    onJump(lineNum, colNum);
    onClose();
  };

  return (
    <div
      className="ide2-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Go to Line:Column"
      onClick={onClose}
      style={backdropStyle}
    >
      <form
        className="ide2-popup ide2-goto-line"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        style={{
          ...modalBoxStyle,
          width: "340px",
          maxWidth: "92vw",
          padding: "10px",
          gap: "8px",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700 }}>
          <span>GO TO LINE:COLUMN ({formatShortcut("go-to-line", platform)})</span>
          {maxLine ? (
            <span style={{ color: "var(--dim, #93a3de)", fontWeight: 400 }}>1..{maxLine}</span>
          ) : null}
        </div>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="142 or 142:18"
          style={modalInputStyle}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "6px" }}>
          <button type="button" onClick={onClose} style={pillBtnStyle}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={!valid}
            style={{
              ...pillBtnStyle,
              background: "var(--ink, #f4f6ff)",
              color: "var(--knock, #05081a)",
              borderColor: "var(--ink, #f4f6ff)",
              fontWeight: 700,
              opacity: valid ? 1 : 0.45,
            }}
          >
            Jump
          </button>
        </div>
      </form>
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* 5. ExportPromptModal (Cmd/Ctrl+Shift+E)                                    */
/* -------------------------------------------------------------------------- */

export interface ExportPromptModalProps {
  open: boolean;
  worktree: WorktreeInfo;
  annotations: readonly Annotation[];
  platform: Platform;
  onCopyFeedbackPrompt: (options: ExportPromptOptions, compiledMarkdown: string) => Promise<void> | void;
  onClose: () => void;
}

const ALL_INTENTS: readonly { id: AnnotationIntent; label: string }[] = [
  { id: "bug", label: "BUG" },
  { id: "change", label: "CHANGE" },
  { id: "question", label: "QUESTION" },
  { id: "keep", label: "KEEP" },
];

export const ExportPromptModal: React.FC<ExportPromptModalProps> = ({
  open,
  worktree,
  annotations,
  platform,
  onCopyFeedbackPrompt,
  onClose,
}) => {
  const [selectedIntents, setSelectedIntents] = useState<AnnotationIntent[]>([
    "bug",
    "change",
    "question",
    "keep",
  ]);
  const [includeOutdated, setIncludeOutdated] = useState<boolean>(false);
  const [resolveAfterCopy, setResolveAfterCopy] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  useEffect(() => {
    if (open) {
      setCopied(false);
    }
  }, [open]);

  const compiled = useMemo(
    () =>
      compileFeedbackPromptMarkdown({
        worktree,
        annotations,
        includeOutdated,
        intents: selectedIntents,
      }),
    [worktree, annotations, includeOutdated, selectedIntents],
  );

  if (!open) return null;

  const toggleIntent = (intent: AnnotationIntent) => {
    setSelectedIntents((prev) =>
      prev.includes(intent) ? prev.filter((i) => i !== intent) : [...prev, intent],
    );
  };

  const handleCopy = async () => {
    if (!compiled.markdown) return;
    await onCopyFeedbackPrompt(
      {
        worktreePath: worktree.path,
        includeOutdated,
        intents: selectedIntents,
        resolveAfterExport: resolveAfterCopy,
      },
      compiled.markdown,
    );
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div
      className="ide2-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Export Feedback Prompt"
      onClick={onClose}
      style={backdropStyle}
    >
      <div
        className="ide2-popup ide2-export-prompt-modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        style={{
          ...modalBoxStyle,
          width: "780px",
          maxWidth: "95vw",
          height: "78vh",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "8px 10px",
            borderBottom: "1px solid var(--faint, #27326b)",
            background: "var(--paper, #05081a)",
          }}
        >
          <span style={{ fontWeight: 700 }}>
            FEEDBACK PROMPT PREVIEW — {worktree.name} ({compiled.includedIds.length} items)
          </span>
          <button type="button" onClick={onClose} style={pillBtnStyle}>
            Esc
          </button>
        </div>

        {/* Filters & Toggles */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "8px",
            padding: "8px 10px",
            borderBottom: "1px solid var(--faint, #27326b)",
            background: "var(--screen, #0a0f2c)",
          }}
        >
          <div style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
            <span style={{ color: "var(--dim, #93a3de)", fontSize: "11px", marginRight: "4px" }}>
              Intents:
            </span>
            {ALL_INTENTS.map((item) => {
              const active = selectedIntents.includes(item.id);
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleIntent(item.id)}
                  style={{
                    ...pillBtnStyle,
                    background: active ? "var(--ink, #f4f6ff)" : "var(--paper, #05081a)",
                    color: active ? "var(--knock, #05081a)" : "var(--dim, #93a3de)",
                    fontWeight: active ? 700 : 400,
                  }}
                >
                  {item.label}
                </button>
              );
            })}
          </div>

          <div style={{ display: "inline-flex", alignItems: "center", gap: "12px", fontSize: "11px" }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: "4px", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={includeOutdated}
                onChange={(e) => setIncludeOutdated(e.target.checked)}
              />
              <span>Include outdated</span>
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: "4px", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={resolveAfterCopy}
                onChange={(e) => setResolveAfterCopy(e.target.checked)}
              />
              <span>Mark resolved after copy</span>
            </label>
          </div>
        </div>

        {/* Markdown Preview */}
        <pre
          style={{
            flex: 1,
            margin: 0,
            padding: "12px",
            overflow: "auto",
            background: "var(--paper, #05081a)",
            color: "var(--ink, #f4f6ff)",
            fontFamily: "inherit",
            fontSize: "12px",
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
          }}
        >
          {compiled.markdown || "No matching annotations for the selected filters."}
        </pre>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "8px",
            padding: "8px 10px",
            borderTop: "1px solid var(--faint, #27326b)",
            background: "var(--screen, #0a0f2c)",
          }}
        >
          <button type="button" onClick={onClose} style={pillBtnStyle}>
            Close
          </button>
          <button
            type="button"
            disabled={!compiled.markdown}
            onClick={() => void handleCopy()}
            style={{
              ...pillBtnStyle,
              background: "var(--ink, #f4f6ff)",
              color: "var(--knock, #05081a)",
              borderColor: "var(--ink, #f4f6ff)",
              fontWeight: 700,
              padding: "4px 12px",
              opacity: compiled.markdown ? 1 : 0.45,
            }}
          >
            {copied
              ? "Copied to Clipboard!"
              : `Copy to Clipboard (${formatShortcut("copy-feedback-prompt", platform)})`}
          </button>
        </div>
      </div>
    </div>
  );
};
