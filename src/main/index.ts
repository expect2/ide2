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
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { LocalWorkspaceBackend } from "./backend/local-backend.js";
import {
  RemoteBootstrapRequiredError,
  SshWorkspaceBackend,
} from "./backend/ssh-backend.js";
import type { WorkspaceBackend } from "./backend/workspace-backend.js";
import { IntelClient } from "./intel/client.js";
import { PLUGIN_SHIM_MODULES } from "./plugins/bundler.js";
import { PluginInstaller } from "./plugins/installer.js";
import { PluginHost } from "./plugins/plugin-host.js";
import { PreferencesStore } from "./services/preferences.js";
import { RecentProjectsStore } from "./services/recent-projects.js";
import { TourServer } from "./services/tour-server.js";
import {
  buildReviewAgentPrompt,
  buildWalkthroughAgentPrompt,
} from "../shared/walkthrough-prompt.js";
import {
  parseSshTarget,
  type CreateAnnotationInput,
  type DiffScope,
  type ExportPromptOptions,
  type FindInPathQuery,
  type InstalledPluginInfo,
  type InstallPluginParams,
  type InstallPluginResult,
  type LaunchContext,
  type OpenProjectResult,
  type PluginAgentCardState,
  type PluginLineDecoration,
  type ReviewUserResponse,
  type UpdateAnnotationInput,
  type UpdatePluginResult,
  type WalkthroughUserResponse,
  type WorkspaceEvent,
} from "../shared/protocol.js";

const APP_ROOT = app.getAppPath();
const DIST_ROOT = resolve(APP_ROOT, "dist");
const RENDERER_ROOT = resolve(DIST_ROOT, "renderer");
const BUILTIN_PR_PLUGIN_DIR = resolve(APP_ROOT, "plugins/pr-checks");

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

interface ParsedProcessFlags {
  cwd: string;
  target: string;
  sshTarget?: string;
  sshOptions?: string;
  autoBootstrap?: boolean;
  diff: boolean;
  base?: string;
  worktree?: string;
}

function parseFlags(argv: readonly string[], fallbackCwd: string): ParsedProcessFlags {
  let cwd = fallbackCwd;
  let target: string | undefined;
  let sshTarget: string | undefined;
  let sshOptions: string | undefined;
  let autoBootstrap = false;
  let diff = false;
  let base: string | undefined;
  let worktree: string | undefined;

  for (const arg of argv) {
    if (arg.startsWith("--ide2-cwd=")) {
      cwd = arg.slice("--ide2-cwd=".length);
    } else if (arg.startsWith("--ide2-target=")) {
      target = arg.slice("--ide2-target=".length);
    } else if (arg.startsWith("--ide2-ssh=")) {
      sshTarget = arg.slice("--ide2-ssh=".length);
    } else if (arg.startsWith("--ide2-ssh-opt=")) {
      sshOptions = arg.slice("--ide2-ssh-opt=".length);
    } else if (arg === "--ide2-bootstrap=1") {
      autoBootstrap = true;
    } else if (arg === "--ide2-diff=1") {
      diff = true;
    } else if (arg.startsWith("--ide2-base=")) {
      base = arg.slice("--ide2-base=".length);
    } else if (arg.startsWith("--ide2-worktree=")) {
      worktree = arg.slice("--ide2-worktree=".length);
    }
  }

  const resolvedTarget = target ? resolve(cwd, target) : cwd;
  return {
    cwd,
    target: resolvedTarget,
    sshTarget,
    sshOptions,
    autoBootstrap,
    diff,
    base,
    worktree,
  };
}

/**
 * Wraps a `WorkspaceBackend` (`LocalWorkspaceBackend` or `SshWorkspaceBackend`)
 * together with its bound Electron `BrowserWindow`s and (when connected via SSH)
 * the laptop-local `clientPluginHost` (`"host": "client"` plugins).
 */
interface ManagedSession {
  key: string;
  backend: WorkspaceBackend;
  /** Non-null on remote SSH sessions so `"host": "client"` plugins run locally on your laptop! */
  clientPluginHost: PluginHost | null;
  /** Latest remote-side `"workspace"` plugin state when `backend.isRemote === true` */
  remotePluginSnapshot: {
    plugins: InstalledPluginInfo[];
    decorations: PluginLineDecoration[];
    cards: PluginAgentCardState[];
  };
  windows: Set<BrowserWindow>;
  unsubBackend?: () => void;
}

const sessionsByKey = new Map<string, ManagedSession>();
const sessionByWindowId = new Map<
  number,
  { managed: ManagedSession; launchContext: LaunchContext }
>();
const recentProjects = new RecentProjectsStore();
const preferences = new PreferencesStore();
let openProjectDialogInFlight = false;

