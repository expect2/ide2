import React, { useCallback, useEffect, useState } from "react";
import {
  defineClientPlugin,
  PluginBadge,
  PluginButton,
  PluginEmptyState,
  PluginPanel,
} from "@expect2/ide2-plugin/client";
import type { WorktreePrReport } from "./server.js";

export default defineClientPlugin((ctx) => {
  ctx.registerToolWindow(
    "pr-checks-panel",
    ({ worktree, rpc, subscribeServerEvent, openFile, openExternalUrl, addReviewNote }) => {
      const [report, setReport] = useState<WorktreePrReport | null>(null);
      const [loading, setLoading] = useState<boolean>(false);

      const loadReport = useCallback(
        async (force = false) => {
          if (!worktree?.path) return;
          setLoading(true);
          try {
            const res = await rpc.call<WorktreePrReport>("getPrReport", {
              worktreePath: worktree.path,
              force,
            });
            setReport(res);
          } finally {
            setLoading(false);
          }
        },
        [rpc, worktree?.path],
      );

      useEffect(() => {
        void loadReport(false);
      }, [loadReport]);

      useEffect(() => {
        return subscribeServerEvent("pr-report-updated", (payload) => {
          const p = payload as { worktreePath?: string; report?: WorktreePrReport };
          if (p?.worktreePath === worktree?.path && p.report) {
            setReport(p.report);
          }
        });
      }, [subscribeServerEvent, worktree?.path]);

      const failingCount =
        report?.checks.filter((c) => c.state === "failure").length ?? 0;
      const pendingCount =
        report?.checks.filter((c) => c.state === "pending").length ?? 0;
      const passingCount =
        report?.checks.filter((c) => c.state === "success").length ?? 0;

      const headerBadge =
        report?.status === "ok" ? (
          failingCount > 0 ? (
            <PluginBadge tone="error">{failingCount} failing</PluginBadge>
          ) : pendingCount > 0 ? (
            <PluginBadge tone="warning">{pendingCount} running</PluginBadge>
          ) : (
            <PluginBadge tone="success">{passingCount} passing</PluginBadge>
          )
        ) : null;

      return (
        <PluginPanel
          title={
            report?.status === "ok" && report.prNumber
              ? `PR #${report.prNumber} — ${report.prTitle}`
              : "GitHub PR & CI Checks"
          }
          badge={headerBadge}
          actions={
            <>
              {report?.prUrl && (
                <PluginButton
                  variant="ghost"
                  onClick={() => openExternalUrl(report.prUrl!)}
                >
                  Open PR ↗
                </PluginButton>
              )}
              <PluginButton
                disabled={loading}
                onClick={() => void loadReport(true)}
              >
                {loading ? "Refreshing…" : "Refresh"}
              </PluginButton>
            </>
          }
        >
          {!report ? (
            <div style={{ color: "var(--dim)" }}>Checking GitHub PR status…</div>
          ) : report.status !== "ok" ? (
            <PluginEmptyState
              title={
                report.status === "no_pr"
                  ? "No Pull Request for this branch"
                  : report.status === "no_github_remote"
                    ? "Not a GitHub repository"
                    : "GitHub CLI unavailable"
              }
              detail={report.message}
              action={
                <PluginButton onClick={() => void loadReport(true)}>
                  Retry Check
                </PluginButton>
              }
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {/* Summary Bar */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "8px",
                  flexWrap: "wrap",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <PluginBadge tone="accent">{report.repoSlug}</PluginBadge>
                  <PluginBadge>{report.branch}</PluginBadge>
                  {report.isDraft && <PluginBadge tone="warning">DRAFT</PluginBadge>}
                  {report.reviewDecision && (
                    <PluginBadge
                      tone={
                        report.reviewDecision === "APPROVED"
                          ? "success"
                          : report.reviewDecision === "CHANGES_REQUESTED"
                            ? "error"
                            : "neutral"
                      }
                    >
                      {report.reviewDecision}
                    </PluginBadge>
                  )}
                </div>

                {failingCount > 0 && (
                  <PluginButton
                    variant="primary"
                    onClick={() => {
                      const failedNames = report.checks
                        .filter((c) => c.state === "failure")
                        .map((c) => `- ${c.name} (${c.rawConclusion})`)
                        .join("\n");
                      void addReviewNote({
                        comment: `Please investigate and fix the failing CI checks on PR #${report.prNumber}:\n${failedNames}`,
                      });
                    }}
                  >
                    + Add Failing Checks to Review
                  </PluginButton>
                )}
              </div>

              {/* Inline File:Line Check Annotations */}
              {report.annotations.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  <div
                    style={{
                      fontSize: "11px",
                      fontWeight: 600,
                      color: "var(--dim)",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                    }}
                  >
                    Inline CI Annotations ({report.annotations.length})
                  </div>
                  {report.annotations.map((ann, idx) => (
                    <div
                      key={`${ann.filePath}:${ann.startLine}:${idx}`}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        justifyContent: "space-between",
                        gap: "10px",
                        padding: "7px 9px",
                        borderRadius: "6px",
                        background: "var(--wash)",
                        border: "1px solid var(--faint)",
                      }}
                    >
                      <div style={{ display: "flex", flexDirection: "column", gap: "3px", minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                          <PluginBadge tone={ann.level === "error" ? "error" : "warning"}>
                            {ann.checkName}
                          </PluginBadge>
                          <button
                            type="button"
                            onClick={() =>
                              openFile(ann.filePath, {
                                line: ann.startLine,
                                viewKind: "diff",
                              })
                            }
                            style={{
                              background: "transparent",
                              border: "none",
                              padding: 0,
                              color: "#8cb4ff",
                              fontFamily: "var(--mono)",
                              fontSize: "11.5px",
                              cursor: "pointer",
                              textDecoration: "underline",
                            }}
                          >
                            {ann.filePath}:{ann.startLine}
                          </button>
                        </div>
                        <div
                          style={{
                            color: "var(--ink)",
                            fontFamily: "var(--mono)",
                            fontSize: "11.5px",
                            whiteSpace: "pre-wrap",
                          }}
                        >
                          {ann.message}
                        </div>
                      </div>
                      <PluginButton
                        variant="ghost"
                        onClick={() =>
                          void addReviewNote({
                            filePath: ann.filePath,
                            startLine: ann.startLine,
                            endLine: ann.endLine,
                            comment: `Fix CI check failure (${ann.checkName}): ${ann.message}`,
                          })
                        }
                      >
                        + Note
                      </PluginButton>
                    </div>
                  ))}
                </div>
              )}

              {/* Check Runs Rollup */}
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <div
                  style={{
                    fontSize: "11px",
                    fontWeight: 600,
                    color: "var(--dim)",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                  }}
                >
                  Checks ({report.checks.length})
                </div>
                {report.checks.length === 0 ? (
                  <div style={{ color: "var(--dim)", fontSize: "11.5px" }}>
                    No status checks reported on this Pull Request.
                  </div>
                ) : (
                  report.checks.map((chk, idx) => (
                    <div
                      key={`${chk.name}-${idx}`}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "4px 8px",
                        borderRadius: "5px",
                        background: "var(--wash)",
                        border: "1px solid var(--faint)",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <PluginBadge
                          tone={
                            chk.state === "success"
                              ? "success"
                              : chk.state === "failure"
                                ? "error"
                                : chk.state === "pending"
                                  ? "warning"
                                  : "neutral"
                          }
                        >
                          {chk.state === "success"
                            ? "✓"
                            : chk.state === "failure"
                              ? "✕"
                              : chk.state === "pending"
                                ? "●"
                                : "–"}{" "}
                          {chk.rawConclusion}
                        </PluginBadge>
                        <span style={{ fontWeight: 500 }}>{chk.name}</span>
                        {chk.workflow && (
                          <span style={{ color: "var(--dim)", fontSize: "11px" }}>
                            ({chk.workflow})
                          </span>
                        )}
                      </div>
                      {chk.url && (
                        <PluginButton
                          variant="ghost"
                          onClick={() => openExternalUrl(chk.url!)}
                        >
                          Logs ↗
                        </PluginButton>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </PluginPanel>
      );
    },
  );
});
