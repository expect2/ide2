import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  protocol,
  shell,
  type WebContents,
} from "electron";
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { IntelClient } from "./intel/client.js";
import { AnnotationStore } from "./services/annotations.js";
import { resolveRepoContext, WorktreeService } from "./services/git.js";
import { RecentProjectsStore } from "./services/recent-projects.js";
import { TourServer } from "./services/tour-server.js";
import { MultiWorktreeWatcher } from "./services/watcher.js";
import { buildWalkthroughAgentPrompt } from "../shared/walkthrough-prompt.js";
import type {
  CodeSymbol,
  CreateAnnotationInput,
  DiffScope,
  ExportPromptOptions,
  FileGitStatus,
  FindInPathQuery,
  LaunchContext,
  OpenProjectResult,
  TokenSpan,
  UpdateAnnotationInput,
  WalkthroughUserResponse,
  WorkspaceEvent,
} from "../shared/protocol.js";

const DIST_ROOT = resolve(app.getAppPath(), "dist");
const RENDERER_ROOT = resolve(DIST_ROOT, "renderer");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "ide2",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function registerRendererProtocol(): void {
  const canonRendererRoot = realpathSync(RENDERER_ROOT);
  protocol.handle("ide2", (request) => {
    try {
      const url = new URL(request.url);
      let reqPath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      if (!reqPath) reqPath = "index.html";
      const candidate = resolve(canonRendererRoot, reqPath);
      const canonTarget = realpathSync(candidate);
      const rel = relative(canonRendererRoot, canonTarget);
      if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        return new Response("Forbidden", { status: 403 });
      }
      if (!statSync(canonTarget).isFile()) {
        return new Response("Not Found", { status: 404 });
      }
      const ext = extname(canonTarget).toLowerCase();
      const mime = STATIC_MIME[ext] ?? "application/octet-stream";
      const body = readFileSync(canonTarget);
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": mime },
      });
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  });
}

interface ParsedProcessFlags {
  cwd: string;
  target: string;
  diff: boolean;
  base?: string;
  worktree?: string;
}

function parseFlags(argv: readonly string[], fallbackCwd: string): ParsedProcessFlags {
  let cwd = fallbackCwd;
  let target: string | undefined;
  let diff = false;
  let base: string | undefined;
  let worktree: string | undefined;

  for (const arg of argv) {
    if (arg.startsWith("--ide2-cwd=")) {
      cwd = arg.slice("--ide2-cwd=".length);
    } else if (arg.startsWith("--ide2-target=")) {
      target = arg.slice("--ide2-target=".length);
    } else if (arg === "--ide2-diff=1") {
      diff = true;
    } else if (arg.startsWith("--ide2-base=")) {
      base = arg.slice("--ide2-base=".length);
    } else if (arg.startsWith("--ide2-worktree=")) {
      worktree = arg.slice("--ide2-worktree=".length);
    }
  }

  const resolvedTarget = target ? resolve(cwd, target) : cwd;
  return { cwd, target: resolvedTarget, diff, base, worktree };
}

interface RepoSession {
  context: LaunchContext;
  git: WorktreeService;
  annotations: AnnotationStore;
  watcher: MultiWorktreeWatcher;
  windows: Set<BrowserWindow>;
  analysisCache: Map<string, { tokens: TokenSpan[][]; symbols: CodeSymbol[] }>;
  gitStatusCache: Map<string, Map<string, FileGitStatus>>;
}

const sessionsByCommonDir = new Map<string, RepoSession>();
const sessionByWindowId = new Map<number, { session: RepoSession; launchContext: LaunchContext }>();
const recentProjects = new RecentProjectsStore();
let openProjectDialogInFlight = false;