const intel = new IntelClient({
  workerPath: resolve(DIST_ROOT, "main/worker.cjs"),
});

function broadcastToSession(managed: ManagedSession, event: WorkspaceEvent): void {
  for (const win of managed.windows) {
    if (!win.isDestroyed()) {
      win.webContents.send("ide2:event", event);
    }
  }
}

async function getMergedPluginsForSession(managed: ManagedSession): Promise<{
  plugins: InstalledPluginInfo[];
  decorations: PluginLineDecoration[];
  cards: PluginAgentCardState[];
}> {
  if (!managed.backend.isRemote || !managed.clientPluginHost) {
    const plugins = await managed.backend.listPlugins();
    const localController = (managed.backend as LocalWorkspaceBackend).getPluginController?.();
    return {
      plugins,
      decorations: localController?.getDecorations() ?? [],
      cards: localController?.getCards() ?? [],
    };
  }

  const localPlugins = await managed.clientPluginHost.listPlugins();
  const remotePlugins = managed.remotePluginSnapshot.plugins;
  return {
    plugins: [...localPlugins, ...remotePlugins],
    decorations: [
      ...managed.clientPluginHost.getDecorations(),
      ...managed.remotePluginSnapshot.decorations,
    ],
    cards: [
      ...managed.clientPluginHost.getCards(),
      ...managed.remotePluginSnapshot.cards,
    ],
  };
}

function broadcastMergedPluginState(managed: ManagedSession): void {
  if (!managed.backend.isRemote || !managed.clientPluginHost) return;
  void managed.clientPluginHost.listPlugins().then((localPlugins) => {
    broadcastToSession(managed, {
      type: "plugins-updated",
      plugins: [...localPlugins, ...managed.remotePluginSnapshot.plugins],
      decorations: [
        ...managed.clientPluginHost!.getDecorations(),
        ...managed.remotePluginSnapshot.decorations,
      ],
      cards: [
        ...managed.clientPluginHost!.getCards(),
        ...managed.remotePluginSnapshot.cards,
      ],
    });
  });
}

