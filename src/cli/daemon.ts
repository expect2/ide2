import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { IntelClient } from "../main/intel/client.js";
import { LocalWorkspaceBackend } from "../main/backend/local-backend.js";
import { PluginHost } from "../main/plugins/plugin-host.js";
import { TourServer } from "../main/services/tour-server.js";
import { resolveRepoContext } from "../main/services/git.js";
import { StdioRpcPeer } from "../shared/rpc-stdio.js";
import type {
  CreateAnnotationInput,
  DiffScope,
  ExportPromptOptions,
  FindInPathQuery,
  InstallPluginParams,
  ReviewUserResponse,
  UpdateAnnotationInput,
  WalkthroughUserResponse,
} from "../shared/protocol.js";

export interface RunDaemonOptions {
  appRoot: string;
  cwd: string;
  argv: readonly string[];
}

function expandHome(inputPath: string): string {
  if (inputPath === "~") return homedir();
  if (inputPath.startsWith("~/")) return resolve(homedir(), inputPath.slice(2));
  return resolve(inputPath);
}

function parseDaemonArgs(argv: readonly string[], fallbackCwd: string): {
  target: string;
  worktree?: string;
  diff: boolean;
  base?: string;
} {
  let target = fallbackCwd;
  let worktree: string | undefined;
  let diff = false;
  let base: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--stdio") {
      continue;
    } else if ((arg === "--cwd" || arg === "--target") && argv[i + 1]) {
      target = argv[++i]!;
    } else if (arg.startsWith("--cwd=")) {
      target = arg.slice("--cwd=".length);
    } else if (arg.startsWith("--target=")) {
      target = arg.slice("--target=".length);
    } else if ((arg === "-w" || arg === "--worktree") && argv[i + 1]) {
      worktree = argv[++i]!;
    } else if (arg.startsWith("--worktree=")) {
      worktree = arg.slice("--worktree=".length);
    } else if (arg === "-d" || arg === "--diff") {
      diff = true;
    } else if ((arg === "-b" || arg === "--base") && argv[i + 1]) {
      base = argv[++i]!;
    } else if (arg.startsWith("--base=")) {
      base = arg.slice("--base=".length);
    } else if (!arg.startsWith("-")) {
      target = arg;
    }
  }

  return {
    target: expandHome(target),
    worktree,
    diff,
    base,
  };
}

/**
 * Headless SSH Daemon (`ide2 daemon --stdio --cwd <repoPath>`).
 *
 * - Keeps `process.stdout` 100% clean for NDJSON RPC framing (redirects `console.log` -> `stderr`).
 * - Runs `TourServer` locally on the remote SSH machine (`~/.expect2-ide/run/ide2.sock` + `ipc/`)
 *   so coding agents in remote `tmux` / SSH shells can run `ide2 review wait`, `ide2 tour`, and
 *   `ide2 x <plugin>` locally with zero SSH port forwarding!
 * - Runs `PluginHost` (`scope: "remote"`, `hostFilter: "workspace"`) for workspace-affinity plugins.
 */