const tourServer = new TourServer({
  ensureRepoWindow: async ({ cwd, worktree, focusWindow }) => {
    const flags: ParsedProcessFlags = {
      cwd,
      target: cwd,
      diff: false,
      worktree,
    };
    const opened = await openIdeWindow(flags, undefined, {
      focusOnReuse: focusWindow,
      suppressCliOpenEvent: true,
    });
    const { session, launchContext } = await getOrCreateRepoSession(flags);
    const cachedWts = session.git.listCachedWorktrees();
    const worktrees =
      cachedWts.length > 0
        ? cachedWts
        : await session.git.discoverWorktrees(launchContext.initialWorktreePath);
    if (focusWindow && !opened.win.isDestroyed()) {
      opened.win.show();
      opened.win.focus();
    }
    return {
      repoCommonDir: session.context.repoCommonDir,
      repoName: session.context.repoName,
      worktreePath: launchContext.initialWorktreePath,
      worktrees,
    };
  },
  broadcastWalkthrough: (repoCommonDir, state) => {
    const session = sessionsByCommonDir.get(repoCommonDir);
    if (session) {
      broadcastToSession(session, {
        type: "walkthrough-updated",
        walkthrough: state,
      });
    }
  },
});

const intel = new IntelClient({
  workerPath: resolve(DIST_ROOT, "main/worker.cjs"),
});

function broadcastToSession(session: RepoSession, event: WorkspaceEvent): void {
  for (const win of session.windows) {
    if (!win.isDestroyed()) {
      win.webContents.send("ide2:event", event);
    }
  }
}

