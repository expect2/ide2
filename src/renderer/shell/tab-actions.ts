import type { DiffScope } from "../../shared/protocol.js";
import type { MarkdownViewMode } from "../views/MarkdownViewer.js";

export interface EditorTab {
  id: string;
  filePath: string;
  viewKind: "code" | "diff";
  pinned?: boolean;
  diffScope?: DiffScope;
  markdownMode?: MarkdownViewMode;
}

export type SplitDirection = "right" | "down";

export interface TabBarState {
  tabs: EditorTab[];
  activeTabId: string | null;
  splitTabId: string | null;
  splitDirection?: SplitDirection;
}

function reconcileSelection(
  prevTabs: readonly EditorTab[],
  nextTabs: EditorTab[],
  prevActiveId: string | null,
  prevSplitId: string | null,
  closedAnchorIndex?: number,
): Pick<TabBarState, "tabs" | "activeTabId" | "splitTabId"> {
  const remainingIds = new Set(nextTabs.map((t) => t.id));

  let activeTabId = prevActiveId;
  if (!activeTabId || !remainingIds.has(activeTabId)) {
    if (nextTabs.length === 0) {
      activeTabId = null;
    } else if (closedAnchorIndex !== undefined) {
      activeTabId = nextTabs[Math.min(closedAnchorIndex, nextTabs.length - 1)]?.id ?? null;
    } else {
      const prevIdx = prevActiveId ? prevTabs.findIndex((t) => t.id === prevActiveId) : 0;
      const safeIdx = prevIdx < 0 ? 0 : Math.min(prevIdx, nextTabs.length - 1);
      activeTabId = nextTabs[safeIdx]?.id ?? null;
    }
  }

  const splitTabId = prevSplitId && remainingIds.has(prevSplitId) ? prevSplitId : null;
  return { tabs: nextTabs, activeTabId, splitTabId };
}

/** Closes a specific tab (even if pinned, when explicitly invoked on that tab). */
export function closeTab(state: TabBarState, tabId: string): TabBarState {
  const idx = state.tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return state;
  const nextTabs = state.tabs.filter((t) => t.id !== tabId);
  return {
    ...state,
    ...reconcileSelection(state.tabs, nextTabs, state.activeTabId, state.splitTabId, idx),
  };
}

/** Closes every unpinned tab except `keepTabId` (JetBrains "Close Other Tabs"). */
export function closeOtherTabs(state: TabBarState, keepTabId: string): TabBarState {
  const nextTabs = state.tabs.filter((t) => t.id === keepTabId || Boolean(t.pinned));
  return {
    ...state,
    ...reconcileSelection(
      state.tabs,
      nextTabs,
      nextTabs.some((t) => t.id === keepTabId) ? keepTabId : state.activeTabId,
      state.splitTabId,
    ),
  };
}

/** Closes all unpinned tabs; if every open tab is pinned, closes all of them. */
export function closeAllTabs(state: TabBarState): TabBarState {
  const hasUnpinned = state.tabs.some((t) => !t.pinned);
  const nextTabs = hasUnpinned ? state.tabs.filter((t) => Boolean(t.pinned)) : [];
  return {
    ...state,
    ...reconcileSelection(state.tabs, nextTabs, state.activeTabId, state.splitTabId),
  };
}

/** Closes all unpinned tabs positioned to the left of `targetTabId`. */
export function closeTabsToLeft(state: TabBarState, targetTabId: string): TabBarState {
  const idx = state.tabs.findIndex((t) => t.id === targetTabId);
  if (idx <= 0) return state;
  const nextTabs = state.tabs.filter((t, i) => i >= idx || Boolean(t.pinned));
  return {
    ...state,
    ...reconcileSelection(state.tabs, nextTabs, state.activeTabId, state.splitTabId),
  };
}

/** Closes all unpinned tabs positioned to the right of `targetTabId`. */
export function closeTabsToRight(state: TabBarState, targetTabId: string): TabBarState {
  const idx = state.tabs.findIndex((t) => t.id === targetTabId);
  if (idx === -1 || idx >= state.tabs.length - 1) return state;
  const nextTabs = state.tabs.filter((t, i) => i <= idx || Boolean(t.pinned));
  return {
    ...state,
    ...reconcileSelection(state.tabs, nextTabs, state.activeTabId, state.splitTabId),
  };
}

/** Closes all unpinned tabs whose file has no Git modifications in the active diff scope. */
export function closeUnmodifiedTabs(
  state: TabBarState,
  modifiedFilePaths: ReadonlySet<string>,
): TabBarState {
  const nextTabs = state.tabs.filter(
    (t) => Boolean(t.pinned) || modifiedFilePaths.has(t.filePath),
  );
  return {
    ...state,
    ...reconcileSelection(state.tabs, nextTabs, state.activeTabId, state.splitTabId),
  };
}

/**
 * Toggles `pinned` on `tabId` and keeps all pinned tabs grouped at the left
 * of the tab bar (exact JetBrains tab-pinning behavior).
 */
export function togglePinTab(state: TabBarState, tabId: string): TabBarState {
  const target = state.tabs.find((t) => t.id === tabId);
  if (!target) return state;

  const toggled: EditorTab = { ...target, pinned: !target.pinned };
  const updated = state.tabs.map((t) => (t.id === tabId ? toggled : t));
  const pinned = updated.filter((t) => Boolean(t.pinned));
  const unpinned = updated.filter((t) => !t.pinned);
  return {
    ...state,
    tabs: [...pinned, ...unpinned],
  };
}
