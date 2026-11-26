import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatShortcut, type Platform } from "./keymap.js";
import type { EditorTab, SplitDirection } from "./tab-actions.js";

export interface TabContextMenuProps {
  x: number;
  y: number;
  tab: EditorTab;
  tabIndex: number;
  totalTabs: number;
  hasOtherClosableTabs: boolean;
  hasLeftClosableTabs: boolean;
  hasRightClosableTabs: boolean;
  hasUnmodifiedClosableTabs: boolean;
  hasSplitOpen: boolean;
  currentLine?: number;
  isActiveTab: boolean;
  worktreePath: string;
  platform: Platform;
  onCloseTab: (tabId: string) => void;
  onCloseOtherTabs: (tabId: string) => void;
  onCloseAllTabs: () => void;
  onCloseTabsToLeft: (tabId: string) => void;
  onCloseTabsToRight: (tabId: string) => void;
  onCloseUnmodifiedTabs: () => void;
  onTogglePinTab: (tabId: string) => void;
  onSplitTab: (tabId: string, direction: SplitDirection) => void;
  onUnsplit: () => void;
  onCopyText: (text: string, label: string) => void;
  onSelectInProject: (filePath: string) => void;
  onToggleDiffForTab: (tab: EditorTab) => void;
  onRevealInOs: (absolutePath: string) => void;
  onDismiss: () => void;
}

type MenuItemEntry =
  | { kind: "separator"; id: string }
  | {
      kind: "item";
      id: string;
      label: string;
      shortcut?: string;
      disabled?: boolean;
      onSelect: () => void;
    };

function joinOsPath(root: string, relPosix: string, platform: Platform): string {
  const cleanRoot = root.replace(/[\\/]+$/, "");
  if (platform === "win32") {
    return `${cleanRoot}\\${relPosix.split("/").join("\\")}`;
  }
  return `${cleanRoot}/${relPosix}`;
}

