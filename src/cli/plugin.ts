import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { PluginInstaller, scaffoldPluginStarter } from "../main/plugins/installer.js";
import type { TourRpcRequest, TourRpcResponse } from "../main/services/tour-server.js";
import { getTourEndpointPaths } from "../shared/walkthrough-prompt.js";

export function formatPluginHelp(): string {
  return [
    "ide2 plugin — install and manage ide2 plugins from GitHub repositories",
    "",
    "Usage:",
    "  ide2 plugin install <owner/repo[#ref] | url | ./path> [--yes] [--link]",
    "  ide2 plugin list",
    "  ide2 plugin update [plugin-id] [--yes]",
    "  ide2 plugin enable <plugin-id>",
    "  ide2 plugin disable <plugin-id>",
    "  ide2 plugin remove <plugin-id>",
    "  ide2 plugin init <directory> [--id <plugin-id>]",
    "",
    "Examples:",
    "  ide2 plugin install expect2/plugin-verify",
    "  ide2 plugin install expect2/plugins/packages/linear#v0.2.0 --yes",
    "  ide2 plugin install ./my-plugin --link",
    "  ide2 plugin init ./my-custom-lens",
    "",
  ].join("\n");
}

export async function runCliPlugin(opts: {
  cwd: string;
  argv: readonly string[];
}): Promise<string> {
  const [sub, ...rest] = opts.argv;
  if (!sub || sub === "-h" || sub === "--help" || sub === "help") {
    return formatPluginHelp();
  }

  const storageRoot = process.env.IDE2_HOME ?? join(homedir(), ".expect2-ide");
  const installer = new PluginInstaller(storageRoot, "local");

  if (sub === "list" || sub === "ls") {
    const list = installer.listInstalled();
    if (list.length === 0) {
      return "No plugins installed in ~/.expect2-ide/plugins.\nRun `ide2 plugin install <owner/repo>` or `ide2 plugin init <dir>`.\n";
    }
    const lines = list.map((p) => {
      const state = p.enabled ? "enabled" : "disabled";
      const sha = p.source.commitSha ? `@${p.source.commitSha.slice(0, 7)}` : "";
      const perms =
        p.grantedPermissions.length > 0 ? ` [${p.grantedPermissions.join(", ")}]` : " [read-only]";
      return `${p.id}  v${p.manifest.version}  (${state}, host:${p.manifest.host ?? "client"})${perms}  <- ${p.source.spec}${sha}`;
    });
    return `${lines.join("\n")}\n`;
  }

  if (sub === "install" || sub === "add") {
    let spec: string | undefined;
    let ref: string | undefined;
    let yes = false;
    let link = false;
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i]!;
      if (arg === "-y" || arg === "--yes") yes = true;
      else if (arg === "--link") link = true;
      else if (arg === "--ref" && rest[i + 1]) ref = rest[++i];
      else if (arg.startsWith("--ref=")) ref = arg.slice("--ref=".length);
      else if (!arg.startsWith("-") && !spec) spec = arg;
    }
    if (!spec) {
      throw new Error("Missing plugin specifier. Expected `ide2 plugin install <owner/repo>`.");
    }

    const res = await installer.install({
      spec,
      ref,
      linkLocal: link,
      approvePermissions: yes,
    });

    if (res.requiresPermissionApproval) {
      const { manifest, commitSha, requestedPermissions } = res.requiresPermissionApproval;
      throw new Error(
        [
          `Plugin "${manifest.name}" (${manifest.id}${commitSha ? ` @ ${commitSha.slice(0, 7)}` : ""}) requests permissions: [${requestedPermissions.join(", ")}].`,
          `Review the repository source and re-run with \`--yes\` to approve and install:`,
          `  ide2 plugin install ${spec} --yes`,
        ].join("\n"),
      );
    }
    if (res.error || !res.installed) {
      throw new Error(res.error ?? "Plugin installation failed.");
    }
    const p = res.installed;
    const shaSuffix = p.source.commitSha ? ` (pinned to ${p.source.commitSha.slice(0, 12)})` : "";
    return `✔ Installed plugin "${p.manifest.name}" (${p.id} v${p.manifest.version})${shaSuffix}\n`;
  }

  if (sub === "update" || sub === "upgrade") {
    let targetId: string | undefined;
    let yes = false;
    for (const arg of rest) {
      if (arg === "-y" || arg === "--yes") yes = true;
      else if (!arg.startsWith("-") && !targetId) targetId = arg;
    }
    const targets = targetId
      ? [targetId]
      : installer
          .listInstalled()
          .filter((p) => p.source.kind !== "builtin")
          .map((p) => p.id);

    if (targets.length === 0) {
      return "No external plugins to update.\n";
    }

    const outLines: string[] = [];
    for (const id of targets) {
      const res = await installer.update(id, yes);
      if (res.requiresPermissionApproval) {
        throw new Error(
          `Update for "${id}" requests new permissions [${res.requiresPermissionApproval.requestedPermissions.join(", ")}]. Re-run with \`--yes\` to approve.`,
        );
      }
      if (res.error) {
        throw new Error(`Failed updating "${id}": ${res.error}`);
      }
      if (res.upToDate) {
        outLines.push(`= ${id} is already up to date.`);
      } else if (res.updated) {
        const sha = res.updated.source.commitSha
          ? ` -> ${res.updated.source.commitSha.slice(0, 12)}`
          : "";
        outLines.push(`✔ Updated ${id} to v${res.updated.manifest.version}${sha}`);
      }
    }
    return `${outLines.join("\n")}\n`;
  }

  if (sub === "enable" || sub === "disable") {
    const id = rest.find((a) => !a.startsWith("-"));
    if (!id) throw new Error(`Usage: ide2 plugin ${sub} <plugin-id>`);
    installer.setEnabled(id, sub === "enable");
    return `✔ Plugin "${id}" ${sub}d.\n`;
  }

  if (sub === "remove" || sub === "uninstall" || sub === "rm") {
    const id = rest.find((a) => !a.startsWith("-"));
    if (!id) throw new Error("Usage: ide2 plugin remove <plugin-id>");
    installer.remove(id);
    return `✔ Removed plugin "${id}".\n`;
  }

  if (sub === "init") {
    let dir: string | undefined;
    let id: string | undefined;
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i]!;
      if (arg === "--id" && rest[i + 1]) id = rest[++i];
      else if (arg.startsWith("--id=")) id = arg.slice("--id=".length);
      else if (!arg.startsWith("-") && !dir) dir = arg;
    }
    if (!dir) throw new Error("Usage: ide2 plugin init <directory> [--id <plugin-id>]");
    const created = scaffoldPluginStarter(dir, id);
    return [
      `✔ Scaffolded ide2 plugin "${created.pluginId}" in ${created.dir}`,
      `  Link for live hot-reload development:`,
      `    ide2 plugin install ${created.dir} --link`,
      "",
    ].join("\n");
  }

  throw new Error(`Unknown plugin subcommand "${sub}". Run \`ide2 plugin --help\`.`);
}

