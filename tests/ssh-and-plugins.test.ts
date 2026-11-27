import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalWorkspaceBackend } from "../src/main/backend/local-backend.js";
import {
  RemoteBootstrapRequiredError,
  SshWorkspaceBackend,
} from "../src/main/backend/ssh-backend.js";
import { IntelClient } from "../src/main/intel/client.js";
import { PluginInstaller, scaffoldPluginStarter } from "../src/main/plugins/installer.js";
import { PluginHost } from "../src/main/plugins/plugin-host.js";
import { TourServer } from "../src/main/services/tour-server.js";
import {
  parseGitHubOwnerRepoFromRemoteUrl,
  parsePluginInstallSpec,
  parseSshTarget,
  validatePluginManifest,
} from "../src/shared/plugin-protocol.js";
import { StdioRpcPeer } from "../src/shared/rpc-stdio.js";

const APP_ROOT = resolve(import.meta.dirname, "..");
const tempDirs: string[] = [];

function makeTempDir(prefix = "ide2-ssh-plug-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function initGitRepo(dir: string, remoteUrl?: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@expect2.dev"], {
    cwd: dir,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Expect2 Test"], {
    cwd: dir,
    stdio: "ignore",
  });
  if (remoteUrl) {
    execFileSync("git", ["remote", "add", "origin", remoteUrl], {
      cwd: dir,
      stdio: "ignore",
    });
  }
  writeFileSync(join(dir, "README.md"), "# Remote Test Repo\n", "utf8");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src/auth.ts"),
    [
      "export function verifyToken(token: string): boolean {",
      "  return token.length > 10;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: dir, stdio: "ignore" });
}

