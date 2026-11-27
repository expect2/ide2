import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  parsePluginInstallSpec,
  validatePluginManifest,
  type Ide2PluginManifest,
  type InstalledPluginInfo,
  type InstalledPluginSource,
  type InstallPluginParams,
  type InstallPluginResult,
  type PluginPermission,
  type UpdatePluginResult,
} from "../../shared/protocol.js";
import { bundlePluginDirectory } from "./bundler.js";

const execFileAsync = promisify(execFile);

export interface PluginLockRecord {
  id: string;
  enabled: boolean;
  source: InstalledPluginSource;
  installedAt: number;
  updatedAt: number;
  grantedPermissions: PluginPermission[];
}

interface PluginLockFile {
  version: 1;
  plugins: Record<string, PluginLockRecord>;
}

function expandHomePath(rawPath: string): string {
  if (rawPath === "~") return homedir();
  if (rawPath.startsWith("~/")) return join(homedir(), rawPath.slice(2));
  return resolve(rawPath);
}

async function runInstallerGit(cwd: string, args: readonly string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
  };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_INDEX_FILE;

  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    env,
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8",
  });
  return stdout.trim();
}

/**
 * Manages plugin installation from GitHub repositories (with immutable 40-char commit SHA pins),
 * local directory development links, permission approval gates, updates, and `ide2 plugin init`.
 */
export class PluginInstaller {
  readonly pluginsDir: string;
  readonly lockFilePath: string;

  constructor(
    storageRoot: string = process.env.IDE2_HOME ?? join(homedir(), ".expect2-ide"),
    private readonly scope: "local" | "remote" = "local",
  ) {
    this.pluginsDir = join(storageRoot, "plugins");
    this.lockFilePath = join(this.pluginsDir, "lock.json");
  }

  getPluginDir(pluginId: string): string {
    return join(this.pluginsDir, pluginId);
  }

  readLockFile(): PluginLockFile {
    try {
      if (!existsSync(this.lockFilePath)) {
        return { version: 1, plugins: {} };
      }
      const parsed = JSON.parse(readFileSync(this.lockFilePath, "utf8")) as PluginLockFile;
      if (!parsed || typeof parsed !== "object" || typeof parsed.plugins !== "object") {
        return { version: 1, plugins: {} };
      }
      return parsed;
    } catch {
      return { version: 1, plugins: {} };
    }
  }

