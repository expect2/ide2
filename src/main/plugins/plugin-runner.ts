import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { parentPort } from "node:worker_threads";
import type {
  PluginCliInvokeContext,
  PluginExecOptions,
  PluginExecResult,
  PluginLineDecorationInput,
  PluginServerContext,
  PluginServerContributeFn,
} from "../../plugin-sdk/server.js";
import type {
  Annotation,
  ChangedFileSummary,
  DiffScope,
  FileDiffResult,
  FileDocument,
  FileEntry,
  LaunchContext,
  PluginAgentCardChoice,
  PluginLineDecoration,
  PluginPermission,
  WorkspaceEvent,
  WorktreeInfo,
} from "../../shared/protocol.js";

const dynamicRequire = createRequire(import.meta.url);

export interface RunnerHostBridge {
  callWorkspace<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  presentCardAndWait(params: {
    pluginId: string;
    pluginName: string;
    subcommand: string;
    worktreePath: string;
    title: string;
    markdown: string;
    choices?: PluginAgentCardChoice[];
    allowFreeformReply?: boolean;
    timeoutMs?: number;
  }): Promise<{ status: "responded" | "waiting"; action?: string; message?: string }>;
  onDecorationsUpdated(pluginId: string, decorations: PluginLineDecoration[]): void;
  onClientEvent(pluginId: string, event: string, payload: unknown): void;
}

interface LoadedPluginEntry {
  pluginId: string;
  pluginName: string;
  grantedPermissions: Set<PluginPermission>;
  decorationsBySource: Map<string, PluginLineDecoration[]>;
  rpcHandlers: Map<
    string,
    (payload: unknown, meta: { worktreePath?: string }) => Promise<unknown> | unknown
  >;
  actionHandlers: Map<
    string,
    (ctx: { worktreePath?: string; filePath?: string; line?: number }) => Promise<void> | void
  >;
  cliHandlers: Map<string, (ctx: PluginCliInvokeContext) => Promise<unknown> | unknown>;
  promptEnrichers: Array<
    (ctx: {
      worktree: WorktreeInfo;
      annotations: Annotation[];
      markdown: string;
    }) => Promise<string | void> | string | void
  >;
  worktreeListeners: Set<
    (evt: {
      worktrees: WorktreeInfo[];
      changedWorktreePath?: string;
      changedFiles?: string[];
    }) => void
  >;
  annotationListeners: Set<(evt: { worktreePath: string; annotations: Annotation[] }) => void>;
  cleanup?: (() => void | Promise<void>) | void;
}