/**
 * Dispatches `ide2 x <plugin-subcommand> [args...]` from a terminal coding agent
 * to the active `ide2` window or headless SSH daemon via `TourServer` (socket + mailbox fallback).
 */
export async function runCliPluginExtension(opts: {
  cwd: string;
  argv: readonly string[];
}): Promise<string> {
  const [subcommand, ...rest] = opts.argv;
  if (!subcommand || subcommand === "-h" || subcommand === "--help") {
    return [
      "ide2 x — invoke a plugin-contributed agent CLI subcommand",
      "",
      "Usage:",
      "  ide2 x <subcommand> [args...] [--worktree <name>] [--wait-timeout <sec>]",
      "",
    ].join("\n");
  }

  let worktree: string | undefined;
  let wait = true;
  let waitTimeoutSec = 90;
  const filteredArgs: string[] = [];

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if ((arg === "-w" || arg === "--worktree") && rest[i + 1]) {
      worktree = rest[++i]!;
    } else if (arg.startsWith("--worktree=")) {
      worktree = arg.slice("--worktree=".length);
    } else if (arg === "--no-wait") {
      wait = false;
    } else if (arg === "--wait-timeout" && rest[i + 1]) {
      waitTimeoutSec = Number.parseFloat(rest[++i]!);
    } else if (arg.startsWith("--wait-timeout=")) {
      waitTimeoutSec = Number.parseFloat(arg.slice("--wait-timeout=".length));
    } else {
      filteredArgs.push(arg);
    }
  }

  const endpoints = getTourEndpointPaths();
  if (!existsSync(endpoints.tokenPath)) {
    throw new Error("No active ide2 instance found. Open ide2 on this repository first.");
  }
  const token = readFileSync(endpoints.tokenPath, "utf8").trim();
  const req: TourRpcRequest = {
    id: randomBytes(8).toString("hex"),
    token,
    method: "plugin.cli",
    params: {
      cwd: opts.cwd,
      worktree,
      subcommand,
      argv: filteredArgs,
      wait,
      waitTimeoutMs: waitTimeoutSec > 0 ? Math.round(waitTimeoutSec * 1000) : 0,
    },
  };

  const result = await sendRpcWithMailboxFallback(endpoints, req);
  if (typeof result === "string") {
    return result.endsWith("\n") ? result : `${result}\n`;
  }
  if (result && typeof result === "object") {
    const obj = result as Record<string, unknown>;
    if (typeof obj.status === "string") {
      const lines = [`STATUS: ${obj.status}`];
      if (obj.action) lines.push(`ACTION: ${String(obj.action)}`);
      if (obj.message) lines.push(`MESSAGE: ${String(obj.message)}`);
      return `${lines.join("\n")}\n`;
    }
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  return "";
}

