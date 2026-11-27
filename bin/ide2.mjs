#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, "..");
const require = createRequire(import.meta.url);

function printHelp() {
  process.stdout.write(
    [
      "ide2 — read-only IDE for the AI coding era",
      "",
      "Usage:",
      "  ide2 [path[:line[:col]]] [options]",
      "  ide2 ssh <user@host:/path/to/repo> [--bootstrap] [--ssh-opt \"...\"] [options]",
      "  ide2 plugin <install|list|update|enable|disable|remove|init> ...",
      "",
      "Examples:",
      "  ide2                                  Open repo/worktree of current directory",
      "  ide2 /path/to/repo                    Open specific repository or worktree",
      "  ide2 src/auth/session.ts:141          Open and jump straight to line 141",
      "  ide2 ssh ubuntu@devbox:/srv/api       Open remote repository via SSH daemon",
      "  ide2 ssh ubuntu@devbox:~/repo --diff  Open remote repo in Diff Review mode",
      "  ide2 plugin install owner/repo        Install an ide2 plugin from GitHub",
      "  ide2 --diff                           Launch directly in Branch Diff Review mode",
      "  ide2 --worktree api-v2                Focus a named worktree on launch",
      "  ide2 --export                         Print current worktree's Markdown Feedback Prompt",
      "  ide2 review wait                      Wait for live review feedback from ide2",
      "  ide2 tour --help                      Drive interactive codebase walkthroughs",
      "  ide2 install-skill                    Install unified ide2 + plugin agent skills",
      "",
      "Subcommands:",
      "  ssh <target>                  Connect local ide2 UI to a remote repository over SSH",
      "  plugin                        Install & manage plugins from GitHub (`ide2 plugin --help`)",
      "  x <subcommand>                Invoke a plugin-contributed agent CLI command",
      "  review                        Live zero-copy-paste review loop (`ide2 review --help`)",
      "  tour                          Agent-driven codebase walkthroughs (`ide2 tour --help`)",
      "  install-skill                 Install unified SKILL.md for skill-aware coding agents",
      "  daemon                        Headless stdio workspace server (used by `ide2 ssh`)",
      "",
      "Options:",
      "  -d, --diff            Open in Diff Review mode",
      "  -b, --base <ref>      Override base branch ref for diffing (e.g. main)",
      "  -w, --worktree <name> Select worktree by name or path",
      "      --bootstrap       Automatically bootstrap headless runtime on remote SSH host",
      "      --ssh-opt <args>  Extra flags forwarded to ssh (e.g. \"-p 2222 -i ~/.ssh/id_ed25519\")",
      "      --export          Compile and print Markdown Feedback Prompt to stdout (headless)",
      "      --resolve         With --export, mark exported annotations as resolved",
      "      --wait            Wait until the ide2 window closes before returning",
      "  -v, --version         Print version",
      "  -h, --help            Print this help",
      "",
    ].join("\n"),
  );
}

function parseCliArgs(argv) {
  const opts = {
    target: undefined,
    sshTarget: undefined,
    sshOpt: undefined,
    bootstrap: false,
    diff: false,
    base: undefined,
    worktree: undefined,
    exportPrompt: false,
    resolveOnExport: false,
    wait: false,
    help: false,
    version: false,
  };

  let i = 0;
  if (argv[0] === "ssh") {
    i = 1;
    if (!argv[1] || argv[1] === "-h" || argv[1] === "--help") {
      opts.help = true;
      return opts;
    }
    opts.sshTarget = argv[i++];
  }

  for (; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "-v" || arg === "--version") {
      opts.version = true;
    } else if (arg === "-d" || arg === "--diff") {
      opts.diff = true;
    } else if (arg === "--bootstrap") {
      opts.bootstrap = true;
    } else if (arg === "--ssh-opt" && argv[i + 1]) {
      opts.sshOpt = argv[++i];
    } else if (arg.startsWith("--ssh-opt=")) {
      opts.sshOpt = arg.slice("--ssh-opt=".length);
    } else if (arg === "--export") {
      opts.exportPrompt = true;
    } else if (arg === "--resolve") {
      opts.resolveOnExport = true;
    } else if (arg === "--wait") {
      opts.wait = true;
    } else if ((arg === "-b" || arg === "--base") && argv[i + 1]) {
      opts.base = argv[++i];
    } else if (arg.startsWith("--base=")) {
      opts.base = arg.slice("--base=".length);
    } else if ((arg === "-w" || arg === "--worktree") && argv[i + 1]) {
      opts.worktree = argv[++i];
    } else if (arg.startsWith("--worktree=")) {
      opts.worktree = arg.slice("--worktree=".length);
    } else if (!arg.startsWith("-") && opts.target === undefined && opts.sshTarget === undefined) {
      if (arg.startsWith("ssh://")) {
        opts.sshTarget = arg;
      } else {
        opts.target = arg;
      }
    }
  }
  return opts;
}

const rawArgs = process.argv.slice(2);
const firstSub = rawArgs[0];

