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
    "2. Start the session with `ide2 tour start --title \"...\" --total <N>`.",
    "3. Drive the walkthrough ONE step at a time using `ide2 tour step`, going top-down from high-level architecture -> key folders -> files -> key code sections.",
    "4. Pass rich Markdown explanations via heredoc stdin (`<<'EOF' ... EOF`). Each `ide2 tour step` call blocks until I click Next or send a steering question inside `ide2`:",
    "   - On `ACTION: next`, advance to the next logical step.",
    "   - On `ACTION: steer`, adapt your very next step to answer or zoom into `MESSAGE:`.",
    "   - On `ACTION: waiting`, run `ide2 tour wait` to keep waiting while I finish reading.",
    "   - On `ACTION: stop`, end immediately.",
    "5. Mark the last step with `--final` (or run `ide2 tour end` when finished).",
  ].join("\n");
}

export function buildWalkthroughSkillMarkdown(): string {
  return [
    "---",
    "name: ide2-tour",
    "description: Drive interactive, step-by-step codebase walkthroughs inside the ide2 desktop IDE. Use when the user asks you to walk them through a codebase, feature, pull request, or architecture using ide2.",
    "---",
    "",
    "# ide2 Interactive Codebase Walkthroughs (`ide2 tour`)",
    "",
    "Use `ide2 tour` to guide the developer through a repository **top-down, one step at a time** inside `ide2`.",
    "`ide2` opens each folder, file, line range, or diff automatically, spotlights the target lines, renders your Markdown (and Mermaid) explanation inline, and blocks until the developer clicks **Next →** or types a steering question.",
    "",
    "## Workflow",
    "",
    "1. **Survey first**: Understand the architecture and plan a concise top-down sequence (typically 5–10 steps: Architecture Overview → Core Folders → Key Files → Critical Code Sections).",
    "2. **Start the tour**:",
    "   ```bash",
    "   ide2 tour start --title \"Architecture Walkthrough\" --total 6",
    "   ```",
    "   *(If `ide2` is not open yet on this repo, `ide2 tour` launches it automatically.)*",
    "3. **Push ONE step at a time** (always use a single-quoted heredoc for multiline Markdown / code / Mermaid):",
    "   ```bash",
    "   # 1) High-level overview (supports Mermaid diagrams)",
    "   ide2 tour step --step 1 --total 6 --title \"System Overview\" <<'EOF'",
    "   High-level data flow across main, worker, and renderer...",
    "   EOF",
    "",
    "   # 2) Folder step (expands & highlights folder in Project tree)",
    "   ide2 tour step --step 2 --total 6 --target src/main/services --title \"Core Services\" <<'EOF'",
    "   This directory owns Git discovery, file watching, and annotations...",
    "   EOF",
    "",
    "   # 3) Exact line-range step (spotlights lines & anchors callout card below line 678)",
    "   ide2 tour step --step 3 --total 6 --target src/main/services/git.ts:628-678 --title \"Worktree Isolation\" <<'EOF'",
    "   `discoverWorktrees` verifies `--git-common-dir` and `--show-toplevel`...",
    "   EOF",
    "",
    "   # 4) Diff step (optional, great for PR / branch walkthroughs)",
    "   ide2 tour step --diff --target src/auth.ts:14-28 --title \"Auth Token Check\" <<'EOF'",
    "   Notice how missing headers now fail closed...",
    "   EOF",
    "   ```",
    "4. **React to `ide2 tour step` stdout**:",
    "   - `ACTION: next` → Push the next step.",
    "   - `ACTION: steer` + `MESSAGE: <text>` → The user asked a question or requested a detour right inside `ide2`. Immediately tailor your next `ide2 tour step` to address `<text>` before resuming the main arc.",
    "   - `ACTION: waiting` → The user is still reading; run `ide2 tour wait` to continue waiting without re-pushing the step.",
    "   - `ACTION: stop` or `ACTION: finish` → Stop pushing steps (`ide2 tour end`).",
    "5. **Finish cleanly**: Pass `--final` on the concluding step (or run `ide2 tour end`).",
    "",
  ].join("\n");
}
