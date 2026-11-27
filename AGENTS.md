# AGENTS.md

Guidance for AI coding agents working on `ide2` or authoring `ide2` plugins.

---

## 1. Repository Overview & Architecture

`ide2` is a strictly **read-only**, dark-mode-only desktop IDE built for the AI coding era (Electron + React 19 + TypeScript + Bun). Coding agents stay in the terminal and connect to `ide2` through plain CLI/IPC primitives (`ide2 review`, `ide2 tour`, `ide2 x`).

### Key Directories

| Path | Responsibility |
| --- | --- |
| `bin/ide2.mjs` | Unified CLI dispatcher (`ide2`, `ide2 ssh`, `ide2 plugin`, `ide2 x`, `ide2 review`, `ide2 tour`, `ide2 install-skill`, `ide2 daemon`) |
| `src/shared/protocol.ts` | Single source of truth for `Ide2Bridge`, `WorkspaceEvent`, diff/file/annotation/tour/review types |
| `src/shared/plugin-protocol.ts` | Plugin manifest schema, validator, GitHub install spec parser, SSH target parser |
| `src/shared/guard.ts` | Read-only containment guard (`insideWorktree`) and safe Git argument filter (`buildSafeGitArgs`) |
| `src/shared/rpc-stdio.ts` | Framing-safe NDJSON stdio RPC transport (`@@IDE2_DAEMON_V1@@` handshake) used by `ide2 ssh` |
| `src/main/backend/` | `WorkspaceBackend` interface, `LocalWorkspaceBackend` (pure Node, no Electron), `SshWorkspaceBackend` (remote SSH proxy + one-click bootstrap) |
| `src/main/services/` | `git.ts` (`WorktreeService`), `annotations.ts`, `watcher.ts`, `tour-server.ts` (Unix socket + mailbox IPC), `preferences.ts`, `recent-projects.ts` |
| `src/main/intel/` | Shiki cold-tonal syntax highlighter, Tree-sitter WASM symbol outline, ripgrep / `git grep` search, `worker.ts` |
| `src/main/plugins/` | `installer.ts` (GitHub clone + 40-char SHA lockfile), `bundler.ts` (`esbuild` + runtime shims), `plugin-host.ts`, `plugin-runner.ts` (`worker_threads`) |
| `src/plugin-sdk/` | Author-facing TypeScript SDK (`@expect2/ide2-plugin/server` and `@expect2/ide2-plugin/client`) |
| `src/preload/index.ts` | Context-isolated Electron `window.ide2` bridge |
| `src/renderer/` | React 19 UI (`App.tsx`, `views/`, `shell/`, `plugins/runtime-host.tsx`, `styles/ide.css`) |
| `plugins/pr-checks/` | Built-in reference plugin (**GitHub PR & CI Checks Lens**) |
| `tests/` | Vitest suite (`bun run test`) |

### Commands

```bash
bun run typecheck   # tsc --noEmit (checks src/, plugins/, tests/)
bun run build       # bun scripts/build.ts (main, preload, worker, plugin-runner, renderer, CLI)
bun run test        # bun --bun vitest run
bun start           # Build and launch ide2 on current repo
```

---

## 2. Core Non-Negotiable Invariants

1. **Strictly read-only & lock-safe:**
   - Never add file editing, staging, commits, rebases, or mutable text buffers.
   - Every repository Git call in `src/main/services/git.ts` MUST go through `buildSafeGitArgs(...)` in `src/shared/guard.ts`, which enforces `--no-optional-locks` and blocks mutating subcommands.
   - All `ide2` state (annotations, preferences, recent projects, IPC sockets, plugins, plugin data) lives outside user repositories under `~/.expect2-ide/` (overridable via `IDE2_HOME`).
2. **Pure-Node `WorkspaceBackend` parity:**
   - Never import `electron` inside `src/main/backend/local-backend.ts`, `src/main/services/`, `src/main/intel/`, `src/main/plugins/`, or `src/cli/`.
   - Any new workspace capability must work across both `LocalWorkspaceBackend` and `SshWorkspaceBackend` (`src/cli/daemon.ts` ↔ `src/main/backend/ssh-backend.ts`).
3. **Cold-tonal syntax palette:**
   - Code syntax tokens (`src/main/intel/highlight.ts`) strictly use cold slate/ice-blue/cyan/indigo hues — reserve green/yellow/red exclusively for diffs, status indicators, and diagnostic/plugin severity badges.
4. **Menu bar & naming:**
   - Always refer to the app as `ide2`. Keep the macOS menu bar strictly `ide2  Edit  View  Window` (no `File` menu).
