import { defineServerPlugin, type PluginLineDecorationInput } from "@expect2/ide2-plugin/server";

interface GhStatusCheckItem {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
  workflowName?: string;
}

interface GhPrViewResponse {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft?: boolean;
  reviewDecision?: string | null;
  headRefOid?: string;
  statusCheckRollup?: GhStatusCheckItem[];
}

interface GhCheckAnnotation {
  path?: string;
  start_line?: number;
  end_line?: number;
  annotation_level?: "failure" | "warning" | "notice" | string;
  title?: string | null;
  message?: string;
  blob_href?: string;
}

export interface PrCheckNormalized {
  name: string;
  workflow?: string;
  state: "success" | "failure" | "pending" | "neutral";
  rawConclusion: string;
  url?: string;
}

export interface PrAnnotationNormalized {
  filePath: string;
  startLine: number;
  endLine: number;
  level: "error" | "warning" | "info";
  checkName: string;
  title: string;
  message: string;
  url?: string;
}

export interface WorktreePrReport {
  status: "ok" | "no_github_remote" | "no_pr" | "gh_unavailable" | "error";
  repoSlug?: string;
  branch?: string;
  prNumber?: number;
  prTitle?: string;
  prUrl?: string;
  prState?: string;
  isDraft?: boolean;
  reviewDecision?: string | null;
  checks: PrCheckNormalized[];
  annotations: PrAnnotationNormalized[];
  checkedAt: number;
  message?: string;
}

