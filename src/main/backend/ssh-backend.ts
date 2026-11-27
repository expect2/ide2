import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { IntelClient } from "../intel/client.js";
import { StdioRpcPeer } from "../../shared/rpc-stdio.js";
import {
  parseSshTarget,
  type Annotation,
  type ChangedFileSummary,
  type CodeSymbol,
  type CommitEntry,
  type CreateAnnotationInput,
  type DiffScope,
  type ExportPromptOptions,
  type FileDiffResult,
  type FileDocument,
  type FileEntry,
  type FindInPathQuery,
  type FuzzyFileHit,
  type InstalledPluginInfo,
  type InstallPluginParams,
  type InstallPluginResult,
  type LaunchContext,
  type LineBlame,
  type ParsedSshTarget,
  type RemoteConnectionState,
  type ReviewUserResponse,
  type SearchMatch,
  type TokenSpan,
  type UpdateAnnotationInput,
  type UpdatePluginResult,
  type WalkthroughUserResponse,
  type WorkspaceEvent,
  type WorktreeInfo,
} from "../../shared/protocol.js";
import type { BootstrapSnapshot, WorkspaceBackend } from "./workspace-backend.js";

export const NEEDS_BOOTSTRAP_SENTINEL = "@@IDE2_NEEDS_BOOTSTRAP@@";

export class RemoteBootstrapRequiredError extends Error {
  readonly needsBootstrap = true;
  readonly sshTarget: string;

  constructor(sshTarget: string, message?: string) {
    super(
      message ??
        `Remote host "${sshTarget}" does not have the ide2 headless daemon installed yet.`,
    );
    this.name = "RemoteBootstrapRequiredError";
    this.sshTarget = sshTarget;
  }
}

export interface CreateSshBackendOptions {
  appRoot: string;
  sshTarget: string;
  sshOptions?: string;
  worktree?: string;
  diff?: boolean;
  base?: string;
  autoBootstrap?: boolean;
  deferOnBootstrapNeeded?: boolean;
  localIntel?: IntelClient;
}

function splitShellWords(raw?: string): string[] {
  if (!raw || !raw.trim()) return [];
  const tokens: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur.length > 0) {
        tokens.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) tokens.push(cur);
  return tokens;
}