export async function runCliDaemon(opts: RunDaemonOptions): Promise<void> {
  // Reserve raw stdout exclusively for StdioRpcPeer; route any library console logs to stderr
  const rawStdout = process.stdout;
  const stderrLog = (...args: unknown[]) => {
    process.stderr.write(`${args.map((a) => String(a)).join(" ")}\n`);
  };
  console.log = stderrLog;
  console.info = stderrLog;
  console.warn = stderrLog;

  const parsed = parseDaemonArgs(opts.argv, opts.cwd);
  const distRoot = resolve(opts.appRoot, "dist");
  const pkgVersion = (() => {
    try {
      const pkg = JSON.parse(readFileSync(resolve(opts.appRoot, "package.json"), "utf8")) as {
        version?: string;
      };
      return pkg.version ?? "0.1.0";
    } catch {
      return "0.1.0";
    }
  })();

  const intel = new IntelClient({
    workerPath: resolve(distRoot, "main/worker.cjs"),
  });

  let activeBackend: LocalWorkspaceBackend | null = null;

  const tourServer = new TourServer({
    ensureRepoWindow: async ({ cwd, worktree }) => {
      if (!activeBackend) {
        throw new Error("Remote daemon workspace not ready yet.");
      }
      const reqCtx = await resolveRepoContext(cwd);
      if (reqCtx.repoCommonDir !== activeBackend.getLaunchContext().repoCommonDir) {
        throw new Error(
          `This remote ide2 daemon is bound to ${activeBackend.getLaunchContext().repoName}, not ${reqCtx.repoName}.`,
        );
      }
      const worktreePath = await activeBackend.selectWorktreePath(worktree, cwd);
      const worktrees = await activeBackend.discoverWorktrees();
      return {
        repoCommonDir: activeBackend.getLaunchContext().repoCommonDir,
        repoName: activeBackend.getLaunchContext().repoName,
        worktreePath,
        worktrees,
      };
    },
    broadcastWalkthrough: (_repoCommonDir, walkthroughs) => {
      activeBackend?.emitEvent({
        type: "walkthrough-updated",
        walkthroughs,
      });
    },
    broadcastReview: (_repoCommonDir, reviews) => {
      activeBackend?.emitEvent({
        type: "review-updated",
        reviews,
      });
    },
    handlePluginCli: async (params) => {
      if (!activeBackend) {
        throw new Error("Workspace backend not initialized.");
      }
      const controller = activeBackend.getPluginController();
      if (!controller) {
        throw new Error("No workspace plugins active.");
      }
      const worktreePath = await activeBackend.selectWorktreePath(params.worktree, params.cwd);
      return controller.handleAgentCli({
        worktreePath,
        subcommand: params.subcommand,
        argv: params.argv,
        stdin: params.stdin,
        wait: params.wait,
        waitTimeoutMs: params.waitTimeoutMs,
      });
    },
  });

  try {
    await tourServer.listen();
  } catch (err) {
    // Another daemon/window on the same remote user account may already own ide2.sock; non-fatal
    stderrLog(
      `[ide2-daemon] note: tour socket already in use or unavailable (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  const backend = await LocalWorkspaceBackend.create({
    targetPath: parsed.target,
    cwd: opts.cwd,
    worktree: parsed.worktree,
    diff: parsed.diff,
    base: parsed.base,
    intel,
    tourServer,
    createPluginController: async (b) => {
      const host = new PluginHost({
        backend: b,
        scope: "remote",
        hostAffinityFilter: "workspace",
        runnerWorkerPath: resolve(distRoot, "main/plugin-runner.cjs"),
        onStateChanged: (snapshot) => {
          b.emitEvent({
            type: "plugins-updated",
            plugins: snapshot.plugins,
            decorations: snapshot.decorations,
            cards: snapshot.cards,
          });
        },
        onPluginEvent: (pluginId, event, payload) => {
          b.emitEvent({
            type: "plugin-event",
            pluginId,
            event,
            payload,
          });
        },
      });
      await host.start();
      return host;
    },
  });
  activeBackend = backend;

  const peer = new StdioRpcPeer(process.stdin, rawStdout, {
    role: "server",
    onRequest: async (method, rawParams) => {
      const p = (rawParams ?? {}) as Record<string, unknown>;
      switch (method) {
        case "getBootstrapSnapshot":
          return backend.getBootstrapSnapshot(
            p as {
              initialWorktreePath?: string;
              initialFilePath?: string;
              initialLine?: number;
              initialColumn?: number;
              initialDiffMode?: boolean;
              initialBaseRef?: string;
            },
          );
        case "listFiles":
          return backend.listFiles(String(p.worktreePath));
        case "fuzzyFindFiles":
          return backend.fuzzyFindFiles(
            p as { worktreePath: string; query: string; allWorktrees?: boolean; limit?: number },
          );
        case "readFile":
          return backend.readFile(
            String(p.worktreePath),
            String(p.filePath),
            p.diffScope as DiffScope | undefined,
          );
        case "readAssetDataUrl":
          return backend.readAssetDataUrl(
            String(p.worktreePath),
            String(p.relativeFromFile),
            String(p.rawHref),
          );
        case "getDiff":
          return backend.getDiff(
            String(p.worktreePath),
            String(p.filePath),
            p.scope as DiffScope,
          );
        case "listChangedFiles":
          return backend.listChangedFiles(String(p.worktreePath), p.scope as DiffScope);
        case "listCommits":
          return backend.listCommits(
            String(p.worktreePath),
            typeof p.limit === "number" ? p.limit : undefined,
          );
        case "getBlame":
          return backend.getBlame(String(p.worktreePath), String(p.filePath));
        case "getStructure":
          return backend.getStructure(String(p.worktreePath), String(p.filePath));
        case "searchSymbols":
          return backend.searchSymbols(
            p as { worktreePath: string; query: string; allWorktrees?: boolean; limit?: number },
          );
        case "findDefinitionAndUsages":
          return backend.findDefinitionAndUsages(
            p as { worktreePath: string; filePath: string; symbolName: string; line: number },
          );
        case "findInPath":
          return backend.findInPath(p as unknown as FindInPathQuery);
        case "listAnnotations":
          return backend.listAnnotations(
            typeof p.worktreePath === "string" ? p.worktreePath : undefined,
          );
        case "createAnnotation":
          return backend.createAnnotation(p as unknown as CreateAnnotationInput);
        case "updateAnnotation":
          return backend.updateAnnotation(p as unknown as UpdateAnnotationInput);
        case "deleteAnnotation":
          return backend.deleteAnnotation(String(p.id));
        case "compileFeedbackPrompt":
          return backend.compileFeedbackPrompt(p as unknown as ExportPromptOptions);
        case "createWorktree":
          return backend.createWorktree(
            p as {
              baseWorktreePath: string;
              branchName: string;
              baseRef?: string;
              targetDir?: string;
            },
          );
        case "respondWalkthrough":
          return backend.respondWalkthrough(p as unknown as WalkthroughUserResponse);
        case "endWalkthrough":
          return backend.endWalkthrough(typeof p.sessionId === "string" ? p.sessionId : undefined);
        case "sendReviewResponse":
          return backend.sendReviewResponse(p as unknown as ReviewUserResponse);
        case "listPlugins":
          return backend.listPlugins();
        case "installPlugin":
          return backend.installPlugin(p as unknown as InstallPluginParams);
        case "setPluginEnabled":
          return backend.setPluginEnabled(p as { pluginId: string; enabled: boolean });
        case "updatePlugin":
          return backend.updatePlugin(p as { pluginId: string; approvePermissions?: boolean });
        case "removePlugin":
          return backend.removePlugin(p as { pluginId: string });
        case "callPluginRpc":
          return backend.callPluginRpc(
            p as { pluginId: string; method: string; payload?: unknown; worktreePath?: string },
          );
        case "triggerPluginAction":
          return backend.triggerPluginAction(
            p as {
              pluginId: string;
              actionId: string;
              worktreePath?: string;
              filePath?: string;
              line?: number;
            },
          );
        case "respondPluginCard":
          return backend.respondPluginCard(
            p as { sessionId: string; action: string; message?: string },
          );
        case "readPluginClientBundle":
          return backend.readPluginClientBundle(String(p.pluginId));
        default:
          throw new Error(`Unknown daemon RPC method "${method}"`);
      }
    },
  });

  const unsubscribe = backend.onEvent((evt) => {
    peer.emitEvent(evt);
  });

  const ctx = backend.getLaunchContext();
  peer.sendHandshake({
    version: pkgVersion,
    protocolVersion: 1,
    pid: process.pid,
    platform: process.platform,
    repoName: ctx.repoName,
    repoCommonDir: ctx.repoCommonDir,
  });

  await new Promise<void>((resolveDone) => {
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      unsubscribe();
      await Promise.allSettled([backend.dispose(), tourServer.close(), intel.dispose()]);
      resolveDone();
    };
    peer.onClose(() => {
      void shutdown();
    });
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
  });
}
