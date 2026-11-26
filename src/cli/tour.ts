import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { TourRpcRequest, TourRpcResponse, TourStepRpcResult } from "../main/services/tour-server.js";
import {
  buildWalkthroughAgentPrompt,
  buildWalkthroughSkillMarkdown,
  getTourEndpointPaths,
  type TourEndpointPaths,
} from "../shared/walkthrough-prompt.js";

export function formatTourHelp(): string {
  return [
    "ide2 tour — drive interactive, step-by-step codebase walkthroughs in ide2",
    "",
    "Usage:",
    "  ide2 tour start [--title <text>] [--total <n>] [--worktree <name>]",
    "  ide2 tour step  [--target <folder|file|file:start-end>] --title <text> [options] [< markdown]",
    "  ide2 tour wait  [--wait-timeout <sec>]",
    "  ide2 tour status",
    "  ide2 tour end",
    "  ide2 tour prompt",
    "  ide2 tour install-skill [--dir <path>] [--claude]",
    "",
    "Step Options:",
    "  -t, --target <loc>        Folder (`src/main`), file (`src/app.ts`), or lines (`src/app.ts:40-72`)",
    "      --title <text>        Short heading for this walkthrough step",
    "  -m, --body <markdown>     Markdown explanation (or pipe multiline Markdown / Mermaid via stdin)",
    "      --step <n>            Explicit 1-based step number",
    "      --total <n>           Total planned steps (e.g. 6)",
    "  -d, --diff                Open target in DiffViewport instead of CodeViewport",
    "  -b, --base <ref>          Base ref when --diff is set (e.g. main)",
    "      --mode <m>            Markdown file view mode: preview | split | raw",
    "  -w, --worktree <name>     Target worktree name, branch, or path",
    "      --final               Mark as the final step (shows 'Finish ✓' button in ide2)",
    "      --wait-timeout <sec>  Max seconds to block before returning ACTION: waiting (default: 90, 0 = infinite)",
    "      --no-wait             Push step and return immediately without waiting for user click",
    "",
    "Blocking Responses (printed to stdout):",
    "  ACTION: next              User clicked 'Next →' — push the next step",
    "  ACTION: steer             User typed a question/detour in ide2 (see `MESSAGE: ...` line)",
    "  ACTION: waiting           User is still reading — run `ide2 tour wait` to continue waiting",
    "  ACTION: finish            User clicked 'Finish ✓' on the final step",
    "  ACTION: stop              User closed the walkthrough — stop pushing steps",
    "",
    "Example (top-down walkthrough):",
    "  ide2 tour start --title \"Auth Flow\" --total 3",
    "  ide2 tour step --step 1 --total 3 --target src/auth --title \"Auth Module\" <<'EOF'",
    "  This folder owns token verification and session state.",
    "  EOF",
    "  ide2 tour step --step 2 --total 3 --target src/auth/session.ts:18-45 --title \"Bearer Verification\" <<'EOF'",
    "  `verifyAuth` rejects malformed headers before slicing the token.",
    "  EOF",
    "  ide2 tour step --step 3 --total 3 --final --title \"Summary\" --body \"End-to-end flow complete.\"",
    "",
  ].join("\n");
}

interface ParsedTourCli {
  subcommand: "help" | "start" | "step" | "wait" | "status" | "end" | "prompt" | "install-skill";
  title?: string;
  target?: string;
  body?: string;
  line?: number;
  endLine?: number;
  stepNumber?: number;
  totalSteps?: number;
  diff?: boolean;
  base?: string;
  markdownMode?: "preview" | "split" | "raw";
  worktree?: string;
  final?: boolean;
  wait: boolean;
  waitTimeoutSec: number;
  skillDir?: string;
  claudeSkill?: boolean;
}