export const TabContextMenu: React.FC<TabContextMenuProps> = ({
  x,
  y,
  tab,
  hasOtherClosableTabs,
  hasLeftClosableTabs,
  hasRightClosableTabs,
  hasUnmodifiedClosableTabs,
  hasSplitOpen,
  currentLine,
  isActiveTab,
  worktreePath,
  platform,
  onCloseTab,
  onCloseOtherTabs,
  onCloseAllTabs,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseUnmodifiedTabs,
  onTogglePinTab,
  onSplitTab,
  onUnsplit,
  onCopyText,
  onSelectInProject,
  onToggleDiffForTab,
  onRevealInOs,
  onDismiss,
}) => {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const fileName = tab.filePath.split("/").pop() ?? tab.filePath;
  const absolutePath = joinOsPath(worktreePath, tab.filePath, platform);
  const revealLabel =
    platform === "darwin"
      ? "Open in Finder"
      : platform === "win32"
        ? "Show in Explorer"
        : "Show in File Manager";

  const entries = useMemo<MenuItemEntry[]>(() => {
    const list: MenuItemEntry[] = [
      {
        kind: "item",
        id: "close",
        label: "Close",
        shortcut: formatShortcut("close-tab", platform),
        onSelect: () => onCloseTab(tab.id),
      },
      {
        kind: "item",
        id: "close-others",
        label: "Close Other Tabs",
        disabled: !hasOtherClosableTabs,
        onSelect: () => onCloseOtherTabs(tab.id),
      },
      {
        kind: "item",
        id: "close-all",
        label: "Close All Tabs",
        onSelect: () => onCloseAllTabs(),
      },
      {
        kind: "item",
        id: "close-left",
        label: "Close Tabs to the Left",
        disabled: !hasLeftClosableTabs,
        onSelect: () => onCloseTabsToLeft(tab.id),
      },
      {
        kind: "item",
        id: "close-right",
        label: "Close Tabs to the Right",
        disabled: !hasRightClosableTabs,
        onSelect: () => onCloseTabsToRight(tab.id),
      },
      {
        kind: "item",
        id: "close-unmodified",
        label: "Close Unmodified Tabs",
        disabled: !hasUnmodifiedClosableTabs,
        onSelect: () => onCloseUnmodifiedTabs(),
      },
      { kind: "separator", id: "sep-pin" },
      {
        kind: "item",
        id: "pin",
        label: tab.pinned ? "Unpin Tab" : "Pin Tab",
        onSelect: () => onTogglePinTab(tab.id),
      },
      { kind: "separator", id: "sep-split" },
      {
        kind: "item",
        id: "split-right",
        label: "Split Right",
        shortcut: formatShortcut("split-right", platform),
        onSelect: () => onSplitTab(tab.id, "right"),
      },
      {
        kind: "item",
        id: "split-down",
        label: "Split Down",
        onSelect: () => onSplitTab(tab.id, "down"),
      },
    ];

    if (hasSplitOpen) {
      list.push({
        kind: "item",
        id: "unsplit",
        label: "Unsplit",
        onSelect: () => onUnsplit(),
      });
    }

    list.push(
      { kind: "separator", id: "sep-copy" },
      {
        kind: "item",
        id: "copy-rel",
        label: "Copy Path from Content Root",
        onSelect: () => onCopyText(tab.filePath, "Copied path from content root"),
      },
      {
        kind: "item",
        id: "copy-abs",
        label: "Copy Absolute Path",
        onSelect: () => onCopyText(absolutePath, "Copied absolute path"),
      },
      {
        kind: "item",
        id: "copy-name",
        label: "Copy File Name",
        onSelect: () => onCopyText(fileName, "Copied file name"),
      },
    );

    if (isActiveTab && currentLine) {
      list.push({
        kind: "item",
        id: "copy-line",
        label: `Copy Path with Line (:${currentLine})`,
        onSelect: () =>
          onCopyText(`${tab.filePath}:${currentLine}`, `Copied ${tab.filePath}:${currentLine}`),
      });
    }

    list.push(
      { kind: "separator", id: "sep-nav" },
      {
        kind: "item",
        id: "select-project",
        label: "Select Opened File in Project",
        onSelect: () => onSelectInProject(tab.filePath),
      },
      {
        kind: "item",
        id: "toggle-diff",
        label: tab.viewKind === "diff" ? "Open Source" : "Show Diff",
        shortcut: formatShortcut("toggle-diff", platform),
        onSelect: () => onToggleDiffForTab(tab),
      },
      {
        kind: "item",
        id: "reveal-os",
        label: revealLabel,
        onSelect: () => onRevealInOs(absolutePath),
      },
    );

    return list;
  }, [
    tab,
    platform,
    hasOtherClosableTabs,
    hasLeftClosableTabs,
    hasRightClosableTabs,
    hasUnmodifiedClosableTabs,
    hasSplitOpen,
    isActiveTab,
    currentLine,
    absolutePath,
    fileName,
    revealLabel,
    onCloseTab,
    onCloseOtherTabs,
    onCloseAllTabs,
    onCloseTabsToLeft,
    onCloseTabsToRight,
    onCloseUnmodifiedTabs,
    onTogglePinTab,
    onSplitTab,
    onUnsplit,
    onCopyText,
    onSelectInProject,
    onToggleDiffForTab,
    onRevealInOs,
  ]);

  const actionableItems = useMemo(
    () => entries.filter((e): e is Extract<MenuItemEntry, { kind: "item" }> => e.kind === "item" && !e.disabled),
    [entries],
  );

  // Keep menu clamped inside viewport bounds
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    const maxLeft = Math.max(pad, window.innerWidth - rect.width - pad);
    const maxTop = Math.max(pad, window.innerHeight - rect.height - pad);
    setPos({
      left: Math.min(Math.max(pad, x), maxLeft),
      top: Math.min(Math.max(pad, y), maxTop),
    });
  }, [x, y, entries.length]);

  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onDismiss();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        if (actionableItems.length === 0) return;
        const curIdx = actionableItems.findIndex((i) => i.id === focusedId);
        const delta = e.key === "ArrowDown" ? 1 : -1;
        const nextIdx =
          curIdx === -1
            ? delta > 0
              ? 0
              : actionableItems.length - 1
            : (curIdx + delta + actionableItems.length) % actionableItems.length;
        setFocusedId(actionableItems[nextIdx]!.id);
      } else if (e.key === "Enter" && focusedId) {
        const hit = actionableItems.find((i) => i.id === focusedId);
        if (hit) {
          e.preventDefault();
          e.stopPropagation();
          hit.onSelect();
          onDismiss();
        }
      }
    };

    window.addEventListener("mousedown", handleMouseDown, true);
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("blur", onDismiss);
    return () => {
      window.removeEventListener("mousedown", handleMouseDown, true);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("blur", onDismiss);
    };
  }, [actionableItems, focusedId, onDismiss]);

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={`Tab actions for ${fileName}`}
      style={{
        position: "fixed",
        left: `${pos.left}px`,
        top: `${pos.top}px`,
        minWidth: "240px",
        padding: "5px",
        background: "var(--wash)",
        border: "1px solid var(--border-strong)",
        borderRadius: "8px",
        boxShadow: "var(--shadow-popup)",
        zIndex: 1300,
        fontFamily: "var(--ui-font)",
        fontSize: "12.5px",
        color: "var(--ink)",
        userSelect: "none",
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {entries.map((entry) => {
        if (entry.kind === "separator") {
          return (
            <div
              key={entry.id}
              role="separator"
              style={{
                height: "1px",
                background: "var(--faint)",
                margin: "4px 6px",
              }}
            />
          );
        }

        const isFocused = focusedId === entry.id && !entry.disabled;
        return (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            onMouseEnter={() => {
              if (!entry.disabled) setFocusedId(entry.id);
            }}
            onMouseLeave={() => {
              if (focusedId === entry.id) setFocusedId(null);
            }}
            onClick={() => {
              if (entry.disabled) return;
              entry.onSelect();
              onDismiss();
            }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "18px",
              width: "100%",
              padding: "5px 10px",
              border: "none",
              borderRadius: "5px",
              background: isFocused ? "var(--selection)" : "transparent",
              color: entry.disabled
                ? "var(--off)"
                : isFocused
                  ? "#ffffff"
                  : "var(--ink)",
              fontFamily: "inherit",
              fontSize: "12.5px",
              textAlign: "left",
              cursor: entry.disabled ? "default" : "pointer",
            }}
          >
            <span>{entry.label}</span>
            {entry.shortcut && (
              <span
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: "11px",
                  color: entry.disabled
                    ? "var(--off)"
                    : isFocused
                      ? "rgba(255,255,255,0.8)"
                      : "var(--dim)",
                }}
              >
                {entry.shortcut}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};
