/**
 * Shared Plugin & Remote SSH Protocol Definitions for `ide2`.
 * Pure runtime-neutral types + parsers shared across Main, Daemon, Worker, CLI, and Renderer.
 */

export type RemoteConnectionStatus =
  | "local"
  | "connecting"
  | "bootstrapping"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";

export interface RemoteConnectionState {
  isRemote: boolean;
  status: RemoteConnectionStatus;
  /** Canonical target string, e.g. `user@host:/srv/repo` */
  sshTarget?: string;
  /** SSH host authority, e.g. `user@host` or `host` */
  sshHost?: string;
  /** Optional port parsed from ssh:// URL or options */
  sshPort?: number;
  /** Optional raw ssh flags */
  sshOptions?: string;
  /** Remote path on the SSH machine, e.g. `/srv/repo` or `~/project` */
  remotePath?: string;
  /** Latest measured round-trip ping latency in ms */
  rttMs?: number;
  /** Set to true when remote host does not have a compatible ide2 daemon runtime yet */
  needsBootstrap?: boolean;
  /** Human-readable error message when status is `error` or `reconnecting` */
  error?: string;
}

export interface ParsedSshTarget {
  /** Normalized display target `user@host:/path` */
  canonicalTarget: string;
  /** Recent-projects storage URI `ssh://user@host/path` */
  uri: string;
  /** Host spec passed to `ssh` (e.g. `ubuntu@devbox`) */
  host: string;
  /** Optional port from `ssh://user@host:2222/...` */
  port?: number;
  /** Remote filesystem path (`~/repo` or `/srv/repo`) */
  remotePath: string;
  /** Optional 1-based line suffix (`user@host:/repo/src/a.ts:42`) */
  line?: number;
  /** Optional 1-based column suffix */
  column?: number;
}

/**
 * Parses SSH target strings such as:
 * - `user@host:/abs/path`
 * - `user@host:~/rel/path`
 * - `user@host:rel/path`
 * - `ssh://user@host:2222/abs/path`
 * - Optional `:line[:col]` suffix on file targets
 */
export function parseSshTarget(rawInput: string): ParsedSshTarget {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw new Error("SSH target cannot be empty. Expected `user@host:/path/to/repo`.");
  }

  let host = "";
  let port: number | undefined;
  let rawPathWithLoc = "";

  if (trimmed.startsWith("ssh://")) {
    const parsedUrl = new URL(trimmed);
    const userPrefix = parsedUrl.username
      ? `${decodeURIComponent(parsedUrl.username)}@`
      : "";
    host = `${userPrefix}${parsedUrl.hostname}`;
    if (parsedUrl.port) {
      const p = Number.parseInt(parsedUrl.port, 10);
      if (Number.isFinite(p) && p > 0) port = p;
    }
    rawPathWithLoc = decodeURIComponent(parsedUrl.pathname || "/");
    // Support `ssh://user@host/~/repo` -> `~/repo`
    if (rawPathWithLoc.startsWith("/~/")) {
      rawPathWithLoc = rawPathWithLoc.slice(1);
    }
  } else {
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx <= 0) {
      throw new Error(
        `Invalid SSH target "${trimmed}". Expected \`user@host:/path/to/repo\` or \`ssh://user@host/path\`.`,
      );
    }
    host = trimmed.slice(0, colonIdx).trim();
    rawPathWithLoc = trimmed.slice(colonIdx + 1).trim();
  }

  if (!host || /\s/.test(host) || host.startsWith("-")) {
    throw new Error(`Invalid SSH host "${host}".`);
  }
  if (!rawPathWithLoc) {
    throw new Error(`Missing remote repository path in "${trimmed}".`);
  }

  let remotePath = rawPathWithLoc;
  let line: number | undefined;
  let column: number | undefined;

  const locMatch = /^(.*?):(\d+)(?::(\d+))?$/.exec(rawPathWithLoc);
  if (locMatch && locMatch[1]) {
    remotePath = locMatch[1];
    line = Number.parseInt(locMatch[2]!, 10);
    column = locMatch[3] ? Number.parseInt(locMatch[3], 10) : undefined;
  }

  const portSegment = port ? `:${port}` : "";
  const uriPath = remotePath.startsWith("/") ? remotePath : `/${remotePath}`;
  return {
    canonicalTarget: `${host}:${remotePath}`,
    uri: `ssh://${host}${portSegment}${uriPath}`,
    host,
    port,
    remotePath,
    line,
    column,
  };
}

