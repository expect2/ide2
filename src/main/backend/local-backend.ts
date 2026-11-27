import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { IntelClient } from "../intel/client.js";
import { AnnotationStore } from "../services/annotations.js";
import { resolveRepoContext, WorktreeService } from "../services/git.js";
import type { TourServer } from "../services/tour-server.js";
import { MultiWorktreeWatcher } from "../services/watcher.js";
import type {
  Annotation,
  ChangedFileSummary,
  CodeSymbol,
  CommitEntry,
  CreateAnnotationInput,
  DiffScope,
  ExportPromptOptions,
  FileDiffResult,
  FileDocument,
  FileEntry,
  FileGitStatus,
  FindInPathQuery,
  FuzzyFileHit,
  InstalledPluginInfo,
  InstallPluginParams,
  InstallPluginResult,
  LaunchContext,
  LineBlame,
  RemoteConnectionState,
  ReviewUserResponse,
  SearchMatch,
  TokenSpan,
  UpdateAnnotationInput,
  UpdatePluginResult,
  WalkthroughUserResponse,
  WorkspaceEvent,
  WorktreeInfo,
} from "../../shared/protocol.js";
import type {
  BootstrapSnapshot,
  PluginRuntimeController,
  WorkspaceBackend,
} from "./workspace-backend.js";

export interface CreateLocalBackendOptions {
  targetPath: string;
  cwd?: string;
  worktree?: string;
  diff?: boolean;
  base?: string;
  intel: IntelClient;
  tourServer: TourServer;
  createPluginController?: (backend: LocalWorkspaceBackend) => Promise<PluginRuntimeController>;
}

/**
 * Pure Node.js repository backend with zero `electron` imports.
 * Runs either inside Electron Main (for local repositories) or inside
 * `ide2 daemon --stdio` on a remote SSH host.
 */
export class LocalWorkspaceBackend implements WorkspaceBackend {
  readonly isRemote = false;

  private readonly git: WorktreeService;
  private readonly annotations: AnnotationStore;
  private readonly watcher: MultiWorktreeWatcher;
  private readonly intel: IntelClient;
  private readonly tourServer: TourServer;
  private readonly analysisCache = new Map<string, { tokens: TokenSpan[][]; symbols: CodeSymbol[] }>();
  private readonly gitStatusCache = new Map<string, Map<string, FileGitStatus>>();
  private readonly listeners = new Set<(event: WorkspaceEvent) => void>();
  private pluginController: PluginRuntimeController | null = null;
  private disposed = false;

  private constructor(
    private readonly context: LaunchContext,
    deps: {
      git: WorktreeService;
      annotations: AnnotationStore;
      watcher: MultiWorktreeWatcher;
      intel: IntelClient;
      tourServer: TourServer;
    },
  ) {
    this.git = deps.git;
    this.annotations = deps.annotations;
    this.watcher = deps.watcher;
    this.intel = deps.intel;
    this.tourServer = deps.tourServer;
  }

