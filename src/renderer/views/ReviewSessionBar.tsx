import React, { useEffect, useState } from "react";
import type { ReviewSessionState } from "../../shared/protocol.js";
import { MORPH_FRAMES, MORPH_INTERVAL_MS } from "../shell/WorktreeStrip.js";

export interface ReviewSessionBarProps {
  review: ReviewSessionState;
  openAnnotationCount: number;
  onSendFeedback: () => void | Promise<void>;
  onApprove: () => void | Promise<void>;
  onCancel: () => void | Promise<void>;
}

export const ReviewSessionBar: React.FC<ReviewSessionBarProps> = ({
  review,
  openAnnotationCount,
  onSendFeedback,
  onApprove,
  onCancel,
}) => {
  const [morphIdx, setMorphIdx] = useState<number>(0);

  useEffect(() => {
    if (!review.agentWorking) return;
    const t = window.setInterval(() => {
      setMorphIdx((i) => (i + 1) % MORPH_FRAMES.length);
    }, MORPH_INTERVAL_MS);
    return () => window.clearInterval(t);
  }, [review.agentWorking]);

  return (
    <div
      className={`review-live-bar ${review.agentWorking ? "is-working" : "is-awaiting"}`}
      role="region"
      aria-label="Live Agent Review Session"
    >
      <div className="review-live-status">
        {review.agentWorking ? (
          <>
            <span className="wt-thinking-spinner" style={{ color: "var(--unknown)" }}>
              {MORPH_FRAMES[morphIdx] ?? "▣"}
            </span>
            <span style={{ color: "var(--unknown)", fontWeight: 600 }}>
              Agent addressing your feedback{review.round > 0 ? ` (Round ${review.round})` : ""}…
            </span>
          </>
        ) : (
          <>
            <span className="review-live-dot" aria-hidden="true" />
            <span style={{ color: "#ffffff", fontWeight: 600 }}>
              Agent connected & waiting for review
            </span>
            {review.label && <span className="wt-target-badge">{review.label}</span>}
            {review.round > 0 && (
              <span className="wt-target-badge">Round {review.round + 1}</span>
            )}
          </>
        )}
      </div>

      <div className="review-live-actions">
        {review.awaitingUser && (
          <>
            <button
              type="button"
              className="btn btn-safe"
              style={{ padding: "2px 9px", height: "24px", fontSize: "11.5px" }}
              onClick={() => void onApprove()}
              title="Tell the waiting agent the changes look good (no further edits needed)"
            >
              Approve ✓
            </button>
            <button
              type="button"
              className="btn btn-primary"
              style={{ padding: "2px 10px", height: "24px", fontSize: "11.5px" }}
              disabled={openAnnotationCount === 0}
              onClick={() => void onSendFeedback()}
              title={
                openAnnotationCount > 0
                  ? `Send ${openAnnotationCount} open annotation(s) directly to the waiting coding agent`
                  : "Add at least one annotation (⌘/) before sending feedback, or click Approve ✓"
              }
            >
              Send to Agent{openAnnotationCount > 0 ? ` (${openAnnotationCount})` : ""} →
            </button>
          </>
        )}
        <button
          type="button"
          className="btn btn-ghost"
          style={{ padding: "2px 7px", height: "24px", fontSize: "11.5px" }}
          onClick={() => void onCancel()}
          title="Disconnect review session"
        >
          Disconnect ✕
        </button>
      </div>
    </div>
  );
};
