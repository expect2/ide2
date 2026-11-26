import { describe, expect, it } from "vitest";
import {
  closeAllTabs,
  closeOtherTabs,
  closeTab,
  closeTabsToLeft,
  closeTabsToRight,
  closeUnmodifiedTabs,
  togglePinTab,
  type TabBarState,
} from "../src/renderer/shell/tab-actions.js";

function makeState(): TabBarState {
  return {
    tabs: [
      { id: "code:a.ts", filePath: "a.ts", viewKind: "code", pinned: true },
      { id: "code:b.ts", filePath: "b.ts", viewKind: "code" },
      { id: "code:c.ts", filePath: "c.ts", viewKind: "code" },
      { id: "code:d.ts", filePath: "d.ts", viewKind: "code" },
    ],
    activeTabId: "code:c.ts",
    splitTabId: "code:d.ts",
    splitDirection: "right",
  };
}

describe("JetBrains tab context menu operations", () => {
  it("closeTab closes target tab and selects nearest neighbor while clearing closed split", () => {
    const next = closeTab(makeState(), "code:d.ts");
    expect(next.tabs.map((t) => t.id)).toEqual(["code:a.ts", "code:b.ts", "code:c.ts"]);
    expect(next.activeTabId).toBe("code:c.ts");
    expect(next.splitTabId).toBeNull();

    const next2 = closeTab(next, "code:c.ts");
    expect(next2.activeTabId).toBe("code:b.ts");
  });

  it("closeOtherTabs preserves target tab and pinned tabs", () => {
    const next = closeOtherTabs(makeState(), "code:c.ts");
    expect(next.tabs.map((t) => t.id)).toEqual(["code:a.ts", "code:c.ts"]);
    expect(next.activeTabId).toBe("code:c.ts");
    expect(next.splitTabId).toBeNull();
  });

  it("closeAllTabs closes unpinned tabs first, then closes pinned tabs if none are unpinned", () => {
    const step1 = closeAllTabs(makeState());
    expect(step1.tabs.map((t) => t.id)).toEqual(["code:a.ts"]);
    expect(step1.activeTabId).toBe("code:a.ts");

    const step2 = closeAllTabs(step1);
    expect(step2.tabs).toEqual([]);
    expect(step2.activeTabId).toBeNull();
  });

  it("closeTabsToLeft and closeTabsToRight respect pinned tabs", () => {
    const leftClosed = closeTabsToLeft(makeState(), "code:c.ts");
    expect(leftClosed.tabs.map((t) => t.id)).toEqual(["code:a.ts", "code:c.ts", "code:d.ts"]);

    const rightClosed = closeTabsToRight(makeState(), "code:b.ts");
    expect(rightClosed.tabs.map((t) => t.id)).toEqual(["code:a.ts", "code:b.ts"]);
    expect(rightClosed.activeTabId).toBe("code:b.ts");
  });

  it("closeUnmodifiedTabs keeps pinned tabs and git-modified tabs", () => {
    const modified = new Set(["c.ts"]);
    const next = closeUnmodifiedTabs(makeState(), modified);
    expect(next.tabs.map((t) => t.id)).toEqual(["code:a.ts", "code:c.ts"]);
  });

  it("togglePinTab moves newly pinned tabs to the pinned left group and unpins cleanly", () => {
    const pinned = togglePinTab(makeState(), "code:d.ts");
    expect(pinned.tabs.map((t) => t.id)).toEqual([
      "code:a.ts",
      "code:d.ts",
      "code:b.ts",
      "code:c.ts",
    ]);
    expect(pinned.tabs[1]?.pinned).toBe(true);

    const unpinned = togglePinTab(pinned, "code:a.ts");
    expect(unpinned.tabs.map((t) => t.id)).toEqual([
      "code:d.ts",
      "code:a.ts",
      "code:b.ts",
      "code:c.ts",
    ]);
    expect(unpinned.tabs[1]?.pinned).toBe(false);
  });
});
