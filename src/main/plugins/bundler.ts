import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, resolve } from "node:path";
import type { Ide2PluginManifest } from "../../shared/protocol.js";

const localRequire = createRequire(import.meta.url);

export interface BundledPluginArtifacts {
  serverOutPath?: string;
  clientOutPath?: string;
}

const CLIENT_REACT_SHIM = `
const R = globalThis.__IDE2_PLUGIN_RUNTIME__?.React;
if (!R) throw new Error("ide2 plugin runtime React bridge is missing");
export default R;
export const {
  Children, Component, Fragment, PureComponent, StrictMode, Suspense,
  cloneElement, createContext, createElement, createRef, forwardRef,
  isValidElement, lazy, memo, startTransition, use, useActionState,
  useCallback, useContext, useDebugValue, useDeferredValue, useEffect,
  useId, useImperativeHandle, useInsertionEffect, useLayoutEffect,
  useMemo, useOptimistic, useReducer, useRef, useState, useSyncExternalStore,
  useTransition
} = R;
`;

const CLIENT_JSX_SHIM = `
const J = globalThis.__IDE2_PLUGIN_RUNTIME__?.jsxRuntime;
if (!J) throw new Error("ide2 plugin runtime jsx-runtime bridge is missing");
export const { Fragment, jsx, jsxs, jsxDEV } = J;
`;

const CLIENT_SDK_SHIM = `
const S = globalThis.__IDE2_PLUGIN_RUNTIME__?.sdk;
if (!S) throw new Error("ide2 plugin client SDK bridge is missing");
export const {
  defineClientPlugin,
  PluginPanel,
  PluginBadge,
  PluginButton,
  PluginEmptyState,
} = S;
export default S;
`;

const SERVER_SDK_SHIM = `
module.exports = {
  defineServerPlugin: (fn) => fn,
};
`;

/**
 * Compiles a plugin's `server` and/or `client` entrypoints (TypeScript, TSX, or JS)
 * into `<pluginDir>/.ide2-build/{server.cjs, client.js}`.
 *
 * - Uses `esbuild` when available (standard local install), rewriting `react` and
 *   `@expect2/ide2-plugin/*` imports to `ide2`'s shared runtime shims so GitHub plugin
 *   repositories require zero `npm install` step!
 * - Falls back cleanly to copying prebuilt `.cjs`/`.js` files or `typescript.transpileModule`
 *   on minimal headless remote environments.
 */
export async function bundlePluginDirectory(
  pluginDir: string,
  manifest: Ide2PluginManifest,
): Promise<BundledPluginArtifacts> {
  const buildDir = resolve(pluginDir, ".ide2-build");
  mkdirSync(buildDir, { recursive: true });

  const out: BundledPluginArtifacts = {};

  let esbuildMod: typeof import("esbuild") | null = null;
  try {
    esbuildMod = localRequire("esbuild") as typeof import("esbuild");
  } catch {
    esbuildMod = null;
  }

  if (manifest.server) {
    const srcServer = resolve(pluginDir, manifest.server);
    if (!existsSync(srcServer)) {
      throw new Error(`Plugin "${manifest.id}" server entry not found: ${manifest.server}`);
    }
    const dstServer = resolve(buildDir, "server.cjs");
    if (esbuildMod) {
      await esbuildMod.build({
        entryPoints: [srcServer],
        outfile: dstServer,
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node20",
        logLevel: "silent",
        plugins: [
          {
            name: "ide2-server-sdk-shim",
            setup(build) {
              build.onResolve(
                { filter: /^(@expect2\/ide2-plugin\/server|ide2\/server)$/ },
                () => ({
                  path: "ide2-server-sdk",
                  namespace: "ide2-shim",
                }),
              );
              build.onLoad({ filter: /^ide2-server-sdk$/, namespace: "ide2-shim" }, () => ({
                contents: SERVER_SDK_SHIM,
                loader: "js",
              }));
            },
          },
        ],
      });
    } else if (/\.(cjs|js)$/i.test(extname(srcServer))) {
      copyFileSync(srcServer, dstServer);
    } else {
      transpileWithTypeScriptFallback(srcServer, dstServer, "cjs");
    }
    out.serverOutPath = dstServer;
  }

  if (manifest.client) {
    const srcClient = resolve(pluginDir, manifest.client);
    if (!existsSync(srcClient)) {
      throw new Error(`Plugin "${manifest.id}" client entry not found: ${manifest.client}`);
    }
    const dstClient = resolve(buildDir, "client.js");
    if (esbuildMod) {
      await esbuildMod.build({
        entryPoints: [srcClient],
        outfile: dstClient,
        bundle: true,
        platform: "browser",
        format: "esm",
        target: "es2022",
        jsx: "automatic",
        logLevel: "silent",
        plugins: [
          {
            name: "ide2-client-runtime-shim",
            setup(build) {
              build.onResolve({ filter: /^react$/ }, () => ({
                path: "react",
                namespace: "ide2-client-shim",
              }));
              build.onResolve({ filter: /^react\/jsx(-dev)?-runtime$/ }, () => ({
                path: "react-jsx",
                namespace: "ide2-client-shim",
              }));
              build.onResolve(
                { filter: /^(@expect2\/ide2-plugin\/client|ide2\/client)$/ },
                () => ({
                  path: "ide2-client-sdk",
                  namespace: "ide2-client-shim",
                }),
              );
              build.onLoad({ filter: /^react$/, namespace: "ide2-client-shim" }, () => ({
                contents: CLIENT_REACT_SHIM,
                loader: "js",
              }));
              build.onLoad({ filter: /^react-jsx$/, namespace: "ide2-client-shim" }, () => ({
                contents: CLIENT_JSX_SHIM,
                loader: "js",
              }));
              build.onLoad({ filter: /^ide2-client-sdk$/, namespace: "ide2-client-shim" }, () => ({
                contents: CLIENT_SDK_SHIM,
                loader: "js",
              }));
            },
          },
        ],
      });
    } else if (/\.(mjs|js)$/i.test(extname(srcClient))) {
      copyFileSync(srcClient, dstClient);
    } else {
      transpileWithTypeScriptFallback(srcClient, dstClient, "esm");
    }
    out.clientOutPath = dstClient;
  }

  return out;
}

function transpileWithTypeScriptFallback(
  srcPath: string,
  dstPath: string,
  mode: "cjs" | "esm",
): void {
  const ts = localRequire("typescript") as typeof import("typescript");
  const { readFileSync } = localRequire("node:fs") as typeof import("node:fs");
  const raw = readFileSync(srcPath, "utf8");
  const res = ts.transpileModule(raw, {
    fileName: srcPath,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: mode === "cjs" ? ts.ModuleKind.CommonJS : ts.ModuleKind.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  });
  mkdirSync(dirname(dstPath), { recursive: true });
  let output = res.outputText;
  if (mode === "esm") {
    output = output
      .replace(
        /from\s+["']react\/jsx-runtime["']/g,
        'from "ide2://app/__plugins/_shim/jsx-runtime.js"',
      )
      .replace(/from\s+["']react["']/g, 'from "ide2://app/__plugins/_shim/react.js"')
      .replace(
        /from\s+["'](@expect2\/ide2-plugin\/client|ide2\/client)["']/g,
        'from "ide2://app/__plugins/_shim/sdk.js"',
      );
  }
  writeFileSync(dstPath, output, "utf8");
}

export const PLUGIN_SHIM_MODULES: Record<string, string> = {
  "react.js": CLIENT_REACT_SHIM,
  "jsx-runtime.js": CLIENT_JSX_SHIM,
  "sdk.js": CLIENT_SDK_SHIM,
};