async function getOrCreateRepoSession(flags: ParsedProcessFlags): Promise<{
  session: RepoSession;
  launchContext: LaunchContext;
}> {
  const baseCtx = await resolveRepoContext(flags.target);
  const existing = sessionsByCommonDir.get(baseCtx.repoCommonDir);

  const selectInitialWorktree = (
    wts: readonly { path: string; name: string; branch: string }[],
  ): string => {
    if (flags.worktree) {
      const q = flags.worktree.trim();
      const resolvedQ = resolve(flags.cwd, q);
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
    return baseCtx.initialWorktreePath;
  };

  if (existing) {
    const wts =
      existing.git.listCachedWorktrees().length > 0
        ? existing.git.listCachedWorktrees()
        : await existing.git.discoverWorktrees(baseCtx.initialWorktreePath);
    const initialWorktreePath = selectInitialWorktree(wts);
    return {
      session: existing,
      launchContext: {
        ...baseCtx,
        initialWorktreePath,
        initialDiffMode: flags.diff,
        initialBaseRef: flags.base,
      },
    };
  }

  const git = new WorktreeService(baseCtx.repoCommonDir);
  const worktrees = await git.discoverWorktrees(baseCtx.initialWorktreePath);
  const initialWorktreePath = selectInitialWorktree(worktrees);
  const annotations = new AnnotationStore(baseCtx.repoCommonDir);

  const launchContext: LaunchContext = {
    ...baseCtx,
    initialWorktreePath,
    initialDiffMode: flags.diff,
    initialBaseRef: flags.base,
  };

  let sessionRef: RepoSession;
  const watcher = new MultiWorktreeWatcher(
    worktrees,
    baseCtx.repoCommonDir,
    async ({ worktreePath, changedFiles }) => {
      if (!sessionRef) return;
      sessionRef.gitStatusCache.delete(worktreePath);
      intel.invalidateWorktree(worktreePath, changedFiles);
      const updatedWorktrees = await git.discoverWorktrees(baseCtx.initialWorktreePath);

      // Reconcile annotations for any changed files so line numbers stay accurate live
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

      broadcastToSession(sessionRef, {
        type: "worktrees-updated",
        worktrees: updatedWorktrees,
        changedWorktreePath: worktreePath,
        changedFiles,
      });

      if (reconciledAny) {
        const list = await annotations.list();
        broadcastToSession(sessionRef, {
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

  sessionRef = {
    context: launchContext,
    git,
    annotations,
    watcher,
    windows: new Set(),
    analysisCache: new Map(),
    gitStatusCache: new Map(),
  };

  sessionsByCommonDir.set(baseCtx.repoCommonDir, sessionRef);
  return { session: sessionRef, launchContext };
}

function getWindowSession(sender: WebContents): { session: RepoSession; launchContext: LaunchContext } {
  const win = BrowserWindow.fromWebContents(sender);
  if (!win) {
    throw new Error("Request did not originate from an active ide2 window.");
  }
  const entry = sessionByWindowId.get(win.id);
  if (!entry) {
    throw new Error("No repository session bound to window.");
  }
  return entry;
}

function installNativeShortcutRouter(win: BrowserWindow): void {
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const isMac = process.platform === "darwin";
    const mod = isMac ? input.meta : input.control;
    const key = input.key.toLowerCase();

    // Never allow Cmd/Ctrl+W or Cmd/Ctrl+R or Cmd/Ctrl+N to trigger Chromium browser defaults!
    if (mod && !input.alt && !input.shift && key === "w") {
      event.preventDefault();
      win.webContents.send("ide2:event", {
        type: "native-shortcut",
        action: "close-tab",
      } satisfies WorkspaceEvent);
      return;
    }

    if (mod && (key === "r" || key === "p" || key === "n")) {
      // Prevent accidental Chromium reload, print dialog, or new window; forward Cmd+Shift+P to Markdown toggle
      if (input.shift && key === "p") {
        event.preventDefault();
        win.webContents.send("ide2:event", {
          type: "native-shortcut",
          action: "cycle-markdown-mode",
        } satisfies WorkspaceEvent);
      } else if (!input.shift) {
        event.preventDefault();
      }
    }
  });
}

function assertRegisteredWorktree(session: RepoSession, worktreePath: string): string {
  let canon = worktreePath;
  try {
    canon = realpathSync(worktreePath);
  } catch {
    // will fail membership check below
  }
  const known = session.git.listCachedWorktrees().some((w) => w.path === canon);
  if (!known) {
    throw new Error(`Refused access to unregistered worktree path: ${worktreePath}`);
  }
  return canon;
}

function buildAppMenu(): void {
  const isMac = process.platform === "darwin";
  const recent = recentProjects.list();
  const recentSubmenu: Electron.MenuItemConstructorOptions[] =
    recent.length > 0
      ? recent.map((proj) => ({
          label: proj.name,
          sublabel: proj.path,
          click: () => {
            void openProjectInNewWindow(
              BrowserWindow.getFocusedWindow() ?? undefined,
              proj.path,
              true,
            );
          },
        }))
      : [{ label: "No Recent Projects", enabled: false }];

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: "ide2",
            submenu: [
              { role: "about", label: "About ide2" },
              { type: "separator" },
              { role: "hide", label: "Hide ide2" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit", label: "Quit ide2" },
            ],
          },
        ] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "Window",
      submenu: [
        {
          label: "Open Project in New Window…",
          accelerator: "CmdOrCtrl+Shift+N",
          click: () => {
            void openProjectInNewWindow(
              BrowserWindow.getFocusedWindow() ?? undefined,
              undefined,
              true,
            );
          },
        },
        {
          label: "Recent Projects",
          submenu: recentSubmenu,
        },
        {
          label: "Copy Walkthrough Prompt for Agent",
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            const bound = win ? sessionByWindowId.get(win.id) : undefined;
            clipboard.writeText(buildWalkthroughAgentPrompt(bound?.session.context.repoName));
          },
        },
        { type: "separator" },
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        {
          label: "Close Window",
          click: () => {
            BrowserWindow.getFocusedWindow()?.close();
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function openProjectInNewWindow(
  parentWin?: BrowserWindow,
  explicitPath?: string,
  showErrorDialog = false,
): Promise<OpenProjectResult> {
  let targetPath = explicitPath?.trim();

  if (!targetPath) {
    if (openProjectDialogInFlight) {
      return { opened: false, canceled: true };
    }
    openProjectDialogInFlight = true;
    try {
      const dialogOpts: Electron.OpenDialogOptions = {
        title: "Open Project in New Window",
        buttonLabel: "Open Project",
        properties: ["openDirectory"],
      };
      const result = parentWin && !parentWin.isDestroyed()
        ? await dialog.showOpenDialog(parentWin, dialogOpts)
        : await dialog.showOpenDialog(dialogOpts);
      if (result.canceled || result.filePaths.length === 0) {
        return { opened: false, canceled: true };
      }
      targetPath = result.filePaths[0];
    } finally {
      openProjectDialogInFlight = false;
    }
  }

  if (!targetPath) {
    return { opened: false, canceled: true };
  }

  try {
    const opened = await openIdeWindow(
      { cwd: targetPath, target: targetPath, diff: false },
      parentWin,
    );
    return {
      opened: true,
      reused: opened.reused,
      repoName: opened.repoName,
    };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Selected folder is not inside a Git repository.";
    const friendly = message.includes("not a git repository")
      ? `Selected folder is not a Git repository:\n${targetPath}`
      : message;
    if (showErrorDialog) {
      dialog.showErrorBox("Could Not Open Project", friendly);
    }
    return { opened: false, error: friendly };
  }
}

async function openIdeWindow(
  flags: ParsedProcessFlags,
  cascadeFromWin?: BrowserWindow,
  options?: { focusOnReuse?: boolean; suppressCliOpenEvent?: boolean },
): Promise<{ win: BrowserWindow; reused: boolean; repoName: string }> {
  const { session, launchContext } = await getOrCreateRepoSession(flags);

  recentProjects.record({
    path: launchContext.initialWorktreePath,
    repoCommonDir: launchContext.repoCommonDir,
    name: launchContext.repoName,
  });
  buildAppMenu();

  // Warm-window reuse if this repository already has an open window!
  const existingWin = Array.from(session.windows).find((w) => !w.isDestroyed());
  if (existingWin) {
    if (options?.focusOnReuse !== false) {
      if (existingWin.isMinimized()) existingWin.restore();
      existingWin.focus();
    }
    if (!options?.suppressCliOpenEvent) {
      existingWin.webContents.send("ide2:event", {
        type: "cli-open-target",
        worktreePath: launchContext.initialWorktreePath,
        filePath: launchContext.initialFilePath,
        line: launchContext.initialLine,
        column: launchContext.initialColumn,
        diffMode: launchContext.initialDiffMode,
      } satisfies WorkspaceEvent);
    }
    return { win: existingWin, reused: true, repoName: launchContext.repoName };
  }

  const anchorWin =
    (cascadeFromWin && !cascadeFromWin.isDestroyed() ? cascadeFromWin : undefined) ??
    BrowserWindow.getFocusedWindow() ??
    undefined;
  const cascadePos = anchorWin
    ? (() => {
        const [x, y] = anchorWin.getPosition();
        return { x: (x ?? 80) + 28, y: (y ?? 80) + 28 };
      })()
    : {};

  const win = new BrowserWindow({
    ...cascadePos,
    width: 1480,
    height: 940,
    minWidth: 920,
    minHeight: 600,
    backgroundColor: "#181a1f",
    darkTheme: true,
    autoHideMenuBar: process.platform !== "darwin",
    title: `ide2 — ${launchContext.repoName}`,
    show: !process.env.IDE2_SMOKE_SCREENSHOT,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: resolve(DIST_ROOT, "preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  session.windows.add(win);
  sessionByWindowId.set(win.id, { session, launchContext });
  installNativeShortcutRouter(win);

  if (process.env.IDE2_SMOKE_SCREENSHOT) {
    win.webContents.on("console-message", (details) => {
      if (details.level === "warning" || details.level === "error") {
        process.stderr.write(`[renderer ${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})\n`);
      }
    });
    win.webContents.on("did-fail-load", (_evt, code, desc, url) => {
      process.stderr.write(`[renderer fail-load] ${code} ${desc} ${url}\n`);
    });
  }

  win.on("closed", () => {
    session.windows.delete(win);
    sessionByWindowId.delete(win.id);
    if (session.windows.size === 0) {
      session.watcher.close();
      sessionsByCommonDir.delete(session.context.repoCommonDir);
    }
  });

  await win.loadURL("ide2://app/index.html");

  if (process.env.IDE2_SMOKE_SCREENSHOT) {
    const outPath = process.env.IDE2_SMOKE_SCREENSHOT;
    setTimeout(async () => {
      try {
        const image = await win.webContents.capturePage();
        writeFileSync(outPath, image.toPNG());
      } finally {
        app.quit();
      }
    }, 1600);
  }

  return { win, reused: false, repoName: launchContext.repoName };
}

function registerIpcHandlers(): void {
  ipcMain.handle("ide2:getBootstrap", async (evt) => {
    const { session, launchContext } = getWindowSession(evt.sender);
    const cachedWts = session.git.listCachedWorktrees();
    const [worktrees, annotations] = await Promise.all([
      cachedWts.length > 0
        ? Promise.resolve(cachedWts)
        : session.git.discoverWorktrees(launchContext.initialWorktreePath),
      session.annotations.list(),
    ]);
    return {
      context: launchContext,
      worktrees,
      annotations,
      walkthrough: tourServer.getState(session.context.repoCommonDir),
    };
  });

  ipcMain.handle("ide2:listFiles", async (evt, worktreePath: string) => {
    const { session } = getWindowSession(evt.sender);
    const safeWt = assertRegisteredWorktree(session, worktreePath);
    const files = await session.git.listFiles(safeWt);
    const statusMap = new Map(
      files.filter((f) => f.gitStatus).map((f) => [f.path, f.gitStatus!]),
    );
    session.gitStatusCache.set(safeWt, statusMap);
    return files;
  });

  ipcMain.handle(
    "ide2:fuzzyFindFiles",
    async (
      evt,
      params: { worktreePath: string; query: string; allWorktrees?: boolean; limit?: number },
    ) => {
      const { session } = getWindowSession(evt.sender);
      const wts = session.git.listCachedWorktrees();
      const targetWts = params.allWorktrees
        ? wts
        : wts.filter((w) => w.path === params.worktreePath);
      const worktreesMeta = await Promise.all(
        targetWts.map(async (wt) => {
          let gitStatuses = session.gitStatusCache.get(wt.path);
          if (!gitStatuses) {
            const files = await session.git.listFiles(wt.path);
            gitStatuses = new Map(
              files.filter((f) => f.gitStatus).map((f) => [f.path, f.gitStatus!]),
            );
            session.gitStatusCache.set(wt.path, gitStatuses);
          }
          return { path: wt.path, name: wt.name, gitStatuses };
        }),
      );
      return intel.fuzzyFindFiles({
        ...params,
        worktrees: worktreesMeta,
      });
    },
  );

  ipcMain.handle(
    "ide2:readFile",
    async (evt, worktreePath: string, filePath: string, diffScope?: DiffScope) => {
      const { session } = getWindowSession(evt.sender);
      const safeWt = assertRegisteredWorktree(session, worktreePath);
      const doc = await session.git.readFile(safeWt, filePath, diffScope);
      if (doc.isBinary) return doc;

      const cacheKey = `${doc.language}:${doc.contentHash}`;
      const cached = session.analysisCache.get(cacheKey);
      if (cached) {
        return { ...doc, tokens: cached.tokens };
      }

      // Stream background Shiki + Tree-sitter analysis without blocking raw file paint!
      const rawContent = doc.lines.join("\n");
      void intel
        .analyzeFile(worktreePath, filePath, doc.contentHash, rawContent, doc.language)
        .then((analyzed) => {
          if (session.analysisCache.size > 150) {
            const firstKey = session.analysisCache.keys().next().value;
            if (firstKey) session.analysisCache.delete(firstKey);
          }
          session.analysisCache.set(cacheKey, {
            tokens: analyzed.tokens,
            symbols: analyzed.symbols,
          });
          broadcastToSession(session, {
            type: "tokens-ready",
            worktreePath,
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
    },
  );

  ipcMain.handle(
    "ide2:readAssetDataUrl",
    async (evt, worktreePath: string, relativeFromFile: string, rawHref: string) => {
      const { session } = getWindowSession(evt.sender);
      const safeWt = assertRegisteredWorktree(session, worktreePath);
      return session.git.readAssetDataUrl(safeWt, relativeFromFile, rawHref);
    },
  );

  ipcMain.handle(
    "ide2:getDiff",
    async (evt, worktreePath: string, filePath: string, scope: DiffScope) => {
      const { session } = getWindowSession(evt.sender);
      const safeWt = assertRegisteredWorktree(session, worktreePath);
      const safeScope: DiffScope =
        scope.kind === "worktree"
          ? { kind: "worktree", otherWorktreePath: assertRegisteredWorktree(session, scope.otherWorktreePath) }
          : scope;
      return session.git.getDiff(safeWt, filePath, safeScope);
    },
  );

  ipcMain.handle(
    "ide2:listChangedFiles",
    async (evt, worktreePath: string, scope: DiffScope) => {
      const { session } = getWindowSession(evt.sender);
      const safeWt = assertRegisteredWorktree(session, worktreePath);
      const safeScope: DiffScope =
        scope.kind === "worktree"
          ? { kind: "worktree", otherWorktreePath: assertRegisteredWorktree(session, scope.otherWorktreePath) }
          : scope;
      return session.git.listChangedFiles(safeWt, safeScope);
    },
  );

  ipcMain.handle("ide2:listCommits", async (evt, worktreePath: string, limit?: number) => {
    const { session } = getWindowSession(evt.sender);
    const safeWt = assertRegisteredWorktree(session, worktreePath);
    return session.git.listCommits(safeWt, limit);
  });

  ipcMain.handle("ide2:getBlame", async (evt, worktreePath: string, filePath: string) => {
    const { session } = getWindowSession(evt.sender);
    const safeWt = assertRegisteredWorktree(session, worktreePath);
    return session.git.getBlame(safeWt, filePath);
  });

  ipcMain.handle("ide2:getStructure", async (evt, worktreePath: string, filePath: string) => {
    const { session } = getWindowSession(evt.sender);
    const safeWt = assertRegisteredWorktree(session, worktreePath);
    const doc = await session.git.readFile(safeWt, filePath);
    if (doc.isBinary) return [];
    const cacheKey = `${doc.language}:${doc.contentHash}`;
    const cached = session.analysisCache.get(cacheKey);
    if (cached) return cached.symbols;
    return intel.getStructure(safeWt, filePath, doc.lines.join("\n"));
  });

  ipcMain.handle(
    "ide2:searchSymbols",
    async (
      evt,
      params: { worktreePath: string; query: string; allWorktrees?: boolean; limit?: number },
    ) => {
      const { session } = getWindowSession(evt.sender);
      const worktreePaths = session.git.listCachedWorktrees().map((w) => w.path);
      return intel.searchSymbols({ ...params, worktreePaths });
    },
  );

  ipcMain.handle(
    "ide2:findDefinitionAndUsages",
    async (
      evt,
      params: { worktreePath: string; filePath: string; symbolName: string; line: number },
    ) => {
      return intel.findDefinitionAndUsages(params);
    },
  );

  ipcMain.handle("ide2:findInPath", async (evt, query: FindInPathQuery) => {
    const { session } = getWindowSession(evt.sender);
    const wts = session.git.listCachedWorktrees().map((w) => ({ path: w.path, name: w.name }));
    return intel.findInPath(query, wts);
  });

  ipcMain.handle("ide2:listAnnotations", async (evt, worktreePath?: string) => {
    const { session } = getWindowSession(evt.sender);
    return session.annotations.list(worktreePath);
  });

  ipcMain.handle("ide2:createAnnotation", async (evt, input: CreateAnnotationInput) => {
    const { session } = getWindowSession(evt.sender);
    const created = await session.annotations.create(input);
    const all = await session.annotations.list();
    broadcastToSession(session, {
      type: "annotations-updated",
      worktreePath: created.worktreePath,
      annotations: all,
    });
    return created;
  });

  ipcMain.handle("ide2:updateAnnotation", async (evt, input: UpdateAnnotationInput) => {
    const { session } = getWindowSession(evt.sender);
    const updated = await session.annotations.update(input);
    const all = await session.annotations.list();
    broadcastToSession(session, {
      type: "annotations-updated",
      worktreePath: updated.worktreePath,
      annotations: all,
    });
    return updated;
  });

  ipcMain.handle("ide2:deleteAnnotation", async (evt, id: string) => {
    const { session } = getWindowSession(evt.sender);
    await session.annotations.delete(id);
    const all = await session.annotations.list();
    broadcastToSession(session, {
      type: "annotations-updated",
      worktreePath: session.context.initialWorktreePath,
      annotations: all,
    });
  });

  ipcMain.handle("ide2:compileFeedbackPrompt", async (evt, options: ExportPromptOptions) => {
    const { session } = getWindowSession(evt.sender);
    const safeWt = assertRegisteredWorktree(session, options.worktreePath);
    const wts = await session.git.discoverWorktrees(session.context.initialWorktreePath);
    const wt = wts.find((w) => w.path === safeWt) ?? wts[0];
    if (!wt) {
      return { markdown: "", count: 0 };
    }
    const res = await session.annotations.compilePrompt(wt, { ...options, worktreePath: safeWt });
    if (options.resolveAfterExport && res.count > 0) {
      const all = await session.annotations.list();
      broadcastToSession(session, {
        type: "annotations-updated",
        worktreePath: wt.path,
        annotations: all,
      });
    }
    return res;
  });

  ipcMain.handle("ide2:copyToClipboard", (_evt, text: string) => {
    clipboard.writeText(text);
  });

  ipcMain.handle("ide2:openExternalUrl", async (_evt, url: string) => {
    if (/^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
    }
  });

  ipcMain.handle("ide2:revealInOs", (_evt, targetPath: string) => {
    shell.showItemInFolder(targetPath);
  });

  ipcMain.handle(
    "ide2:createWorktree",
    async (
      evt,
      params: { baseWorktreePath: string; branchName: string; baseRef?: string; targetDir?: string },
    ) => {
      const { session } = getWindowSession(evt.sender);
      const safeBase = assertRegisteredWorktree(session, params.baseWorktreePath);
      const created = await session.git.createWorktree({ ...params, baseWorktreePath: safeBase });
      const updatedWorktrees = await session.git.discoverWorktrees(session.context.initialWorktreePath);
      session.watcher.resetWatches(updatedWorktrees, session.context.repoCommonDir);
      broadcastToSession(session, {
        type: "worktrees-updated",
        worktrees: updatedWorktrees,
        changedWorktreePath: created.path,
      });
      return created;
    },
  );

  ipcMain.handle("ide2:openProjectWindow", async (evt, targetPath?: string) => {
    const senderWin = BrowserWindow.fromWebContents(evt.sender) ?? undefined;
    return openProjectInNewWindow(senderWin, targetPath, false);
  });

  ipcMain.handle("ide2:listRecentProjects", () => {
    return recentProjects.list();
  });

  ipcMain.handle("ide2:respondWalkthrough", (evt, response: WalkthroughUserResponse) => {
    const { session } = getWindowSession(evt.sender);
    tourServer.respondFromUser(session.context.repoCommonDir, response);
  });

  ipcMain.handle("ide2:endWalkthrough", (evt) => {
    const { session } = getWindowSession(evt.sender);
    tourServer.endFromUser(session.context.repoCommonDir);
  });

  ipcMain.handle("ide2:getWalkthroughAgentPrompt", (evt) => {
    const { session } = getWindowSession(evt.sender);
    return buildWalkthroughAgentPrompt(session.context.repoName);
  });
}

app.setName("ide2");
nativeTheme.themeSource = "dark";

const gotSingleInstanceLock = process.env.IDE2_SMOKE_SCREENSHOT
  ? true
  : app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine, workingDirectory) => {
    const flags = parseFlags(commandLine, workingDirectory || process.cwd());
    void openIdeWindow(flags);
  });

  app.whenReady().then(async () => {
    if (process.platform === "darwin") {
      app.setAboutPanelOptions({
        applicationName: "ide2",
        applicationVersion: app.getVersion(),
      });
    }
    registerRendererProtocol();
    buildAppMenu();
    registerIpcHandlers();
    try {
      await tourServer.listen();
    } catch (err) {
      console.error("Failed to start ide2 tour RPC socket:", err);
    }
    const initialFlags = parseFlags(process.argv, process.cwd());
    try {
      await openIdeWindow(initialFlags);
    } catch (err) {
      console.error("Failed to open repository in ide2:", err);
      app.quit();
    }
  });

  app.on("will-quit", () => {
    void tourServer.close();
  });

  app.on("window-all-closed", () => {
    void Promise.allSettled([intel.dispose(), tourServer.close()]).finally(() => {
      app.quit();
    });
  });
}