export function parseTourArgs(argv: readonly string[]): ParsedTourCli {
  const first = argv[0];
  if (!first || first === "-h" || first === "--help" || first === "help") {
    return { subcommand: "help", wait: true, waitTimeoutSec: 90 };
  }

  let subcommand: ParsedTourCli["subcommand"] = "help";
  if (first === "start") subcommand = "start";
  else if (first === "step" || first === "focus" || first === "show") subcommand = "step";
  else if (first === "wait") subcommand = "wait";
  else if (first === "status") subcommand = "status";
  else if (first === "end" || first === "stop" || first === "clear" || first === "finish") {
    subcommand = "end";
  } else if (first === "prompt") subcommand = "prompt";
  else if (first === "install-skill") subcommand = "install-skill";
  else {
    throw new Error(`Unknown tour subcommand "${first}". Run \`ide2 tour --help\`.`);
  }

  const parsed: ParsedTourCli = {
    subcommand,
    wait: true,
    waitTimeoutSec: 90,
  };

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      parsed.subcommand = "help";
      return parsed;
    } else if ((arg === "-t" || arg === "--target") && argv[i + 1] !== undefined) {
      parsed.target = argv[++i];
    } else if (arg.startsWith("--target=")) {
      parsed.target = arg.slice("--target=".length);
    } else if (arg === "--title" && argv[i + 1] !== undefined) {
      parsed.title = argv[++i];
    } else if (arg.startsWith("--title=")) {
      parsed.title = arg.slice("--title=".length);
    } else if ((arg === "-m" || arg === "--body" || arg === "--message") && argv[i + 1] !== undefined) {
      parsed.body = argv[++i];
    } else if (arg.startsWith("--body=")) {
      parsed.body = arg.slice("--body=".length);
    } else if (arg === "--line" && argv[i + 1] !== undefined) {
      parsed.line = Number.parseInt(argv[++i]!, 10);
    } else if (arg === "--end-line" && argv[i + 1] !== undefined) {
      parsed.endLine = Number.parseInt(argv[++i]!, 10);
    } else if (arg === "--step" && argv[i + 1] !== undefined) {
      parsed.stepNumber = Number.parseInt(argv[++i]!, 10);
    } else if (arg.startsWith("--step=")) {
      parsed.stepNumber = Number.parseInt(arg.slice("--step=".length), 10);
    } else if (arg === "--total" && argv[i + 1] !== undefined) {
      parsed.totalSteps = Number.parseInt(argv[++i]!, 10);
    } else if (arg.startsWith("--total=")) {
      parsed.totalSteps = Number.parseInt(arg.slice("--total=".length), 10);
    } else if (arg === "-d" || arg === "--diff") {
      parsed.diff = true;
    } else if ((arg === "-b" || arg === "--base") && argv[i + 1] !== undefined) {
      parsed.base = argv[++i];
    } else if (arg.startsWith("--base=")) {
      parsed.base = arg.slice("--base=".length);
    } else if (arg === "--mode" && argv[i + 1] !== undefined) {
      const m = argv[++i];
      if (m === "preview" || m === "split" || m === "raw") {
        parsed.markdownMode = m;
      }
    } else if ((arg === "-w" || arg === "--worktree") && argv[i + 1] !== undefined) {
      parsed.worktree = argv[++i];
    } else if (arg.startsWith("--worktree=")) {
      parsed.worktree = arg.slice("--worktree=".length);
    } else if (arg === "--final") {
      parsed.final = true;
    } else if (arg === "--no-wait") {
      parsed.wait = false;
    } else if (arg === "--wait") {
      parsed.wait = true;
    } else if (arg === "--wait-timeout" && argv[i + 1] !== undefined) {
      parsed.waitTimeoutSec = Number.parseFloat(argv[++i]!);
    } else if (arg.startsWith("--wait-timeout=")) {
      parsed.waitTimeoutSec = Number.parseFloat(arg.slice("--wait-timeout=".length));
    } else if (arg === "--dir" && argv[i + 1] !== undefined) {
      parsed.skillDir = argv[++i];
    } else if (arg.startsWith("--dir=")) {
      parsed.skillDir = arg.slice("--dir=".length);
    } else if (arg === "--claude") {
      parsed.claudeSkill = true;
    } else if (!arg.startsWith("-") && parsed.target === undefined && subcommand === "step") {
      parsed.target = arg;
    }
  }

  return parsed;
}

