import type { LaunchContext } from "../../shared/protocol.js";

export type Platform = LaunchContext["platform"];

export type IdeAction =
  | "search-everywhere"
  | "go-to-file"
  | "go-to-symbol"
  | "recent-files"
  | "export-prompt-preview"
  | "find-in-path"
  | "find-in-file"
  | "go-to-line"
  | "go-to-declaration"
  | "find-usages"
  | "nav-back"
  | "nav-forward"
  | "tool-project"
  | "tool-annotations"
  | "tool-structure"
  | "tool-git"
  | "toggle-diff"
  | "cycle-markdown-mode"
  | "next-change"
  | "prev-change"
  | "annotate"
  | "copy-feedback-prompt"
  | "switch-worktree"
  | "open-project-window"
  | "close-tab"
  | "prev-tab"
  | "next-tab"
  | "split-right"
  | "escape";

export interface KeyEventLike {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
}

export interface ActionDescriptor {
  action: IdeAction;
  label: string;
  description: string;
  category: "Navigation" | "Search" | "Tool Windows" | "Review" | "Tabs";
}

export const DOUBLE_SHIFT_THRESHOLD_MS = 320;

export const IDE_ACTIONS: readonly ActionDescriptor[] = [
  {
    action: "search-everywhere",
    label: "Search Everywhere",
    description: "Unified search across files, symbols, worktrees, and actions",
    category: "Search",
  },
  {
    action: "go-to-file",
    label: "Go to File",
    description: "Fuzzy path search across current or all worktrees",
    category: "Navigation",
  },
  {
    action: "go-to-symbol",
    label: "Go to Symbol",
    description: "Search Tree-sitter symbols across workspace",
    category: "Navigation",
  },
  {
    action: "recent-files",
    label: "Recent Files & Switcher",
    description: "Switch between tool windows, worktrees, and recent files",
    category: "Navigation",
  },
  {
    action: "export-prompt-preview",
    label: "Export Feedback Prompt",
    description: "Preview, filter, and copy Markdown feedback prompt",
    category: "Review",
  },
  {
    action: "find-in-path",
    label: "Find in Path",
    description: "Full-repo ripgrep search with live code preview",
    category: "Search",
  },
  {
    action: "find-in-file",
    label: "Find in File",
    description: "Open in-file search bar",
    category: "Search",
  },
  {
    action: "go-to-line",
    label: "Go to Line:Column",
    description: "Jump viewport to line[:col]",
    category: "Navigation",
  },
  {
    action: "go-to-declaration",
    label: "Go to Declaration / Usages",
    description: "Jump to symbol definition or list usages",
    category: "Navigation",
  },
  {
    action: "find-usages",
    label: "Find Usages",
    description: "List all references across active worktree",
    category: "Navigation",
  },
  {
    action: "nav-back",
    label: "Navigate Back",
    description: "Jump to previous cursor/file location",
    category: "Navigation",
  },
  {
    action: "nav-forward",
    label: "Navigate Forward",
    description: "Jump to next cursor/file location",
    category: "Navigation",
  },
  {
    action: "tool-project",
    label: "Project Tool Window",
    description: "Toggle Project file tree",
    category: "Tool Windows",
  },
  {
    action: "tool-annotations",
    label: "Annotations Tool Window",
    description: "Toggle Annotations & Feedback composer",
    category: "Tool Windows",
  },
  {
    action: "tool-structure",
    label: "Structure Tool Window",
    description: "Toggle AST symbol outline",
    category: "Tool Windows",
  },
  {
    action: "tool-git",
    label: "Git & Worktrees Tool Window",
    description: "Toggle Git Changes, Worktrees & Log panel",
    category: "Tool Windows",
  },
  {
    action: "toggle-diff",
    label: "Toggle Diff View",
    description: "Toggle diff view for active file",
    category: "Review",
  },
  {
    action: "cycle-markdown-mode",
    label: "Cycle Markdown Mode",
    description: "Cycle Preview / Split / Raw Markdown modes",
    category: "Review",
  },
  {
    action: "next-change",
    label: "Next Change",
    description: "Jump to next diff hunk",
    category: "Review",
  },
  {
    action: "prev-change",
    label: "Previous Change",
    description: "Jump to previous diff hunk",
    category: "Review",
  },
  {
    action: "annotate",
    label: "Annotate Selection / Line",
    description: "Create inline review annotation at active line(s)",
    category: "Review",
  },
  {
    action: "copy-feedback-prompt",
    label: "Copy Feedback Prompt",
    description: "Compile and copy active worktree Markdown feedback prompt",
    category: "Review",
  },
  {
    action: "switch-worktree",
    label: "Switch Worktree",
    description: "Quick-switch between discovered git worktrees",
    category: "Navigation",
  },
  {
    action: "open-project-window",
    label: "Open Project in New Window…",
    description: "Choose another Git repository to open in a new ide2 window",
    category: "Navigation",
  },
  {
    action: "close-tab",
    label: "Close Active Tab",
    description: "Close active editor tab without closing window",
    category: "Tabs",
  },
  {
    action: "prev-tab",
    label: "Previous Tab",
    description: "Select previous tab in active editor group",
    category: "Tabs",
  },
  {
    action: "next-tab",
    label: "Next Tab",
    description: "Select next tab in active editor group",
    category: "Tabs",
  },
  {
    action: "split-right",
    label: "Split Editor Right",
    description: "Open parallel read-only editor split",
    category: "Tabs",
  },
  {
    action: "escape",
    label: "Dismiss / Focus Editor",
    description: "Close active popup and return focus to code viewport",
    category: "Navigation",
  },
];

