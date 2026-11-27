import React, { useEffect, useState } from "react";
import type {
  Ide2PluginManifest,
  InstalledPluginInfo,
  PluginPermission,
  RecentProject,
  RemoteConnectionState,
} from "../../shared/protocol.js";

const backdropStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(10, 12, 16, 0.65)",
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  paddingTop: "68px",
  zIndex: 1200,
};

const modalStyle: React.CSSProperties = {
  width: "620px",
  maxWidth: "92vw",
  maxHeight: "82vh",
  background: "var(--wash)",
  border: "1px solid var(--border-strong)",
  borderRadius: "10px",
  boxShadow: "var(--shadow-modal)",
  color: "var(--ink)",
  fontFamily: "var(--ui-font)",
  fontSize: "12.5px",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--screen)",
  border: "1px solid var(--border-strong)",
  borderRadius: "6px",
  color: "var(--ink)",
  padding: "7px 10px",
  fontFamily: "var(--mono)",
  fontSize: "12.5px",
  outline: "none",
};

/* -------------------------------------------------------------------------- */
/* 1. Connect to Remote Repository via SSH Modal                              */
/* -------------------------------------------------------------------------- */

export const ConnectSshModal: React.FC<{
  open: boolean;
  onClose: () => void;
  onConnected?: (repoName?: string) => void;
}> = ({ open, onClose, onConnected }) => {
  const [sshTarget, setSshTarget] = useState<string>("");
  const [sshOptions, setSshOptions] = useState<string>("");
  const [openInDiff, setOpenInDiff] = useState<boolean>(false);
  const [recentSsh, setRecentSsh] = useState<RecentProject[]>([]);
  const [connecting, setConnecting] = useState<boolean>(false);
  const [bootstrapping, setBootstrapping] = useState<boolean>(false);
  const [needsBootstrapTarget, setNeedsBootstrapTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setNeedsBootstrapTarget(null);
    void window.ide2
      .listRecentProjects()
      .then((list) => setRecentSsh(list.filter((p) => p.isRemote && p.sshTarget)));
  }, [open]);

  if (!open) return null;

  const attemptConnect = async (targetOverride?: string, autoBootstrap = false) => {
    const target = (targetOverride ?? sshTarget).trim();
    if (!target) {
      setError("Enter an SSH target like `ubuntu@devbox:/srv/repo` or `user@host:~/project`.");
      return;
    }
    if (autoBootstrap) setBootstrapping(true);
    else setConnecting(true);
    setError(null);

    try {
      const res = await window.ide2.connectSshWindow({
        sshTarget: target,
        sshOptions: sshOptions.trim() || undefined,
        diff: openInDiff,
        autoBootstrap,
      });
      if (res.opened) {
        onConnected?.(res.repoName);
        onClose();
        return;
      }
      if (res.needsBootstrap) {
        setNeedsBootstrapTarget(target);
        setError(null);
        return;
      }
      setError(res.error ?? "Failed to connect over SSH.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
      setBootstrapping(false);
    }
  };

  return (
    <div style={backdropStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{ height: "2px", background: "var(--expect2-trail-bar)" }} />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 16px",
            borderBottom: "1px solid var(--faint)",
          }}
        >
          <div>
            <div style={{ fontWeight: 600, fontSize: "13.5px" }}>
              Connect to Remote Repository via SSH
            </div>
            <div style={{ fontSize: "11.5px", color: "var(--dim)", marginTop: "2px" }}>
              Native local <code>ide2</code> UI backed by a headless read-only SSH stdio daemon
            </div>
          </div>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            ×
          </button>
        </div>

        <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
            <span style={{ fontWeight: 500, fontSize: "12px" }}>SSH Target (`user@host:/path/to/repo`)</span>
            <input
              type="text"
              autoFocus
              value={sshTarget}
              onChange={(e) => {
                setSshTarget(e.target.value);
                setNeedsBootstrapTarget(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void attemptConnect();
                } else if (e.key === "Escape") {
                  onClose();
                }
              }}
              placeholder="ubuntu@devbox:~/my-repo"
              style={inputStyle}
            />
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
            <span style={{ fontWeight: 500, fontSize: "12px", color: "var(--dim)" }}>
              Extra SSH Flags (optional)
            </span>
            <input
              type="text"
              value={sshOptions}
              onChange={(e) => setSshOptions(e.target.value)}
              placeholder="-p 2222 -i ~/.ssh/id_ed25519"
              style={inputStyle}
            />
          </label>

          <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={openInDiff}
              onChange={(e) => setOpenInDiff(e.target.checked)}
            />
            <span style={{ fontSize: "12px", color: "var(--dim)" }}>
              Open directly in Branch Diff Review mode
            </span>
          </label>

          {needsBootstrapTarget && (
            <div
              style={{
                padding: "12px",
                borderRadius: "8px",
                border: "1px solid rgba(61, 107, 255, 0.5)",
                background: "rgba(61, 107, 255, 0.1)",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              }}
            >
              <div style={{ fontWeight: 600, color: "#8cb4ff" }}>
                One-Click Remote Runtime Bootstrap Ready
              </div>
              <div style={{ fontSize: "12px", color: "var(--dim)", lineHeight: 1.45 }}>
                <code>ide2</code> is not installed on <code>{needsBootstrapTarget.split(":")[0]}</code> yet.
                Click below to stream the ~350 KB headless daemon into{" "}
                <code>~/.expect2-ide/remote-runtime/</code> over SSH (requires Node.js &ge; 18 &amp; Git).
              </div>
              <div>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={bootstrapping}
                  onClick={() => void attemptConnect(needsBootstrapTarget, true)}
                >
                  {bootstrapping
                    ? "Bootstrapping Remote Host…"
                    : "Bootstrap Remote Runtime & Connect →"}
                </button>
              </div>
            </div>
          )}

          {error && (
            <div
              style={{
                padding: "9px 11px",
                borderRadius: "6px",
                background: "rgba(255, 93, 77, 0.12)",
                border: "1px solid rgba(255, 93, 77, 0.4)",
                color: "var(--danger, #ff5d4d)",
                fontFamily: "var(--mono)",
                fontSize: "11.5px",
                whiteSpace: "pre-wrap",
              }}
            >
              {error}
            </div>
          )}

          {recentSsh.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "5px", marginTop: "4px" }}>
              <span style={{ fontSize: "11px", color: "var(--dim)", fontWeight: 600 }}>
                RECENT SSH CONNECTIONS
              </span>
              {recentSsh.slice(0, 5).map((item) => (
                <button
                  key={item.path}
                  type="button"
                  onClick={() => {
                    if (item.sshTarget) {
                      setSshTarget(item.sshTarget);
                      void attemptConnect(item.sshTarget, false);
                    }
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "6px 9px",
                    borderRadius: "6px",
                    background: "var(--screen)",
                    border: "1px solid var(--faint)",
                    color: "var(--ink)",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <span style={{ fontWeight: 500 }}>{item.name}</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: "11px", color: "var(--dim)" }}>
                    {item.sshTarget}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "8px",
            padding: "10px 16px",
            borderTop: "1px solid var(--faint)",
            background: "var(--paper)",
          }}
        >
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={connecting || bootstrapping}
            onClick={() => void attemptConnect()}
          >
            {connecting ? "Connecting…" : "Connect via SSH"}
          </button>
        </div>
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* 2. In-Window Deferred SSH Bootstrap Card (`ide2 ssh user@host:/repo`)      */
/* -------------------------------------------------------------------------- */

export const RemoteBootstrapPromptView: React.FC<{
  connection: RemoteConnectionState;
  onBootstrapped: () => Promise<void> | void;
}> = ({ connection, onBootstrapped }) => {
  const [busy, setBusy] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  const handleBootstrap = async () => {
    setBusy(true);
    setErr(null);
    const res = await window.ide2.bootstrapRemoteSsh();
    setBusy(false);
    if (!res.ok) {
      setErr(res.error ?? "Remote bootstrap failed.");
      return;
    }
    await onBootstrapped();
  };

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "32px",
      }}
    >
      <div
        style={{
          maxWidth: "520px",
          padding: "22px 24px",
          borderRadius: "10px",
          background: "var(--wash)",
          border: "1px solid var(--border-strong)",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
        }}
      >
        <div style={{ fontSize: "15px", fontWeight: 600, color: "var(--ink)" }}>
          Set up Headless <code>ide2</code> Runtime on <code>{connection.sshHost}</code>
        </div>
        <div style={{ fontSize: "12.5px", color: "var(--dim)", lineHeight: 1.5 }}>
          <code>{connection.sshTarget}</code> does not have the <code>ide2</code> headless daemon yet.
          One click installs a lightweight (~350 KB), strictly read-only runtime into{" "}
          <code>~/.expect2-ide/remote-runtime/</code> so you can browse worktrees, review diffs,
          and let remote terminal coding agents run <code>ide2 review wait</code> &amp;{" "}
          <code>ide2 tour</code>.
        </div>
        {err && (
          <div
            style={{
              padding: "8px 10px",
              borderRadius: "6px",
              background: "rgba(255, 93, 77, 0.12)",
              border: "1px solid rgba(255, 93, 77, 0.4)",
              color: "var(--danger, #ff5d4d)",
              fontFamily: "var(--mono)",
              fontSize: "11.5px",
            }}
          >
            {err}
          </div>
        )}
        <div style={{ display: "flex", gap: "8px", marginTop: "4px" }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void handleBootstrap()}
          >
            {busy ? "Bootstrapping via SSH…" : "Bootstrap Remote Runtime & Open Repo →"}
          </button>
        </div>
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* 3. Manage Plugins Modal (Install from GitHub + Option C Local/Remote)      */
/* -------------------------------------------------------------------------- */

