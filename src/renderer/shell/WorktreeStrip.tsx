import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Annotation, WorktreeInfo } from "../../shared/protocol.js";
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
        gap: "6px",
        padding: "4px 8px",
        background: "var(--paper, #05081a)",
        borderBottom: "1px solid var(--faint, #27326b)",
        fontFamily: "var(--mono, 'Kode Mono', monospace)",
        fontSize: "12px",
        color: "var(--ink, #f4f6ff)",
        userSelect: "none",
        overflowX: "auto",
        minHeight: "34px",
        boxSizing: "border-box",
      }}
    >
      {/* [expect2] wordmark badge */}
      <button
        type="button"
        className="ide2-wordmark"
        onClick={onOpenSearchEverywhere}
        title={
          onOpenSearchEverywhere
            ? `Search Everywhere (${formatShortcut("search-everywhere", platform)})`
            : "expect2 IDE (read-only)"
        }
        style={{
          display: "inline-flex",
          alignItems: "center",
          border: "1px solid var(--faint, #27326b)",
          background: "var(--screen, #0a0f2c)",
          color: "var(--ink, #f4f6ff)",
          padding: "2px 6px",
          fontFamily: "inherit",
          fontSize: "12px",
          fontWeight: 600,
          cursor: onOpenSearchEverywhere ? "pointer" : "default",
          borderRadius: 0,
          flexShrink: 0,
          letterSpacing: "0.02em",
        }}
      >
        <span>expect</span>
        <span
          style={{
            background: "var(--ink, #f4f6ff)",
            color: "var(--knock, #05081a)",
            padding: "0 3px",
            marginLeft: "2px",
            fontWeight: 700,
          }}
        >
          2
        </span>
      </button>

      {/* Worktree Pills */}
      <div
        className="ide2-worktree-pills"
        role="tablist"
        aria-label="Git Worktrees"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "4px",
          flex: 1,
          minWidth: 0,
          overflowX: "auto",
        }}
      >
        {worktrees.map((wt) => {
          const isActive = wt.path === activeWorktreePath;
          const isLive = now - wt.lastActivityAt < ACTIVE_WINDOW_MS;
          const spinner = MORPH_FRAMES[morphFrame] ?? "▣";
          const changedCount = getWorktreeChangedCount(wt);
          const openAnnCount = openAnnotationsByWorktree.get(wt.path) ?? 0;

          return (
            <div
              key={wt.path}
              className={`ide2-worktree-pill${isActive ? " is-active" : ""}${isLive ? " is-live" : ""}`}
              style={{
                display: "inline-flex",
                alignItems: "stretch",
                border: isActive
                  ? "1px solid var(--ink, #f4f6ff)"
                  : "1px solid var(--faint, #27326b)",
                background: isActive
                  ? "var(--ink, #f4f6ff)"
                  : "var(--screen, #0a0f2c)",
                color: isActive
                  ? "var(--knock, #05081a)"
                  : "var(--ink, #f4f6ff)",
                flexShrink: 0,
                borderRadius: 0,
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
                  padding: "2px 7px",
                  background: "transparent",
                  color: "inherit",
                  border: "none",
                  fontFamily: "inherit",
                  fontSize: "12px",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {isActive && <span aria-hidden="true">■</span>}
                <span style={{ fontWeight: isActive ? 700 : 500 }}>{wt.name}</span>
                <span
                  style={{
                    color: isActive ? "var(--knock, #05081a)" : "var(--dim, #93a3de)",
                    opacity: isActive ? 0.8 : 1,
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
                      color: isActive ? "var(--knock, #05081a)" : "var(--unknown, #ffe45c)",
                      fontWeight: 700,
                    }}
                  >
                    {spinner}
                  </span>
                )}

                {changedCount > 0 ? (
                  <span
                    style={{
                      color: isActive ? "var(--knock, #05081a)" : "var(--unknown, #ffe45c)",
                      fontWeight: 600,
                    }}
                  >
                    ~{changedCount}
                  </span>
                ) : (
                  <span
                    style={{
                      color: isActive ? "var(--knock, #05081a)" : "var(--safe, #6dffa6)",
                      opacity: isActive ? 0.75 : 0.9,
                    }}
                  >
                    clean
                  </span>
                )}

                {wt.counts.conflicted > 0 && (
                  <span
                    style={{
                      color: isActive ? "var(--knock, #05081a)" : "var(--unsafe, #ff5d4d)",
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
                      color: isActive ? "var(--knock, #05081a)" : "var(--sky, #3d6bff)",
                      fontWeight: 700,
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
                    ? "1px solid rgba(5, 8, 26, 0.25)"
                    : "1px solid var(--faint, #27326b)",
                  background: "transparent",
                  color: "inherit",
                  padding: "0 5px",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: "11px",
                  opacity: 0.75,
                }}
              >
                ⋯
              </button>
            </div>
          );
        })}
      </div>

      {/* [+ Worktree] Button */}
      <button
        type="button"
        className="ide2-add-worktree-btn"
        onClick={() => setCreateOpen(true)}
        title="Create new git worktree (git worktree add)"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "4px",
          padding: "3px 8px",
          background: "var(--wash, #0c1230)",
          border: "1px solid var(--faint, #27326b)",
          color: "var(--ink, #f4f6ff)",
          fontFamily: "inherit",
          fontSize: "12px",
          cursor: "pointer",
          borderRadius: 0,
          flexShrink: 0,
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
            background: "var(--wash, #0c1230)",
            border: "2px solid var(--ink, #f4f6ff)",
            boxShadow: "4px 4px 0 var(--sky, #3d6bff)",
            minWidth: "200px",
            padding: "4px 0",
            fontFamily: "var(--mono, 'Kode Mono', monospace)",
            fontSize: "12px",
          }}
        >
          <div
            style={{
              padding: "4px 10px",
              color: "var(--dim, #93a3de)",
              borderBottom: "1px solid var(--faint, #27326b)",
              fontSize: "11px",
            }}
          >
            {contextMenu.worktree.name} ({contextMenu.worktree.branch})
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
            background: "rgba(5, 8, 26, 0.72)",
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
              background: "var(--wash, #0c1230)",
              border: "2px solid var(--ink, #f4f6ff)",
              boxShadow: "4px 4px 0 var(--sky, #3d6bff)",
              padding: "12px",
              fontFamily: "var(--mono, 'Kode Mono', monospace)",
              color: "var(--ink, #f4f6ff)",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                borderBottom: "1px solid var(--faint, #27326b)",
                paddingBottom: "6px",
                fontWeight: 700,
              }}
            >
              <span>┌─ NEW GIT WORKTREE ─┐</span>
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                style={{
                  background: "transparent",
                  border: "1px solid var(--faint, #27326b)",
                  color: "var(--dim, #93a3de)",
                  cursor: "pointer",
                  padding: "1px 6px",
                  fontFamily: "inherit",
                }}
              >
                Esc
              </button>
            </div>

            <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px" }}>
              <span style={{ color: "var(--dim, #93a3de)" }}>New Branch Name</span>
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

            <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px" }}>
              <span style={{ color: "var(--dim, #93a3de)" }}>Base Ref (optional)</span>
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
                  color: "var(--unsafe, #ff5d4d)",
                  border: "1px solid var(--unsafe, #ff5d4d)",
                  padding: "6px 8px",
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
                  background: "var(--screen, #0a0f2c)",
                  border: "1px solid var(--faint, #27326b)",
                  color: "var(--dim, #93a3de)",
                  padding: "4px 10px",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: "12px",
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={creating}
                style={{
                  background: "var(--ink, #f4f6ff)",
                  border: "1px solid var(--ink, #f4f6ff)",
                  color: "var(--knock, #05081a)",
                  padding: "4px 12px",
                  cursor: creating ? "wait" : "pointer",
                  fontFamily: "inherit",
                  fontSize: "12px",
                  fontWeight: 700,
                }}
              >
                {creating ? "Creating..." : "Create Worktree"}
              </button>
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
  color: "var(--ink, #f4f6ff)",
  padding: "6px 10px",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: "12px",
};

const inputStyle: React.CSSProperties = {
  background: "var(--screen, #0a0f2c)",
  border: "1px solid var(--faint, #27326b)",
  color: "var(--ink, #f4f6ff)",
  padding: "6px 8px",
  fontFamily: "inherit",
  fontSize: "12px",
  outline: "none",
  borderRadius: 0,
};