if (firstSub === "daemon") {
  const daemonEntry = resolve(APP_ROOT, "dist/cli/daemon.cjs");
  if (!existsSync(daemonEntry)) {
    process.stderr.write("ide2: daemon artifact missing. Run `bun run build` in ide2 first.\n");
    process.exit(1);
  }
  const { runCliDaemon } = require(daemonEntry);
  Promise.resolve(
    runCliDaemon({ appRoot: APP_ROOT, cwd: process.cwd(), argv: rawArgs.slice(1) }),
  )
    .then(() => process.exit(0))
    .catch((err) => {
      process.stderr.write(
        `ide2 daemon failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
} else if (firstSub === "plugin" || firstSub === "plugins" || firstSub === "x") {
  const pluginEntry = resolve(APP_ROOT, "dist/cli/plugin.cjs");
  if (!existsSync(pluginEntry)) {
    process.stderr.write("ide2: plugin artifact missing. Run `bun run build` in ide2 first.\n");
    process.exit(1);
  }
  const { runCliPlugin, runCliPluginExtension } = require(pluginEntry);
  const promise =
    firstSub === "x"
      ? runCliPluginExtension({ cwd: process.cwd(), argv: rawArgs.slice(1) })
      : runCliPlugin({ cwd: process.cwd(), argv: rawArgs.slice(1) });
  Promise.resolve(promise)
    .then((output) => {
      if (output) process.stdout.write(output);
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(
        `ide2 ${firstSub} failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
} else if (
  firstSub === "tour" ||
  firstSub === "walkthrough" ||
  firstSub === "review" ||
  firstSub === "install-skill"
) {
  const tourEntry = resolve(APP_ROOT, "dist/cli/tour.cjs");
  if (!existsSync(tourEntry)) {
    process.stderr.write("ide2: build artifacts missing. Run `bun run build` in ide2 first.\n");
    process.exit(1);
  }
  const { runCliTour, runCliReview, runCliInstallSkill } = require(tourEntry);
  const promise =
    firstSub === "review"
      ? runCliReview({ cwd: process.cwd(), appRoot: APP_ROOT, argv: rawArgs.slice(1) })
      : firstSub === "install-skill"
        ? runCliInstallSkill({ cwd: process.cwd(), argv: rawArgs.slice(1) })
        : runCliTour({ cwd: process.cwd(), appRoot: APP_ROOT, argv: rawArgs.slice(1) });
  Promise.resolve(promise)
    .then((output) => {
      if (output) {
        process.stdout.write(output);
      }
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(
        `ide2 ${firstSub} failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
} else {
  const opts = parseCliArgs(rawArgs);

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  if (opts.version) {
    const pkg = JSON.parse(readFileSync(resolve(APP_ROOT, "package.json"), "utf8"));
    process.stdout.write(`ide2 ${pkg.version}\n`);
    process.exit(0);
  }

  const cwd = process.cwd();
  const rawTarget = opts.target ?? cwd;

  if (opts.exportPrompt) {
    const exportEntry = resolve(APP_ROOT, "dist/cli/export.cjs");
    if (!existsSync(exportEntry)) {
      process.stderr.write("ide2: build artifacts missing. Run `bun run build` in expect2-ide first.\n");
      process.exit(1);
    }
    const { runCliExport } = require(exportEntry);
    Promise.resolve(
      runCliExport({
        cwd,
        target: rawTarget,
        worktreeFilter: opts.worktree,
        resolveAfterExport: opts.resolveOnExport,
      }),
    )
      .then((markdown) => {
        if (markdown) {
          process.stdout.write(markdown);
        }
        process.exit(0);
      })
      .catch((err) => {
        process.stderr.write(
          `ide2 --export failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      });
  } else {
    const mainEntry = resolve(APP_ROOT, "dist/main/index.cjs");
    if (!existsSync(mainEntry)) {
      process.stderr.write("ide2: build artifacts missing. Run `bun run build` in expect2-ide first.\n");
      process.exit(1);
    }

    const macWrapperBinary = resolve(APP_ROOT, "dist/ide2.app/Contents/MacOS/Electron");
    const electronBinary =
      process.platform === "darwin" && existsSync(macWrapperBinary)
        ? macWrapperBinary
        : require("electron");
    const electronArgs = [APP_ROOT, `--ide2-cwd=${cwd}`];
    if (opts.sshTarget) {
      electronArgs.push(`--ide2-ssh=${opts.sshTarget}`);
      if (opts.sshOpt) electronArgs.push(`--ide2-ssh-opt=${opts.sshOpt}`);
      if (opts.bootstrap) electronArgs.push("--ide2-bootstrap=1");
    } else {
      electronArgs.push(`--ide2-target=${rawTarget}`);
    }
    if (opts.diff) electronArgs.push("--ide2-diff=1");
    if (opts.base) electronArgs.push(`--ide2-base=${opts.base}`);
    if (opts.worktree) electronArgs.push(`--ide2-worktree=${opts.worktree}`);

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;

    if (opts.wait || process.env.IDE2_FOREGROUND === "1") {
      const child = spawn(electronBinary, electronArgs, {
        stdio: "inherit",
        env,
      });
      child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
    } else {
      const child = spawn(electronBinary, electronArgs, {
        detached: true,
        stdio: "ignore",
        env,
        windowsHide: false,
      });
      child.unref();
      process.exit(0);
    }
  }
}