function isShiftKey(e: KeyEventLike): boolean {
  return e.key === "Shift" || e.code === "ShiftLeft" || e.code === "ShiftRight";
}

function isPureShiftKey(e: KeyEventLike): boolean {
  return isShiftKey(e) && !e.metaKey && !e.ctrlKey && !e.altKey;
}

function normalizeKey(e: KeyEventLike): string {
  // Prefer code for letters/digits/brackets/slashes so macOS Option dead-keys (e.g. Alt+O -> ø) match reliably.
  if (e.code) {
    if (e.code.startsWith("Key") && e.code.length === 4) {
      return e.code.slice(3).toLowerCase();
    }
    if (e.code.startsWith("Digit") && e.code.length === 6) {
      return e.code.slice(5);
    }
    if (e.code === "BracketLeft") return "[";
    if (e.code === "BracketRight") return "]";
    if (e.code === "Slash") return "/";
    if (e.code === "Backslash") return "\\";
    if (e.code === "Tab") return "tab";
    if (e.code === "Escape") return "escape";
    if (e.code === "ArrowLeft") return "arrowleft";
    if (e.code === "ArrowRight") return "arrowright";
    if (/^F\d+$/.test(e.code)) return e.code.toLowerCase();
  }

  const lower = e.key.toLowerCase();
  if (lower === "{") return "[";
  if (lower === "}") return "]";
  if (lower === "?") return "/";
  return lower;
}

/**
 * Stateful detector for JetBrains `Shift+Shift` within 320ms
 * with no other key pressed in between.
 */
export class DoubleShiftDetector {
  private lastShiftDownAt: number | null = null;
  private dirtyBetweenShifts = false;
  private readonly thresholdMs: number;

  constructor(thresholdMs: number = DOUBLE_SHIFT_THRESHOLD_MS) {
    this.thresholdMs = thresholdMs;
  }

  onKeyDown(event: KeyEventLike, now: number = Date.now()): boolean {
    if (isPureShiftKey(event)) {
      if (event.repeat) {
        return false;
      }
      if (
        this.lastShiftDownAt !== null &&
        !this.dirtyBetweenShifts &&
        now - this.lastShiftDownAt <= this.thresholdMs
      ) {
        this.lastShiftDownAt = null;
        this.dirtyBetweenShifts = false;
        return true;
      }
      this.lastShiftDownAt = now;
      this.dirtyBetweenShifts = false;
      return false;
    }

    // Any non-pure-Shift key (including Shift+letter, Cmd+Shift, Ctrl, etc.) invalidates pending Shift tap.
    this.dirtyBetweenShifts = true;
    this.lastShiftDownAt = null;
    return false;
  }

