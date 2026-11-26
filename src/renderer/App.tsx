import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Annotation,
  AnnotationStatus,
  ChangedFileSummary,
  CodeSymbol,
  CommitEntry,
  DiffScope,
  ExportPromptOptions,
  FileDiffResult,
  FileDocument,
  FileEntry,
  FindInPathQuery,
  LaunchContext,
  LineBlame,
  RecentProject,
  ReviewSessionState,
  SearchMatch,
  WalkthroughState,
  WalkthroughStep,
  WorktreeInfo,
} from "../shared/protocol.js";
import {
  Expect2Wordmark,
  IconAnnotations,
  IconDiff,
  IconExport,
  IconGitBranch,
  IconNewWindow,
  IconProject,
  IconSearch,
  IconSplit,
  IconStructure,
  IconWalkthrough,
} from "./components/BrandMark.js";
import {
  formatShortcut,
  isEditableElement,
  KeymapDispatcher,
  type IdeAction,
  type Platform,
} from "./shell/keymap.js";
import {
  ExportPromptModal,
  FindInPathPopup,
  GoToLinePopup,
  RecentFilesPopup,
  SearchEverywherePopup,
  type SearchEverywhereTab,
} from "./shell/Popups.js";
import { Statusline } from "./shell/Statusline.js";
import {
  closeAllTabs,
  closeOtherTabs,
  closeTab,
  closeTabsToLeft,
  closeTabsToRight,
  closeUnmodifiedTabs,
  togglePinTab,
  type EditorTab,
  type SplitDirection,
} from "./shell/tab-actions.js";
import { TabContextMenu } from "./shell/TabContextMenu.js";
import {
  AnnotationsToolWindow,
  GitToolWindow,
  ProjectToolWindow,
  StructureToolWindow,
  UsagesToolWindow,
} from "./shell/ToolWindows.js";
import { WorktreeStrip } from "./shell/WorktreeStrip.js";
import { CodeViewport } from "./views/CodeViewport.js";
import { DiffViewport, type DiffViewMode } from "./views/DiffViewport.js";
import { MarkdownViewer, type MarkdownViewMode } from "./views/MarkdownViewer.js";
import { ReviewSessionBar } from "./views/ReviewSessionBar.js";
import { WalkthroughBar } from "./views/WalkthroughBar.js";
import { WalkthroughCard } from "./views/WalkthroughCard.js";

interface WorktreeSessionState {
  tabs: EditorTab[];
  activeTabId: string | null;
  splitTabId: string | null;
  splitDirection?: SplitDirection;
  diffScope: DiffScope;
}

interface NavHistoryEntry {
  worktreePath: string;
  filePath: string;
  line: number;
  column: number;
}

interface RecentFileItem {
  worktreePath: string;
  worktreeName: string;
  filePath: string;
  openedAt: number;
}

type LeftToolId = "project" | "structure" | null;
type BottomToolId = "git" | "usages" | null;

function isMarkdownFile(filePath: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(filePath);
}

function resolvePosixRelative(fromFile: string, rawHref: string): { path: string; anchor?: string } {
  const [hrefPart = "", hashPart] = rawHref.split("#");
  if (!hrefPart) {
    return { path: fromFile, anchor: hashPart };
  }
  const baseParts = fromFile.split("/").slice(0, -1);
  const relParts = hrefPart.replace(/^\.\//, "").split("/");
  const stack = hrefPart.startsWith("/") ? [] : [...baseParts];
  for (const seg of relParts) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      stack.pop();
    } else {
      stack.push(seg);
    }
  }
  return { path: stack.join("/"), anchor: hashPart };
}