function posixSingleQuote(val: string): string {
  return `'${val.replace(/'/g, `'\\''`)}'`;
}

/**
 * Remote SSH Workspace Backend (`ide2 ssh user@host:/path/to/repo`).
 *
 * - Spawns `ssh` and speaks NDJSON RPC (`StdioRpcPeer`) to `ide2 daemon --stdio` on the remote host.
 * - Supports One-Click Automatic Remote Bootstrap (`bootstrapRemoteRuntime`), streaming a
 *   ~350 KB zero-native-dependency headless bundle into `~/.expect2-ide/remote-runtime/<version>/`.
 * - Measures live SSH RTT (`__ping`) and auto-reconnects with exponential backoff on network drops.
 * - Uses local `IntelClient` (Shiki + Tree-sitter WASM) on your laptop whenever the remote host
 *   is running the minimal zero-dep bootstrap bundle!
 */
export class SshWorkspaceBackend implements WorkspaceBackend {
  readonly isRemote = true;

  private readonly parsedTarget: ParsedSshTarget;
  private readonly appRoot: string;
  private readonly appVersion: string;
  private readonly sshBin: string;
  private readonly sshExtraArgs: string[];
  private readonly localIntel?: IntelClient;
  private readonly initialFlags: {
    worktree?: string;
    diff?: boolean;
    base?: string;
  };

  private child: ChildProcessWithoutNullStreams | null = null;
  private peer: StdioRpcPeer | null = null;
  private context: LaunchContext;
  private cachedWorktrees: WorktreeInfo[] = [];
  private connectionState: RemoteConnectionState;
  private readonly listeners = new Set<(event: WorkspaceEvent) => void>();
  private readonly localAnalysisCache = new Map<
    string,
    { tokens: TokenSpan[][]; symbols: CodeSymbol[] }
  >();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private connectInFlight: Promise<void> | null = null;
  private disposed = false;

  private constructor(opts: CreateSshBackendOptions, parsed: ParsedSshTarget, appVersion: string) {
    this.appRoot = opts.appRoot;
    this.appVersion = appVersion;
    this.parsedTarget = parsed;
    this.sshBin = process.env.IDE2_SSH_BIN || "ssh";
    this.sshExtraArgs = [
      ...(parsed.port ? ["-p", String(parsed.port)] : []),
      ...splitShellWords(opts.sshOptions),
    ];
    this.localIntel = opts.localIntel;
    this.initialFlags = {
      worktree: opts.worktree,
      diff: opts.diff,
      base: opts.base,
    };

    const fallbackName =
      parsed.remotePath.replace(/\/+$/, "").split("/").pop() || parsed.host;
    this.context = {
      repoCommonDir: parsed.uri,
      repoName: fallbackName,
      initialWorktreePath: parsed.remotePath,
      initialLine: parsed.line,
      initialColumn: parsed.column,
      initialDiffMode: Boolean(opts.diff),
      initialBaseRef: opts.base,
      sshTarget: parsed.canonicalTarget,
      sshHost: parsed.host,
      platform: process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux",
    };

    this.connectionState = {
      isRemote: true,
      status: "connecting",
      sshTarget: parsed.canonicalTarget,
      sshHost: parsed.host,
      sshPort: parsed.port,
      sshOptions: opts.sshOptions,
      remotePath: parsed.remotePath,
    };
  }

  static async create(opts: CreateSshBackendOptions): Promise<SshWorkspaceBackend> {
    const parsed = parseSshTarget(opts.sshTarget);
    const appVersion = (() => {
      try {
        const pkg = JSON.parse(
          readFileSync(resolve(opts.appRoot, "package.json"), "utf8"),
        ) as { version?: string };
        return pkg.version ?? "0.1.0";
      } catch {
        return "0.1.0";
      }
    })();

    const instance = new SshWorkspaceBackend(opts, parsed, appVersion);
    try {
      await instance.connect({ allowAutoBootstrap: Boolean(opts.autoBootstrap) });
    } catch (err) {
      if (err instanceof RemoteBootstrapRequiredError && opts.deferOnBootstrapNeeded) {
        return instance;
      }
      await instance.dispose();
      throw err;
    }
    return instance;
  }

  getLaunchContext(): LaunchContext {
    return this.context;
  }

  getConnectionState(): RemoteConnectionState {
    return { ...this.connectionState };
  }

  private updateConnectionState(patch: Partial<RemoteConnectionState>): void {
    this.connectionState = {
      ...this.connectionState,
      ...patch,
    };
    this.emitEvent({
      type: "connection-updated",
      connection: this.getConnectionState(),
    });
  }

  private emitEvent(event: WorkspaceEvent): void {
    if (this.disposed) return;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // ignore
      }
    }
  }

  onEvent(listener: (event: WorkspaceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private buildSshBaseArgs(): string[] {
    return [
      "-T",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      ...this.sshExtraArgs,
      this.parsedTarget.host,
    ];
  }

  private buildRemoteLaunchCommand(): string {
    const remoteTargetExpr =
      this.parsedTarget.remotePath === "~"
        ? '"$HOME"'
        : this.parsedTarget.remotePath.startsWith("~/")
          ? `"$HOME"/${posixSingleQuote(this.parsedTarget.remotePath.slice(2))}`
          : posixSingleQuote(this.parsedTarget.remotePath);

    const extraArgs: string[] = ["--stdio", "--cwd", remoteTargetExpr];
    if (this.initialFlags.worktree) {
      extraArgs.push("--worktree", posixSingleQuote(this.initialFlags.worktree));
    }
    if (this.initialFlags.diff) {
      extraArgs.push("--diff");
    }
    if (this.initialFlags.base) {
      extraArgs.push("--base", posixSingleQuote(this.initialFlags.base));
    }
    const argTail = extraArgs.join(" ");

    const runtimeBin = `"$HOME/.expect2-ide/remote-runtime/${this.appVersion}/bin/ide2"`;
    const script = [
      `if [ -n "$IDE2_REMOTE_BIN" ] && [ -x "$IDE2_REMOTE_BIN" ]; then exec "$IDE2_REMOTE_BIN" daemon ${argTail};`,
      `elif [ -x ${runtimeBin} ]; then exec ${runtimeBin} daemon ${argTail};`,
      `elif command -v ide2 >/dev/null 2>&1; then exec ide2 daemon ${argTail};`,
      `else printf '%s\\n' '${NEEDS_BOOTSTRAP_SENTINEL}'; exit 42; fi`,
    ].join(" ");

    return `sh -lc ${posixSingleQuote(script)}`;
  }

  /**
   * Streams a lightweight (~350 KB), architecture-independent headless `ide2` runtime
   * into `~/.expect2-ide/remote-runtime/<version>/` on the SSH host in a single round-trip.
   */
  async bootstrapRemoteRuntime(): Promise<void> {
    this.updateConnectionState({
      status: "bootstrapping",
      needsBootstrap: false,
      error: undefined,
    });

    const stageRoot = mkdtempSync(join(tmpdir(), "ide2-remote-bootstrap-"));
    const payloadDir = join(stageRoot, "payload");
    const archivePath = join(stageRoot, "runtime.tar.gz");

    try {
      mkdirSync(join(payloadDir, "bin"), { recursive: true });
      mkdirSync(join(payloadDir, "dist/cli"), { recursive: true });
      mkdirSync(join(payloadDir, "dist/main"), { recursive: true });

      copyFileSync(resolve(this.appRoot, "package.json"), join(payloadDir, "package.json"));
      copyFileSync(resolve(this.appRoot, "bin/ide2.mjs"), join(payloadDir, "bin/ide2.mjs"));

      // Write POSIX `bin/ide2` launcher so remote shells & daemon exec it directly
      const wrapperScript = [
        "#!/usr/bin/env sh",
        'DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"',
        'exec node "$DIR/bin/ide2.mjs" "$@"',
        "",
      ].join("\n");
      const binIde2 = join(payloadDir, "bin/ide2");
      writeFileSync(binIde2, wrapperScript, { mode: 0o755 });

      const requiredFiles: Array<[string, string]> = [
        ["dist/cli/daemon.cjs", "dist/cli/daemon.cjs"],
        ["dist/cli/tour.cjs", "dist/cli/tour.cjs"],
        ["dist/cli/export.cjs", "dist/cli/export.cjs"],
      ];
      for (const [srcRel, dstRel] of requiredFiles) {
        const absSrc = resolve(this.appRoot, srcRel);
        if (existsSync(absSrc)) {
          copyFileSync(absSrc, join(payloadDir, dstRel));
        }
      }

      const optionalFiles: Array<[string, string]> = [
        ["dist/main/plugin-runner.cjs", "dist/main/plugin-runner.cjs"],
        ["dist/main/worker.cjs", "dist/main/worker.cjs"],
      ];
      for (const [srcRel, dstRel] of optionalFiles) {
        const absSrc = resolve(this.appRoot, srcRel);
        if (existsSync(absSrc)) {
          copyFileSync(absSrc, join(payloadDir, dstRel));
        }
      }

      execFileSync("tar", ["-czf", archivePath, "-C", payloadDir, "."], {
        stdio: "ignore",
      });
      const archiveBytes = readFileSync(archivePath);

      const remoteInstallScript = [
        "set -e",
        "command -v node >/dev/null 2>&1 || { echo 'Node.js (>=18) is required on the remote host.' >&2; exit 12; }",
        `DEST="$HOME/.expect2-ide/remote-runtime/${this.appVersion}"`,
        'mkdir -p "$DEST" "$HOME/.local/bin"',
        'tar -xzf - -C "$DEST"',
        'chmod +x "$DEST/bin/ide2" "$DEST/bin/ide2.mjs"',
        'if [ ! -e "$HOME/.local/bin/ide2" ] || [ -L "$HOME/.local/bin/ide2" ]; then ln -sf "$DEST/bin/ide2" "$HOME/.local/bin/ide2" 2>/dev/null || true; fi',
      ].join("; ");

      await new Promise<void>((resolveInstall, rejectInstall) => {
        const sshArgs = [
          ...this.buildSshBaseArgs(),
          `sh -lc ${posixSingleQuote(remoteInstallScript)}`,
        ];
        const proc = spawn(this.sshBin, sshArgs, {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stderr = "";
        proc.stderr.setEncoding("utf8");
        proc.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        proc.on("error", (err) => rejectInstall(err));
        proc.on("close", (code) => {
          if (code === 0) {
            resolveInstall();
          } else {
            rejectInstall(
              new Error(
                `Remote bootstrap failed (exit ${code ?? "signal"}): ${stderr.trim() || "SSH error"}`,
              ),
            );
          }
        });
        proc.stdin.end(archiveBytes);
      });
    } finally {
      rmSync(stageRoot, { recursive: true, force: true });
    }
  }

  async bootstrapAndConnect(): Promise<void> {
    await this.bootstrapRemoteRuntime();
    await this.connect({ allowAutoBootstrap: false });
  }

  async reconnectNow(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardownActiveProcess();
    await this.connect({ allowAutoBootstrap: false });
  }

  private async connect(opts: { allowAutoBootstrap: boolean }): Promise<void> {
    if (this.connectInFlight) return this.connectInFlight;

    const run = (async () => {
      this.updateConnectionState({
        status: this.reconnectAttempt > 0 ? "reconnecting" : "connecting",
        error: undefined,
      });

      const sshArgs = [...this.buildSshBaseArgs(), this.buildRemoteLaunchCommand()];
      const child = spawn(this.sshBin, sshArgs, {
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;

      let stderrBuf = "";
      let needsBootstrapDetected = false;
      let childExitCode: number | null = null;
      const childExitedPromise = new Promise<number | null>((resExit) => {
        child.once("exit", (code) => {
          childExitCode = code;
          resExit(code);
        });
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderrBuf = (stderrBuf + chunk).slice(-4096);
      });

      const peer = new StdioRpcPeer(child.stdout, child.stdin, {
        role: "client",
        onNonProtocolLine: (line) => {
          if (line.includes(NEEDS_BOOTSTRAP_SENTINEL)) {
            needsBootstrapDetected = true;
          }
        },
      });
      this.peer = peer;

      const exitBeforeHandshake = new Promise<never>((_res, rej) => {
        void childExitedPromise.then((code) => {
          if (needsBootstrapDetected || code === 42) {
            rej(new RemoteBootstrapRequiredError(this.parsedTarget.canonicalTarget));
          } else {
            rej(
              new Error(
                stderrBuf.trim() ||
                  `SSH connection to ${this.parsedTarget.host} exited with code ${code ?? "unknown"}.`,
              ),
            );
          }
        });
        child.once("error", (err) => rej(err));
      });

      try {
        const t0 = performance.now();
        await Promise.race([peer.waitForHandshake(20000), exitBeforeHandshake]);
        const rttMs = Math.max(1, Math.round(performance.now() - t0));

        const snap = await peer.call<BootstrapSnapshot>("getBootstrapSnapshot", {
          initialLine: this.parsedTarget.line,
          initialColumn: this.parsedTarget.column,
          initialDiffMode: this.initialFlags.diff,
          initialBaseRef: this.initialFlags.base,
        });

        this.context = {
          ...snap.context,
          initialLine: this.parsedTarget.line ?? snap.context.initialLine,
          initialColumn: this.parsedTarget.column ?? snap.context.initialColumn,
          sshTarget: this.parsedTarget.canonicalTarget,
          sshHost: this.parsedTarget.host,
          platform:
            process.platform === "darwin"
              ? "darwin"
              : process.platform === "win32"
                ? "win32"
                : "linux",
        };
        this.cachedWorktrees = snap.worktrees;
        const wasReconnect = this.reconnectAttempt > 0;
        this.reconnectAttempt = 0;

        this.updateConnectionState({
          status: "connected",
          rttMs,
          needsBootstrap: false,
          error: undefined,
        });

        peer.onEvent((rawEvt) => {
          const evt = rawEvt as WorkspaceEvent;
          if (evt.type === "worktrees-updated") {
            this.cachedWorktrees = evt.worktrees;
          }
          this.emitEvent(evt);
        });

        peer.onClose(() => {
          if (this.peer !== peer || this.disposed) return;
          this.stopPingLoop();
          this.scheduleReconnect(stderrBuf.trim() || "SSH connection lost");
        });

        this.startPingLoop();

        if (wasReconnect) {
          this.emitEvent({
            type: "worktrees-updated",
            worktrees: snap.worktrees,
          });
          this.emitEvent({
            type: "annotations-updated",
            worktreePath: this.context.initialWorktreePath,
            annotations: snap.annotations,
          });
          this.emitEvent({
            type: "walkthrough-updated",
            walkthroughs: snap.walkthroughs,
          });
          this.emitEvent({
            type: "review-updated",
            reviews: snap.reviews,
          });
        }
      } catch (err) {
        if (childExitCode === null) {
          await Promise.race([
            childExitedPromise,
            new Promise((r) => setTimeout(r, 80)),
          ]);
        }
        const normalizedErr =
          err instanceof RemoteBootstrapRequiredError ||
          needsBootstrapDetected ||
          childExitCode === 42
            ? new RemoteBootstrapRequiredError(this.parsedTarget.canonicalTarget)
            : err;

        this.teardownActiveProcess();
        if (normalizedErr instanceof RemoteBootstrapRequiredError) {
          if (opts.allowAutoBootstrap) {
            await this.bootstrapRemoteRuntime();
            this.connectInFlight = null;
            await this.connect({ allowAutoBootstrap: false });
            return;
          }
          this.updateConnectionState({
            status: "error",
            needsBootstrap: true,
            error: normalizedErr.message,
          });
          throw normalizedErr;
        }

        const finalErr =
          stderrBuf.trim() &&
          normalizedErr instanceof Error &&
          normalizedErr.message === "RPC stream ended"
            ? new Error(stderrBuf.trim())
            : normalizedErr;

        this.updateConnectionState({
          status: "error",
          error: finalErr instanceof Error ? finalErr.message : String(finalErr),
        });
        throw finalErr;
      }
    })();

    this.connectInFlight = run;
    try {
      await run;
    } finally {
      if (this.connectInFlight === run) {
        this.connectInFlight = null;
      }
    }
  }

  private startPingLoop(): void {
    this.stopPingLoop();
    this.pingTimer = setInterval(() => {
      if (!this.peer || this.disposed) return;
      const t0 = performance.now();
      void this.peer
        .call("__ping", undefined, 8000)
        .then(() => {
          const rttMs = Math.max(1, Math.round(performance.now() - t0));
          if (this.connectionState.status === "connected") {
            this.updateConnectionState({ rttMs });
          }
        })
        .catch(() => {
          // Peer close/timeout handler triggers reconnect
        });
    }, 12000);
  }

  private stopPingLoop(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.disposed || this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    const delayMs = Math.min(15000, 1000 * Math.pow(1.6, Math.min(this.reconnectAttempt - 1, 6)));
    this.updateConnectionState({
      status: "reconnecting",
      error: `${reason} — reconnecting…`,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed) return;
      void this.connect({ allowAutoBootstrap: false }).catch((err) => {
        if (!this.disposed) {
          this.scheduleReconnect(err instanceof Error ? err.message : String(err));
        }
      });
    }, delayMs);
  }

  private teardownActiveProcess(): void {
    this.stopPingLoop();
    const p = this.peer;
    this.peer = null;
    p?.dispose();
    const c = this.child;
    this.child = null;
    if (c && !c.killed) {
      try {
        c.kill();
      } catch {
        // ignore
      }
    }
  }

  private requirePeer(): StdioRpcPeer {
    if (!this.peer) {
      throw new Error(
        this.connectionState.error ??
          `SSH session to ${this.parsedTarget.host} is currently disconnected.`,
      );
    }
    return this.peer;
  }

  async selectWorktreePath(query?: string): Promise<string> {
    const wts =
      this.cachedWorktrees.length > 0 ? this.cachedWorktrees : await this.discoverWorktrees();
    if (query) {
      const q = query.trim();
      const hit = wts.find((w) => w.name === q || w.branch === q || w.path === q);
      if (hit) return hit.path;
    }
    return this.context.initialWorktreePath;
  }

  listCachedWorktrees(): WorktreeInfo[] {
    return this.cachedWorktrees;
  }

  async discoverWorktrees(): Promise<WorktreeInfo[]> {
    const snap = await this.getBootstrapSnapshot();
    this.cachedWorktrees = snap.worktrees;
    return snap.worktrees;
  }

  async getBootstrapSnapshot(overrides?: {
    initialWorktreePath?: string;
    initialFilePath?: string;
    initialLine?: number;
    initialColumn?: number;
    initialDiffMode?: boolean;
    initialBaseRef?: string;
  }): Promise<BootstrapSnapshot> {
    if (!this.peer && this.connectionState.needsBootstrap) {
      return {
        context: this.context,
        worktrees: [],
        annotations: [],
        walkthroughs: [],
        reviews: [],
        connection: this.getConnectionState(),
        plugins: [],
        pluginDecorations: [],
        pluginCards: [],
      };
    }
    const snap = await this.requirePeer().call<BootstrapSnapshot>(
      "getBootstrapSnapshot",
      overrides,
    );
    this.cachedWorktrees = snap.worktrees;
    return {
      ...snap,
      context: {
        ...snap.context,
        sshTarget: this.parsedTarget.canonicalTarget,
        sshHost: this.parsedTarget.host,
        platform: this.context.platform,
      },
      connection: this.getConnectionState(),
    };
  }

  async listFiles(worktreePath: string): Promise<FileEntry[]> {
    return this.requirePeer().call<FileEntry[]>("listFiles", { worktreePath });
  }

  async fuzzyFindFiles(params: {
    worktreePath: string;
    query: string;
    allWorktrees?: boolean;
    limit?: number;
  }): Promise<FuzzyFileHit[]> {
    return this.requirePeer().call<FuzzyFileHit[]>("fuzzyFindFiles", params);
  }

  async readFile(
    worktreePath: string,
    filePath: string,
    diffScope?: DiffScope,
  ): Promise<FileDocument> {
    const doc = await this.requirePeer().call<FileDocument>("readFile", {
      worktreePath,
      filePath,
      diffScope,
    });
    if (doc.isBinary || !this.localIntel) return doc;

    // Enhance minimal remote-bootstrap files locally using our laptop's Shiki + Tree-sitter worker!
    const cacheKey = `${doc.language}:${doc.contentHash}`;
    const cached = this.localAnalysisCache.get(cacheKey);
    if (cached) {
      return { ...doc, tokens: cached.tokens };
    }

    const rawContent = doc.lines.join("\n");
    void this.localIntel
      .analyzeFile(worktreePath, filePath, doc.contentHash, rawContent, doc.language)
      .then((analyzed) => {
        if (this.disposed) return;
        if (this.localAnalysisCache.size > 150) {
          const oldest = this.localAnalysisCache.keys().next().value;
          if (oldest) this.localAnalysisCache.delete(oldest);
        }
        this.localAnalysisCache.set(cacheKey, {
          tokens: analyzed.tokens,
          symbols: analyzed.symbols,
        });
        this.emitEvent({
          type: "tokens-ready",
          worktreePath,
          filePath,
          contentHash: doc.contentHash,
          tokens: analyzed.tokens,
          symbols: analyzed.symbols,
        });
      })
      .catch(() => {
        // non-fatal
      });

    return doc;
  }

  async readAssetDataUrl(
    worktreePath: string,
    relativeFromFile: string,
    rawHref: string,
  ): Promise<string | null> {
    return this.requirePeer().call<string | null>("readAssetDataUrl", {
      worktreePath,
      relativeFromFile,
      rawHref,
    });
  }

  async getDiff(
    worktreePath: string,
    filePath: string,
    scope: DiffScope,
  ): Promise<FileDiffResult> {
    return this.requirePeer().call<FileDiffResult>("getDiff", { worktreePath, filePath, scope });
  }

  async listChangedFiles(worktreePath: string, scope: DiffScope): Promise<ChangedFileSummary[]> {
    return this.requirePeer().call<ChangedFileSummary[]>("listChangedFiles", {
      worktreePath,
      scope,
    });
  }

  async listCommits(worktreePath: string, limit?: number): Promise<CommitEntry[]> {
    return this.requirePeer().call<CommitEntry[]>("listCommits", { worktreePath, limit });
  }

  async getBlame(worktreePath: string, filePath: string): Promise<LineBlame[]> {
    return this.requirePeer().call<LineBlame[]>("getBlame", { worktreePath, filePath });
  }

  async getStructure(worktreePath: string, filePath: string): Promise<CodeSymbol[]> {
    const remoteSymbols = await this.requirePeer().call<CodeSymbol[]>("getStructure", {
      worktreePath,
      filePath,
    });
    if (remoteSymbols.length > 0 || !this.localIntel) return remoteSymbols;
    const doc = await this.readFile(worktreePath, filePath);
    if (doc.isBinary) return [];
    const cacheKey = `${doc.language}:${doc.contentHash}`;
    const cached = this.localAnalysisCache.get(cacheKey);
    if (cached && cached.symbols.length > 0) return cached.symbols;
    return this.localIntel.getStructure(worktreePath, filePath, doc.lines.join("\n"));
  }

  async searchSymbols(params: {
    worktreePath: string;
    query: string;
    allWorktrees?: boolean;
    limit?: number;
  }): Promise<CodeSymbol[]> {
    return this.requirePeer().call<CodeSymbol[]>("searchSymbols", params);
  }

  async findDefinitionAndUsages(params: {
    worktreePath: string;
    filePath: string;
    symbolName: string;
    line: number;
  }): Promise<{ definitions: SearchMatch[]; usages: SearchMatch[] }> {
    return this.requirePeer().call<{ definitions: SearchMatch[]; usages: SearchMatch[] }>(
      "findDefinitionAndUsages",
      params,
    );
  }

  async findInPath(query: FindInPathQuery): Promise<SearchMatch[]> {
    return this.requirePeer().call<SearchMatch[]>("findInPath", query);
  }

  async listAnnotations(worktreePath?: string): Promise<Annotation[]> {
    return this.requirePeer().call<Annotation[]>("listAnnotations", { worktreePath });
  }

  async createAnnotation(input: CreateAnnotationInput): Promise<Annotation> {
    return this.requirePeer().call<Annotation>("createAnnotation", input);
  }

  async updateAnnotation(input: UpdateAnnotationInput): Promise<Annotation> {
    return this.requirePeer().call<Annotation>("updateAnnotation", input);
  }

  async deleteAnnotation(id: string): Promise<void> {
    await this.requirePeer().call<void>("deleteAnnotation", { id });
  }

  async compileFeedbackPrompt(
    options: ExportPromptOptions,
  ): Promise<{ markdown: string; count: number }> {
    return this.requirePeer().call<{ markdown: string; count: number }>(
      "compileFeedbackPrompt",
      options,
    );
  }

  async createWorktree(params: {
    baseWorktreePath: string;
    branchName: string;
    baseRef?: string;
    targetDir?: string;
  }): Promise<WorktreeInfo> {
    return this.requirePeer().call<WorktreeInfo>("createWorktree", params);
  }

  async respondWalkthrough(response: WalkthroughUserResponse): Promise<void> {
    await this.requirePeer().call<void>("respondWalkthrough", response);
  }

  async endWalkthrough(sessionId?: string): Promise<void> {
    await this.requirePeer().call<void>("endWalkthrough", { sessionId });
  }

  async sendReviewResponse(
    response: ReviewUserResponse,
  ): Promise<{ sent: boolean; count: number }> {
    return this.requirePeer().call<{ sent: boolean; count: number }>(
      "sendReviewResponse",
      response,
    );
  }

  async listPlugins(): Promise<InstalledPluginInfo[]> {
    return this.requirePeer().call<InstalledPluginInfo[]>("listPlugins");
  }

  async installPlugin(params: InstallPluginParams): Promise<InstallPluginResult> {
    return this.requirePeer().call<InstallPluginResult>("installPlugin", params, 120000);
  }

  async setPluginEnabled(params: {
    pluginId: string;
    enabled: boolean;
  }): Promise<InstalledPluginInfo[]> {
    return this.requirePeer().call<InstalledPluginInfo[]>("setPluginEnabled", params);
  }

  async updatePlugin(params: {
    pluginId: string;
    approvePermissions?: boolean;
  }): Promise<UpdatePluginResult> {
    return this.requirePeer().call<UpdatePluginResult>("updatePlugin", params, 120000);
  }

  async removePlugin(params: { pluginId: string }): Promise<InstalledPluginInfo[]> {
    return this.requirePeer().call<InstalledPluginInfo[]>("removePlugin", params);
  }

  async callPluginRpc(params: {
    pluginId: string;
    method: string;
    payload?: unknown;
    worktreePath?: string;
  }): Promise<unknown> {
    return this.requirePeer().call<unknown>("callPluginRpc", params);
  }

  async triggerPluginAction(params: {
    pluginId: string;
    actionId: string;
    worktreePath?: string;
    filePath?: string;
    line?: number;
  }): Promise<void> {
    await this.requirePeer().call<void>("triggerPluginAction", params);
  }

  async respondPluginCard(params: {
    sessionId: string;
    action: string;
    message?: string;
  }): Promise<void> {
    await this.requirePeer().call<void>("respondPluginCard", params);
  }

  async readPluginClientBundle(pluginId: string): Promise<string | null> {
    return this.requirePeer().call<string | null>("readPluginClientBundle", { pluginId });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardownActiveProcess();
    this.listeners.clear();
  }
}