/* -------------------------------------------------------------------------- */
/* Plugin Manifest & Runtime Contracts                                        */
/* -------------------------------------------------------------------------- */

export type PluginHostAffinity = "client" | "workspace";
export type PluginPermission = "exec" | "network" | "agent-ipc";
export type PluginDockSlot = "left" | "right" | "bottom";

export interface PluginToolWindowContribution {
  id: string;
  title: string;
  slot: PluginDockSlot;
  badge?: string;
}

export interface PluginViewportContribution {
  id: string;
  title: string;
  /** Glob-like suffix/pattern matches such as `*.openapi.yaml`, `*.trace.json`, or `pr-overview` */
  filePatterns: string[];
}

export interface PluginActionContribution {
  id: string;
  title: string;
  description?: string;
}

export interface PluginCliContribution {
  subcommand: string;
  description: string;
}

export interface Ide2PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  repository?: string;
  /**
   * Execution affinity when connected over `ide2 ssh`:
   * - `"client"` (default): runs on your local machine (uses local `gh` / Keychain credentials, works on every SSH box immediately).
   * - `"workspace"`: runs on whichever machine holds the Git repository (next to remote build tools & terminal coding agents).
   */
  host?: PluginHostAffinity;
  engine?: {
    ide2?: string;
  };
  permissions?: PluginPermission[];
  /** Relative path to server entrypoint (e.g. `./src/server.ts` or `./dist/server.cjs`) */
  server?: string;
  /** Relative path to client React entrypoint (e.g. `./src/client.tsx` or `./dist/client.js`) */
  client?: string;
  /** Optional relative path to `SKILL.md` exposed to coding agents on `ide2 install-skill` */
  skill?: string;
  contributes?: {
    toolWindows?: PluginToolWindowContribution[];
    viewports?: PluginViewportContribution[];
    actions?: PluginActionContribution[];
    cli?: PluginCliContribution[];
  };
}

export type PluginDecorationSeverity = "info" | "warning" | "error" | "success";

export interface PluginLineDecoration {
  id: string;
  pluginId: string;
  pluginName: string;
  worktreePath: string;
  filePath: string;
  side?: "new" | "old";
  startLine: number;
  endLine?: number;
  severity: PluginDecorationSeverity;
  /** Short 1-4 char token shown in the gutter/pill (e.g. `CI`, `✕`, `✓`, `!`) */
  gutterBadge?: string;
  /** Concise single-line summary rendered inline at the end of the code/diff line */
  title: string;
  /** Detailed Markdown explanation shown on hover/expand */
  hoverMarkdown?: string;
  /** Optional external link (e.g. GitHub Actions check run URL) */
  url?: string;
}

export interface PluginAgentCardChoice {
  id: string;
  label: string;
  kind?: "primary" | "danger" | "default";
}

export interface PluginAgentCardState {
  sessionId: string;
  pluginId: string;
  pluginName: string;
  subcommand: string;
  worktreePath: string;
  title: string;
  markdown: string;
  choices: PluginAgentCardChoice[];
  allowFreeformReply?: boolean;
  awaitingUser: boolean;
  createdAt: number;
}

export interface InstalledPluginSource {
  kind: "github" | "local" | "builtin";
  /** Original install specifier, e.g. `expect2/plugin-pr-checks` or `./my-plugin` */
  spec: string;
  repoUrl?: string;
  subdir?: string;
  ref?: string;
  commitSha?: string;
  linked?: boolean;
}

export interface InstalledPluginInfo {
  id: string;
  manifest: Ide2PluginManifest;
  enabled: boolean;
  /** `"local"` = installed in laptop's `~/.expect2-ide/plugins`; `"remote"` = installed on remote SSH host */
  scope: "local" | "remote";
  source: InstalledPluginSource;
  installedAt: number;
  updatedAt: number;
  grantedPermissions: PluginPermission[];
  hasClientBundle: boolean;
  hasServerBundle: boolean;
  error?: string;
}

