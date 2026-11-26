import { describe, expect, it } from "vitest";
import {
  DOUBLE_SHIFT_THRESHOLD_MS,
  DoubleShiftDetector,
  KeymapDispatcher,
  formatShortcut,
  matchShortcut,
  type KeyEventLike,
} from "../src/renderer/shell/keymap.js";

function key(
  k: string,
  opts: Partial<Omit<KeyEventLike, "key">> = {},
): KeyEventLike {
  return { key: k, ...opts };
}

describe("DoubleShiftDetector (Shift+Shift)", () => {
  it("triggers search-everywhere when Shift is pressed twice within 320ms", () => {
    const detector = new DoubleShiftDetector();
    expect(detector.onKeyDown(key("Shift", { shiftKey: true }), 1000)).toBe(false);
    expect(detector.onKeyDown(key("Shift", { shiftKey: true }), 1200)).toBe(true);
  });

  it("triggers at the exact 320ms boundary", () => {
    const detector = new DoubleShiftDetector();
    expect(detector.onKeyDown(key("Shift", { shiftKey: true }), 1000)).toBe(false);
    expect(
      detector.onKeyDown(key("Shift", { shiftKey: true }), 1000 + DOUBLE_SHIFT_THRESHOLD_MS),
    ).toBe(true);
  });

  it("does not trigger when gap exceeds 320ms", () => {
    const detector = new DoubleShiftDetector();
    expect(detector.onKeyDown(key("Shift", { shiftKey: true }), 1000)).toBe(false);
    expect(detector.onKeyDown(key("Shift", { shiftKey: true }), 1321)).toBe(false);
    // Subsequent fast Shift after the second tap still works
    expect(detector.onKeyDown(key("Shift", { shiftKey: true }), 1450)).toBe(true);
  });

  it("requires another pair after triggering (3rd Shift does not double-fire)", () => {
    const detector = new DoubleShiftDetector();
    expect(detector.onKeyDown(key("Shift", { shiftKey: true }), 1000)).toBe(false);
    expect(detector.onKeyDown(key("Shift", { shiftKey: true }), 1100)).toBe(true);
    expect(detector.onKeyDown(key("Shift", { shiftKey: true }), 1180)).toBe(false);
  });

  it("does not trigger when a Shift+letter or another key is typed between Shifts", () => {
    const detector = new DoubleShiftDetector();
    expect(detector.onKeyDown(key("Shift", { shiftKey: true }), 1000)).toBe(false);
    // User types capital A while Shift is held
    expect(detector.onKeyDown(key("A", { code: "KeyA", shiftKey: true }), 1080)).toBe(false);
    // Second Shift within 320ms of first Shift must NOT trigger
    expect(detector.onKeyDown(key("Shift", { shiftKey: true }), 1200)).toBe(false);
  });

  it("ignores auto-repeat Shift keydowns and modifier+Shift chords", () => {
    const detector = new DoubleShiftDetector();
    expect(detector.onKeyDown(key("Shift", { shiftKey: true }), 1000)).toBe(false);
    expect(detector.onKeyDown(key("Shift", { shiftKey: true, repeat: true }), 1120)).toBe(false);
    expect(detector.onKeyDown(key("Shift", { shiftKey: true, metaKey: true }), 1150)).toBe(false);
    expect(detector.onKeyDown(key("Shift", { shiftKey: true }), 1250)).toBe(false);
  });
});

