import React from "react";
import type { DiffScope, WorktreeInfo } from "../shared/protocol.js";

export interface PluginToolWindowProps {
  worktree?: WorktreeInfo;
  worktrees: readonly WorktreeInfo[];
  activeFilePath?: string;
  activeLine?: number;
  rpc: {
    call<T = unknown>(method: string, payload?: unknown): Promise<T>;
  };
  subscribeServerEvent: (
    event: string,
    listener: (payload: unknown) => void,
  ) => () => void;
  openFile: (
    filePath: string,
    options?: { line?: number; viewKind?: "code" | "diff"; diffScope?: DiffScope },
  ) => void;
  openExternalUrl: (url: string) => void;
  addReviewNote: (params: {
    filePath?: string;
    startLine?: number;
    endLine?: number;
    comment: string;
  }) => Promise<void>;
}

export interface PluginViewportProps extends PluginToolWindowProps {
  filePath: string;
}

export interface PluginClientRegistrationContext {
  readonly pluginId: string;
  registerToolWindow(id: string, component: React.ComponentType<PluginToolWindowProps>): void;
  registerViewport(id: string, component: React.ComponentType<PluginViewportProps>): void;
}

export type PluginClientContributeFn = (
  ctx: PluginClientRegistrationContext,
) => (() => void) | void;

export function defineClientPlugin(fn: PluginClientContributeFn): PluginClientContributeFn {
  return fn;
}

/* -------------------------------------------------------------------------- */
/* Curated Cold-Tonal Host UI Primitives (`@expect2/ide2-plugin/client`)      */
/* -------------------------------------------------------------------------- */

export const PluginPanel: React.FC<{
  title: string;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
  onClose?: () => void;
  children: React.ReactNode;
}> = ({ title, badge, actions, onClose, children }) => (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      height: "100%",
      minHeight: 0,
      background: "var(--paper)",
      color: "var(--ink)",
      fontFamily: "var(--ui-font)",
      fontSize: "12px",
    }}
  >
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "8px",
        height: "32px",
        padding: "0 10px",
        borderBottom: "1px solid var(--faint)",
        background: "var(--wash)",
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0 }}>
        <span style={{ fontWeight: 600, color: "var(--ink)", fontSize: "12px" }}>{title}</span>
        {badge}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
        {actions}
        {onClose && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onClose}
            title="Hide Tool Window"
            style={{ padding: "1px 6px", fontSize: "13px" }}
          >
            ×
          </button>
        )}
      </div>
    </div>
    <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "10px" }}>{children}</div>
  </div>
);

export const PluginBadge: React.FC<{
  tone?: "neutral" | "success" | "warning" | "error" | "accent";
  children: React.ReactNode;
}> = ({ tone = "neutral", children }) => {
  const palette: Record<
    NonNullable<typeof tone>,
    { bg: string; border: string; fg: string }
  > = {
    neutral: { bg: "var(--wash)", border: "var(--faint)", fg: "var(--dim)" },
    success: {
      bg: "rgba(109, 255, 166, 0.12)",
      border: "rgba(109, 255, 166, 0.35)",
      fg: "var(--safe, #6dffa6)",
    },
    warning: {
      bg: "rgba(255, 228, 92, 0.12)",
      border: "rgba(255, 228, 92, 0.35)",
      fg: "var(--unknown, #ffe45c)",
    },
    error: {
      bg: "rgba(255, 93, 77, 0.14)",
      border: "rgba(255, 93, 77, 0.42)",
      fg: "var(--danger, #ff5d4d)",
    },
    accent: {
      bg: "rgba(61, 107, 255, 0.16)",
      border: "rgba(61, 107, 255, 0.45)",
      fg: "#8cb4ff",
    },
  };
  const colors = palette[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        padding: "1px 6px",
        borderRadius: "4px",
        fontSize: "10.5px",
        fontFamily: "var(--mono)",
        fontWeight: 600,
        background: colors.bg,
        border: `1px solid ${colors.border}`,
        color: colors.fg,
      }}
    >
      {children}
    </span>
  );
};

export const PluginButton: React.FC<{
  variant?: "default" | "primary" | "ghost";
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
  children: React.ReactNode;
}> = ({ variant = "default", disabled, title, onClick, children }) => (
  <button
    type="button"
    disabled={disabled}
    title={title}
    onClick={onClick}
    className={`btn${variant === "primary" ? " btn-primary" : variant === "ghost" ? " btn-ghost" : ""}`}
    style={{ fontSize: "11.5px" }}
  >
    {children}
  </button>
);

export const PluginEmptyState: React.FC<{
  title: string;
  detail?: string;
  action?: React.ReactNode;
}> = ({ title, detail, action }) => (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "flex-start",
      gap: "6px",
      padding: "14px",
      borderRadius: "8px",
      border: "1px solid var(--faint)",
      background: "var(--wash)",
    }}
  >
    <div style={{ fontWeight: 600, color: "var(--ink)", fontSize: "12.5px" }}>{title}</div>
    {detail && <div style={{ color: "var(--dim)", fontSize: "11.5px", lineHeight: 1.45 }}>{detail}</div>}
    {action && <div style={{ marginTop: "4px" }}>{action}</div>}
  </div>
);
