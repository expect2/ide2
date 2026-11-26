import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runCliTour, sendTourRpc } from "../src/cli/tour.js";
import { TourServer } from "../src/main/services/tour-server.js";
import type { WalkthroughState } from "../src/shared/protocol.js";

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
    expect(skillContent).toContain("name: ide2-tour");
    expect(skillContent).toContain("ide2 tour step");

    // Verify subprocess routing via `node bin/ide2.mjs walkthrough --help`
    const sub = spawnSync(process.execPath, [IDE2_BIN, "walkthrough", "--help"], {
      cwd: APP_ROOT,
      encoding: "utf8",
    });
    expect(sub.status).toBe(0);
    expect(sub.stdout).toBe(helpOut);
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

    const broadcasts: Array<WalkthroughState | null> = [];
    const server = new TourServer(
      {
        ensureRepoWindow: async () => ({
          repoCommonDir: canonCommonDir,
          repoName: "repo",
          worktreePath: canonRepo,
          worktrees: [],
        }),
        broadcastWalkthrough: (_commonDir, state) => {
          broadcasts.push(state ? structuredClone(state) : null);
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
});
