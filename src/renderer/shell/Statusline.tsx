import React, { useEffect, useState } from "react";
import type { WorktreeInfo } from "../../shared/protocol.js";
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
        gap: "10px",
        height: "24px",
        padding: "0 8px",
        background: "var(--paper, #05081a)",
        borderTop: "1px solid var(--faint, #27326b)",
        color: "var(--ink, #f4f6ff)",
        fontFamily: "var(--mono, 'Kode Mono', monospace)",
        fontSize: "11px",
        userSelect: "none",
        whiteSpace: "nowrap",
        overflow: "hidden",
        boxSizing: "border-box",
      }}
    >
      {/* Left Cluster */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            background: "var(--ink, #f4f6ff)",
            color: "var(--knock, #05081a)",
            padding: "0 5px",
            fontWeight: 700,
            letterSpacing: "0.03em",
          }}
        >
          expect2 READ-ONLY
        </span>

        {worktree && (
          <span style={{ color: "var(--dim, #93a3de)" }}>
            ⎇ wt: <strong style={{ color: "var(--ink, #f4f6ff)" }}>{worktree.name}</strong> (
            {worktree.branch}
            {worktree.ahead > 0 ? ` ↑${worktree.ahead}` : ""})
          </span>
        )}

        <span
          style={{
            color: isFresh
              ? "var(--unknown, #ffe45c)"
              : watcherActive
                ? "var(--safe, #6dffa6)"
                : "var(--off, #56659e)",
          }}
        >
          {isFresh
            ? `↻ updated ${formatRelativeActivity(updatedRef, now)} ago`
            : watcherActive
              ? "▣ watching"
              : "◻ paused"}
        </span>
      </div>

      {/* Right Cluster */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
        {filePath && (
          <button
            type="button"
            onClick={onOpenGoToLine}
            title={`Go to Line (${formatShortcut("go-to-line", platform)})`}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--ink, #f4f6ff)",
              fontFamily: "inherit",
              fontSize: "11px",
              cursor: onOpenGoToLine ? "pointer" : "default",
              padding: 0,
            }}
          >
            {filePath}:{line}:{column}
          </button>
        )}

        {language && (
          <span style={{ color: "var(--dim, #93a3de)", textTransform: "uppercase" }}>
            {language}
          </span>
        )}

        <button
          type="button"
          aria-pressed={blameEnabled}
          onClick={onToggleBlame}
          style={{
            ...statusBtnStyle,
            background: blameEnabled ? "var(--ink, #f4f6ff)" : "var(--screen, #0a0f2c)",
            color: blameEnabled ? "var(--knock, #05081a)" : "var(--dim, #93a3de)",
            fontWeight: blameEnabled ? 700 : 400,
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
            background: crtEnabled ? "var(--ink, #f4f6ff)" : "var(--screen, #0a0f2c)",
            color: crtEnabled ? "var(--knock, #05081a)" : "var(--dim, #93a3de)",
            fontWeight: crtEnabled ? 700 : 400,
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
            color: openAnnotationCount > 0 ? "var(--sky, #3d6bff)" : "var(--dim, #93a3de)",
            fontWeight: openAnnotationCount > 0 ? 700 : 400,
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
            background: copied ? "var(--safe, #6dffa6)" : "var(--ink, #f4f6ff)",
            color: "var(--knock, #05081a)",
            borderColor: copied ? "var(--safe, #6dffa6)" : "var(--ink, #f4f6ff)",
            fontWeight: 700,
          }}
        >
          {copied
            ? "Copied!"
            : `Copy Feedback Prompt ${formatShortcut("copy-feedback-prompt", platform)}`}
        </button>
      </div>
    </footer>
  );
};

const statusBtnStyle: React.CSSProperties = {
  background: "var(--screen, #0a0f2c)",
  border: "1px solid var(--faint, #27326b)",
  color: "var(--ink, #f4f6ff)",
  padding: "0 6px",
  height: "18px",
  fontFamily: "inherit",
  fontSize: "11px",
  cursor: "pointer",
  borderRadius: 0,
};