function parseGitHubSlug(remoteUrl?: string): string | null {
  if (!remoteUrl) return null;
  const trimmed = remoteUrl.trim();
  const httpsMatch = /^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(
    trimmed,
  );
  if (httpsMatch) return `${httpsMatch[1]}/${httpsMatch[2]}`;
  const sshMatch = /^(?:git@|ssh:\/\/git@)github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(
    trimmed,
  );
  if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`;
  return null;
}

function normalizeCheckState(item: GhStatusCheckItem): PrCheckNormalized {
  const name = item.name || item.context || "check";
  const url = item.detailsUrl || item.targetUrl;
  const conclusion = (item.conclusion || item.state || item.status || "").toUpperCase();

  let state: PrCheckNormalized["state"] = "neutral";
  if (["SUCCESS", "PASSED"].includes(conclusion)) {
    state = "success";
  } else if (
    ["FAILURE", "FAILED", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"].includes(
      conclusion,
    )
  ) {
    state = "failure";
  } else if (["IN_PROGRESS", "QUEUED", "PENDING", "WAITING", "REQUESTED", "EXPECTED"].includes(conclusion)) {
    state = "pending";
  }

  return {
    name,
    workflow: item.workflowName,
    state,
    rawConclusion: conclusion || "UNKNOWN",
    url,
  };
}

export default defineServerPlugin(async (ctx) => {
  const ghBin = process.env.IDE2_GH_BIN || "gh";
  const reportsByWorktree = new Map<string, WorktreePrReport>();

  const inspectWorktree = async (worktreePath: string, force = false): Promise<WorktreePrReport> => {
    const existing = reportsByWorktree.get(worktreePath);
    if (!force && existing && Date.now() - existing.checkedAt < 25000) {
      return existing;
    }

    const [launch, worktrees] = await Promise.all([
      ctx.getLaunchContext(),
      ctx.listWorktrees(),
    ]);
    const wt = worktrees.find((w) => w.path === worktreePath) ?? worktrees[0];
    const branch = wt?.branch ?? "";
    const repoSlug = parseGitHubSlug(launch.remoteOriginUrl);

    if (!repoSlug) {
      const report: WorktreePrReport = {
        status: "no_github_remote",
        branch,
        checks: [],
        annotations: [],
        checkedAt: Date.now(),
        message: "Repository remote.origin.url does not point to github.com.",
      };
      reportsByWorktree.set(worktreePath, report);
      ctx.setDecorations(worktreePath, []);
      return report;
    }

    if (!branch || branch === "(detached)") {
      const report: WorktreePrReport = {
        status: "no_pr",
        repoSlug,
        branch,
        checks: [],
        annotations: [],
        checkedAt: Date.now(),
        message: "Worktree is on a detached HEAD.",
      };
      reportsByWorktree.set(worktreePath, report);
      ctx.setDecorations(worktreePath, []);
      return report;
    }

    let prViewRes;
    try {
      prViewRes = await ctx.exec(
        ghBin,
        [
          "pr",
          "view",
          branch,
          "--repo",
          repoSlug,
          "--json",
          "number,title,url,state,isDraft,reviewDecision,headRefOid,statusCheckRollup",
        ],
        { timeoutMs: 15000 },
      );
    } catch (err) {
      const report: WorktreePrReport = {
        status: "gh_unavailable",
        repoSlug,
        branch,
        checks: [],
        annotations: [],
        checkedAt: Date.now(),
        message: `GitHub CLI (${ghBin}) is not installed or unavailable: ${err instanceof Error ? err.message : String(err)}`,
      };
      reportsByWorktree.set(worktreePath, report);
      ctx.setDecorations(worktreePath, []);
      return report;
    }

    if (prViewRes.exitCode !== 0) {
      const stderrLower = prViewRes.stderr.toLowerCase();
      const isNoPr =
        stderrLower.includes("no pull requests found") ||
        stderrLower.includes("could not resolve to a pullrequest");
      const isAuth =
        stderrLower.includes("gh auth login") || stderrLower.includes("not logged into");
      const report: WorktreePrReport = {
        status: isNoPr ? "no_pr" : isAuth ? "gh_unavailable" : "error",
        repoSlug,
        branch,
        checks: [],
        annotations: [],
        checkedAt: Date.now(),
        message: isNoPr
          ? `No open GitHub Pull Request found for branch "${branch}" on ${repoSlug}.`
          : prViewRes.stderr.trim() || "gh pr view failed.",
      };
      reportsByWorktree.set(worktreePath, report);
      ctx.setDecorations(worktreePath, []);
      return report;
    }

    let prData: GhPrViewResponse;
    try {
      prData = JSON.parse(prViewRes.stdout) as GhPrViewResponse;
    } catch {
      const report: WorktreePrReport = {
        status: "error",
        repoSlug,
        branch,
        checks: [],
        annotations: [],
        checkedAt: Date.now(),
        message: "Malformed JSON returned by `gh pr view`.",
      };
      reportsByWorktree.set(worktreePath, report);
      return report;
    }

    const checks = (prData.statusCheckRollup ?? []).map(normalizeCheckState);
    const annotations: PrAnnotationNormalized[] = [];

    // Fetch inline check-run file:line annotations when commit SHA is known and any check failed/warned
    const hasNonPassing = checks.some((c) => c.state === "failure" || c.state === "neutral");
    if (prData.headRefOid && hasNonPassing) {
      try {
        const runsRes = await ctx.exec(
          ghBin,
          ["api", `repos/${repoSlug}/commits/${prData.headRefOid}/check-runs`],
          { timeoutMs: 12000 },
        );
        if (runsRes.exitCode === 0 && runsRes.stdout.trim()) {
          const parsedRuns = JSON.parse(runsRes.stdout) as {
            check_runs?: Array<{
              id: number;
              name?: string;
              html_url?: string;
              output?: { annotations_count?: number };
            }>;
          };
          const runsWithAnns = (parsedRuns.check_runs ?? [])
            .filter((r) => (r.output?.annotations_count ?? 0) > 0)
            .slice(0, 6);

          for (const run of runsWithAnns) {
            const annRes = await ctx.exec(
              ghBin,
              ["api", `repos/${repoSlug}/check-runs/${run.id}/annotations`],
              { timeoutMs: 10000 },
            );
            if (annRes.exitCode === 0 && annRes.stdout.trim()) {
              const rawAnns = JSON.parse(annRes.stdout) as GhCheckAnnotation[];
              for (const a of rawAnns.slice(0, 40)) {
                if (!a.path || a.path === ".github" || !a.start_line) continue;
                const level: PrAnnotationNormalized["level"] =
                  a.annotation_level === "failure"
                    ? "error"
                    : a.annotation_level === "warning"
                      ? "warning"
                      : "info";
                annotations.push({
                  filePath: a.path.replace(/^\/+/, ""),
                  startLine: a.start_line,
                  endLine: a.end_line ?? a.start_line,
                  level,
                  checkName: run.name ?? "CI",
                  title: a.title?.trim() || `${run.name ?? "CI"}: ${a.annotation_level ?? "issue"}`,
                  message: (a.message ?? "").trim(),
                  url: run.html_url,
                });
              }
            }
          }
        }
      } catch {
        // Non-fatal check-run annotation fetch error
      }
    }

    const decorations: PluginLineDecorationInput[] = annotations.map((ann, idx) => ({
      id: `pr-check-ann-${idx}-${ann.filePath}-${ann.startLine}`,
      worktreePath,
      filePath: ann.filePath,
      side: "new",
      startLine: ann.startLine,
      endLine: ann.endLine,
      severity: ann.level,
      gutterBadge: ann.level === "error" ? "✕" : "!",
      title: `${ann.checkName}: ${ann.message.split(/\r?\n/)[0] ?? ann.title}`,
      hoverMarkdown: [
        `**${ann.title}** (\`${ann.checkName}\` · PR #${prData.number})`,
        "",
        "```text",
        ann.message,
        "```",
      ].join("\n"),
      url: ann.url ?? prData.url,
    }));

    ctx.setDecorations(worktreePath, decorations);

    const report: WorktreePrReport = {
      status: "ok",
      repoSlug,
      branch,
      prNumber: prData.number,
      prTitle: prData.title,
      prUrl: prData.url,
      prState: prData.state,
      isDraft: prData.isDraft,
      reviewDecision: prData.reviewDecision,
      checks,
      annotations,
      checkedAt: Date.now(),
    };
    reportsByWorktree.set(worktreePath, report);
    ctx.emitClientEvent("pr-report-updated", { worktreePath, report });
    return report;
  };

  ctx.handleRpc("getPrReport", async (payload, meta) => {
    const p = (payload ?? {}) as { worktreePath?: string; force?: boolean };
    const wtPath = p.worktreePath ?? meta.worktreePath;
    if (!wtPath) {
      const wts = await ctx.listWorktrees();
      if (!wts[0]) return null;
      return inspectWorktree(wts[0].path, Boolean(p.force));
    }
    return inspectWorktree(wtPath, Boolean(p.force));
  });

  ctx.handleAction("refresh-pr-checks", async ({ worktreePath }) => {
    if (worktreePath) {
      await inspectWorktree(worktreePath, true);
      return;
    }
    const wts = await ctx.listWorktrees();
    for (const wt of wts) {
      await inspectWorktree(wt.path, true);
    }
  });

  ctx.registerPromptEnricher(async ({ worktree, markdown }) => {
    const report = reportsByWorktree.get(worktree.path);
    if (!report || report.status !== "ok") return markdown;
    const failing = report.checks.filter((c) => c.state === "failure");
    if (failing.length === 0 && report.annotations.length === 0) return markdown;

    const lines = [
      markdown.trimEnd(),
      "",
      `## GitHub PR #${report.prNumber} Failing CI Checks`,
      "",
    ];
    for (const f of failing) {
      lines.push(`- **${f.name}** (${f.rawConclusion})${f.url ? ` — ${f.url}` : ""}`);
    }
    for (const ann of report.annotations.slice(0, 12)) {
      lines.push(
        `- \`${ann.filePath}:${ann.startLine}\` [${ann.checkName}]: ${ann.message.split(/\r?\n/)[0]}`,
      );
    }
    return `${lines.join("\n")}\n`;
  });

  // Prime active initial worktree non-blockingly on load
  void ctx
    .getLaunchContext()
    .then((lc) => {
      if (lc.initialWorktreePath) {
        return inspectWorktree(lc.initialWorktreePath, false);
      }
      return undefined;
    })
    .catch(() => {});

  return () => {
    ctx.clearDecorations();
  };
});
