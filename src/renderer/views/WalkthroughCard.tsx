import React, { useEffect, useMemo, useState } from "react";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type * as Mdast from "mdast";
import type { WalkthroughStep } from "../../shared/protocol.js";
import { IconProject, IconWalkthrough } from "../components/BrandMark.js";
import { MORPH_FRAMES, MORPH_INTERVAL_MS } from "../shell/WorktreeStrip.js";

const tourMdParser = unified().use(remarkParse).use(remarkGfm);

let tourMermaidInit = false;
let tourMermaidCounter = 0;

const TourMermaidDiagram: React.FC<{ code: string }> = ({ code }) => {
  const [svg, setSvg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    (async () => {
      const mod = await import("mermaid");
      const mermaid = mod.default;
      if (!tourMermaidInit) {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          themeVariables: {
            darkMode: true,
            background: "#1e1f22",
            primaryColor: "#2b2d34",
            primaryBorderColor: "#3d6bff",
            primaryTextColor: "#dfe1e5",
            secondaryColor: "#24262b",
            tertiaryColor: "#181a1f",
            lineColor: "#8b909a",
            textColor: "#dfe1e5",
            fontFamily: "-apple-system, BlinkMacSystemFont, Inter, Segoe UI, sans-serif",
          },
        });
        tourMermaidInit = true;
      }
      tourMermaidCounter += 1;
      const rendered = await mermaid.render(`ide2-tour-mmd-${tourMermaidCounter}`, code);
      if (!cancelled) setSvg(rendered.svg);
    })().catch((e: unknown) => {
      if (!cancelled) setErr(e instanceof Error ? e.message : "Mermaid render error");
    });
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (err) {
    return (
      <pre className="md-code-pre" style={{ margin: "8px 0" }}>
        <code>{code}</code>
      </pre>
    );
  }
  if (!svg) {
    return <div style={{ padding: "8px 0", color: "var(--dim)", fontSize: 12 }}>Rendering diagram…</div>;
  }
  return (
    <div
      className="md-mermaid-svg"
      style={{ padding: "10px", cursor: "default" }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
};

function renderTourPhrasing(
  nodes: Mdast.PhrasingContent[],
  keyPrefix: string,
  onOpenRepoTarget?: (rawHref: string) => void,
): React.ReactNode {
  return nodes.map((node, idx) => {
    const k = `${keyPrefix}-${idx}`;
    switch (node.type) {
      case "text":
        return <React.Fragment key={k}>{node.value}</React.Fragment>;
      case "emphasis":
        return <em key={k}>{renderTourPhrasing(node.children, k, onOpenRepoTarget)}</em>;
      case "strong":
        return <strong key={k}>{renderTourPhrasing(node.children, k, onOpenRepoTarget)}</strong>;
      case "delete":
        return <del key={k}>{renderTourPhrasing(node.children, k, onOpenRepoTarget)}</del>;
      case "inlineCode":
        return (
          <code key={k} className="ann-inline-code">
            {node.value}
          </code>
        );
      case "break":
        return <br key={k} />;
      case "link":
        return (
          <a
            key={k}
            href={node.url}
            className="md-link"
            onClick={(e) => {
              e.preventDefault();
              if (/^https?:\/\//i.test(node.url)) {
                void window.ide2?.openExternalUrl(node.url);
              } else {
                onOpenRepoTarget?.(node.url);
              }
            }}
          >
            {renderTourPhrasing(node.children, k, onOpenRepoTarget)}
          </a>
        );
      default:
        return null;
    }
  });
}

function renderTourBlock(
  node: Mdast.RootContent,
  key: string,
  onOpenRepoTarget?: (rawHref: string) => void,
): React.ReactNode {
  switch (node.type) {
    case "heading": {
      const children = renderTourPhrasing(node.children, key, onOpenRepoTarget);
      if (node.depth <= 2) return <h3 key={key} className="wt-md-h">{children}</h3>;
      return <h4 key={key} className="wt-md-h4">{children}</h4>;
    }
    case "paragraph":
      return <p key={key} className="wt-md-p">{renderTourPhrasing(node.children, key, onOpenRepoTarget)}</p>;
    case "list": {
      const Tag = node.ordered ? "ol" : "ul";
      return (
        <Tag key={key} className="wt-md-list">
          {node.children.map((li, i) => (
            <li key={`${key}-li-${i}`}>
              {li.children.map((sub, j) => renderTourBlock(sub, `${key}-li-${i}-${j}`, onOpenRepoTarget))}
            </li>
          ))}
        </Tag>
      );
    }
    case "blockquote":
      return (
        <blockquote key={key} className="wt-md-quote">
          {node.children.map((sub, i) => renderTourBlock(sub, `${key}-bq-${i}`, onOpenRepoTarget))}
        </blockquote>
      );
    case "code":
      if (node.lang?.toLowerCase() === "mermaid") {
        return <TourMermaidDiagram key={key} code={node.value} />;
      }
      return (
        <div key={key} className="md-code-block" style={{ margin: "8px 0" }}>
          <pre className="md-code-pre" style={{ padding: "8px 12px", fontSize: "12px" }}>
            <code>{node.value}</code>
          </pre>
        </div>
      );
    case "table": {
      const [head, ...rows] = node.children;
      return (
        <div key={key} className="md-table-wrap" style={{ margin: "8px 0" }}>
          <table className="md-table">
            {head && (
              <thead>
                <tr>
                  {head.children.map((c, ci) => (
                    <th key={`${key}-th-${ci}`}>
                      {renderTourPhrasing(c.children, `${key}-th-${ci}`, onOpenRepoTarget)}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            {rows.length > 0 && (
              <tbody>
                {rows.map((r, ri) => (
                  <tr key={`${key}-tr-${ri}`}>
                    {r.children.map((c, ci) => (
                      <td key={`${key}-td-${ri}-${ci}`}>
                        {renderTourPhrasing(c.children, `${key}-td-${ri}-${ci}`, onOpenRepoTarget)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>
      );
    }
    case "thematicBreak":
      return <hr key={key} style={{ border: "none", borderTop: "1px solid var(--faint)", margin: "10px 0" }} />;
    default:
      return null;
  }
}

export interface WalkthroughCardProps {
  step: WalkthroughStep;
  variant: "banner" | "inline";
  isLatestStep: boolean;
  hasPrev: boolean;
  hasNextVisited: boolean;
  awaitingUser: boolean;
  agentThinking: boolean;
  onPrev: () => void;
  onNextVisited: () => void;
  onReturnToLatest: () => void;
  onAdvance: () => void | Promise<void>;
  onSteer: (message: string) => void | Promise<void>;
  onStop: () => void | Promise<void>;
  onOpenRepoTarget?: (rawTarget: string) => void;
}

export const WalkthroughCard: React.FC<WalkthroughCardProps> = ({
  step,
  variant,
  isLatestStep,
  hasPrev,
  hasNextVisited,
  awaitingUser,
  agentThinking,
  onPrev,
  onNextVisited,
  onReturnToLatest,
  onAdvance,
  onSteer,
  onStop,
  onOpenRepoTarget,
}) => {
  const [steerInput, setSteerInput] = useState<string>("");
  const [morphIdx, setMorphIdx] = useState<number>(0);

  useEffect(() => {
    setSteerInput("");
  }, [step.id]);

  useEffect(() => {
    if (!agentThinking) return;
    const t = window.setInterval(() => {
      setMorphIdx((i) => (i + 1) % MORPH_FRAMES.length);
    }, MORPH_INTERVAL_MS);
    return () => window.clearInterval(t);
  }, [agentThinking]);

  const ast = useMemo(() => tourMdParser.parse(step.body || ""), [step.body]);

  const targetBadge = useMemo(() => {
    if (step.targetKind === "overview") return "Architecture Overview";
    if (step.targetKind === "folder") return `${step.targetPath}/`;
    if (step.targetKind === "range" || (step.targetKind === "diff" && step.startLine)) {
      const range =
        step.endLine && step.endLine !== step.startLine
          ? `L${step.startLine}-${step.endLine}`
          : `L${step.startLine}`;
      return `${step.targetPath}:${range}`;
    }
    return step.targetPath ?? "Overview";
  }, [step]);

  const stepLabel = step.totalSteps
    ? `STEP ${step.stepNumber} OF ${step.totalSteps}`
    : `STEP ${step.stepNumber}`;

  const submitSteer = () => {
    const trimmed = steerInput.trim();
    if (!trimmed) return;
    setSteerInput("");
    void onSteer(trimmed);
  };

  return (
    <div
      className={`wt-card wt-card-${variant}`}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="wt-card-accent" aria-hidden="true" />

      <div className="wt-card-head">
        <div className="wt-card-title-group">
          <span className="wt-step-badge">
            <IconWalkthrough size={12} />
            <span>{stepLabel}</span>
          </span>
          <span className="wt-card-title">{step.title}</span>
          <span className="wt-target-badge">{targetBadge}</span>
        </div>

        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void onStop()}
          title="End walkthrough"
          style={{ padding: "2px 7px", fontSize: "11.5px" }}
        >
          End ✕
        </button>
      </div>

      {step.targetKind === "folder" && step.folderFiles && step.folderFiles.length > 0 && (
        <div className="wt-folder-chips">
          {step.folderFiles.map((entry) => {
            const isSubdir = entry.endsWith("/");
            const shortName = isSubdir
              ? `${entry.slice(0, -1).split("/").pop()}/`
              : entry.split("/").pop() ?? entry;
            return (
              <button
                key={entry}
                type="button"
                className="wt-folder-chip"
                title={entry}
                onClick={() => {
                  if (!isSubdir) {
                    onOpenRepoTarget?.(entry);
                  }
                }}
                style={{ cursor: isSubdir ? "default" : "pointer" }}
              >
                {isSubdir ? <IconProject size={12} /> : <span style={{ color: "var(--sky)" }}>·</span>}
                <span>{shortName}</span>
              </button>
            );
          })}
        </div>
      )}

      {step.body && (
        <div className="wt-card-body">
          {ast.children.map((node, idx) =>
            renderTourBlock(node, `wt-blk-${idx}`, onOpenRepoTarget),
          )}
        </div>
      )}

      <div className="wt-card-foot">
        {!isLatestStep ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <button
                type="button"
                className="btn"
                onClick={onPrev}
                disabled={!hasPrev}
              >
                ← Prev
              </button>
              <button
                type="button"
                className="btn"
                onClick={onNextVisited}
                disabled={!hasNextVisited}
              >
                Forward →
              </button>
              <span style={{ fontSize: "11.5px", color: "var(--dim)", marginLeft: "4px" }}>
                Viewing earlier step in history
              </span>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onReturnToLatest}
            >
              Return to Live Step →
            </button>
          </>
        ) : agentThinking || !awaitingUser ? (
          <>
            <div className="wt-thinking-status">
              <span className="wt-thinking-spinner">{MORPH_FRAMES[morphIdx] ?? "▣"}</span>
              <span>Waiting for coding agent's next walkthrough step…</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              {hasPrev && (
                <button type="button" className="btn" onClick={onPrev}>
                  ← Prev
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="wt-steer-group">
              {hasPrev && (
                <button type="button" className="btn" onClick={onPrev} title="View previous step">
                  ← Prev
                </button>
              )}
              <input
                type="text"
                className="wt-steer-input"
                placeholder="Ask a question or steer the agent…"
                value={steerInput}
                onChange={(e) => setSteerInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && steerInput.trim()) {
                    e.preventDefault();
                    e.stopPropagation();
                    submitSteer();
                  } else if (e.key === "Escape" && steerInput) {
                    e.preventDefault();
                    e.stopPropagation();
                    setSteerInput("");
                  }
                }}
              />
              {steerInput.trim().length > 0 && (
                <button type="button" className="btn btn-primary" onClick={submitSteer}>
                  Ask Agent ↵
                </button>
              )}
            </div>

            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void onAdvance()}
              title={step.final ? "Finish walkthrough" : "Advance agent to next step"}
            >
              <span>{step.final ? "Finish ✓" : "Next →"}</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
};
