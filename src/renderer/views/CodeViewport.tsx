import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type {
  Annotation,
  CodeSymbol,
  FileDocument,
  LineBlame,
  SymbolKind,
  TokenSpan,
} from "../../shared/protocol";
import { AnnotationComposer, AnnotationThreadCard } from "./AnnotationCard";

export interface CodeViewportHandle {
  scrollToLine: (
    line: number,
    options?: { flash?: boolean; column?: number; align?: "start" | "center" | "auto" },
  ) => void;
  openFind: () => void;
  openComposerAtSelection: () => void;
}

export interface CodeViewportProps {
  document: FileDocument;
  symbols?: CodeSymbol[];
  blame?: LineBlame[];
  showBlame?: boolean;
  annotations?: Annotation[];
  activeLine?: number;
  scrollToRequest?: {
    line: number;
    column?: number;
    flash?: boolean;
    seq: number;
  } | null;
  recentlyUpdatedAt?: number;
  onCreateAnnotation?: (input: {
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
  onSymbolActivate?: (params: {
    symbolName: string;
    line: number;
    mode: "definition" | "usages";
  }) => void;
  onCursorChange?: (pos: {
    line: number;
    column: number;
    startLine?: number;
    endLine?: number;
  }) => void;
  onVisibleLineChange?: (firstVisibleLine: number) => void;
  findOpenTrigger?: number;
  annotateTrigger?: number;
  fontSizePx?: number;
  spotlight?: {
    startLine: number;
    endLine: number;
    card?: React.ReactNode;
    seq?: string;
  } | null;
}

interface FindMatch {
  line: number; // 1-based
  start: number; // 0-based char offset
  end: number;
}

const SYMBOL_KIND_PREFIX: Record<SymbolKind, string> = {
  function: "fn",
  method: "method",
  class: "class",
  interface: "iface",
  type: "type",
  const: "const",
  variable: "let",
  property: "prop",
  enum: "enum",
  module: "mod",
  heading: "#",
};

function flattenSymbols(symbols: CodeSymbol[]): CodeSymbol[] {
  const result: CodeSymbol[] = [];
  const walk = (list: CodeSymbol[]) => {
    for (const sym of list) {
      result.push(sym);
      if (sym.children && sym.children.length > 0) {
        walk(sym.children);
      }
    }
  };
  walk(symbols);
  return result;
}

function findEnclosingSymbol(
  flatSymbols: CodeSymbol[],
  line: number,
): CodeSymbol | null {
  let best: CodeSymbol | null = null;
  for (const sym of flatSymbols) {
    if (sym.startLine <= line && sym.endLine >= line) {
      if (
        !best ||
        sym.endLine - sym.startLine <= best.endLine - best.startLine
      ) {
        best = sym;
      }
    }
  }
  return best;
}

function getLineNumberFromNode(node: Node | null): number | null {
  let cur: Node | null = node;
  while (cur) {
    if (cur instanceof HTMLElement && cur.dataset.lineNumber) {
      const parsed = Number.parseInt(cur.dataset.lineNumber, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
    cur = cur.parentNode;
  }
  return null;
}

function extractIdentifierAtPoint(
  clientX: number,
  clientY: number,
  fallbackTarget: EventTarget | null,
): string | null {
  const doc = window.document;
  let textNode: Node | null = null;
  let offset = 0;

  const docAny = doc as unknown as {
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };

  if (typeof docAny.caretPositionFromPoint === "function") {
    const pos = docAny.caretPositionFromPoint(clientX, clientY);
    if (pos) {
      textNode = pos.offsetNode;
      offset = pos.offset;
    }
  } else if (typeof docAny.caretRangeFromPoint === "function") {
    const range = docAny.caretRangeFromPoint(clientX, clientY);
    if (range) {
      textNode = range.startContainer;
      offset = range.startOffset;
    }
  }

  if (textNode && textNode.nodeType === Node.TEXT_NODE) {
    const text = textNode.textContent ?? "";
    const isWord = (ch: string) => /[A-Za-z0-9_$]/.test(ch);
    let left = Math.min(offset, text.length);
    let right = left;
    while (left > 0 && isWord(text[left - 1] ?? "")) left--;
    while (right < text.length && isWord(text[right] ?? "")) right++;
    const word = text.slice(left, right);
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(word)) {
      return word;
    }
  }

  if (fallbackTarget instanceof HTMLElement) {
    const raw = fallbackTarget.textContent?.trim() ?? "";
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(raw)) {
      return raw;
    }
  }

  return null;
}

function renderLineTokensWithMatches(
  lineText: string,
  tokens: TokenSpan[] | undefined,
  lineMatches: FindMatch[],
  activeMatch: FindMatch | null,
): React.ReactNode {
  if (!lineText) return "\u00A0";

  // Build uniform segments with optional token class
  const baseSegments: Array<{ text: string; cls?: TokenSpan["cls"] }> =
    tokens && tokens.length > 0
      ? tokens.map((t) => ({ text: t.text, cls: t.cls }))
      : [{ text: lineText }];

  if (lineMatches.length === 0) {
    return baseSegments.map((seg, idx) =>
      seg.cls ? (
        <span key={idx} className={`tok-${seg.cls}`}>
          {seg.text}
        </span>
      ) : (
        <React.Fragment key={idx}>{seg.text}</React.Fragment>
      ),
    );
  }

  // Split segments across match boundaries
  const output: React.ReactNode[] = [];
  let cursor = 0;
  let matchIdx = 0;
  let keyCounter = 0;

  for (const seg of baseSegments) {
    const segStart = cursor;
    const segEnd = cursor + seg.text.length;
    let pos = segStart;

    while (pos < segEnd) {
      while (
        matchIdx < lineMatches.length &&
        lineMatches[matchIdx]!.end <= pos
      ) {
        matchIdx++;
      }

      const m = lineMatches[matchIdx];
      if (!m || m.start >= segEnd) {
        const chunk = seg.text.slice(pos - segStart);
        output.push(
          seg.cls ? (
            <span key={keyCounter++} className={`tok-${seg.cls}`}>
              {chunk}
            </span>
          ) : (
            <React.Fragment key={keyCounter++}>{chunk}</React.Fragment>
          ),
        );
        pos = segEnd;
      } else if (pos < m.start) {
        const nextStop = Math.min(m.start, segEnd);
        const chunk = seg.text.slice(pos - segStart, nextStop - segStart);
        output.push(
          seg.cls ? (
            <span key={keyCounter++} className={`tok-${seg.cls}`}>
              {chunk}
            </span>
          ) : (
            <React.Fragment key={keyCounter++}>{chunk}</React.Fragment>
          ),
        );
        pos = nextStop;
      } else {
        const nextStop = Math.min(m.end, segEnd);
        const chunk = seg.text.slice(pos - segStart, nextStop - segStart);
        const isActive =
          activeMatch !== null &&
          activeMatch.line === m.line &&
          activeMatch.start === m.start &&
          activeMatch.end === m.end;
        output.push(
          <mark
            key={keyCounter++}
            className={`code-find-match ${isActive ? "active" : ""} ${
              seg.cls ? `tok-${seg.cls}` : ""
            }`}
          >
            {chunk}
          </mark>,
        );
        pos = nextStop;
      }
    }

    cursor = segEnd;
  }

  return output;
}

export const CodeViewport = forwardRef<CodeViewportHandle, CodeViewportProps>(
  (
    {
      document: doc,
      symbols = [],
      blame,
      showBlame = false,
      annotations = [],
      activeLine,
      scrollToRequest,
      recentlyUpdatedAt,
      onCreateAnnotation,
      onUpdateAnnotation,
      onResolveAnnotation,
      onUnresolveAnnotation,
      onDeleteAnnotation,
      onSymbolActivate,
      onCursorChange,
      onVisibleLineChange,
      findOpenTrigger,
      annotateTrigger,
      fontSizePx = 13.5,
      spotlight = null,
    },
    ref,
  ) => {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const findInputRef = useRef<HTMLInputElement | null>(null);
    const selectionAnchorRef = useRef<number | null>(null);

    const [cursorLine, setCursorLine] = useState<number>(activeLine ?? 1);
    const [selectedRange, setSelectedRange] = useState<{
      startLine: number;
      endLine: number;
    } | null>(null);
    const [selectedIdentifier, setSelectedIdentifier] = useState<string | null>(
      null,
    );
    const [composerRange, setComposerRange] = useState<{
      startLine: number;
      endLine: number;
    } | null>(null);
    const [flashedLine, setFlashedLine] = useState<number | null>(null);
    const [updatedPulse, setUpdatedPulse] = useState<boolean>(false);

    // Find in file state
    const [findOpen, setFindOpen] = useState<boolean>(false);
    const [findQuery, setFindQuery] = useState<string>("");
    const [caseSensitive, setCaseSensitive] = useState<boolean>(false);
    const [activeMatchIndex, setActiveMatchIndex] = useState<number>(0);

    const lineHeightPx = Math.round(fontSizePx * 1.5);

    const virtualizer = useVirtualizer({
      count: doc.lines.length,
      getScrollElement: () => scrollRef.current,
      estimateSize: () => lineHeightPx,
      overscan: 18,
    });

    const scrollToLine = useCallback(
      (
        line: number,
        options?: {
          flash?: boolean;
          column?: number;
          align?: "start" | "center" | "auto";
        },
      ) => {
        if (doc.lines.length === 0) return;
        const clamped = Math.max(1, Math.min(doc.lines.length, line));
        virtualizer.scrollToIndex(clamped - 1, {
          align: options?.align ?? "center",
        });
        setCursorLine(clamped);
        onCursorChange?.({
          line: clamped,
          column: options?.column ?? 1,
        });
        if (options?.flash) {
          setFlashedLine(clamped);
        }
      },
      [doc.lines.length, virtualizer, onCursorChange],
    );

    const openComposerForRange = useCallback(
      (startLine: number, endLine: number) => {
        if (!onCreateAnnotation) return;
        const s = Math.max(1, Math.min(startLine, endLine));
        const e = Math.min(doc.lines.length || 1, Math.max(startLine, endLine));
        setComposerRange({ startLine: s, endLine: e });
        setSelectedRange({ startLine: s, endLine: e });
        virtualizer.scrollToIndex(e - 1, { align: "center" });
      },
      [doc.lines.length, onCreateAnnotation, virtualizer],
    );

    useImperativeHandle(
      ref,
      () => ({
        scrollToLine,
        openFind: () => {
          setFindOpen(true);
          requestAnimationFrame(() => {
            findInputRef.current?.focus();
            findInputRef.current?.select();
          });
        },
        openComposerAtSelection: () => {
          const range = selectedRange ?? {
            startLine: cursorLine,
            endLine: cursorLine,
          };
          openComposerForRange(range.startLine, range.endLine);
        },
      }),
      [scrollToLine, selectedRange, cursorLine, openComposerForRange],
    );

    // Sync activeLine prop
    useEffect(() => {
      if (activeLine && activeLine !== cursorLine) {
        setCursorLine(activeLine);
      }
    }, [activeLine]);

    // External scrollToRequest
    useEffect(() => {
      if (!scrollToRequest) return;
      scrollToLine(scrollToRequest.line, {
        flash: scrollToRequest.flash ?? true,
        column: scrollToRequest.column,
      });
    }, [scrollToRequest?.seq, scrollToRequest?.line]);

    // Walkthrough spotlight auto-scroll
    useEffect(() => {
      if (!spotlight || doc.lines.length === 0) return;
      const anchor = Math.max(1, Math.min(doc.lines.length, spotlight.endLine));
      virtualizer.scrollToIndex(anchor - 1, { align: "center" });
    }, [spotlight?.seq, spotlight?.startLine, spotlight?.endLine, doc.lines.length]);

    // Flash decay
    useEffect(() => {
      if (flashedLine === null) return;
      const timer = window.setTimeout(() => setFlashedLine(null), 1250);
      return () => window.clearTimeout(timer);
    }, [flashedLine]);

    // Recently updated pulse (from external agent edit)
    useEffect(() => {
      if (!recentlyUpdatedAt) return;
      setUpdatedPulse(true);
      const timer = window.setTimeout(() => setUpdatedPulse(false), 1150);
      return () => window.clearTimeout(timer);
    }, [recentlyUpdatedAt]);

    // External find trigger
    useEffect(() => {
      if (!findOpenTrigger) return;
      setFindOpen(true);
      requestAnimationFrame(() => {
        findInputRef.current?.focus();
        findInputRef.current?.select();
      });
    }, [findOpenTrigger]);

    // External annotate trigger
    useEffect(() => {
      if (!annotateTrigger) return;
      const range = selectedRange ?? {
        startLine: cursorLine,
        endLine: cursorLine,
      };
      openComposerForRange(range.startLine, range.endLine);
    }, [annotateTrigger]);

    // Compute Find matches
    const findMatches = useMemo<FindMatch[]>(() => {
      if (!findOpen || !findQuery) return [];
      const needle = caseSensitive ? findQuery : findQuery.toLowerCase();
      if (!needle) return [];
      const hits: FindMatch[] = [];
      for (let i = 0; i < doc.lines.length; i++) {
        const rawLine = doc.lines[i] ?? "";
        const hay = caseSensitive ? rawLine : rawLine.toLowerCase();
        let idx = 0;
        while (idx <= hay.length - needle.length) {
          const found = hay.indexOf(needle, idx);
          if (found === -1) break;
          hits.push({
            line: i + 1,
            start: found,
            end: found + needle.length,
          });
          idx = found + Math.max(1, needle.length);
          if (hits.length >= 5000) return hits;
        }
      }
      return hits;
    }, [findOpen, findQuery, caseSensitive, doc.lines]);

    const matchesByLine = useMemo(() => {
      const map = new Map<number, FindMatch[]>();
      for (const m of findMatches) {
        const existing = map.get(m.line);
        if (existing) existing.push(m);
        else map.set(m.line, [m]);
      }
      return map;
    }, [findMatches]);

    useEffect(() => {
      if (findMatches.length === 0) {
        setActiveMatchIndex(0);
        return;
      }
      const nextIdx = Math.min(activeMatchIndex, findMatches.length - 1);
      setActiveMatchIndex(nextIdx);
      const match = findMatches[nextIdx];
      if (match) {
        virtualizer.scrollToIndex(match.line - 1, { align: "center" });
      }
    }, [findQuery, caseSensitive, doc.contentHash]);

    const stepMatch = useCallback(
      (delta: 1 | -1) => {
        if (findMatches.length === 0) return;
        const next =
          (activeMatchIndex + delta + findMatches.length) % findMatches.length;
        setActiveMatchIndex(next);
        const match = findMatches[next];
        if (match) {
          virtualizer.scrollToIndex(match.line - 1, { align: "center" });
          setCursorLine(match.line);
        }
      },
      [findMatches, activeMatchIndex, virtualizer],
    );

    // Group annotations by anchor line (endLine ?? startLine) and track gutter markers
    const { threadsByLine, gutterByLine } = useMemo(() => {
      const threads = new Map<number, Annotation[]>();
      const gutter = new Map<number, Annotation[]>();
      const maxLine = Math.max(1, doc.lines.length);

      for (const ann of annotations) {
        if (ann.side === "old") continue;
        const start = Math.max(1, Math.min(maxLine, ann.startLine ?? 1));
        const end = Math.max(start, Math.min(maxLine, ann.endLine ?? start));

        const tList = threads.get(end);
        if (tList) tList.push(ann);
        else threads.set(end, [ann]);

        const gList = gutter.get(start);
        if (gList) gList.push(ann);
        else gutter.set(start, [ann]);
      }
      return { threadsByLine: threads, gutterByLine: gutter };
    }, [annotations, doc.lines.length]);

    const flatSymbols = useMemo(() => flattenSymbols(symbols), [symbols]);

    const virtualItems = virtualizer.getVirtualItems();
    const firstVisibleLine =
      virtualItems.length > 0 ? virtualItems[0]!.index + 1 : 1;

    useEffect(() => {
      onVisibleLineChange?.(firstVisibleLine);
    }, [firstVisibleLine, onVisibleLineChange]);

    const enclosingSymbol = useMemo(
      () => findEnclosingSymbol(flatSymbols, firstVisibleLine),
      [flatSymbols, firstVisibleLine],
    );

    const handleLineNumberClick = (
      e: React.MouseEvent,
      lineNumber: number,
    ) => {
      e.stopPropagation();
      if (e.shiftKey && selectionAnchorRef.current !== null) {
        const anchor = selectionAnchorRef.current;
        const s = Math.min(anchor, lineNumber);
        const end = Math.max(anchor, lineNumber);
        setSelectedRange({ startLine: s, endLine: end });
        setCursorLine(lineNumber);
        onCursorChange?.({
          line: lineNumber,
          column: 1,
          startLine: s,
          endLine: end,
        });
      } else {
        selectionAnchorRef.current = lineNumber;
        setSelectedRange({ startLine: lineNumber, endLine: lineNumber });
        setCursorLine(lineNumber);
        onCursorChange?.({
          line: lineNumber,
          column: 1,
          startLine: lineNumber,
          endLine: lineNumber,
        });
      }
    };

    const handleCodeMouseUp = (e: React.MouseEvent) => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) {
        const sLine = getLineNumberFromNode(sel.anchorNode);
        const eLine = getLineNumberFromNode(sel.focusNode);
        if (sLine !== null && eLine !== null) {
          const startLine = Math.min(sLine, eLine);
          const endLine = Math.max(sLine, eLine);
          selectionAnchorRef.current = startLine;
          setSelectedRange({ startLine, endLine });
          setCursorLine(eLine);
          const selectedStr = sel.toString().trim();
          if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(selectedStr)) {
            setSelectedIdentifier(selectedStr);
          } else {
            setSelectedIdentifier(null);
          }
          onCursorChange?.({
            line: eLine,
            column: 1,
            startLine,
            endLine,
          });
          return;
        }
      }

      const lineNum = getLineNumberFromNode(e.target as Node);
      if (lineNum !== null) {
        const ident = extractIdentifierAtPoint(e.clientX, e.clientY, e.target);
        setSelectedIdentifier(ident);
        setCursorLine(lineNum);
        if ((e.metaKey || e.ctrlKey) && ident && onSymbolActivate) {
          e.preventDefault();
          onSymbolActivate({
            symbolName: ident,
            line: lineNum,
            mode: "definition",
          });
        } else {
          onCursorChange?.({ line: lineNum, column: 1 });
        }
      }
    };