5. **Terminology:**
   - Always use **plugin** / **plugins** (never "extension" / "extensions") in CLI output, UI labels, docs, and manifests.

---

## 3. Creating an `ide2` Plugin

Plugins extend what developers see about code/diffs and how terminal coding agents interact with `ide2`. A plugin is a small folder (or GitHub repo) containing `ide2-plugin.json` plus optional `server`, `client`, and `SKILL.md` files.

### Quickstart Workflow

```bash
ide2 plugin init ./my-plugin --id my-plugin
ide2 plugin install ./my-plugin --link
```

- `--link` symlinks `~/.expect2-ide/plugins/my-plugin` to `./my-plugin` and watches `./my-plugin/src/` so edits automatically re-bundle and hot-reload inside `ide2`.
- GitHub repos require **no `node_modules` and no pre-build step**: `ide2` clones the repo, pins its exact 40-char commit SHA in `~/.expect2-ide/plugins/lock.json`, and compiles TypeScript/TSX entrypoints into `.ide2-build/{server.cjs, client.js}` with `esbuild`.

### Directory Layout

```text
my-plugin/
├── ide2-plugin.json     # Required declarative manifest (parsed without executing code)
├── src/
│   ├── server.ts        # Optional backend running in isolated Node worker_threads
│   └── client.tsx       # Optional React 19 UI panels / custom file viewports
└── SKILL.md             # Optional agent skill synced by `ide2 install-skill`
```

### Manifest Schema (`ide2-plugin.json`)

Validated by `validatePluginManifest` in `src/shared/plugin-protocol.ts`:

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "description": "Concise description shown in Manage Plugins",
  "author": "your-name",
  "repository": "https://github.com/owner/repo",
  "host": "client",
  "engine": { "ide2": ">=0.1.0" },
  "permissions": ["exec"],
  "server": "./src/server.ts",
  "client": "./src/client.tsx",
  "skill": "./SKILL.md",
  "contributes": {
    "toolWindows": [
      { "id": "main-panel", "title": "My Panel", "slot": "bottom" }
    ],
    "viewports": [
      { "id": "trace-viewer", "title": "Trace Viewer", "filePatterns": ["*.trace.json"] }
    ],
    "actions": [
      { "id": "refresh", "title": "My Plugin: Refresh", "description": "Re-run analysis" }
    ],
    "cli": [
      { "subcommand": "decide", "description": "Present an interactive decision card" }
    ]
  }
}
```

#### Key Manifest Rules
- **`id`**: Must match `/^[a-z][a-z0-9-]{1,62}$/`.
- **`host`** (`"client"` | `"workspace"`, default `"client"`):
  - `"client"`: Runs on the user's laptop against whichever `WorkspaceBackend` is active (local or SSH). Use this for plugins relying on local credentials (`gh`, Linear/Sentry tokens) or pure read-only viewers so they work on every SSH host with zero remote setup.
  - `"workspace"`: Runs on the machine holding the Git repository (inside `ide2 daemon` during `ide2 ssh`). Use this for plugins that run repo-local toolchains (`cargo`, `pytest`, `expect2`) or expose `ide2 x <subcommand>` commands to remote terminal agents.
- **`permissions`**: Empty (`[]`) by default (strictly read-only workspace API + plugin-scoped JSON storage). Allowed permissions:
  - `"exec"` — unlocks `ctx.exec(command, args, opts)` (automatically injects `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, `GH_PROMPT_DISABLED=1`).
  - `"network"` — declares outbound network intent.
  - `"agent-ipc"` — unlocks `ctx.handleCli(subcommand, handler)` on `TourServer` (`ide2 x <subcommand>`).
- **`server` / `client` / `skill`**: Relative paths staying strictly inside the plugin directory (no `..` or absolute paths).

### Server Runtime API (`@expect2/ide2-plugin/server`)

Default-export `defineServerPlugin(async (ctx) => { ... return () => cleanup(); })`. See full type definitions in `src/plugin-sdk/server.ts`.

