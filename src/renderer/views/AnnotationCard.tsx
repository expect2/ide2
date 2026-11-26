import React, { useEffect, useRef, useState } from "react";
import type { Annotation } from "../../shared/protocol";

export function formatAnnotationRange(
  startLine?: number,
  endLine?: number,
  side?: "new" | "old",
): string {
  if (!startLine) return "General";
  const range =
    !endLine || endLine === startLine ? `L${startLine}` : `L${startLine}-${endLine}`;
  return side === "old" ? `${range} (old)` : range;
}

export interface AnnotationComposerProps {
  filePath?: string;
  side?: "new" | "old";
  startLine?: number;
  endLine?: number;
  initialComment?: string;
  selectedPreview?: string;
  isEditing?: boolean;
  autoFocus?: boolean;
  onSubmit: (data: { comment: string }) => void | Promise<void>;
  onCancel: () => void;
}

export const AnnotationComposer: React.FC<AnnotationComposerProps> = ({
  filePath,
  side,
  startLine,
  endLine,
  initialComment = "",
  selectedPreview,
  isEditing = false,
  autoFocus = true,
  onSubmit,
  onCancel,
}) => {
  const [comment, setComment] = useState<string>(initialComment);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (autoFocus) {
      textareaRef.current?.focus();
    }
  }, [autoFocus]);

  const handleSubmit = async () => {
    const trimmed = comment.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit({ comment: trimmed });
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      void handleSubmit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };

  const rangeLabel = formatAnnotationRange(startLine, endLine, side);
  const anchorLabel = filePath
    ? startLine
      ? `${filePath}:${rangeLabel}`
      : filePath
    : rangeLabel;

  const previewLine = selectedPreview
    ? selectedPreview.split(/\r?\n/)[0]?.trim() ?? ""
    : "";

  return (
    <div
      className="ann-composer"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="ann-composer-head">
        <div className="ann-anchor-badge">
          <span>◆</span>
          <span>{anchorLabel}</span>
          {side === "old" && <span className="ann-side-chip">DELETED</span>}
        </div>
        <span>{isEditing ? "Edit Annotation" : "New Annotation"}</span>
      </div>

      {previewLine && (
        <div className="ann-snippet-preview" title={selectedPreview}>
          {previewLine}
        </div>
      )}

      <textarea
        ref={textareaRef}
        className="ann-textarea"
        placeholder="Write feedback for the coding agent (Markdown supported)..."
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={3}
      />

      <div className="ann-composer-foot">
        <span className="ann-composer-hint">⌘/Ctrl+Enter submit · Esc cancel</span>
        <div className="ann-composer-actions">
          <button
            type="button"
            className="btn"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void handleSubmit()}
            disabled={!comment.trim() || submitting}
          >
            {submitting ? "Saving..." : isEditing ? "Update" : "Add Note"}
          </button>
        </div>
      </div>
    </div>
  );
};

function renderFormattedComment(text: string): React.ReactNode {
  const parts = text.split(/(`[^`\n]+`)/g);
  return parts.map((part, idx) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
      return (
        <code key={idx} className="ann-inline-code">
          {part.slice(1, -1)}
        </code>
      );
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
}

export interface AnnotationThreadCardProps {
  annotations: Annotation[];
  compact?: boolean;
  onEdit?: (
    annotation: Annotation,
    updates: { comment: string },
  ) => void | Promise<void>;
  onResolve?: (annotation: Annotation) => void | Promise<void>;
  onUnresolve?: (annotation: Annotation) => void | Promise<void>;
  onDelete?: (annotation: Annotation) => void | Promise<void>;
  onJumpTo?: (annotation: Annotation) => void;
}

export const AnnotationThreadCard: React.FC<AnnotationThreadCardProps> = ({
  annotations,
  compact = false,
  onEdit,
  onResolve,
  onUnresolve,
  onDelete,
  onJumpTo,
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);

  if (annotations.length === 0) return null;

  const allResolved = annotations.every((a) => a.status === "resolved");

  return (
    <div
      className={`ann-card ${allResolved ? "ann-resolved-card" : ""} ${compact ? "ann-compact" : ""}`}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="ann-thread">
        {annotations.map((ann) => {
          const isEditing = editingId === ann.id;
          const rangeText = formatAnnotationRange(
            ann.startLine,
            ann.endLine,
            ann.side,
          );

          if (isEditing && onEdit) {
            return (
              <div key={ann.id} className="ann-item">
                <AnnotationComposer
                  filePath={ann.filePath}
                  side={ann.side}
                  startLine={ann.startLine}
                  endLine={ann.endLine}
                  initialComment={ann.comment}
                  isEditing
                  onSubmit={async (updates) => {
                    await onEdit(ann, updates);
                    setEditingId(null);
                  }}
                  onCancel={() => setEditingId(null)}
                />
              </div>
            );
          }

          return (
            <div
              key={ann.id}
              className={`ann-item ${ann.status === "resolved" ? "ann-resolved" : ""}`}
            >
              <div className="ann-item-head">
                <div className="ann-item-meta">
                  <span
                    className={`ann-range-badge ${onJumpTo ? "clickable" : ""}`}
                    onClick={onJumpTo ? () => onJumpTo(ann) : undefined}
                    title={onJumpTo ? "Jump to anchored lines" : undefined}
                  >
                    ◆ {rangeText}
                  </span>
                  {ann.status === "outdated" && (
                    <span
                      className="ann-outdated-chip"
                      title="Anchored lines changed since this annotation was written"
                    >
                      OUTDATED · code drifted
                    </span>
                  )}
                  {ann.status === "resolved" && (
                    <span className="ann-resolved-chip">RESOLVED</span>
                  )}
                </div>

                <div className="ann-actions">
                  {onEdit && (
                    <button
                      type="button"
                      className="ann-action-btn"
                      onClick={() => setEditingId(ann.id)}
                    >
                      Edit
                    </button>
                  )}
                  {ann.status === "resolved"
                    ? onUnresolve && (
                        <button
                          type="button"
                          className="ann-action-btn"
                          onClick={() => void onUnresolve(ann)}
                        >
                          Reopen
                        </button>
                      )
                    : onResolve && (
                        <button
                          type="button"
                          className="ann-action-btn"
                          onClick={() => void onResolve(ann)}
                        >
                          Resolve
                        </button>
                      )}
                  {onDelete && (
                    <button
                      type="button"
                      className="ann-action-btn danger"
                      onClick={() => void onDelete(ann)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>

              <div className="ann-body">{renderFormattedComment(ann.comment)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