  reset(): void {
    this.lastShiftDownAt = null;
    this.dirtyBetweenShifts = false;
  }
}

/**
 * Pure JetBrains shortcut matcher for a single keydown event.
 * Does not handle `Shift+Shift` (use `DoubleShiftDetector` or `KeymapDispatcher`).
 * Zero VIM modal commands: plain keys without modifiers (except F7/Escape) never match.
 */
export function matchShortcut(event: KeyEventLike, platform: Platform): IdeAction | null {
  if (isShiftKey(event)) {
    return null;
  }

  const isMac = platform === "darwin";
  const meta = Boolean(event.metaKey);
  const ctrl = Boolean(event.ctrlKey);
  const alt = Boolean(event.altKey);
  const shift = Boolean(event.shiftKey);

  // Primary IDE modifier: Cmd on macOS, Ctrl on Linux/Windows
  const mod = isMac ? meta && !ctrl : ctrl && !meta;
  const noMod = !meta && !ctrl && !alt && !shift;
  const key = normalizeKey(event);

  if (key === "escape" && noMod) {
    return "escape";
  }

  if (key === "f7") {
    if (noMod) return "next-change";
    if (!meta && !ctrl && !alt && shift) return "prev-change";
    if (!meta && !ctrl && alt && !shift) return "find-usages";
    return null;
  }

  // Tool windows: Cmd+1/6/7/9 on macOS, Alt+1/6/7/9 on all platforms
  if (alt && !meta && !ctrl && !shift) {
    if (key === "1") return "tool-project";
    if (key === "6") return "tool-annotations";
    if (key === "7") return "tool-structure";
    if (key === "9") return "tool-git";
  }
  if (isMac && meta && !ctrl && !alt && !shift) {
    if (key === "1") return "tool-project";
    if (key === "6") return "tool-annotations";
    if (key === "7") return "tool-structure";
    if (key === "9") return "tool-git";
  }

  // Navigation Back / Forward
  if (isMac) {
    if (meta && !ctrl && !alt && !shift) {
      if (key === "[") return "nav-back";
      if (key === "]") return "nav-forward";
    }
  } else {
    if (ctrl && alt && !meta && !shift) {
      if (key === "arrowleft") return "nav-back";
      if (key === "arrowright") return "nav-forward";
    }
  }

  // Tab switching: Cmd+Shift+[ / ] or Ctrl+Tab / Ctrl+Shift+Tab
  if (ctrl && !meta && !alt && key === "tab") {
    return shift ? "prev-tab" : "next-tab";
  }
  if (mod && shift && !alt) {
    if (key === "[") return "prev-tab";
    if (key === "]") return "next-tab";
  }

  // Go to Symbol: Cmd+Alt+O (mac) / Ctrl+Alt+Shift+N or Ctrl+Alt+O (win/linux)
  if (isMac) {
    if (meta && alt && !ctrl && !shift && key === "o") {
      return "go-to-symbol";
    }
  } else {
    if (ctrl && alt && !meta && !shift && key === "o") {
      return "go-to-symbol";
    }
    if (ctrl && alt && shift && !meta && key === "n") {
      return "go-to-symbol";
    }
  }

  // Annotate: Cmd/Ctrl+/ or Cmd/Ctrl+Alt+M
  if (mod && alt && !shift && key === "m") {
    return "annotate";
  }
  if (mod && !alt && !shift && key === "/") {
    return "annotate";
  }

  // Remaining primary modifier (mod) shortcuts
  if (!mod || alt) {
    return null;
  }

  if (shift) {
    switch (key) {
      case "o":
        return "go-to-file";
      case "e":
        return "export-prompt-preview";
      case "f":
        return "find-in-path";
      case "v":
      case "p":
        return "cycle-markdown-mode";
      case "c":
        return "copy-feedback-prompt";
      case "w":
        return "switch-worktree";
      case "n":
        return "open-project-window";
      default:
        return null;
    }
  }

  switch (key) {
    case "o":
      return "go-to-file";
    case "e":
      return "recent-files";
    case "f":
      return "find-in-file";
    case "l":
    case "g":
      return "go-to-line";
    case "b":
      return "go-to-declaration";
    case "k":
      return "tool-git";
    case "d":
      return "toggle-diff";
    case "w":
      return "close-tab";
    case "\\":
      return "split-right";
    default:
      return null;
  }
}