function sendRpcWithMailboxFallback(
  endpoints: ReturnType<typeof getTourEndpointPaths>,
  payload: TourRpcRequest,
): Promise<unknown> {
  return new Promise<unknown>((resolveRpc, rejectRpc) => {
    const client = createConnection({ path: endpoints.socketPath });
    client.setEncoding("utf8");
    let buffer = "";
    let settled = false;

    client.once("connect", () => {
      client.write(`${JSON.stringify(payload)}\n`);
    });

    client.on("data", (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl !== -1 && !settled) {
        settled = true;
        client.end();
        try {
          const parsed = JSON.parse(buffer.slice(0, nl)) as TourRpcResponse;
          if (!parsed.ok) rejectRpc(new Error(parsed.error ?? "Plugin CLI RPC error"));
          else resolveRpc(parsed.result);
        } catch (err) {
          rejectRpc(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });

    client.once("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      if (err.code === "EPERM" || err.code === "EACCES") {
        settled = true;
        sendViaMailbox(endpoints.ipcDir, payload).then(resolveRpc, rejectRpc);
        return;
      }
      settled = true;
      rejectRpc(err);
    });
  });
}

function sendViaMailbox(ipcDir: string, payload: TourRpcRequest): Promise<unknown> {
  return new Promise<unknown>((resolveMbx, rejectMbx) => {
    const reqFinal = join(ipcDir, `${payload.id}.req.json`);
    const reqTmp = `${reqFinal}.tmp`;
    const resFinal = join(ipcDir, `${payload.id}.res.json`);
    let settled = false;

    const consume = () => {
      if (settled || !existsSync(resFinal)) return;
      settled = true;
      cleanup();
      try {
        const parsed = JSON.parse(readFileSync(resFinal, "utf8")) as TourRpcResponse;
        try {
          rmSync(resFinal, { force: true });
        } catch {
          // ignore
        }
        if (!parsed.ok) rejectMbx(new Error(parsed.error ?? "Plugin CLI error"));
        else resolveMbx(parsed.result);
      } catch (err) {
        rejectMbx(err instanceof Error ? err : new Error(String(err)));
      }
    };

    const watcher = (() => {
      try {
        return watch(ipcDir, () => consume());
      } catch {
        return null;
      }
    })();
    const poll = setInterval(consume, 80);

    const cleanup = () => {
      watcher?.close();
      clearInterval(poll);
    };

    writeFileSync(reqTmp, JSON.stringify(payload), "utf8");
    renameSync(reqTmp, reqFinal);
  });
}
