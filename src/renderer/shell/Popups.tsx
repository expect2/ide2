import React, { useEffect, useMemo, useRef, useState } from "react";
import { compileFeedbackPromptMarkdown } from "../../shared/prompt-compiler.js";
import type {
  Annotation,
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
  background: "rgba(10, 12, 16, 0.62)",
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  paddingTop: "64px",
  zIndex: 1000,
};

const modalBoxStyle: React.CSSProperties = {
  background: "var(--wash)",
  border: "1px solid var(--border-strong)",
  borderRadius: "10px",
  boxShadow: "var(--shadow-modal)",
  overflow: "hidden",
  color: "var(--ink)",
  fontFamily: "var(--ui-font)",
  fontSize: "12.5px",
  display: "flex",
  flexDirection: "column",
};

const accentTopBarStyle: React.CSSProperties = {
  height: "2px",
  width: "100%",
  background: "var(--expect2-trail-bar)",
  flexShrink: 0,
};

const modalInputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--screen)",
  border: "1px solid var(--border-strong)",
  borderRadius: "6px",
  color: "var(--ink)",
  padding: "7px 10px",
  fontFamily: "var(--ui-font)",
  fontSize: "13px",
  outline: "none",
};

const pillBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "4px",
  background: "var(--screen)",
  border: "1px solid var(--border-strong)",
  color: "var(--dim)",
  padding: "3px 8px",
  fontFamily: "var(--ui-font)",
  fontSize: "11.5px",
  fontWeight: 500,
  cursor: "pointer",
  borderRadius: "6px",
};

const activePillBtnStyle: React.CSSProperties = {
  ...pillBtnStyle,
  background: "var(--selection, #2e436e)",
  border: "1px solid rgba(61, 107, 255, 0.45)",
  color: "#ffffff",
  fontWeight: 600,
};

const primaryCtaBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "6px",
  background: "var(--accent, #3574f0)",
  border: "1px solid var(--accent, #3574f0)",
  color: "#ffffff",
  padding: "6px 14px",
  fontFamily: "var(--ui-font)",
  fontSize: "12px",
  fontWeight: 600,
  cursor: "pointer",
  borderRadius: "6px",
};

/* -------------------------------------------------------------------------- */
/* 1. SearchEverywherePopup (Shift+Shift / Cmd+Shift+O / Cmd+Alt+O)          */
/* -------------------------------------------------------------------------- */

export type SearchEverywhereTab = "all" | "files" | "symbols" | "worktrees" | "actions";

export interface SearchEverywherePluginAction {
  pluginId: string;
  actionId: string;
  title: string;
  description?: string;
}