describe("matchShortcut — macOS (darwin)", () => {
  it("matches all core JetBrains Cmd shortcuts on darwin", () => {
    expect(matchShortcut(key("O", { metaKey: true, shiftKey: true }), "darwin")).toBe("go-to-file");
    expect(matchShortcut(key("o", { metaKey: true }), "darwin")).toBe("go-to-file");
    expect(
      matchShortcut(key("ø", { code: "KeyO", metaKey: true, altKey: true }), "darwin"),
    ).toBe("go-to-symbol");
    expect(matchShortcut(key("e", { metaKey: true }), "darwin")).toBe("recent-files");
    expect(matchShortcut(key("E", { metaKey: true, shiftKey: true }), "darwin")).toBe(
      "export-prompt-preview",
    );
    expect(matchShortcut(key("F", { metaKey: true, shiftKey: true }), "darwin")).toBe("find-in-path");
    expect(matchShortcut(key("f", { metaKey: true }), "darwin")).toBe("find-in-file");
    expect(matchShortcut(key("l", { metaKey: true }), "darwin")).toBe("go-to-line");
    expect(matchShortcut(key("g", { metaKey: true }), "darwin")).toBe("go-to-line");
    expect(matchShortcut(key("b", { metaKey: true }), "darwin")).toBe("go-to-declaration");
    expect(matchShortcut(key("F7", { altKey: true }), "darwin")).toBe("find-usages");
    expect(matchShortcut(key("[", { metaKey: true }), "darwin")).toBe("nav-back");
    expect(matchShortcut(key("]", { metaKey: true }), "darwin")).toBe("nav-forward");
    expect(matchShortcut(key("1", { metaKey: true }), "darwin")).toBe("tool-project");
    expect(matchShortcut(key("6", { metaKey: true }), "darwin")).toBe("tool-annotations");
    expect(matchShortcut(key("7", { metaKey: true }), "darwin")).toBe("tool-structure");
    expect(matchShortcut(key("9", { metaKey: true }), "darwin")).toBe("tool-git");
    expect(matchShortcut(key("k", { metaKey: true }), "darwin")).toBe("tool-git");
    expect(matchShortcut(key("d", { metaKey: true }), "darwin")).toBe("toggle-diff");
    expect(matchShortcut(key("V", { metaKey: true, shiftKey: true }), "darwin")).toBe(
      "cycle-markdown-mode",
    );
    expect(matchShortcut(key("P", { metaKey: true, shiftKey: true }), "darwin")).toBe(
      "cycle-markdown-mode",
    );
    expect(matchShortcut(key("F7"), "darwin")).toBe("next-change");
    expect(matchShortcut(key("F7", { shiftKey: true }), "darwin")).toBe("prev-change");
    expect(matchShortcut(key("/", { metaKey: true }), "darwin")).toBe("annotate");
    expect(
      matchShortcut(key("µ", { code: "KeyM", metaKey: true, altKey: true }), "darwin"),
    ).toBe("annotate");
    expect(matchShortcut(key("C", { metaKey: true, shiftKey: true }), "darwin")).toBe(
      "copy-feedback-prompt",
    );
    expect(matchShortcut(key("W", { metaKey: true, shiftKey: true }), "darwin")).toBe(
      "switch-worktree",
    );
    expect(matchShortcut(key("N", { metaKey: true, shiftKey: true }), "darwin")).toBe(
      "open-project-window",
    );
    expect(matchShortcut(key("w", { metaKey: true }), "darwin")).toBe("close-tab");
    expect(matchShortcut(key("{", { code: "BracketLeft", metaKey: true, shiftKey: true }), "darwin")).toBe(
      "prev-tab",
    );
    expect(matchShortcut(key("}", { code: "BracketRight", metaKey: true, shiftKey: true }), "darwin")).toBe(
      "next-tab",
    );
    expect(matchShortcut(key("\\", { metaKey: true }), "darwin")).toBe("split-right");
    expect(matchShortcut(key("Escape"), "darwin")).toBe("escape");
  });

  it("does not trigger darwin Cmd shortcuts with Ctrl on macOS", () => {
    expect(matchShortcut(key("e", { ctrlKey: true }), "darwin")).toBeNull();
    expect(matchShortcut(key("w", { ctrlKey: true }), "darwin")).toBeNull();
  });
});

