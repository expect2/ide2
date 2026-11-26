import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Annotation, WorktreeInfo } from "../../shared/protocol.js";
import { Expect2Wordmark, IconGitBranch } from "../components/BrandMark.js";
import { formatShortcut, type Platform } from "./keymap.js";

export const MORPH_FRAMES = ["◻", "▣", "◼", "▣"] as const;
export const ACTIVE_WINDOW_MS = 8000;
export const MORPH_INTERVAL_MS = 160;

export interface WorktreeStripProps {
  worktrees: readonly WorktreeInfo[];
  activeWorktreePath: string;
  annotations: readonly Annotation[];
  platform: Platform;
  onSelectWorktree: (worktreePath: string) => void;
  onCreateWorktree: (params: {
    baseWorktreePath: string;
    branchName: string;
    baseRef?: string;
  }) => Promise<WorktreeInfo | void>;
  onCopyText: (text: string) => void | Promise<void>;
  onRevealInOs: (targetPath: string) => void | Promise<void>;
  onOpenSearchEverywhere?: () => void;
  onOpenSwitchWorktree?: () => void;
}

interface ContextMenuState {
  worktree: WorktreeInfo;
  x: number;
  y: number;
}

export function formatRelativeActivity(lastActivityAt: number, now: number): string {
  if (!lastActivityAt || lastActivityAt <= 0) return "idle";
  const diffSec = Math.max(0, Math.floor((now - lastActivityAt) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  return `${Math.floor(diffHr / 24)}d`;
}

function getWorktreeChangedCount(wt: WorktreeInfo): number {
  const { modified, added, deleted, untracked, conflicted, branchChanged } = wt.counts;
  return branchChanged > 0
    ? branchChanged
    : modified + added + deleted + untracked + conflicted;
}

export const WorktreeStrip: React.FC<WorktreeStripProps> = ({
  worktrees,
  activeWorktreePath,
  annotations,
  platform,
  onSelectWorktree,
  onCreateWorktree,
  onCopyText,
  onRevealInOs,
  onOpenSearchEverywhere,
}) => {
  const [now, setNow] = useState<number>(() => Date.now());
  const [morphFrame, setMorphFrame] = useState<number>(0);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [createOpen, setCreateOpen] = useState<boolean>(false);
  const [branchName, setBranchName] = useState<string>("");
  const [baseRef, setBaseRef] = useState<string>("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState<boolean>(false);
  const [hoveredWordmark, setHoveredWordmark] = useState<boolean>(false);
  const [hoveredPillPath, setHoveredPillPath] = useState<string | null>(null);
  const [hoveredAddBtn, setHoveredAddBtn] = useState<boolean>(false);
  const branchInputRef = useRef<HTMLInputElement | null>(null);

  const activeWorktree = useMemo(
    () => worktrees.find((w) => w.path === activeWorktreePath) ?? worktrees[0],
    [worktrees, activeWorktreePath],
  );

  const hasRecentActivity = useMemo(
    () => worktrees.some((wt) => now - wt.lastActivityAt < ACTIVE_WINDOW_MS),
    [worktrees, now],
  );

  useEffect(() => {
    setNow(Date.now());
  }, [worktrees]);

  useEffect(() => {
    if (!hasRecentActivity) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      setMorphFrame((prev) => (prev + 1) % MORPH_FRAMES.length);
    }, MORPH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [hasRecentActivity]);

  useEffect(() => {
    if (!contextMenu) return;
    const handleGlobalClick = () => setContextMenu(null);
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };
    window.addEventListener("click", handleGlobalClick);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("click", handleGlobalClick);
      window.removeEventListener("keydown", handleKey);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (createOpen) {
      setBaseRef(activeWorktree?.baseRef || activeWorktree?.branch || "main");
      setBranchName("");
      setCreateError(null);
      window.setTimeout(() => branchInputRef.current?.focus(), 0);
    }
  }, [createOpen, activeWorktree?.baseRef, activeWorktree?.branch]);

  const openAnnotationsByWorktree = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ann of annotations) {
      if (ann.status === "open") {
        counts.set(ann.worktreePath, (counts.get(ann.worktreePath) ?? 0) + 1);
      }
    }
    return counts;
  }, [annotations]);

  const handleOpenContextMenu = (
    e: React.MouseEvent,
    worktree: WorktreeInfo,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      worktree,
      x: e.clientX,
      y: e.clientY,
    });
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedBranch = branchName.trim();
    if (!trimmedBranch) {
      setCreateError("Branch name is required.");
      return;
    }
    if (!activeWorktree) {
      setCreateError("No active worktree found.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const created = await onCreateWorktree({
        baseWorktreePath: activeWorktree.path,
        branchName: trimmedBranch,
        baseRef: baseRef.trim() || undefined,
      });
      setCreateOpen(false);
      if (created?.path) {
        onSelectWorktree(created.path);
      }
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <header
      className="ide2-worktree-strip"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "0 12px",
        height: "40px",
        minHeight: "40px",
        background: "var(--paper)",
        borderBottom: "1px solid var(--faint)",
        fontFamily: "var(--ui-font)",
        fontSize: "12.5px",
        color: "var(--ink)",
        userSelect: "none",
        overflowX: "auto",
        boxSizing: "border-box",
      }}
    >
      {/* expect2 pixel-art wordmark with 4-colour echo trail */}
      <button
        type="button"
        className="ide2-wordmark"
        onClick={onOpenSearchEverywhere}
        onMouseEnter={() => setHoveredWordmark(true)}
        onMouseLeave={() => setHoveredWordmark(false)}
        title={
          onOpenSearchEverywhere
            ? `Search Everywhere (${formatShortcut("search-everywhere", platform)})`
            : "expect2 IDE (read-only)"
        }
        style={{
          display: "inline-flex",
          alignItems: "center",
          border: hoveredWordmark && onOpenSearchEverywhere
            ? "1px solid var(--faint)"
            : "1px solid transparent",
          background: hoveredWordmark && onOpenSearchEverywhere
            ? "var(--wash)"
            : "transparent",
          padding: "4px 7px",
          cursor: onOpenSearchEverywhere ? "pointer" : "default",
          borderRadius: "6px",
          flexShrink: 0,
          transition: "background 120ms ease, border-color 120ms ease",
        }}
      >
        <Expect2Wordmark height={18} withTrail={true} />
      </button>

      <div
        aria-hidden="true"
        style={{
          width: "1px",
          height: "18px",
          background: "var(--faint)",
          flexShrink: 0,
        }}
      />

      {/* Worktree Pills */}
      <div
        className="ide2-worktree-pills"
        role="tablist"
        aria-label="Git Worktrees"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "5px",
          flex: 1,
          minWidth: 0,
          overflowX: "auto",
        }}
      >
        {worktrees.map((wt) => {
          const isActive = wt.path === activeWorktreePath;
          const isHovered = hoveredPillPath === wt.path;
          const isLive = now - wt.lastActivityAt < ACTIVE_WINDOW_MS;
          const spinner = MORPH_FRAMES[morphFrame] ?? "▣";
          const changedCount = getWorktreeChangedCount(wt);
          const openAnnCount = openAnnotationsByWorktree.get(wt.path) ?? 0;

          return (
            <div
              key={wt.path}
              className={`ide2-worktree-pill${isActive ? " is-active" : ""}${isLive ? " is-live" : ""}`}
              onMouseEnter={() => setHoveredPillPath(wt.path)}
              onMouseLeave={() => setHoveredPillPath((cur) => (cur === wt.path ? null : cur))}
              style={{
                display: "inline-flex",
                alignItems: "stretch",
                height: "28px",
                border: isActive
                  ? "1px solid rgba(61, 107, 255, 0.45)"
                  : isHovered
                    ? "1px solid var(--border-strong)"
                    : "1px solid var(--faint)",
                background: isActive
                  ? "var(--selection, #2e436e)"
                  : isHovered
                    ? "var(--wash-hi)"
                    : "var(--wash)",
                color: isActive
                  ? "#ffffff"
                  : isHovered
                    ? "var(--ink)"
                    : "var(--dim)",
                flexShrink: 0,
                borderRadius: "6px",
                transition: "background 120ms ease, border-color 120ms ease, color 120ms ease",
              }}
              onContextMenu={(e) => handleOpenContextMenu(e, wt)}
            >
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => onSelectWorktree(wt.path)}
                title={`${wt.name} · ${wt.branch} (${wt.path}) — right-click for actions`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "0 8px",
                  background: "transparent",
                  color: "inherit",
                  border: "none",
                  fontFamily: "var(--ui-font)",
                  fontSize: "12px",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    color: isActive ? "#9bb8ff" : "var(--dim)",
                  }}
                >
                  <IconGitBranch size={13} />
                </span>

                <span
                  style={{
                    fontWeight: isActive ? 600 : 500,
                    color: isActive ? "#ffffff" : "var(--ink)",
                  }}
                >
                  {wt.name}
                </span>

                <span
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: "11px",
                    color: isActive ? "rgba(255, 255, 255, 0.78)" : "var(--dim)",
                  }}
                >
                  {wt.branch}
                  {wt.ahead > 0 ? ` ↑${wt.ahead}` : ""}
                </span>

                {isLive && (
                  <span
                    className="ide2-morph-spinner"
                    title={`Agent activity ${formatRelativeActivity(wt.lastActivityAt, now)} ago`}
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: "11px",
                      color: "var(--unknown)",
                      fontWeight: 700,
                    }}
                  >
                    {spinner}
                  </span>
                )}

                {changedCount > 0 ? (
                  <span
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: "11px",
                      color: "var(--unknown)",
                      fontWeight: 600,
                    }}
                  >
                    ~{changedCount}
                  </span>
                ) : (
                  <span
                    style={{
                      fontSize: "11px",
                      color: "var(--safe)",
                      opacity: isActive ? 0.92 : 0.8,
                      fontWeight: 500,
                    }}
                  >
                    clean
                  </span>
                )}

                {wt.counts.conflicted > 0 && (
                  <span
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: "11px",
                      color: "var(--unsafe)",
                      fontWeight: 700,
                    }}
                  >
                    !{wt.counts.conflicted}
                  </span>
                )}

                {openAnnCount > 0 && (
                  <span
                    title={`${openAnnCount} open annotation(s)`}
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: "11px",
                      color: isActive ? "#b8d0ff" : "#7fa4ff",
                      background: isActive
                        ? "rgba(255, 255, 255, 0.14)"
                        : "var(--sky-bg)",
                      padding: "0 5px",
                      borderRadius: "4px",
                      fontWeight: 600,
                    }}
                  >
                    ◆{openAnnCount}
                  </span>
                )}
              </button>

              <button
                type="button"
                aria-label={`Actions for ${wt.name}`}
                onClick={(e) => handleOpenContextMenu(e, wt)}
                title="Worktree actions (Copy Path, Reveal in OS)"
                style={{
                  border: "none",
                  borderLeft: isActive
                    ? "1px solid rgba(255, 255, 255, 0.16)"
                    : "1px solid var(--faint)",
                  background: "transparent",
                  color: isActive ? "rgba(255, 255, 255, 0.8)" : "var(--dim)",
                  padding: "0 6px",
                  cursor: "pointer",
                  fontFamily: "var(--ui-font)",
                  fontSize: "12px",
                  borderRadius: "0 5px 5px 0",
                }}
              >
                ⋯
              </button>
            </div>
          );
        })}
      </div>

      {/* + Worktree Pill Button */}
      <button
        type="button"
        className="ide2-add-worktree-btn"
        onClick={() => setCreateOpen(true)}
        onMouseEnter={() => setHoveredAddBtn(true)}
        onMouseLeave={() => setHoveredAddBtn(false)}
        title="Create new git worktree (git worktree add)"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "4px",
          height: "28px",
          padding: "0 10px",
          background: hoveredAddBtn ? "var(--wash-hi)" : "var(--wash)",
          border: hoveredAddBtn
            ? "1px solid var(--border-strong)"
            : "1px solid var(--faint)",
          color: "var(--ink)",
          fontFamily: "var(--ui-font)",
          fontSize: "12px",
          fontWeight: 500,
          cursor: "pointer",
          borderRadius: "6px",
          flexShrink: 0,
          transition: "background 120ms ease, border-color 120ms ease",
        }}
      >
        + Worktree
      </button>

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="ide2-context-menu"
          role="menu"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "fixed",
            left: `${contextMenu.x}px`,
            top: `${contextMenu.y}px`,
            zIndex: 1200,
            background: "var(--wash)",
            border: "1px solid var(--border-strong)",
            borderRadius: "8px",
            boxShadow: "var(--shadow-popup)",
            minWidth: "210px",
            padding: "4px",
            fontFamily: "var(--ui-font)",
            fontSize: "12.5px",
          }}
        >
          <div
            style={{
              padding: "5px 8px 6px",
              color: "var(--dim)",
              borderBottom: "1px solid var(--faint)",
              marginBottom: "3px",
              fontSize: "11px",
              display: "flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            <span style={{ color: "var(--ink)", fontWeight: 600 }}>
              {contextMenu.worktree.name}
            </span>
            <span style={{ fontFamily: "var(--mono)" }}>
              {contextMenu.worktree.branch}
            </span>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              void onCopyText(contextMenu.worktree.path);
              setContextMenu(null);
            }}
            style={menuItemStyle}
          >
            Copy Path
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              void onCopyText(`cd "${contextMenu.worktree.path.replace(/"/g, '\\"')}"`);
              setContextMenu(null);
            }}
            style={menuItemStyle}
          >
            Copy cd command
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              void onRevealInOs(contextMenu.worktree.path);
              setContextMenu(null);
            }}
            style={menuItemStyle}
          >
            Reveal in OS
          </button>
        </div>
      )}

      {/* Create Worktree Dialog */}
      {createOpen && (
        <div
          className="ide2-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Create New Git Worktree"
          onClick={() => setCreateOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(10, 12, 16, 0.64)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            paddingTop: "80px",
            zIndex: 1100,
          }}
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={handleCreateSubmit}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setCreateOpen(false);
              }
            }}
            style={{
              width: "440px",
              maxWidth: "92vw",
              background: "var(--wash)",
              border: "1px solid var(--border-strong)",
              borderRadius: "10px",
              boxShadow: "var(--shadow-modal)",
              overflow: "hidden",
              fontFamily: "var(--ui-font)",
              color: "var(--ink)",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              aria-hidden="true"
              style={{
                height: "2px",
                width: "100%",
                background: "var(--expect2-trail-bar)",
                flexShrink: 0,
              }}
            />

            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                borderBottom: "1px solid var(--faint)",
                padding: "10px 14px",
                background: "var(--paper)",
              }}
            >
              <span style={{ fontWeight: 600, fontSize: "13px", color: "var(--ink)" }}>
                New Git Worktree
              </span>
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                style={{
                  background: "var(--wash)",
                  border: "1px solid var(--border-strong)",
                  borderRadius: "5px",
                  color: "var(--dim)",
                  cursor: "pointer",
                  padding: "2px 7px",
                  fontFamily: "var(--mono)",
                  fontSize: "11px",
                }}
              >
                Esc
              </button>
            </div>

            <div
              style={{
                padding: "14px",
                display: "flex",
                flexDirection: "column",
                gap: "12px",
              }}
            >
              <label style={{ display: "flex", flexDirection: "column", gap: "5px", fontSize: "12px" }}>
                <span style={{ color: "var(--dim)", fontWeight: 500 }}>New Branch Name</span>
                <input
                  ref={branchInputRef}
                  type="text"
                  value={branchName}
                  onChange={(e) => setBranchName(e.target.value)}
                  placeholder="feat/agent-task"
                  style={inputStyle}
                  disabled={creating}
                />
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: "5px", fontSize: "12px" }}>
                <span style={{ color: "var(--dim)", fontWeight: 500 }}>Base Ref (optional)</span>
                <input
                  type="text"
                  value={baseRef}
                  onChange={(e) => setBaseRef(e.target.value)}
                  placeholder="main"
                  style={inputStyle}
                  disabled={creating}
                />
              </label>

              {createError && (
                <div
                  style={{
                    color: "var(--unsafe)",
                    background: "var(--unsafe-bg)",
                    border: "1px solid rgba(255, 93, 77, 0.35)",
                    borderRadius: "6px",
                    padding: "7px 10px",
                    fontSize: "12px",
                  }}
                >
                  {createError}
                </div>
              )}

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "4px" }}>
                <button
                  type="button"
                  onClick={() => setCreateOpen(false)}
                  disabled={creating}
                  style={{
                    background: "var(--screen)",
                    border: "1px solid var(--border-strong)",
                    borderRadius: "6px",
                    color: "var(--ink)",
                    padding: "6px 12px",
                    cursor: "pointer",
                    fontFamily: "var(--ui-font)",
                    fontSize: "12px",
                    fontWeight: 500,
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  style={{
                    background: "var(--accent, #3574f0)",
                    border: "1px solid var(--accent, #3574f0)",
                    borderRadius: "6px",
                    color: "#ffffff",
                    padding: "6px 14px",
                    cursor: creating ? "wait" : "pointer",
                    fontFamily: "var(--ui-font)",
                    fontSize: "12px",
                    fontWeight: 600,
                  }}
                >
                  {creating ? "Creating..." : "Create Worktree"}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}
    </header>
  );
};

const menuItemStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  background: "transparent",
  border: "none",
  borderRadius: "5px",
  color: "var(--ink)",
  padding: "6px 8px",
  cursor: "pointer",
  fontFamily: "var(--ui-font)",
  fontSize: "12px",
};

const inputStyle: React.CSSProperties = {
  background: "var(--screen)",
  border: "1px solid var(--border-strong)",
  borderRadius: "6px",
  color: "var(--ink)",
  padding: "7px 10px",
  fontFamily: "var(--mono)",
  fontSize: "12.5px",
  outline: "none",
};
