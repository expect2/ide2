import { homedir, userInfo } from "node:os";
import { join } from "node:path";

export interface TourEndpointPaths {
  runDir: string;
  socketPath: string;
  tokenPath: string;
  pidPath: string;
  ipcDir: string;
}

export function getTourEndpointPaths(customRunDir?: string): TourEndpointPaths {
  const runDir =
    customRunDir ??
    process.env.IDE2_RUN_DIR ??
    join(homedir(), ".expect2-ide", "run");
  const tokenPath = join(runDir, "ide2.token");
  const pidPath = join(runDir, "ide2.pid");
  const ipcDir = join(runDir, "ipc");

  if (process.platform === "win32" && !customRunDir && !process.env.IDE2_RUN_DIR) {
    let username = "user";
    try {
      username = userInfo().username.replace(/[^a-zA-Z0-9._-]/g, "_");
    } catch {
      // fallback
    }
    return {
      runDir,
      socketPath: `\\\\.\\pipe\\ide2-tour-${username}`,
      tokenPath,
      pidPath,
      ipcDir,
    };
  }

  return {
    runDir,
    socketPath: join(runDir, "ide2.sock"),
    tokenPath,
    pidPath,
    ipcDir,
  };
}

export function buildWalkthroughAgentPrompt(repoName?: string): string {
  const scopeLabel = repoName ? `the \`${repoName}\` repository` : "this repository";
  return [
    `Walk me through ${scopeLabel} top-down using \`ide2\`.`,
    "",
    "1. First run `ide2 tour --help` to see the exact CLI flags and response format.",
    "2. Prepare the full walkthrough in advance BEFORE starting Step 1: explore the codebase up front, verify exact file paths and line ranges, and plan the complete top-down sequence (high-level architecture -> key folders -> files -> key code/diff sections) so stepping through is fast and cohesive.",
    "3. Start the session with `ide2 tour start --title \"...\" --total <N>` using your planned step count.",
    "4. Drive the prepared walkthrough ONE step at a time using `ide2 tour step`, passing rich Markdown explanations via heredoc stdin (`<<'EOF' ... EOF`). Each `ide2 tour step` call blocks until I click Next or send a steering question inside `ide2`:",
    "   - On `ACTION: next`, immediately push the next prepared step.",
    "   - On `ACTION: steer`, update your remaining walkthrough plan if needed and adapt your very next step to answer or zoom into `MESSAGE:` (updating `--total` if you add or reorder steps).",
    "   - On `ACTION: waiting`, run `ide2 tour wait` to keep waiting while I finish reading.",
    "   - On `ACTION: stop`, end immediately.",
    "5. Mark the last step with `--final` (or run `ide2 tour end` when finished).",
  ].join("\n");
}

export function buildReviewAgentPrompt(repoName?: string): string {
  const scopeLabel = repoName ? `\`${repoName}\`` : "this repository";
  return [
    `Wait for my code review feedback on ${scopeLabel} directly via \`ide2\` (no copy/paste).`,
    "",
    "1. Run `ide2 review wait --resolve` (it launches/focuses `ide2` and blocks until I click **Send to Agent** or **Approve**).",
    "2. React to stdout:",
    "   - On `ACTION: waiting`, run `ide2 review wait --resolve` again to keep waiting while I finish reviewing.",
    "   - On `ACTION: feedback`, address every item in the Markdown feedback printed below it, then run `ide2 review wait --resolve` again for the next review round.",
    "   - On `ACTION: approved` or `ACTION: cancel`, finish cleanly.",
  ].join("\n");
}