/**
 * Combined dispatcher handling both `Shift+Shift` double-tap and single-chord JetBrains shortcuts.
 */
export class KeymapDispatcher {
  private readonly doubleShift: DoubleShiftDetector;

  constructor(thresholdMs: number = DOUBLE_SHIFT_THRESHOLD_MS) {
    this.doubleShift = new DoubleShiftDetector(thresholdMs);
  }

  dispatch(event: KeyEventLike, platform: Platform, now: number = Date.now()): IdeAction | null {
    if (this.doubleShift.onKeyDown(event, now)) {
      return "search-everywhere";
    }
    return matchShortcut(event, platform);
  }

  reset(): void {
    this.doubleShift.reset();
  }
}

/**
 * Returns crisp, platform-native shortcut labels for menus, tool window headers, and tooltips.
 */
export function formatShortcut(action: IdeAction, platform: Platform): string {
  const isMac = platform === "darwin";

  switch (action) {
    case "search-everywhere":
      return isMac ? "⇧⇧" : "Shift+Shift";
    case "go-to-file":
      return isMac ? "⇧⌘O" : "Ctrl+Shift+O";
    case "go-to-symbol":
      return isMac ? "⌥⌘O" : "Ctrl+Alt+O";
    case "recent-files":
      return isMac ? "⌘E" : "Ctrl+E";
    case "export-prompt-preview":
      return isMac ? "⇧⌘E" : "Ctrl+Shift+E";
    case "find-in-path":
      return isMac ? "⇧⌘F" : "Ctrl+Shift+F";
    case "find-in-file":
      return isMac ? "⌘F" : "Ctrl+F";
    case "go-to-line":
      return isMac ? "⌘L" : "Ctrl+L";
    case "go-to-declaration":
      return isMac ? "⌘B" : "Ctrl+B";
    case "find-usages":
      return isMac ? "⌥F7" : "Alt+F7";
    case "nav-back":
      return isMac ? "⌘[" : "Ctrl+Alt+Left";
    case "nav-forward":
      return isMac ? "⌘]" : "Ctrl+Alt+Right";
    case "tool-project":
      return isMac ? "⌘1" : "Alt+1";
    case "tool-annotations":
      return isMac ? "⌘6" : "Alt+6";
    case "tool-structure":
      return isMac ? "⌘7" : "Alt+7";
    case "tool-git":
      return isMac ? "⌘9" : "Alt+9";
    case "toggle-diff":
      return isMac ? "⌘D" : "Ctrl+D";
    case "cycle-markdown-mode":
      return isMac ? "⇧⌘V" : "Ctrl+Shift+V";
    case "next-change":
      return "F7";
    case "prev-change":
      return isMac ? "⇧F7" : "Shift+F7";
    case "annotate":
      return isMac ? "⌘/" : "Ctrl+/";
    case "copy-feedback-prompt":
      return isMac ? "⇧⌘C" : "Ctrl+Shift+C";
    case "switch-worktree":
      return isMac ? "⇧⌘W" : "Ctrl+Shift+W";
    case "open-project-window":
      return isMac ? "⇧⌘N" : "Ctrl+Shift+N";
    case "close-tab":
      return isMac ? "⌘W" : "Ctrl+W";
    case "prev-tab":
      return isMac ? "⇧⌘[" : "Ctrl+Shift+Tab";
    case "next-tab":
      return isMac ? "⇧⌘]" : "Ctrl+Tab";
    case "split-right":
      return isMac ? "⌘\\" : "Ctrl+\\";
    case "escape":
      return "Esc";
  }
}

export function isEditableElement(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as { tagName?: string; isContentEditable?: boolean };
  if (el.isContentEditable) return true;
  const tag = el.tagName?.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
