import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Ide2Wordmark } from "../components/BrandMark.js";
import { formatShortcut, type Platform } from "../shell/keymap.js";

export interface OnboardingTourProps {
  open: boolean;
  platform: Platform;
  onFinish: () => void | Promise<void>;
  onCopyReviewPrompt: () => void | Promise<void>;
  onCopyWalkthroughPrompt: () => void | Promise<void>;
}

interface TourStepDef {
  id: string;
  anchor?: string;
  kicker: string;
  title: string;
  body: string;
  highlights?: Array<{ key?: string; text: string }>;
  showAgentActions?: boolean;
}

interface RectBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

const CARD_WIDTH = 420;
const CARD_EST_HEIGHT = 290;
const VIEWPORT_MARGIN = 16;
const SPOTLIGHT_PAD = 6;

export const OnboardingTour: React.FC<OnboardingTourProps> = ({
  open,
  platform,
  onFinish,
  onCopyReviewPrompt,
  onCopyWalkthroughPrompt,
}) => {
  const [stepIndex, setStepIndex] = useState<number>(0);
  const [targetRect, setTargetRect] = useState<RectBox | null>(null);
  const [viewport, setViewport] = useState<{ w: number; h: number }>(() => ({
    w: typeof window !== "undefined" ? window.innerWidth : 1440,
    h: typeof window !== "undefined" ? window.innerHeight : 900,
  }));

  const steps: TourStepDef[] = useMemo(
    () => [
      {
        id: "welcome",
        kicker: "WELCOME TO IDE2",
        title: "Read-only clarity for the AI coding era",
        body: "Keep your coding agents in the terminal. Open ide2 whenever you want to inspect diffs across worktrees, read Markdown specs, or send precise direction back — without touching files or locking Git.",
        highlights: [
          { text: "Strictly read-only & lock-safe (--no-optional-locks on every Git call)" },
          { text: "Zero harness lock-in — works with Claude Code, Grok Build, Codex, Pi & more" },
          { text: "All review notes live outside your repo in ~/.expect2-ide/" },
        ],
      },
      {
        id: "worktrees",
        anchor: "worktree-strip",
        kicker: "MULTI-WORKTREE STRIP",
        title: "Every agent branch in one window",
        body: "All Git worktrees of this repository appear along the top strip with independent tab sessions, changed-file counts, and live filesystem pulses.",
        highlights: [
          {
            key: formatShortcut("switch-worktree", platform),
            text: "Jump between worktrees or spin up a new branch with + Worktree",
          },
          {
            text: "Green dots & spinners light up per worktree when an agent connects over IPC",
          },
        ],
      },
      {
        id: "navigation",
        anchor: "nav-diff",
        kicker: "NAVIGATION, DIFFS & SPECS",
        title: "JetBrains muscle memory, instant diffs",
        body: "Move across files, symbols, and multi-scope diffs (Branch vs Base, Working Tree, Commit, or Worktree vs Worktree) without heavy indexing.",
        highlights: [
          { key: "⇧⇧", text: "Search Everywhere across files, symbols, worktrees & actions" },
          { key: formatShortcut("go-to-file", platform), text: "Go to File (press again for all worktrees)" },
          { key: formatShortcut("toggle-diff", platform), text: "Toggle Split / Unified Diff  ·  F7 / ⇧F7 next/prev hunk" },
          { key: formatShortcut("cycle-markdown-mode", platform), text: "Cycle Markdown Preview / Split / Raw with Mermaid diagrams" },
        ],
      },
      {
        id: "annotations",
        anchor: "export-review",
        kicker: "ANNOTATIONS & LIVE REVIEW",
        title: "Drift-resilient notes, zero copy/paste",
        body: "Click any gutter + or press " + formatShortcut("annotate", platform) + " on code, diffs, or rendered Markdown blocks to anchor review feedback. Notes shift automatically when agents edit lines above them.",
        highlights: [
          { key: formatShortcut("copy-feedback-prompt", platform), text: "Copy all open notes as a structured Markdown prompt anytime" },
          { text: "Run ide2 review wait in your terminal to unlock one-click Send to Agent → & Approve ✓" },
        ],
      },
      {
        id: "agent-menu",
        anchor: "agent-menu",
        kicker: "AGENT COLLABORATION",
        title: "Walkthroughs & live review from any agent",
        body: "Use the Agent menu anytime to copy ready-to-paste prompts for top-down codebase tours (ide2 tour) or live review loops (ide2 review wait) — or install the reusable skill once with `ide2 install-skill`.",
        showAgentActions: true,
      },
    ],
    [platform],
  );

  // Reset to step 0 whenever reopened
  useEffect(() => {
    if (open) {
      setStepIndex(0);
    }
  }, [open]);

  const activeStep = steps[stepIndex] ?? steps[0]!;
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === steps.length - 1;

  const measureAnchor = useCallback(() => {
    if (!open) return;
    setViewport({ w: window.innerWidth, h: window.innerHeight });
    if (!activeStep.anchor) {
      setTargetRect(null);
      return;
    }
    const el = document.querySelector<HTMLElement>(`[data-tour-anchor="${activeStep.anchor}"]`);
    if (!el) {
      setTargetRect(null);
      return;
    }
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) {
      setTargetRect(null);
      return;
    }
    setTargetRect({
      left: Math.max(4, Math.round(r.left - SPOTLIGHT_PAD)),
      top: Math.max(4, Math.round(r.top - SPOTLIGHT_PAD)),
      width: Math.min(window.innerWidth - 8, Math.round(r.width + SPOTLIGHT_PAD * 2)),
      height: Math.min(window.innerHeight - 8, Math.round(r.height + SPOTLIGHT_PAD * 2)),
    });
  }, [open, activeStep.anchor]);

  useLayoutEffect(() => {
    measureAnchor();
    if (!open) return;
    const onResize = () => measureAnchor();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open, measureAnchor]);

  const handleClose = useCallback(() => {
    void onFinish();
  }, [onFinish]);

  const handleNext = useCallback(() => {
    if (isLast) {
      void onFinish();
    } else {
      setStepIndex((i) => Math.min(steps.length - 1, i + 1));
    }
  }, [isLast, onFinish, steps.length]);

  const handlePrev = useCallback(() => {
    setStepIndex((i) => Math.max(0, i - 1));
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        handleClose();
      } else if (e.key === "ArrowRight" || e.key === "Enter") {
        // Don't hijack Enter if user focused an action button inside the card
        if (e.key === "Enter" && document.activeElement?.tagName === "BUTTON") {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        handleNext();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        handlePrev();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, handleClose, handleNext, handlePrev]);

  if (!open) return null;

  // Compute callout card placement (centered on welcome step, anchored cleanly below/beside spotlight otherwise)
  const cardStyle: React.CSSProperties = (() => {
    if (!targetRect) {
      return {
        left: `${Math.max(VIEWPORT_MARGIN, Math.round((viewport.w - CARD_WIDTH) / 2))}px`,
        top: `${Math.max(VIEWPORT_MARGIN, Math.round((viewport.h - 340) / 2))}px`,
        width: `${CARD_WIDTH}px`,
      };
    }

    const preferBelowTop = targetRect.top + targetRect.height + 14;
    const fitsBelow = preferBelowTop + CARD_EST_HEIGHT <= viewport.h - VIEWPORT_MARGIN;
    const top = fitsBelow
      ? preferBelowTop
      : Math.max(VIEWPORT_MARGIN, targetRect.top - CARD_EST_HEIGHT - 14);

    // Align card horizontally near the spotlight center, clamped inside viewport
    const anchorCenterX = targetRect.left + targetRect.width / 2;
    const idealLeft = Math.round(anchorCenterX - CARD_WIDTH / 2);
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(viewport.w - CARD_WIDTH - VIEWPORT_MARGIN, idealLeft),
    );

    return {
      left: `${left}px`,
      top: `${top}px`,
      width: `${CARD_WIDTH}px`,
    };
  })();

  return (
    <div
      className="onboarding-root"
      role="dialog"
      aria-modal="true"
      aria-label={`ide2 Quick Tour — ${activeStep.title}`}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Dimmed backdrop with smooth rounded SVG cutout around spotlighted UI control */}
      <svg
        className="onboarding-backdrop"
        width={viewport.w}
        height={viewport.h}
        viewBox={`0 0 ${viewport.w} ${viewport.h}`}
        aria-hidden="true"
        onClick={handleClose}
      >
        <defs>
          <mask id="ide2-onboarding-mask">
            <rect x="0" y="0" width={viewport.w} height={viewport.h} fill="#ffffff" />
            {targetRect && (
              <rect
                x={targetRect.left}
                y={targetRect.top}
                width={targetRect.width}
                height={targetRect.height}
                rx="8"
                ry="8"
                fill="#000000"
              />
            )}
          </mask>
        </defs>
        <rect
          x="0"
          y="0"
          width={viewport.w}
          height={viewport.h}
          fill="rgba(5, 8, 22, 0.72)"
          mask="url(#ide2-onboarding-mask)"
        />
      </svg>

      {/* Crisp spotlight ring */}
      {targetRect && (
        <div
          className="onboarding-spotlight-ring"
          aria-hidden="true"
          style={{
            left: `${targetRect.left}px`,
            top: `${targetRect.top}px`,
            width: `${targetRect.width}px`,
            height: `${targetRect.height}px`,
          }}
        />
      )}

      {/* Anchored Callout Card */}
      <div className="onboarding-card" style={cardStyle}>
        <div className="onboarding-trail-bar" aria-hidden="true" />

        <div className="onboarding-card-body">
          <div className="onboarding-head">
            <span className="onboarding-kicker">{activeStep.kicker}</span>
            <span className="onboarding-step-count">
              {stepIndex + 1} / {steps.length}
            </span>
          </div>

          {isFirst && (
            <div style={{ marginBottom: "10px" }}>
              <Ide2Wordmark height={24} withTrail={true} />
            </div>
          )}

          <h2 className="onboarding-title">{activeStep.title}</h2>
          <p className="onboarding-desc">{activeStep.body}</p>

          {activeStep.highlights && activeStep.highlights.length > 0 && (
            <ul className="onboarding-list">
              {activeStep.highlights.map((item, idx) => (
                <li key={idx} className="onboarding-list-item">
                  {item.key ? (
                    <span className="kbd-hint onboarding-kbd">{item.key}</span>
                  ) : (
                    <span className="onboarding-bullet" aria-hidden="true">
                      ◆
                    </span>
                  )}
                  <span>{item.text}</span>
                </li>
              ))}
            </ul>
          )}

          {activeStep.showAgentActions && (
            <div className="onboarding-quick-actions">
              <button
                type="button"
                className="btn"
                onClick={() => void onCopyReviewPrompt()}
              >
                Copy Live Review Prompt
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => void onCopyWalkthroughPrompt()}
              >
                Copy Walkthrough Prompt
              </button>
            </div>
          )}
        </div>

        <div className="onboarding-foot">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={handleClose}
            style={{ color: "var(--dim)" }}
          >
            Skip
          </button>

          <div className="onboarding-dots" aria-hidden="true">
            {steps.map((s, idx) => (
              <button
                key={s.id}
                type="button"
                tabIndex={-1}
                className={`onboarding-dot${idx === stepIndex ? " active" : ""}`}
                onClick={() => setStepIndex(idx)}
                title={`Go to step ${idx + 1}: ${s.title}`}
              />
            ))}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            {!isFirst && (
              <button type="button" className="btn" onClick={handlePrev}>
                ← Back
              </button>
            )}
            <button type="button" className="btn btn-primary" onClick={handleNext}>
              {isLast ? "Get Started ✓" : "Next →"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
