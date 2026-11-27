import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { PluginRuntimeController, WorkspaceBackend } from "../backend/workspace-backend.js";
import type {
  Annotation,
  DiffScope,
  InstalledPluginInfo,
  InstallPluginParams,
  InstallPluginResult,
  PluginAgentCardChoice,
  PluginAgentCardState,
  PluginHostAffinity,
  PluginLineDecoration,
  UpdatePluginResult,
  WorktreeInfo,
} from "../../shared/protocol.js";
import { bundlePluginDirectory } from "./bundler.js";
import { PluginInstaller } from "./installer.js";
import {
  PluginRunnerCore,
  type RunnerIncomingMsg,
  type RunnerOutgoingMsg,
} from "./plugin-runner.js";

export interface PluginHostOptions {
  backend: WorkspaceBackend;
  storageRoot?: string;
  scope: "local" | "remote";
  /**
   * Filter which plugins this `PluginHost` executes:
   * - `"all"`: run both `"client"` and `"workspace"` plugins (used when viewing a local repo!)
   * - `"client"`: run `"client"`-affinity plugins on your laptop when viewing a remote SSH repo
   * - `"workspace"`: run `"workspace"`-affinity plugins inside `ide2 daemon` on a remote SSH host
   */
  hostAffinityFilter: "all" | PluginHostAffinity;
  runnerWorkerPath?: string;
  builtinPluginDirs?: string[];
  onStateChanged?: (snapshot: {
    plugins: InstalledPluginInfo[];
    decorations: PluginLineDecoration[];
    cards: PluginAgentCardState[];
  }) => void;
  onPluginEvent?: (pluginId: string, event: string, payload: unknown) => void;
}