describe("matchShortcut — Linux & Windows", () => {
  for (const platform of ["linux", "win32"] as const) {
    it(`matches Ctrl/Alt JetBrains shortcuts on ${platform}`, () => {
      expect(matchShortcut(key("O", { ctrlKey: true, shiftKey: true }), platform)).toBe(
        "go-to-file",
      );
      expect(matchShortcut(key("o", { ctrlKey: true }), platform)).toBe("go-to-file");
      expect(matchShortcut(key("o", { ctrlKey: true, altKey: true }), platform)).toBe(
        "go-to-symbol",
      );
      expect(
        matchShortcut(key("N", { ctrlKey: true, altKey: true, shiftKey: true }), platform),
      ).toBe("go-to-symbol");
      expect(matchShortcut(key("e", { ctrlKey: true }), platform)).toBe("recent-files");
      expect(matchShortcut(key("E", { ctrlKey: true, shiftKey: true }), platform)).toBe(
        "export-prompt-preview",
      );
      expect(matchShortcut(key("F", { ctrlKey: true, shiftKey: true }), platform)).toBe(
        "find-in-path",
      );
      expect(matchShortcut(key("f", { ctrlKey: true }), platform)).toBe("find-in-file");
      expect(matchShortcut(key("l", { ctrlKey: true }), platform)).toBe("go-to-line");
      expect(matchShortcut(key("b", { ctrlKey: true }), platform)).toBe("go-to-declaration");
      expect(matchShortcut(key("F7", { altKey: true }), platform)).toBe("find-usages");
      expect(
        matchShortcut(key("ArrowLeft", { ctrlKey: true, altKey: true }), platform),
      ).toBe("nav-back");
      expect(
        matchShortcut(key("ArrowRight", { ctrlKey: true, altKey: true }), platform),
      ).toBe("nav-forward");
      expect(matchShortcut(key("1", { altKey: true }), platform)).toBe("tool-project");
      expect(matchShortcut(key("6", { altKey: true }), platform)).toBe("tool-annotations");
      expect(matchShortcut(key("7", { altKey: true }), platform)).toBe("tool-structure");
      expect(matchShortcut(key("9", { altKey: true }), platform)).toBe("tool-git");
      expect(matchShortcut(key("k", { ctrlKey: true }), platform)).toBe("tool-git");
      expect(matchShortcut(key("d", { ctrlKey: true }), platform)).toBe("toggle-diff");
      expect(matchShortcut(key("Tab", { ctrlKey: true }), platform)).toBe("next-tab");
      expect(matchShortcut(key("Tab", { ctrlKey: true, shiftKey: true }), platform)).toBe(
        "prev-tab",
      );
      expect(matchShortcut(key("/", { ctrlKey: true }), platform)).toBe("annotate");
      expect(matchShortcut(key("m", { ctrlKey: true, altKey: true }), platform)).toBe("annotate");
      expect(matchShortcut(key("C", { ctrlKey: true, shiftKey: true }), platform)).toBe(
        "copy-feedback-prompt",
      );
      expect(matchShortcut(key("W", { ctrlKey: true, shiftKey: true }), platform)).toBe(
        "switch-worktree",
      );
      expect(matchShortcut(key("N", { ctrlKey: true, shiftKey: true }), platform)).toBe(
        "open-project-window",
      );
      expect(matchShortcut(key("w", { ctrlKey: true }), platform)).toBe("close-tab");
      expect(matchShortcut(key("\\", { ctrlKey: true }), platform)).toBe("split-right");
    });
  }
});

describe("Zero VIM modal bindings", () => {
  it("never intercepts plain letters or VIM navigation/command keys", () => {
    const vimKeys = ["j", "k", "h", "l", "i", "a", "o", "v", "u", "d", "y", "p", ":", "/", "?", "g", "G", "n", "N"];
    for (const platform of ["darwin", "linux", "win32"] as const) {
      for (const ch of vimKeys) {
        expect(matchShortcut(key(ch), platform)).toBeNull();
        expect(matchShortcut(key(ch, { shiftKey: ch === ch.toUpperCase() && ch !== ch.toLowerCase() }), platform)).toBeNull();
      }
    }
  });
});

describe("KeymapDispatcher & formatShortcut", () => {
  it("combines DoubleShiftDetector and matchShortcut cleanly", () => {
    const dispatcher = new KeymapDispatcher();
    expect(dispatcher.dispatch(key("Shift", { shiftKey: true }), "darwin", 100)).toBeNull();
    expect(dispatcher.dispatch(key("Shift", { shiftKey: true }), "darwin", 250)).toBe(
      "search-everywhere",
    );
    expect(dispatcher.dispatch(key("d", { metaKey: true }), "darwin", 300)).toBe("toggle-diff");
  });

  it("formats crisp platform-native shortcut labels", () => {
    expect(formatShortcut("search-everywhere", "darwin")).toBe("⇧⇧");
    expect(formatShortcut("search-everywhere", "linux")).toBe("Shift+Shift");
    expect(formatShortcut("go-to-file", "darwin")).toBe("⇧⌘O");
    expect(formatShortcut("go-to-file", "win32")).toBe("Ctrl+Shift+O");
    expect(formatShortcut("tool-project", "darwin")).toBe("⌘1");
    expect(formatShortcut("tool-project", "linux")).toBe("Alt+1");
    expect(formatShortcut("open-project-window", "darwin")).toBe("⇧⌘N");
    expect(formatShortcut("open-project-window", "win32")).toBe("Ctrl+Shift+N");
  });
});
