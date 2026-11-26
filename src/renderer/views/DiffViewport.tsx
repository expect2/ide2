import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type {
  Annotation,
  DiffRow,
  DiffScope,
  FileDiffResult,
  WordDiffPart,
  WorktreeInfo,
} from "../../shared/protocol";
import { AnnotationComposer, AnnotationThreadCard } from "./AnnotationCard";

export type DiffViewMode = "split" | "unified";

export interface DiffViewportProps {
  diff: FileDiffResult;
  mode?: DiffViewMode;
  onModeChange?: (mode: DiffViewMode) => void;
  onScopeChange?: (scope: DiffScope) => void;
  worktrees?: WorktreeInfo[];
  annotations?: Annotation[];
  onCreateAnnotation?: (input: {
    side: "new" | "old";
    startLine: number;
    endLine: number;
    selectedText: string;
    contextBefore: string;
    contextAfter: string;
    comment: string;
  }) => void | Promise<void>;
  onUpdateAnnotation?: (
    annotation: Annotation,
    updates: { comment: string },
  ) => void | Promise<void>;
  onResolveAnnotation?: (annotation: Annotation) => void | Promise<void>;
  onUnresolveAnnotation?: (annotation: Annotation) => void | Promise<void>;
  onDeleteAnnotation?: (annotation: Annotation) => void | Promise<void>;
  hunkNavTrigger?: { direction: "next" | "prev"; seq: number } | null;
  onOpenFile?: (filePath: string, line?: number) => void;
  spotlight?: {
    startLine?: number;
    endLine?: number;
    card?: React.ReactNode;
    seq?: string;
  } | null;
}

type UnifiedDisplayItem =
  | {
      key: string;
      kind: "hunk";
      header: string;
      rowIndex: number;
    }
  | {
      key: string;
      kind: "line";
      lineType: "context" | "add" | "del";
      oldLineNumber?: number;
      newLineNumber?: number;
      text: string;
      parts?: WordDiffPart[];
      side: "new" | "old";
      rowIndex: number;
    };

function renderWordParts(
  parts: WordDiffPart[] | undefined,
  fallbackText: string | undefined,
  side: "old" | "new",
): React.ReactNode {
  if (!parts || parts.length === 0) {
    return fallbackText && fallbackText.length > 0 ? fallbackText : "\u00A0";
  }
  return parts.map((part, idx) => {
    if (side === "old" && part.removed) {
      return (
        <span key={idx} className="word-del">
          {part.text}
        </span>
      );
    }
    if (side === "new" && part.added) {
      return (
        <span key={idx} className="word-add">
          {part.text}
        </span>
      );
    }
    return <React.Fragment key={idx}>{part.text}</React.Fragment>;
  });
}

function extractSideContext(
  rows: DiffRow[],
  side: "new" | "old",
  startLine: number,
  endLine: number,
): { selectedText: string; contextBefore: string; contextAfter: string } {
  const lineMap = new Map<number, string>();
  for (const r of rows) {
    if (side === "old" && r.oldLineNumber !== undefined) {
      lineMap.set(r.oldLineNumber, r.oldText ?? "");
    } else if (side === "new" && r.newLineNumber !== undefined) {
      lineMap.set(r.newLineNumber, r.newText ?? "");
    }
  }

  const collect = (from: number, to: number): string => {
    const out: string[] = [];
    for (let l = from; l <= to; l++) {
      const txt = lineMap.get(l);
      if (txt !== undefined) out.push(txt);
    }
    return out.join("\n");
  };

  return {
    selectedText: collect(startLine, endLine),
    contextBefore: collect(Math.max(1, startLine - 2), startLine - 1),
    contextAfter: collect(endLine + 1, endLine + 2),
  };
}