interface PendingCardSession {
  state: PluginAgentCardState;
  resolve: (res: { status: "responded" | "waiting"; action?: string; message?: string }) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class PluginHost implements PluginRuntimeController {
  private readonly storageRoot: string;
  private readonly installer: PluginInstaller;
  private readonly decorationsByPlugin = new Map<string, PluginLineDecoration[]>();
  private readonly runtimeErrors = new Map<string, string>();
  private readonly activeLoadedIds = new Set<string>();
  private readonly reloadStampByPlugin = new Map<string, number>();
  private readonly reloadingByPlugin = new Map<string, Promise<void>>();
  private readonly linkWatchers = new Map<string, FSWatcher>();
  private lockDirWatcher: FSWatcher | null = null;
  private readonly cardSessions = new Map<string, PendingCardSession>();

  private worker: Worker | null = null;
  private inProcessRunner: PluginRunnerCore | null = null;
  private nextReqId = 1;
  private readonly pendingReqs = new Map<
    number,
    { resolve: (val: unknown) => void; reject: (err: Error) => void }
  >();
  private unsubBackend: (() => void) | null = null;
  private disposed = false;

  constructor(private readonly opts: PluginHostOptions) {
    this.storageRoot =
      opts.storageRoot ?? process.env.IDE2_HOME ?? join(homedir(), ".expect2-ide");
    this.installer = new PluginInstaller(this.storageRoot, opts.scope);
  }

  async start(): Promise<void> {
    if (this.opts.builtinPluginDirs) {
      for (const dir of this.opts.builtinPluginDirs) {
        try {
          await this.installer.ensureBuiltinPlugin(dir);
        } catch {
          // Non-fatal builtin seeding error
        }
      }
    }

    this.initRunner();

    this.unsubBackend = this.opts.backend.onEvent((evt) => {
      if (evt.type === "worktrees-updated" || evt.type === "annotations-updated") {
        if (this.worker) {
          this.worker.postMessage({ kind: "host-evt", event: evt } satisfies RunnerIncomingMsg);
        } else if (this.inProcessRunner) {
          this.inProcessRunner.broadcastWorkspaceEvent(evt);
        }
      }
    });

    await this.reconcileActivePlugins();
    this.startLockDirWatcher();
  }

  private startLockDirWatcher(): void {
    if (this.lockDirWatcher || this.disposed) return;
    try {
      mkdirSync(this.installer.pluginsDir, { recursive: true });
      let timer: ReturnType<typeof setTimeout> | null = null;
      this.lockDirWatcher = watch(this.installer.pluginsDir, (_evt, filename) => {
        if (!filename || filename === "lock.json" || filename.startsWith("lock.json.")) {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            if (!this.disposed) {
              void this.reconcileActivePlugins();
            }
          }, 150);
        }
      });
    } catch {
      // Non-fatal if OS watcher unavailable
    }
  }

  private initRunner(): void {
    if (this.opts.runnerWorkerPath && existsSync(this.opts.runnerWorkerPath)) {
      const worker = new Worker(this.opts.runnerWorkerPath);
      worker.on("message", (msg: RunnerOutgoingMsg) => {
        if (msg.kind === "host-res") {
          const pending = this.pendingReqs.get(msg.id);
          if (!pending) return;
          this.pendingReqs.delete(msg.id);
          if (msg.ok) pending.resolve(msg.result);
          else pending.reject(new Error(msg.error ?? "Plugin runner error"));
        } else if (msg.kind === "worker-evt") {
          if (msg.type === "decorations") {
            this.decorationsByPlugin.set(msg.pluginId, msg.decorations);
            if (!this.reloadingByPlugin.has(msg.pluginId)) {
              this.emitSnapshot();
            }
          } else if (msg.type === "client-event") {
            this.opts.onPluginEvent?.(msg.pluginId, msg.event, msg.payload);
          }
        } else if (msg.kind === "worker-req") {
          void this.handleWorkerRequest(msg.id, msg.method, msg.params);
        }
      });
      worker.on("error", (err: Error) => {
        for (const [, p] of this.pendingReqs) p.reject(err);
        this.pendingReqs.clear();
      });
      this.worker = worker;
      return;
    }

    this.inProcessRunner = new PluginRunnerCore({
      callWorkspace: (method, params) => this.dispatchWorkspaceCall(method, params),
      presentCardAndWait: (params) => this.presentCardInternal(params),
      onDecorationsUpdated: (pluginId, decorations) => {
        this.decorationsByPlugin.set(pluginId, decorations);
        if (!this.reloadingByPlugin.has(pluginId)) {
          this.emitSnapshot();
        }
      },
      onClientEvent: (pluginId, event, payload) => {
        this.opts.onPluginEvent?.(pluginId, event, payload);
      },
    });
  }

  private async handleWorkerRequest(
    id: number,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.worker) return;
    try {
      let result: unknown;
      if (method.startsWith("workspace.")) {
        result = await this.dispatchWorkspaceCall(method.slice("workspace.".length), params);
      } else if (method === "card.presentAndWait") {
        result = await this.presentCardInternal(
          params as unknown as {
            pluginId: string;
            pluginName: string;
            subcommand: string;
            worktreePath: string;
            title: string;
            markdown: string;
            choices?: PluginAgentCardChoice[];
            allowFreeformReply?: boolean;
            timeoutMs?: number;
          },
        );
      } else {
        throw new Error(`Unknown worker host request "${method}"`);
      }
      this.worker.postMessage({
        kind: "worker-res",
        id,
        ok: true,
        result,
      } satisfies RunnerIncomingMsg);
    } catch (err) {
      this.worker.postMessage({
        kind: "worker-res",
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies RunnerIncomingMsg);
    }
  }

  private async dispatchWorkspaceCall<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const p = params ?? {};
    switch (method) {
      case "getLaunchContext":
        return this.opts.backend.getLaunchContext() as T;
      case "discoverWorktrees":
        return (await this.opts.backend.discoverWorktrees()) as T;
      case "listFiles":
        return (await this.opts.backend.listFiles(String(p.worktreePath))) as T;
      case "readFile":
        return (await this.opts.backend.readFile(
          String(p.worktreePath),
          String(p.filePath),
          p.diffScope as DiffScope | undefined,
        )) as T;
      case "getDiff":
        return (await this.opts.backend.getDiff(
          String(p.worktreePath),
          String(p.filePath),
          p.scope as DiffScope,
        )) as T;
      case "listChangedFiles":
        return (await this.opts.backend.listChangedFiles(
          String(p.worktreePath),
          p.scope as DiffScope,
        )) as T;
      default:
        throw new Error(`Unsupported plugin workspace method "${method}"`);
    }
  }

  private callRunner<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (this.worker) {
      const id = this.nextReqId++;
      return new Promise<T>((resolveReq, rejectReq) => {
        this.pendingReqs.set(id, {
          resolve: (v) => resolveReq(v as T),
          reject: rejectReq,
        });
        this.worker!.postMessage({
          kind: "host-req",
          id,
          method,
          params,
        } satisfies RunnerIncomingMsg);
      });
    }

    if (!this.inProcessRunner) {
      return Promise.reject(new Error("Plugin runner is not initialized"));
    }
    const r = this.inProcessRunner;
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "loadPlugin":
        return r.loadPlugin(p as Parameters<PluginRunnerCore["loadPlugin"]>[0]) as Promise<T>;
      case "unloadPlugin":
        return r.unloadPlugin(String(p.pluginId)) as Promise<T>;
      case "callRpc":
        return r.callRpc(p as Parameters<PluginRunnerCore["callRpc"]>[0]) as Promise<T>;
      case "triggerAction":
        return r.triggerAction(p as Parameters<PluginRunnerCore["triggerAction"]>[0]) as Promise<T>;
      case "enrichPrompt":
        return r.enrichPrompt(p as Parameters<PluginRunnerCore["enrichPrompt"]>[0]) as Promise<T>;
      case "invokeCli":
        return r.invokeCli(p as Parameters<PluginRunnerCore["invokeCli"]>[0]) as Promise<T>;
      case "disposeAll":
        return r.disposeAll() as Promise<T>;
      default:
        return Promise.reject(new Error(`Unknown runner method "${method}"`));
    }
  }

  private shouldExecutePlugin(plugin: InstalledPluginInfo): boolean {
    if (!plugin.enabled || plugin.error) return false;
    const affinity = plugin.manifest.host ?? "client";
    if (this.opts.hostAffinityFilter === "all") return true;
    return affinity === this.opts.hostAffinityFilter;
  }

  private async reconcileActivePlugins(): Promise<void> {
    const all = this.installer.listInstalled();
    const desiredIds = new Set<string>();

    for (const plugin of all) {
      if (this.shouldExecutePlugin(plugin)) {
        desiredIds.add(plugin.id);
      }
    }

    // Unload disabled/removed plugins
    for (const activeId of Array.from(this.activeLoadedIds)) {
      if (!desiredIds.has(activeId)) {
        this.activeLoadedIds.delete(activeId);
        this.decorationsByPlugin.delete(activeId);
        this.stopLinkWatcher(activeId);
        await this.callRunner("unloadPlugin", { pluginId: activeId }).catch(() => {});
      }
    }

    // Load enabled plugins with server bundles
    for (const plugin of all) {
      if (!desiredIds.has(plugin.id)) continue;
      if (this.activeLoadedIds.has(plugin.id)) continue;

      if (plugin.hasServerBundle) {
        const pluginDir = this.installer.getPluginDir(plugin.id);
        const serverBundlePath = join(pluginDir, ".ide2-build/server.cjs");
        const dataDir = join(this.storageRoot, "plugin-data", plugin.id);
        try {
          await this.callRunner("loadPlugin", {
            pluginId: plugin.id,
            pluginName: plugin.manifest.name,
            serverBundlePath,
            dataDir,
            grantedPermissions: plugin.grantedPermissions,
          });
          this.runtimeErrors.delete(plugin.id);
          this.activeLoadedIds.add(plugin.id);
        } catch (err) {
          this.runtimeErrors.set(
            plugin.id,
            err instanceof Error ? err.message : String(err),
          );
        }
      } else {
        this.activeLoadedIds.add(plugin.id);
      }

      if (plugin.source.linked) {
        this.ensureLinkWatcher(plugin);
      }
    }

    this.emitSnapshot();
  }

  private ensureLinkWatcher(plugin: InstalledPluginInfo): void {
    if (this.linkWatchers.has(plugin.id)) return;
    const rawDir = this.installer.getPluginDir(plugin.id);
    let watchTarget = rawDir;
    try {
      // Resolve symlink target so macOS FSEvents observes edits inside the linked repo
      watchTarget = realpathSync(rawDir);
    } catch {
      watchTarget = rawDir;
    }
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    try {
      const watcher = watch(watchTarget, { recursive: true }, (_evt, filename) => {
        if (!filename) return;
        const norm = String(filename).replace(/\\/g, "/");
        if (
          norm.startsWith(".ide2-build") ||
          norm.includes("/.ide2-build") ||
          norm.startsWith(".git") ||
          norm.includes("/.git") ||
          norm.startsWith("node_modules") ||
          norm.includes("/node_modules")
        ) {
          return;
        }
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          void this.reloadPlugin(plugin.id);
        }, 120);
      });
      this.linkWatchers.set(plugin.id, watcher);
    } catch {
      // Non-fatal if OS recursive watch unsupported
    }
  }

  private stopLinkWatcher(pluginId: string): void {
    const w = this.linkWatchers.get(pluginId);
    if (w) {
      this.linkWatchers.delete(pluginId);
      w.close();
    }
  }

  async reloadPlugin(pluginId: string): Promise<void> {
    const all = this.installer.listInstalled();
    const target = all.find((p) => p.id === pluginId);
    if (!target) return;
    const dir = this.installer.getPluginDir(pluginId);

    const run = (async () => {
      try {
        await bundlePluginDirectory(dir, target.manifest);
        const prevStamp = this.reloadStampByPlugin.get(pluginId) ?? target.updatedAt;
        this.reloadStampByPlugin.set(pluginId, Math.max(Date.now(), prevStamp + 1));
        this.activeLoadedIds.delete(pluginId);
        await this.callRunner("unloadPlugin", { pluginId }).catch(() => {});
        await this.reconcileActivePlugins();
      } catch (err) {
        this.runtimeErrors.set(pluginId, err instanceof Error ? err.message : String(err));
        this.emitSnapshot();
      }
    })();

    this.reloadingByPlugin.set(pluginId, run);
    try {
      await run;
    } finally {
      if (this.reloadingByPlugin.get(pluginId) === run) {
        this.reloadingByPlugin.delete(pluginId);
      }
      this.emitSnapshot();
    }
  }

  private getAnnotatedPluginList(): InstalledPluginInfo[] {
    return this.installer
      .listInstalled()
      .filter((p) => {
        if (this.opts.hostAffinityFilter === "all") return true;
        const affinity = p.manifest.host ?? "client";
        return affinity === this.opts.hostAffinityFilter;
      })
      .map((p) => ({
        ...p,
        updatedAt: Math.max(p.updatedAt, this.reloadStampByPlugin.get(p.id) ?? 0),
        error: p.error ?? this.runtimeErrors.get(p.id),
      }));
  }

  getDecorations(): PluginLineDecoration[] {
    const out: PluginLineDecoration[] = [];
    for (const [id, list] of this.decorationsByPlugin.entries()) {
      if (this.activeLoadedIds.has(id)) {
        out.push(...list);
      }
    }
    return out;
  }

  getCards(): PluginAgentCardState[] {
    return Array.from(this.cardSessions.values()).map((c) => c.state);
  }

  private emitSnapshot(): void {
    if (this.disposed) return;
    this.opts.onStateChanged?.({
      plugins: this.getAnnotatedPluginList(),
      decorations: this.getDecorations(),
      cards: this.getCards(),
    });
  }

  async listPlugins(): Promise<InstalledPluginInfo[]> {
    return this.getAnnotatedPluginList();
  }

  async installPlugin(params: InstallPluginParams): Promise<InstallPluginResult> {
    const res = await this.installer.install(params);
    if (res.installed) {
      this.activeLoadedIds.delete(res.installed.id);
      await this.callRunner("unloadPlugin", { pluginId: res.installed.id }).catch(() => {});
      await this.reconcileActivePlugins();
      const refreshed = this.getAnnotatedPluginList().find((p) => p.id === res.installed!.id);
      return { installed: refreshed ?? res.installed };
    }
    return res;
  }

  async setPluginEnabled(pluginId: string, enabled: boolean): Promise<InstalledPluginInfo[]> {
    this.installer.setEnabled(pluginId, enabled);
    await this.reconcileActivePlugins();
    return this.getAnnotatedPluginList();
  }

  async updatePlugin(pluginId: string, approvePermissions = false): Promise<UpdatePluginResult> {
    const res = await this.installer.update(pluginId, approvePermissions);
    if (res.updated && !res.upToDate) {
      this.activeLoadedIds.delete(pluginId);
      await this.callRunner("unloadPlugin", { pluginId }).catch(() => {});
      await this.reconcileActivePlugins();
    }
    return res;
  }

  async removePlugin(pluginId: string): Promise<InstalledPluginInfo[]> {
    this.activeLoadedIds.delete(pluginId);
    this.decorationsByPlugin.delete(pluginId);
    this.runtimeErrors.delete(pluginId);
    this.stopLinkWatcher(pluginId);
    await this.callRunner("unloadPlugin", { pluginId }).catch(() => {});
    this.installer.remove(pluginId);
    this.emitSnapshot();
    return this.getAnnotatedPluginList();
  }

  async callPluginRpc(params: {
    pluginId: string;
    method: string;
    payload?: unknown;
    worktreePath?: string;
  }): Promise<unknown> {
    const inflightReload = this.reloadingByPlugin.get(params.pluginId);
    if (inflightReload) {
      await inflightReload;
    }
    return this.callRunner("callRpc", params);
  }

  async triggerPluginAction(params: {
    pluginId: string;
    actionId: string;
    worktreePath?: string;
    filePath?: string;
    line?: number;
  }): Promise<void> {
    await this.callRunner("triggerAction", params);
  }

  async enrichFeedbackPrompt(params: {
    worktree: WorktreeInfo;
    annotations: Annotation[];
    markdown: string;
  }): Promise<string> {
    if (this.activeLoadedIds.size === 0) return params.markdown;
    return this.callRunner<string>("enrichPrompt", params);
  }

  private presentCardInternal(params: {
    pluginId: string;
    pluginName: string;
    subcommand: string;
    worktreePath: string;
    title: string;
    markdown: string;
    choices?: PluginAgentCardChoice[];
    allowFreeformReply?: boolean;
    timeoutMs?: number;
  }): Promise<{ status: "responded" | "waiting"; action?: string; message?: string }> {
    const sessionId = randomBytes(8).toString("hex");
    const choices: PluginAgentCardChoice[] =
      params.choices && params.choices.length > 0
        ? params.choices
        : [
            { id: "approve", label: "Approve ✓", kind: "primary" },
            { id: "dismiss", label: "Dismiss", kind: "default" },
          ];

    const state: PluginAgentCardState = {
      sessionId,
      pluginId: params.pluginId,
      pluginName: params.pluginName,
      subcommand: params.subcommand,
      worktreePath: params.worktreePath,
      title: params.title,
      markdown: params.markdown,
      choices,
      allowFreeformReply: params.allowFreeformReply ?? true,
      awaitingUser: true,
      createdAt: Date.now(),
    };

    const timeoutMs = params.timeoutMs ?? 90000;

    return new Promise((resolveCard) => {
      const entry: PendingCardSession = {
        state,
        resolve: resolveCard,
      };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.cardSessions.delete(sessionId);
          this.emitSnapshot();
          resolveCard({ status: "waiting" });
        }, timeoutMs);
      }
      this.cardSessions.set(sessionId, entry);
      this.emitSnapshot();
    });
  }

  async respondPluginCard(params: {
    sessionId: string;
    action: string;
    message?: string;
  }): Promise<boolean> {
    const entry = this.cardSessions.get(params.sessionId);
    if (!entry) return false;
    this.cardSessions.delete(params.sessionId);
    if (entry.timer) clearTimeout(entry.timer);
    this.emitSnapshot();
    entry.resolve({
      status: "responded",
      action: params.action,
      message: params.message,
    });
    return true;
  }

  async handleAgentCli(params: {
    worktreePath: string;
    subcommand: string;
    argv: string[];
    stdin?: string;
    wait?: boolean;
    waitTimeoutMs?: number;
  }): Promise<unknown> {
    return this.callRunner("invokeCli", params);
  }

  async readPluginClientBundle(pluginId: string): Promise<string | null> {
    const bundlePath = join(this.installer.getPluginDir(pluginId), ".ide2-build/client.js");
    if (!existsSync(bundlePath)) return null;
    return readFileSync(bundlePath, "utf8");
  }

  hasPlugin(pluginId: string): boolean {
    return this.installer.listInstalled().some((p) => p.id === pluginId);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubBackend?.();
    if (this.lockDirWatcher) {
      this.lockDirWatcher.close();
      this.lockDirWatcher = null;
    }
    for (const w of this.linkWatchers.values()) w.close();
    this.linkWatchers.clear();
    for (const [, c] of this.cardSessions) {
      if (c.timer) clearTimeout(c.timer);
      c.resolve({ status: "responded", action: "cancel" });
    }
    this.cardSessions.clear();
    await this.callRunner("disposeAll").catch(() => {});
    if (this.worker) {
      const w = this.worker;
      this.worker = null;
      await w.terminate();
    }
  }
}
