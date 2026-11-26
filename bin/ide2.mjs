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
      "",
      "Examples:",
      "  ide2                          Open repo/worktree of current directory",
      "  ide2 /path/to/repo            Open specific repository or worktree",
      "  ide2 src/auth/session.ts:141  Open and jump straight to line 141",
      "  ide2 --diff                   Launch directly in Branch Diff Review mode",
      "  ide2 --worktree api-v2        Focus a named worktree on launch",
      "  ide2 --export                 Print current worktree's Markdown Feedback Prompt to stdout",
      "",
      "Options:",
      "  -d, --diff            Open in Diff Review mode",
      "  -b, --base <ref>      Override base branch ref for diffing (e.g. main)",
      "  -w, --worktree <name> Select worktree by name or path",
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
    diff: false,
    base: undefined,
    worktree: undefined,
    exportPrompt: false,
    resolveOnExport: false,
    wait: false,
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "-v" || arg === "--version") {
      opts.version = true;
    } else if (arg === "-d" || arg === "--diff") {
      opts.diff = true;
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
    } else if (!arg.startsWith("-") && opts.target === undefined) {
      opts.target = arg;
    }
  }
  return opts;
}

const opts = parseCliArgs(process.argv.slice(2));

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
      process.stderr.write(`ide2 --export failed: ${err instanceof Error ? err.message : String(err)}\n`);
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
  const electronArgs = [
    APP_ROOT,
    `--ide2-cwd=${cwd}`,
    `--ide2-target=${rawTarget}`,
  ];
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