afterEach(() => {
  delete process.env.IDE2_SSH_BIN;
  delete process.env.IDE2_GH_BIN;
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe("SSH & Plugin Spec Parsers", () => {
  it("parses SSH targets including ports, ~/ paths, and file:line[:col] suffixes", () => {
    const basic = parseSshTarget("ubuntu@devbox:/srv/api");
    expect(basic.host).toBe("ubuntu@devbox");
    expect(basic.remotePath).toBe("/srv/api");
    expect(basic.uri).toBe("ssh://ubuntu@devbox/srv/api");

    const withLoc = parseSshTarget("meir@gpu-box:~/repo/src/auth.ts:42:7");
    expect(withLoc.host).toBe("meir@gpu-box");
    expect(withLoc.remotePath).toBe("~/repo/src/auth.ts");
    expect(withLoc.line).toBe(42);
    expect(withLoc.column).toBe(7);

    const urlForm = parseSshTarget("ssh://root@10.0.0.5:2222/var/git/app");
    expect(urlForm.host).toBe("root@10.0.0.5");
    expect(urlForm.port).toBe(2222);
    expect(urlForm.remotePath).toBe("/var/git/app");
  });

  it("parses GitHub shorthand, monorepo subdirs, tree URLs, and commit/tag refs", () => {
    const simple = parsePluginInstallSpec("expect2/plugin-verify");
    expect(simple.kind).toBe("github");
    expect(simple.cloneUrl).toBe("https://github.com/expect2/plugin-verify.git");
    expect(simple.subdir).toBeUndefined();

    const monorepo = parsePluginInstallSpec("expect2/plugins/packages/linear#v0.3.0");
    expect(monorepo.kind).toBe("github");
    expect(monorepo.cloneUrl).toBe("https://github.com/expect2/plugins.git");
    expect(monorepo.subdir).toBe("packages/linear");
    expect(monorepo.ref).toBe("v0.3.0");

    const treeUrl = parsePluginInstallSpec(
      "https://github.com/expect2/plugins/tree/main/packages/pr-lens",
    );
    expect(treeUrl.owner).toBe("expect2");
    expect(treeUrl.repo).toBe("plugins");
    expect(treeUrl.ref).toBe("main");
    expect(treeUrl.subdir).toBe("packages/pr-lens");

    expect(parseGitHubOwnerRepoFromRemoteUrl("git@github.com:expect2/ide2.git")?.slug).toBe(
      "expect2/ide2",
    );
    expect(
      parseGitHubOwnerRepoFromRemoteUrl("https://github.com/expect2/ide2.git")?.slug,
    ).toBe("expect2/ide2");
  });

  it("validates ide2-plugin.json and rejects path traversal or unknown permissions", () => {
    const valid = validatePluginManifest({
      id: "my-lens",
      name: "My Lens",
      version: "1.0.0",
      permissions: ["exec"],
      server: "./src/server.ts",
    });
    expect(valid.host).toBe("client");
    expect(valid.permissions).toEqual(["exec"]);

    expect(() =>
      validatePluginManifest({
        id: "bad",
        server: "../escape.ts",
      }),
    ).toThrow(/must stay inside/);

    expect(() =>
      validatePluginManifest({
        id: "bad-perm",
        permissions: ["sudo-root"],
      }),
    ).toThrow(/Unknown plugin permission/);
  });
});

describe("StdioRpcPeer framing & MOTD noise resilience", () => {
  it("ignores pre-handshake banner lines and multiplexes requests, pings, and events", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();

    const server = new StdioRpcPeer(c2s, s2c, {
      role: "server",
      onRequest: async (method, params) => {
        if (method === "echo") return { got: params };
        throw new Error(`unexpected ${method}`);
      },
    });

    const nonProtoLines: string[] = [];
    const client = new StdioRpcPeer(s2c, c2s, {
      role: "client",
      onNonProtocolLine: (line) => nonProtoLines.push(line),
    });

    // Simulate noisy SSH `.bashrc` / MOTD output before daemon starts
    s2c.write("Welcome to Ubuntu 24.04 LTS!\n");
    s2c.write("Last login: Fri Nov 27\n");

    server.sendHandshake({
      version: "0.1.0",
      protocolVersion: 1,
      pid: 1234,
      platform: "linux",
      repoName: "demo",
      repoCommonDir: "/srv/demo/.git",
    });

    const hs = await client.waitForHandshake(3000);
    expect(hs.repoName).toBe("demo");
    expect(nonProtoLines).toHaveLength(2);

    const pong = await client.call<{ pong: number }>("__ping");
    expect(typeof pong.pong).toBe("number");

    const res = await client.call<{ got: { x: number } }>("echo", { x: 7 });
    expect(res.got.x).toBe(7);

    const events: unknown[] = [];
    client.onEvent((e) => events.push(e));
    server.emitEvent({ type: "hello-event" });
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual([{ type: "hello-event" }]);

    client.dispose();
    server.dispose();
  });
});

describe("GitHub-style Git Plugin Installer, PR Checks Lens & Remote SSH Daemon", () => {
  it("installs a TypeScript plugin from a Git repo with permission gating, 40-char SHA pinning, and updates cleanly", async () => {
    const ide2Home = makeTempDir("ide2-home-");
    const pluginGitRepo = makeTempDir("plugin-git-repo-");

    // Create a plugin Git repository using scaffoldPluginStarter + a permission + agent-ipc CLI
    scaffoldPluginStarter(pluginGitRepo, "sample-verify");
    writeFileSync(
      join(pluginGitRepo, "ide2-plugin.json"),
      JSON.stringify(
        {
          id: "sample-verify",
          name: "Sample Verify",
          version: "0.1.0",
          host: "workspace",
          permissions: ["agent-ipc"],
          server: "./src/server.ts",
          client: "./src/client.tsx",
          contributes: {
            cli: [{ subcommand: "decide", description: "Ask user decision card" }],
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    writeFileSync(
      join(pluginGitRepo, "src/server.ts"),
      [
        'import { defineServerPlugin } from "@expect2/ide2-plugin/server";',
        "export default defineServerPlugin((ctx) => {",
        '  ctx.handleRpc("pingPlugin", () => ({ ok: true, id: ctx.pluginId }));',
        '  ctx.handleCli("decide", async ({ argv, presentCardAndWait }) => {',
        "    return presentCardAndWait({",
        '      title: argv[0] || "Approve Schema?",',
        '      markdown: "Proposed migration adds index on users(email).",',
        '      choices: [{ id: "ship", label: "Ship It", kind: "primary" }],',
        "    });",
        "  });",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );

    execFileSync("git", ["init", "-b", "main"], { cwd: pluginGitRepo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "dev@expect2.dev"], {
      cwd: pluginGitRepo,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Expect2"], {
      cwd: pluginGitRepo,
      stdio: "ignore",
    });
    execFileSync("git", ["add", "."], { cwd: pluginGitRepo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "v0.1.0"], { cwd: pluginGitRepo, stdio: "ignore" });
    const firstSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: pluginGitRepo,
      encoding: "utf8",
    }).trim();

    const installer = new PluginInstaller(ide2Home, "local");
    const repoFileUrl = `file://${pluginGitRepo}`;

    // 1. Without permission approval, installation pauses and returns manifest + exact commit SHA
    const unapproved = await installer.install({
      spec: repoFileUrl,
      approvePermissions: false,
    });
    expect(unapproved.requiresPermissionApproval?.commitSha).toBe(firstSha);
    expect(unapproved.requiresPermissionApproval?.requestedPermissions).toEqual(["agent-ipc"]);

    // 2. With permission approval, clones, compiles TS + TSX with esbuild, and pins 40-char SHA
    const approved = await installer.install({
      spec: repoFileUrl,
      approvePermissions: true,
    });
    expect(approved.error).toBeUndefined();
    expect(approved.installed?.id).toBe("sample-verify");
    expect(approved.installed?.source.commitSha).toBe(firstSha);
    expect(approved.installed?.hasServerBundle).toBe(true);
    expect(approved.installed?.hasClientBundle).toBe(true);

    // 3. Same commit reports upToDate: true; new commit updates SHA & version
    const sameUpdate = await installer.update("sample-verify", true);
    expect(sameUpdate.upToDate).toBe(true);

    writeFileSync(
      join(pluginGitRepo, "ide2-plugin.json"),
      JSON.stringify(
        {
          id: "sample-verify",
          name: "Sample Verify",
          version: "0.2.0",
          host: "workspace",
          permissions: ["agent-ipc"],
          server: "./src/server.ts",
          client: "./src/client.tsx",
        },
        null,
        2,
      ),
      "utf8",
    );
    execFileSync("git", ["add", "."], { cwd: pluginGitRepo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "v0.2.0"], { cwd: pluginGitRepo, stdio: "ignore" });
    const secondSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: pluginGitRepo,
      encoding: "utf8",
    }).trim();

    const nextUpdate = await installer.update("sample-verify", true);
    expect(nextUpdate.upToDate).toBe(false);
    expect(nextUpdate.updated?.manifest.version).toBe("0.2.0");
    expect(nextUpdate.updated?.source.commitSha).toBe(secondSha);
  });

  it("runs the built-in GitHub PR & CI Checks Lens (`pr-checks`), emits inline line decorations, and enriches review prompts", async () => {
    const ide2Home = makeTempDir("ide2-pr-home-");
    const repoDir = makeTempDir("repo-with-gh-");
    initGitRepo(repoDir, "https://github.com/expect2/ide2.git");

    // Create a deterministic mock `gh` CLI script
    const mockBinDir = makeTempDir("mock-gh-");
    const mockGh = join(mockBinDir, "gh");
    writeFileSync(
      mockGh,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        'if (args[0] === "pr" && args[1] === "view") {',
        "  console.log(JSON.stringify({",
        "    number: 42,",
        '    title: "Add SSH daemon & plugin host",',
        '    url: "https://github.com/expect2/ide2/pull/42",',
        '    state: "OPEN",',
        "    isDraft: false,",
        '    reviewDecision: "REVIEW_REQUIRED",',
        '    headRefOid: "deadbeef1234",',
        "    statusCheckRollup: [",
        '      { name: "typecheck", conclusion: "FAILURE", detailsUrl: "https://github.com/expect2/ide2/runs/1" },',
        '      { name: "unit-tests", conclusion: "SUCCESS" }',
        "    ]",
        "  }));",
        "  process.exit(0);",
        "}",
        'if (args[0] === "api" && args[1].endsWith("/check-runs")) {',
        "  console.log(JSON.stringify({",
        '    check_runs: [{ id: 991, name: "typecheck", html_url: "https://github.com/expect2/ide2/runs/991", output: { annotations_count: 1 } }]',
        "  }));",
        "  process.exit(0);",
        "}",
        'if (args[0] === "api" && args[1].endsWith("/annotations")) {',
        "  console.log(JSON.stringify([",
        '    { path: "src/auth.ts", start_line: 2, end_line: 2, annotation_level: "failure", title: "TS2322", message: "Token length check fails on empty string" }',
        "  ]));",
        "  process.exit(0);",
        "}",
        "process.exit(1);",
      ].join("\n"),
      "utf8",
    );
    chmodSync(mockGh, 0o755);
    process.env.IDE2_GH_BIN = mockGh;

    const intel = new IntelClient();
    const tourServer = new TourServer({
      ensureRepoWindow: async () => {
        throw new Error("unused");
      },
      broadcastWalkthrough: () => {},
    });

    const backend = await LocalWorkspaceBackend.create({
      targetPath: repoDir,
      intel,
      tourServer,
    });

    const host = new PluginHost({
      backend,
      storageRoot: ide2Home,
      scope: "local",
      hostAffinityFilter: "all",
      builtinPluginDirs: [resolve(APP_ROOT, "plugins/pr-checks")],
    });
    backend.attachPluginController(host);
    await host.start();

    const wts = await backend.discoverWorktrees();
    const wtPath = wts[0]!.path;

    const report = (await backend.callPluginRpc({
      pluginId: "pr-checks",
      method: "getPrReport",
      payload: { worktreePath: wtPath, force: true },
    })) as { status: string; prNumber: number; annotations: Array<{ filePath: string }> };

    expect(report.status).toBe("ok");
    expect(report.prNumber).toBe(42);
    expect(report.annotations).toHaveLength(1);

    const decs = host.getDecorations();
    expect(decs).toHaveLength(1);
    expect(decs[0]?.filePath).toBe("src/auth.ts");
    expect(decs[0]?.startLine).toBe(2);
    expect(decs[0]?.severity).toBe("error");

    // Add a review annotation and verify compileFeedbackPrompt appends failing CI context!
    await backend.createAnnotation({
      worktreePath: wtPath,
      filePath: "src/auth.ts",
      startLine: 2,
      endLine: 2,
      comment: "Fix token validation edge case.",
    });
    const compiled = await backend.compileFeedbackPrompt({ worktreePath: wtPath });
    expect(compiled.markdown).toContain("## GitHub PR #42 Failing CI Checks");
    expect(compiled.markdown).toContain("src/auth.ts:2");

    await backend.dispose();
    await intel.dispose();
  });

  it("bootstraps a fresh remote host over SSH in one click and streams worktrees, files, diffs, and Option C client plugins", async () => {
    const remoteHome = makeTempDir("remote-ssh-home-");
    const remoteRepo = join(remoteHome, "srv-repo");
    initGitRepo(remoteRepo, "https://github.com/expect2/ide2.git");
    writeFileSync(
      join(remoteRepo, "src/auth.ts"),
      [
        "export function verifyToken(token: string): boolean {",
        "  return token.trim().length >= 16;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    // Mock `ssh` script that executes the remote command with HOME=remoteHome
    const mockSshDir = makeTempDir("mock-ssh-bin-");
    const mockSshPath = join(mockSshDir, "mock-ssh");
    writeFileSync(
      mockSshPath,
      [
        "#!/usr/bin/env node",
        'const { spawn } = require("node:child_process");',
        "const args = process.argv.slice(2);",
        // Last arg is the remote command (`sh -lc '...'`)
        "const remoteCmd = args[args.length - 1];",
        'const env = { ...process.env, HOME: process.env.TEST_REMOTE_HOME, IDE2_HOME: process.env.TEST_REMOTE_HOME + "/.expect2-ide" };',
        "delete env.IDE2_REMOTE_BIN;",
        // Strip current workspace bin from PATH so `command -v ide2` is genuinely absent before bootstrap!
        'env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin";',
        'const child = spawn("sh", ["-c", remoteCmd], { stdio: "inherit", env });',
        'child.on("exit", (code) => process.exit(code ?? 0));',
      ].join("\n"),
      "utf8",
    );
    chmodSync(mockSshPath, 0o755);
    process.env.IDE2_SSH_BIN = mockSshPath;
    process.env.TEST_REMOTE_HOME = remoteHome;

    try {
      // 1. Connecting without bootstrap detects missing remote runtime cleanly
      await expect(
        SshWorkspaceBackend.create({
          appRoot: APP_ROOT,
          sshTarget: `ubuntu@mockbox:${remoteRepo}`,
          autoBootstrap: false,
        }),
      ).rejects.toBeInstanceOf(RemoteBootstrapRequiredError);

      // 2. Connecting with autoBootstrap=true streams runtime tarball, installs ~/.expect2-ide/remote-runtime, and connects!
      const localIntel = new IntelClient();
      const sshBackend = await SshWorkspaceBackend.create({
        appRoot: APP_ROOT,
        sshTarget: `ubuntu@mockbox:${remoteRepo}`,
        autoBootstrap: true,
        localIntel,
      });

      expect(
        existsSync(join(remoteHome, ".expect2-ide/remote-runtime/0.1.0/bin/ide2")),
      ).toBe(true);
      expect(sshBackend.getConnectionState().status).toBe("connected");
      expect(sshBackend.getLaunchContext().remoteOriginUrl).toBe(
        "https://github.com/expect2/ide2.git",
      );

      const snap = await sshBackend.getBootstrapSnapshot();
      expect(snap.worktrees).toHaveLength(1);
      const remoteWtPath = snap.worktrees[0]!.path;

      const doc = await sshBackend.readFile(remoteWtPath, "src/auth.ts");
      expect(doc.lines[1]).toContain("token.trim().length >= 16");

      const diff = await sshBackend.getDiff(remoteWtPath, "src/auth.ts", {
        kind: "working",
      });
      expect(diff.additions).toBeGreaterThan(0);

      await sshBackend.dispose();
      await localIntel.dispose();
    } finally {
      delete process.env.TEST_REMOTE_HOME;
    }
  }, 25000);

  it("hot-reloads linked plugins live when installed via CLI and when src/server.ts or src/client.tsx is edited", async () => {
    const ide2Home = makeTempDir("ide2-hotreload-home-");
    const repoDir = makeTempDir("ide2-hotreload-repo-");
    const linkedPluginDir = makeTempDir("ide2-linked-plugin-");
    initGitRepo(repoDir);

    scaffoldPluginStarter(linkedPluginDir, "hot-lens");
    writeFileSync(
      join(linkedPluginDir, "src/server.ts"),
      [
        'import { defineServerPlugin } from "@expect2/ide2-plugin/server";',
        "export default defineServerPlugin((ctx) => {",
        '  ctx.handleRpc("version", () => ({ rev: 1 }));',
        "});",
        "",
      ].join("\n"),
      "utf8",
    );

    const intel = new IntelClient();
    const tourServer = new TourServer({
      ensureRepoWindow: async () => {
        throw new Error("unused");
      },
      broadcastWalkthrough: () => {},
    });
    const backend = await LocalWorkspaceBackend.create({
      targetPath: repoDir,
      intel,
      tourServer,
    });

    const snapshots: Array<{ updatedAt: number }> = [];
    const host = new PluginHost({
      backend,
      storageRoot: ide2Home,
      scope: "local",
      hostAffinityFilter: "all",
      onStateChanged: (snap) => {
        const p = snap.plugins.find((x) => x.id === "hot-lens");
        if (p) snapshots.push({ updatedAt: p.updatedAt });
      },
    });
    backend.attachPluginController(host);
    await host.start();

    // 1. Install externally via a separate PluginInstaller (simulating `ide2 plugin install ./hot-lens --link` from terminal while ide2 is already open!)
    const cliInstaller = new PluginInstaller(ide2Home, "local");
    const installRes = await cliInstaller.install({
      spec: linkedPluginDir,
      linkLocal: true,
      approvePermissions: true,
    });
    expect(installRes.error).toBeUndefined();

    // Wait for lock.json watcher to auto-load `hot-lens`
    const waitUntil = async (fn: () => Promise<boolean>, timeoutMs = 4000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (await fn()) return;
        await new Promise((r) => setTimeout(r, 80));
      }
      throw new Error("Timed out waiting for hot-reload condition");
    };

    await waitUntil(async () => {
      try {
        const res = (await backend.callPluginRpc({
          pluginId: "hot-lens",
          method: "version",
        })) as { rev: number };
        return res.rev === 1;
      } catch {
        return false;
      }
    });

    const beforeStamp = (await host.listPlugins()).find((p) => p.id === "hot-lens")!.updatedAt;

    // 2. Edit src/server.ts & src/client.tsx directly in the linked folder -> watcher rebuilds, reloads server, and bumps updatedAt (cache-busting client.js)
    writeFileSync(
      join(linkedPluginDir, "src/server.ts"),
      [
        'import { defineServerPlugin } from "@expect2/ide2-plugin/server";',
        "export default defineServerPlugin((ctx) => {",
        '  ctx.handleRpc("version", () => ({ rev: 2 }));',
        "});",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(linkedPluginDir, "src/client.tsx"),
      [
        'import React from "react";',
        'import { defineClientPlugin, PluginPanel } from "@expect2/ide2-plugin/client";',
        "export default defineClientPlugin((ctx) => {",
        '  ctx.registerToolWindow("panel", () => <PluginPanel title="HOT_REV_2">v2</PluginPanel>);',
        "});",
        "",
      ].join("\n"),
      "utf8",
    );

    await waitUntil(async () => {
      try {
        const res = (await backend.callPluginRpc({
          pluginId: "hot-lens",
          method: "version",
        })) as { rev: number };
        return res.rev === 2;
      } catch {
        return false;
      }
    });

    const afterStamp = (await host.listPlugins()).find((p) => p.id === "hot-lens")!.updatedAt;
    expect(afterStamp).toBeGreaterThan(beforeStamp);

    const clientCode = await host.readPluginClientBundle("hot-lens");
    expect(clientCode).toContain("HOT_REV_2");

    await backend.dispose();
    await intel.dispose();
  }, 15000);
});
