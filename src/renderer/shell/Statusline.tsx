import React, { useEffect, useState } from "react";
import type { WorktreeInfo } from "../../shared/protocol.js";
import { Expect2CursorMark, IconGitBranch } from "../components/BrandMark.js";
import { formatShortcut, type Platform } from "./keymap.js";
import { formatRelativeActivity } from "./WorktreeStrip.js";

export interface StatuslineProps {
  worktree?: WorktreeInfo;
  filePath?: string;
  line?: number;
  column?: number;
  language?: string;
  blameEnabled: boolean;
  crtEnabled: boolean;
  openAnnotationCount: number;
  lastUpdatedAt?: number;
  watcherActive?: boolean;
  platform: Platform;
  onToggleBlame: () => void;
  onToggleCrt: () => void;
  onOpenAnnotations: () => void;
  onOpenGoToLine?: () => void;
  onCopyFeedbackPrompt: () => Promise<void> | void;
}

export const Statusline: React.FC<StatuslineProps> = ({
  worktree,
  filePath,
  line = 1,
  column = 1,
  language,
  blameEnabled,
  crtEnabled,
  openAnnotationCount,
  lastUpdatedAt,
  watcherActive = true,
  platform,
  onToggleBlame,
  onToggleCrt,
  onOpenAnnotations,
  onOpenGoToLine,
  onCopyFeedbackPrompt,
}) => {
  const [now, setNow] = useState<number>(() => Date.now());
  const [copied, setCopied] = useState<boolean>(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const updatedRef = lastUpdatedAt ?? worktree?.lastActivityAt ?? 0;
  const isFresh = updatedRef > 0 && now - updatedRef < 8000;

  const handleCopy = async () => {
    await onCopyFeedbackPrompt();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <footer
      className="ide2-statusline"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
        height: "30px",
        minHeight: "30px",
        flexShrink: 0,
        padding: "0 10px",
        background: "var(--paper)",
        borderTop: "1px solid var(--faint)",
        color: "var(--dim)",
        fontFamily: "var(--ui-font)",
        fontSize: "11.5px",
        userSelect: "none",
        whiteSpace: "nowrap",
        overflow: "hidden",
        boxSizing: "border-box",
      }}
    >
      {/* Left Cluster */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
        <Expect2CursorMark height={13} fill="var(--dim)" />

        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            background: "var(--wash)",
            border: "1px solid var(--faint)",
            color: "var(--dim)",
            padding: "1px 6px",
            borderRadius: "4px",
            fontSize: "10.5px",
            fontWeight: 600,
            letterSpacing: "0.04em",
          }}
        >
          READ-ONLY
        </span>

        {worktree && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "5px",
              color: "var(--dim)",
              minWidth: 0,
            }}
          >
            <IconGitBranch size={12} />
            <span style={{ color: "var(--ink)", fontWeight: 500 }}>{worktree.name}</span>
            <span style={{ fontFamily: "var(--mono)", fontSize: "11px", color: "var(--dim)" }}>
              ({worktree.branch}
              {worktree.ahead > 0 ? ` ↑${worktree.ahead}` : ""})
            </span>
          </span>
        )}

        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            color: isFresh
              ? "var(--unknown)"
              : watcherActive
                ? "var(--safe)"
                : "var(--off)",
            fontSize: "11px",
          }}
        >
          <span style={{ fontFamily: "var(--mono)" }}>
            {isFresh ? "↻" : watcherActive ? "▣" : "◻"}
          </span>
          <span>
            {isFresh
              ? `updated ${formatRelativeActivity(updatedRef, now)} ago`
              : watcherActive
                ? "watching"
                : "paused"}
          </span>
        </span>
      </div>

      {/* Right Cluster */}
      <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
        {filePath && (
          <button
            type="button"
            onClick={onOpenGoToLine}
            title={`Go to Line (${formatShortcut("go-to-line", platform)})`}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--ink)",
              fontFamily: "var(--mono)",
              fontSize: "11px",
              cursor: onOpenGoToLine ? "pointer" : "default",
              padding: "0 4px",
            }}
          >
            {filePath}:{line}:{column}
          </button>
        )}

        {language && (
          <span
            style={{
              color: "var(--dim)",
              fontSize: "11px",
              padding: "0 4px",
              textTransform: "uppercase",
              letterSpacing: "0.02em",
            }}
          >
            {language}
          </span>
        )}

        <button
          type="button"
          aria-pressed={blameEnabled}
          onClick={onToggleBlame}
          style={{
            ...statusBtnStyle,
            background: blameEnabled ? "var(--selection, #2e436e)" : "transparent",
            borderColor: blameEnabled ? "rgba(61, 107, 255, 0.45)" : "var(--faint)",
            color: blameEnabled ? "#ffffff" : "var(--dim)",
            fontWeight: blameEnabled ? 600 : 500,
          }}
        >
          Blame
        </button>

        <button
          type="button"
          aria-pressed={crtEnabled}
          onClick={onToggleCrt}
          style={{
            ...statusBtnStyle,
            background: crtEnabled ? "var(--selection, #2e436e)" : "transparent",
            borderColor: crtEnabled ? "rgba(61, 107, 255, 0.45)" : "var(--faint)",
            color: crtEnabled ? "#ffffff" : "var(--dim)",
            fontWeight: crtEnabled ? 600 : 500,
          }}
        >
          CRT
        </button>

        <button
          type="button"
          onClick={onOpenAnnotations}
          title={`Annotations (${formatShortcut("tool-annotations", platform)})`}
          style={{
            ...statusBtnStyle,
            fontFamily: "var(--mono)",
            background: openAnnotationCount > 0 ? "var(--sky-bg)" : "transparent",
            borderColor:
              openAnnotationCount > 0 ? "rgba(61, 107, 255, 0.38)" : "var(--faint)",
            color: openAnnotationCount > 0 ? "#8cb4ff" : "var(--dim)",
            fontWeight: openAnnotationCount > 0 ? 600 : 500,
          }}
        >
          ◆ {openAnnotationCount}
        </button>

        <button
          type="button"
          onClick={() => void handleCopy()}
          title={`Copy Feedback Prompt (${formatShortcut("copy-feedback-prompt", platform)})`}
          style={{
            ...statusBtnStyle,
            background: copied ? "var(--safe)" : "var(--accent, #3574f0)",
            color: copied ? "var(--knock)" : "#ffffff",
            borderColor: copied ? "var(--safe)" : "var(--accent, #3574f0)",
            padding: "0 9px",
            fontWeight: 600,
          }}
        >
          {copied ? (
            "Copied!"
          ) : (
            <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
              <span>Copy Feedback Prompt</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: "10.5px", opacity: 0.85 }}>
                {formatShortcut("copy-feedback-prompt", platform)}
              </span>
            </span>
          )}
        </button>
      </div>
    </footer>
  );
};

const statusBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  border: "1px solid var(--faint)",
  color: "var(--dim)",
  padding: "0 7px",
  height: "20px",
  fontFamily: "var(--ui-font)",
  fontSize: "11px",
  cursor: "pointer",
  borderRadius: "5px",
};