| Method / Property | Purpose |
| --- | --- |
| `ctx.pluginId`, `ctx.pluginName`, `ctx.dataDir` | Identity and isolated persistent storage directory (`~/.expect2-ide/plugin-data/<id>`) |
| `ctx.getLaunchContext()` | Repo name, `repoCommonDir`, `initialWorktreePath`, `remoteOriginUrl`, SSH metadata |
| `ctx.listWorktrees()`, `ctx.listFiles(wt)` | Read-only worktree and file discovery |
| `ctx.readFile(wt, path, diffScope?)` | Read-only file document (`lines`, `contentHash`, `language`, `lineGitMarkers`) |
| `ctx.getDiff(wt, path, scope)`, `ctx.listChangedFiles(wt, scope)` | Read-only Git diffs and changed file summaries |
| `ctx.setDecorations(sourceKey, decorations[])` / `ctx.clearDecorations(sourceKey?)` | Push `PluginLineDecoration` cards directly onto lines in `CodeViewport` and `DiffViewport` (no React required!) |
| `ctx.handleRpc(method, (payload, { worktreePath }) => ...)` | Register typed RPC handlers callable from `client.tsx` via `rpc.call(method, payload)` |
| `ctx.emitClientEvent(event, payload?)` | Push live server events to `client.tsx` (`subscribeServerEvent`) |
| `ctx.handleAction(actionId, ({ worktreePath, filePath, line }) => ...)` | Handle actions declared in `contributes.actions` (triggered from Search Everywhere `⇧⇧`) |
| `ctx.registerPromptEnricher(({ worktree, annotations, markdown }) => nextMarkdown)` | Append structured context to compiled review prompts (`⇧⌘C`, `ide2 --export`, `Send to Agent →`) |
| `ctx.handleCli(subcommand, ({ worktreePath, argv, stdin, wait, waitTimeoutMs, presentCardAndWait }) => ...)` | Requires `"agent-ipc"`. Handles `ide2 x <subcommand> ...`; `presentCardAndWait(...)` renders an interactive decision card in `ide2` and blocks the terminal agent until the developer responds |
| `ctx.onWorktreesUpdated(fn)`, `ctx.onAnnotationsUpdated(fn)` | Live subscriptions returning unsubscribe functions |
| `ctx.readStorageJson(key)`, `ctx.writeStorageJson(key, val)` | Atomic JSON persistence scoped to `ctx.dataDir` |
| `ctx.exec(command, args, opts?)` | Requires `"exec"`. Spawns external read-only command with `GIT_OPTIONAL_LOCKS=0` |

### Client Runtime API (`@expect2/ide2-plugin/client`)

Default-export `defineClientPlugin((ctx) => { ... })`. See `src/plugin-sdk/client.tsx` and `plugins/pr-checks/src/client.tsx`.

- Register declared tool windows and viewports matching `ide2-plugin.json`:
  - `ctx.registerToolWindow(id, Component)` — receives `{ worktree, worktrees, activeFilePath, activeLine, rpc, subscribeServerEvent, openFile, openExternalUrl, addReviewNote }`.
  - `ctx.registerViewport(id, Component)` — receives the same props plus `filePath`.
- Curated cold-tonal host primitives exported from `@expect2/ide2-plugin/client`:
  - `PluginPanel`, `PluginBadge`, `PluginButton`, `PluginEmptyState`.
- Standard React 19 hooks (`useState`, `useEffect`, `useCallback`, `useMemo`, etc.) and DOM/SVG/Canvas work normally inside your component — `ide2`'s bundler automatically maps `react`, `react/jsx-runtime`, and `@expect2/ide2-plugin/client` to the host's single shared runtime (`globalThis.__IDE2_PLUGIN_RUNTIME__`), and every plugin renders inside `<PluginErrorBoundary>`.
- Use `ide2` CSS variables (`--paper`, `--wash`, `--screen`, `--faint`, `--border-strong`, `--ink`, `--dim`, `--safe`, `--unknown`, `--danger`, `--mono`, `--ui-font`) so custom markup matches the dark theme seamlessly.

### Reference Implementation

Study `plugins/pr-checks/` (**GitHub PR & CI Checks Lens**) for a complete, production-tested example using `ctx.getLaunchContext().remoteOriginUrl`, `ctx.exec("gh", ...)`, `ctx.setDecorations(...)`, `ctx.registerPromptEnricher(...)`, `ctx.handleRpc(...)`, `ctx.emitClientEvent(...)`, and a `PluginPanel` React client.

### Testing & Publishing a Plugin Repo

1. Scaffold and link locally: `ide2 plugin init ./my-plugin && ide2 plugin install ./my-plugin --link`.
2. Support an env-var binary override if your plugin wraps an external CLI (e.g. `process.env.IDE2_GH_BIN || "gh"`) so unit tests can run deterministically without network access.
3. Push the plugin folder (containing `ide2-plugin.json` at repo root or a monorepo subdirectory) to GitHub. Users install it with `ide2 plugin install owner/repo` (or `owner/repo/subdir#v0.1.0`).