export const ManagePluginsModal: React.FC<{
  open: boolean;
  plugins: readonly InstalledPluginInfo[];
  connection: RemoteConnectionState;
  onRefreshPlugins: () => Promise<void> | void;
  onClose: () => void;
}> = ({ open, plugins, connection, onRefreshPlugins, onClose }) => {
  const [spec, setSpec] = useState<string>("");
  const [targetScope, setTargetScope] = useState<"local" | "remote">("local");
  const [linkLocal, setLinkLocal] = useState<boolean>(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [installing, setInstalling] = useState<boolean>(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<{
    manifest: Ide2PluginManifest;
    commitSha?: string;
    requestedPermissions: PluginPermission[];
  } | null>(null);

  useEffect(() => {
    if (open) {
      setError(null);
      setStatusMsg(null);
      setPendingApproval(null);
    }
  }, [open]);

  if (!open) return null;

  const handleInstall = async (approvePermissions = false) => {
    const trimmed = spec.trim();
    if (!trimmed) {
      setError("Enter a GitHub repository (`owner/repo[#ref]`) or local directory path.");
      return;
    }
    setInstalling(true);
    setError(null);
    setStatusMsg(null);
    try {
      const res = await window.ide2.installPlugin({
        spec: trimmed,
        targetScope: connection.isRemote ? targetScope : "local",
        linkLocal,
        approvePermissions,
      });
      if (res.requiresPermissionApproval) {
        setPendingApproval(res.requiresPermissionApproval);
        return;
      }
      if (res.error || !res.installed) {
        setError(res.error ?? "Installation failed.");
        return;
      }
      setPendingApproval(null);
      setSpec("");
      const sha = res.installed.source.commitSha
        ? ` @ ${res.installed.source.commitSha.slice(0, 7)}`
        : "";
      setStatusMsg(`Installed ${res.installed.manifest.name} (${res.installed.id}${sha})`);
      await onRefreshPlugins();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  };

  const renderPluginRow = (p: InstalledPluginInfo) => {
    const isBusy = busyId === `${p.scope}:${p.id}`;
    const shaBadge = p.source.commitSha ? p.source.commitSha.slice(0, 7) : null;
    const affinity = p.manifest.host ?? "client";

    return (
      <div
        key={`${p.scope}:${p.id}`}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "6px",
          padding: "10px 12px",
          borderRadius: "8px",
          background: "var(--screen)",
          border: "1px solid var(--faint)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "8px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "7px", flexWrap: "wrap" }}>
            <strong style={{ fontSize: "13px" }}>{p.manifest.name}</strong>
            <span style={{ fontFamily: "var(--mono)", fontSize: "11px", color: "var(--dim)" }}>
              {p.id} v{p.manifest.version}
            </span>
            <span
              style={{
                fontFamily: "var(--mono)",
                fontSize: "10px",
                padding: "1px 5px",
                borderRadius: "4px",
                background: "var(--wash)",
                border: "1px solid var(--faint)",
                color: "var(--dim)",
              }}
            >
              host:{affinity}
            </span>
            {shaBadge && (
              <span
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: "10px",
                  padding: "1px 5px",
                  borderRadius: "4px",
                  background: "rgba(61, 107, 255, 0.14)",
                  color: "#8cb4ff",
                }}
                title={`Pinned commit ${p.source.commitSha}`}
              >
                #{shaBadge}
              </span>
            )}
            {p.grantedPermissions.map((perm) => (
              <span
                key={perm}
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: "10px",
                  padding: "1px 5px",
                  borderRadius: "4px",
                  background: "rgba(255, 228, 92, 0.12)",
                  color: "var(--unknown, #ffe45c)",
                }}
              >
                {perm}
              </span>
            ))}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
            <button
              type="button"
              className={`btn${p.enabled ? " btn-primary" : ""}`}
              disabled={isBusy}
              onClick={async () => {
                setBusyId(`${p.scope}:${p.id}`);
                await window.ide2.setPluginEnabled({
                  pluginId: p.id,
                  enabled: !p.enabled,
                  scope: p.scope,
                });
                await onRefreshPlugins();
                setBusyId(null);
              }}
            >
              {p.enabled ? "Enabled" : "Disabled"}
            </button>

            {p.source.kind !== "builtin" && (
              <>
                <button
                  type="button"
                  className="btn"
                  disabled={isBusy}
                  onClick={async () => {
                    setBusyId(`${p.scope}:${p.id}`);
                    const res = await window.ide2.updatePlugin({
                      pluginId: p.id,
                      scope: p.scope,
                      approvePermissions: true,
                    });
                    if (res.error) setError(res.error);
                    else if (res.upToDate) setStatusMsg(`${p.id} is already up to date.`);
                    else setStatusMsg(`Updated ${p.id} to v${res.updated?.manifest.version}`);
                    await onRefreshPlugins();
                    setBusyId(null);
                  }}
                >
                  Update
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={isBusy}
                  onClick={async () => {
                    setBusyId(`${p.scope}:${p.id}`);
                    await window.ide2.removePlugin({ pluginId: p.id, scope: p.scope });
                    await onRefreshPlugins();
                    setBusyId(null);
                  }}
                >
                  Remove
                </button>
              </>
            )}
          </div>
        </div>

        {p.manifest.description && (
          <div style={{ color: "var(--dim)", fontSize: "11.5px" }}>{p.manifest.description}</div>
        )}
        <div style={{ fontFamily: "var(--mono)", fontSize: "10.5px", color: "var(--dim)" }}>
          Source: {p.source.spec}
          {p.source.linked ? " (symlinked dev mode — auto hot-reload)" : ""}
        </div>
        {p.error && (
          <div
            style={{
              color: "var(--danger, #ff5d4d)",
              fontFamily: "var(--mono)",
              fontSize: "11px",
            }}
          >
            Error: {p.error}
          </div>
        )}
      </div>
    );
  };

  const localPlugins = plugins.filter((p) => p.scope === "local");
  const remotePlugins = plugins.filter((p) => p.scope === "remote");

  return (
    <div style={backdropStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: "680px" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ height: "2px", background: "var(--expect2-trail-bar)" }} />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 16px",
            borderBottom: "1px solid var(--faint)",
          }}
        >
          <div>
            <div style={{ fontWeight: 600, fontSize: "13.5px" }}>Manage ide2 Plugins</div>
            <div style={{ fontSize: "11.5px", color: "var(--dim)", marginTop: "2px" }}>
              Install extensions from GitHub repositories (`owner/repo[#ref]`) with pinned commit SHAs
            </div>
          </div>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            ×
          </button>
        </div>

        <div
          style={{
            padding: "14px 16px",
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: "14px",
          }}
        >
          {/* GitHub / Local Install Bar */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "8px",
              padding: "12px",
              borderRadius: "8px",
              background: "var(--paper)",
              border: "1px solid var(--faint)",
            }}
          >
            <div style={{ display: "flex", gap: "8px" }}>
              <input
                type="text"
                value={spec}
                onChange={(e) => {
                  setSpec(e.target.value);
                  setPendingApproval(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleInstall(false);
                  }
                }}
                placeholder="owner/repo, owner/repo#v0.1.0, or ./local-plugin"
                style={{ ...inputStyle, flex: 1 }}
              />
              <button
                type="button"
                className="btn btn-primary"
                disabled={installing}
                onClick={() => void handleInstall(false)}
              >
                {installing ? "Installing…" : "Install Plugin"}
              </button>
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "10px",
                flexWrap: "wrap",
              }}
            >
              <label
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  fontSize: "11.5px",
                  color: "var(--dim)",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={linkLocal}
                  onChange={(e) => setLinkLocal(e.target.checked)}
                />
                <span>Symlink local folder (hot-reload on save)</span>
              </label>

              {connection.isRemote && (
                <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "11.5px" }}>
                  <span style={{ color: "var(--dim)" }}>Install target:</span>
                  <select
                    value={targetScope}
                    onChange={(e) => setTargetScope(e.target.value as "local" | "remote")}
                    style={{
                      background: "var(--screen)",
                      color: "var(--ink)",
                      border: "1px solid var(--border-strong)",
                      borderRadius: "5px",
                      padding: "2px 6px",
                      fontSize: "11.5px",
                    }}
                  >
                    <option value="local">Local Laptop (`host: client`)</option>
                    <option value="remote">
                      Remote SSH ({connection.sshHost} · `host: workspace`)
                    </option>
                  </select>
                </div>
              )}
            </div>

            {pendingApproval && (
              <div
                style={{
                  padding: "10px 12px",
                  borderRadius: "6px",
                  border: "1px solid rgba(255, 228, 92, 0.45)",
                  background: "rgba(255, 228, 92, 0.08)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                }}
              >
                <div style={{ fontWeight: 600, color: "var(--unknown, #ffe45c)" }}>
                  Approve Requested Plugin Permissions?
                </div>
                <div style={{ fontSize: "12px", color: "var(--ink)" }}>
                  <strong>{pendingApproval.manifest.name}</strong> (
                  <code>{pendingApproval.manifest.id}</code>
                  {pendingApproval.commitSha
                    ? ` @ ${pendingApproval.commitSha.slice(0, 10)}`
                    : ""}
                  ) requests:{" "}
                  <code>[{pendingApproval.requestedPermissions.join(", ")}]</code>
                </div>
                <div style={{ display: "flex", gap: "8px", marginTop: "2px" }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={installing}
                    onClick={() => void handleInstall(true)}
                  >
                    Approve &amp; Install
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setPendingApproval(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {statusMsg && (
              <div style={{ color: "var(--safe, #6dffa6)", fontSize: "11.5px" }}>✔ {statusMsg}</div>
            )}
            {error && (
              <div
                style={{
                  color: "var(--danger, #ff5d4d)",
                  fontFamily: "var(--mono)",
                  fontSize: "11.5px",
                  whiteSpace: "pre-wrap",
                }}
              >
                {error}
              </div>
            )}
          </div>

          {/* Local Plugins Section */}
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--dim)" }}>
              LOCAL PLUGINS ({localPlugins.length})
              {connection.isRemote ? " — `host: client` plugins active across all SSH hosts" : ""}
            </div>
            {localPlugins.length === 0 ? (
              <div style={{ color: "var(--dim)", fontSize: "12px" }}>No local plugins installed.</div>
            ) : (
              localPlugins.map(renderPluginRow)
            )}
          </div>

          {/* Remote SSH Workspace Plugins Section */}
          {connection.isRemote && (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--dim)" }}>
                REMOTE WORKSPACE PLUGINS ON {connection.sshHost?.toUpperCase()} ({remotePlugins.length})
              </div>
              {remotePlugins.length === 0 ? (
                <div style={{ color: "var(--dim)", fontSize: "12px" }}>
                  No `host: workspace` plugins installed on {connection.sshHost}.
                </div>
              ) : (
                remotePlugins.map(renderPluginRow)
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