export const DiffViewport: React.FC<DiffViewportProps> = ({
  diff,
  mode: controlledMode,
  onModeChange,
  onScopeChange,
  worktrees = [],
  annotations = [],
  onCreateAnnotation,
  onUpdateAnnotation,
  onResolveAnnotation,
  onUnresolveAnnotation,
  onDeleteAnnotation,
  hunkNavTrigger,
  onOpenFile,
  spotlight = null,
}) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const [localMode, setLocalMode] = useState<DiffViewMode>("split");
  const viewMode = controlledMode ?? localMode;
  const setViewMode = (next: DiffViewMode) => {
    if (onModeChange) onModeChange(next);
    else setLocalMode(next);
  };

  const [activeHunkCursor, setActiveHunkCursor] = useState<number>(0);

  const [selection, setSelection] = useState<{
    side: "new" | "old";
    startLine: number;
    endLine: number;
  } | null>(null);
  const selectionAnchorRef = useRef<{
    side: "new" | "old";
    line: number;
  } | null>(null);

  const [composer, setComposer] = useState<{
    side: "new" | "old";
    startLine: number;
    endLine: number;
  } | null>(null);

  // Build unified display items when in unified mode
  const unifiedItems = useMemo<UnifiedDisplayItem[]>(() => {
    const items: UnifiedDisplayItem[] = [];
    diff.rows.forEach((row, idx) => {
      if (row.type === "hunk") {
        items.push({
          key: `hunk-${idx}`,
          kind: "hunk",
          header: row.header ?? "@@",
          rowIndex: idx,
        });
      } else if (row.type === "context") {
        items.push({
          key: `ctx-${idx}`,
          kind: "line",
          lineType: "context",
          oldLineNumber: row.oldLineNumber,
          newLineNumber: row.newLineNumber,
          text: row.newText ?? row.oldText ?? "",
          side: "new",
          rowIndex: idx,
        });
      } else if (row.type === "del") {
        items.push({
          key: `del-${idx}`,
          kind: "line",
          lineType: "del",
          oldLineNumber: row.oldLineNumber,
          text: row.oldText ?? "",
          parts: row.oldParts,
          side: "old",
          rowIndex: idx,
        });
      } else if (row.type === "add") {
        items.push({
          key: `add-${idx}`,
          kind: "line",
          lineType: "add",
          newLineNumber: row.newLineNumber,
          text: row.newText ?? "",
          parts: row.newParts,
          side: "new",
          rowIndex: idx,
        });
      } else if (row.type === "modify") {
        items.push({
          key: `mod-old-${idx}`,
          kind: "line",
          lineType: "del",
          oldLineNumber: row.oldLineNumber,
          text: row.oldText ?? "",
          parts: row.oldParts,
          side: "old",
          rowIndex: idx,
        });
        items.push({
          key: `mod-new-${idx}`,
          kind: "line",
          lineType: "add",
          newLineNumber: row.newLineNumber,
          text: row.newText ?? "",
          parts: row.newParts,
          side: "new",
          rowIndex: idx,
        });
      }
    });
    return items;
  }, [diff.rows]);

  const itemCount = viewMode === "split" ? diff.rows.length : unifiedItems.length;

  const virtualizer = useVirtualizer({
    count: itemCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 22,
    overscan: 20,
  });

  // Compute hunk indices for F7 / Shift+F7 navigation
  const hunkIndices = useMemo<number[]>(() => {
    const indices: number[] = [];
    if (viewMode === "split") {
      diff.rows.forEach((r, idx) => {
        if (r.type === "hunk") indices.push(idx);
      });
      if (indices.length === 0) {
        let inChange = false;
        diff.rows.forEach((r, idx) => {
          const isChange = r.type !== "context" && r.type !== "hunk";
          if (isChange && !inChange) indices.push(idx);
          inChange = isChange;
        });
      }
    } else {
      unifiedItems.forEach((item, idx) => {
        if (item.kind === "hunk") indices.push(idx);
      });
      if (indices.length === 0) {
        let inChange = false;
        unifiedItems.forEach((item, idx) => {
          const isChange = item.kind === "line" && item.lineType !== "context";
          if (isChange && !inChange) indices.push(idx);
          inChange = isChange;
        });
      }
    }
    return indices;
  }, [viewMode, diff.rows, unifiedItems]);

  const jumpHunk = useCallback(
    (direction: "next" | "prev") => {
      if (hunkIndices.length === 0) return;
      const nextCursor =
        direction === "next"
          ? (activeHunkCursor + 1) % hunkIndices.length
          : (activeHunkCursor - 1 + hunkIndices.length) % hunkIndices.length;
      setActiveHunkCursor(nextCursor);
      const targetIdx = hunkIndices[nextCursor];
      if (targetIdx !== undefined) {
        virtualizer.scrollToIndex(targetIdx, { align: "start" });
      }
    },
    [hunkIndices, activeHunkCursor, virtualizer],
  );

  useEffect(() => {
    setActiveHunkCursor(0);
    setSelection(null);
    setComposer(null);
  }, [diff.filePath, diff.scope]);

  useEffect(() => {
    if (!hunkNavTrigger) return;
    jumpHunk(hunkNavTrigger.direction);
  }, [hunkNavTrigger?.seq]);

  const { spotlightRowSet, spotlightAnchorIdx } = useMemo(() => {
    const matched = new Set<number>();
    if (!spotlight) {
      return { spotlightRowSet: matched, spotlightAnchorIdx: null as number | null };
    }
    const sLine = spotlight.startLine;
    const eLine = spotlight.endLine ?? sLine;

    if (sLine !== undefined && eLine !== undefined) {
      if (viewMode === "split") {
        diff.rows.forEach((r, idx) => {
          if (r.type === "hunk") return;
          const nMatch = r.newLineNumber !== undefined && r.newLineNumber >= sLine && r.newLineNumber <= eLine;
          const oMatch = r.oldLineNumber !== undefined && r.oldLineNumber >= sLine && r.oldLineNumber <= eLine;
          if (nMatch || oMatch) matched.add(idx);
        });
      } else {
        unifiedItems.forEach((item, idx) => {
          if (item.kind !== "line") return;
          const ln = item.newLineNumber ?? item.oldLineNumber;
          if (ln !== undefined && ln >= sLine && ln <= eLine) matched.add(idx);
        });
      }
    }

    let anchor: number | null = null;
    for (const idx of matched) {
      if (anchor === null || idx > anchor) anchor = idx;
    }
    if (anchor === null && spotlight.card && itemCount > 0) {
      anchor = hunkIndices[0] ?? 0;
    }
    return { spotlightRowSet: matched, spotlightAnchorIdx: anchor };
  }, [spotlight, viewMode, diff.rows, unifiedItems, itemCount, hunkIndices]);

  useEffect(() => {
    if (spotlightAnchorIdx === null) return;
    virtualizer.scrollToIndex(spotlightAnchorIdx, { align: "center" });
  }, [spotlight?.seq, spotlightAnchorIdx]);

  // Group annotations by side + anchor line
  const { oldThreads, newThreads, oldGutter, newGutter } = useMemo(() => {
    const oThreads = new Map<number, Annotation[]>();
    const nThreads = new Map<number, Annotation[]>();
    const oGutter = new Map<number, Annotation[]>();
    const nGutter = new Map<number, Annotation[]>();

    for (const ann of annotations) {
      if (!ann.startLine) continue;
      const start = ann.startLine;
      const end = ann.endLine ?? start;
      if (ann.side === "old") {
        const tl = oThreads.get(end);
        if (tl) tl.push(ann);
        else oThreads.set(end, [ann]);
        const gl = oGutter.get(start);
        if (gl) gl.push(ann);
        else oGutter.set(start, [ann]);
      } else {
        const tl = nThreads.get(end);
        if (tl) tl.push(ann);
        else nThreads.set(end, [ann]);
        const gl = nGutter.get(start);
        if (gl) gl.push(ann);
        else nGutter.set(start, [ann]);
      }
    }
    return {
      oldThreads: oThreads,
      newThreads: nThreads,
      oldGutter: oGutter,
      newGutter: nGutter,
    };
  }, [annotations]);

  const handleLineSelect = (
    e: React.MouseEvent,
    side: "new" | "old",
    lineNumber: number,
  ) => {
    e.stopPropagation();
    const anchor = selectionAnchorRef.current;
    if (e.shiftKey && anchor && anchor.side === side) {
      const startLine = Math.min(anchor.line, lineNumber);
      const endLine = Math.max(anchor.line, lineNumber);
      setSelection({ side, startLine, endLine });
    } else {
      selectionAnchorRef.current = { side, line: lineNumber };
      setSelection({ side, startLine: lineNumber, endLine: lineNumber });
    }
  };

  const openComposer = (
    side: "new" | "old",
    startLine: number,
    endLine: number,
  ) => {
    if (!onCreateAnnotation) return;
    const s = Math.min(startLine, endLine);
    const e = Math.max(startLine, endLine);
    setSelection({ side, startLine: s, endLine: e });
    setComposer({ side, startLine: s, endLine: e });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "F7") {
      e.preventDefault();
      e.stopPropagation();
      jumpHunk(e.shiftKey ? "prev" : "next");
    } else if ((e.metaKey || e.ctrlKey) && e.key === "/" && selection) {
      e.preventDefault();
      e.stopPropagation();
      openComposer(selection.side, selection.startLine, selection.endLine);
    } else if (e.key === "Escape") {
      if (composer) {
        e.stopPropagation();
        setComposer(null);
      } else if (selection) {
        setSelection(null);
      }
    }
  };

  const handleSubmitComposer = async (data: {
    comment: string;
  }) => {
    if (!composer || !onCreateAnnotation) return;
    const ctx = extractSideContext(
      diff.rows,
      composer.side,
      composer.startLine,
      composer.endLine,
    );
    await onCreateAnnotation({
      side: composer.side,
      startLine: composer.startLine,
      endLine: composer.endLine,
      selectedText: ctx.selectedText,
      contextBefore: ctx.contextBefore,
      contextAfter: ctx.contextAfter,
      comment: data.comment,
    });
    setComposer(null);
  };

  const otherWorktrees = worktrees.filter((w) => w.path !== diff.worktreePath);
  const virtualItems = virtualizer.getVirtualItems();
  const activeHunkRowIdx = hunkIndices[activeHunkCursor];

  return (
    <div
      ref={rootRef}
      className={`diff-viewport ${spotlightRowSet.size > 0 ? "has-spotlight" : ""}`}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {/* Diff Toolbar */}
      <div className="diff-toolbar">
        <div className="diff-toolbar-group">
          <button
            type="button"
            className="diff-file-label"
            onClick={() => onOpenFile?.(diff.filePath)}
            title="Open file in Code Viewport"
          >
            {diff.oldPath && diff.oldPath !== diff.filePath
              ? `${diff.oldPath} → ${diff.filePath}`
              : diff.filePath}
          </button>

          <span className="kbd-hint">
            {diff.baseLabel} ↔ {diff.targetLabel}
          </span>

          <span className="diff-stats">
            <span className="diff-stat-add">+{diff.additions}</span>
            <span className="diff-stat-del">-{diff.deletions}</span>
          </span>
        </div>

        <div className="diff-toolbar-group">
          {onScopeChange && (
            <>
              <button
                type="button"
                className={`diff-scope-btn ${diff.scope.kind === "branch" ? "active" : ""}`}
                onClick={() => onScopeChange({ kind: "branch" })}
              >
                Branch vs Base
              </button>
              <button
                type="button"
                className={`diff-scope-btn ${diff.scope.kind === "working" ? "active" : ""}`}
                onClick={() => onScopeChange({ kind: "working" })}
              >
                Working Tree vs HEAD
              </button>
              {otherWorktrees.length > 0 && (
                <select
                  className="diff-scope-select"
                  aria-label="Compare with Worktree"
                  value={
                    diff.scope.kind === "worktree"
                      ? diff.scope.otherWorktreePath
                      : ""
                  }
                  onChange={(e) => {
                    if (e.target.value) {
                      onScopeChange({
                        kind: "worktree",
                        otherWorktreePath: e.target.value,
                      });
                    }
                  }}
                >
                  <option value="">Compare with Worktree…</option>
                  {otherWorktrees.map((wt) => (
                    <option key={wt.path} value={wt.path}>
                      wt: {wt.name} ({wt.branch})
                    </option>
                  ))}
                </select>
              )}
            </>
          )}

          <div className="md-mode-tabs">
            <button
              type="button"
              className={`md-mode-tab ${viewMode === "split" ? "active" : ""}`}
              onClick={() => setViewMode("split")}
            >
              Split
            </button>
            <button
              type="button"
              className={`md-mode-tab ${viewMode === "unified" ? "active" : ""}`}
              onClick={() => setViewMode("unified")}
            >
              Unified
            </button>
          </div>

          <button
            type="button"
            className="btn"
            onClick={() => jumpHunk("prev")}
            disabled={hunkIndices.length === 0}
            title="Previous Change (Shift+F7)"
          >
            ← Prev ⇧F7
          </button>
          <span style={{ fontSize: 11, color: "var(--dim)" }}>
            {hunkIndices.length > 0
              ? `${activeHunkCursor + 1}/${hunkIndices.length}`
              : "0/0"}
          </span>
          <button
            type="button"
            className="btn"
            onClick={() => jumpHunk("next")}
            disabled={hunkIndices.length === 0}
            title="Next Change (F7)"
          >
            Next F7 →
          </button>
        </div>
      </div>

      {/* Floating selection bar when lines are selected */}
      {selection && !composer && onCreateAnnotation && (
        <div className="code-selection-bar">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() =>
              openComposer(
                selection.side,
                selection.startLine,
                selection.endLine,
              )
            }
          >
            + Annotate{" "}
            {selection.startLine === selection.endLine
              ? `L${selection.startLine}`
              : `L${selection.startLine}-${selection.endLine}`}{" "}
            ({selection.side}) (⌘/)
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setSelection(null)}
          >
            ×
          </button>
        </div>
      )}

      {diff.isBinary ? (
        <div className="code-binary-placeholder">
          <span className="statusline-badge">BINARY DIFF</span>
          <span>{diff.filePath}</span>
        </div>
      ) : diff.rows.length === 0 ? (
        <div className="code-binary-placeholder">
          <span style={{ color: "var(--safe)" }}>
            ✓ NO DIFFERENCES IN THIS SCOPE
          </span>
          <span style={{ fontSize: 12, color: "var(--off)" }}>
            {diff.baseLabel} matches {diff.targetLabel}
          </span>
        </div>
      ) : (
        <div ref={scrollRef} className="diff-scroll">
          <div
            className="code-virtual-canvas"
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          >
            {virtualItems.map((vItem) => {
              if (viewMode === "split") {
                const row = diff.rows[vItem.index];
                if (!row) return null;

                if (row.type === "hunk") {
                  return (
                    <div
                      key={vItem.key}
                      ref={virtualizer.measureElement}
                      data-index={vItem.index}
                      className="code-row"
                      style={{ transform: `translateY(${vItem.start}px)` }}
                    >
                      <div
                        className={`diff-hunk-row ${
                          activeHunkRowIdx === vItem.index ? "active-hunk" : ""
                        }`}
                      >
                        <span>{row.header ?? "@@"}</span>
                      </div>
                    </div>
                  );
                }

                const hasOld = row.type !== "add" && row.oldLineNumber !== undefined;
                const hasNew = row.type !== "del" && row.newLineNumber !== undefined;

                const oldSelected =
                  hasOld &&
                  selection?.side === "old" &&
                  row.oldLineNumber! >= selection.startLine &&
                  row.oldLineNumber! <= selection.endLine;
                const newSelected =
                  hasNew &&
                  selection?.side === "new" &&
                  row.newLineNumber! >= selection.startLine &&
                  row.newLineNumber! <= selection.endLine;

                const oldAnnList = hasOld
                  ? oldThreads.get(row.oldLineNumber!) ?? []
                  : [];
                const newAnnList = hasNew
                  ? newThreads.get(row.newLineNumber!) ?? []
                  : [];
                const oldLead = hasOld
                  ? oldGutter.get(row.oldLineNumber!)?.[0]
                  : undefined;
                const newLead = hasNew
                  ? newGutter.get(row.newLineNumber!)?.[0]
                  : undefined;

                const showOldComposer =
                  hasOld &&
                  composer?.side === "old" &&
                  composer.endLine === row.oldLineNumber;
                const showNewComposer =
                  hasNew &&
                  composer?.side === "new" &&
                  composer.endLine === row.newLineNumber;

                const oldCellClass = [
                  "diff-cell",
                  !hasOld
                    ? "diff-cell-empty"
                    : row.type === "del"
                      ? "diff-cell-del"
                      : row.type === "modify"
                        ? "diff-cell-mod-old"
                        : "",
                  oldSelected ? "selected" : "",
                ]
                  .filter(Boolean)
                  .join(" ");

                const newCellClass = [
                  "diff-cell",
                  !hasNew
                    ? "diff-cell-empty"
                    : row.type === "add"
                      ? "diff-cell-add"
                      : row.type === "modify"
                        ? "diff-cell-mod-new"
                        : "",
                  newSelected ? "selected" : "",
                ]
                  .filter(Boolean)
                  .join(" ");

                const showSpotlightHere =
                  spotlightAnchorIdx === vItem.index && Boolean(spotlight?.card);
                const isSpotlightRow = spotlightRowSet.has(vItem.index);

                return (
                  <div
                    key={vItem.key}
                    ref={virtualizer.measureElement}
                    data-index={vItem.index}
                    className="code-row"
                    style={{ transform: `translateY(${vItem.start}px)` }}
                  >
                    <div className={`diff-split-row ${isSpotlightRow ? "tour-spotlight" : ""}`}>
                      {/* OLD SIDE */}
                      <div className={oldCellClass}>
                        {hasOld ? (
                          <>
                            <div className="diff-gutter">
                              <div className="code-ann-lane">
                                {oldLead ? (
                                  <button
                                    type="button"
                                    className={`code-ann-diamond ${
                                      oldLead.status === "resolved" ? "resolved" : ""
                                    }`}
                                    onClick={() =>
                                      openComposer(
                                        "old",
                                        row.oldLineNumber!,
                                        oldLead.endLine ?? row.oldLineNumber!,
                                      )
                                    }
                                    title="Add note on deleted/old line"
                                  >
                                    ◆
                                  </button>
                                ) : (
                                  onCreateAnnotation && (
                                    <button
                                      type="button"
                                      className="code-ann-add"
                                      title={`Annotate old L${row.oldLineNumber}`}
                                      onClick={() =>
                                        openComposer(
                                          "old",
                                          row.oldLineNumber!,
                                          row.oldLineNumber!,
                                        )
                                      }
                                    >
                                      +
                                    </button>
                                  )
                                )}
                              </div>
                              <div
                                className="diff-lineno"
                                onClick={(e) =>
                                  handleLineSelect(e, "old", row.oldLineNumber!)
                                }
                              >
                                {row.oldLineNumber}
                              </div>
                              <div
                                className={`diff-sign ${
                                  row.type === "del" || row.type === "modify"
                                    ? "del"
                                    : ""
                                }`}
                              >
                                {row.type === "del" || row.type === "modify"
                                  ? "-"
                                  : " "}
                              </div>
                            </div>
                            <div className="diff-code">
                              {renderWordParts(
                                row.oldParts,
                                row.oldText,
                                "old",
                              )}
                            </div>
                          </>
                        ) : (
                          <div className="diff-code">{"\u00A0"}</div>
                        )}
                      </div>

                      {/* NEW SIDE */}
                      <div className={newCellClass}>
                        {hasNew ? (
                          <>
                            <div className="diff-gutter">
                              <div className="code-ann-lane">
                                {newLead ? (
                                  <button
                                    type="button"
                                    className={`code-ann-diamond ${
                                      newLead.status === "resolved" ? "resolved" : ""
                                    }`}
                                    onClick={() =>
                                      openComposer(
                                        "new",
                                        row.newLineNumber!,
                                        newLead.endLine ?? row.newLineNumber!,
                                      )
                                    }
                                    title="Add note on new line"
                                  >
                                    ◆
                                  </button>
                                ) : (
                                  onCreateAnnotation && (
                                    <button
                                      type="button"
                                      className="code-ann-add"
                                      title={`Annotate new L${row.newLineNumber}`}
                                      onClick={() =>
                                        openComposer(
                                          "new",
                                          row.newLineNumber!,
                                          row.newLineNumber!,
                                        )
                                      }
                                    >
                                      +
                                    </button>
                                  )
                                )}
                              </div>
                              <div
                                className="diff-lineno"
                                onClick={(e) =>
                                  handleLineSelect(e, "new", row.newLineNumber!)
                                }
                              >
                                {row.newLineNumber}
                              </div>
                              <div
                                className={`diff-sign ${
                                  row.type === "add" || row.type === "modify"
                                    ? "add"
                                    : ""
                                }`}
                              >
                                {row.type === "add" || row.type === "modify"
                                  ? "+"
                                  : " "}
                              </div>
                            </div>
                            <div className="diff-code">
                              {renderWordParts(
                                row.newParts,
                                row.newText,
                                "new",
                              )}
                            </div>
                          </>
                        ) : (
                          <div className="diff-code">{"\u00A0"}</div>
                        )}
                      </div>
                    </div>

                    {(oldAnnList.length > 0 ||
                      newAnnList.length > 0 ||
                      showOldComposer ||
                      showNewComposer ||
                      showSpotlightHere) && (
                      <div className="code-inline-slot">
                        {showSpotlightHere && spotlight?.card}
                        {oldAnnList.length > 0 && (
                          <AnnotationThreadCard
                            annotations={oldAnnList}
                            compact
                            onEdit={onUpdateAnnotation}
                            onResolve={onResolveAnnotation}
                            onUnresolve={onUnresolveAnnotation}
                            onDelete={onDeleteAnnotation}
                          />
                        )}
                        {newAnnList.length > 0 && (
                          <AnnotationThreadCard
                            annotations={newAnnList}
                            compact
                            onEdit={onUpdateAnnotation}
                            onResolve={onResolveAnnotation}
                            onUnresolve={onUnresolveAnnotation}
                            onDelete={onDeleteAnnotation}
                          />
                        )}
                        {(showOldComposer || showNewComposer) && composer && (
                          <AnnotationComposer
                            filePath={diff.filePath}
                            side={composer.side}
                            startLine={composer.startLine}
                            endLine={composer.endLine}
                            selectedPreview={
                              extractSideContext(
                                diff.rows,
                                composer.side,
                                composer.startLine,
                                composer.endLine,
                              ).selectedText
                            }
                            onSubmit={handleSubmitComposer}
                            onCancel={() => setComposer(null)}
                          />
                        )}
                      </div>
                    )}
                  </div>
                );
              }

              // UNIFIED MODE
              const item = unifiedItems[vItem.index];
              if (!item) return null;

              if (item.kind === "hunk") {
                return (
                  <div
                    key={vItem.key}
                    ref={virtualizer.measureElement}
                    data-index={vItem.index}
                    className="code-row"
                    style={{ transform: `translateY(${vItem.start}px)` }}
                  >
                    <div
                      className={`diff-hunk-row ${
                        activeHunkRowIdx === vItem.index ? "active-hunk" : ""
                      }`}
                    >
                      <span>{item.header}</span>
                    </div>
                  </div>
                );
              }

              const targetLine =
                item.side === "old" ? item.oldLineNumber : item.newLineNumber;
              const isSelected =
                targetLine !== undefined &&
                selection?.side === item.side &&
                targetLine >= selection.startLine &&
                targetLine <= selection.endLine;

              const threadList =
                targetLine !== undefined
                  ? item.side === "old"
                    ? oldThreads.get(targetLine) ?? []
                    : newThreads.get(targetLine) ?? []
                  : [];

              const leadAnn =
                targetLine !== undefined
                  ? item.side === "old"
                    ? oldGutter.get(targetLine)?.[0]
                    : newGutter.get(targetLine)?.[0]
                  : undefined;

              const showComposerHere =
                targetLine !== undefined &&
                composer?.side === item.side &&
                composer.endLine === targetLine;
              const showSpotlightHere =
                spotlightAnchorIdx === vItem.index && Boolean(spotlight?.card);
              const isSpotlightRow = spotlightRowSet.has(vItem.index);

              return (
                <div
                  key={vItem.key}
                  ref={virtualizer.measureElement}
                  data-index={vItem.index}
                  className="code-row"
                  style={{ transform: `translateY(${vItem.start}px)` }}
                >
                  <div
                    className={[
                      "diff-unified-row",
                      item.lineType === "add"
                        ? "add"
                        : item.lineType === "del"
                          ? "del"
                          : "",
                      isSelected ? "selected" : "",
                      isSpotlightRow ? "tour-spotlight" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <div className="diff-gutter">
                      <div className="code-ann-lane">
                        {leadAnn ? (
                          <button
                            type="button"
                            className={`code-ann-diamond ${
                              leadAnn.status === "resolved" ? "resolved" : ""
                            }`}
                            onClick={() =>
                              targetLine !== undefined &&
                              openComposer(
                                item.side,
                                targetLine,
                                leadAnn.endLine ?? targetLine,
                              )
                            }
                          >
                            ◆
                          </button>
                        ) : (
                          onCreateAnnotation &&
                          targetLine !== undefined && (
                            <button
                              type="button"
                              className="code-ann-add"
                              title={`Annotate ${item.side} L${targetLine}`}
                              onClick={() =>
                                openComposer(item.side, targetLine, targetLine)
                              }
                            >
                              +
                            </button>
                          )
                        )}
                      </div>
                      <div
                        className="diff-lineno"
                        onClick={(e) =>
                          item.oldLineNumber !== undefined &&
                          handleLineSelect(e, "old", item.oldLineNumber)
                        }
                      >
                        {item.oldLineNumber ?? ""}
                      </div>
                      <div
                        className="diff-lineno"
                        onClick={(e) =>
                          item.newLineNumber !== undefined &&
                          handleLineSelect(e, "new", item.newLineNumber)
                        }
                      >
                        {item.newLineNumber ?? ""}
                      </div>
                      <div
                        className={`diff-sign ${
                          item.lineType === "add"
                            ? "add"
                            : item.lineType === "del"
                              ? "del"
                              : ""
                        }`}
                      >
                        {item.lineType === "add"
                          ? "+"
                          : item.lineType === "del"
                            ? "-"
                            : " "}
                      </div>
                    </div>
                    <div className="diff-code">
                      {renderWordParts(item.parts, item.text, item.side)}
                    </div>
                  </div>

                  {(threadList.length > 0 || showComposerHere || showSpotlightHere) && (
                    <div className="code-inline-slot">
                      {showSpotlightHere && spotlight?.card}
                      {threadList.length > 0 && (
                        <AnnotationThreadCard
                          annotations={threadList}
                          compact
                          onEdit={onUpdateAnnotation}
                          onResolve={onResolveAnnotation}
                          onUnresolve={onUnresolveAnnotation}
                          onDelete={onDeleteAnnotation}
                        />
                      )}
                      {showComposerHere && composer && (
                        <AnnotationComposer
                          filePath={diff.filePath}
                          side={composer.side}
                          startLine={composer.startLine}
                          endLine={composer.endLine}
                          selectedPreview={
                            extractSideContext(
                              diff.rows,
                              composer.side,
                              composer.startLine,
                              composer.endLine,
                            ).selectedText
                          }
                          onSubmit={handleSubmitComposer}
                          onCancel={() => setComposer(null)}
                        />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
