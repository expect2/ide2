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
  FindInPathQuery,
  FuzzyFileHit,
  InstalledPluginInfo,
  InstallPluginParams,
  InstallPluginResult,
  LaunchContext,
  LineBlame,
  PluginAgentCardState,
  PluginLineDecoration,
  RemoteConnectionState,
  ReviewSessionState,
  ReviewUserResponse,
  SearchMatch,
  UpdateAnnotationInput,
  UpdatePluginResult,
  WalkthroughState,
  WalkthroughUserResponse,
  WorkspaceEvent,
  WorktreeInfo,
} from "../../shared/protocol.js";

export interface BootstrapSnapshot {
  context: LaunchContext;
  worktrees: WorktreeInfo[];
  annotations: Annotation[];
  walkthroughs: WalkthroughState[];
  reviews: ReviewSessionState[];
  connection: RemoteConnectionState;
  plugins: InstalledPluginInfo[];
  pluginDecorations: PluginLineDecoration[];
  pluginCards: PluginAgentCardState[];
}

/**
 * Pure runtime-agnostic interface implemented identically by:
 * 1. `LocalWorkspaceBackend` (in-process on local repos, or inside `ide2 daemon --stdio` on a remote host)
 * 2. `SshWorkspaceBackend` (JSON-RPC proxy over `ssh` stdio on your laptop)
 */
export interface WorkspaceBackend {
  readonly isRemote: boolean;
  getLaunchContext(): LaunchContext;
  getConnectionState(): RemoteConnectionState;

  getBootstrapSnapshot(overrides?: {
    initialWorktreePath?: string;
    initialFilePath?: string;
    initialLine?: number;
    initialColumn?: number;
    initialDiffMode?: boolean;
    initialBaseRef?: string;
  }): Promise<BootstrapSnapshot>;

  selectWorktreePath(query?: string, cwdHint?: string): Promise<string>;
  listCachedWorktrees(): WorktreeInfo[];
  discoverWorktrees(): Promise<WorktreeInfo[]>;

  listFiles(worktreePath: string): Promise<FileEntry[]>;
  fuzzyFindFiles(params: {
    worktreePath: string;
    query: string;
    allWorktrees?: boolean;
    limit?: number;
  }): Promise<FuzzyFileHit[]>;
  readFile(worktreePath: string, filePath: string, diffScope?: DiffScope): Promise<FileDocument>;
  readAssetDataUrl(
    worktreePath: string,
    relativeFromFile: string,
    rawHref: string,
  ): Promise<string | null>;
  getDiff(worktreePath: string, filePath: string, scope: DiffScope): Promise<FileDiffResult>;
  listChangedFiles(worktreePath: string, scope: DiffScope): Promise<ChangedFileSummary[]>;
  listCommits(worktreePath: string, limit?: number): Promise<CommitEntry[]>;
  getBlame(worktreePath: string, filePath: string): Promise<LineBlame[]>;
  getStructure(worktreePath: string, filePath: string): Promise<CodeSymbol[]>;
  searchSymbols(params: {
    worktreePath: string;
    query: string;
    allWorktrees?: boolean;
    limit?: number;
  }): Promise<CodeSymbol[]>;
  findDefinitionAndUsages(params: {
    worktreePath: string;
    filePath: string;
    symbolName: string;
    line: number;
  }): Promise<{ definitions: SearchMatch[]; usages: SearchMatch[] }>;
  findInPath(query: FindInPathQuery): Promise<SearchMatch[]>;

  listAnnotations(worktreePath?: string): Promise<Annotation[]>;
  createAnnotation(input: CreateAnnotationInput): Promise<Annotation>;
  updateAnnotation(input: UpdateAnnotationInput): Promise<Annotation>;
  deleteAnnotation(id: string): Promise<void>;
  compileFeedbackPrompt(options: ExportPromptOptions): Promise<{ markdown: string; count: number }>;

  createWorktree(params: {
    baseWorktreePath: string;
    branchName: string;
    baseRef?: string;
    targetDir?: string;
  }): Promise<WorktreeInfo>;

  respondWalkthrough(response: WalkthroughUserResponse): Promise<void>;
  endWalkthrough(sessionId?: string): Promise<void>;
  sendReviewResponse(response: ReviewUserResponse): Promise<{ sent: boolean; count: number }>;

  // Workspace-side plugin management & execution (for `"host": "workspace"` on remote, or all plugins when standalone)
  listPlugins(): Promise<InstalledPluginInfo[]>;
  installPlugin(params: InstallPluginParams): Promise<InstallPluginResult>;
  setPluginEnabled(params: { pluginId: string; enabled: boolean }): Promise<InstalledPluginInfo[]>;
  updatePlugin(params: {
    pluginId: string;
    approvePermissions?: boolean;
  }): Promise<UpdatePluginResult>;
  removePlugin(params: { pluginId: string }): Promise<InstalledPluginInfo[]>;
  callPluginRpc(params: {
    pluginId: string;
    method: string;
    payload?: unknown;
    worktreePath?: string;
  }): Promise<unknown>;
  triggerPluginAction(params: {
    pluginId: string;
    actionId: string;
    worktreePath?: string;
    filePath?: string;
    line?: number;
  }): Promise<void>;
  respondPluginCard(params: {
    sessionId: string;
    action: string;
    message?: string;
  }): Promise<void>;
  readPluginClientBundle(pluginId: string): Promise<string | null>;

  onEvent(listener: (event: WorkspaceEvent) => void): () => void;
  dispose(): Promise<void>;
}

/**
 * Pluggable controller interface implemented by `PluginHost` so `LocalWorkspaceBackend`
 * and Electron Main can attach plugin support cleanly without circular dependencies.
 */
export interface PluginRuntimeController {
  listPlugins(): Promise<InstalledPluginInfo[]>;
  getDecorations(): PluginLineDecoration[];
  getCards(): PluginAgentCardState[];
  enrichFeedbackPrompt(params: {
    worktree: WorktreeInfo;
    annotations: Annotation[];
    markdown: string;
  }): Promise<string>;
  installPlugin(params: InstallPluginParams): Promise<InstallPluginResult>;
  setPluginEnabled(pluginId: string, enabled: boolean): Promise<InstalledPluginInfo[]>;
  updatePlugin(pluginId: string, approvePermissions?: boolean): Promise<UpdatePluginResult>;
  removePlugin(pluginId: string): Promise<InstalledPluginInfo[]>;
  callPluginRpc(params: {
    pluginId: string;
    method: string;
    payload?: unknown;
    worktreePath?: string;
  }): Promise<unknown>;
  triggerPluginAction(params: {
    pluginId: string;
    actionId: string;
    worktreePath?: string;
    filePath?: string;
    line?: number;
  }): Promise<void>;
  respondPluginCard(params: {
    sessionId: string;
    action: string;
    message?: string;
  }): Promise<boolean>;
  handleAgentCli(params: {
    worktreePath: string;
    subcommand: string;
    argv: string[];
    stdin?: string;
    wait?: boolean;
    waitTimeoutMs?: number;
  }): Promise<unknown>;
  readPluginClientBundle(pluginId: string): Promise<string | null>;
  dispose(): Promise<void>;
}