function execExternalReadOnly(
  command: string,
  args: readonly string[],
  options?: PluginExecOptions,
): Promise<PluginExecResult> {
  return new Promise<PluginExecResult>((resolveExec, rejectExec) => {
    const timeoutMs = options?.timeoutMs ?? 20000;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...options?.env,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
    };

    const child = spawn(command, [...args], {
      cwd: options?.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            try {
              child.kill();
            } catch {
              // ignore
            }
            rejectExec(new Error(`Plugin command "${command}" timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : null;

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      rejectExec(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveExec({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: code ?? 1,
      });
    });
  });
}

export class PluginRunnerCore {
  private readonly loaded = new Map<string, LoadedPluginEntry>();

  constructor(private readonly bridge: RunnerHostBridge) {}

  async loadPlugin(params: {
    pluginId: string;
    pluginName: string;
    serverBundlePath: string;
    dataDir: string;
    grantedPermissions: PluginPermission[];
  }): Promise<void> {
    await this.unloadPlugin(params.pluginId);
    mkdirSync(params.dataDir, { recursive: true });

    const entry: LoadedPluginEntry = {
      pluginId: params.pluginId,
      pluginName: params.pluginName,
      grantedPermissions: new Set(params.grantedPermissions),
      decorationsBySource: new Map(),
      rpcHandlers: new Map(),
      actionHandlers: new Map(),
      cliHandlers: new Map(),
      promptEnrichers: [],
      worktreeListeners: new Set(),
      annotationListeners: new Set(),
    };

    const flushDecorations = () => {
      const merged: PluginLineDecoration[] = [];
      for (const list of entry.decorationsBySource.values()) {
        merged.push(...list);
      }
      this.bridge.onDecorationsUpdated(entry.pluginId, merged);
    };

    const sanitizeKey = (key: string) => key.replace(/[^a-zA-Z0-9._-]/g, "_");

    const ctx: PluginServerContext = {
      pluginId: entry.pluginId,
      pluginName: entry.pluginName,
      dataDir: params.dataDir,

      getLaunchContext: () => this.bridge.callWorkspace<LaunchContext>("getLaunchContext"),
      listWorktrees: () => this.bridge.callWorkspace<WorktreeInfo[]>("discoverWorktrees"),
      listFiles: (worktreePath) =>
        this.bridge.callWorkspace<FileEntry[]>("listFiles", { worktreePath }),
      readFile: (worktreePath, filePath, diffScope) =>
        this.bridge.callWorkspace<FileDocument>("readFile", { worktreePath, filePath, diffScope }),
      getDiff: (worktreePath, filePath, scope) =>
        this.bridge.callWorkspace<FileDiffResult>("getDiff", { worktreePath, filePath, scope }),
      listChangedFiles: (worktreePath, scope) =>
        this.bridge.callWorkspace<ChangedFileSummary[]>("listChangedFiles", {
          worktreePath,
          scope,
        }),

      setDecorations: (sourceKey: string, decorations: readonly PluginLineDecorationInput[]) => {
        const normalized: PluginLineDecoration[] = decorations.map((d, idx) => ({
          ...d,
          id:
            d.id ??
            `${entry.pluginId}:${sourceKey}:${d.filePath}:${d.side ?? "new"}:${d.startLine}:${idx}`,
          pluginId: entry.pluginId,
          pluginName: entry.pluginName,
        }));
        entry.decorationsBySource.set(sourceKey, normalized);
        flushDecorations();
      },

      clearDecorations: (sourceKey?: string) => {
        if (sourceKey) {
          entry.decorationsBySource.delete(sourceKey);
        } else {
          entry.decorationsBySource.clear();
        }
        flushDecorations();
      },

      emitClientEvent: (event: string, payload?: unknown) => {
        this.bridge.onClientEvent(entry.pluginId, event, payload);
      },

      handleRpc: (method, handler) => {
        entry.rpcHandlers.set(method, handler);
      },

      handleAction: (actionId, handler) => {
        entry.actionHandlers.set(actionId, handler);
      },

      registerPromptEnricher: (handler) => {
        entry.promptEnrichers.push(handler);
      },

      handleCli: (subcommand, handler) => {
        if (!entry.grantedPermissions.has("agent-ipc")) {
          throw new Error(
            `Plugin "${entry.pluginId}" must declare "agent-ipc" in permissions to register CLI subcommands.`,
          );
        }
        entry.cliHandlers.set(subcommand, handler);
      },

      onWorktreesUpdated: (listener) => {
        entry.worktreeListeners.add(listener);
        return () => entry.worktreeListeners.delete(listener);
      },

      onAnnotationsUpdated: (listener) => {
        entry.annotationListeners.add(listener);
        return () => entry.annotationListeners.delete(listener);
      },

      readStorageJson: async <T = unknown>(key: string): Promise<T | null> => {
        try {
          const p = join(params.dataDir, `${sanitizeKey(key)}.json`);
          if (!existsSync(p)) return null;
          return JSON.parse(readFileSync(p, "utf8")) as T;
        } catch {
          return null;
        }
      },

      writeStorageJson: async (key: string, value: unknown): Promise<void> => {
        mkdirSync(params.dataDir, { recursive: true });
        const dst = join(params.dataDir, `${sanitizeKey(key)}.json`);
        const tmp = `${dst}.${process.pid}.${Date.now()}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
        renameSync(tmp, dst);
      },

      exec: async (command, args, options) => {
        if (!entry.grantedPermissions.has("exec")) {
          throw new Error(
            `Plugin "${entry.pluginId}" attempted to run "${command}" without "exec" permission.`,
          );
        }
        return execExternalReadOnly(command, args, options);
      },
    };

    // Evict require cache so hot-reloads & updates pick up fresh code immediately
    const resolvedPath = dynamicRequire.resolve(params.serverBundlePath);
    delete dynamicRequire.cache[resolvedPath];

    const rawMod = dynamicRequire(resolvedPath) as
      | PluginServerContributeFn
      | { default?: PluginServerContributeFn };
    const contributeFn = typeof rawMod === "function" ? rawMod : rawMod?.default;
    if (typeof contributeFn !== "function") {
      throw new Error(`Plugin "${params.pluginId}" server entry did not default-export a function.`);
    }

    this.loaded.set(params.pluginId, entry);
    try {
      entry.cleanup = await contributeFn(ctx);
    } catch (err) {
      this.loaded.delete(params.pluginId);
      throw err;
    }
  }

  async unloadPlugin(pluginId: string): Promise<void> {
    const existing = this.loaded.get(pluginId);
    if (!existing) return;
    this.loaded.delete(pluginId);
    try {
      await existing.cleanup?.();
    } catch {
      // ignore cleanup errors
    }
    this.bridge.onDecorationsUpdated(pluginId, []);
  }

  async callRpc(params: {
    pluginId: string;
    method: string;
    payload?: unknown;
    worktreePath?: string;
  }): Promise<unknown> {
    const entry = this.loaded.get(params.pluginId);
    if (!entry) {
      throw new Error(`Plugin "${params.pluginId}" is not active.`);
    }
    const handler = entry.rpcHandlers.get(params.method);
    if (!handler) {
      throw new Error(`Plugin "${params.pluginId}" has no RPC handler "${params.method}".`);
    }
    return handler(params.payload, { worktreePath: params.worktreePath });
  }

  async triggerAction(params: {
    pluginId: string;
    actionId: string;
    worktreePath?: string;
    filePath?: string;
    line?: number;
  }): Promise<void> {
    const entry = this.loaded.get(params.pluginId);
    if (!entry) return;
    const handler = entry.actionHandlers.get(params.actionId);
    if (!handler) return;
    await handler({
      worktreePath: params.worktreePath,
      filePath: params.filePath,
      line: params.line,
    });
  }

  async enrichPrompt(params: {
    worktree: WorktreeInfo;
    annotations: Annotation[];
    markdown: string;
  }): Promise<string> {
    let current = params.markdown;
    for (const entry of this.loaded.values()) {
      for (const enricher of entry.promptEnrichers) {
        try {
          const next = await enricher({
            worktree: params.worktree,
            annotations: params.annotations,
            markdown: current,
          });
          if (typeof next === "string" && next.trim()) {
            current = next;
          }
        } catch {
          // ignore faulty plugin enricher
        }
      }
    }
    return current;
  }

  async invokeCli(params: {
    subcommand: string;
    worktreePath: string;
    argv: string[];
    stdin?: string;
    wait?: boolean;
    waitTimeoutMs?: number;
  }): Promise<unknown> {
    for (const entry of this.loaded.values()) {
      const handler = entry.cliHandlers.get(params.subcommand);
      if (handler) {
        return handler({
          worktreePath: params.worktreePath,
          argv: params.argv,
          stdin: params.stdin,
          wait: params.wait,
          waitTimeoutMs: params.waitTimeoutMs,
          presentCardAndWait: (card) =>
            this.bridge.presentCardAndWait({
              pluginId: entry.pluginId,
              pluginName: entry.pluginName,
              subcommand: params.subcommand,
              worktreePath: params.worktreePath,
              title: card.title,
              markdown: card.markdown,
              choices: card.choices,
              allowFreeformReply: card.allowFreeformReply,
              timeoutMs: card.timeoutMs ?? params.waitTimeoutMs,
            }),
        });
      }
    }
    throw new Error(
      `No enabled ide2 plugin registers CLI subcommand "${params.subcommand}".`,
    );
  }

  broadcastWorkspaceEvent(event: WorkspaceEvent): void {
    if (event.type === "worktrees-updated") {
      for (const entry of this.loaded.values()) {
        for (const l of entry.worktreeListeners) {
          try {
            l({
              worktrees: event.worktrees,
              changedWorktreePath: event.changedWorktreePath,
              changedFiles: event.changedFiles,
            });
          } catch {
            // ignore
          }
        }
      }
    } else if (event.type === "annotations-updated") {
      for (const entry of this.loaded.values()) {
        for (const l of entry.annotationListeners) {
          try {
            l({
              worktreePath: event.worktreePath,
              annotations: event.annotations,
            });
          } catch {
            // ignore
          }
        }
      }
    }
  }

  async disposeAll(): Promise<void> {
    const ids = Array.from(this.loaded.keys());
    for (const id of ids) {
      await this.unloadPlugin(id);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Worker Thread Entrypoint (`dist/main/plugin-runner.cjs`)                   */
/* -------------------------------------------------------------------------- */

export type RunnerIncomingMsg =
  | { kind: "host-req"; id: number; method: string; params?: Record<string, unknown> }
  | { kind: "host-evt"; event: WorkspaceEvent }
  | { kind: "worker-res"; id: number; ok: boolean; result?: unknown; error?: string };

export type RunnerOutgoingMsg =
  | { kind: "host-res"; id: number; ok: boolean; result?: unknown; error?: string }
  | { kind: "worker-req"; id: number; method: string; params?: Record<string, unknown> }
  | {
      kind: "worker-evt";
      type: "decorations";
      pluginId: string;
      decorations: PluginLineDecoration[];
    }
  | {
      kind: "worker-evt";
      type: "client-event";
      pluginId: string;
      event: string;
      payload: unknown;
    };

if (parentPort) {
  const port = parentPort;
  let nextWorkerReqId = 1;
  const pendingWorkerReqs = new Map<
    number,
    { resolve: (val: unknown) => void; reject: (err: Error) => void }
  >();

  const callHost = <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> => {
    const id = nextWorkerReqId++;
    return new Promise<T>((resolveReq, rejectReq) => {
      pendingWorkerReqs.set(id, {
        resolve: (v) => resolveReq(v as T),
        reject: rejectReq,
      });
      port.postMessage({
        kind: "worker-req",
        id,
        method,
        params,
      } satisfies RunnerOutgoingMsg);
    });
  };

  const core = new PluginRunnerCore({
    callWorkspace: (method, params) => callHost(`workspace.${method}`, params),
    presentCardAndWait: (params) => callHost("card.presentAndWait", params),
    onDecorationsUpdated: (pluginId, decorations) => {
      port.postMessage({
        kind: "worker-evt",
        type: "decorations",
        pluginId,
        decorations,
      } satisfies RunnerOutgoingMsg);
    },
    onClientEvent: (pluginId, event, payload) => {
      port.postMessage({
        kind: "worker-evt",
        type: "client-event",
        pluginId,
        event,
        payload,
      } satisfies RunnerOutgoingMsg);
    },
  });

  port.on("message", (msg: RunnerIncomingMsg) => {
    if (msg.kind === "worker-res") {
      const pending = pendingWorkerReqs.get(msg.id);
      if (!pending) return;
      pendingWorkerReqs.delete(msg.id);
      if (msg.ok) pending.resolve(msg.result);
      else pending.reject(new Error(msg.error ?? "Host call failed"));
      return;
    }

    if (msg.kind === "host-evt") {
      core.broadcastWorkspaceEvent(msg.event);
      return;
    }

    if (msg.kind === "host-req") {
      void (async () => {
        try {
          const p = (msg.params ?? {}) as Record<string, unknown>;
          let result: unknown;
          switch (msg.method) {
            case "loadPlugin":
              await core.loadPlugin(
                p as {
                  pluginId: string;
                  pluginName: string;
                  serverBundlePath: string;
                  dataDir: string;
                  grantedPermissions: PluginPermission[];
                },
              );
              break;
            case "unloadPlugin":
              await core.unloadPlugin(String(p.pluginId));
              break;
            case "callRpc":
              result = await core.callRpc(
                p as {
                  pluginId: string;
                  method: string;
                  payload?: unknown;
                  worktreePath?: string;
                },
              );
              break;
            case "triggerAction":
              await core.triggerAction(
                p as {
                  pluginId: string;
                  actionId: string;
                  worktreePath?: string;
                  filePath?: string;
                  line?: number;
                },
              );
              break;
            case "enrichPrompt":
              result = await core.enrichPrompt(
                p as { worktree: WorktreeInfo; annotations: Annotation[]; markdown: string },
              );
              break;
            case "invokeCli":
              result = await core.invokeCli(
                p as {
                  subcommand: string;
                  worktreePath: string;
                  argv: string[];
                  stdin?: string;
                  wait?: boolean;
                  waitTimeoutMs?: number;
                },
              );
              break;
            case "disposeAll":
              await core.disposeAll();
              break;
            default:
              throw new Error(`Unknown runner method "${msg.method}"`);
          }
          port.postMessage({
            kind: "host-res",
            id: msg.id,
            ok: true,
            result,
          } satisfies RunnerOutgoingMsg);
        } catch (err) {
          port.postMessage({
            kind: "host-res",
            id: msg.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          } satisfies RunnerOutgoingMsg);
        }
      })();
    }
  });
}
