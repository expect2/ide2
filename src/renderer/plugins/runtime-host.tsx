import React, { useEffect, useState } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import * as clientSdk from "../../plugin-sdk/client.js";
import type {
  PluginClientContributeFn,
  PluginToolWindowProps,
  PluginViewportProps,
} from "../../plugin-sdk/client.js";
import type {
  InstalledPluginInfo,
  PluginAgentCardState,
  PluginLineDecoration,
} from "../../shared/protocol.js";

// Expose single shared React 19 + SDK instance to dynamically imported plugin ESM bundles
(
  globalThis as unknown as {
    __IDE2_PLUGIN_RUNTIME__?: {
      React: typeof React;
      jsxRuntime: typeof jsxRuntime;
      sdk: typeof clientSdk;
    };
  }
).__IDE2_PLUGIN_RUNTIME__ = {
  React,
  jsxRuntime,
  sdk: clientSdk,
};

export interface RegisteredClientContributions {
  toolWindows: Map<string, React.ComponentType<PluginToolWindowProps>>;
  viewports: Map<string, React.ComponentType<PluginViewportProps>>;
}

export class PluginErrorBoundary extends React.Component<
  { pluginName: string; children: React.ReactNode },
  { error: string | null }
> {
  constructor(props: { pluginName: string; children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(err: unknown): { error: string } {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  override render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: "14px",
            margin: "10px",
            borderRadius: "8px",
            border: "1px solid rgba(255, 93, 77, 0.45)",
            background: "rgba(255, 93, 77, 0.08)",
            color: "var(--ink)",
            fontFamily: "var(--ui-font)",
            fontSize: "12px",
          }}
        >
          <div style={{ fontWeight: 600, color: "var(--danger, #ff5d4d)", marginBottom: "4px" }}>
            Plugin UI Error ({this.props.pluginName})
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: "11px", color: "var(--dim)" }}>
            {this.state.error}
          </div>
          <button
            type="button"
            className="btn"
            style={{ marginTop: "8px" }}
            onClick={() => this.setState({ error: null })}
          >
            Retry Render
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Dynamically imports enabled plugin `client.js` ESM bundles over `ide2://app/__plugins/...`
 * (supporting both laptop-installed `"local"` plugins and SSH-streamed `"remote"` plugins).
 */
export function useLoadedClientPlugins(
  plugins: readonly InstalledPluginInfo[],
  sessionKey: string,
): RegisteredClientContributions {
  const [registry, setRegistry] = useState<RegisteredClientContributions>(() => ({
    toolWindows: new Map(),
    viewports: new Map(),
  }));

  useEffect(() => {
    let cancelled = false;
    const cleanups: Array<() => void> = [];

    const loadAll = async () => {
      const nextToolWindows = new Map<string, React.ComponentType<PluginToolWindowProps>>();
      const nextViewports = new Map<string, React.ComponentType<PluginViewportProps>>();

      for (const plugin of plugins) {
        if (!plugin.enabled || !plugin.hasClientBundle || plugin.error) continue;
        const url = `ide2://app/__plugins/${plugin.scope}/${encodeURIComponent(plugin.id)}/client.js?v=${plugin.updatedAt}&session=${encodeURIComponent(sessionKey)}`;
        try {
          const mod = (await import(/* @vite-ignore */ url)) as {
            default?: PluginClientContributeFn;
          };
          const contribute = mod.default;
          if (typeof contribute !== "function") continue;

          const cleanup = contribute({
            pluginId: plugin.id,
            registerToolWindow: (id, comp) => {
              nextToolWindows.set(`${plugin.id}:${id}`, comp);
            },
            registerViewport: (id, comp) => {
              nextViewports.set(`${plugin.id}:${id}`, comp);
            },
          });
          if (typeof cleanup === "function") {
            cleanups.push(cleanup);
          }
        } catch (err) {
          console.error(`Failed loading client bundle for plugin "${plugin.id}":`, err);
        }
      }

      if (!cancelled) {
        setRegistry({
          toolWindows: nextToolWindows,
          viewports: nextViewports,
        });
      }
    };

    void loadAll();

    return () => {
      cancelled = true;
      for (const fn of cleanups) {
        try {
          fn();
        } catch {
          // ignore
        }
      }
    };
  }, [plugins, sessionKey]);

  return registry;
}

