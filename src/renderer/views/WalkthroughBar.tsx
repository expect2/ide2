import React, { useEffect, useState } from "react";
import type { WalkthroughState, WalkthroughStep } from "../../shared/protocol.js";
import { IconWalkthrough } from "../components/BrandMark.js";
import { MORPH_FRAMES, MORPH_INTERVAL_MS } from "../shell/WorktreeStrip.js";

export interface WalkthroughBarProps {
  walkthrough: WalkthroughState;
  viewedStepId: string;
  onSelectStep: (step: WalkthroughStep) => void;
  onEndWalkthrough: () => void | Promise<void>;
}

function formatPillTarget(step: WalkthroughStep): string {
  if (step.targetKind === "overview") return step.title;
  if (step.targetKind === "folder") {
    const seg = step.targetPath?.split("/").pop() ?? step.targetPath ?? "folder";
    return `${seg}/`;
  }
  const base = step.targetPath?.split("/").pop() ?? step.title;
  if (step.startLine) {
    return step.endLine && step.endLine !== step.startLine
      ? `${base}:${step.startLine}-${step.endLine}`
      : `${base}:${step.startLine}`;
  }
  return base;
}

export const WalkthroughBar: React.FC<WalkthroughBarProps> = ({
  walkthrough,
  viewedStepId,
  onSelectStep,
  onEndWalkthrough,
}) => {
  const [morphIdx, setMorphIdx] = useState<number>(0);

  useEffect(() => {
    if (!walkthrough.agentThinking) return;
    const t = window.setInterval(() => {
      setMorphIdx((i) => (i + 1) % MORPH_FRAMES.length);
    }, MORPH_INTERVAL_MS);
    return () => window.clearInterval(t);
  }, [walkthrough.agentThinking]);

  const latestStep = walkthrough.steps[walkthrough.steps.length - 1];
  const isViewingHistory = latestStep && viewedStepId !== latestStep.id;

  return (
    <div className="wt-tour-bar" role="region" aria-label="Codebase Walkthrough">
      <div className="wt-tour-bar-title">
        <span style={{ color: "var(--sky)", display: "inline-flex", alignItems: "center" }}>
          <IconWalkthrough size={14} />
        </span>
        <span>{walkthrough.title || "Walkthrough"}</span>
      </div>

      <div className="wt-tour-pills" role="tablist" aria-label="Walkthrough Steps">
        {walkthrough.steps.map((step) => {
          const isViewed = step.id === viewedStepId;
          const isLiveHead = step.id === walkthrough.activeStepId;
          return (
            <button
              key={step.id}
              type="button"
              role="tab"
              aria-selected={isViewed}
              className={`wt-tour-pill ${isViewed ? "active" : ""} ${isLiveHead ? "live-head" : ""}`}
              onClick={() => onSelectStep(step)}
              title={`${step.stepNumber}. ${step.title}`}
            >
              <span className="wt-tour-pill-num">{step.stepNumber}.</span>
              <span>{formatPillTarget(step)}</span>
            </button>
          );
        })}
      </div>

      <div className="wt-tour-bar-actions">
        {walkthrough.agentThinking && (
          <span className="wt-thinking-chip">
            <span>{MORPH_FRAMES[morphIdx] ?? "▣"}</span>
            <span>Agent preparing next step…</span>
          </span>
        )}
        {isViewingHistory && latestStep && (
          <button
            type="button"
            className="btn btn-primary"
            style={{ padding: "2px 8px", height: "23px", fontSize: "11.5px" }}
            onClick={() => onSelectStep(latestStep)}
          >
            Live Step →
          </button>
        )}
        <button
          type="button"
          className="btn btn-ghost"
          style={{ padding: "2px 7px", height: "23px", fontSize: "11.5px" }}
          onClick={() => void onEndWalkthrough()}
          title="End Walkthrough"
        >
          End ✕
        </button>
      </div>
    </div>
  );
};