    const handleViewportKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "f") {
        e.preventDefault();
        e.stopPropagation();
        setFindOpen(true);
        requestAnimationFrame(() => {
          findInputRef.current?.focus();
          findInputRef.current?.select();
        });
      } else if (
        (mod && e.key === "/") ||
        (mod && e.altKey && e.key.toLowerCase() === "m")
      ) {
        if (onCreateAnnotation) {
          e.preventDefault();
          e.stopPropagation();
          const range = selectedRange ?? {
            startLine: cursorLine,
            endLine: cursorLine,
          };
          openComposerForRange(range.startLine, range.endLine);
        }
      } else if (e.altKey && e.key === "F7") {
        if (selectedIdentifier && onSymbolActivate) {
          e.preventDefault();
          e.stopPropagation();
          onSymbolActivate({
            symbolName: selectedIdentifier,
            line: cursorLine,
            mode: "usages",
          });
        }
      } else if (e.key === "Escape") {
        if (findOpen) {
          e.stopPropagation();
          setFindOpen(false);
          rootRef.current?.focus();
        } else if (composerRange) {
          e.stopPropagation();
          setComposerRange(null);
        } else if (selectedRange) {
          setSelectedRange(null);
        }
      }
    };

    const handleSubmitAnnotation = async (data: {
      comment: string;
    }) => {
      if (!composerRange || !onCreateAnnotation) return;
      const { startLine, endLine } = composerRange;
      const selectedText = doc.lines.slice(startLine - 1, endLine).join("\n");
      const contextBefore = doc.lines
        .slice(Math.max(0, startLine - 3), startLine - 1)
        .join("\n");
      const contextAfter = doc.lines
        .slice(endLine, Math.min(doc.lines.length, endLine + 2))
        .join("\n");

      await onCreateAnnotation({
        startLine,
        endLine,
        selectedText,
        contextBefore,
        contextAfter,
        comment: data.comment,
      });
      setComposerRange(null);
    };

    const activeMatch =
      findMatches.length > 0 ? findMatches[activeMatchIndex] ?? null : null;

    if (doc.isBinary) {
      return (
        <div ref={rootRef} className="code-viewport" tabIndex={0}>
          <div className="code-binary-placeholder">
            <span className="statusline-badge">BINARY FILE</span>
            <span>
              {doc.filePath} ({doc.byteLength.toLocaleString()} bytes)
            </span>
            <span style={{ color: "var(--off)", fontSize: 12 }}>
              Read-only text viewport disabled for binary assets.
            </span>
          </div>
        </div>
      );
    }

    return (
      <div
        ref={rootRef}
        className={`code-viewport ${updatedPulse ? "pulse-updated" : ""} ${spotlight ? "has-spotlight" : ""}`}
        tabIndex={0}
        onKeyDown={handleViewportKeyDown}
      >
        {/* Sticky Enclosing Symbol Bar */}
        <div className="code-sticky-symbol">
          {enclosingSymbol ? (
            <button
              type="button"
              className="code-sticky-btn"
              title={`Jump to ${enclosingSymbol.name} at line ${enclosingSymbol.startLine}`}
              onClick={() =>
                scrollToLine(enclosingSymbol.startLine, { flash: true })
              }
            >
              <span className="code-sticky-prefix">┌─</span>
              <span className="code-sticky-kind">
                {SYMBOL_KIND_PREFIX[enclosingSymbol.kind]}
              </span>
              <span className="code-sticky-name">{enclosingSymbol.name}</span>
              {enclosingSymbol.detail && (
                <span>{enclosingSymbol.detail}</span>
              )}
              <span className="code-sticky-line">
                :L{enclosingSymbol.startLine}
              </span>
            </button>
          ) : (
            <span style={{ color: "var(--off)" }}>
              ┌─ {doc.filePath} · {doc.lines.length} lines
            </span>
          )}
          <span style={{ color: "var(--off)", fontSize: 11 }}>
            READ-ONLY · {doc.language.toUpperCase()}
          </span>
        </div>

        {doc.isTruncated && (
          <div className="code-truncated-banner">
            ▲ FILE TRUNCATED AT {doc.byteLength.toLocaleString()} BYTES FOR FAST
            READ-ONLY VIEWING
          </div>
        )}

        {/* Non-Modal Find in File Bar */}
        {findOpen && (
          <div className="code-find-bar" onClick={(e) => e.stopPropagation()}>
            <input
              ref={findInputRef}
              type="text"
              className="code-find-input"
              placeholder="Find in file..."
              value={findQuery}
              onChange={(e) => setFindQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  stepMatch(e.shiftKey ? -1 : 1);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setFindOpen(false);
                  rootRef.current?.focus();
                }
              }}
            />
            <button
              type="button"
              className={`btn ${caseSensitive ? "btn-primary" : ""}`}
              title="Match Case"
              onClick={() => setCaseSensitive((v) => !v)}
            >
              Aa
            </button>
            <span className="code-find-count">
              {findQuery
                ? findMatches.length > 0
                  ? `${activeMatchIndex + 1}/${findMatches.length}`
                  : "0/0"
                : "—"}
            </span>
            <button
              type="button"
              className="btn"
              title="Previous Match (Shift+Enter)"
              onClick={() => stepMatch(-1)}
              disabled={findMatches.length === 0}
            >
              ↑
            </button>
            <button
              type="button"
              className="btn"
              title="Next Match (Enter)"
              onClick={() => stepMatch(1)}
              disabled={findMatches.length === 0}
            >
              ↓
            </button>
            <button
              type="button"
              className="btn"
              title="Close (Esc)"
              onClick={() => {
                setFindOpen(false);
                rootRef.current?.focus();
              }}
            >
              ×
            </button>
          </div>
        )}

        {/* Floating Selection Action Bar */}
        {selectedRange && !composerRange && (onCreateAnnotation || selectedIdentifier) && (
          <div
            className="code-selection-bar"
            onClick={(e) => e.stopPropagation()}
          >
            {onCreateAnnotation && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() =>
                  openComposerForRange(
                    selectedRange.startLine,
                    selectedRange.endLine,
                  )
                }
              >
                + Annotate{" "}
                {selectedRange.startLine === selectedRange.endLine
                  ? `L${selectedRange.startLine}`
                  : `L${selectedRange.startLine}-${selectedRange.endLine}`}{" "}
                (⌘/)
              </button>
            )}
            {selectedIdentifier && onSymbolActivate && (
              <button
                type="button"
                className="btn"
                onClick={() =>
                  onSymbolActivate({
                    symbolName: selectedIdentifier,
                    line: cursorLine,
                    mode: "usages",
                  })
                }
              >
                Usages: {selectedIdentifier} (⌥F7)
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setSelectedRange(null)}
            >
              ×
            </button>
          </div>
        )}

        {/* Virtualized Code Canvas */}
        <div
          ref={scrollRef}
          className="code-scroll"
          style={{
            fontSize: `${fontSizePx}px`,
            lineHeight: "1.5",
          }}
          onMouseUp={handleCodeMouseUp}
        >
          <div
            className="code-virtual-canvas"
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          >
            {virtualItems.map((virtualRow) => {
              const lineIndex = virtualRow.index;
              const lineNumber = lineIndex + 1;
              const lineText = doc.lines[lineIndex] ?? "";
              const lineTokens = doc.tokens?.[lineIndex];
              const gitMarker = doc.lineGitMarkers?.[lineNumber];
              const blameEntry = showBlame ? blame?.[lineIndex] : undefined;
              const gutterAnns = gutterByLine.get(lineNumber) ?? [];
              const threadAnns = threadsByLine.get(lineNumber) ?? [];
              const showComposerHere = composerRange?.endLine === lineNumber;

              const isSelected =
                selectedRange !== null &&
                lineNumber >= selectedRange.startLine &&
                lineNumber <= selectedRange.endLine;
              const isCurrent = cursorLine === lineNumber;
              const isFlashed = flashedLine === lineNumber;
              const isLineUpdated =
                updatedPulse &&
                (gitMarker === "added" || gitMarker === "modified");
              const isSpotlighted =
                spotlight !== null &&
                lineNumber >= spotlight.startLine &&
                lineNumber <= spotlight.endLine;
              const spotlightAnchorLine = spotlight
                ? Math.max(1, Math.min(doc.lines.length, spotlight.endLine))
                : null;
              const showSpotlightCardHere =
                spotlightAnchorLine === lineNumber && Boolean(spotlight?.card);

              const lineMatches = matchesByLine.get(lineNumber) ?? [];

              const leadAnn =
                gutterAnns.find((a) => a.status !== "resolved") ??
                gutterAnns[0];

              return (
                <div
                  key={virtualRow.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualRow.index}
                  className="code-row"
                  style={{
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <div
                    data-line-number={lineNumber}
                    className={[
                      "code-line",
                      isCurrent ? "current" : "",
                      isSelected ? "selected" : "",
                      isFlashed ? "flash" : "",
                      isLineUpdated ? "pulse-updated" : "",
                      isSpotlighted ? "tour-spotlight" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    {/* 3-Lane VIM/JetBrains Gutter */}
                    <div className="code-gutter">
                      {/* Lane 1: Git marker */}
                      <div
                        className={`code-git-marker ${gitMarker ?? ""}`}
                        title={
                          gitMarker === "added"
                            ? "Added line"
                            : gitMarker === "modified"
                              ? "Modified line"
                              : gitMarker === "deleted-after"
                                ? "Lines deleted after this line"
                                : undefined
                        }
                      />

                      {/* Lane 2: Annotation Diamond or Hover + */}
                      <div className="code-ann-lane">
                        {leadAnn ? (
                          <button
                            type="button"
                            className={`code-ann-diamond ${
                              leadAnn.status === "resolved" ? "resolved" : ""
                            }`}
                            title={`${gutterAnns.length} annotation(s) — click to add another`}
                            onClick={(e) => {
                              e.stopPropagation();
                              openComposerForRange(
                                lineNumber,
                                leadAnn.endLine ?? lineNumber,
                              );
                            }}
                          >
                            ◆
                          </button>
                        ) : (
                          onCreateAnnotation && (
                            <button
                              type="button"
                              className="code-ann-add"
                              title={`Annotate line ${lineNumber}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                openComposerForRange(lineNumber, lineNumber);
                              }}
                            >
                              +
                            </button>
                          )
                        )}
                      </div>

                      {/* Optional Git Blame Column */}
                      {showBlame && (
                        <div
                          className="code-blame-col"
                          title={
                            blameEntry
                              ? `${blameEntry.sha} · ${blameEntry.author} (${blameEntry.relativeTime}): ${blameEntry.summary}`
                              : undefined
                          }
                        >
                          {blameEntry ? (
                            <>
                              <span className="code-blame-sha">
                                {blameEntry.sha.slice(0, 6)}
                              </span>
                              <span className="code-blame-author">
                                {blameEntry.author}
                              </span>
                              <span className="code-blame-time">
                                {blameEntry.relativeTime}
                              </span>
                            </>
                          ) : (
                            <span>—</span>
                          )}
                        </div>
                      )}

                      {/* Lane 3: Line Number */}
                      <div
                        className="code-lineno"
                        onClick={(e) => handleLineNumberClick(e, lineNumber)}
                        title={`Select line ${lineNumber} (Shift+click for range)`}
                      >
                        {lineNumber}
                      </div>
                    </div>

                    {/* Code Line Content */}
                    <div className="code-content">
                      {renderLineTokensWithMatches(
                        lineText,
                        lineTokens,
                        lineMatches,
                        activeMatch,
                      )}
                    </div>
                  </div>

                  {/* Inline Annotation Thread, Walkthrough Card & Composer */}
                  {(threadAnns.length > 0 || showComposerHere || showSpotlightCardHere) && (
                    <div className="code-inline-slot">
                      {showSpotlightCardHere && spotlight?.card}
                      {threadAnns.length > 0 && (
                        <AnnotationThreadCard
                          annotations={threadAnns}
                          compact
                          onEdit={onUpdateAnnotation}
                          onResolve={onResolveAnnotation}
                          onUnresolve={onUnresolveAnnotation}
                          onDelete={onDeleteAnnotation}
                          onJumpTo={(ann) =>
                            scrollToLine(ann.startLine ?? lineNumber, {
                              flash: true,
                            })
                          }
                        />
                      )}
                      {showComposerHere && composerRange && (
                        <div style={{ marginTop: threadAnns.length > 0 ? 6 : 0 }}>
                          <AnnotationComposer
                            filePath={doc.filePath}
                            side="new"
                            startLine={composerRange.startLine}
                            endLine={composerRange.endLine}
                            selectedPreview={doc.lines
                              .slice(
                                composerRange.startLine - 1,
                                composerRange.endLine,
                              )
                              .join("\n")}
                            onSubmit={handleSubmitAnnotation}
                            onCancel={() => setComposerRange(null)}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  },
);

CodeViewport.displayName = "CodeViewport";