export function buildWalkthroughSkillMarkdown(): string {
  return [
    "---",
    "name: ide2",
    "description: Collaborate with the developer inside the ide2 desktop IDE — drive interactive step-by-step codebase walkthroughs (`ide2 tour`) and receive live code review feedback directly over IPC without copy/paste (`ide2 review wait` / `ide2 --export`).",
    "---",
    "",
    "# ide2 Agent Collaboration (`ide2 tour` & `ide2 review`)",
    "",
    "`ide2` is a read-only desktop IDE with local IPC for coding agents. Use it for two workflows:",
    "",
    "1. **Live Code Review Loop (`ide2 review wait`)** — Wait for the developer's line-anchored review annotations directly over IPC (no copy/paste).",
    "2. **Interactive Codebase Walkthroughs (`ide2 tour`)** — Guide the developer top-down through a codebase, feature, or diff one step at a time.",
    "",
    "---",
    "",
    "## 1. Live Code Review Loop (`ide2 review`)",
    "",
    "When the developer asks you to wait for their review in `ide2`, or after completing a feature they want to review:",
    "",
    "```bash",
    "ide2 review wait --resolve [--diff] [--label \"Auth changes\"] [--worktree <name>]",
    "```",
    "",
    "- `ide2` activates a live **Send to Agent →** and **Approve ✓** bar in the UI.",
    "- React to stdout:",
    "  - `ACTION: feedback` → The full line-anchored Markdown feedback prompt follows immediately on stdout. Address every item, then call `ide2 review wait --resolve` again for the next round.",
    "  - `ACTION: waiting` → The developer is still reviewing; call `ide2 review wait --resolve` again to resume waiting without disturbing the UI.",
    "  - `ACTION: approved` or `ACTION: cancel` → Review complete; stop waiting.",
    "",
    "To pull open annotations on demand (without blocking), run:",
    "```bash",
    "ide2 --export [--resolve] [--worktree <name>]",
    "```",
    "",
    "---",
    "",
    "## 2. Interactive Codebase Walkthroughs (`ide2 tour`)",
    "",
    "When asked to walk the developer through a repository, architecture, or PR:",
    "",
    "1. **Prepare the full walkthrough in advance** before calling `ide2 tour start`: read the relevant files, verify exact line ranges/targets, and plan the complete top-down sequence (typically 5–10 steps: Architecture Overview → Core Folders → Key Files → Critical Code/Diff Sections) so each `Next →` click advances immediately without research pauses.",
    "2. **Start the tour** with your planned `--total`:",
    "   ```bash",
    "   ide2 tour start --title \"Architecture Walkthrough\" --total 6",
    "   ```",
    "3. **Push ONE step at a time** (use a single-quoted heredoc for Markdown / Mermaid):",
    "   ```bash",
    "   # Overview step (supports Mermaid diagrams)",
    "   ide2 tour step --step 1 --total 6 --title \"System Overview\" <<'EOF'",
    "   High-level data flow across main, worker, and renderer...",
    "   EOF",
    "",
    "   # Folder step (expands & highlights folder in Project tree)",
    "   ide2 tour step --step 2 --total 6 --target src/main/services --title \"Core Services\" <<'EOF'",
    "   This directory owns Git discovery, file watching, and annotations...",
    "   EOF",
    "",
    "   # Line-range step (spotlights lines & anchors callout card below line 678)",
    "   ide2 tour step --step 3 --total 6 --target src/main/services/git.ts:628-678 --title \"Worktree Isolation\" <<'EOF'",
    "   `discoverWorktrees` verifies `--git-common-dir` and `--show-toplevel`...",
    "   EOF",
    "",
    "   # Diff step",
    "   ide2 tour step --diff --target src/auth.ts:14-28 --title \"Auth Token Check\" <<'EOF'",
    "   Notice how missing headers now fail closed...",
    "   EOF",
    "   ```",
    "4. **React to `ide2 tour step` stdout**:",
    "   - `ACTION: next` → Immediately push the next prepared step.",
    "   - `ACTION: steer` + `MESSAGE: <text>` → Update your remaining walkthrough plan if needed and immediately adapt your next step to answer or zoom into `<text>` (updating `--total` if you add or reorder steps).",
    "   - `ACTION: waiting` → Run `ide2 tour wait` to keep waiting while the developer reads.",
    "   - `ACTION: stop` or `ACTION: finish` → Stop pushing steps (`ide2 tour end`).",
    "5. **Finish cleanly**: Pass `--final` on the last step (or run `ide2 tour end`).",
    "",
  ].join("\n");
}