export interface SearchEverywherePopupProps {
  open: boolean;
  initialTab?: SearchEverywhereTab;
  initialQuery?: string;
  activeWorktree: WorktreeInfo;
  worktrees: readonly WorktreeInfo[];
  pluginActions?: readonly SearchEverywherePluginAction[];
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
  onRunPluginAction?: (pluginId: string, actionId: string) => void;
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
    }
  | {
      kind: "plugin";
      key: string;
      title: string;
      subtitle: string;
      pluginId: string;
      actionId: string;
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
  pluginActions = [],
  platform,
  onSearchFiles,
  onSearchSymbols,
  onOpenFile,
  onSelectWorktree,
  onRunAction,
  onRunPluginAction,
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
      const matchedPluginActs = pluginActions.filter(
        (pa) =>
          !q ||
          pa.title.toLowerCase().includes(q) ||
          (pa.description ?? "").toLowerCase().includes(q) ||
          pa.pluginId.toLowerCase().includes(q),
      );
      for (const pa of matchedPluginActs.slice(0, tab === "all" ? 5 : 25)) {
        out.push({
          kind: "plugin",
          key: `plug:${pa.pluginId}:${pa.actionId}`,
          title: pa.title,
          subtitle: pa.description ?? `Plugin: ${pa.pluginId}`,
          pluginId: pa.pluginId,
          actionId: pa.actionId,
        });
      }
    }

    return out;
  }, [tab, fileHits, symbolHits, worktrees, pluginActions, parsed.text, parsed.line, parsed.column, platform]);

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
      case "plugin":
        onClose();
        onRunPluginAction?.(item.pluginId, item.actionId);
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
        <div aria-hidden="true" style={accentTopBarStyle} />

        {/* Tabs + Scope Pill */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 12px",
            borderBottom: "1px solid var(--faint)",
            background: "var(--paper)",
            gap: "8px",
          }}
        >
          <div role="tablist" style={{ display: "inline-flex", gap: "2px" }}>
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
                    background: "transparent",
                    border: "none",
                    borderBottom: active
                      ? "2px solid var(--sky)"
                      : "2px solid transparent",
                    color: active ? "#ffffff" : "var(--dim)",
                    padding: "9px 10px 7px",
                    fontFamily: "var(--ui-font)",
                    fontSize: "12.5px",
                    fontWeight: active ? 600 : 500,
                    cursor: "pointer",
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
            style={allWorktrees ? activePillBtnStyle : pillBtnStyle}
          >
            {allWorktrees ? "All Worktrees" : `Worktree: ${activeWorktree.name}`}
          </button>
        </div>

        {/* Search Input */}
        <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--faint)" }}>
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
        <div style={{ flex: 1, overflowY: "auto", maxHeight: "420px", padding: "6px 0" }}>
          {items.length === 0 ? (
            <div style={{ padding: "16px 14px", color: "var(--dim)" }}>
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
                    width: "calc(100% - 12px)",
                    margin: "0 6px",
                    borderRadius: "5px",
                    textAlign: "left",
                    padding: "6px 10px",
                    background: selected ? "var(--selection, #2e436e)" : "transparent",
                    color: selected ? "#ffffff" : "var(--ink)",
                    border: "none",
                    fontFamily: "var(--ui-font)",
                    fontSize: "12.5px",
                    cursor: "pointer",
                    boxSizing: "border-box",
                  }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                    <span
                      style={{
                        fontFamily: "var(--mono)",
                        fontSize: "10px",
                        fontWeight: 600,
                        padding: "1px 5px",
                        borderRadius: "4px",
                        background: selected ? "rgba(255, 255, 255, 0.14)" : "var(--screen)",
                        border: selected
                          ? "1px solid rgba(255, 255, 255, 0.24)"
                          : "1px solid var(--faint)",
                        color: selected ? "#ffffff" : "var(--dim)",
                        textTransform: "uppercase",
                        flexShrink: 0,
                      }}
                    >
                      {item.kind}
                    </span>
                    <span
                      style={{
                        fontWeight: 500,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {item.title}
                      {item.kind === "file" && item.line ? (
                        <span style={{ fontFamily: "var(--mono)", opacity: 0.85 }}>
                          :{item.line}
                        </span>
                      ) : null}
                    </span>
                  </span>

                  <span
                    style={{
                      color: selected ? "rgba(255, 255, 255, 0.78)" : "var(--dim)",
                      fontFamily: item.kind === "action" ? "var(--mono)" : "var(--ui-font)",
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
        label: `${w.path === activeWorktreePath ? "● " : ""}${w.name} (${w.branch})`,
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
        <div aria-hidden="true" style={accentTopBarStyle} />

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "8px 12px",
            borderBottom: "1px solid var(--faint)",
            background: "var(--paper)",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontWeight: 600 }}>
            <span>Switcher</span>
            <span style={{ fontFamily: "var(--mono)", fontSize: "11px", color: "var(--dim)", fontWeight: 400 }}>
              {formatShortcut("recent-files", platform)}
            </span>
          </span>
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
              padding: "4px 8px",
              fontSize: "12px",
            }}
          />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1.35fr", minHeight: "280px", maxHeight: "420px" }}>
          {/* Left Column: Tool Windows + Worktrees */}
          <div
            style={{
              borderRight: "1px solid var(--faint)",
              overflowY: "auto",
              padding: "6px 0",
            }}
          >
            <div
              style={{
                padding: "2px 12px 6px",
                fontSize: "10.5px",
                fontWeight: 600,
                letterSpacing: "0.04em",
                color: "var(--dim)",
              }}
            >
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
                    width: "calc(100% - 12px)",
                    margin: "0 6px",
                    borderRadius: "5px",
                    textAlign: "left",
                    padding: "5px 10px",
                    background: selected ? "var(--selection, #2e436e)" : "transparent",
                    color: selected ? "#ffffff" : "var(--ink)",
                    border: "none",
                    fontFamily: "var(--ui-font)",
                    fontSize: "12.5px",
                    cursor: "pointer",
                    boxSizing: "border-box",
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {item.label}
                  </span>
                  {item.kind === "tool" && (
                    <span
                      style={{
                        fontFamily: "var(--mono)",
                        fontSize: "11px",
                        color: selected ? "rgba(255, 255, 255, 0.78)" : "var(--dim)",
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
          <div style={{ overflowY: "auto", padding: "6px 0" }}>
            <div
              style={{
                padding: "2px 12px 6px",
                fontSize: "10.5px",
                fontWeight: 600,
                letterSpacing: "0.04em",
                color: "var(--dim)",
              }}
            >
              RECENT FILES
            </div>
            {filteredRecent.length === 0 ? (
              <div style={{ padding: "10px 12px", color: "var(--dim)" }}>
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
                      width: "calc(100% - 12px)",
                      margin: "0 6px",
                      borderRadius: "5px",
                      textAlign: "left",
                      padding: "5px 10px",
                      background: selected ? "var(--selection, #2e436e)" : "transparent",
                      color: selected ? "#ffffff" : "var(--ink)",
                      border: "none",
                      fontFamily: "var(--ui-font)",
                      fontSize: "12.5px",
                      cursor: "pointer",
                      boxSizing: "border-box",
                    }}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {file.filePath}
                    </span>
                    <span
                      style={{
                        fontSize: "11px",
                        color: selected ? "rgba(255, 255, 255, 0.78)" : "var(--dim)",
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
        <div aria-hidden="true" style={accentTopBarStyle} />

        {/* Header & Search Options */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "8px",
            padding: "10px 12px",
            borderBottom: "1px solid var(--faint)",
            background: "var(--paper)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontWeight: 600 }}>
              <span>Find in Path</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: "11px", color: "var(--dim)", fontWeight: 400 }}>
                {formatShortcut("find-in-path", platform)}
              </span>
            </span>
            <div style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
              <button
                type="button"
                aria-pressed={caseSensitive}
                onClick={() => setCaseSensitive((v) => !v)}
                title="Match Case"
                style={{
                  ...(caseSensitive ? activePillBtnStyle : pillBtnStyle),
                  fontFamily: "var(--mono)",
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
                  ...(wholeWord ? activePillBtnStyle : pillBtnStyle),
                  fontFamily: "var(--mono)",
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
                  ...(isRegex ? activePillBtnStyle : pillBtnStyle),
                  fontFamily: "var(--mono)",
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
                  padding: "3px 8px",
                  fontFamily: "var(--mono)",
                  fontSize: "11.5px",
                }}
              />
              <button
                type="button"
                aria-pressed={allWorktrees}
                onClick={() => setAllWorktrees((v) => !v)}
                style={allWorktrees ? activePillBtnStyle : pillBtnStyle}
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
        <div
          style={{
            flex: "1 1 55%",
            overflowY: "auto",
            borderBottom: "1px solid var(--faint)",
            padding: "6px 0",
          }}
        >
          {loading ? (
            <div style={{ padding: "12px 14px", color: "var(--dim)" }}>Searching...</div>
          ) : matches.length === 0 ? (
            <div style={{ padding: "12px 14px", color: "var(--dim)" }}>
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
                    width: "calc(100% - 12px)",
                    margin: "0 6px",
                    borderRadius: "5px",
                    textAlign: "left",
                    padding: "5px 10px",
                    background: selected ? "var(--selection, #2e436e)" : "transparent",
                    color: selected ? "#ffffff" : "var(--ink)",
                    border: "none",
                    fontFamily: "var(--mono)",
                    fontSize: "12px",
                    cursor: "pointer",
                    boxSizing: "border-box",
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    <span>{before}</span>
                    <mark
                      style={{
                        background: selected ? "rgba(255, 228, 92, 0.28)" : "var(--unknown-bg-hi)",
                        color: "var(--unknown)",
                        padding: "0 2px",
                        borderRadius: "3px",
                      }}
                    >
                      {hit}
                    </mark>
                    <span>{after}</span>
                  </span>
                  <span
                    style={{
                      flexShrink: 0,
                      fontFamily: "var(--ui-font)",
                      fontSize: "11px",
                      color: selected ? "rgba(255, 255, 255, 0.78)" : "var(--dim)",
                    }}
                  >
                    {allWorktrees ? `[${m.worktreeName}] ` : ""}
                    {m.filePath}
                    <span style={{ fontFamily: "var(--mono)" }}>:{m.line}</span>
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
            background: "var(--screen)",
            padding: "10px 12px",
          }}
        >
          {activeMatch ? (
            <>
              <div
                style={{
                  fontSize: "11.5px",
                  color: "var(--dim)",
                  marginBottom: "8px",
                  borderBottom: "1px solid var(--faint)",
                  paddingBottom: "5px",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                <span>{activeMatch.worktreeName}</span>
                <span>·</span>
                <span style={{ fontFamily: "var(--mono)", color: "var(--ink)" }}>
                  {activeMatch.filePath}:{activeMatch.line}:{activeMatch.column}
                </span>
              </div>
              <pre
                style={{
                  margin: 0,
                  fontFamily: "var(--mono)",
                  fontSize: "12px",
                  lineHeight: 1.55,
                }}
              >
                {previewLines.map((ln) => (
                  <div
                    key={ln.lineNumber}
                    style={{
                      display: "flex",
                      gap: "12px",
                      padding: "1px 6px",
                      borderRadius: "4px",
                      background: ln.isTarget ? "var(--wash-hi)" : "transparent",
                    }}
                  >
                    <span
                      style={{
                        minWidth: "42px",
                        textAlign: "right",
                        color: ln.isTarget ? "var(--unknown)" : "var(--dim)",
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
            <div style={{ color: "var(--dim)" }}>Select a match to preview context.</div>
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
          width: "360px",
          maxWidth: "92vw",
        }}
      >
        <div aria-hidden="true" style={accentTopBarStyle} />

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "9px 14px",
            borderBottom: "1px solid var(--faint)",
            background: "var(--paper)",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontWeight: 600 }}>
            <span>Go to Line:Column</span>
            <span style={{ fontFamily: "var(--mono)", fontSize: "11px", color: "var(--dim)", fontWeight: 400 }}>
              {formatShortcut("go-to-line", platform)}
            </span>
          </span>
          {maxLine ? (
            <span style={{ fontFamily: "var(--mono)", fontSize: "11px", color: "var(--dim)" }}>
              1..{maxLine}
            </span>
          ) : null}
        </div>

        <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: "10px" }}>
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="142 or 142:18"
            style={{ ...modalInputStyle, fontFamily: "var(--mono)" }}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
            <button type="button" onClick={onClose} style={pillBtnStyle}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={!valid}
              style={{
                ...primaryCtaBtnStyle,
                opacity: valid ? 1 : 0.45,
                cursor: valid ? "pointer" : "not-allowed",
              }}
            >
              Jump
            </button>
          </div>
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
  reviewConnected?: boolean;
  onCopyFeedbackPrompt: (options: ExportPromptOptions, compiledMarkdown: string) => Promise<void> | void;
  onSendToAgent?: (options: { includeOutdated: boolean; resolveAfterSend: boolean }) => Promise<void> | void;
  onClose: () => void;
}

export const ExportPromptModal: React.FC<ExportPromptModalProps> = ({
  open,
  worktree,
  annotations,
  platform,
  reviewConnected = false,
  onCopyFeedbackPrompt,
  onSendToAgent,
  onClose,
}) => {
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
      }),
    [worktree, annotations, includeOutdated],
  );

  if (!open) return null;

  const handleCopy = async () => {
    if (!compiled.markdown) return;
    await onCopyFeedbackPrompt(
      {
        worktreePath: worktree.path,
        includeOutdated,
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
        <div aria-hidden="true" style={accentTopBarStyle} />

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 14px",
            borderBottom: "1px solid var(--faint)",
            background: "var(--paper)",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontWeight: 600 }}>
            <span>Feedback Prompt Preview</span>
            <span
              style={{
                fontSize: "11px",
                fontWeight: 500,
                color: "var(--dim)",
                background: "var(--wash)",
                border: "1px solid var(--faint)",
                borderRadius: "4px",
                padding: "1px 6px",
              }}
            >
              {worktree.name} · {compiled.includedIds.length} items
            </span>
          </span>
          <button
            type="button"
            onClick={onClose}
            style={{ ...pillBtnStyle, fontFamily: "var(--mono)", fontSize: "11px" }}
          >
            Esc
          </button>
        </div>

        {/* Options */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: "14px",
            padding: "8px 14px",
            borderBottom: "1px solid var(--faint)",
            background: "var(--wash)",
            fontSize: "12px",
            color: "var(--dim)",
          }}
        >
          <label style={{ display: "inline-flex", alignItems: "center", gap: "5px", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={includeOutdated}
              onChange={(e) => setIncludeOutdated(e.target.checked)}
            />
            <span>Include outdated</span>
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: "5px", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={resolveAfterCopy}
              onChange={(e) => setResolveAfterCopy(e.target.checked)}
            />
            <span>Mark resolved after copy</span>
          </label>
        </div>

        {/* Markdown Preview */}
        <pre
          style={{
            flex: 1,
            margin: 0,
            padding: "14px",
            overflow: "auto",
            background: "var(--screen)",
            color: "var(--ink)",
            fontFamily: "var(--mono)",
            fontSize: "12px",
            lineHeight: 1.55,
            whiteSpace: "pre-wrap",
          }}
        >
          {compiled.markdown || "No open annotations yet."}
        </pre>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "8px",
            padding: "10px 14px",
            borderTop: "1px solid var(--faint)",
            background: "var(--paper)",
          }}
        >
          <button type="button" onClick={onClose} style={pillBtnStyle}>
            Close
          </button>
          {reviewConnected && onSendToAgent && (
            <button
              type="button"
              disabled={!compiled.markdown}
              onClick={() =>
                void onSendToAgent({
                  includeOutdated,
                  resolveAfterSend: resolveAfterCopy,
                })
              }
              style={{
                ...primaryCtaBtnStyle,
                opacity: compiled.markdown ? 1 : 0.45,
                cursor: compiled.markdown ? "pointer" : "not-allowed",
              }}
            >
              Send to Agent →
            </button>
          )}
          <button
            type="button"
            disabled={!compiled.markdown}
            onClick={() => void handleCopy()}
            style={{
              ...(reviewConnected ? pillBtnStyle : primaryCtaBtnStyle),
              background: copied
                ? "var(--safe)"
                : reviewConnected
                  ? "var(--screen)"
                  : "var(--accent, #3574f0)",
              borderColor: copied
                ? "var(--safe)"
                : reviewConnected
                  ? "var(--border-strong)"
                  : "var(--accent, #3574f0)",
              color: copied
                ? "var(--knock)"
                : reviewConnected
                  ? "var(--ink)"
                  : "#ffffff",
              opacity: compiled.markdown ? 1 : 0.45,
              cursor: compiled.markdown ? "pointer" : "not-allowed",
            }}
          >
            {copied ? (
              "Copied to Clipboard!"
            ) : (
              <>
                <span>Copy to Clipboard</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: "11px", opacity: 0.85 }}>
                  {formatShortcut("copy-feedback-prompt", platform)}
                </span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