export interface InstallPluginParams {
  spec: string;
  ref?: string;
  targetScope?: "local" | "remote";
  approvePermissions?: boolean;
  linkLocal?: boolean;
}

export interface InstallPluginResult {
  installed?: InstalledPluginInfo;
  requiresPermissionApproval?: {
    manifest: Ide2PluginManifest;
    commitSha?: string;
    requestedPermissions: PluginPermission[];
  };
  error?: string;
}

export interface UpdatePluginResult {
  updated?: InstalledPluginInfo;
  upToDate?: boolean;
  requiresPermissionApproval?: {
    manifest: Ide2PluginManifest;
    commitSha?: string;
    requestedPermissions: PluginPermission[];
  };
  error?: string;
}

export interface ParsedGitHubPluginSpec {
  kind: "github" | "git-url" | "local";
  displaySpec: string;
  cloneUrl?: string;
  owner?: string;
  repo?: string;
  subdir?: string;
  ref?: string;
  localPath?: string;
}

const VALID_PLUGIN_ID = /^[a-z][a-z0-9-]{1,62}$/;
const VALID_PERMISSIONS = new Set<PluginPermission>(["exec", "network", "agent-ipc"]);
const VALID_SLOTS = new Set<PluginDockSlot>(["left", "right", "bottom"]);