function registerRendererProtocol(): void {
  const canonRendererRoot = realpathSync(RENDERER_ROOT);
  const localInstaller = new PluginInstaller(
    process.env.IDE2_HOME ?? join(homedir(), ".expect2-ide"),
    "local",
  );

  protocol.handle("ide2", async (request) => {
    try {
      const url = new URL(request.url);
      let reqPath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      if (!reqPath) reqPath = "index.html";

      // Dynamic Plugin ESM & Runtime Shim serving (`ide2://app/__plugins/...`)
      if (reqPath.startsWith("__plugins/")) {
        const subParts = reqPath.slice("__plugins/".length).split("/");
        if (subParts[0] === "_shim" && subParts[1]) {
          const shimSource = PLUGIN_SHIM_MODULES[subParts[1]];
          if (shimSource) {
            return new Response(shimSource, {
              status: 200,
              headers: { "Content-Type": "text/javascript; charset=utf-8" },
            });
          }
          return new Response("Shim Not Found", { status: 404 });
        }

        const scope = subParts[0]; // "local" | "remote"
        const pluginId = subParts[1];
        if (!pluginId) {
          return new Response("Not Found", { status: 404 });
        }

        if (scope === "local") {
          const bundleFile = join(localInstaller.getPluginDir(pluginId), ".ide2-build/client.js");
          if (existsSync(bundleFile)) {
            return new Response(readFileSync(bundleFile), {
              status: 200,
              headers: {
                "Content-Type": "text/javascript; charset=utf-8",
                "Cache-Control": "no-store",
              },
            });
          }
          return new Response("Local plugin client bundle not found", { status: 404 });
        }

        if (scope === "remote") {
          const sessionKey = url.searchParams.get("session") ?? "";
          const candidate =
            (sessionKey ? sessionsByKey.get(sessionKey) : undefined) ??
            Array.from(sessionsByKey.values()).find((s) => s.backend.isRemote);
          if (!candidate) {
            return new Response("No active remote session", { status: 404 });
          }
          const code = await candidate.backend.readPluginClientBundle(pluginId);
          if (code !== null) {
            return new Response(code, {
              status: 200,
              headers: {
                "Content-Type": "text/javascript; charset=utf-8",
                "Cache-Control": "no-store",
              },
            });
          }
          return new Response("Remote plugin client bundle not found", { status: 404 });
        }
      }

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

const tourServer = new TourServer({
  ensureRepoWindow: async ({ cwd, worktree, diff, focusWindow }) => {
    const flags: ParsedProcessFlags = {
      cwd,
      target: cwd,
      diff: Boolean(diff),
      worktree,
    };
    const { managed, launchContext } = await getOrCreateManagedSession(flags);
    const otherWtAwaiting = tourServer
      .getReviewStates(managed.backend.getLaunchContext().repoCommonDir)
      .some((r) => r.awaitingUser && r.worktreePath !== launchContext.initialWorktreePath);
    const shouldFocus = focusWindow && !otherWtAwaiting;
    const opened = await openIdeWindow(flags, undefined, {
      focusOnReuse: shouldFocus,
      suppressCliOpenEvent: !diff || otherWtAwaiting,
    });
    const cachedWts = managed.backend.listCachedWorktrees();
    const worktrees =
      cachedWts.length > 0 ? cachedWts : await managed.backend.discoverWorktrees();
    if (shouldFocus && !opened.win.isDestroyed()) {
      opened.win.show();
      opened.win.focus();
    }
    return {
      repoCommonDir: managed.backend.getLaunchContext().repoCommonDir,
      repoName: managed.backend.getLaunchContext().repoName,
      worktreePath: launchContext.initialWorktreePath,
      worktrees,
    };
  },
  broadcastWalkthrough: (repoCommonDir, walkthroughs) => {
    const managed = sessionsByKey.get(repoCommonDir);
    if (managed) {
      broadcastToSession(managed, {
        type: "walkthrough-updated",
        walkthroughs,
      });
    }
  },
  broadcastReview: (repoCommonDir, reviews) => {
    const managed = sessionsByKey.get(repoCommonDir);
    if (managed) {
      broadcastToSession(managed, {
        type: "review-updated",
        reviews,
      });
    }
  },
  handlePluginCli: async (params) => {
    const flags: ParsedProcessFlags = {
      cwd: params.cwd,
      target: params.cwd,
      diff: false,
      worktree: params.worktree,
    };
    const { managed, launchContext } = await getOrCreateManagedSession(flags);
    await openIdeWindow(flags, undefined, {
      focusOnReuse: Boolean(params.wait),
      suppressCliOpenEvent: true,
    });
    const localBackend = managed.backend as LocalWorkspaceBackend;
    const controller = localBackend.getPluginController?.();
    if (!controller) {
      throw new Error("No plugin runtime active on this workspace.");
    }
    return controller.handleAgentCli({
      worktreePath: launchContext.initialWorktreePath,
      subcommand: params.subcommand,
      argv: params.argv,
      stdin: params.stdin,
      wait: params.wait,
      waitTimeoutMs: params.waitTimeoutMs,
    });
  },
});

async function getOrCreateManagedSession(
  flags: ParsedProcessFlags,
  opts?: { deferSshBootstrap?: boolean },
): Promise<{
  managed: ManagedSession;
  launchContext: LaunchContext;
}> {
  if (flags.sshTarget) {
    const parsedSsh = parseSshTarget(flags.sshTarget);
    const key = parsedSsh.uri;
    const existing = sessionsByKey.get(key);
    if (existing) {
      const wtPath = await existing.backend
        .selectWorktreePath(flags.worktree)
        .catch(() => existing.backend.getLaunchContext().initialWorktreePath);
      return {
        managed: existing,
        launchContext: {
          ...existing.backend.getLaunchContext(),
          initialWorktreePath: wtPath,
          initialLine: parsedSsh.line,
          initialColumn: parsedSsh.column,
          initialDiffMode: flags.diff,
          initialBaseRef: flags.base,
        },
      };
    }

    const sshBackend = await SshWorkspaceBackend.create({
      appRoot: APP_ROOT,
      sshTarget: flags.sshTarget,
      sshOptions: flags.sshOptions,
      worktree: flags.worktree,
      diff: flags.diff,
      base: flags.base,
      autoBootstrap: flags.autoBootstrap,
      deferOnBootstrapNeeded: opts?.deferSshBootstrap,
      localIntel: intel,
    });

    const initialSnap = await sshBackend.getBootstrapSnapshot().catch(() => null);

    const managed: ManagedSession = {
      key,
      backend: sshBackend,
      clientPluginHost: null,
      remotePluginSnapshot: {
        plugins: initialSnap?.plugins ?? [],
        decorations: initialSnap?.pluginDecorations ?? [],
        cards: initialSnap?.pluginCards ?? [],
      },
      windows: new Set(),
    };

    const clientHost = new PluginHost({
      backend: sshBackend,
      scope: "local",
      hostAffinityFilter: "client",
      runnerWorkerPath: resolve(DIST_ROOT, "main/plugin-runner.cjs"),
      builtinPluginDirs: existsSync(BUILTIN_PR_PLUGIN_DIR) ? [BUILTIN_PR_PLUGIN_DIR] : [],
      onStateChanged: () => {
        broadcastMergedPluginState(managed);
      },
      onPluginEvent: (pluginId, event, payload) => {
        broadcastToSession(managed, {
          type: "plugin-event",
          pluginId,
          event,
          payload,
        });
      },
    });
    managed.clientPluginHost = clientHost;

    if (!sshBackend.getConnectionState().needsBootstrap) {
      await clientHost.start();
    }

    managed.unsubBackend = sshBackend.onEvent((evt) => {
      if (evt.type === "plugins-updated") {
        managed.remotePluginSnapshot = {
          plugins: evt.plugins,
          decorations: evt.decorations,
          cards: evt.cards,
        };
        broadcastMergedPluginState(managed);
        return;
      }
      broadcastToSession(managed, evt);
    });

    sessionsByKey.set(key, managed);
    return {
      managed,
      launchContext: sshBackend.getLaunchContext(),
    };
  }

  // Local repository session
  const tempBackend = await LocalWorkspaceBackend.create({
    targetPath: flags.target,
    cwd: flags.cwd,
    worktree: flags.worktree,
    diff: flags.diff,
    base: flags.base,
    intel,
    tourServer,
  });

  const repoCommonDir = tempBackend.getLaunchContext().repoCommonDir;
  const existing = sessionsByKey.get(repoCommonDir);
  if (existing) {
    const newLaunchCtx = tempBackend.getLaunchContext();
    await tempBackend.dispose();
    const wtPath = await existing.backend.selectWorktreePath(flags.worktree, flags.cwd);
    return {
      managed: existing,
      launchContext: {
        ...existing.backend.getLaunchContext(),
        initialWorktreePath: wtPath,
        initialFilePath: newLaunchCtx.initialFilePath,
        initialLine: newLaunchCtx.initialLine,
        initialColumn: newLaunchCtx.initialColumn,
        initialDiffMode: flags.diff,
        initialBaseRef: flags.base,
      },
    };
  }

  const managed: ManagedSession = {
    key: repoCommonDir,
    backend: tempBackend,
    clientPluginHost: null,
    remotePluginSnapshot: { plugins: [], decorations: [], cards: [] },
    windows: new Set(),
  };

  const pluginHost = new PluginHost({
    backend: tempBackend,
    scope: "local",
    hostAffinityFilter: "all",
    runnerWorkerPath: resolve(DIST_ROOT, "main/plugin-runner.cjs"),
    builtinPluginDirs: existsSync(BUILTIN_PR_PLUGIN_DIR) ? [BUILTIN_PR_PLUGIN_DIR] : [],
    onStateChanged: (snapshot) => {
      broadcastToSession(managed, {
        type: "plugins-updated",
        plugins: snapshot.plugins,
        decorations: snapshot.decorations,
        cards: snapshot.cards,
      });
    },
    onPluginEvent: (pluginId, event, payload) => {
      broadcastToSession(managed, {
        type: "plugin-event",
        pluginId,
        event,
        payload,
      });
    },
  });
  tempBackend.attachPluginController(pluginHost);
  await pluginHost.start();

  managed.unsubBackend = tempBackend.onEvent((evt) => {
    broadcastToSession(managed, evt);
  });

  sessionsByKey.set(repoCommonDir, managed);
  return {
    managed,
    launchContext: tempBackend.getLaunchContext(),
  };
}

function getWindowSession(sender: WebContents): {
  managed: ManagedSession;
  launchContext: LaunchContext;
} {
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

    if (mod && !input.alt && !input.shift && key === "w") {
      event.preventDefault();
      win.webContents.send("ide2:event", {
        type: "native-shortcut",
        action: "close-tab",
      } satisfies WorkspaceEvent);
      return;
    }

    if (mod && (key === "r" || key === "p" || key === "n")) {
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

function buildAppMenu(): void {
  const isMac = process.platform === "darwin";
  const recent = recentProjects.list();
  const recentSubmenu: Electron.MenuItemConstructorOptions[] =
    recent.length > 0
      ? recent.map((proj) => ({
          label: proj.isRemote ? `${proj.name} (SSH)` : proj.name,
          sublabel: proj.sshTarget ?? proj.path,
          click: () => {
            if (proj.isRemote && proj.sshTarget) {
              void openIdeWindow(
                {
                  cwd: process.cwd(),
                  target: process.cwd(),
                  sshTarget: proj.sshTarget,
                  diff: false,
                },
                BrowserWindow.getFocusedWindow() ?? undefined,
              );
            } else {
              void openProjectInNewWindow(
                BrowserWindow.getFocusedWindow() ?? undefined,
                proj.path,
                true,
              );
            }
          },
        }))
      : [{ label: "No Recent Projects", enabled: false }];

  const sendShortcutActionToFocused = (action: string) => {
    const win = BrowserWindow.getFocusedWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send("ide2:event", {
        type: "native-shortcut",
        action,
      } satisfies WorkspaceEvent);
    }
  };

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: "ide2",
            submenu: [
              { role: "about", label: "About ide2" },
              { type: "separator" },
              {
                label: "Manage Plugins…",
                click: () => sendShortcutActionToFocused("manage-plugins"),
              },
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
          label: "Connect to Remote via SSH…",
          click: () => sendShortcutActionToFocused("connect-ssh"),
        },
        {
          label: "Manage Plugins…",
          click: () => sendShortcutActionToFocused("manage-plugins"),
        },
        {
          label: "Recent Projects",
          submenu: recentSubmenu,
        },
        { type: "separator" },
        {
          label: "Copy Walkthrough Prompt for Agent",
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            const bound = win ? sessionByWindowId.get(win.id) : undefined;
            clipboard.writeText(
              buildWalkthroughAgentPrompt(bound?.managed.backend.getLaunchContext().repoName),
            );
          },
        },
        {
          label: "Copy Live Review Prompt for Agent",
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            const bound = win ? sessionByWindowId.get(win.id) : undefined;
            clipboard.writeText(
              buildReviewAgentPrompt(bound?.managed.backend.getLaunchContext().repoName),
            );
          },
        },
        {
          label: "Show Onboarding Walkthrough",
          click: () => sendShortcutActionToFocused("show-onboarding"),
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

  if (targetPath?.startsWith("ssh://")) {
    try {
      const opened = await openIdeWindow(
        {
          cwd: process.cwd(),
          target: process.cwd(),
          sshTarget: targetPath,
          diff: false,
        },
        parentWin,
      );
      return { opened: true, reused: opened.reused, repoName: opened.repoName };
    } catch (err) {
      if (err instanceof RemoteBootstrapRequiredError) {
        return {
          opened: false,
          needsBootstrap: true,
          sshTarget: err.sshTarget,
          error: err.message,
        };
      }
      return {
        opened: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

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
      const result =
        parentWin && !parentWin.isDestroyed()
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
  options?: {
    focusOnReuse?: boolean;
    suppressCliOpenEvent?: boolean;
    deferSshBootstrap?: boolean;
  },
): Promise<{ win: BrowserWindow; reused: boolean; repoName: string }> {
  const { managed, launchContext } = await getOrCreateManagedSession(flags, {
    deferSshBootstrap: options?.deferSshBootstrap,
  });

  if (managed.backend.isRemote && launchContext.sshTarget) {
    recentProjects.record({
      path: managed.key,
      repoCommonDir: managed.key,
      name: `${launchContext.repoName} (${launchContext.sshHost ?? "SSH"})`,
      isRemote: true,
      sshTarget: launchContext.sshTarget,
    });
  } else {
    recentProjects.record({
      path: launchContext.initialWorktreePath,
      repoCommonDir: launchContext.repoCommonDir,
      name: launchContext.repoName,
    });
  }
  buildAppMenu();

  const existingWin = Array.from(managed.windows).find((w) => !w.isDestroyed());
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

  const titleSuffix =
    managed.backend.isRemote && launchContext.sshHost
      ? `${launchContext.repoName} [SSH: ${launchContext.sshHost}]`
      : launchContext.repoName;

  const win = new BrowserWindow({
    ...cascadePos,
    width: 1480,
    height: 940,
    minWidth: 920,
    minHeight: 600,
    backgroundColor: "#181a1f",
    darkTheme: true,
    autoHideMenuBar: process.platform !== "darwin",
    title: `ide2 — ${titleSuffix}`,
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

  managed.windows.add(win);
  sessionByWindowId.set(win.id, { managed, launchContext });
  installNativeShortcutRouter(win);

  if (process.env.IDE2_SMOKE_SCREENSHOT) {
    win.webContents.on("console-message", (details) => {
      if (details.level === "warning" || details.level === "error") {
        process.stderr.write(
          `[renderer ${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})\n`,
        );
      }
    });
    win.webContents.on("did-fail-load", (_evt, code, desc, url) => {
      process.stderr.write(`[renderer fail-load] ${code} ${desc} ${url}\n`);
    });
  }

  win.on("closed", () => {
    managed.windows.delete(win);
    sessionByWindowId.delete(win.id);
    if (managed.windows.size === 0) {
      sessionsByKey.delete(managed.key);
      managed.unsubBackend?.();
      void Promise.allSettled([
        managed.clientPluginHost?.dispose(),
        managed.backend.dispose(),
      ]);
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
    const { managed, launchContext } = getWindowSession(evt.sender);
    const snap = await managed.backend.getBootstrapSnapshot({
      initialWorktreePath: launchContext.initialWorktreePath,
      initialFilePath: launchContext.initialFilePath,
      initialLine: launchContext.initialLine,
      initialColumn: launchContext.initialColumn,
      initialDiffMode: launchContext.initialDiffMode,
      initialBaseRef: launchContext.initialBaseRef,
    });

    if (managed.backend.isRemote) {
      managed.remotePluginSnapshot = {
        plugins: snap.plugins,
        decorations: snap.pluginDecorations,
        cards: snap.pluginCards,
      };
    }

    const merged = await getMergedPluginsForSession(managed);

    return {
      context: snap.context,
      worktrees: snap.worktrees,
      annotations: snap.annotations,
      walkthroughs: snap.walkthroughs,
      reviews: snap.reviews,
      connection: snap.connection,
      plugins: merged.plugins,
      pluginDecorations: merged.decorations,
      pluginCards: merged.cards,
      showOnboarding:
        !process.env.IDE2_SMOKE_SCREENSHOT &&
        !preferences.isOnboardingCompleted() &&
        !snap.connection.needsBootstrap &&
        snap.walkthroughs.length === 0 &&
        snap.reviews.length === 0,
    };
  });

  ipcMain.handle("ide2:listFiles", async (evt, worktreePath: string) => {
    const { managed } = getWindowSession(evt.sender);
    return managed.backend.listFiles(worktreePath);
  });

  ipcMain.handle("ide2:fuzzyFindFiles", async (evt, params) => {
    const { managed } = getWindowSession(evt.sender);
    return managed.backend.fuzzyFindFiles(params);
  });

  ipcMain.handle(
    "ide2:readFile",
    async (evt, worktreePath: string, filePath: string, diffScope?: DiffScope) => {
      const { managed } = getWindowSession(evt.sender);
      return managed.backend.readFile(worktreePath, filePath, diffScope);
    },
  );

  ipcMain.handle(
    "ide2:readAssetDataUrl",
    async (evt, worktreePath: string, relativeFromFile: string, rawHref: string) => {
      const { managed } = getWindowSession(evt.sender);
      return managed.backend.readAssetDataUrl(worktreePath, relativeFromFile, rawHref);
    },
  );

  ipcMain.handle(
    "ide2:getDiff",
    async (evt, worktreePath: string, filePath: string, scope: DiffScope) => {
      const { managed } = getWindowSession(evt.sender);
      return managed.backend.getDiff(worktreePath, filePath, scope);
    },
  );

  ipcMain.handle(
    "ide2:listChangedFiles",
    async (evt, worktreePath: string, scope: DiffScope) => {
      const { managed } = getWindowSession(evt.sender);
      return managed.backend.listChangedFiles(worktreePath, scope);
    },
  );

  ipcMain.handle("ide2:listCommits", async (evt, worktreePath: string, limit?: number) => {
    const { managed } = getWindowSession(evt.sender);
    return managed.backend.listCommits(worktreePath, limit);
  });

  ipcMain.handle("ide2:getBlame", async (evt, worktreePath: string, filePath: string) => {
    const { managed } = getWindowSession(evt.sender);
    return managed.backend.getBlame(worktreePath, filePath);
  });

  ipcMain.handle("ide2:getStructure", async (evt, worktreePath: string, filePath: string) => {
    const { managed } = getWindowSession(evt.sender);
    return managed.backend.getStructure(worktreePath, filePath);
  });

  ipcMain.handle("ide2:searchSymbols", async (evt, params) => {
    const { managed } = getWindowSession(evt.sender);
    return managed.backend.searchSymbols(params);
  });

  ipcMain.handle("ide2:findDefinitionAndUsages", async (evt, params) => {
    const { managed } = getWindowSession(evt.sender);
    return managed.backend.findDefinitionAndUsages(params);
  });

  ipcMain.handle("ide2:findInPath", async (evt, query: FindInPathQuery) => {
    const { managed } = getWindowSession(evt.sender);
    return managed.backend.findInPath(query);
  });

  ipcMain.handle("ide2:listAnnotations", async (evt, worktreePath?: string) => {
    const { managed } = getWindowSession(evt.sender);
    return managed.backend.listAnnotations(worktreePath);
  });

  ipcMain.handle("ide2:createAnnotation", async (evt, input: CreateAnnotationInput) => {
    const { managed } = getWindowSession(evt.sender);
    return managed.backend.createAnnotation(input);
  });

  ipcMain.handle("ide2:updateAnnotation", async (evt, input: UpdateAnnotationInput) => {
    const { managed } = getWindowSession(evt.sender);
    return managed.backend.updateAnnotation(input);
  });

  ipcMain.handle("ide2:deleteAnnotation", async (evt, id: string) => {
    const { managed } = getWindowSession(evt.sender);
    return managed.backend.deleteAnnotation(id);
  });

  ipcMain.handle("ide2:compileFeedbackPrompt", async (evt, options: ExportPromptOptions) => {
    const { managed } = getWindowSession(evt.sender);
    const res = await managed.backend.compileFeedbackPrompt(options);
    if (managed.backend.isRemote && managed.clientPluginHost && res.count > 0 && res.markdown) {
      const wts = managed.backend.listCachedWorktrees();
      const wt = wts.find((w) => w.path === options.worktreePath) ?? wts[0];
      if (wt) {
        const anns = await managed.backend.listAnnotations(options.worktreePath).catch(() => []);
        const enriched = await managed.clientPluginHost
          .enrichFeedbackPrompt({
            worktree: wt,
            annotations: anns,
            markdown: res.markdown,
          })
          .catch(() => res.markdown);
        return { markdown: enriched, count: res.count };
      }
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
    if (!targetPath.startsWith("ssh://")) {
      shell.showItemInFolder(targetPath);
    }
  });

  ipcMain.handle("ide2:createWorktree", async (evt, params) => {
    const { managed } = getWindowSession(evt.sender);
    return managed.backend.createWorktree(params);
  });

  ipcMain.handle("ide2:openProjectWindow", async (evt, targetPath?: string) => {
    const senderWin = BrowserWindow.fromWebContents(evt.sender) ?? undefined;
    return openProjectInNewWindow(senderWin, targetPath, false);
  });

  ipcMain.handle(
    "ide2:connectSshWindow",
    async (
      evt,
      params: {
        sshTarget: string;
        sshOptions?: string;
        diff?: boolean;
        worktree?: string;
        autoBootstrap?: boolean;
      },
    ): Promise<OpenProjectResult> => {
      const senderWin = BrowserWindow.fromWebContents(evt.sender) ?? undefined;
      try {
        const opened = await openIdeWindow(
          {
            cwd: process.cwd(),
            target: process.cwd(),
            sshTarget: params.sshTarget,
            sshOptions: params.sshOptions,
            autoBootstrap: params.autoBootstrap,
            diff: Boolean(params.diff),
            worktree: params.worktree,
          },
          senderWin,
        );
        return {
          opened: true,
          reused: opened.reused,
          repoName: opened.repoName,
          sshTarget: params.sshTarget,
        };
      } catch (err) {
        if (err instanceof RemoteBootstrapRequiredError) {
          return {
            opened: false,
            needsBootstrap: true,
            sshTarget: err.sshTarget,
            error: err.message,
          };
        }
        return {
          opened: false,
          sshTarget: params.sshTarget,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle("ide2:bootstrapRemoteSsh", async (evt) => {
    const { managed } = getWindowSession(evt.sender);
    if (!managed.backend.isRemote) {
      return { ok: true };
    }
    const ssh = managed.backend as SshWorkspaceBackend;
    try {
      await ssh.bootstrapAndConnect();
      if (managed.clientPluginHost) {
        await managed.clientPluginHost.start();
      }
      const snap = await ssh.getBootstrapSnapshot();
      managed.remotePluginSnapshot = {
        plugins: snap.plugins,
        decorations: snap.pluginDecorations,
        cards: snap.pluginCards,
      };
      broadcastToSession(managed, {
        type: "worktrees-updated",
        worktrees: snap.worktrees,
      });
      broadcastMergedPluginState(managed);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle("ide2:reconnectRemoteSsh", async (evt) => {
    const { managed } = getWindowSession(evt.sender);
    if (!managed.backend.isRemote) return { ok: true };
    const ssh = managed.backend as SshWorkspaceBackend;
    try {
      await ssh.reconnectNow();
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle("ide2:listRecentProjects", () => {
    return recentProjects.list();
  });

  ipcMain.handle("ide2:respondWalkthrough", async (evt, response: WalkthroughUserResponse) => {
    const { managed } = getWindowSession(evt.sender);
    await managed.backend.respondWalkthrough(response);
  });

  ipcMain.handle("ide2:endWalkthrough", async (evt, sessionId?: string) => {
    const { managed } = getWindowSession(evt.sender);
    await managed.backend.endWalkthrough(sessionId);
  });

  ipcMain.handle("ide2:getWalkthroughAgentPrompt", (evt) => {
    const { managed } = getWindowSession(evt.sender);
    return buildWalkthroughAgentPrompt(managed.backend.getLaunchContext().repoName);
  });

  ipcMain.handle("ide2:getReviewAgentPrompt", (evt) => {
    const { managed } = getWindowSession(evt.sender);
    return buildReviewAgentPrompt(managed.backend.getLaunchContext().repoName);
  });

  ipcMain.handle("ide2:completeOnboarding", () => {
    preferences.markOnboardingCompleted();
  });

  ipcMain.handle("ide2:sendReviewResponse", async (evt, response: ReviewUserResponse) => {
    const { managed } = getWindowSession(evt.sender);
    return managed.backend.sendReviewResponse(response);
  });

  /* ------------------------------------------------------------------------ */
  /* Dual-Affinity Plugin Routing (Option C: Local `client` + Remote `workspace`) */
  /* ------------------------------------------------------------------------ */

  ipcMain.handle("ide2:listPlugins", async (evt) => {
    const { managed } = getWindowSession(evt.sender);
    const merged = await getMergedPluginsForSession(managed);
    return merged.plugins;
  });

  ipcMain.handle(
    "ide2:installPlugin",
    async (evt, params: InstallPluginParams): Promise<InstallPluginResult> => {
      const { managed } = getWindowSession(evt.sender);
      if (managed.backend.isRemote && params.targetScope === "remote") {
        return managed.backend.installPlugin(params);
      }
      if (managed.clientPluginHost) {
        return managed.clientPluginHost.installPlugin(params);
      }
      return managed.backend.installPlugin(params);
    },
  );

  ipcMain.handle(
    "ide2:setPluginEnabled",
    async (
      evt,
      params: { pluginId: string; enabled: boolean; scope?: "local" | "remote" },
    ): Promise<InstalledPluginInfo[]> => {
      const { managed } = getWindowSession(evt.sender);
      if (managed.backend.isRemote && params.scope === "remote") {
        await managed.backend.setPluginEnabled(params);
      } else if (managed.clientPluginHost) {
        await managed.clientPluginHost.setPluginEnabled(params.pluginId, params.enabled);
      } else {
        await managed.backend.setPluginEnabled(params);
      }
      return (await getMergedPluginsForSession(managed)).plugins;
    },
  );

  ipcMain.handle(
    "ide2:updatePlugin",
    async (
      evt,
      params: { pluginId: string; scope?: "local" | "remote"; approvePermissions?: boolean },
    ): Promise<UpdatePluginResult> => {
      const { managed } = getWindowSession(evt.sender);
      if (managed.backend.isRemote && params.scope === "remote") {
        return managed.backend.updatePlugin(params);
      }
      if (managed.clientPluginHost) {
        return managed.clientPluginHost.updatePlugin(
          params.pluginId,
          params.approvePermissions,
        );
      }
      return managed.backend.updatePlugin(params);
    },
  );

  ipcMain.handle(
    "ide2:removePlugin",
    async (
      evt,
      params: { pluginId: string; scope?: "local" | "remote" },
    ): Promise<InstalledPluginInfo[]> => {
      const { managed } = getWindowSession(evt.sender);
      if (managed.backend.isRemote && params.scope === "remote") {
        await managed.backend.removePlugin(params);
      } else if (managed.clientPluginHost) {
        await managed.clientPluginHost.removePlugin(params.pluginId);
      } else {
        await managed.backend.removePlugin(params);
      }
      return (await getMergedPluginsForSession(managed)).plugins;
    },
  );

  ipcMain.handle(
    "ide2:callPluginRpc",
    async (
      evt,
      params: { pluginId: string; method: string; payload?: unknown; worktreePath?: string },
    ) => {
      const { managed } = getWindowSession(evt.sender);
      if (managed.clientPluginHost?.hasPlugin(params.pluginId)) {
        return managed.clientPluginHost.callPluginRpc(params);
      }
      return managed.backend.callPluginRpc(params);
    },
  );

  ipcMain.handle(
    "ide2:triggerPluginAction",
    async (
      evt,
      params: {
        pluginId: string;
        actionId: string;
        worktreePath?: string;
        filePath?: string;
        line?: number;
      },
    ) => {
      const { managed } = getWindowSession(evt.sender);
      if (managed.clientPluginHost?.hasPlugin(params.pluginId)) {
        await managed.clientPluginHost.triggerPluginAction(params);
        return;
      }
      await managed.backend.triggerPluginAction(params);
    },
  );

  ipcMain.handle(
    "ide2:respondPluginCard",
    async (evt, params: { sessionId: string; action: string; message?: string }) => {
      const { managed } = getWindowSession(evt.sender);
      if (managed.clientPluginHost) {
        const handled = await managed.clientPluginHost.respondPluginCard(params);
        if (handled) return;
      }
      await managed.backend.respondPluginCard(params);
    },
  );
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
    void openIdeWindow(flags, undefined, { deferSshBootstrap: true });
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
      await openIdeWindow(initialFlags, undefined, { deferSshBootstrap: true });
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