  static async create(opts: CreateLocalBackendOptions): Promise<LocalWorkspaceBackend> {
    const baseCtx = await resolveRepoContext(opts.targetPath);
    const git = new WorktreeService(baseCtx.repoCommonDir);
    const worktrees = await git.discoverWorktrees(baseCtx.initialWorktreePath);

    const initialWorktreePath = selectWorktreeFromList(
      worktrees,
      baseCtx.initialWorktreePath,
      opts.worktree,
      opts.cwd ?? opts.targetPath,
    );

    const launchContext: LaunchContext = {
      ...baseCtx,
      initialWorktreePath,
      initialDiffMode: Boolean(opts.diff),
      initialBaseRef: opts.base,
    };

    const annotations = new AnnotationStore(baseCtx.repoCommonDir);

    let backendRef: LocalWorkspaceBackend | null = null;
    const watcher = new MultiWorktreeWatcher(
      worktrees,
      baseCtx.repoCommonDir,
      async ({ worktreePath, changedFiles }) => {
        if (!backendRef || backendRef.disposed) return;
        backendRef.gitStatusCache.delete(worktreePath);
        opts.intel.invalidateWorktree(worktreePath, changedFiles);
        const updatedWorktrees = await git.discoverWorktrees(baseCtx.initialWorktreePath);

        let reconciledAny = false;
        for (const relFile of changedFiles.slice(0, 25)) {
          try {
            const doc = await git.readFile(worktreePath, relFile);
            if (!doc.isBinary) {
              await annotations.reconcileFile(worktreePath, relFile, doc.lines, doc.contentHash);
              reconciledAny = true;
            }
          } catch {
            // File may have been deleted or ignored
          }
        }

        backendRef.emitEvent({
          type: "worktrees-updated",
          worktrees: updatedWorktrees,
          changedWorktreePath: worktreePath,
          changedFiles,
        });

        if (reconciledAny) {
          const list = await annotations.list();
          backendRef.emitEvent({
            type: "annotations-updated",
            worktreePath,
            annotations: list,
          });
        }
      },
      {
        onActivity: (worktreePath, timestamp) => {
          git.touchActivity(worktreePath, timestamp);
        },
      },
    );

    const instance = new LocalWorkspaceBackend(launchContext, {
      git,
      annotations,
      watcher,
      intel: opts.intel,
      tourServer: opts.tourServer,
    });
    backendRef = instance;

    if (opts.createPluginController) {
      instance.pluginController = await opts.createPluginController(instance);
    }

    return instance;
  }

  attachPluginController(controller: PluginRuntimeController): void {
    this.pluginController = controller;
  }

  getPluginController(): PluginRuntimeController | null {
    return this.pluginController;
  }

  getLaunchContext(): LaunchContext {
    return this.context;
  }

  getConnectionState(): RemoteConnectionState {
    return {
      isRemote: false,
      status: "local",
    };
  }

