import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runCliInstallSkill, runCliReview, runCliTour, sendTourRpc } from "../src/cli/tour.js";
import { TourServer } from "../src/main/services/tour-server.js";
import type { ReviewSessionState, WalkthroughState } from "../src/shared/protocol.js";

const APP_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const IDE2_BIN = resolve(APP_ROOT, "bin/ide2.mjs");

const tempDirs: string[] = [];
const activeServers: TourServer[] = [];

function makeShortTempDir(prefix: string): string {
  // Use /tmp directly so Unix domain socket paths stay well under macOS 104-byte sun_path limit
  const base = existsSync("/tmp") ? "/tmp" : process.cwd();
  const dir = realpathSync(mkdtempSync(join(base, prefix)));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 1500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = fn();
    if (val) return val;
    await new Promise((r) => setTimeout(r, 12));
  }
  throw new Error("Timed out waiting for expected walkthrough server state.");
}

afterEach(async () => {
  while (activeServers.length > 0) {
    const srv = activeServers.pop();
    if (srv) {
      await srv.close();
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("Agent-Driven Codebase Walkthrough (`ide2 tour`)", () => {
  it("supports `ide2 tour --help`, `prompt`, and `install-skill` (plus `walkthrough` alias)", async () => {
    const tmp = makeShortTempDir("ide2-tskill-");
    const helpOut = await runCliTour({
      cwd: APP_ROOT,
      appRoot: APP_ROOT,
      argv: ["--help"],
      autoLaunch: false,
    });
    expect(helpOut).toContain("ide2 tour — drive interactive, step-by-step codebase walkthroughs");
    expect(helpOut).toContain("ACTION: next");
    expect(helpOut).toContain("ACTION: steer");
    expect(helpOut).toContain("ACTION: waiting");

    const promptOut = await runCliTour({
      cwd: APP_ROOT,
      appRoot: APP_ROOT,
      argv: ["prompt"],
      autoLaunch: false,
    });
    expect(promptOut).toContain("ide2 tour --help");
    expect(promptOut).toContain("Prepare the full walkthrough in advance");
    expect(promptOut).toContain("update your remaining walkthrough plan");
    expect(promptOut).toContain("ide2 tour step");

    const skillDir = join(tmp, "custom-skill");
    const installOut = await runCliTour({
      cwd: APP_ROOT,
      appRoot: APP_ROOT,
      argv: ["install-skill", "--dir", skillDir],
      autoLaunch: false,
    });
    const skillFile = join(skillDir, "SKILL.md");
    expect(installOut).toContain(skillFile);
    expect(existsSync(skillFile)).toBe(true);
    const skillContent = readFileSync(skillFile, "utf8");
    expect(skillContent).toContain("name: ide2");
    expect(skillContent).toContain("ide2 tour step");
    expect(skillContent).toContain("ide2 review wait");

    // Top-level `ide2 install-skill --dir ...` writes the same unified skill
    const topSkillDir = join(tmp, "top-skill");
    const topInstallOut = await runCliInstallSkill({
      cwd: APP_ROOT,
      argv: ["--dir", topSkillDir],
    });
    expect(topInstallOut).toContain(join(topSkillDir, "SKILL.md"));
    expect(readFileSync(join(topSkillDir, "SKILL.md"), "utf8")).toBe(skillContent);

    // Verify `ide2 review --help` & `ide2 review prompt`
    const reviewHelpOut = await runCliReview({
      cwd: APP_ROOT,
      appRoot: APP_ROOT,
      argv: ["--help"],
      autoLaunch: false,
    });
    expect(reviewHelpOut).toContain("ide2 review — receive live code review feedback");
    expect(reviewHelpOut).toContain("ACTION: feedback");
    expect(reviewHelpOut).toContain("ACTION: approved");

    const reviewPromptOut = await runCliReview({
      cwd: APP_ROOT,
      appRoot: APP_ROOT,
      argv: ["prompt"],
      autoLaunch: false,
    });
    expect(reviewPromptOut).toContain("ide2 review wait");

    // Verify subprocess routing via `node bin/ide2.mjs walkthrough --help` and `review --help`
    const sub = spawnSync(process.execPath, [IDE2_BIN, "walkthrough", "--help"], {
      cwd: APP_ROOT,
      encoding: "utf8",
    });
    expect(sub.status).toBe(0);
    expect(sub.stdout).toBe(helpOut);

    const subReview = spawnSync(process.execPath, [IDE2_BIN, "review", "--help"], {
      cwd: APP_ROOT,
      encoding: "utf8",
    });
    expect(subReview.status).toBe(0);
    expect(subReview.stdout).toBe(reviewHelpOut);
  });

  it("drives synchronous step-by-step tours (overview -> folder -> range + timeout/wait -> diff final) and enforces security", async () => {
    const root = makeShortTempDir("ide2-trpc-");
    const runDir = join(root, "run");
    const repoDir = join(root, "repo");
    const outsideFile = join(root, "secret.txt");
    mkdirSync(join(repoDir, "src", "services"), { recursive: true });
    writeFileSync(outsideFile, "secret\n", "utf8");

    git(repoDir, ["init", "-b", "main"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Tour Tester"]);
    writeFileSync(
      join(repoDir, "src", "services", "auth.ts"),
      [
        "export function verifyToken(raw?: string): boolean {",
        "  if (!raw) return false;",
        "  const parts = raw.split(' ');",
        "  return parts[0] === 'Bearer' && Boolean(parts[1]);",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "init"]);

    const canonRepo = realpathSync(repoDir);
    const canonCommonDir = realpathSync(join(canonRepo, ".git"));

    const broadcasts: Array<WalkthroughState[]> = [];
    const server = new TourServer(
      {
        ensureRepoWindow: async () => ({
          repoCommonDir: canonCommonDir,
          repoName: "repo",
          worktreePath: canonRepo,
          worktrees: [],
        }),
        broadcastWalkthrough: (_commonDir, states) => {
          broadcasts.push(structuredClone(states));
        },
      },
      runDir,
    );
    activeServers.push(server);
    await server.listen();

    // 0. Start walkthrough session
    const startOut = await runCliTour({
      cwd: canonRepo,
      appRoot: APP_ROOT,
      runDir,
      autoLaunch: false,
      argv: ["start", "--title", "Auth Deep Dive", "--total", "4"],
    });
    expect(startOut).toContain("ACTION: started");

    // 1. Overview step — blocks until user clicks "Next"
    const step1Promise = runCliTour({
      cwd: canonRepo,
      appRoot: APP_ROOT,
      runDir,
      autoLaunch: false,
      argv: ["step", "--title", "System Architecture"],
      stdinText: "High-level overview with `verifyToken`.",
    });

    const state1 = await waitFor(() => {
      const s = server.getState(canonCommonDir);
      return s && s.steps.length === 1 && s.awaitingUser ? s : null;
    });
    expect(state1.title).toBe("Auth Deep Dive");
    expect(state1.totalSteps).toBe(4);
    expect(state1.awaitingUser).toBe(true);
    expect(state1.steps[0]?.targetKind).toBe("overview");

    server.respondFromUser(canonCommonDir, {
      stepId: state1.activeStepId,
      action: "next",
    });
    expect(await step1Promise).toBe("ACTION: next\nSTEP: 1\n");

    // Immediately after user clicks Next, session enters `agentThinking = true`
    expect(server.getState(canonCommonDir)?.agentThinking).toBe(true);

    // 2. Folder step — blocks until user sends an inline steering message
    const step2Promise = runCliTour({
      cwd: canonRepo,
      appRoot: APP_ROOT,
      runDir,
      autoLaunch: false,
      argv: ["step", "--target", "src/services", "--title", "Services Directory"],
      stdinText: "Core backend services live here.",
    });

    const state2 = await waitFor(() => {
      const s = server.getState(canonCommonDir);
      return s && s.steps.length === 2 && s.awaitingUser ? s : null;
    });
    expect(state2.steps).toHaveLength(2);
    expect(state2.steps[1]?.targetKind).toBe("folder");
    expect(state2.steps[1]?.targetPath).toBe("src/services");
    expect(state2.steps[1]?.folderFiles).toContain("src/services/auth.ts");

    server.respondFromUser(canonCommonDir, {
      stepId: state2.activeStepId,
      action: "steer",
      message: "Show me how Bearer tokens are split",
    });
    expect(await step2Promise).toBe(
      "ACTION: steer\nSTEP: 2\nMESSAGE: Show me how Bearer tokens are split\n",
    );

    // 3. Range step with short `--wait-timeout` -> returns `ACTION: waiting`, then buffered click + `ide2 tour wait`
    const step3TimeoutOut = await runCliTour({
      cwd: canonRepo,
      appRoot: APP_ROOT,
      runDir,
      autoLaunch: false,
      argv: [
        "step",
        "--target",
        "src/services/auth.ts:2-4",
        "--title",
        "Token Parsing",
        "--wait-timeout",
        "0.06",
      ],
      stdinText: "Splits on space and checks `Bearer` prefix.",
    });
    expect(step3TimeoutOut).toContain("ACTION: waiting");
    expect(step3TimeoutOut).toContain("STEP: 3");

    // Step 3 remains active and awaitingUser in ide2!
    const state3 = server.getState(canonCommonDir);
    expect(state3?.awaitingUser).toBe(true);
    expect(state3?.steps[2]?.targetKind).toBe("range");
    expect(state3?.steps[2]?.startLine).toBe(2);
    expect(state3?.steps[2]?.endLine).toBe(4);

    // User clicks Next right BEFORE agent calls `ide2 tour wait` -> buffered cleanly without losing the click!
    server.respondFromUser(canonCommonDir, {
      stepId: state3!.activeStepId,
      action: "next",
    });

    const resumedWaitOut = await runCliTour({
      cwd: canonRepo,
      appRoot: APP_ROOT,
      runDir,
      autoLaunch: false,
      argv: ["wait", "--wait-timeout", "1"],
    });
    expect(resumedWaitOut).toBe("ACTION: next\nSTEP: 3\n");

    // 4. Final diff step -> user clicks Finish -> clears state
    const step4Promise = runCliTour({
      cwd: canonRepo,
      appRoot: APP_ROOT,
      runDir,
      autoLaunch: false,
      argv: [
        "step",
        "--diff",
        "--target",
        "src/services/auth.ts:1-4",
        "--final",
        "--title",
        "Wrap-up",
        "--body",
        "Walkthrough complete!",
      ],
    });

    const state4 = await waitFor(() => {
      const s = server.getState(canonCommonDir);
      return s && s.steps.length === 4 && s.awaitingUser ? s : null;
    });
    expect(state4.steps[3]?.targetKind).toBe("diff");
    expect(state4.steps[3]?.final).toBe(true);

    server.respondFromUser(canonCommonDir, {
      stepId: state4.activeStepId,
      action: "finish",
    });
    expect(await step4Promise).toBe("ACTION: finish\nSTEP: 4\n");
    expect(server.getState(canonCommonDir)).toBeNull();

    // 5. Security: path traversal outside worktree & bad auth token are rejected
    await expect(
      runCliTour({
        cwd: canonRepo,
        appRoot: APP_ROOT,
        runDir,
        autoLaunch: false,
        argv: ["step", "--target", "../secret.txt", "--title", "Escape", "--no-wait"],
      }),
    ).rejects.toThrow(/Refused walkthrough target outside worktree/);

    await expect(
      sendTourRpc(server.getEndpointPaths(), "wrong-secret-token", "ping"),
    ).rejects.toThrow(/Unauthorized token/);
    expect(broadcasts.length).toBeGreaterThan(0);
  });

  it("drives zero-copy-paste live review loop (`ide2 review wait` -> feedback -> timeout + buffered approve -> status/end)", async () => {
    const root = makeShortTempDir("ide2-rev-");
    const runDir = join(root, "run");
    const repoDir = join(root, "repo");
    mkdirSync(repoDir, { recursive: true });

    git(repoDir, ["init", "-b", "main"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Review Tester"]);
    writeFileSync(join(repoDir, "app.ts"), "export const ok = true;\n", "utf8");
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "init"]);

    const canonRepo = realpathSync(repoDir);
    const canonCommonDir = realpathSync(join(canonRepo, ".git"));

    const reviewBroadcasts: Array<ReviewSessionState[]> = [];
    const seenDiffFlags: Array<boolean | undefined> = [];
    const server = new TourServer(
      {
        ensureRepoWindow: async (params) => {
          seenDiffFlags.push(params.diff);
          return {
            repoCommonDir: canonCommonDir,
            repoName: "repo",
            worktreePath: canonRepo,
            worktrees: [],
          };
        },
        broadcastWalkthrough: () => {},
        broadcastReview: (_commonDir, states) => {
          reviewBroadcasts.push(structuredClone(states));
        },
      },
      runDir,
    );
    activeServers.push(server);
    await server.listen();

    // 1. Agent calls `ide2 review wait --diff --label "Auth fixes"` and blocks until developer clicks Send to Agent
    const round1Promise = runCliReview({
      cwd: canonRepo,
      appRoot: APP_ROOT,
      runDir,
      autoLaunch: false,
      argv: ["wait", "--diff", "--label", "Auth fixes"],
    });

    const reviewState1 = await waitFor(() => {
      const s = server.getReviewState(canonCommonDir);
      return s && s.awaitingUser ? s : null;
    });
    expect(reviewState1.label).toBe("Auth fixes");
    expect(reviewState1.agentWorking).toBe(false);
    expect(seenDiffFlags).toContain(true);

    const feedbackMd = "# Code Review Feedback — `repo`\n\n## 1. `app.ts:1`\nAdd strict return type.";
    expect(
      server.respondReviewFromUser(canonCommonDir, {
        action: "feedback",
        count: 2,
        markdown: feedbackMd,
      }),
    ).toBe(true);

    const round1Out = await round1Promise;
    expect(round1Out).toBe(`ACTION: feedback\nROUND: 1\nANNOTATIONS: 2\n\n${feedbackMd}\n`);

    // Immediately transitions to `agentWorking: true` while agent implements the feedback
    const workingState = server.getReviewState(canonCommonDir);
    expect(workingState?.agentWorking).toBe(true);
    expect(workingState?.awaitingUser).toBe(false);
    expect(workingState?.round).toBe(1);

    // 2. Agent returns for round 2 with short `--wait-timeout` -> returns `ACTION: waiting`
    const round2TimeoutOut = await runCliReview({
      cwd: canonRepo,
      appRoot: APP_ROOT,
      runDir,
      autoLaunch: false,
      argv: ["wait", "--wait-timeout", "0.06"],
    });
    expect(round2TimeoutOut).toContain("ACTION: waiting");
    expect(round2TimeoutOut).toContain("ROUND: 1");
    expect(server.getReviewState(canonCommonDir)?.awaitingUser).toBe(true);

    // Status reflects active waiting session
    const statusJson = JSON.parse(
      await runCliReview({
        cwd: canonRepo,
        appRoot: APP_ROOT,
        runDir,
        autoLaunch: false,
        argv: ["status"],
      }),
    ) as { active: boolean; awaitingUser: boolean; round: number };
    expect(statusJson.active).toBe(true);
    expect(statusJson.awaitingUser).toBe(true);
    expect(statusJson.round).toBe(1);

    // 3. Developer clicks Approve right BEFORE agent resumes `ide2 review wait` -> buffered without losing click!
    expect(
      server.respondReviewFromUser(canonCommonDir, {
        action: "approve",
        count: 0,
      }),
    ).toBe(true);
    // UI state clears immediately so the green bar disappears
    expect(server.getReviewState(canonCommonDir)).toBeNull();

    // Agent calls `ide2 review wait` and receives the buffered approval cleanly
    const approvedOut = await runCliReview({
      cwd: canonRepo,
      appRoot: APP_ROOT,
      runDir,
      autoLaunch: false,
      argv: ["wait", "--wait-timeout", "1"],
    });
    expect(approvedOut).toBe("ACTION: approved\nROUND: 1\n");
    expect(server.getReviewState(canonCommonDir)).toBeNull();

    // 4. `ide2 review end` closes an active waiting session cleanly
    const waitToEndPromise = runCliReview({
      cwd: canonRepo,
      appRoot: APP_ROOT,
      runDir,
      autoLaunch: false,
      argv: ["wait", "--wait-timeout", "5"],
    });
    await waitFor(() => server.getReviewState(canonCommonDir));

    const endOut = await runCliReview({
      cwd: canonRepo,
      appRoot: APP_ROOT,
      runDir,
      autoLaunch: false,
      argv: ["end"],
    });
    expect(endOut).toBe("ACTION: ended\n");
    expect(await waitToEndPromise).toBe("ACTION: cancel\nROUND: 0\n");
    expect(server.getReviewState(canonCommonDir)).toBeNull();
    expect(reviewBroadcasts.length).toBeGreaterThan(0);
  });

  it("isolates concurrent agents across multiple worktrees, multiple repos, and same-worktree multi-agent sessions", async () => {
    const root = makeShortTempDir("ide2-multi-");
    const runDir = join(root, "run");

    // Repo A with two worktrees: wt-auth (main) and wt-billing (linked worktree)
    const repoA = join(root, "repo-a");
    const wtBilling = join(root, "wt-billing");
    const wtOther = join(root, "wt-other");
    mkdirSync(repoA, { recursive: true });
    git(repoA, ["init", "-b", "main"]);
    git(repoA, ["config", "user.email", "test@example.com"]);
    git(repoA, ["config", "user.name", "Multi Tester"]);
    writeFileSync(join(repoA, "auth.ts"), "export const auth = 1;\n", "utf8");
    git(repoA, ["add", "."]);
    git(repoA, ["commit", "-m", "init A"]);
    git(repoA, ["worktree", "add", "-b", "feat/billing", wtBilling]);
    writeFileSync(join(wtBilling, "billing.ts"), "export const bill = 2;\n", "utf8");
    git(repoA, ["worktree", "add", "-b", "feat/other", wtOther]);

    // Repo B (separate window)
    const repoB = join(root, "repo-b");
    mkdirSync(repoB, { recursive: true });
    git(repoB, ["init", "-b", "main"]);
    git(repoB, ["config", "user.email", "test@example.com"]);
    git(repoB, ["config", "user.name", "Multi Tester"]);
    writeFileSync(join(repoB, "index.ts"), "export const b = 3;\n", "utf8");
    git(repoB, ["add", "."]);
    git(repoB, ["commit", "-m", "init B"]);

    const canonRepoA = realpathSync(repoA);
    const canonCommonA = realpathSync(join(canonRepoA, ".git"));
    const canonWtBilling = realpathSync(wtBilling);
    const canonWtOther = realpathSync(wtOther);
    const canonRepoB = realpathSync(repoB);
    const canonCommonB = realpathSync(join(canonRepoB, ".git"));

    const server = new TourServer(
      {
        ensureRepoWindow: async ({ cwd }) => {
          const canonCwd = realpathSync(cwd);
          if (canonCwd.startsWith(canonRepoB)) {
            return {
              repoCommonDir: canonCommonB,
              repoName: "repo-b",
              worktreePath: canonRepoB,
              worktrees: [],
            };
          }
          const wtPath = canonCwd.startsWith(canonWtBilling)
            ? canonWtBilling
            : canonCwd.startsWith(canonWtOther)
              ? canonWtOther
              : canonRepoA;
          return {
            repoCommonDir: canonCommonA,
            repoName: "repo-a",
            worktreePath: wtPath,
            worktrees: [],
          };
        },
        broadcastWalkthrough: () => {},
        broadcastReview: () => {},
      },
      runDir,
    );
    activeServers.push(server);
    await server.listen();

    // 1. Two agents simultaneously wait on DIFFERENT worktrees of Repo A + a third agent waits on Repo B
    const agentAuthPromise = runCliReview({
      cwd: canonRepoA,
      appRoot: APP_ROOT,
      runDir,
      autoLaunch: false,
      argv: ["wait", "--label", "Auth Agent"],
    });
    const agentBillingPromise = runCliReview({
      cwd: canonWtBilling,
      appRoot: APP_ROOT,
      runDir,
      autoLaunch: false,
      argv: ["wait", "--label", "Billing Agent"],
    });
    const agentRepoBPromise = runCliReview({
      cwd: canonRepoB,
      appRoot: APP_ROOT,
      runDir,
      autoLaunch: false,
      argv: ["wait", "--label", "RepoB Agent"],
    });

    await waitFor(() => {
      const aStates = server.getReviewStates(canonCommonA);
      const bStates = server.getReviewStates(canonCommonB);
      return aStates.length === 2 && bStates.length === 1 ? true : null;
    });

    // Sending feedback for an unrelated worktree (`wt-other`) MUST return false — zero cross-talk!
    expect(
      server.respondReviewFromUser(canonCommonA, {
        worktreePath: canonWtOther,
        action: "feedback",
        count: 1,
        markdown: "Should never leak",
      }),
    ).toBe(false);

    // Send feedback specifically to `wt-auth` — only Auth Agent receives it; Billing Agent keeps waiting!
    expect(
      server.respondReviewFromUser(canonCommonA, {
        worktreePath: canonRepoA,
        action: "feedback",
        count: 1,
        markdown: "Fix auth.ts:1",
      }),
    ).toBe(true);

    expect(await agentAuthPromise).toBe("ACTION: feedback\nROUND: 1\nANNOTATIONS: 1\n\nFix auth.ts:1\n");
    expect(server.getReviewState(canonCommonA, canonRepoA)?.agentWorking).toBe(true);
    expect(server.getReviewState(canonCommonA, canonWtBilling)?.awaitingUser).toBe(true);

    // 2. Two agents simultaneously wait on the EXACT SAME worktree (`wt-billing`) -> neither evicts the other!
    const agentBilling2Promise = runCliReview({
      cwd: canonWtBilling,
      appRoot: APP_ROOT,
      runDir,
      autoLaunch: false,
      argv: ["wait", "--label", "Billing Agent 2"],
    });

    const billingPair = await waitFor(() => {
      const list = server
        .getReviewStates(canonCommonA)
        .filter((s) => s.worktreePath === canonWtBilling);
      return list.length === 2 ? list : null;
    });
    const firstBilling = billingPair.find((s) => s.label === "Billing Agent")!;
    const secondBilling = billingPair.find((s) => s.label === "Billing Agent 2")!;
    expect(firstBilling.sessionId).not.toBe(secondBilling.sessionId);

    // Approve secondBilling by sessionId; firstBilling stays connected, then send feedback to firstBilling!
    expect(
      server.respondReviewFromUser(canonCommonA, {
        sessionId: secondBilling.sessionId,
        worktreePath: canonWtBilling,
        action: "approve",
        count: 0,
      }),
    ).toBe(true);
    expect(await agentBilling2Promise).toBe("ACTION: approved\nROUND: 0\n");

    expect(
      server.respondReviewFromUser(canonCommonA, {
        sessionId: firstBilling.sessionId,
        worktreePath: canonWtBilling,
        action: "feedback",
        count: 1,
        markdown: "Fix billing.ts:1",
      }),
    ).toBe(true);
    expect(await agentBillingPromise).toBe("ACTION: feedback\nROUND: 1\nANNOTATIONS: 1\n\nFix billing.ts:1\n");

    // 3. Concurrent walkthroughs on `wt-auth` and `wt-billing` stay isolated
    const tourAuthPromise = runCliTour({
      cwd: canonRepoA,
      appRoot: APP_ROOT,
      runDir,
      autoLaunch: false,
      argv: ["step", "--target", "auth.ts", "--title", "Auth Tour", "--body", "Explaining auth"],
    });
    const tourBillingPromise = runCliTour({
      cwd: canonWtBilling,
      appRoot: APP_ROOT,
      runDir,
      autoLaunch: false,
      argv: ["step", "--target", "billing.ts", "--title", "Billing Tour", "--body", "Explaining billing"],
    });

    const bothTours = await waitFor(() => {
      const tours = server.getWalkthroughStates(canonCommonA);
      return tours.length === 2 ? tours : null;
    });
    const authTour = bothTours.find((t) => t.worktreePath === canonRepoA)!;
    const billingTour = bothTours.find((t) => t.worktreePath === canonWtBilling)!;

    // Advance ONLY authTour -> billingTour remains awaitingUser!
    server.respondFromUser(canonCommonA, {
      sessionId: authTour.sessionId,
      worktreePath: canonRepoA,
      stepId: authTour.activeStepId,
      action: "finish",
    });
    expect(await tourAuthPromise).toBe("ACTION: finish\nSTEP: 1\n");
    expect(server.getState(canonCommonA, canonWtBilling)?.awaitingUser).toBe(true);

    // 4. Closing Repo A's window cancels Repo A's remaining billing tour, while Repo B's review stays alive!
    server.closeRepo(canonCommonA);
    expect(await tourBillingPromise).toBe("ACTION: stop\nSTEP: 1\n");
    expect(server.getReviewState(canonCommonB, canonRepoB)?.awaitingUser).toBe(true);

    // Finally approve Repo B's agent cleanly
    expect(
      server.respondReviewFromUser(canonCommonB, {
        worktreePath: canonRepoB,
        action: "approve",
        count: 0,
      }),
    ).toBe(true);
    expect(await agentRepoBPromise).toBe("ACTION: approved\nROUND: 0\n");
  });
});
