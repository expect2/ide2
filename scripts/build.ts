import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
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
    external: NODE_EXTERNALS,
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
  // 3. Headless CLI `--export` entry
  Bun.build({
    entrypoints: [resolve(ROOT, "src/cli/export.ts")],
    outdir: resolve(DIST, "cli"),
    target: "node",
    format: "cjs",
    naming: "export.cjs",
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

const elapsed = (performance.now() - t0).toFixed(0);
console.log(`✔ Built expect2-ide in ${elapsed}ms`);