async function readStdinIfPiped(hasTitle: boolean): Promise<string> {
  if (process.stdin.isTTY) return "";
  return new Promise<string>((resolveStdin) => {
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveStdin(Buffer.concat(chunks).toString("utf8"));
    };

    // Many agent harnesses spawn commands with an open, idle stdin pipe (`isTTY === false`).
    // If `--title` was already supplied and zero bytes arrive on stdin within 80ms, treat stdin as empty
    // instead of hanging forever waiting for EOF.
    const idleTimer = hasTitle
      ? setTimeout(() => {
          if (chunks.length === 0) finish();
        }, 80)
      : null;

    const onData = (chunk: Buffer | string) => {
      if (idleTimer) clearTimeout(idleTimer);
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    };
    const onEnd = () => finish();
    const onError = () => finish();

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("error", onError);
      process.stdin.pause?.();
    };

    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onError);
    process.stdin.resume?.();
  });
}

function sendSocketRpcRequest<T>(
  socketPath: string,
  payload: TourRpcRequest,
): Promise<T> {
  return new Promise<T>((resolveRpc, rejectRpc) => {
    const client = createConnection({ path: socketPath });
    client.setEncoding("utf8");

    let buffer = "";
    let settled = false;

    client.once("connect", () => {
      client.write(`${JSON.stringify(payload)}\n`);
    });

    client.on("data", (chunk: string) => {
      buffer += chunk;
      const idx = buffer.indexOf("\n");
      if (idx !== -1 && !settled) {
        settled = true;
        const line = buffer.slice(0, idx).trim();
        client.end();
        try {
          const parsed = JSON.parse(line) as TourRpcResponse;
          if (!parsed.ok) {
            const appErr = new Error(parsed.error ?? "RPC request failed");
            (appErr as { isRpcError?: boolean }).isRpcError = true;
            rejectRpc(appErr);
          } else {
            resolveRpc(parsed.result as T);
          }
        } catch (err) {
          rejectRpc(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });

    client.once("error", (err) => {
      if (!settled) {
        settled = true;
        rejectRpc(err);
      }
    });

    client.once("close", () => {
      if (!settled) {
        settled = true;
        rejectRpc(new Error("Connection to ide2 closed before receiving a response."));
      }
    });
  });
}

function isPidAlive(pidPath: string): boolean {
  try {
    if (!existsSync(pidPath)) return false;
    const pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists and belongs to user/system
    if (err && typeof err === "object" && (err as { code?: string }).code === "EPERM") {
      return true;
    }
    return false;
  }
}

function sendFileMailboxRpcRequest<T>(
  paths: TourEndpointPaths,
  payload: TourRpcRequest,
): Promise<T> {
  return new Promise<T>((resolveRpc, rejectRpc) => {
    if (!existsSync(paths.ipcDir)) {
      rejectRpc(new Error("ide2 IPC directory is not available."));
      return;
    }

    const tmpReq = join(paths.ipcDir, `${payload.id}.req.tmp`);
    const finalReq = join(paths.ipcDir, `${payload.id}.req.json`);
    const resFile = join(paths.ipcDir, `${payload.id}.res.json`);

    let settled = false;
    let watcher: ReturnType<typeof watch> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      if (watcher) {
        try {
          watcher.close();
        } catch {
          // ignore
        }
        watcher = null;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      try {
        rmSync(finalReq, { force: true });
      } catch {
        // ignore
      }
    };

    const tryConsumeResponse = () => {
      if (settled || !existsSync(resFile)) return;
      let raw: string;
      try {
        raw = readFileSync(resFile, "utf8");
        rmSync(resFile, { force: true });
      } catch {
        return;
      }
      settled = true;
      cleanup();
      try {
        const parsed = JSON.parse(raw) as TourRpcResponse;
        if (!parsed.ok) {
          rejectRpc(new Error(parsed.error ?? "RPC request failed"));
        } else {
          resolveRpc(parsed.result as T);
        }
      } catch (err) {
        rejectRpc(err instanceof Error ? err : new Error(String(err)));
      }
    };

    try {
      watcher = watch(paths.ipcDir, () => {
        tryConsumeResponse();
      });
      watcher.on("error", () => {});
    } catch {
      // pollTimer handles environments without fs.watch
    }

    pollTimer = setInterval(() => {
      tryConsumeResponse();
      if (!settled && !isPidAlive(paths.pidPath)) {
        settled = true;
        cleanup();
        rejectRpc(new Error("ide2 process exited while waiting for walkthrough step."));
      }
    }, 35);

    try {
      writeFileSync(tmpReq, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(tmpReq, finalReq);
    } catch (err) {
      settled = true;
      cleanup();
      rejectRpc(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export async function sendTourRpc<T>(
  paths: TourEndpointPaths,
  token: string,
  method: TourRpcRequest["method"],
  params?: Record<string, unknown>,
): Promise<T> {
  const payload: TourRpcRequest = {
    id: randomBytes(8).toString("hex"),
    token,
    method,
    params,
  };

  try {
    return await sendSocketRpcRequest<T>(paths.socketPath, payload);
  } catch (err) {
    // Do not retry application-level RPC rejections (e.g. invalid target or bad token)
    if (err && typeof err === "object" && (err as { isRpcError?: boolean }).isRpcError) {
      throw err;
    }
    // Fallback seamlessly to filesystem mailbox IPC when running inside a no-network agent sandbox!
    if (isPidAlive(paths.pidPath) && existsSync(paths.ipcDir)) {
      return sendFileMailboxRpcRequest<T>(paths, payload);
    }
    throw err;
  }
}

async function canPingDaemon(runDir?: string): Promise<{ paths: TourEndpointPaths; token: string } | null> {
  const paths = getTourEndpointPaths(runDir);
  if (!existsSync(paths.tokenPath)) return null;
  const token = readFileSync(paths.tokenPath, "utf8").trim();
  if (!token) return null;
  try {
    await sendTourRpc(paths, token, "ping");
    return { paths, token };
  } catch {
    return null;
  }
}

async function ensureDaemonRunning(options: {
  cwd: string;
  appRoot: string;
  runDir?: string;
  autoLaunch?: boolean;
}): Promise<{ paths: TourEndpointPaths; token: string }> {
  const existing = await canPingDaemon(options.runDir);
  if (existing) return existing;

  if (options.autoLaunch === false) {
    throw new Error("ide2 is not currently running.");
  }

  const req = createRequire(resolve(options.appRoot, "package.json"));
  const macWrapper = resolve(options.appRoot, "dist/ide2.app/Contents/MacOS/Electron");
  const electronBinary =
    process.platform === "darwin" && existsSync(macWrapper)
      ? macWrapper
      : (req("electron") as string);

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (options.runDir) {
    env.IDE2_RUN_DIR = options.runDir;
  }

  const child = spawn(
    electronBinary,
    [options.appRoot, `--ide2-cwd=${options.cwd}`, `--ide2-target=${options.cwd}`],
    {
      detached: true,
      stdio: "ignore",
      env,
      windowsHide: false,
    },
  );
  child.unref();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 80));
    const ready = await canPingDaemon(options.runDir);
    if (ready) return ready;
  }

  throw new Error("Timed out waiting for ide2 desktop window to start.");
}

function formatStepResultOutput(res: TourStepRpcResult): string {
  if (res.status === "no_wait") {
    return `ACTION: pushed\nSTEP: ${res.stepNumber ?? 1}\n`;
  }
  if (res.status === "idle") {
    return "ACTION: idle\n";
  }
  if (res.status === "waiting") {
    return [
      "ACTION: waiting",
      `STEP: ${res.stepNumber ?? 1}`,
      "HINT: User is still reading this step in ide2. Run `ide2 tour wait` to continue waiting.",
      "",
    ].join("\n");
  }

  const lines = [`ACTION: ${res.action ?? "next"}`];
  if (res.stepNumber !== undefined) {
    lines.push(`STEP: ${res.stepNumber}`);
  }
  if (res.message && res.message.trim()) {
    lines.push(`MESSAGE: ${res.message.trim()}`);
  }
  return `${lines.join("\n")}\n`;
}

export interface RunCliTourOptions {
  cwd: string;
  appRoot: string;
  argv: readonly string[];
  stdinText?: string;
  runDir?: string;
  autoLaunch?: boolean;
}

export async function runCliTour(options: RunCliTourOptions): Promise<string> {
  const parsed = parseTourArgs(options.argv);

  if (parsed.subcommand === "help") {
    return formatTourHelp();
  }

  if (parsed.subcommand === "prompt") {
    return `${buildWalkthroughAgentPrompt()}\n`;
  }

  if (parsed.subcommand === "install-skill") {
    const baseDir = parsed.skillDir
      ? resolve(options.cwd, parsed.skillDir)
      : parsed.claudeSkill
        ? join(homedir(), ".claude", "skills", "ide2-tour")
        : join(homedir(), ".agents", "skills", "ide2-tour");
    mkdirSync(baseDir, { recursive: true });
    const skillPath = join(baseDir, "SKILL.md");
    writeFileSync(skillPath, buildWalkthroughSkillMarkdown(), "utf8");
    return `Installed ide2-tour skill to ${skillPath}\n`;
  }

  const conn = await ensureDaemonRunning({
    cwd: options.cwd,
    appRoot: options.appRoot,
    runDir: options.runDir,
    autoLaunch: options.autoLaunch,
  });

  if (parsed.subcommand === "start") {
    const res = await sendTourRpc<{ sessionId: string }>(
      conn.paths,
      conn.token,
      "tour.start",
      {
        cwd: options.cwd,
        worktree: parsed.worktree,
        title: parsed.title,
        totalSteps: parsed.totalSteps,
      },
    );
    return `ACTION: started\nSESSION: ${res.sessionId}\n`;
  }

  if (parsed.subcommand === "step") {
    const rawBody =
      parsed.body !== undefined
        ? parsed.body
        : options.stdinText !== undefined
          ? options.stdinText
          : await readStdinIfPiped(Boolean(parsed.title?.trim()));
    const body = rawBody.trim();
    const waitTimeoutMs =
      Number.isFinite(parsed.waitTimeoutSec) && parsed.waitTimeoutSec >= 0
        ? Math.round(parsed.waitTimeoutSec * 1000)
        : 90_000;

    const res = await sendTourRpc<TourStepRpcResult>(
      conn.paths,
      conn.token,
      "tour.step",
      {
        cwd: options.cwd,
        worktree: parsed.worktree,
        target: parsed.target,
        line: parsed.line,
        endLine: parsed.endLine,
        title: parsed.title ?? "",
        body,
        stepNumber: parsed.stepNumber,
        totalSteps: parsed.totalSteps,
        diff: parsed.diff,
        base: parsed.base,
        markdownMode: parsed.markdownMode,
        final: parsed.final,
        wait: parsed.wait,
        waitTimeoutMs,
      },
    );
    return formatStepResultOutput(res);
  }

  if (parsed.subcommand === "wait") {
    const waitTimeoutMs =
      Number.isFinite(parsed.waitTimeoutSec) && parsed.waitTimeoutSec >= 0
        ? Math.round(parsed.waitTimeoutSec * 1000)
        : 90_000;
    const res = await sendTourRpc<TourStepRpcResult>(
      conn.paths,
      conn.token,
      "tour.wait",
      {
        cwd: options.cwd,
        waitTimeoutMs,
      },
    );
    return formatStepResultOutput(res);
  }

  if (parsed.subcommand === "status") {
    const res = await sendTourRpc<Record<string, unknown>>(
      conn.paths,
      conn.token,
      "tour.status",
      { cwd: options.cwd },
    );
    return `${JSON.stringify(res, null, 2)}\n`;
  }

  await sendTourRpc(conn.paths, conn.token, "tour.end", { cwd: options.cwd });
  return "ACTION: ended\n";
}