export function matchesPluginFilePattern(filePath: string, patterns: readonly string[]): boolean {
  const lower = filePath.toLowerCase();
  const base = lower.split("/").pop() ?? lower;
  for (const raw of patterns) {
    const pat = raw.trim().toLowerCase();
    if (!pat) continue;
    if (pat.startsWith("*.")) {
      const suffix = pat.slice(1); // e.g. `.trace.json`
      if (lower.endsWith(suffix)) return true;
    } else if (base === pat || lower.endsWith(`/${pat}`)) {
      return true;
    }
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Inline Code / Diff Decoration Strip                                        */
/* -------------------------------------------------------------------------- */

export const PluginDecorationCards: React.FC<{
  decorations: readonly PluginLineDecoration[];
  onOpenExternalUrl?: (url: string) => void;
  onQuickAnnotate?: (dec: PluginLineDecoration) => void;
}> = ({ decorations, onOpenExternalUrl, onQuickAnnotate }) => {
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  if (decorations.length === 0) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px", marginBottom: "4px" }}>
      {decorations.map((dec) => {
        const isExpanded = Boolean(expandedIds[dec.id]);
        const borderColor =
          dec.severity === "error"
            ? "rgba(255, 93, 77, 0.42)"
            : dec.severity === "warning"
              ? "rgba(255, 228, 92, 0.38)"
              : dec.severity === "success"
                ? "rgba(109, 255, 166, 0.38)"
                : "rgba(61, 107, 255, 0.42)";
        const accentColor =
          dec.severity === "error"
            ? "var(--danger, #ff5d4d)"
            : dec.severity === "warning"
              ? "var(--unknown, #ffe45c)"
              : dec.severity === "success"
                ? "var(--safe, #6dffa6)"
                : "#8cb4ff";

        return (
          <div
            key={dec.id}
            onClick={(e) => e.stopPropagation()}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "4px",
              padding: "5px 10px",
              borderRadius: "6px",
              background: "var(--wash)",
              border: `1px solid ${borderColor}`,
              fontFamily: "var(--ui-font)",
              fontSize: "11.5px",
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
              <div style={{ display: "flex", alignItems: "center", gap: "7px", minWidth: 0 }}>
                <span
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: "10px",
                    fontWeight: 700,
                    color: accentColor,
                    padding: "1px 5px",
                    borderRadius: "4px",
                    border: `1px solid ${borderColor}`,
                    flexShrink: 0,
                  }}
                >
                  {dec.gutterBadge ?? dec.pluginId.toUpperCase()}
                </span>
                <span
                  style={{
                    color: "var(--ink)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {dec.title}
                </span>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
                {dec.hoverMarkdown && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ fontSize: "11px", padding: "1px 6px" }}
                    onClick={() =>
                      setExpandedIds((prev) => ({ ...prev, [dec.id]: !prev[dec.id] }))
                    }
                  >
                    {isExpanded ? "Hide" : "Details"}
                  </button>
                )}
                {dec.url && onOpenExternalUrl && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ fontSize: "11px", padding: "1px 6px" }}
                    onClick={() => onOpenExternalUrl(dec.url!)}
                  >
                    Open ↗
                  </button>
                )}
                {onQuickAnnotate && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ fontSize: "11px", padding: "1px 6px" }}
                    onClick={() => onQuickAnnotate(dec)}
                  >
                    + Add to Review
                  </button>
                )}
              </div>
            </div>

            {isExpanded && dec.hoverMarkdown && (
              <pre
                style={{
                  margin: 0,
                  padding: "6px 8px",
                  borderRadius: "4px",
                  background: "var(--screen)",
                  color: "var(--dim)",
                  fontFamily: "var(--mono)",
                  fontSize: "11px",
                  whiteSpace: "pre-wrap",
                  overflowX: "auto",
                }}
              >
                {dec.hoverMarkdown}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Agent-Driven Plugin Interactive Card (`ide2 x <subcommand> --wait`)        */
/* -------------------------------------------------------------------------- */

export const PluginAgentCardBanner: React.FC<{
  card: PluginAgentCardState;
  onRespond: (sessionId: string, action: string, message?: string) => void;
}> = ({ card, onRespond }) => {
  const [replyText, setReplyText] = useState<string>("");

  return (
    <div
      style={{
        margin: "8px 12px",
        padding: "12px 14px",
        borderRadius: "8px",
        border: "1px solid rgba(61, 107, 255, 0.5)",
        background: "var(--wash)",
        boxShadow: "var(--shadow-popup)",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        fontFamily: "var(--ui-font)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span
            style={{
              fontSize: "10.5px",
              fontFamily: "var(--mono)",
              fontWeight: 700,
              padding: "2px 6px",
              borderRadius: "4px",
              background: "rgba(61, 107, 255, 0.18)",
              color: "#8cb4ff",
            }}
          >
            {card.pluginName} · ide2 x {card.subcommand}
          </span>
          <strong style={{ fontSize: "13px", color: "var(--ink)" }}>{card.title}</strong>
        </div>
      </div>

      <div
        style={{
          fontSize: "12px",
          color: "var(--ink)",
          whiteSpace: "pre-wrap",
          fontFamily: "var(--mono)",
          background: "var(--screen)",
          padding: "8px 10px",
          borderRadius: "6px",
          border: "1px solid var(--faint)",
          maxHeight: "220px",
          overflow: "auto",
        }}
      >
        {card.markdown}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px",
          flexWrap: "wrap",
        }}
      >
        {card.allowFreeformReply && (
          <input
            type="text"
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            placeholder="Optional note / steering reply back to agent…"
            style={{
              flex: 1,
              minWidth: "220px",
              background: "var(--screen)",
              border: "1px solid var(--border-strong)",
              borderRadius: "6px",
              color: "var(--ink)",
              padding: "5px 9px",
              fontSize: "12px",
            }}
          />
        )}
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          {card.choices.map((choice) => (
            <button
              key={choice.id}
              type="button"
              className={`btn${choice.kind === "primary" ? " btn-primary" : ""}`}
              onClick={() => onRespond(card.sessionId, choice.id, replyText.trim() || undefined)}
            >
              {choice.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