export function validatePluginManifest(raw: unknown): Ide2PluginManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("ide2-plugin.json must be a JSON object.");
  }
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  if (!VALID_PLUGIN_ID.test(id)) {
    throw new Error(
      `Invalid plugin id "${id}". Must match /^[a-z][a-z0-9-]{1,62}$/.`,
    );
  }
  const name = typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : id;
  const version =
    typeof obj.version === "string" && obj.version.trim() ? obj.version.trim() : "0.1.0";

  const hostRaw = obj.host;
  if (hostRaw !== undefined && hostRaw !== "client" && hostRaw !== "workspace") {
    throw new Error(`Invalid plugin host "${String(hostRaw)}". Expected "client" or "workspace".`);
  }
  const host: PluginHostAffinity = hostRaw === "workspace" ? "workspace" : "client";

  const permissions: PluginPermission[] = [];
  if (obj.permissions !== undefined) {
    if (!Array.isArray(obj.permissions)) {
      throw new Error(`"permissions" in ide2-plugin.json must be an array.`);
    }
    for (const p of obj.permissions) {
      if (typeof p !== "string" || !VALID_PERMISSIONS.has(p as PluginPermission)) {
        throw new Error(
          `Unknown plugin permission "${String(p)}". Allowed: exec, network, agent-ipc.`,
        );
      }
      if (!permissions.includes(p as PluginPermission)) {
        permissions.push(p as PluginPermission);
      }
    }
  }

  const assertSafeRelPath = (field: string, val: unknown): string | undefined => {
    if (val === undefined) return undefined;
    if (typeof val !== "string" || !val.trim()) {
      throw new Error(`"${field}" must be a non-empty relative path string.`);
    }
    const norm = val.trim().replace(/\\/g, "/");
    if (norm.startsWith("/") || norm.split("/").includes("..")) {
      throw new Error(`"${field}" path "${val}" must stay inside the plugin directory.`);
    }
    return norm;
  };

  const server = assertSafeRelPath("server", obj.server);
  const client = assertSafeRelPath("client", obj.client);
  const skill = assertSafeRelPath("skill", obj.skill);

  let contributes: Ide2PluginManifest["contributes"];
  if (obj.contributes && typeof obj.contributes === "object" && !Array.isArray(obj.contributes)) {
    const cObj = obj.contributes as Record<string, unknown>;
    const toolWindows: PluginToolWindowContribution[] = [];
    if (Array.isArray(cObj.toolWindows)) {
      for (const tw of cObj.toolWindows) {
        if (tw && typeof tw === "object") {
          const t = tw as Record<string, unknown>;
          const twId = typeof t.id === "string" ? t.id.trim() : "";
          const twTitle = typeof t.title === "string" ? t.title.trim() : "";
          const twSlot = t.slot as PluginDockSlot;
          if (!twId || !twTitle || !VALID_SLOTS.has(twSlot)) {
            throw new Error(`Invalid toolWindows contribution in plugin "${id}".`);
          }
          toolWindows.push({
            id: twId,
            title: twTitle,
            slot: twSlot,
            badge: typeof t.badge === "string" ? t.badge : undefined,
          });
        }
      }
    }

    const viewports: PluginViewportContribution[] = [];
    if (Array.isArray(cObj.viewports)) {
      for (const vp of cObj.viewports) {
        if (vp && typeof vp === "object") {
          const v = vp as Record<string, unknown>;
          const vpId = typeof v.id === "string" ? v.id.trim() : "";
          const vpTitle = typeof v.title === "string" ? v.title.trim() : "";
          const patterns = Array.isArray(v.filePatterns)
            ? v.filePatterns.filter((x): x is string => typeof x === "string" && x.length > 0)
            : [];
          if (!vpId || !vpTitle) {
            throw new Error(`Invalid viewports contribution in plugin "${id}".`);
          }
          viewports.push({ id: vpId, title: vpTitle, filePatterns: patterns });
        }
      }
    }

    const actions: PluginActionContribution[] = [];
    if (Array.isArray(cObj.actions)) {
      for (const act of cObj.actions) {
        if (act && typeof act === "object") {
          const a = act as Record<string, unknown>;
          const aId = typeof a.id === "string" ? a.id.trim() : "";
          const aTitle = typeof a.title === "string" ? a.title.trim() : "";
          if (!aId || !aTitle) {
            throw new Error(`Invalid actions contribution in plugin "${id}".`);
          }
          actions.push({
            id: aId,
            title: aTitle,
            description: typeof a.description === "string" ? a.description : undefined,
          });
        }
      }
    }

    const cli: PluginCliContribution[] = [];
    if (Array.isArray(cObj.cli)) {
      for (const cmd of cObj.cli) {
        if (cmd && typeof cmd === "object") {
          const k = cmd as Record<string, unknown>;
          const sub = typeof k.subcommand === "string" ? k.subcommand.trim() : "";
          if (!sub || !/^[a-z][a-z0-9-]*$/.test(sub)) {
            throw new Error(`Invalid cli subcommand "${sub}" in plugin "${id}".`);
          }
          cli.push({
            subcommand: sub,
            description: typeof k.description === "string" ? k.description : "",
          });
        }
      }
    }

    contributes = {
      ...(toolWindows.length > 0 ? { toolWindows } : {}),
      ...(viewports.length > 0 ? { viewports } : {}),
      ...(actions.length > 0 ? { actions } : {}),
      ...(cli.length > 0 ? { cli } : {}),
    };
  }

  return {
    id,
    name,
    version,
    description: typeof obj.description === "string" ? obj.description : undefined,
    author: typeof obj.author === "string" ? obj.author : undefined,
    repository: typeof obj.repository === "string" ? obj.repository : undefined,
    host,
    engine:
      obj.engine && typeof obj.engine === "object"
        ? { ide2: typeof (obj.engine as Record<string, unknown>).ide2 === "string" ? ((obj.engine as Record<string, unknown>).ide2 as string) : undefined }
        : undefined,
    permissions,
    server,
    client,
    skill,
    contributes,
  };
}

/**
 * Parses plugin installation specifiers:
 * - `owner/repo`
 * - `owner/repo#v0.2.0` or `owner/repo@sha`
 * - `owner/repo/packages/subplugin#main`
 * - `https://github.com/owner/repo[.git][#ref]`
 * - `https://github.com/owner/repo/tree/<ref>/<subdir>`
 * - `file:///abs/repo.git` or `/local/path` or `./local/path`
 */