  private writeLockFile(lock: PluginLockFile): void {
    mkdirSync(this.pluginsDir, { recursive: true });
    const tmp = `${this.lockFilePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
    renameSync(tmp, this.lockFilePath);
  }

  listInstalled(): InstalledPluginInfo[] {
    const lock = this.readLockFile();
    const results: InstalledPluginInfo[] = [];

    for (const [id, rec] of Object.entries(lock.plugins)) {
      const pluginDir = this.getPluginDir(id);
      const manifestPath = join(pluginDir, "ide2-plugin.json");
      if (!existsSync(manifestPath)) continue;

      try {
        const rawManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
        const manifest = validatePluginManifest(rawManifest);
        const hasServerBundle = existsSync(join(pluginDir, ".ide2-build/server.cjs"));
        const hasClientBundle = existsSync(join(pluginDir, ".ide2-build/client.js"));
        results.push({
          id: manifest.id,
          manifest,
          enabled: rec.enabled,
          scope: this.scope,
          source: rec.source,
          installedAt: rec.installedAt,
          updatedAt: rec.updatedAt,
          grantedPermissions: rec.grantedPermissions ?? [],
          hasClientBundle,
          hasServerBundle,
        });
      } catch (err) {
        results.push({
          id,
          manifest: { id, name: id, version: "0.0.0" },
          enabled: false,
          scope: this.scope,
          source: rec.source,
          installedAt: rec.installedAt,
          updatedAt: rec.updatedAt,
          grantedPermissions: rec.grantedPermissions ?? [],
          hasClientBundle: false,
          hasServerBundle: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  }

  /**
   * Installs a plugin from a GitHub repo (`owner/repo[#ref]`, URL, monorepo subdir)
   * or a local path (`./my-plugin`, with optional `--link`).
   */
  async install(params: InstallPluginParams): Promise<InstallPluginResult> {
    try {
      const parsed = parsePluginInstallSpec(params.spec, params.ref);
      mkdirSync(this.pluginsDir, { recursive: true });

      if (parsed.kind === "local" && parsed.localPath) {
        const absLocal = expandHomePath(parsed.localPath);
        if (!existsSync(absLocal)) {
          return { error: `Local plugin directory does not exist: ${absLocal}` };
        }
        const manifest = this.readAndValidateManifest(absLocal);
        const requested = manifest.permissions ?? [];
        if (requested.length > 0 && !params.approvePermissions) {
          return {
            requiresPermissionApproval: {
              manifest,
              requestedPermissions: requested,
            },
          };
        }

        const dstDir = this.getPluginDir(manifest.id);
        this.removeExistingDirOrSymlink(dstDir);

        if (params.linkLocal) {
          await bundlePluginDirectory(absLocal, manifest);
          symlinkSync(absLocal, dstDir, "dir");
        } else {
          cpSync(absLocal, dstDir, {
            recursive: true,
            filter: (src) => !src.includes("node_modules") && !src.endsWith("/.git"),
          });
          await bundlePluginDirectory(dstDir, manifest);
        }

        const now = Date.now();
        const lock = this.readLockFile();
        const existing = lock.plugins[manifest.id];
        lock.plugins[manifest.id] = {
          id: manifest.id,
          enabled: existing ? existing.enabled : true,
          source: {
            kind: "local",
            spec: absLocal,
            linked: Boolean(params.linkLocal),
          },
          installedAt: existing?.installedAt ?? now,
          updatedAt: now,
          grantedPermissions: requested,
        };
        this.writeLockFile(lock);

        const installed = this.listInstalled().find((p) => p.id === manifest.id);
        return { installed };
      }

      // GitHub or Git URL clone with immutable 40-char commit SHA pinning
      const cloneUrl = parsed.cloneUrl!;
      const stageRoot = mkdtempSync(join(tmpdir(), "ide2-plugin-install-"));
      const repoDir = join(stageRoot, "repo");

      try {
        await this.cloneAndCheckout(cloneUrl, repoDir, parsed.ref);
        const commitSha = await runInstallerGit(repoDir, ["rev-parse", "HEAD"]);
        const pluginSourceDir = parsed.subdir ? resolve(repoDir, parsed.subdir) : repoDir;
        if (!existsSync(pluginSourceDir)) {
          return {
            error: `Subdirectory "${parsed.subdir}" was not found in ${parsed.displaySpec}.`,
          };
        }

        const manifest = this.readAndValidateManifest(pluginSourceDir);
        const requested = manifest.permissions ?? [];
        if (requested.length > 0 && !params.approvePermissions) {
          return {
            requiresPermissionApproval: {
              manifest,
              commitSha,
              requestedPermissions: requested,
            },
          };
        }

        const stagedFinal = join(stageRoot, "final");
        cpSync(pluginSourceDir, stagedFinal, {
          recursive: true,
          filter: (src) => !src.endsWith("/.git") && !src.includes("/.git/"),
        });

        await bundlePluginDirectory(stagedFinal, manifest);

        const dstDir = this.getPluginDir(manifest.id);
        this.removeExistingDirOrSymlink(dstDir);
        cpSync(stagedFinal, dstDir, { recursive: true });

        const now = Date.now();
        const lock = this.readLockFile();
        const existing = lock.plugins[manifest.id];
        lock.plugins[manifest.id] = {
          id: manifest.id,
          enabled: existing ? existing.enabled : true,
          source: {
            kind: "github",
            spec: parsed.displaySpec,
            repoUrl: cloneUrl,
            subdir: parsed.subdir,
            ref: parsed.ref,
            commitSha,
          },
          installedAt: existing?.installedAt ?? now,
          updatedAt: now,
          grantedPermissions: requested,
        };
        this.writeLockFile(lock);

        const installed = this.listInstalled().find((p) => p.id === manifest.id);
        return { installed };
      } finally {
        rmSync(stageRoot, { recursive: true, force: true });
      }
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async update(pluginId: string, approvePermissions = false): Promise<UpdatePluginResult> {
    const lock = this.readLockFile();
    const rec = lock.plugins[pluginId];
    if (!rec) {
      return { error: `Plugin "${pluginId}" is not installed.` };
    }

    if (rec.source.kind === "local") {
      const res = await this.install({
        spec: rec.source.spec,
        linkLocal: rec.source.linked,
        approvePermissions: true,
      });
      if (res.error) return { error: res.error };
      return { updated: res.installed };
    }

    if (!rec.source.repoUrl) {
      return { error: `Plugin "${pluginId}" cannot be updated (no repository URL recorded).` };
    }

    const stageRoot = mkdtempSync(join(tmpdir(), "ide2-plugin-update-"));
    const repoDir = join(stageRoot, "repo");
    try {
      await this.cloneAndCheckout(rec.source.repoUrl, repoDir, rec.source.ref);
      const nextSha = await runInstallerGit(repoDir, ["rev-parse", "HEAD"]);
      if (rec.source.commitSha && nextSha === rec.source.commitSha) {
        const current = this.listInstalled().find((p) => p.id === pluginId);
        return { updated: current, upToDate: true };
      }

      const pluginSourceDir = rec.source.subdir ? resolve(repoDir, rec.source.subdir) : repoDir;
      const manifest = this.readAndValidateManifest(pluginSourceDir);
      const requested = manifest.permissions ?? [];
      const previouslyGranted = new Set(rec.grantedPermissions ?? []);
      const newlyAdded = requested.filter((p) => !previouslyGranted.has(p));

      if (newlyAdded.length > 0 && !approvePermissions) {
        return {
          requiresPermissionApproval: {
            manifest,
            commitSha: nextSha,
            requestedPermissions: requested,
          },
        };
      }

      const stagedFinal = join(stageRoot, "final");
      cpSync(pluginSourceDir, stagedFinal, {
        recursive: true,
        filter: (src) => !src.endsWith("/.git") && !src.includes("/.git/"),
      });
      await bundlePluginDirectory(stagedFinal, manifest);

      const dstDir = this.getPluginDir(pluginId);
      this.removeExistingDirOrSymlink(dstDir);
      cpSync(stagedFinal, dstDir, { recursive: true });

      rec.source.commitSha = nextSha;
      rec.updatedAt = Date.now();
      rec.grantedPermissions = requested;
      this.writeLockFile(lock);

      const updated = this.listInstalled().find((p) => p.id === pluginId);
      return { updated, upToDate: false };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    } finally {
      rmSync(stageRoot, { recursive: true, force: true });
    }
  }

  setEnabled(pluginId: string, enabled: boolean): InstalledPluginInfo[] {
    const lock = this.readLockFile();
    const rec = lock.plugins[pluginId];
    if (rec) {
      rec.enabled = enabled;
      rec.updatedAt = Date.now();
      this.writeLockFile(lock);
    }
    return this.listInstalled();
  }

  remove(pluginId: string): InstalledPluginInfo[] {
    const lock = this.readLockFile();
    delete lock.plugins[pluginId];
    this.writeLockFile(lock);
    const dstDir = this.getPluginDir(pluginId);
    this.removeExistingDirOrSymlink(dstDir);
    return this.listInstalled();
  }

  /**
   * Ensures a built-in reference plugin directory is registered & bundled on first launch
   * (without overwriting user enable/disable state if already registered).
   */
  async ensureBuiltinPlugin(builtinSourceDir: string): Promise<void> {
    if (!existsSync(join(builtinSourceDir, "ide2-plugin.json"))) return;
    const manifest = this.readAndValidateManifest(builtinSourceDir);
    const lock = this.readLockFile();
    const existing = lock.plugins[manifest.id];
    const dstDir = this.getPluginDir(manifest.id);

    if (existing && existing.source.kind !== "builtin") {
      // User replaced it with a custom/GitHub install; leave untouched
      return;
    }

    const needsInstall =
      !existing ||
      !existsSync(join(dstDir, ".ide2-build/server.cjs")) ||
      this.readInstalledVersionSafe(dstDir) !== manifest.version;

    if (!needsInstall) return;

    mkdirSync(this.pluginsDir, { recursive: true });
    this.removeExistingDirOrSymlink(dstDir);
    cpSync(builtinSourceDir, dstDir, { recursive: true });
    await bundlePluginDirectory(dstDir, manifest);

    const now = Date.now();
    lock.plugins[manifest.id] = {
      id: manifest.id,
      enabled: existing ? existing.enabled : true,
      source: {
        kind: "builtin",
        spec: `builtin:${manifest.id}`,
        repository: manifest.repository,
      } as InstalledPluginSource,
      installedAt: existing?.installedAt ?? now,
      updatedAt: now,
      grantedPermissions: manifest.permissions ?? [],
    };
    this.writeLockFile(lock);
  }

  private readInstalledVersionSafe(dir: string): string | null {
    try {
      const m = JSON.parse(readFileSync(join(dir, "ide2-plugin.json"), "utf8")) as {
        version?: string;
      };
      return m.version ?? null;
    } catch {
      return null;
    }
  }

  private readAndValidateManifest(dir: string): Ide2PluginManifest {
    const manifestPath = join(dir, "ide2-plugin.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`No ide2-plugin.json found in ${dir}`);
    }
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    return validatePluginManifest(parsed);
  }

  private removeExistingDirOrSymlink(targetPath: string): void {
    try {
      const st = lstatSync(targetPath);
      if (st.isSymbolicLink() || st.isFile()) {
        rmSync(targetPath, { force: true });
      } else {
        rmSync(targetPath, { recursive: true, force: true });
      }
    } catch {
      // does not exist
    }
  }

  private async cloneAndCheckout(
    cloneUrl: string,
    destDir: string,
    ref?: string,
  ): Promise<void> {
    mkdirSync(destDir, { recursive: true });
    if (!ref) {
      await runInstallerGit(destDir, ["clone", "--depth", "1", cloneUrl, "."]);
      return;
    }

    // Try fast shallow branch/tag clone first; fall back to full fetch for commit SHAs
    try {
      await runInstallerGit(destDir, [
        "clone",
        "--depth",
        "1",
        "--branch",
        ref,
        cloneUrl,
        ".",
      ]);
      return;
    } catch {
      rmSync(destDir, { recursive: true, force: true });
      mkdirSync(destDir, { recursive: true });
    }

    await runInstallerGit(destDir, ["init"]);
    await runInstallerGit(destDir, ["remote", "add", "origin", cloneUrl]);
    try {
      await runInstallerGit(destDir, ["fetch", "--depth", "1", "origin", ref]);
      await runInstallerGit(destDir, ["checkout", "--detach", "FETCH_HEAD"]);
    } catch {
      await runInstallerGit(destDir, ["fetch", "origin"]);
      await runInstallerGit(destDir, ["checkout", "--detach", ref]);
    }
  }
}

/**
 * Scaffolds a complete starter `ide2` plugin directory (`ide2 plugin init <dir>`).
 */
export function scaffoldPluginStarter(targetDir: string, rawPluginId?: string): {
  pluginId: string;
  dir: string;
} {
  const absDir = expandHomePath(targetDir);
  const rawName = (rawPluginId ?? absDir.split(/[\\/]/).pop() ?? "my-plugin")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const pluginId = /^[a-z]/.test(rawName) ? rawName : `plugin-${rawName || "starter"}`;

  mkdirSync(join(absDir, "src"), { recursive: true });

  const manifest: Ide2PluginManifest = {
    id: pluginId,
    name: pluginId
      .split("-")
      .map((s) => (s ? s[0]!.toUpperCase() + s.slice(1) : ""))
      .join(" "),
    version: "0.1.0",
    description: "Custom read-only inspection plugin for ide2",
    host: "client",
    engine: { ide2: ">=0.1.0" },
    permissions: [],
    server: "./src/server.ts",
    client: "./src/client.tsx",
    skill: "./SKILL.md",
    contributes: {
      toolWindows: [
        {
          id: "panel",
          title: pluginId,
          slot: "bottom",
        },
      ],
      actions: [
        {
          id: "refresh",
          title: `${pluginId}: Refresh`,
        },
      ],
    },
  };

  writeFileSync(
    join(absDir, "ide2-plugin.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  writeFileSync(
    join(absDir, "src/server.ts"),
    [
      'import { defineServerPlugin } from "@expect2/ide2-plugin/server";',
      "",
      "export default defineServerPlugin(async (ctx) => {",
      "  const refresh = async () => {",
      "    const wts = await ctx.listWorktrees();",
      "    ctx.emitClientEvent(\"summary\", { worktreeCount: wts.length });",
      "  };",
      "",
      "  ctx.handleRpc(\"getSummary\", async () => {",
      "    const wts = await ctx.listWorktrees();",
      "    return { worktrees: wts.map((w) => ({ name: w.name, branch: w.branch })) };",
      "  });",
      "",
      "  ctx.handleAction(\"refresh\", async () => {",
      "    await refresh();",
      "  });",
      "",
      "  const unsub = ctx.onWorktreesUpdated(() => {",
      "    void refresh();",
      "  });",
      "",
      "  return () => unsub();",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  writeFileSync(
    join(absDir, "src/client.tsx"),
    [
      'import React, { useEffect, useState } from "react";',
      'import { defineClientPlugin, PluginBadge, PluginButton, PluginPanel } from "@expect2/ide2-plugin/client";',
      "",
      "export default defineClientPlugin((ctx) => {",
      "  ctx.registerToolWindow(\"panel\", ({ worktree, rpc }) => {",
      "    const [branches, setBranches] = useState<Array<{ name: string; branch: string }>>([]);",
      "",
      "    const load = () => {",
      "      void rpc.call<{ worktrees: Array<{ name: string; branch: string }> }>(\"getSummary\")",
      "        .then((res) => setBranches(res.worktrees));",
      "    };",
      "",
      "    useEffect(() => { load(); }, [worktree?.path]);",
      "",
      "    return (",
      `      <PluginPanel title="${manifest.name}" badge={<PluginBadge tone="accent">{branches.length} wt</PluginBadge>} actions={<PluginButton onClick={load}>Refresh</PluginButton>}>`,
      "        <div style={{ display: \"flex\", flexDirection: \"column\", gap: \"6px\" }}>",
      "          {branches.map((b) => (",
      "            <div key={b.name} style={{ display: \"flex\", gap: \"8px\", alignItems: \"center\" }}>",
      "              <strong>{b.name}</strong>",
      "              <PluginBadge>{b.branch}</PluginBadge>",
      "            </div>",
      "          ))}",
      "        </div>",
      "      </PluginPanel>",
      "    );",
      "  });",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  writeFileSync(
    join(absDir, "SKILL.md"),
    [
      "---",
      `name: ide2-${pluginId}`,
      `description: Agent instructions for the ${manifest.name} ide2 plugin.`,
      "---",
      "",
      `# ${manifest.name}`,
      "",
      `Installed in \`ide2\` as \`${pluginId}\`.`,
      "",
    ].join("\n"),
    "utf8",
  );

  return { pluginId, dir: absDir };
}