export const App: React.FC = () => {
  const [bootError, setBootError] = useState<string | null>(null);
  const [context, setContext] = useState<LaunchContext | null>(null);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [activeWorktreePath, setActiveWorktreePath] = useState<string>("");
  const [annotations, setAnnotations] = useState<Annotation[]>([]);

  // Per-worktree session state (instant <2ms swap across worktrees!)
  const [sessions, setSessions] = useState<Record<string, WorktreeSessionState>>({});

  // Cached per-worktree data
  const [filesByWt, setFilesByWt] = useState<Record<string, FileEntry[]>>({});
  const [changedByWt, setChangedByWt] = useState<Record<string, ChangedFileSummary[]>>({});
  const [commitsByWt, setCommitsByWt] = useState<Record<string, CommitEntry[]>>({});
  const [docsCache, setDocsCache] = useState<Record<string, FileDocument>>({});
  const [symbolsCache, setSymbolsCache] = useState<Record<string, CodeSymbol[]>>({});
  const [diffsCache, setDiffsCache] = useState<Record<string, FileDiffResult>>({});
  const [blameCache, setBlameCache] = useState<Record<string, LineBlame[]>>({});
  const [filePulseAt, setFilePulseAt] = useState<Record<string, number>>({});

  // UI Dock & View State
  const [leftTool, setLeftTool] = useState<LeftToolId>("project");
  const [rightAnnotationsOpen, setRightAnnotationsOpen] = useState<boolean>(false);
  const [bottomTool, setBottomTool] = useState<BottomToolId>(null);
  const [diffViewMode, setDiffViewMode] = useState<DiffViewMode>("split");
  const [blameEnabled, setBlameEnabled] = useState<boolean>(false);
  const [crtEnabled, setCrtEnabled] = useState<boolean>(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | undefined>(undefined);
  const [cursorPos, setCursorPos] = useState<{ line: number; column: number }>({
    line: 1,
    column: 1,
  });

  // Viewport imperative triggers
  const [scrollToReq, setScrollToReq] = useState<{
    line: number;
    column?: number;
    flash?: boolean;
    seq: number;
  } | null>(null);
  const [findTrigger, setFindTrigger] = useState<number>(0);
  const [annotateTrigger, setAnnotateTrigger] = useState<number>(0);
  const [hunkNavTrigger, setHunkNavTrigger] = useState<{
    direction: "next" | "prev";
    seq: number;
  } | null>(null);

  // Usages state
  const [usagesState, setUsagesState] = useState<{
    symbolName: string;
    definitions: SearchMatch[];
    usages: SearchMatch[];
  } | null>(null);

  // Modals / Popups
  const [searchPopup, setSearchPopup] = useState<{
    open: boolean;
    tab: SearchEverywhereTab;
  }>({ open: false, tab: "all" });
  const [recentPopupOpen, setRecentPopupOpen] = useState<boolean>(false);
  const [findInPathOpen, setFindInPathOpen] = useState<boolean>(false);
  const [goToLineOpen, setGoToLineOpen] = useState<boolean>(false);
  const [exportModalOpen, setExportModalOpen] = useState<boolean>(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState<boolean>(false);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [tabContextMenu, setTabContextMenu] = useState<{
    tabId: string;
    x: number;
    y: number;
  } | null>(null);
  const [projectLocateReq, setProjectLocateReq] = useState<{
    filePath: string;
    seq: number;
  } | null>(null);
  const [walkthrough, setWalkthrough] = useState<WalkthroughState | null>(null);
  const [review, setReview] = useState<ReviewSessionState | null>(null);
  const [agentMenuOpen, setAgentMenuOpen] = useState<boolean>(false);
  const [viewedStepId, setViewedStepId] = useState<string>("");
  const [folderFocusReq, setFolderFocusReq] = useState<{
    dirPath: string;
    seq: string;
  } | null>(null);
  const lastNavigatedStepIdRef = useRef<string>("");

  // Navigation History & Recent Files
  const navStackRef = useRef<{ items: NavHistoryEntry[]; index: number }>({
    items: [],
    index: -1,
  });
  const [recentFiles, setRecentFiles] = useState<RecentFileItem[]>([]);
  const keyDispatcherRef = useRef(new KeymapDispatcher());

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => {
      setToast((cur) => (cur === msg ? null : cur));
    }, 2400);
  }, []);

  const platform: Platform = context?.platform ?? "darwin";

  const activeWorktree = useMemo(
    () => worktrees.find((w) => w.path === activeWorktreePath) ?? worktrees[0],
    [worktrees, activeWorktreePath],
  );

  const currentSession: WorktreeSessionState = useMemo(() => {
    if (!activeWorktreePath) {
      return { tabs: [], activeTabId: null, splitTabId: null, diffScope: { kind: "branch" } };
    }
    return (
      sessions[activeWorktreePath] ?? {
        tabs: [],
        activeTabId: null,
        splitTabId: null,
        diffScope: {
          kind: "branch",
          baseRef: context?.initialBaseRef ?? activeWorktree?.baseRef,
        },
      }
    );
  }, [sessions, activeWorktreePath, context?.initialBaseRef, activeWorktree?.baseRef]);

  const activeTab = useMemo(
    () => currentSession.tabs.find((t) => t.id === currentSession.activeTabId) ?? null,
    [currentSession],
  );

  const splitTab = useMemo(
    () =>
      currentSession.splitTabId
        ? currentSession.tabs.find((t) => t.id === currentSession.splitTabId) ?? null
        : null,
    [currentSession],
  );

  const loadWorktreeResources = useCallback(
    async (wtPath: string, scope: DiffScope) => {
      const [files, changed, commits] = await Promise.all([
        window.ide2.listFiles(wtPath),
        window.ide2.listChangedFiles(wtPath, scope),
        window.ide2.listCommits(wtPath, 60),
      ]);
      setFilesByWt((prev) => ({ ...prev, [wtPath]: files }));
      setChangedByWt((prev) => ({ ...prev, [wtPath]: changed }));
      setCommitsByWt((prev) => ({ ...prev, [wtPath]: commits }));
      return { files, changed, commits };
    },
    [],
  );

  const loadFileDocument = useCallback(
    async (wtPath: string, filePath: string, diffScope?: DiffScope) => {
      const key = `${wtPath}::${filePath}`;
      const doc = await window.ide2.readFile(
        wtPath,
        filePath,
        diffScope ?? { kind: "branch" },
      );
      setDocsCache((prev) => ({ ...prev, [key]: doc }));
      return doc;
    },
    [],
  );

  const loadDiffDocument = useCallback(
    async (wtPath: string, filePath: string, scope: DiffScope) => {
      const scopeKey = JSON.stringify(scope);
      const key = `${wtPath}::${filePath}::${scopeKey}`;
      const diff = await window.ide2.getDiff(wtPath, filePath, scope);
      setDiffsCache((prev) => ({ ...prev, [key]: diff }));
      return diff;
    },
    [],
  );

  const openFileInWorktree = useCallback(
    async (
      wtPath: string,
      filePath: string,
      options?: {
        line?: number;
        column?: number;
        viewKind?: "code" | "diff";
        diffScope?: DiffScope;
        markdownMode?: MarkdownViewMode;
        recordHistory?: boolean;
      },
    ) => {
      const viewKind = options?.viewKind ?? "code";
      const tabId = viewKind === "diff" ? `diff:${filePath}` : `code:${filePath}`;

      try {
        if (viewKind === "diff") {
          await loadDiffDocument(
            wtPath,
            filePath,
            options?.diffScope ?? { kind: "branch" },
          );
        } else {
          await loadFileDocument(wtPath, filePath, options?.diffScope);
        }
      } catch (err) {
        showToast(
          `Could not open ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }

      if (wtPath !== activeWorktreePath) {
        setActiveWorktreePath(wtPath);
      }

      setSessions((prev) => {
        const existingSession = prev[wtPath] ?? {
          tabs: [],
          activeTabId: null,
          splitTabId: null,
          diffScope: options?.diffScope ?? { kind: "branch" },
        };
        const exists = existingSession.tabs.some((t) => t.id === tabId);
        const nextTabs: EditorTab[] = exists
          ? existingSession.tabs.map((t) =>
              t.id === tabId
                ? {
                    ...t,
                    ...(options?.diffScope ? { diffScope: options.diffScope } : {}),
                    ...(options?.markdownMode ? { markdownMode: options.markdownMode } : {}),
                  }
                : t,
            )
          : [
              ...existingSession.tabs,
              {
                id: tabId,
                filePath,
                viewKind,
                diffScope: options?.diffScope ?? existingSession.diffScope,
                markdownMode:
                  options?.markdownMode ??
                  (isMarkdownFile(filePath) ? "preview" : undefined),
              },
            ];
        return {
          ...prev,
          [wtPath]: {
            ...existingSession,
            tabs: nextTabs,
            activeTabId: tabId,
          },
        };
      });

      const wtObj = worktrees.find((w) => w.path === wtPath);
      setRecentFiles((prev) => {
        const filtered = prev.filter(
          (r) => !(r.worktreePath === wtPath && r.filePath === filePath),
        );
        return [
          {
            worktreePath: wtPath,
            worktreeName: wtObj?.name ?? "worktree",
            filePath,
            openedAt: Date.now(),
          },
          ...filtered,
        ].slice(0, 30);
      });

      if (options?.recordHistory !== false) {
        const stack = navStackRef.current;
        const entry: NavHistoryEntry = {
          worktreePath: wtPath,
          filePath,
          line: options?.line ?? 1,
          column: options?.column ?? 1,
        };
        const trimmed = stack.items.slice(0, stack.index + 1);
        trimmed.push(entry);
        stack.items = trimmed.slice(-80);
        stack.index = stack.items.length - 1;
      }

      if (options?.line) {
        setCursorPos({ line: options.line, column: options.column ?? 1 });
        setScrollToReq({
          line: options.line,
          column: options.column,
          flash: true,
          seq: Date.now(),
        });
      }
    },
    [activeWorktreePath, loadDiffDocument, loadFileDocument, showToast, worktrees],
  );

  const applyWalkthroughStepNavigation = useCallback(
    (step: WalkthroughStep) => {
      setViewedStepId(step.id);
      if (step.worktreePath && step.worktreePath !== activeWtRef.current) {
        setActiveWorktreePath(step.worktreePath);
      }
      if (step.targetKind === "folder" && step.targetPath) {
        setLeftTool("project");
        setFolderFocusReq({ dirPath: step.targetPath, seq: `${step.id}-${Date.now()}` });
      } else if (
        (step.targetKind === "file" || step.targetKind === "range") &&
        step.targetPath
      ) {
        void openFileInWorktree(step.worktreePath, step.targetPath, {
          viewKind: "code",
          markdownMode: step.markdownMode,
          line: step.targetKind === "file" ? 1 : undefined,
        });
      } else if (step.targetKind === "diff" && step.targetPath) {
        void openFileInWorktree(step.worktreePath, step.targetPath, {
          viewKind: "diff",
          diffScope: step.diffScope ?? { kind: "branch" },
        });
      }
    },
    [openFileInWorktree],
  );

  // Bootstrap IDE on mount
  useEffect(() => {
    let mounted = true;
    window.ide2
      .getBootstrap()
      .then(async ({ context: ctx, worktrees: wts, annotations: anns, walkthrough: initialWtTour, review: initialReview }) => {
        if (!mounted) return;
        setContext(ctx);
        setWorktrees(wts);
        setAnnotations(anns);
        if (initialWtTour) {
          setWalkthrough(initialWtTour);
          setViewedStepId(initialWtTour.activeStepId);
        }
        if (initialReview) {
          setReview(initialReview);
        }

        const initialWt =
          wts.find((w) => w.path === ctx.initialWorktreePath)?.path ?? wts[0]?.path ?? "";
        setActiveWorktreePath(initialWt);

        if (initialWt) {
          const defaultScope: DiffScope = {
            kind: "branch",
            baseRef: ctx.initialBaseRef,
          };
          const { files, changed } = await loadWorktreeResources(initialWt, defaultScope);

          if (ctx.initialDiffMode) {
            setBottomTool("git");
          }

          if (ctx.initialFilePath) {
            await openFileInWorktree(initialWt, ctx.initialFilePath, {
              line: ctx.initialLine,
              column: ctx.initialColumn,
              viewKind: ctx.initialDiffMode ? "diff" : "code",
              diffScope: defaultScope,
            });
          } else if (ctx.initialDiffMode && changed[0]) {
            await openFileInWorktree(initialWt, changed[0].path, {
              viewKind: "diff",
              diffScope: defaultScope,
            });
          } else {
            const readme = files.find((f) => /^readme\.md$/i.test(f.path));
            const firstTarget = readme?.path ?? changed[0]?.path ?? files[0]?.path;
            if (firstTarget) {
              await openFileInWorktree(initialWt, firstTarget, {
                diffScope: defaultScope,
              });
            }
          }

          if (initialWtTour && initialWtTour.steps.length > 0) {
            const activeTourStep =
              initialWtTour.steps.find((s) => s.id === initialWtTour.activeStepId) ??
              initialWtTour.steps[initialWtTour.steps.length - 1];
            if (activeTourStep) {
              lastNavigatedStepIdRef.current = activeTourStep.id;
              applyWalkthroughStepNavigation(activeTourStep);
            }
          }
        }
      })
      .catch((err) => {
        if (mounted) {
          setBootError(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  // Load worktree files/diffs lazily if user switches to a worktree not yet loaded
  useEffect(() => {
    if (!activeWorktreePath) return;
    if (!filesByWt[activeWorktreePath]) {
      void loadWorktreeResources(activeWorktreePath, currentSession.diffScope).then(
        ({ files, changed }) => {
          setSessions((prev) => {
            const existing = prev[activeWorktreePath];
            if (existing && existing.tabs.length > 0) return prev;
            const readme = files.find((f) => /^readme\.md$/i.test(f.path));
            const pick = readme?.path ?? changed[0]?.path ?? files[0]?.path;
            if (!pick) return prev;
            void loadFileDocument(activeWorktreePath, pick, currentSession.diffScope);
            return {
              ...prev,
              [activeWorktreePath]: {
                tabs: [
                  {
                    id: `code:${pick}`,
                    filePath: pick,
                    viewKind: "code",
                    diffScope: currentSession.diffScope,
                    markdownMode: isMarkdownFile(pick) ? "preview" : undefined,
                  },
                ],
                activeTabId: `code:${pick}`,
                splitTabId: null,
                diffScope: currentSession.diffScope,
              },
            };
          });
        },
      );
    }
  }, [activeWorktreePath]);

  // Load blame when blame is toggled on for active tab
  useEffect(() => {
    if (!blameEnabled || !activeWorktreePath || !activeTab || activeTab.viewKind !== "code") {
      return;
    }
    const key = `${activeWorktreePath}::${activeTab.filePath}`;
    if (!blameCache[key]) {
      void window.ide2
        .getBlame(activeWorktreePath, activeTab.filePath)
        .then((blame) => setBlameCache((prev) => ({ ...prev, [key]: blame })))
        .catch(() => {});
    }
  }, [blameEnabled, activeWorktreePath, activeTab]);

  // Subscribe to live backend events (agent edits, tokens streaming, CLI warm wakeup, native shortcuts)
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const activeWtRef = useRef(activeWorktreePath);
  activeWtRef.current = activeWorktreePath;

  useEffect(() => {
    return window.ide2.onEvent((event) => {
      if (event.type === "tokens-ready") {
        const key = `${event.worktreePath}::${event.filePath}`;
        setDocsCache((prev) => {
          const cur = prev[key];
          if (!cur || cur.contentHash !== event.contentHash) return prev;
          return { ...prev, [key]: { ...cur, tokens: event.tokens } };
        });
        setSymbolsCache((prev) => ({ ...prev, [key]: event.symbols }));
      } else if (event.type === "annotations-updated") {
        setAnnotations(event.annotations);
      } else if (event.type === "worktrees-updated") {
        setWorktrees(event.worktrees);
        setLastUpdatedAt(Date.now());
        const touchedWt = event.changedWorktreePath;
        if (touchedWt) {
          const wtSession = sessionsRef.current[touchedWt];
          const scope = wtSession?.diffScope ?? { kind: "branch" };
          void loadWorktreeResources(touchedWt, scope);

          // Live reload any open tabs in that worktree smoothly!
          if (wtSession) {
            for (const tab of wtSession.tabs) {
              if (
                !event.changedFiles ||
                event.changedFiles.length === 0 ||
                event.changedFiles.includes(tab.filePath)
              ) {
                const key = `${touchedWt}::${tab.filePath}`;
                setFilePulseAt((prev) => ({ ...prev, [key]: Date.now() }));
                if (tab.viewKind === "diff") {
                  void loadDiffDocument(touchedWt, tab.filePath, tab.diffScope ?? scope);
                } else {
                  void loadFileDocument(touchedWt, tab.filePath, scope);
                }
              }
            }
          }
        }
      } else if (event.type === "cli-open-target") {
        setActiveWorktreePath(event.worktreePath);
        if (event.filePath) {
          void openFileInWorktree(event.worktreePath, event.filePath, {
            line: event.line,
            column: event.column,
            viewKind: event.diffMode ? "diff" : "code",
          });
        } else if (event.diffMode) {
          setBottomTool("git");
        }
      } else if (event.type === "native-shortcut") {
        runActionRef.current(event.action as IdeAction);
      } else if (event.type === "review-updated") {
        setReview(event.review);
      } else if (event.type === "walkthrough-updated") {
        setWalkthrough(event.walkthrough);
        if (!event.walkthrough) {
          setViewedStepId("");
          lastNavigatedStepIdRef.current = "";
        } else if (
          event.walkthrough.activeStepId &&
          event.walkthrough.activeStepId !== lastNavigatedStepIdRef.current
        ) {
          const nextStep = event.walkthrough.steps.find(
            (s) => s.id === event.walkthrough!.activeStepId,
          );
          if (nextStep) {
            lastNavigatedStepIdRef.current = nextStep.id;
            applyWalkthroughStepNavigation(nextStep);
          }
        }
      }
    });
  }, [applyWalkthroughStepNavigation, loadDiffDocument, loadFileDocument, loadWorktreeResources, openFileInWorktree]);

  const handleCopyPromptQuick = useCallback(
    async (opts?: Partial<ExportPromptOptions>) => {
      if (!activeWorktreePath) return;
      const res = await window.ide2.compileFeedbackPrompt({
        worktreePath: activeWorktreePath,
        includeOutdated: opts?.includeOutdated,
        resolveAfterExport: opts?.resolveAfterExport,
      });
      if (!res.markdown) {
        showToast("No open annotations in current worktree to export");
        return;
      }
      await window.ide2.copyToClipboard(res.markdown);
      showToast(`Copied Feedback Prompt (${res.count} annotation${res.count === 1 ? "" : "s"})`);
    },
    [activeWorktreePath, showToast],
  );

  const handleOpenProjectWindow = useCallback(
    async (targetPath?: string) => {
      setProjectMenuOpen(false);
      try {
        const res = await window.ide2.openProjectWindow(targetPath);
        if (res.canceled) return;
        if (!res.opened) {
          showToast(res.error ?? "Could not open project");
          return;
        }
        if (res.reused) {
          showToast(`Focused existing window for ${res.repoName ?? "project"}`);
        } else {
          showToast(`Opened ${res.repoName ?? "project"} in new window`);
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err));
      }
    },
    [showToast],
  );

  useEffect(() => {
    if (!projectMenuOpen) return;
    void window.ide2
      .listRecentProjects()
      .then((list) => setRecentProjects(list))
      .catch(() => {});
    const onGlobalClick = () => setProjectMenuOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setProjectMenuOpen(false);
    };
    window.addEventListener("click", onGlobalClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", onGlobalClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [projectMenuOpen]);

  const handleCopyWalkthroughPrompt = useCallback(async () => {
    setAgentMenuOpen(false);
    try {
      const prompt = await window.ide2.getWalkthroughAgentPrompt();
      await window.ide2.copyToClipboard(prompt);
      showToast("Copied Walkthrough Prompt — paste into your coding agent!");
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    }
  }, [showToast]);

  const handleCopyReviewPrompt = useCallback(async () => {
    setAgentMenuOpen(false);
    try {
      const prompt = await window.ide2.getReviewAgentPrompt();
      await window.ide2.copyToClipboard(prompt);
      showToast("Copied Live Review Prompt — paste into your agent for zero-copy-paste reviews!");
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    }
  }, [showToast]);

  const handleSendReviewFeedback = useCallback(
    async (opts?: { includeOutdated?: boolean; resolveAfterSend?: boolean }) => {
      if (!activeWorktreePath) return;
      const res = await window.ide2.sendReviewResponse({
        action: "feedback",
        worktreePath: activeWorktreePath,
        includeOutdated: opts?.includeOutdated,
        resolveAfterSend: opts?.resolveAfterSend ?? review?.resolveOnSend ?? true,
      });
      if (!res.sent || res.count === 0) {
        showToast("No open annotations in current worktree to send");
        return;
      }
      showToast(
        `Sent ${res.count} annotation${res.count === 1 ? "" : "s"} directly to coding agent`,
      );
    },
    [activeWorktreePath, review?.resolveOnSend, showToast],
  );

  const handleApproveReview = useCallback(async () => {
    if (!activeWorktreePath) return;
    await window.ide2.sendReviewResponse({
      action: "approve",
      worktreePath: activeWorktreePath,
    });
    showToast("Approved — notified coding agent");
  }, [activeWorktreePath, showToast]);

  const handleCancelReview = useCallback(async () => {
    if (!activeWorktreePath) return;
    await window.ide2.sendReviewResponse({
      action: "cancel",
      worktreePath: activeWorktreePath,
    });
  }, [activeWorktreePath]);

  useEffect(() => {
    if (!agentMenuOpen) return;
    const onGlobalClick = () => setAgentMenuOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAgentMenuOpen(false);
    };
    window.addEventListener("click", onGlobalClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", onGlobalClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [agentMenuOpen]);

  const updateActiveSessionTabs = useCallback(
    (updater: (session: WorktreeSessionState) => WorktreeSessionState) => {
      if (!activeWorktreePath) return;
      setSessions((prev) => {
        const s = prev[activeWorktreePath];
        if (!s) return prev;
        return {
          ...prev,
          [activeWorktreePath]: updater(s),
        };
      });
    },
    [activeWorktreePath],
  );

  const handleCloseTab = useCallback(
    (tabId: string) => {
      updateActiveSessionTabs((s) => ({ ...s, ...closeTab(s, tabId) }));
    },
    [updateActiveSessionTabs],
  );

  const modifiedFilePathSet = useMemo(() => {
    const set = new Set<string>();
    for (const c of changedByWt[activeWorktreePath] ?? []) {
      set.add(c.path);
    }
    for (const f of filesByWt[activeWorktreePath] ?? []) {
      if (f.gitStatus && f.gitStatus !== "clean") {
        set.add(f.path);
      }
    }
    return set;
  }, [changedByWt, filesByWt, activeWorktreePath]);

  const handleSymbolActivate = useCallback(
    async (params: { symbolName: string; line: number; mode: "definition" | "usages" }) => {
      if (!activeWorktreePath || !activeTab) return;
      const res = await window.ide2.findDefinitionAndUsages({
        worktreePath: activeWorktreePath,
        filePath: activeTab.filePath,
        symbolName: params.symbolName,
        line: params.line,
      });

      if (params.mode === "definition" && res.definitions.length === 1) {
        const def = res.definitions[0]!;
        if (def.filePath === activeTab.filePath && def.line === params.line && res.usages.length > 0) {
          setUsagesState({
            symbolName: params.symbolName,
            definitions: res.definitions,
            usages: res.usages,
          });
          setBottomTool("usages");
        } else {
          await openFileInWorktree(def.worktreePath, def.filePath, {
            line: def.line,
            column: def.column,
          });
        }
      } else {
        setUsagesState({
          symbolName: params.symbolName,
          definitions: res.definitions,
          usages: res.usages,
        });
        setBottomTool("usages");
      }
    },
    [activeTab, activeWorktreePath, openFileInWorktree],
  );

  const runAction = useCallback(
    (action: IdeAction) => {
      switch (action) {
        case "search-everywhere":
          setSearchPopup({ open: true, tab: "all" });
          break;
        case "go-to-file":
          setSearchPopup({ open: true, tab: "files" });
          break;
        case "go-to-symbol":
          setSearchPopup({ open: true, tab: "symbols" });
          break;
        case "switch-worktree":
          setSearchPopup({ open: true, tab: "worktrees" });
          break;
        case "open-project-window":
          void handleOpenProjectWindow();
          break;
        case "copy-walkthrough-prompt":
          void handleCopyWalkthroughPrompt();
          break;
        case "recent-files":
          setRecentPopupOpen((v) => !v);
          break;
        case "export-prompt-preview":
          setExportModalOpen(true);
          break;
        case "find-in-path":
          setFindInPathOpen(true);
          break;
        case "find-in-file":
          setFindTrigger((n) => n + 1);
          break;
        case "go-to-line":
          setGoToLineOpen(true);
          break;
        case "go-to-declaration":
        case "find-usages": {
          if (!activeWorktreePath || !activeTab) break;
          const doc = docsCache[`${activeWorktreePath}::${activeTab.filePath}`];
          const lineText = doc?.lines[(cursorPos.line ?? 1) - 1] ?? "";
          const colIdx = Math.max(0, Math.min(lineText.length - 1, (cursorPos.column ?? 1) - 1));
          const isIdent = (ch: string) => /[A-Za-z0-9_$]/.test(ch);
          let symbolName: string | undefined;
          if (lineText[colIdx] && isIdent(lineText[colIdx]!)) {
            let start = colIdx;
            let end = colIdx + 1;
            while (start > 0 && isIdent(lineText[start - 1]!)) start -= 1;
            while (end < lineText.length && isIdent(lineText[end]!)) end += 1;
            symbolName = lineText.slice(start, end);
          } else {
            const keywords = new Set([
              "export", "import", "default", "const", "let", "var", "function",
              "async", "await", "return", "class", "interface", "type", "enum",
              "public", "private", "protected", "readonly", "def", "fn", "pub", "func",
            ]);
            const matches = Array.from(lineText.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g));
            symbolName = matches.find((m) => !keywords.has(m[0]))?.[0] ?? matches[0]?.[0];
          }
          if (symbolName) {
            void handleSymbolActivate({
              symbolName,
              line: cursorPos.line,
              mode: action === "go-to-declaration" ? "definition" : "usages",
            });
          }
          break;
        }
        case "nav-back": {
          const stack = navStackRef.current;
          if (stack.index > 0) {
            stack.index -= 1;
            const entry = stack.items[stack.index]!;
            void openFileInWorktree(entry.worktreePath, entry.filePath, {
              line: entry.line,
              column: entry.column,
              recordHistory: false,
            });
          }
          break;
        }
        case "nav-forward": {
          const stack = navStackRef.current;
          if (stack.index < stack.items.length - 1) {
            stack.index += 1;
            const entry = stack.items[stack.index]!;
            void openFileInWorktree(entry.worktreePath, entry.filePath, {
              line: entry.line,
              column: entry.column,
              recordHistory: false,
            });
          }
          break;
        }
        case "tool-project":
          setLeftTool((cur) => (cur === "project" ? null : "project"));
          break;
        case "tool-structure":
          setLeftTool((cur) => (cur === "structure" ? null : "structure"));
          break;
        case "tool-git":
          setBottomTool((cur) => (cur === "git" ? null : "git"));
          break;
        case "tool-annotations":
          setRightAnnotationsOpen((v) => !v);
          break;
        case "toggle-diff":
          if (activeWorktreePath && activeTab) {
            if (activeTab.viewKind === "diff") {
              void openFileInWorktree(activeWorktreePath, activeTab.filePath, {
                viewKind: "code",
              });
            } else {
              void openFileInWorktree(activeWorktreePath, activeTab.filePath, {
                viewKind: "diff",
                diffScope: currentSession.diffScope,
              });
            }
          }
          break;
        case "cycle-markdown-mode":
          if (activeWorktreePath && activeTab && isMarkdownFile(activeTab.filePath)) {
            const order: MarkdownViewMode[] = ["preview", "split", "raw"];
            const cur = activeTab.markdownMode ?? "preview";
            const next = order[(order.indexOf(cur) + 1) % order.length]!;
            setSessions((prev) => {
              const s = prev[activeWorktreePath];
              if (!s) return prev;
              return {
                ...prev,
                [activeWorktreePath]: {
                  ...s,
                  tabs: s.tabs.map((t) =>
                    t.id === activeTab.id ? { ...t, markdownMode: next } : t,
                  ),
                },
              };
            });
          }
          break;
        case "next-change":
          setHunkNavTrigger({ direction: "next", seq: Date.now() });
          break;
        case "prev-change":
          setHunkNavTrigger({ direction: "prev", seq: Date.now() });
          break;
        case "annotate":
          setAnnotateTrigger((n) => n + 1);
          break;
        case "copy-feedback-prompt":
          void handleCopyPromptQuick();
          break;
        case "close-tab":
          if (activeTab) handleCloseTab(activeTab.id);
          break;
        case "prev-tab":
        case "next-tab":
          if (activeWorktreePath && currentSession.tabs.length > 1 && activeTab) {
            const idx = currentSession.tabs.findIndex((t) => t.id === activeTab.id);
            const delta = action === "next-tab" ? 1 : -1;
            const nextIdx =
              (idx + delta + currentSession.tabs.length) % currentSession.tabs.length;
            const nextTab = currentSession.tabs[nextIdx]!;
            setSessions((prev) => ({
              ...prev,
              [activeWorktreePath]: {
                ...currentSession,
                activeTabId: nextTab.id,
              },
            }));
          }
          break;
        case "split-right":
          if (activeWorktreePath && activeTab) {
            setSessions((prev) => {
              const s = prev[activeWorktreePath];
              if (!s) return prev;
              return {
                ...prev,
                [activeWorktreePath]: {
                  ...s,
                  splitTabId: s.splitTabId ? null : activeTab.id,
                },
              };
            });
          }
          break;
        case "escape":
          setSearchPopup((p) => ({ ...p, open: false }));
          setRecentPopupOpen(false);
          setFindInPathOpen(false);
          setGoToLineOpen(false);
          setExportModalOpen(false);
          setProjectMenuOpen(false);
          break;
      }
    },
    [
      activeTab,
      activeWorktreePath,
      currentSession,
      cursorPos.line,
      docsCache,
      handleCloseTab,
      handleCopyPromptQuick,
      handleCopyWalkthroughPrompt,
      handleOpenProjectWindow,
      handleSymbolActivate,
      openFileInWorktree,
    ],
  );

  const runActionRef = useRef(runAction);
  runActionRef.current = runAction;

  // Global JetBrains keyboard listener
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const anyModalOpen =
        searchPopup.open ||
        recentPopupOpen ||
        findInPathOpen ||
        goToLineOpen ||
        exportModalOpen;

      const action = keyDispatcherRef.current.dispatch(e, platform);
      if (!action) return;

      if (anyModalOpen) {
        if (action === "escape") {
          e.preventDefault();
          runAction("escape");
        }
        return;
      }

      if (isEditableElement(e.target) && action !== "escape" && action !== "copy-feedback-prompt") {
        return;
      }

      e.preventDefault();
      runAction(action);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    platform,
    runAction,
    searchPopup.open,
    recentPopupOpen,
    findInPathOpen,
    goToLineOpen,
    exportModalOpen,
  ]);

  const activeDocKey =
    activeWorktreePath && activeTab ? `${activeWorktreePath}::${activeTab.filePath}` : "";
  const activeDoc = activeDocKey ? docsCache[activeDocKey] : undefined;
  const activeSymbols = activeDocKey ? symbolsCache[activeDocKey] ?? [] : [];
  const activeBlame = activeDocKey ? blameCache[activeDocKey] : undefined;

  const worktreeAnnotations = useMemo(
    () => annotations.filter((a) => a.worktreePath === activeWorktreePath),
    [annotations, activeWorktreePath],
  );
  const openWtAnnotationCount = useMemo(
    () => worktreeAnnotations.filter((a) => a.status === "open").length,
    [worktreeAnnotations],
  );

  const handleSearchFilesMemo = useCallback(
    (params: { worktreePath: string; query: string; allWorktrees: boolean }) =>
      window.ide2.fuzzyFindFiles({ ...params, limit: 60 }),
    [],
  );

  const handleSearchSymbolsMemo = useCallback(
    (params: { worktreePath: string; query: string; allWorktrees: boolean }) =>
      window.ide2.searchSymbols({ ...params, limit: 60 }),
    [],
  );

  const handleFindInPathMemo = useCallback(
    (q: FindInPathQuery) => window.ide2.findInPath(q),
    [],
  );

  const handleLoadPreviewMemo = useCallback(
    (wtPath: string, fp: string) => window.ide2.readFile(wtPath, fp),
    [],
  );

  const viewedWalkthroughStep = useMemo(() => {
    if (!walkthrough || walkthrough.steps.length === 0) return null;
    return (
      walkthrough.steps.find((s) => s.id === viewedStepId) ??
      walkthrough.steps.find((s) => s.id === walkthrough.activeStepId) ??
      walkthrough.steps[walkthrough.steps.length - 1] ??
      null
    );
  }, [walkthrough, viewedStepId]);

  const renderWalkthroughCard = (
    step: WalkthroughStep,
    variant: "banner" | "inline",
  ): React.ReactNode => {
    if (!walkthrough) return null;
    const idx = walkthrough.steps.findIndex((s) => s.id === step.id);
    const latest = walkthrough.steps[walkthrough.steps.length - 1];
    const isLatestStep = Boolean(latest && latest.id === step.id);

    return (
      <WalkthroughCard
        step={step}
        variant={variant}
        isLatestStep={isLatestStep}
        hasPrev={idx > 0}
        hasNextVisited={idx >= 0 && idx < walkthrough.steps.length - 1}
        awaitingUser={walkthrough.awaitingUser}
        agentThinking={walkthrough.agentThinking}
        onPrev={() => {
          const prevStep = walkthrough.steps[idx - 1];
          if (prevStep) applyWalkthroughStepNavigation(prevStep);
        }}
        onNextVisited={() => {
          const nextStep = walkthrough.steps[idx + 1];
          if (nextStep) applyWalkthroughStepNavigation(nextStep);
        }}
        onReturnToLatest={() => {
          if (latest) applyWalkthroughStepNavigation(latest);
        }}
        onAdvance={() =>
          window.ide2.respondWalkthrough({
            stepId: step.id,
            action: step.final ? "finish" : "next",
          })
        }
        onSteer={(message) =>
          window.ide2.respondWalkthrough({
            stepId: step.id,
            action: "steer",
            message,
          })
        }
        onStop={() => window.ide2.endWalkthrough()}
        onOpenRepoTarget={(rawTarget) => {
          const cleaned = rawTarget.replace(/^\/+/, "");
          const match = /^(.*?):(\d+)/.exec(cleaned);
          if (match?.[1]) {
            void openFileInWorktree(step.worktreePath, match[1], {
              line: Number.parseInt(match[2] ?? "1", 10),
            });
          } else {
            void openFileInWorktree(step.worktreePath, cleaned);
          }
        }}
      />
    );
  };

  const renderTabViewport = (tab: EditorTab, isSplitPane = false) => {
    const docKey = `${activeWorktreePath}::${tab.filePath}`;
    const doc = docsCache[docKey];
    const syms = symbolsCache[docKey] ?? [];
    const fileAnns = worktreeAnnotations.filter((a) => a.filePath === tab.filePath);
    const matchesInlineTour =
      !isSplitPane &&
      viewedWalkthroughStep !== null &&
      viewedWalkthroughStep.worktreePath === activeWorktreePath &&
      viewedWalkthroughStep.targetPath === tab.filePath &&
      ((viewedWalkthroughStep.targetKind === "range" && tab.viewKind === "code") ||
        (viewedWalkthroughStep.targetKind === "diff" && tab.viewKind === "diff"));

    const onCreateAnn = async (input: {
      comment: string;
      startLine?: number;
      endLine?: number;
      selectedText?: string;
      contextBefore?: string;
      contextAfter?: string;
      side?: "new" | "old";
    }) => {
      await window.ide2.createAnnotation({
        worktreePath: activeWorktreePath,
        filePath: tab.filePath,
        side: input.side ?? "new",
        startLine: input.startLine,
        endLine: input.endLine,
        comment: input.comment,
        selectedText: input.selectedText,
        contextBefore: input.contextBefore,
        contextAfter: input.contextAfter,
        contentHash: doc?.contentHash,
        language: doc?.language,
      });
      showToast(`Added annotation on ${tab.filePath}`);
    };

    const onEditAnn = async (
      ann: Annotation,
      updates: { comment: string },
    ) => {
      await window.ide2.updateAnnotation({
        id: ann.id,
        comment: updates.comment,
      });
    };

    const onSetStatus = async (ann: Annotation, status: AnnotationStatus) => {
      await window.ide2.updateAnnotation({ id: ann.id, status });
    };

    const onDeleteAnn = async (ann: Annotation) => {
      await window.ide2.deleteAnnotation(ann.id);
    };

    if (tab.viewKind === "diff") {
      const scope = tab.diffScope ?? currentSession.diffScope;
      const diffKey = `${activeWorktreePath}::${tab.filePath}::${JSON.stringify(scope)}`;
      const diffData = diffsCache[diffKey];
      if (!diffData) {
        return <div className="editor-empty">Loading diff for {tab.filePath}…</div>;
      }
      return (
        <DiffViewport
          diff={diffData}
          mode={diffViewMode}
          onModeChange={setDiffViewMode}
          onScopeChange={(nextScope) => {
            setSessions((prev) => {
              const s = prev[activeWorktreePath];
              if (!s) return prev;
              return {
                ...prev,
                [activeWorktreePath]: {
                  ...s,
                  diffScope: nextScope,
                  tabs: s.tabs.map((t) =>
                    t.id === tab.id ? { ...t, diffScope: nextScope } : t,
                  ),
                },
              };
            });
            void loadDiffDocument(activeWorktreePath, tab.filePath, nextScope);
            void loadWorktreeResources(activeWorktreePath, nextScope);
          }}
          worktrees={worktrees}
          annotations={fileAnns}
          onCreateAnnotation={onCreateAnn}
          onUpdateAnnotation={onEditAnn}
          onResolveAnnotation={(a) => onSetStatus(a, "resolved")}
          onUnresolveAnnotation={(a) => onSetStatus(a, "open")}
          onDeleteAnnotation={onDeleteAnn}
          hunkNavTrigger={!isSplitPane ? hunkNavTrigger : null}
          onOpenFile={(fp, ln) =>
            void openFileInWorktree(activeWorktreePath, fp, { line: ln, viewKind: "code" })
          }
          spotlight={
            matchesInlineTour && viewedWalkthroughStep
              ? {
                  startLine: viewedWalkthroughStep.startLine,
                  endLine: viewedWalkthroughStep.endLine,
                  card: renderWalkthroughCard(viewedWalkthroughStep, "inline"),
                  seq: viewedWalkthroughStep.id,
                }
              : null
          }
        />
      );
    }

    if (!doc) {
      return <div className="editor-empty">Loading {tab.filePath}…</div>;
    }

    if (isMarkdownFile(tab.filePath)) {
      return (
        <MarkdownViewer
          document={doc}
          symbols={syms}
          blame={blameEnabled ? blameCache[docKey] : undefined}
          showBlame={blameEnabled}
          annotations={fileAnns}
          mode={tab.markdownMode ?? "preview"}
          onModeChange={(nextMode) => {
            setSessions((prev) => {
              const s = prev[activeWorktreePath];
              if (!s) return prev;
              return {
                ...prev,
                [activeWorktreePath]: {
                  ...s,
                  tabs: s.tabs.map((t) =>
                    t.id === tab.id ? { ...t, markdownMode: nextMode } : t,
                  ),
                },
              };
            });
          }}
          scrollToRequest={!isSplitPane ? scrollToReq : null}
          recentlyUpdatedAt={filePulseAt[docKey]}
          onCreateAnnotation={onCreateAnn}
          onUpdateAnnotation={onEditAnn}
          onResolveAnnotation={(a) => onSetStatus(a, "resolved")}
          onUnresolveAnnotation={(a) => onSetStatus(a, "open")}
          onDeleteAnnotation={onDeleteAnn}
          onSymbolActivate={(p) => void handleSymbolActivate(p)}
          onOpenRelativeLink={async (rawTarget, anchor) => {
            const needsRelResolve =
              !rawTarget || rawTarget.startsWith("./") || rawTarget.startsWith("../");
            const resolved = needsRelResolve
              ? resolvePosixRelative(tab.filePath, rawTarget)
              : { path: rawTarget.replace(/^\/+/, ""), anchor };
            const targetPath = resolved.path;
            const hash = anchor ?? resolved.anchor;
            let lineNum: number | undefined;
            const lineMatch = hash?.match(/^L(\d+)/i);
            if (lineMatch?.[1]) {
              lineNum = Number.parseInt(lineMatch[1], 10);
            } else if (hash) {
              const slug = decodeURIComponent(hash).toLowerCase().replace(/^#/, "");
              const slugify = (s: string) =>
                s
                  .toLowerCase()
                  .replace(/[^\w\s-]/g, "")
                  .trim()
                  .replace(/\s+/g, "-");
              const findHeadingLine = (list: CodeSymbol[]): number | undefined => {
                for (const sym of list) {
                  if (sym.kind === "heading" && slugify(sym.name) === slug) {
                    return sym.startLine;
                  }
                  if (sym.children) {
                    const nested = findHeadingLine(sym.children);
                    if (nested !== undefined) return nested;
                  }
                }
                return undefined;
              };
              try {
                const targetSyms =
                  symbolsCache[`${activeWorktreePath}::${targetPath}`] ??
                  (await window.ide2.getStructure(activeWorktreePath, targetPath));
                lineNum = findHeadingLine(targetSyms);
              } catch {
                // Target file may not exist; openFileInWorktree handles toast cleanly
              }
            }
            void openFileInWorktree(activeWorktreePath, targetPath, { line: lineNum });
          }}
          onOpenExternalUrl={(url) => void window.ide2.openExternalUrl(url)}
          readAssetDataUrl={(fromFile, href) =>
            window.ide2.readAssetDataUrl(activeWorktreePath, fromFile, href)
          }
          onCursorChange={(pos) => {
            if (!isSplitPane) setCursorPos(pos);
          }}
          findOpenTrigger={!isSplitPane ? findTrigger : 0}
          annotateTrigger={!isSplitPane ? annotateTrigger : 0}
          spotlight={
            matchesInlineTour && viewedWalkthroughStep && viewedWalkthroughStep.startLine
              ? {
                  startLine: viewedWalkthroughStep.startLine,
                  endLine:
                    viewedWalkthroughStep.endLine ?? viewedWalkthroughStep.startLine,
                  card: renderWalkthroughCard(viewedWalkthroughStep, "inline"),
                  seq: viewedWalkthroughStep.id,
                }
              : null
          }
        />
      );
    }

    return (
      <CodeViewport
        document={doc}
        symbols={syms}
        blame={blameEnabled ? blameCache[docKey] : undefined}
        showBlame={blameEnabled}
        annotations={fileAnns}
        activeLine={cursorPos.line}
        scrollToRequest={!isSplitPane ? scrollToReq : null}
        recentlyUpdatedAt={filePulseAt[docKey]}
        onCreateAnnotation={onCreateAnn}
        onUpdateAnnotation={onEditAnn}
        onResolveAnnotation={(a) => onSetStatus(a, "resolved")}
        onUnresolveAnnotation={(a) => onSetStatus(a, "open")}
        onDeleteAnnotation={onDeleteAnn}
        onSymbolActivate={(p) => void handleSymbolActivate(p)}
        onCursorChange={(pos) => {
          if (!isSplitPane) setCursorPos(pos);
        }}
        findOpenTrigger={!isSplitPane ? findTrigger : 0}
        annotateTrigger={!isSplitPane ? annotateTrigger : 0}
        spotlight={
          matchesInlineTour && viewedWalkthroughStep && viewedWalkthroughStep.startLine
            ? {
                startLine: viewedWalkthroughStep.startLine,
                endLine:
                  viewedWalkthroughStep.endLine ?? viewedWalkthroughStep.startLine,
                card: renderWalkthroughCard(viewedWalkthroughStep, "inline"),
                seq: viewedWalkthroughStep.id,
              }
            : null
        }
      />
    );
  };

  if (bootError) {
    return (
      <div className="ide-root" style={{ padding: "32px" }}>
        <div className="jb-popup" style={{ padding: "20px", maxWidth: "620px" }}>
          <h2 style={{ color: "var(--unsafe)", marginBottom: "8px" }}>
            ✘ Could not open repository in ide2
          </h2>
          <p style={{ color: "var(--dim)" }}>{bootError}</p>
          <p style={{ color: "var(--off)", marginTop: "12px", fontSize: "12px" }}>
            Launch `ide2` inside any Git repository or worktree directory.
          </p>
        </div>
      </div>
    );
  }

  if (!context || !activeWorktree) {
    return (
      <div className="ide-root">
        <div className="editor-empty">
          <Expect2Wordmark height={34} withTrail={true} />
          <span style={{ fontSize: "12.5px", color: "var(--dim)" }}>Loading workspace…</span>
        </div>
      </div>
    );
  }

  const activeChangedFile = changedByWt[activeWorktreePath]?.find(
    (c) => c.path === activeTab?.filePath,
  );

  return (
    <div className={`ide-root${crtEnabled ? " crt-scanlines" : ""}`}>
      {/* 1. Always-Visible Top Multi-Worktree Strip */}
      <WorktreeStrip
        worktrees={worktrees}
        activeWorktreePath={activeWorktreePath}
        annotations={annotations}
        platform={platform}
        onSelectWorktree={(wtPath) => setActiveWorktreePath(wtPath)}
        onCreateWorktree={async (params) => {
          const wt = await window.ide2.createWorktree(params);
          showToast(`Created worktree ${wt.name} (${wt.branch})`);
          return wt;
        }}
        onCopyText={(txt) => {
          void window.ide2.copyToClipboard(txt);
          showToast("Copied to clipboard");
        }}
        onRevealInOs={(p) => window.ide2.revealInOs(p)}
        onOpenSearchEverywhere={() => setSearchPopup({ open: true, tab: "all" })}
        onOpenSwitchWorktree={() => setSearchPopup({ open: true, tab: "worktrees" })}
      />

      {/* 2. Navigation Breadcrumb & Action Bar */}
      <div className="ide-breadcrumb">
        <div style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0, position: "relative" }}>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={(e) => {
              e.stopPropagation();
              setProjectMenuOpen((v) => !v);
            }}
            title={`Switch or open another project in a new window (${formatShortcut("open-project-window", platform)})`}
            style={{
              padding: "2px 7px",
              height: "24px",
              color: "var(--ink)",
              fontWeight: 600,
              gap: "5px",
              background: projectMenuOpen ? "var(--wash-hi)" : undefined,
            }}
          >
            <IconProject size={13} />
            <span>{context.repoName}</span>
            <span style={{ color: "var(--dim)", fontSize: "10px" }}>▾</span>
          </button>

          {projectMenuOpen && (
            <div
              role="menu"
              aria-label="Project Switcher"
              onClick={(e) => e.stopPropagation()}
              style={{
                position: "absolute",
                top: "calc(100% + 4px)",
                left: 0,
                zIndex: 1200,
                minWidth: "280px",
                maxWidth: "380px",
                background: "var(--wash)",
                border: "1px solid var(--border-strong)",
                borderRadius: "8px",
                boxShadow: "var(--shadow-popup)",
                padding: "4px",
                fontFamily: "var(--ui-font)",
                fontSize: "12.5px",
              }}
            >
              <button
                type="button"
                role="menuitem"
                className="ide2-project-menu-item"
                onClick={() => void handleOpenProjectWindow()}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "12px",
                  width: "100%",
                  padding: "6px 8px",
                  borderRadius: "5px",
                  border: "none",
                  background: "transparent",
                  color: "var(--ink)",
                  fontWeight: 500,
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: "7px" }}>
                  <IconNewWindow size={14} />
                  <span>Open Project in New Window…</span>
                </span>
                <span className="kbd-hint">{formatShortcut("open-project-window", platform)}</span>
              </button>

              {recentProjects.length > 0 && (
                <>
                  <div style={{ height: "1px", background: "var(--faint)", margin: "4px 6px" }} />
                  <div
                    style={{
                      padding: "3px 8px 4px",
                      fontSize: "10.5px",
                      fontWeight: 600,
                      letterSpacing: "0.04em",
                      color: "var(--dim)",
                    }}
                  >
                    RECENT PROJECTS
                  </div>
                  {recentProjects.map((proj) => {
                    const isCurrent = proj.repoCommonDir === context.repoCommonDir;
                    return (
                      <button
                        key={proj.repoCommonDir}
                        type="button"
                        role="menuitem"
                        className={`ide2-project-menu-item${isCurrent ? " is-current" : ""}`}
                        onClick={() => void handleOpenProjectWindow(proj.path)}
                        title={proj.path}
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "flex-start",
                          gap: "1px",
                          width: "100%",
                          padding: "5px 8px",
                          borderRadius: "5px",
                          border: "none",
                          background: isCurrent ? "var(--selection, #2e436e)" : "transparent",
                          color: isCurrent ? "#ffffff" : "var(--ink)",
                          textAlign: "left",
                          cursor: "pointer",
                        }}
                      >
                        <span style={{ fontWeight: isCurrent ? 600 : 500, fontSize: "12px" }}>
                          {isCurrent ? `● ${proj.name}` : proj.name}
                        </span>
                        <span
                          style={{
                            fontFamily: "var(--mono)",
                            fontSize: "10.5px",
                            color: isCurrent ? "rgba(255, 255, 255, 0.72)" : "var(--dim)",
                            maxWidth: "100%",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {proj.path}
                        </span>
                      </button>
                    );
                  })}
                </>
              )}
            </div>
          )}

          <span style={{ color: "var(--off)" }}>›</span>
          <span style={{ color: "var(--dim)" }}>{activeWorktree.name}</span>
          {activeTab && (
            <>
              <span style={{ color: "var(--off)" }}>›</span>
              <span style={{ color: "var(--ink)", fontFamily: "var(--mono)", fontSize: "12px" }}>
                {activeTab.filePath.split("/").join(" › ")}
              </span>
            </>
          )}
          {activeChangedFile && (
            <span style={{ fontFamily: "var(--mono)", fontSize: "11.5px", marginLeft: "6px" }}>
              <span style={{ color: "var(--safe)" }}>+{activeChangedFile.additions}</span>{" "}
              <span style={{ color: "var(--unsafe)" }}>-{activeChangedFile.deletions}</span>
            </span>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setSearchPopup({ open: true, tab: "all" })}
            title="Search Everywhere (Shift+Shift)"
          >
            <IconSearch size={13} />
            <span>Search</span>
            <span className="kbd-hint">⇧⇧</span>
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setFindInPathOpen(true)}
            title={`Find in Path (${formatShortcut("find-in-path", platform)})`}
          >
            <span>Find in Path</span>
            <span className="kbd-hint">{formatShortcut("find-in-path", platform)}</span>
          </button>
          {activeTab && (
            <button
              type="button"
              className={`btn${activeTab.viewKind === "diff" ? " btn-primary" : " btn-ghost"}`}
              onClick={() => runAction("toggle-diff")}
              title={`Toggle Diff (${formatShortcut("toggle-diff", platform)})`}
            >
              <IconDiff size={13} />
              <span>Diff</span>
              <span className="kbd-hint">{formatShortcut("toggle-diff", platform)}</span>
            </button>
          )}
          <div style={{ position: "relative" }}>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={(e) => {
                e.stopPropagation();
                setAgentMenuOpen((v) => !v);
              }}
              title="Copy prompts to connect a coding agent (Walkthrough or Live Review)"
              style={{ background: agentMenuOpen ? "var(--wash-hi)" : undefined }}
            >
              <IconWalkthrough size={13} />
              <span>Agent</span>
              <span style={{ color: "var(--dim)", fontSize: "10px" }}>▾</span>
            </button>
            {agentMenuOpen && (
              <div
                role="menu"
                aria-label="Coding Agent Workflows"
                onClick={(e) => e.stopPropagation()}
                style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  right: 0,
                  zIndex: 1200,
                  minWidth: "270px",
                  background: "var(--wash)",
                  border: "1px solid var(--border-strong)",
                  borderRadius: "8px",
                  boxShadow: "var(--shadow-popup)",
                  padding: "4px",
                  fontFamily: "var(--ui-font)",
                  fontSize: "12.5px",
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="ide2-project-menu-item"
                  onClick={() => void handleCopyReviewPrompt()}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    gap: "2px",
                    width: "100%",
                    padding: "6px 8px",
                    borderRadius: "5px",
                    border: "none",
                    background: "transparent",
                    color: "var(--ink)",
                    textAlign: "left",
                    cursor: "pointer",
                  }}
                >
                  <span style={{ fontWeight: 500 }}>Copy Live Review Prompt</span>
                  <span style={{ fontSize: "11px", color: "var(--dim)" }}>
                    Agent runs `ide2 review wait` (no copy/paste)
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="ide2-project-menu-item"
                  onClick={() => void handleCopyWalkthroughPrompt()}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    gap: "2px",
                    width: "100%",
                    padding: "6px 8px",
                    borderRadius: "5px",
                    border: "none",
                    background: "transparent",
                    color: "var(--ink)",
                    textAlign: "left",
                    cursor: "pointer",
                  }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", width: "100%", justifyContent: "space-between" }}>
                    <span style={{ fontWeight: 500 }}>Copy Walkthrough Prompt</span>
                    <span className="kbd-hint">{formatShortcut("copy-walkthrough-prompt", platform)}</span>
                  </span>
                  <span style={{ fontSize: "11px", color: "var(--dim)" }}>
                    Agent guides you top-down via `ide2 tour`
                  </span>
                </button>
              </div>
            )}
          </div>
          {review?.awaitingUser ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                if (openWtAnnotationCount > 0) {
                  void handleSendReviewFeedback();
                } else {
                  setExportModalOpen(true);
                }
              }}
              title="Send open annotations directly to the waiting coding agent (no copy/paste)"
            >
              <IconExport size={13} />
              <span>
                Send to Agent{openWtAnnotationCount > 0 ? ` (${openWtAnnotationCount})` : ""} →
              </span>
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setExportModalOpen(true)}
              title={`Preview & Export Feedback Prompt (${formatShortcut("export-prompt-preview", platform)})`}
            >
              <IconExport size={13} />
              <span>Export Prompt{openWtAnnotationCount > 0 ? ` (${openWtAnnotationCount})` : ""}</span>
            </button>
          )}
        </div>
      </div>

      {/* 2a. Live Connected Agent Review Bar */}
      {review && (
        <ReviewSessionBar
          review={review}
          openAnnotationCount={openWtAnnotationCount}
          onSendFeedback={() => handleSendReviewFeedback()}
          onApprove={() => handleApproveReview()}
          onCancel={() => handleCancelReview()}
        />
      )}

      {/* 2b. Active Walkthrough Step Outline Bar */}
      {walkthrough && walkthrough.steps.length > 0 && viewedWalkthroughStep && (
        <WalkthroughBar
          walkthrough={walkthrough}
          viewedStepId={viewedWalkthroughStep.id}
          onSelectStep={(s) => applyWalkthroughStepNavigation(s)}
          onEndWalkthrough={() => window.ide2.endWalkthrough()}
        />
      )}

      {/* 3. Main JetBrains Body: Left Tool Stripe + Left Dock + Editor Canvas + Right Annotations Dock */}
      <div className="ide-body">
        <aside className="tool-stripe" aria-label="Tool Window Bar">
          <button
            type="button"
            className={`tool-stripe-btn${leftTool === "project" ? " active" : ""}`}
            onClick={() => runAction("tool-project")}
            title={`Project (${formatShortcut("tool-project", platform)})`}
          >
            <IconProject />
          </button>
          <button
            type="button"
            className={`tool-stripe-btn${leftTool === "structure" ? " active" : ""}`}
            onClick={() => runAction("tool-structure")}
            title={`Structure (${formatShortcut("tool-structure", platform)})`}
          >
            <IconStructure />
          </button>
          <button
            type="button"
            className={`tool-stripe-btn${bottomTool === "git" ? " active" : ""}`}
            onClick={() => runAction("tool-git")}
            title={`Git & Worktrees (${formatShortcut("tool-git", platform)})`}
          >
            <IconGitBranch />
          </button>
          <button
            type="button"
            className={`tool-stripe-btn${rightAnnotationsOpen ? " active" : ""}`}
            onClick={() => runAction("tool-annotations")}
            title={`Annotations (${formatShortcut("tool-annotations", platform)})`}
          >
            <IconAnnotations />
            {openWtAnnotationCount > 0 && (
              <span className="tool-stripe-badge">{openWtAnnotationCount}</span>
            )}
          </button>
        </aside>

        {leftTool && (
          <div className="tool-dock tool-dock-left" style={{ width: "270px", flexShrink: 0 }}>
            {leftTool === "project" ? (
              <ProjectToolWindow
                worktreeName={activeWorktree.name}
                files={filesByWt[activeWorktreePath] ?? []}
                activeFilePath={activeTab?.filePath}
                locateRequest={projectLocateReq}
                highlightedDirPath={
                  viewedWalkthroughStep?.targetKind === "folder" &&
                  viewedWalkthroughStep.worktreePath === activeWorktreePath
                    ? viewedWalkthroughStep.targetPath ?? null
                    : null
                }
                focusDirRequest={folderFocusReq}
                annotations={worktreeAnnotations}
                activeWorktreePath={activeWorktreePath}
                platform={platform}
                onSelectFile={(fp) => void openFileInWorktree(activeWorktreePath, fp)}
                onClose={() => setLeftTool(null)}
              />
            ) : (
              <StructureToolWindow
                filePath={activeTab?.filePath}
                symbols={activeSymbols}
                activeLine={cursorPos.line}
                platform={platform}
                onSelectSymbol={(sym) =>
                  void openFileInWorktree(sym.worktreePath, sym.filePath, {
                    line: sym.startLine,
                  })
                }
                onClose={() => setLeftTool(null)}
              />
            )}
          </div>
        )}

        {/* Center Column: Editor Canvas + Bottom Tool Dock */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            minWidth: 0,
            minHeight: 0,
          }}
        >
          <div className="editor-group">
            {/* Tab Bar */}
            {currentSession.tabs.length > 0 && (
              <div className="tab-bar" role="tablist">
                {currentSession.tabs.map((tab) => {
                  const isActive = tab.id === currentSession.activeTabId;
                  const baseName = tab.filePath.split("/").pop() ?? tab.filePath;
                  const tabAnnCount = worktreeAnnotations.filter(
                    (a) => a.filePath === tab.filePath && a.status === "open",
                  ).length;

                  return (
                    <div
                      key={tab.id}
                      role="tab"
                      aria-selected={isActive}
                      className={`tab-item${isActive ? " active" : ""}${tab.pinned ? " pinned" : ""}`}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setTabContextMenu({ tabId: tab.id, x: e.clientX, y: e.clientY });
                      }}
                      onAuxClick={(e) => {
                        if (e.button === 1) {
                          e.preventDefault();
                          handleCloseTab(tab.id);
                        }
                      }}
                      onClick={() => {
                        setSessions((prev) => ({
                          ...prev,
                          [activeWorktreePath]: {
                            ...currentSession,
                            activeTabId: tab.id,
                          },
                        }));
                        if (tab.viewKind === "diff") {
                          void loadDiffDocument(
                            activeWorktreePath,
                            tab.filePath,
                            tab.diffScope ?? currentSession.diffScope,
                          );
                        } else if (!docsCache[`${activeWorktreePath}::${tab.filePath}`]) {
                          void loadFileDocument(
                            activeWorktreePath,
                            tab.filePath,
                            currentSession.diffScope,
                          );
                        }
                      }}
                    >
                      {tab.pinned && (
                        <span
                          title="Pinned tab"
                          style={{ color: "var(--sky)", fontSize: "10px", lineHeight: 1 }}
                        >
                          ●
                        </span>
                      )}
                      {tab.viewKind === "diff" && (
                        <span style={{ color: "var(--unknown)", fontSize: "10px" }}>DIFF</span>
                      )}
                      <span>{baseName}</span>
                      {tabAnnCount > 0 && (
                        <span style={{ color: "var(--sky)", fontSize: "10px" }}>
                          ◆{tabAnnCount}
                        </span>
                      )}
                      <button
                        type="button"
                        className="tab-close-btn"
                        aria-label={tab.pinned ? `Unpin ${baseName}` : `Close ${baseName}`}
                        title={tab.pinned ? "Unpin Tab" : `Close (${formatShortcut("close-tab", platform)})`}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (tab.pinned) {
                            updateActiveSessionTabs((s) => ({ ...s, ...togglePinTab(s, tab.id) }));
                          } else {
                            handleCloseTab(tab.id);
                          }
                        }}
                      >
                        {tab.pinned ? "▾" : "×"}
                      </button>
                    </div>
                  );
                })}

                <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", paddingRight: "8px" }}>
                  {activeTab && (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => runAction("split-right")}
                      title={`Split Editor Right (${formatShortcut("split-right", platform)})`}
                    >
                      <IconSplit size={13} />
                      <span>Split</span>
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Banner Walkthrough Card for Overview, Folder, Whole-File, or off-tab Range steps */}
            {viewedWalkthroughStep &&
              (viewedWalkthroughStep.targetKind === "overview" ||
                viewedWalkthroughStep.targetKind === "folder" ||
                viewedWalkthroughStep.targetKind === "file" ||
                !activeTab ||
                viewedWalkthroughStep.worktreePath !== activeWorktreePath ||
                viewedWalkthroughStep.targetPath !== activeTab.filePath ||
                (viewedWalkthroughStep.targetKind === "range" && activeTab.viewKind !== "code") ||
                (viewedWalkthroughStep.targetKind === "diff" && activeTab.viewKind !== "diff")) &&
              renderWalkthroughCard(viewedWalkthroughStep, "banner")}

            {/* Viewport or Split Viewports */}
            {activeTab ? (
              <div
                className="editor-split"
                style={{
                  flexDirection: currentSession.splitDirection === "down" ? "column" : "row",
                }}
              >
                <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
                  {renderTabViewport(activeTab, false)}
                </div>
                {splitTab && (
                  <>
                    <div
                      className={`split-resizer ${
                        currentSession.splitDirection === "down"
                          ? "split-resizer-row"
                          : "split-resizer-col"
                      }`}
                    />
                    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
                      {renderTabViewport(splitTab, true)}
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="editor-empty">
                <Expect2Wordmark height={42} withTrail={true} />
                <div style={{ fontSize: "12.5px", color: "var(--dim)" }}>
                  Read-only IDE for reviewing agent-authored code & worktrees
                </div>
                <div className="editor-empty-shortcuts">
                  <span>Search Everywhere</span>
                  <span className="kbd-hint">⇧⇧</span>
                  <span>Go to File</span>
                  <span className="kbd-hint">{formatShortcut("go-to-file", platform)}</span>
                  <span>Recent Files</span>
                  <span className="kbd-hint">{formatShortcut("recent-files", platform)}</span>
                  <span>Find in Path</span>
                  <span className="kbd-hint">{formatShortcut("find-in-path", platform)}</span>
                  <span>Git & Worktrees</span>
                  <span className="kbd-hint">{formatShortcut("tool-git", platform)}</span>
                  <span>Open Project in New Window</span>
                  <span className="kbd-hint">{formatShortcut("open-project-window", platform)}</span>
                </div>
              </div>
            )}
          </div>

          {/* Bottom Dock: 9 Git & Worktrees OR Alt+F7 Usages */}
          {bottomTool && (
            <div className="tool-dock tool-dock-bottom" style={{ height: "250px", flexShrink: 0 }}>
              {bottomTool === "git" ? (
                <GitToolWindow
                  worktrees={worktrees}
                  activeWorktree={activeWorktree}
                  changedFiles={changedByWt[activeWorktreePath] ?? []}
                  diffScope={currentSession.diffScope}
                  commits={commitsByWt[activeWorktreePath] ?? []}
                  activeFilePath={activeTab?.filePath}
                  platform={platform}
                  onChangeDiffScope={(nextScope) => {
                    setSessions((prev) => ({
                      ...prev,
                      [activeWorktreePath]: {
                        ...currentSession,
                        diffScope: nextScope,
                      },
                    }));
                    void loadWorktreeResources(activeWorktreePath, nextScope);
                  }}
                  onOpenDiff={(fp, scope) =>
                    void openFileInWorktree(activeWorktreePath, fp, {
                      viewKind: "diff",
                      diffScope: scope,
                    })
                  }
                  onOpenActiveFileDiff={() => runAction("toggle-diff")}
                  onSwitchWorktree={(wtPath) => setActiveWorktreePath(wtPath)}
                  onCompareWorktrees={(otherWtPath) => {
                    const nextScope: DiffScope = {
                      kind: "worktree",
                      otherWorktreePath: otherWtPath,
                    };
                    setSessions((prev) => ({
                      ...prev,
                      [activeWorktreePath]: {
                        ...currentSession,
                        diffScope: nextScope,
                      },
                    }));
                    void loadWorktreeResources(activeWorktreePath, nextScope);
                    if (activeTab) {
                      void openFileInWorktree(activeWorktreePath, activeTab.filePath, {
                        viewKind: "diff",
                        diffScope: nextScope,
                      });
                    }
                  }}
                  onCopyText={(txt) => {
                    void window.ide2.copyToClipboard(txt);
                    showToast("Copied to clipboard");
                  }}
                  onLoadCommitChanges={(sha) =>
                    window.ide2.listChangedFiles(activeWorktreePath, { kind: "commit", sha })
                  }
                  onClose={() => setBottomTool(null)}
                />
              ) : usagesState ? (
                <UsagesToolWindow
                  symbolName={usagesState.symbolName}
                  definitions={usagesState.definitions}
                  usages={usagesState.usages}
                  platform={platform}
                  onJumpToMatch={(m) =>
                    void openFileInWorktree(m.worktreePath, m.filePath, {
                      line: m.line,
                      column: m.column,
                    })
                  }
                  onClose={() => setBottomTool(null)}
                />
              ) : null}
            </div>
          )}
        </div>

        {/* Right Dock: 6 Annotations & Feedback Prompt Composer */}
        {rightAnnotationsOpen && (
          <div className="tool-dock tool-dock-right" style={{ width: "340px", flexShrink: 0 }}>
            <AnnotationsToolWindow
              worktree={activeWorktree}
              annotations={worktreeAnnotations}
              platform={platform}
              reviewConnected={Boolean(review?.awaitingUser)}
              onJumpToAnnotation={(ann) => {
                if (ann.filePath) {
                  void openFileInWorktree(ann.worktreePath, ann.filePath, {
                    line: ann.startLine ?? 1,
                    viewKind: ann.side === "old" ? "diff" : "code",
                  });
                }
              }}
              onSaveWorktreeNote={async (comment, existingNote) => {
                if (existingNote) {
                  await window.ide2.updateAnnotation({ id: existingNote.id, comment });
                } else {
                  await window.ide2.createAnnotation({
                    worktreePath: activeWorktreePath,
                    comment,
                  });
                }
                showToast("Saved overall worktree note");
              }}
              onUpdateAnnotationStatus={async (id, status) => {
                await window.ide2.updateAnnotation({ id, status });
              }}
              onDeleteAnnotation={async (id) => {
                await window.ide2.deleteAnnotation(id);
              }}
              onCopyFeedbackPrompt={(opts) => handleCopyPromptQuick(opts)}
              onSendToAgent={(opts) => handleSendReviewFeedback(opts)}
              onClose={() => setRightAnnotationsOpen(false)}
            />
          </div>
        )}
      </div>

      {/* 4. Dense Bottom Statusline */}
      <Statusline
        worktree={activeWorktree}
        filePath={activeTab?.filePath}
        line={cursorPos.line}
        column={cursorPos.column}
        language={activeDoc?.language}
        blameEnabled={blameEnabled}
        crtEnabled={crtEnabled}
        openAnnotationCount={openWtAnnotationCount}
        lastUpdatedAt={lastUpdatedAt}
        watcherActive={true}
        platform={platform}
        onToggleBlame={() => setBlameEnabled((v) => !v)}
        onToggleCrt={() => setCrtEnabled((v) => !v)}
        onOpenAnnotations={() => setRightAnnotationsOpen((v) => !v)}
        onOpenGoToLine={() => setGoToLineOpen(true)}
        onCopyFeedbackPrompt={() => handleCopyPromptQuick()}
      />

      {/* 5. JetBrains Popups & Modals */}
      <SearchEverywherePopup
        open={searchPopup.open}
        initialTab={searchPopup.tab}
        activeWorktree={activeWorktree}
        worktrees={worktrees}
        platform={platform}
        onSearchFiles={handleSearchFilesMemo}
        onSearchSymbols={handleSearchSymbolsMemo}
        onOpenFile={(wtPath, fp, ln, col) =>
          void openFileInWorktree(wtPath, fp, { line: ln, column: col })
        }
        onSelectWorktree={(wtPath) => setActiveWorktreePath(wtPath)}
        onRunAction={(act) => runAction(act)}
        onClose={() => setSearchPopup((p) => ({ ...p, open: false }))}
      />

      <RecentFilesPopup
        open={recentPopupOpen}
        worktrees={worktrees}
        activeWorktreePath={activeWorktreePath}
        recentFiles={recentFiles}
        platform={platform}
        onOpenFile={(wtPath, fp) => void openFileInWorktree(wtPath, fp)}
        onSelectWorktree={(wtPath) => setActiveWorktreePath(wtPath)}
        onRunAction={(act) => runAction(act)}
        onClose={() => setRecentPopupOpen(false)}
      />

      <FindInPathPopup
        open={findInPathOpen}
        activeWorktree={activeWorktree}
        platform={platform}
        onSearch={handleFindInPathMemo}
        onLoadFilePreview={handleLoadPreviewMemo}
        onSelectMatch={(m) =>
          void openFileInWorktree(m.worktreePath, m.filePath, {
            line: m.line,
            column: m.column,
          })
        }
        onClose={() => setFindInPathOpen(false)}
      />

      <GoToLinePopup
        open={goToLineOpen}
        currentLine={cursorPos.line}
        maxLine={activeDoc?.lines.length}
        platform={platform}
        onJump={(ln, col) => {
          setCursorPos({ line: ln, column: col ?? 1 });
          setScrollToReq({ line: ln, column: col, flash: true, seq: Date.now() });
        }}
        onClose={() => setGoToLineOpen(false)}
      />

      <ExportPromptModal
        open={exportModalOpen}
        worktree={activeWorktree}
        annotations={worktreeAnnotations}
        platform={platform}
        reviewConnected={Boolean(review?.awaitingUser)}
        onCopyFeedbackPrompt={async (opts) => {
          await handleCopyPromptQuick(opts);
          setExportModalOpen(false);
        }}
        onSendToAgent={async (opts) => {
          await handleSendReviewFeedback(opts);
          setExportModalOpen(false);
        }}
        onClose={() => setExportModalOpen(false)}
      />

      {/* JetBrains Editor Tab Context Menu */}
      {tabContextMenu && (() => {
        const menuTabIndex = currentSession.tabs.findIndex(
          (t) => t.id === tabContextMenu.tabId,
        );
        const menuTab = menuTabIndex >= 0 ? currentSession.tabs[menuTabIndex] : undefined;
        if (!menuTab) return null;

        const hasOtherClosableTabs = currentSession.tabs.some(
          (t) => t.id !== menuTab.id && !t.pinned,
        );
        const hasLeftClosableTabs = currentSession.tabs.some(
          (t, i) => i < menuTabIndex && !t.pinned,
        );
        const hasRightClosableTabs = currentSession.tabs.some(
          (t, i) => i > menuTabIndex && !t.pinned,
        );
        const hasUnmodifiedClosableTabs = currentSession.tabs.some(
          (t) => !t.pinned && !modifiedFilePathSet.has(t.filePath),
        );

        return (
          <TabContextMenu
            x={tabContextMenu.x}
            y={tabContextMenu.y}
            tab={menuTab}
            tabIndex={menuTabIndex}
            totalTabs={currentSession.tabs.length}
            hasOtherClosableTabs={hasOtherClosableTabs}
            hasLeftClosableTabs={hasLeftClosableTabs}
            hasRightClosableTabs={hasRightClosableTabs}
            hasUnmodifiedClosableTabs={hasUnmodifiedClosableTabs}
            hasSplitOpen={Boolean(currentSession.splitTabId)}
            currentLine={cursorPos.line}
            isActiveTab={menuTab.id === currentSession.activeTabId}
            worktreePath={activeWorktreePath}
            platform={platform}
            onCloseTab={(id) => handleCloseTab(id)}
            onCloseOtherTabs={(id) =>
              updateActiveSessionTabs((s) => ({ ...s, ...closeOtherTabs(s, id) }))
            }
            onCloseAllTabs={() =>
              updateActiveSessionTabs((s) => ({ ...s, ...closeAllTabs(s) }))
            }
            onCloseTabsToLeft={(id) =>
              updateActiveSessionTabs((s) => ({ ...s, ...closeTabsToLeft(s, id) }))
            }
            onCloseTabsToRight={(id) =>
              updateActiveSessionTabs((s) => ({ ...s, ...closeTabsToRight(s, id) }))
            }
            onCloseUnmodifiedTabs={() =>
              updateActiveSessionTabs((s) => ({
                ...s,
                ...closeUnmodifiedTabs(s, modifiedFilePathSet),
              }))
            }
            onTogglePinTab={(id) =>
              updateActiveSessionTabs((s) => ({ ...s, ...togglePinTab(s, id) }))
            }
            onSplitTab={(id, direction) => {
              const targetTab = currentSession.tabs.find((t) => t.id === id);
              if (targetTab) {
                if (targetTab.viewKind === "diff") {
                  void loadDiffDocument(
                    activeWorktreePath,
                    targetTab.filePath,
                    targetTab.diffScope ?? currentSession.diffScope,
                  );
                } else if (!docsCache[`${activeWorktreePath}::${targetTab.filePath}`]) {
                  void loadFileDocument(
                    activeWorktreePath,
                    targetTab.filePath,
                    currentSession.diffScope,
                  );
                }
              }
              updateActiveSessionTabs((s) => ({
                ...s,
                splitTabId: id,
                splitDirection: direction,
              }));
            }}
            onUnsplit={() =>
              updateActiveSessionTabs((s) => ({
                ...s,
                splitTabId: null,
              }))
            }
            onCopyText={(txt, label) => {
              void window.ide2.copyToClipboard(txt);
              showToast(label);
            }}
            onSelectInProject={(fp) => {
              setLeftTool("project");
              setProjectLocateReq({ filePath: fp, seq: Date.now() });
            }}
            onToggleDiffForTab={(t) => {
              if (t.viewKind === "diff") {
                void openFileInWorktree(activeWorktreePath, t.filePath, {
                  viewKind: "code",
                });
              } else {
                void openFileInWorktree(activeWorktreePath, t.filePath, {
                  viewKind: "diff",
                  diffScope: currentSession.diffScope,
                });
              }
            }}
            onRevealInOs={(absPath) => void window.ide2.revealInOs(absPath)}
            onDismiss={() => setTabContextMenu(null)}
          />
        );
      })()}

      {/* Toast Notification */}
      {toast && (
        <div
          role="status"
          style={{
            position: "fixed",
            right: "16px",
            bottom: "38px",
            zIndex: 1200,
            background: "var(--wash)",
            color: "var(--ink)",
            border: "1px solid var(--border-strong)",
            borderRadius: "8px",
            padding: "8px 14px",
            fontSize: "12.5px",
            fontWeight: 500,
            boxShadow: "var(--shadow-popup)",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <span style={{ color: "var(--safe)", fontWeight: 700 }}>✔</span>
          <span>{toast}</span>
        </div>
      )}
    </div>
  );
};