  emitEvent(event: WorkspaceEvent): void {
    if (this.disposed) return;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // ignore listener failure
      }
    }
  }

  onEvent(listener: (event: WorkspaceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async selectWorktreePath(query?: string, cwdHint?: string): Promise<string> {
    const cached = this.git.listCachedWorktrees();
    const wts =
      cached.length > 0 ? cached : await this.git.discoverWorktrees(this.context.initialWorktreePath);
    return selectWorktreeFromList(
      wts,
      this.context.initialWorktreePath,
      query,
      cwdHint ?? this.context.initialWorktreePath,
    );
  }

  listCachedWorktrees(): WorktreeInfo[] {
    return this.git.listCachedWorktrees();
  }

  async discoverWorktrees(): Promise<WorktreeInfo[]> {
    return this.git.discoverWorktrees(this.context.initialWorktreePath);
  }

  async getBootstrapSnapshot(overrides?: {
    initialWorktreePath?: string;
    initialFilePath?: string;
    initialLine?: number;
    initialColumn?: number;
    initialDiffMode?: boolean;
    initialBaseRef?: string;
  }): Promise<BootstrapSnapshot> {
    const cachedWts = this.git.listCachedWorktrees();
    const [worktrees, annotations, plugins] = await Promise.all([
      cachedWts.length > 0
        ? Promise.resolve(cachedWts)
        : this.git.discoverWorktrees(this.context.initialWorktreePath),
      this.annotations.list(),
      this.listPlugins(),
    ]);
    const walkthroughs = this.tourServer.getWalkthroughStates(this.context.repoCommonDir);
    const reviews = this.tourServer.getReviewStates(this.context.repoCommonDir);

    return {
      context: {
        ...this.context,
        ...(overrides?.initialWorktreePath
          ? { initialWorktreePath: overrides.initialWorktreePath }
          : {}),
        ...(overrides?.initialFilePath !== undefined
          ? { initialFilePath: overrides.initialFilePath }
          : {}),
        ...(overrides?.initialLine !== undefined ? { initialLine: overrides.initialLine } : {}),
        ...(overrides?.initialColumn !== undefined
          ? { initialColumn: overrides.initialColumn }
          : {}),
        ...(overrides?.initialDiffMode !== undefined
          ? { initialDiffMode: overrides.initialDiffMode }
          : {}),
        ...(overrides?.initialBaseRef !== undefined
          ? { initialBaseRef: overrides.initialBaseRef }
          : {}),
      },
      worktrees,
      annotations,
      walkthroughs,
      reviews,
      connection: this.getConnectionState(),
      plugins,
      pluginDecorations: this.pluginController?.getDecorations() ?? [],
      pluginCards: this.pluginController?.getCards() ?? [],
    };
  }

  private assertRegisteredWorktree(worktreePath: string): string {
    let canon = worktreePath;
    try {
      canon = realpathSync(worktreePath);
    } catch {
      // membership check below will reject
    }
    const known = this.git.listCachedWorktrees().some((w) => w.path === canon);
    if (!known) {
      throw new Error(`Refused access to unregistered worktree path: ${worktreePath}`);
    }
    return canon;
  }

  async listFiles(worktreePath: string): Promise<FileEntry[]> {
    const safeWt = this.assertRegisteredWorktree(worktreePath);
    const files = await this.git.listFiles(safeWt);
    const statusMap = new Map(
      files.filter((f) => f.gitStatus).map((f) => [f.path, f.gitStatus!]),
    );
    this.gitStatusCache.set(safeWt, statusMap);
    return files;
  }

  async fuzzyFindFiles(params: {
    worktreePath: string;
    query: string;
    allWorktrees?: boolean;
    limit?: number;
  }): Promise<FuzzyFileHit[]> {
    const wts = this.git.listCachedWorktrees();
    const targetWts = params.allWorktrees
      ? wts
      : wts.filter((w) => w.path === params.worktreePath);
    const worktreesMeta = await Promise.all(
      targetWts.map(async (wt) => {
        let gitStatuses = this.gitStatusCache.get(wt.path);
        if (!gitStatuses) {
          const files = await this.git.listFiles(wt.path);
          gitStatuses = new Map(
            files.filter((f) => f.gitStatus).map((f) => [f.path, f.gitStatus!]),
          );
          this.gitStatusCache.set(wt.path, gitStatuses);
        }
        return { path: wt.path, name: wt.name, gitStatuses };
      }),
    );
    return this.intel.fuzzyFindFiles({
      ...params,
      worktrees: worktreesMeta,
    });
  }

  async readFile(
    worktreePath: string,
    filePath: string,
    diffScope?: DiffScope,
  ): Promise<FileDocument> {
    const safeWt = this.assertRegisteredWorktree(worktreePath);
    const doc = await this.git.readFile(safeWt, filePath, diffScope);
    if (doc.isBinary) return doc;

    const cacheKey = `${doc.language}:${doc.contentHash}`;
    const cached = this.analysisCache.get(cacheKey);
    if (cached) {
      return { ...doc, tokens: cached.tokens };
    }

    const rawContent = doc.lines.join("\n");
    void this.intel
      .analyzeFile(safeWt, filePath, doc.contentHash, rawContent, doc.language)
      .then((analyzed) => {
        if (this.disposed) return;
        if (this.analysisCache.size > 150) {
          const firstKey = this.analysisCache.keys().next().value;
          if (firstKey) this.analysisCache.delete(firstKey);
        }
        this.analysisCache.set(cacheKey, {
          tokens: analyzed.tokens,
          symbols: analyzed.symbols,
        });
        this.emitEvent({
          type: "tokens-ready",
          worktreePath: safeWt,
          filePath,
          contentHash: doc.contentHash,
          tokens: analyzed.tokens,
          symbols: analyzed.symbols,
        });
      })
      .catch(() => {
        // Non-fatal highlight/AST error
      });

    return doc;
  }

  async readAssetDataUrl(
    worktreePath: string,
    relativeFromFile: string,
    rawHref: string,
  ): Promise<string | null> {
    const safeWt = this.assertRegisteredWorktree(worktreePath);
    return this.git.readAssetDataUrl(safeWt, relativeFromFile, rawHref);
  }

  async getDiff(
    worktreePath: string,
    filePath: string,
    scope: DiffScope,
  ): Promise<FileDiffResult> {
    const safeWt = this.assertRegisteredWorktree(worktreePath);
    const safeScope: DiffScope =
      scope.kind === "worktree"
        ? {
            kind: "worktree",
            otherWorktreePath: this.assertRegisteredWorktree(scope.otherWorktreePath),
          }
        : scope;
    return this.git.getDiff(safeWt, filePath, safeScope);
  }

  async listChangedFiles(worktreePath: string, scope: DiffScope): Promise<ChangedFileSummary[]> {
    const safeWt = this.assertRegisteredWorktree(worktreePath);
    const safeScope: DiffScope =
      scope.kind === "worktree"
        ? {
            kind: "worktree",
            otherWorktreePath: this.assertRegisteredWorktree(scope.otherWorktreePath),
          }
        : scope;
    return this.git.listChangedFiles(safeWt, safeScope);
  }

  async listCommits(worktreePath: string, limit?: number): Promise<CommitEntry[]> {
    const safeWt = this.assertRegisteredWorktree(worktreePath);
    return this.git.listCommits(safeWt, limit);
  }

  async getBlame(worktreePath: string, filePath: string): Promise<LineBlame[]> {
    const safeWt = this.assertRegisteredWorktree(worktreePath);
    return this.git.getBlame(safeWt, filePath);
  }

  async getStructure(worktreePath: string, filePath: string): Promise<CodeSymbol[]> {
    const safeWt = this.assertRegisteredWorktree(worktreePath);
    const doc = await this.git.readFile(safeWt, filePath);
    if (doc.isBinary) return [];
    const cacheKey = `${doc.language}:${doc.contentHash}`;
    const cached = this.analysisCache.get(cacheKey);
    if (cached) return cached.symbols;
    return this.intel.getStructure(safeWt, filePath, doc.lines.join("\n"));
  }

  async searchSymbols(params: {
    worktreePath: string;
    query: string;
    allWorktrees?: boolean;
    limit?: number;
  }): Promise<CodeSymbol[]> {
    const worktreePaths = this.git.listCachedWorktrees().map((w) => w.path);
    return this.intel.searchSymbols({ ...params, worktreePaths });
  }

  async findDefinitionAndUsages(params: {
    worktreePath: string;
    filePath: string;
    symbolName: string;
    line: number;
  }): Promise<{ definitions: SearchMatch[]; usages: SearchMatch[] }> {
    const safeWt = this.assertRegisteredWorktree(params.worktreePath);
    return this.intel.findDefinitionAndUsages({ ...params, worktreePath: safeWt });
  }

  async findInPath(query: FindInPathQuery): Promise<SearchMatch[]> {
    const wts = this.git.listCachedWorktrees().map((w) => ({ path: w.path, name: w.name }));
    return this.intel.findInPath(query, wts);
  }

  async listAnnotations(worktreePath?: string): Promise<Annotation[]> {
    return this.annotations.list(worktreePath);
  }

  async createAnnotation(input: CreateAnnotationInput): Promise<Annotation> {
    const created = await this.annotations.create(input);
    const all = await this.annotations.list();
    this.emitEvent({
      type: "annotations-updated",
      worktreePath: created.worktreePath,
      annotations: all,
    });
    return created;
  }

  async updateAnnotation(input: UpdateAnnotationInput): Promise<Annotation> {
    const updated = await this.annotations.update(input);
    const all = await this.annotations.list();
    this.emitEvent({
      type: "annotations-updated",
      worktreePath: updated.worktreePath,
      annotations: all,
    });
    return updated;
  }

  async deleteAnnotation(id: string): Promise<void> {
    await this.annotations.delete(id);
    const all = await this.annotations.list();
    this.emitEvent({
      type: "annotations-updated",
      worktreePath: this.context.initialWorktreePath,
      annotations: all,
    });
  }

  async compileFeedbackPrompt(
    options: ExportPromptOptions,
  ): Promise<{ markdown: string; count: number }> {
    const safeWt = this.assertRegisteredWorktree(options.worktreePath);
    const wts = await this.git.discoverWorktrees(this.context.initialWorktreePath);
    const wt = wts.find((w) => w.path === safeWt) ?? wts[0];
    if (!wt) {
      return { markdown: "", count: 0 };
    }
    const openBefore = await this.annotations.list(safeWt);
    const res = await this.annotations.compilePrompt(wt, { ...options, worktreePath: safeWt });
    let markdown = res.markdown;
    if (res.count > 0 && markdown && this.pluginController) {
      try {
        markdown = await this.pluginController.enrichFeedbackPrompt({
          worktree: wt,
          annotations: openBefore,
          markdown,
        });
      } catch {
        // Non-fatal plugin enricher error
      }
    }
    if (options.resolveAfterExport && res.count > 0) {
      const all = await this.annotations.list();
      this.emitEvent({
        type: "annotations-updated",
        worktreePath: wt.path,
        annotations: all,
      });
    }
    return { markdown, count: res.count };
  }

  async createWorktree(params: {
    baseWorktreePath: string;
    branchName: string;
    baseRef?: string;
    targetDir?: string;
  }): Promise<WorktreeInfo> {
    const safeBase = this.assertRegisteredWorktree(params.baseWorktreePath);
    const created = await this.git.createWorktree({ ...params, baseWorktreePath: safeBase });
    const updatedWorktrees = await this.git.discoverWorktrees(this.context.initialWorktreePath);
    this.watcher.resetWatches(updatedWorktrees, this.context.repoCommonDir);
    this.emitEvent({
      type: "worktrees-updated",
      worktrees: updatedWorktrees,
      changedWorktreePath: created.path,
    });
    return created;
  }

  async respondWalkthrough(response: WalkthroughUserResponse): Promise<void> {
    this.tourServer.respondFromUser(this.context.repoCommonDir, response);
  }

  async endWalkthrough(sessionId?: string): Promise<void> {
    this.tourServer.endFromUser(this.context.repoCommonDir, sessionId);
  }

  async sendReviewResponse(
    response: ReviewUserResponse,
  ): Promise<{ sent: boolean; count: number }> {
    const safeWt = this.assertRegisteredWorktree(response.worktreePath);

    if (response.action === "approve" || response.action === "cancel") {
      const sent = this.tourServer.respondReviewFromUser(this.context.repoCommonDir, {
        sessionId: response.sessionId,
        worktreePath: safeWt,
        action: response.action,
        count: 0,
      });
      return { sent, count: 0 };
    }

    const wts = await this.git.discoverWorktrees(this.context.initialWorktreePath);
    const wt = wts.find((w) => w.path === safeWt) ?? wts[0];
    if (!wt) {
      return { sent: false, count: 0 };
    }

    const reviewState = this.tourServer.getReviewState(
      this.context.repoCommonDir,
      safeWt,
      response.sessionId,
    );
    if (!reviewState) {
      return { sent: false, count: 0 };
    }
    const shouldResolve = response.resolveAfterSend ?? reviewState.resolveOnSend ?? true;

    const openBefore = await this.annotations.list(safeWt);
    const compiled = await this.annotations.compilePrompt(wt, {
      worktreePath: safeWt,
      includeOutdated: response.includeOutdated,
      resolveAfterExport: shouldResolve,
    });
    if (compiled.count === 0 || !compiled.markdown) {
      return { sent: false, count: 0 };
    }

    let markdown = compiled.markdown;
    if (this.pluginController) {
      try {
        markdown = await this.pluginController.enrichFeedbackPrompt({
          worktree: wt,
          annotations: openBefore,
          markdown,
        });
      } catch {
        // ignore enricher failure
      }
    }

    if (shouldResolve) {
      const all = await this.annotations.list();
      this.emitEvent({
        type: "annotations-updated",
        worktreePath: wt.path,
        annotations: all,
      });
    }

    const sent = this.tourServer.respondReviewFromUser(this.context.repoCommonDir, {
      sessionId: response.sessionId ?? reviewState.sessionId,
      worktreePath: safeWt,
      action: "feedback",
      markdown,
      count: compiled.count,
    });
    return { sent, count: compiled.count };
  }

  /* ------------------------------------------------------------------------ */
  /* Workspace-Side Plugin Operations                                         */
  /* ------------------------------------------------------------------------ */

  async listPlugins(): Promise<InstalledPluginInfo[]> {
    return this.pluginController ? this.pluginController.listPlugins() : [];
  }

  async installPlugin(params: InstallPluginParams): Promise<InstallPluginResult> {
    if (!this.pluginController) {
      return { error: "Plugin runtime is not initialized on this workspace." };
    }
    return this.pluginController.installPlugin(params);
  }

  async setPluginEnabled(params: {
    pluginId: string;
    enabled: boolean;
  }): Promise<InstalledPluginInfo[]> {
    if (!this.pluginController) return [];
    return this.pluginController.setPluginEnabled(params.pluginId, params.enabled);
  }

  async updatePlugin(params: {
    pluginId: string;
    approvePermissions?: boolean;
  }): Promise<UpdatePluginResult> {
    if (!this.pluginController) {
      return { error: "Plugin runtime is not initialized on this workspace." };
    }
    return this.pluginController.updatePlugin(params.pluginId, params.approvePermissions);
  }

  async removePlugin(params: { pluginId: string }): Promise<InstalledPluginInfo[]> {
    if (!this.pluginController) return [];
    return this.pluginController.removePlugin(params.pluginId);
  }

  async callPluginRpc(params: {
    pluginId: string;
    method: string;
    payload?: unknown;
    worktreePath?: string;
  }): Promise<unknown> {
    if (!this.pluginController) {
      throw new Error("Plugin runtime is not available.");
    }
    return this.pluginController.callPluginRpc(params);
  }

  async triggerPluginAction(params: {
    pluginId: string;
    actionId: string;
    worktreePath?: string;
    filePath?: string;
    line?: number;
  }): Promise<void> {
    if (!this.pluginController) return;
    await this.pluginController.triggerPluginAction(params);
  }

  async respondPluginCard(params: {
    sessionId: string;
    action: string;
    message?: string;
  }): Promise<void> {
    if (!this.pluginController) return;
    await this.pluginController.respondPluginCard(params);
  }

  async readPluginClientBundle(pluginId: string): Promise<string | null> {
    if (!this.pluginController) return null;
    return this.pluginController.readPluginClientBundle(pluginId);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.watcher.close();
    this.tourServer.closeRepo(this.context.repoCommonDir);
    if (this.pluginController) {
      await this.pluginController.dispose();
    }
    this.listeners.clear();
  }
}

export function selectWorktreeFromList(
  wts: readonly { path: string; name: string; branch: string }[],
  fallbackPath: string,
  worktreeQuery?: string,
  cwdHint?: string,
): string {
  if (worktreeQuery) {
    const q = worktreeQuery.trim();
    const resolvedQ = cwdHint ? resolve(cwdHint, q) : q;
    let canonQ = resolvedQ;
    try {
      canonQ = realpathSync(resolvedQ);
    } catch {
      // ignore non-path names
    }
    const matched = wts.find(
      (w) =>
        w.name === q ||
        w.branch === q ||
        w.path === q ||
        w.path === resolvedQ ||
        w.path === canonQ,
    );
    if (matched) return matched.path;
  }
  return fallbackPath;
}
