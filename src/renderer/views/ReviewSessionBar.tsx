import React, { useEffect, useState } from "react";
import type { ReviewSessionState } from "../../shared/protocol.js";
import { MORPH_FRAMES, MORPH_INTERVAL_MS } from "../shell/WorktreeStrip.js";

export interface ReviewSessionBarProps {
  review: ReviewSessionState;
  peerReviews?: readonly ReviewSessionState[];
  openAnnotationCount: number;
  onSelectSession?: (sessionId: string) => void;
  onSendFeedback: () => void | Promise<void>;
  onApprove: () => void | Promise<void>;
  onCancel: () => void | Promise<void>;
}

export const ReviewSessionBar: React.FC<ReviewSessionBarProps> = ({
  review,
  peerReviews,
  openAnnotationCount,
  onSelectSession,
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

  const showSessionSwitcher = Boolean(peerReviews && peerReviews.length > 1 && onSelectSession);

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
            {review.label && !showSessionSwitcher && (
              <span className="wt-target-badge">{review.label}</span>
            )}
            {review.round > 0 && (
              <span className="wt-target-badge">Round {review.round + 1}</span>
            )}
          </>
        )}

        {showSessionSwitcher && peerReviews && (
          <div style={{ display: "inline-flex", alignItems: "center", gap: "4px", marginLeft: "6px" }}>
            {peerReviews.map((s, idx) => {
              const selected = s.sessionId === review.sessionId;
              return (
                <button
                  key={s.sessionId}
                  type="button"
                  onClick={() => onSelectSession?.(s.sessionId)}
                  className="btn btn-ghost"
                  style={{
                    height: "21px",
                    padding: "0 7px",
                    fontSize: "11px",
                    background: selected ? "var(--selection, #2e436e)" : "rgba(255,255,255,0.04)",
                    borderColor: selected ? "rgba(94, 148, 255, 0.55)" : "var(--faint)",
                    color: selected ? "#ffffff" : "var(--dim)",
                  }}
                  title={`Target review session ${s.label || `#${idx + 1}`} (${s.sessionId})`}
                >
                  <span
                    style={{
                      width: "6px",
                      height: "6px",
                      borderRadius: "50%",
                      background: s.awaitingUser ? "var(--safe)" : "var(--unknown)",
                      display: "inline-block",
                    }}
                  />
                  <span>{s.label || `Agent #${idx + 1}`}</span>
                </button>
              );
            })}
          </div>
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
