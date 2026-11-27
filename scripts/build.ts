import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DIST = resolve(ROOT, "dist");

const t0 = performance.now();
rmSync(DIST, { recursive: true, force: true });
mkdirSync(resolve(DIST, "main"), { recursive: true });
mkdirSync(resolve(DIST, "preload"), { recursive: true });
mkdirSync(resolve(DIST, "renderer"), { recursive: true });
mkdirSync(resolve(DIST, "cli"), { recursive: true });

const NODE_EXTERNALS = [
  "electron",
  "@vscode/ripgrep",
  "web-tree-sitter",
  "tree-sitter-wasms",
  "shiki",
  "shiki/*",
];

const jobs: Promise<Bun.BuildOutput>[] = [
  // 1. Electron Main Process
  Bun.build({
    entrypoints: [resolve(ROOT, "src/main/index.ts")],
    outdir: resolve(DIST, "main"),
    target: "node",
    format: "cjs",
    naming: "index.cjs",
    sourcemap: "external",
    external: [...NODE_EXTERNALS, "esbuild", "typescript"],
  }),
  // 2. Electron Preload Bridge (must be CJS for sandboxed renderer)
  Bun.build({
    entrypoints: [resolve(ROOT, "src/preload/index.ts")],
    outdir: resolve(DIST, "preload"),
    target: "node",
    format: "cjs",
    naming: "index.cjs",
    sourcemap: "external",
    external: ["electron"],
  }),
  // 3. Headless CLI `--export`, `tour`, `daemon` (SSH), and `plugin` entries
  Bun.build({
    entrypoints: [resolve(ROOT, "src/cli/export.ts")],
    outdir: resolve(DIST, "cli"),
    target: "node",
    format: "cjs",
    naming: "export.cjs",
    sourcemap: "external",
    external: NODE_EXTERNALS,
  }),
  Bun.build({
    entrypoints: [resolve(ROOT, "src/cli/tour.ts")],
    outdir: resolve(DIST, "cli"),
    target: "node",
    format: "cjs",
    naming: "tour.cjs",
    sourcemap: "external",
    external: NODE_EXTERNALS,
  }),
  Bun.build({
    entrypoints: [resolve(ROOT, "src/cli/daemon.ts")],
    outdir: resolve(DIST, "cli"),
    target: "node",
    format: "cjs",
    naming: "daemon.cjs",
    sourcemap: "external",
    external: [...NODE_EXTERNALS, "esbuild", "typescript"],
  }),
  Bun.build({
    entrypoints: [resolve(ROOT, "src/cli/plugin.ts")],
    outdir: resolve(DIST, "cli"),
    target: "node",
    format: "cjs",
    naming: "plugin.cjs",
    sourcemap: "external",
    external: [...NODE_EXTERNALS, "esbuild", "typescript"],
  }),
  Bun.build({
    entrypoints: [resolve(ROOT, "src/main/plugins/plugin-runner.ts")],
    outdir: resolve(DIST, "main"),
    target: "node",
    format: "cjs",
    naming: "plugin-runner.cjs",
    sourcemap: "external",
    external: NODE_EXTERNALS,
  }),
  // 4. Renderer App (ESM with code-splitting so `mermaid` stays lazy-loaded!)
  Bun.build({
    entrypoints: [resolve(ROOT, "src/renderer/main.tsx")],
    outdir: resolve(DIST, "renderer"),
    target: "browser",
    format: "esm",
    splitting: true,
    minify: true,
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    sourcemap: "external",
    naming: {
      entry: "app.[ext]",
      chunk: "chunks/[name]-[hash].[ext]",
      asset: "assets/[name]-[hash].[ext]",
    },
  }),
];

if (existsSync(resolve(ROOT, "src/main/intel/worker.ts"))) {
  jobs.push(
    Bun.build({
      entrypoints: [resolve(ROOT, "src/main/intel/worker.ts")],
      outdir: resolve(DIST, "main"),
      target: "node",
      format: "cjs",
      naming: "worker.cjs",
      sourcemap: "external",
      external: NODE_EXTERNALS,
    }),
  );
}

const results = await Promise.all(jobs);
for (const res of results) {
  if (!res.success) {
    console.error("Build failed:");
    for (const log of res.logs) {
      console.error(log);
    }
    process.exit(1);
  }
}

copyFileSync(
  resolve(ROOT, "src/renderer/index.html"),
  resolve(DIST, "renderer/index.html"),
);

// On macOS, create an APFS copy-on-write clone `dist/ide2.app` (zero extra disk blocks)
// with CFBundleName/CFBundleDisplayName set to `ide2`, so the macOS menu bar, Dock,
// and Cmd+Tab natively display `ide2` instead of `Electron`.
if (process.platform === "darwin") {
  const srcApp = resolve(ROOT, "node_modules/electron/dist/Electron.app");
  if (existsSync(srcApp)) {
    const dstApp = resolve(DIST, "ide2.app");
    try {
      execFileSync("cp", ["-c", "-R", srcApp, dstApp], { stdio: "ignore" });
    } catch {
      execFileSync("cp", ["-R", srcApp, dstApp], { stdio: "ignore" });
    }

    const plistPath = resolve(dstApp, "Contents/Info.plist");
    let plist = readFileSync(plistPath, "utf8");
    plist = plist
      .replace(
        /<key>CFBundleDisplayName<\/key>\s*<string>[^<]*<\/string>/,
        "<key>CFBundleDisplayName</key>\n\t<string>ide2</string>",
      )
      .replace(
        /<key>CFBundleName<\/key>\s*<string>[^<]*<\/string>/,
        "<key>CFBundleName</key>\n\t<string>ide2</string>",
      )
      .replace(
        /<key>CFBundleIdentifier<\/key>\s*<string>[^<]*<\/string>/,
        "<key>CFBundleIdentifier</key>\n\t<string>dev.expect2.ide2</string>",
      );
    writeFileSync(plistPath, plist, "utf8");

    try {
      execFileSync("codesign", ["--force", "--deep", "--sign", "-", dstApp], {
        stdio: "ignore",
      });
    } catch {
      // Non-fatal if codesign is unavailable
    }
  }
}

const elapsed = (performance.now() - t0).toFixed(0);
console.log(`✔ Built ide2 in ${elapsed}ms`);