export function parsePluginInstallSpec(rawSpec: string, explicitRef?: string): ParsedGitHubPluginSpec {
  const trimmed = rawSpec.trim();
  if (!trimmed) {
    throw new Error("Plugin specifier cannot be empty.");
  }

  // Local directory path (`./foo`, `../foo`, `/abs/foo`, `~/foo`)
  if (
    trimmed.startsWith(".") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("~/") ||
    /^[A-Za-z]:[\\/]/.test(trimmed)
  ) {
    return {
      kind: "local",
      displaySpec: trimmed,
      localPath: trimmed,
    };
  }

  // Full git/file/ssh URL
  if (
    trimmed.startsWith("https://") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("git@") ||
    trimmed.startsWith("ssh://") ||
    trimmed.startsWith("file://")
  ) {
    const hashIdx = trimmed.indexOf("#");
    const baseUrl = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
    const hashRef = hashIdx >= 0 ? trimmed.slice(hashIdx + 1).trim() : undefined;

    // Support pasting `https://github.com/owner/repo/tree/main/plugins/foo`
    const ghTreeMatch = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.+))?$/i.exec(
      baseUrl,
    );
    if (ghTreeMatch) {
      const owner = ghTreeMatch[1]!;
      const repo = ghTreeMatch[2]!.replace(/\.git$/i, "");
      const treeRef = ghTreeMatch[3]!;
      const subdir = ghTreeMatch[4]?.replace(/^\/+|\/+$/g, "");
      return {
        kind: "github",
        displaySpec: subdir ? `${owner}/${repo}/${subdir}` : `${owner}/${repo}`,
        cloneUrl: `https://github.com/${owner}/${repo}.git`,
        owner,
        repo,
        subdir: subdir || undefined,
        ref: explicitRef || hashRef || treeRef,
      };
    }

    const ghRootMatch = /^https?:\/\/github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?\/?$/i.exec(baseUrl);
    if (ghRootMatch) {
      const owner = ghRootMatch[1]!;
      const repo = ghRootMatch[2]!;
      return {
        kind: "github",
        displaySpec: `${owner}/${repo}`,
        cloneUrl: `https://github.com/${owner}/${repo}.git`,
        owner,
        repo,
        ref: explicitRef || hashRef || undefined,
      };
    }

    return {
      kind: "git-url",
      displaySpec: baseUrl,
      cloneUrl: baseUrl,
      ref: explicitRef || hashRef || undefined,
    };
  }

  // Shorthand `owner/repo[/subdir][#ref | @ref]`
  let pathPart = trimmed;
  let parsedRef: string | undefined;
  const hashIdx = pathPart.indexOf("#");
  if (hashIdx >= 0) {
    parsedRef = pathPart.slice(hashIdx + 1).trim();
    pathPart = pathPart.slice(0, hashIdx);
  } else {
    const atIdx = pathPart.indexOf("@");
    if (atIdx > 0) {
      parsedRef = pathPart.slice(atIdx + 1).trim();
      pathPart = pathPart.slice(0, atIdx);
    }
  }

  const segs = pathPart.split("/").filter(Boolean);
  if (segs.length < 2) {
    throw new Error(
      `Invalid plugin specifier "${rawSpec}". Expected GitHub \`owner/repo\`, URL, or \`./local-path\`.`,
    );
  }
  const owner = segs[0]!;
  const repo = segs[1]!.replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`Invalid GitHub owner/repo "${owner}/${repo}".`);
  }
  const subdir = segs.length > 2 ? segs.slice(2).join("/") : undefined;
  if (subdir && subdir.split("/").includes("..")) {
    throw new Error(`Invalid plugin subdirectory "${subdir}".`);
  }

  return {
    kind: "github",
    displaySpec: subdir ? `${owner}/${repo}/${subdir}` : `${owner}/${repo}`,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
    owner,
    repo,
    subdir,
    ref: explicitRef || parsedRef || undefined,
  };
}

/**
 * Extracts GitHub `owner/repo` slug from any standard HTTPS or SSH git remote URL.
 */
export function parseGitHubOwnerRepoFromRemoteUrl(remoteUrl?: string): {
  owner: string;
  repo: string;
  slug: string;
} | null {
  if (!remoteUrl) return null;
  const trimmed = remoteUrl.trim();
  const httpsMatch = /^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(
    trimmed,
  );
  if (httpsMatch) {
    const owner = httpsMatch[1]!;
    const repo = httpsMatch[2]!;
    return { owner, repo, slug: `${owner}/${repo}` };
  }
  const sshMatch = /^(?:git@|ssh:\/\/git@)github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(
    trimmed,
  );
  if (sshMatch) {
    const owner = sshMatch[1]!;
    const repo = sshMatch[2]!;
    return { owner, repo, slug: `${owner}/${repo}` };
  }
  return null;
}
