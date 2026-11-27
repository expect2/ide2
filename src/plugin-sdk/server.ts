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
  WorktreeInfo,
} from "../shared/protocol.js";

export interface PluginExecOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface PluginExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type PluginLineDecorationInput = Omit<
  PluginLineDecoration,
  "id" | "pluginId" | "pluginName"
> & {
  id?: string;
};

export interface PluginCliInvokeContext {
  worktreePath: string;
  argv: string[];
  stdin?: string;
  wait?: boolean;
  waitTimeoutMs?: number;
  presentCardAndWait(card: {
    title: string;
    markdown: string;
    choices?: PluginAgentCardChoice[];
    allowFreeformReply?: boolean;
    timeoutMs?: number;
  }): Promise<{
    status: "responded" | "waiting";
    action?: string;
    message?: string;
  }>;
}

export interface PluginServerContext {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly dataDir: string;

  getLaunchContext(): Promise<LaunchContext>;
  listWorktrees(): Promise<WorktreeInfo[]>;
  listFiles(worktreePath: string): Promise<FileEntry[]>;
  readFile(worktreePath: string, filePath: string, diffScope?: DiffScope): Promise<FileDocument>;
  getDiff(worktreePath: string, filePath: string, scope: DiffScope): Promise<FileDiffResult>;
  listChangedFiles(worktreePath: string, scope: DiffScope): Promise<ChangedFileSummary[]>;

  setDecorations(sourceKey: string, decorations: readonly PluginLineDecorationInput[]): void;
  clearDecorations(sourceKey?: string): void;

  emitClientEvent(event: string, payload?: unknown): void;

  handleRpc(
    method: string,
    handler: (payload: unknown, meta: { worktreePath?: string }) => Promise<unknown> | unknown,
  ): void;

  handleAction(
    actionId: string,
    handler: (ctx: {
      worktreePath?: string;
      filePath?: string;
      line?: number;
    }) => Promise<void> | void,
  ): void;

  registerPromptEnricher(
    handler: (ctx: {
      worktree: WorktreeInfo;
      annotations: Annotation[];
      markdown: string;
    }) => Promise<string | void> | string | void,
  ): void;

  handleCli(
    subcommand: string,
    handler: (ctx: PluginCliInvokeContext) => Promise<unknown> | unknown,
  ): void;

  onWorktreesUpdated(
    listener: (evt: {
      worktrees: WorktreeInfo[];
      changedWorktreePath?: string;
      changedFiles?: string[];
    }) => void,
  ): () => void;

  onAnnotationsUpdated(
    listener: (evt: { worktreePath: string; annotations: Annotation[] }) => void,
  ): () => void;

  readStorageJson<T = unknown>(key: string): Promise<T | null>;
  writeStorageJson(key: string, value: unknown): Promise<void>;

  /**
   * Executes an external read-only command. Requires `"exec"` in `ide2-plugin.json` permissions.
   * Automatically sets `GIT_OPTIONAL_LOCKS=0` so git invocations never contend on `.git/index.lock`.
   */
  exec(
    command: string,
    args: readonly string[],
    options?: PluginExecOptions,
  ): Promise<PluginExecResult>;
}

export type PluginServerContributeFn = (
  ctx: PluginServerContext,
) => Promise<(() => void | Promise<void>) | void> | (() => void | Promise<void>) | void;

export function defineServerPlugin(fn: PluginServerContributeFn): PluginServerContributeFn {
  return fn;
}
