import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join, isAbsolute, relative, resolve, sep } from "node:path";
import { toPosixPath } from "../../shared/guard.js";
import type {
  DiffScope,
  ReviewSessionState,
  ReviewUserAction,
  WalkthroughState,
  WalkthroughStep,
  WalkthroughTargetKind,
  WalkthroughUserAction,
  WalkthroughUserResponse,
  WorktreeInfo,
} from "../../shared/protocol.js";
import { getTourEndpointPaths } from "../../shared/walkthrough-prompt.js";

export interface TourHostAdapter {
  ensureRepoWindow(params: {
    cwd: string;
    worktree?: string;
    diff?: boolean;
    focusWindow: boolean;
  }): Promise<{
    repoCommonDir: string;
    repoName: string;
    worktreePath: string;
    worktrees: WorktreeInfo[];
  }>;
  broadcastWalkthrough(repoCommonDir: string, walkthroughs: WalkthroughState[]): void;
  broadcastReview?: (repoCommonDir: string, reviews: ReviewSessionState[]) => void;
}

export interface TourStartParams {
  cwd: string;
  worktree?: string;
  sessionId?: string;
  title?: string;
  totalSteps?: number;
}

export interface TourStepParams {
  cwd: string;
  worktree?: string;
  sessionId?: string;
  target?: string;
  line?: number;
  endLine?: number;
  title: string;
  body: string;
  stepNumber?: number;
  totalSteps?: number;
  diff?: boolean;
  base?: string;
  markdownMode?: "preview" | "split" | "raw";
  final?: boolean;
  wait?: boolean;
  waitTimeoutMs?: number;
}

export interface TourWaitParams {
  cwd: string;
  worktree?: string;
  sessionId?: string;
  waitTimeoutMs?: number;
}

export interface TourStepRpcResult {
  status: "responded" | "waiting" | "no_wait" | "idle";
  sessionId: string;
  stepId?: string;
  stepNumber?: number;
  action?: WalkthroughUserAction;
  message?: string;
}

interface PendingWaiter {
  stepId: string;
  stepNumber: number;
  resolve: (res: TourStepRpcResult) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface RepoTourSession {
  sessionId: string;
  repoCommonDir: string;
  worktreePath: string;
  title?: string;
  totalSteps?: number;
  steps: WalkthroughStep[];
  activeStepId: string;
  awaitingUser: boolean;
  agentThinking: boolean;
  waiter: PendingWaiter | null;
  /** Buffers a user click that occurred while no CLI waiter was currently attached (e.g. right after wait-timeout). */
  bufferedResponse: WalkthroughUserResponse | null;
}

export interface ReviewWaitParams {
  cwd: string;
  worktree?: string;
  sessionId?: string;
  label?: string;
  diff?: boolean;
  resolveOnSend?: boolean;
  waitTimeoutMs?: number;
}

export interface ReviewWaitRpcResult {
  status: "responded" | "waiting" | "idle";
  sessionId: string;
  round: number;
  action?: ReviewUserAction;
  count?: number;
  markdown?: string;
}

interface PendingReviewWaiter {
  resolve: (res: ReviewWaitRpcResult) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface BufferedReviewResponse {
  action: ReviewUserAction;
  round: number;
  count: number;
  markdown?: string;
}

interface RepoReviewSession {
  sessionId: string;
  repoCommonDir: string;
  worktreePath: string;
  label?: string;
  awaitingUser: boolean;
  agentWorking: boolean;
  round: number;
  resolveOnSend: boolean;
  updatedAt: number;
  waiter: PendingReviewWaiter | null;
  bufferedResponse: BufferedReviewResponse | null;
}

export interface TourRpcRequest {
  id: string;
  token: string;
  method:
    | "ping"
    | "tour.start"
    | "tour.step"
    | "tour.wait"
    | "tour.status"
    | "tour.end"
    | "review.wait"
    | "review.status"
    | "review.end";
  params?: Record<string, unknown>;
}

export interface TourRpcResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

function parseTargetWithRange(rawTarget?: string): {
  pathPart?: string;
  startLine?: number;
  endLine?: number;
} {
  if (!rawTarget) return {};
  const trimmed = rawTarget.trim();
  if (!trimmed || trimmed === "." || trimmed === "./") {
    return {};
  }

  const rangeMatch = /^(.*?):(\d+)(?:-(\d+))?$/.exec(trimmed);
  if (rangeMatch && rangeMatch[1]) {
    const s = Number.parseInt(rangeMatch[2] ?? "", 10);
    const e = rangeMatch[3] ? Number.parseInt(rangeMatch[3], 10) : s;
    if (Number.isFinite(s) && s > 0) {
      return {
        pathPart: rangeMatch[1],
        startLine: Math.min(s, Math.max(s, e)),
        endLine: Math.max(s, e),
      };
    }
  }

  return { pathPart: trimmed };
}

function listImmediateFolderFiles(canonWorktree: string, canonDir: string): string[] {
  try {
    const entries = readdirSync(canonDir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "dist")
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) {
          return a.isDirectory() ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

    const out: string[] = [];
    for (const entry of entries.slice(0, 24)) {
      const full = resolve(canonDir, entry.name);
      const rel = toPosixPath(relative(canonWorktree, full));
      out.push(entry.isDirectory() ? `${rel}/` : rel);
    }
    return out;
  } catch {
    return [];
  }
}

function resolveValidatedTarget(
  worktreePath: string,
  params: TourStepParams,
): {
  targetKind: WalkthroughTargetKind;
  targetPath?: string;
  folderFiles?: string[];
  startLine?: number;
  endLine?: number;
  diffScope?: DiffScope;
} {
  const canonWt = realpathSync(worktreePath);
  const parsed = parseTargetWithRange(params.target);
  const startLine = params.line ?? parsed.startLine;
  const endLine = params.endLine ?? parsed.endLine ?? startLine;

  if (!parsed.pathPart) {
    return { targetKind: "overview" };
  }

  const candidateAbs = resolve(canonWt, parsed.pathPart);
  const lexicalRel = relative(canonWt, candidateAbs);
  if (lexicalRel === ".." || lexicalRel.startsWith(`..${sep}`) || isAbsolute(lexicalRel)) {
    throw new Error(`Refused walkthrough target outside worktree: ${params.target}`);
  }
  if (lexicalRel === "") {
    return { targetKind: "overview" };
  }

  if (existsSync(candidateAbs)) {
    const canonTarget = realpathSync(candidateAbs);
    const canonRel = relative(canonWt, canonTarget);
    if (canonRel === ".." || canonRel.startsWith(`..${sep}`) || isAbsolute(canonRel)) {
      throw new Error(`Refused symlink walkthrough target outside worktree: ${params.target}`);
    }
    if (canonRel === "") {
      return { targetKind: "overview" };
    }

    const st = statSync(canonTarget);
    const relPosix = toPosixPath(canonRel);

    if (st.isDirectory()) {
      return {
        targetKind: "folder",
        targetPath: relPosix,
        folderFiles: listImmediateFolderFiles(canonWt, canonTarget),
      };
    }

    if (st.isFile()) {
      if (params.diff) {
        return {
          targetKind: "diff",
          targetPath: relPosix,
          startLine,
          endLine,
          diffScope: { kind: "branch", baseRef: params.base },
        };
      }
      if (startLine !== undefined && startLine > 0) {
        return {
          targetKind: "range",
          targetPath: relPosix,
          startLine,
          endLine: endLine && endLine >= startLine ? endLine : startLine,
        };
      }
      return {
        targetKind: "file",
        targetPath: relPosix,
      };
    }
  } else if (params.diff) {
    // Support diffing a file that was deleted in the working tree
    return {
      targetKind: "diff",
      targetPath: toPosixPath(lexicalRel),
      startLine,
      endLine,
      diffScope: { kind: "branch", baseRef: params.base },
    };
  }

  throw new Error(`Target path does not exist in worktree (${canonWt}): ${parsed.pathPart}`);
}

async function probeSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const sock = createConnection({ path: socketPath });
    const timer = setTimeout(() => {
      sock.destroy();
      resolveProbe(false);
    }, 350);
    sock.once("connect", () => {
      clearTimeout(timer);
      sock.destroy();
      resolveProbe(true);
    });
    sock.once("error", () => {
      clearTimeout(timer);
      sock.destroy();
      resolveProbe(false);
    });
  });
}

export class TourServer {
  private readonly host: TourHostAdapter;
  private readonly runDir: string;
  private readonly socketPath: string;
  private readonly tokenPath: string;
  private readonly pidPath: string;
  private readonly ipcDir: string;
  private readonly secretToken: string;
  private readonly sessions = new Map<string, RepoTourSession>();
  private readonly reviewSessions = new Map<string, RepoReviewSession>();
  private readonly inFlightFileReqs = new Set<string>();
  private server: Server | null = null;
  private ipcWatcher: FSWatcher | null = null;
  private ipcPollTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(host: TourHostAdapter, customRunDir?: string) {
    this.host = host;
    const paths = getTourEndpointPaths(customRunDir);
    this.runDir = paths.runDir;
    this.socketPath = paths.socketPath;
    this.tokenPath = paths.tokenPath;
    this.pidPath = paths.pidPath;
    this.ipcDir = paths.ipcDir;
    this.secretToken = randomBytes(32).toString("hex");
  }

  getEndpointPaths(): {
    runDir: string;
    socketPath: string;
    tokenPath: string;
    pidPath: string;
    ipcDir: string;
  } {
    return {
      runDir: this.runDir,
      socketPath: this.socketPath,
      tokenPath: this.tokenPath,
      pidPath: this.pidPath,
      ipcDir: this.ipcDir,
    };
  }

  async listen(): Promise<void> {
    mkdirSync(this.runDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.ipcDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.runDir, 0o700);
      chmodSync(this.ipcDir, 0o700);
    } catch {
      // ignore on platforms without POSIX chmod
    }

    // Clean any stale request/response files from an earlier crashed run
    try {
      for (const name of readdirSync(this.ipcDir)) {
        rmSync(join(this.ipcDir, name), { force: true });
      }
    } catch {
      // ignore
    }

    if (process.platform !== "win32" && existsSync(this.socketPath)) {
      const alive = await probeSocketAlive(this.socketPath);
      if (!alive) {
        try {
          unlinkSync(this.socketPath);
        } catch {
          // ignore
        }
      }
    }

    writeFileSync(this.tokenPath, `${this.secretToken}\n`, { encoding: "utf8", mode: 0o600 });
    writeFileSync(this.pidPath, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(this.tokenPath, 0o600);
      chmodSync(this.pidPath, 0o600);
    } catch {
      // ignore on Windows
    }

    // Start filesystem mailbox IPC watcher (works even when agent runs inside a no-network sandbox!)
    try {
      this.ipcWatcher = watch(this.ipcDir, () => {
        this.sweepFileRequests();
      });
      this.ipcWatcher.on("error", () => {});
    } catch {
      // fallback to poll timer below
    }
    this.ipcPollTimer = setInterval(() => this.sweepFileRequests(), 25);
    this.ipcPollTimer.unref?.();

    // Also start fast Unix domain socket / named pipe listener when permitted by OS environment
    await new Promise<void>((resolveListen) => {
      const srv = createServer((conn) => this.handleConnection(conn));
      srv.once("error", () => {
        // If socket bind is restricted by an outer sandbox, filesystem mailbox IPC remains active
        resolveListen();
      });
      srv.listen(this.socketPath, () => {
        if (process.platform !== "win32") {
          try {
            chmodSync(this.socketPath, 0o600);
          } catch {
            // ignore
          }
        }
        this.server = srv;
        resolveListen();
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.ipcPollTimer) {
      clearInterval(this.ipcPollTimer);
      this.ipcPollTimer = null;
    }
    if (this.ipcWatcher) {
      try {
        this.ipcWatcher.close();
      } catch {
        // ignore
      }
      this.ipcWatcher = null;
    }

    for (const session of this.sessions.values()) {
      if (session.waiter) {
        if (session.waiter.timer) clearTimeout(session.waiter.timer);
        session.waiter.resolve({
          status: "responded",
          sessionId: session.sessionId,
          stepId: session.waiter.stepId,
          stepNumber: session.waiter.stepNumber,
          action: "stop",
        });
        session.waiter = null;
      }
    }
    this.sessions.clear();

    for (const rev of this.reviewSessions.values()) {
      if (rev.waiter) {
        if (rev.waiter.timer) clearTimeout(rev.waiter.timer);
        rev.waiter.resolve({
          status: "responded",
          sessionId: rev.sessionId,
          round: rev.round,
          action: "cancel",
        });
        rev.waiter = null;
      }
    }
    this.reviewSessions.clear();

    if (this.server) {
      const srv = this.server;
      this.server = null;
      await new Promise<void>((r) => srv.close(() => r()));
    }

    for (const p of [this.socketPath, this.tokenPath, this.pidPath]) {
      if (p && existsSync(p)) {
        try {
          rmSync(p, { force: true });
        } catch {
          // ignore
        }
      }
    }
  }

  private canonPath(p: string): string {
    try {
      return existsSync(p) ? realpathSync(p) : resolve(p);
    } catch {
      return resolve(p);
    }
  }

  private isTourEndedBuffered(session: RepoTourSession): boolean {
    return Boolean(
      session.bufferedResponse &&
        (session.bufferedResponse.action === "finish" || session.bufferedResponse.action === "stop"),
    );
  }

  private isReviewEndedBuffered(session: RepoReviewSession): boolean {
    return Boolean(
      session.bufferedResponse &&
        (session.bufferedResponse.action === "approve" || session.bufferedResponse.action === "cancel"),
    );
  }

  private broadcastRepoWalkthroughs(repoCommonDir: string): void {
    const canonRepo = this.canonPath(repoCommonDir);
    this.host.broadcastWalkthrough(canonRepo, this.getWalkthroughStates(canonRepo));
  }

  private broadcastRepoReviews(repoCommonDir: string): void {
    const canonRepo = this.canonPath(repoCommonDir);
    this.host.broadcastReview?.(canonRepo, this.getReviewStates(canonRepo));
  }

  /** Cleanly terminate any waiting tours or review sessions when a repository's last window closes. */
  closeRepo(repoCommonDir: string): void {
    const canonRepo = this.canonPath(repoCommonDir);
    for (const [id, session] of Array.from(this.sessions.entries())) {
      if (session.repoCommonDir !== canonRepo) continue;
      if (session.waiter) {
        if (session.waiter.timer) clearTimeout(session.waiter.timer);
        session.waiter.resolve({
          status: "responded",
          sessionId: session.sessionId,
          stepId: session.waiter.stepId,
          stepNumber: session.waiter.stepNumber,
          action: "stop",
        });
        session.waiter = null;
      }
      this.sessions.delete(id);
    }
    for (const [id, rev] of Array.from(this.reviewSessions.entries())) {
      if (rev.repoCommonDir !== canonRepo) continue;
      if (rev.waiter) {
        if (rev.waiter.timer) clearTimeout(rev.waiter.timer);
        rev.waiter.resolve({
          status: "responded",
          sessionId: rev.sessionId,
          round: rev.round,
          action: "cancel",
        });
        rev.waiter = null;
      }
      this.reviewSessions.delete(id);
    }
  }

  getWalkthroughStates(repoCommonDir: string): WalkthroughState[] {
    const canonRepo = this.canonPath(repoCommonDir);
    const out: WalkthroughState[] = [];
    for (const session of this.sessions.values()) {
      if (
        session.repoCommonDir === canonRepo &&
        session.steps.length > 0 &&
        !this.isTourEndedBuffered(session)
      ) {
        out.push(this.toPublicState(session));
      }
    }
    return out;
  }

  getState(repoCommonDir: string, worktreePath?: string, sessionId?: string): WalkthroughState | null {
    const canonRepo = this.canonPath(repoCommonDir);
    if (sessionId) {
      const s = this.sessions.get(sessionId);
      if (s && s.repoCommonDir === canonRepo && s.steps.length > 0 && !this.isTourEndedBuffered(s)) {
        return this.toPublicState(s);
      }
      return null;
    }
    const states = this.getWalkthroughStates(canonRepo);
    if (worktreePath) {
      const canonWt = this.canonPath(worktreePath);
      return states.find((s) => s.worktreePath === canonWt) ?? null;
    }
    return states[0] ?? null;
  }

  respondFromUser(repoCommonDir: string, response: WalkthroughUserResponse): void {
    const canonRepo = this.canonPath(repoCommonDir);
    let session: RepoTourSession | undefined;

    if (response.sessionId) {
      const candidate = this.sessions.get(response.sessionId);
      if (candidate && candidate.repoCommonDir === canonRepo) {
        session = candidate;
      }
    }
    if (!session && response.worktreePath) {
      const canonWt = this.canonPath(response.worktreePath);
      session = Array.from(this.sessions.values()).find(
        (s) => s.repoCommonDir === canonRepo && s.worktreePath === canonWt && !this.isTourEndedBuffered(s),
      );
    }
    if (!session) {
      session = Array.from(this.sessions.values()).find(
        (s) =>
          s.repoCommonDir === canonRepo &&
          !this.isTourEndedBuffered(s) &&
          s.steps.some((st) => st.id === response.stepId),
      );
    }
    if (!session) {
      session = Array.from(this.sessions.values()).find(
        (s) => s.repoCommonDir === canonRepo && !this.isTourEndedBuffered(s),
      );
    }
    if (!session) return;

    const targetStep =
      session.steps.find((s) => s.id === response.stepId) ??
      session.steps[session.steps.length - 1];
    const stepNumber = targetStep?.stepNumber ?? session.steps.length;

    const isEnding = response.action === "stop" || response.action === "finish";
    const hadWaiter = Boolean(session.waiter);

    if (session.waiter) {
      const w = session.waiter;
      session.waiter = null;
      if (w.timer) clearTimeout(w.timer);
      w.resolve({
        status: "responded",
        sessionId: session.sessionId,
        stepId: response.stepId,
        stepNumber,
        action: response.action,
        message: response.message,
      });
    } else {
      session.bufferedResponse = response;
    }

    if (isEnding) {
      session.awaitingUser = false;
      session.agentThinking = false;
      if (hadWaiter) {
        this.sessions.delete(session.sessionId);
      }
      this.broadcastRepoWalkthroughs(canonRepo);
    } else {
      session.awaitingUser = false;
      session.agentThinking = true;
      this.broadcastRepoWalkthroughs(canonRepo);
    }
  }

  endFromUser(repoCommonDir: string, sessionId?: string): void {
    const canonRepo = this.canonPath(repoCommonDir);
    const session = sessionId
      ? this.sessions.get(sessionId)
      : Array.from(this.sessions.values()).find(
          (s) => s.repoCommonDir === canonRepo && !this.isTourEndedBuffered(s),
        );
    if (!session || session.repoCommonDir !== canonRepo) return;
    this.respondFromUser(canonRepo, {
      sessionId: session.sessionId,
      worktreePath: session.worktreePath,
      stepId: session.activeStepId,
      action: "stop",
    });
  }

  getReviewStates(repoCommonDir: string): ReviewSessionState[] {
    const canonRepo = this.canonPath(repoCommonDir);
    const out: ReviewSessionState[] = [];
    for (const session of this.reviewSessions.values()) {
      if (session.repoCommonDir === canonRepo && !this.isReviewEndedBuffered(session)) {
        out.push(this.toPublicReviewState(session));
      }
    }
    return out;
  }

  getReviewState(
    repoCommonDir: string,
    worktreePath?: string,
    sessionId?: string,
  ): ReviewSessionState | null {
    const canonRepo = this.canonPath(repoCommonDir);
    if (sessionId) {
      const s = this.reviewSessions.get(sessionId);
      if (s && s.repoCommonDir === canonRepo && !this.isReviewEndedBuffered(s)) {
        return this.toPublicReviewState(s);
      }
      return null;
    }
    const states = this.getReviewStates(canonRepo);
    if (worktreePath) {
      const canonWt = this.canonPath(worktreePath);
      const matching = states.filter((s) => s.worktreePath === canonWt);
      return matching.find((s) => s.awaitingUser) ?? matching[0] ?? null;
    }
    return states.find((s) => s.awaitingUser) ?? states[0] ?? null;
  }

  respondReviewFromUser(
    repoCommonDir: string,
    payload: {
      sessionId?: string;
      worktreePath?: string;
      action: ReviewUserAction;
      markdown?: string;
      count: number;
    },
  ): boolean {
    const canonRepo = this.canonPath(repoCommonDir);
    let session: RepoReviewSession | undefined;

    if (payload.sessionId) {
      const candidate = this.reviewSessions.get(payload.sessionId);
      if (candidate && candidate.repoCommonDir === canonRepo && !this.isReviewEndedBuffered(candidate)) {
        session = candidate;
      }
    } else if (payload.worktreePath) {
      const canonWt = this.canonPath(payload.worktreePath);
      const matching = Array.from(this.reviewSessions.values()).filter(
        (s) => s.repoCommonDir === canonRepo && s.worktreePath === canonWt && !this.isReviewEndedBuffered(s),
      );
      // Strictly scoped to this worktree — never leak feedback to an agent on a different worktree!
      session = matching.find((s) => s.awaitingUser) ?? matching[0];
    } else {
      const active = Array.from(this.reviewSessions.values()).filter(
        (s) => s.repoCommonDir === canonRepo && !this.isReviewEndedBuffered(s),
      );
      session = active.find((s) => s.awaitingUser) ?? active[0];
    }

    if (!session) return false;

    const nextRound = payload.action === "feedback" ? session.round + 1 : session.round;
    session.round = nextRound;
    session.updatedAt = Date.now();

    const result: ReviewWaitRpcResult = {
      status: "responded",
      sessionId: session.sessionId,
      round: nextRound,
      action: payload.action,
      count: payload.count,
      markdown: payload.markdown,
    };

    const hadWaiter = Boolean(session.waiter);
    if (session.waiter) {
      const w = session.waiter;
      session.waiter = null;
      if (w.timer) clearTimeout(w.timer);
      w.resolve(result);
    } else {
      session.bufferedResponse = {
        action: payload.action,
        round: nextRound,
        count: payload.count,
        markdown: payload.markdown,
      };
    }

    if (payload.action === "approve" || payload.action === "cancel") {
      session.awaitingUser = false;
      session.agentWorking = false;
      if (hadWaiter) {
        this.reviewSessions.delete(session.sessionId);
      }
      this.broadcastRepoReviews(canonRepo);
    } else {
      session.awaitingUser = false;
      session.agentWorking = true;
      this.broadcastRepoReviews(canonRepo);
    }
    return true;
  }

  private toPublicReviewState(session: RepoReviewSession): ReviewSessionState {
    return {
      sessionId: session.sessionId,
      repoCommonDir: session.repoCommonDir,
      worktreePath: session.worktreePath,
      label: session.label,
      awaitingUser: session.awaitingUser,
      agentWorking: session.agentWorking,
      round: session.round,
      resolveOnSend: session.resolveOnSend,
      updatedAt: session.updatedAt,
    };
  }

  private toPublicState(session: RepoTourSession): WalkthroughState {
    return {
      sessionId: session.sessionId,
      repoCommonDir: session.repoCommonDir,
      worktreePath: session.worktreePath,
      title: session.title,
      totalSteps: session.totalSteps,
      steps: session.steps.slice(),
      activeStepId: session.activeStepId,
      awaitingUser: session.awaitingUser,
      agentThinking: session.agentThinking,
    };
  }

  private verifyToken(candidate: string): boolean {
    if (typeof candidate !== "string") return false;
    const a = Buffer.from(candidate, "utf8");
    const b = Buffer.from(this.secretToken, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  private handleConnection(conn: Socket): void {
    conn.setEncoding("utf8");
    let buffer = "";

    conn.on("data", (chunk: string) => {
      buffer += chunk;
      let newlineIdx = buffer.indexOf("\n");
      while (newlineIdx !== -1) {
        const rawLine = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (rawLine) {
          void this.dispatchLine(conn, rawLine);
        }
        newlineIdx = buffer.indexOf("\n");
      }
    });

    conn.on("error", () => {
      // Ignore client disconnect errors
    });
  }

  private sendResponse(conn: Socket, response: TourRpcResponse): void {
    if (!conn.destroyed && conn.writable) {
      conn.write(`${JSON.stringify(response)}\n`);
    }
  }

  private sweepFileRequests(): void {
    if (this.closed || !existsSync(this.ipcDir)) return;
    let names: string[];
    try {
      names = readdirSync(this.ipcDir);
    } catch {
      return;
    }

    for (const name of names) {
      if (!name.endsWith(".req.json")) continue;
      if (this.inFlightFileReqs.has(name)) continue;
      this.inFlightFileReqs.add(name);
      const reqFilePath = join(this.ipcDir, name);
      void (async () => {
        try {
          const raw = readFileSync(reqFilePath, "utf8");
          rmSync(reqFilePath, { force: true });
          const response = await this.processRawRequest(raw);
          const resBase = name.slice(0, -".req.json".length);
          const tmpResPath = join(this.ipcDir, `${resBase}.res.tmp`);
          const finalResPath = join(this.ipcDir, `${resBase}.res.json`);
          writeFileSync(tmpResPath, `${JSON.stringify(response)}\n`, {
            encoding: "utf8",
            mode: 0o600,
          });
          renameSync(tmpResPath, finalResPath);
        } catch {
          // Ignore malformed/vanished request file
        } finally {
          this.inFlightFileReqs.delete(name);
        }
      })();
    }
  }

  private async dispatchLine(conn: Socket, rawLine: string): Promise<void> {
    const response = await this.processRawRequest(rawLine, conn);
    this.sendResponse(conn, response);
  }

  private async processRawRequest(rawLine: string, conn?: Socket): Promise<TourRpcResponse> {
    let req: TourRpcRequest;
    try {
      req = JSON.parse(rawLine) as TourRpcRequest;
    } catch {
      return { id: "unknown", ok: false, error: "Invalid JSON request." };
    }

    if (!this.verifyToken(req.token)) {
      return { id: req.id ?? "unknown", ok: false, error: "Unauthorized token." };
    }

    try {
      switch (req.method) {
        case "ping": {
          return {
            id: req.id,
            ok: true,
            result: { pid: process.pid },
          };
        }
        case "tour.start": {
          const p = (req.params ?? {}) as unknown as TourStartParams;
          const result = await this.handleStart(p);
          return { id: req.id, ok: true, result };
        }
        case "tour.step": {
          const p = (req.params ?? {}) as unknown as TourStepParams;
          const result = await this.handleStep(p, conn);
          return { id: req.id, ok: true, result };
        }
        case "tour.wait": {
          const p = (req.params ?? {}) as unknown as TourWaitParams;
          const result = await this.handleWait(p, conn);
          return { id: req.id, ok: true, result };
        }
        case "tour.status": {
          const p = (req.params ?? {}) as { cwd?: string; worktree?: string; sessionId?: string };
          const result = await this.handleStatus({
            cwd: String(p.cwd ?? process.cwd()),
            worktree: p.worktree,
            sessionId: p.sessionId,
          });
          return { id: req.id, ok: true, result };
        }
        case "tour.end": {
          const p = (req.params ?? {}) as { cwd?: string; worktree?: string; sessionId?: string };
          const result = await this.handleEnd({
            cwd: String(p.cwd ?? process.cwd()),
            worktree: p.worktree,
            sessionId: p.sessionId,
          });
          return { id: req.id, ok: true, result };
        }
        case "review.wait": {
          const p = (req.params ?? {}) as unknown as ReviewWaitParams;
          const result = await this.handleReviewWait(p, conn);
          return { id: req.id, ok: true, result };
        }
        case "review.status": {
          const p = (req.params ?? {}) as { cwd?: string; worktree?: string; sessionId?: string };
          const result = await this.handleReviewStatus({
            cwd: String(p.cwd ?? process.cwd()),
            worktree: p.worktree,
            sessionId: p.sessionId,
          });
          return { id: req.id, ok: true, result };
        }
        case "review.end": {
          const p = (req.params ?? {}) as { cwd?: string; worktree?: string; sessionId?: string };
          const result = await this.handleReviewEnd({
            cwd: String(p.cwd ?? process.cwd()),
            worktree: p.worktree,
            sessionId: p.sessionId,
          });
          return { id: req.id, ok: true, result };
        }
        default: {
          return {
            id: req.id,
            ok: false,
            error: `Unknown RPC method: ${String((req as { method?: unknown }).method)}`,
          };
        }
      }
    } catch (err) {
      return {
        id: req.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private findTourSession(
    repoCommonDir: string,
    worktreePath: string,
    sessionId?: string,
  ): RepoTourSession | undefined {
    const canonRepo = this.canonPath(repoCommonDir);
    if (sessionId) {
      const exact = this.sessions.get(sessionId);
      return exact && exact.repoCommonDir === canonRepo ? exact : undefined;
    }
    const canonWt = this.canonPath(worktreePath);
    const matches = Array.from(this.sessions.values()).filter(
      (s) => s.repoCommonDir === canonRepo && s.worktreePath === canonWt,
    );
    return matches[matches.length - 1];
  }

  private async handleStart(params: TourStartParams): Promise<{ sessionId: string }> {
    const repoInfo = await this.host.ensureRepoWindow({
      cwd: params.cwd,
      worktree: params.worktree,
      focusWindow: true,
    });
    const canonRepo = this.canonPath(repoInfo.repoCommonDir);
    const canonWt = this.canonPath(repoInfo.worktreePath);
    const existing = this.findTourSession(canonRepo, canonWt, params.sessionId);
    if (existing) {
      if (existing.waiter) {
        if (existing.waiter.timer) clearTimeout(existing.waiter.timer);
        existing.waiter.resolve({
          status: "responded",
          sessionId: existing.sessionId,
          stepId: existing.waiter.stepId,
          stepNumber: existing.waiter.stepNumber,
          action: "stop",
        });
      }
      this.sessions.delete(existing.sessionId);
    }

    const sessionId = params.sessionId?.trim() || randomBytes(8).toString("hex");
    const fresh: RepoTourSession = {
      sessionId,
      repoCommonDir: canonRepo,
      worktreePath: canonWt,
      title: params.title,
      totalSteps: params.totalSteps,
      steps: [],
      activeStepId: "",
      awaitingUser: false,
      agentThinking: true,
      waiter: null,
      bufferedResponse: null,
    };
    this.sessions.set(sessionId, fresh);
    this.broadcastRepoWalkthroughs(canonRepo);
    return { sessionId };
  }

  private async handleStep(params: TourStepParams, conn?: Socket): Promise<TourStepRpcResult> {
    if (!params.title?.trim() && !params.body?.trim()) {
      throw new Error("`ide2 tour step` requires --title and/or a Markdown explanation body.");
    }

    const canonCwd = this.canonPath(params.cwd);
    const hasExistingForCwd = Array.from(this.sessions.values()).some(
      (s) => canonCwd === s.worktreePath || canonCwd.startsWith(`${s.worktreePath}${sep}`),
    );
    const repoInfo = await this.host.ensureRepoWindow({
      cwd: params.cwd,
      worktree: params.worktree,
      focusWindow: !hasExistingForCwd,
    });
    const canonRepo = this.canonPath(repoInfo.repoCommonDir);
    const canonWt = this.canonPath(repoInfo.worktreePath);

    let session = this.findTourSession(canonRepo, canonWt, params.sessionId);
    if (session && this.isTourEndedBuffered(session)) {
      this.sessions.delete(session.sessionId);
      session = undefined;
    }
    if (!session) {
      const sessionId = params.sessionId?.trim() || randomBytes(8).toString("hex");
      session = {
        sessionId,
        repoCommonDir: canonRepo,
        worktreePath: canonWt,
        totalSteps: params.totalSteps,
        steps: [],
        activeStepId: "",
        awaitingUser: false,
        agentThinking: false,
        waiter: null,
        bufferedResponse: null,
      };
      this.sessions.set(sessionId, session);
    }

    // Cancel any previous superseded waiter on this session
    if (session.waiter) {
      const prev = session.waiter;
      session.waiter = null;
      if (prev.timer) clearTimeout(prev.timer);
      prev.resolve({
        status: "responded",
        sessionId: session.sessionId,
        stepId: prev.stepId,
        stepNumber: prev.stepNumber,
        action: "next",
      });
    }

    const resolvedTarget = resolveValidatedTarget(canonWt, params);
    const stepNumber = params.stepNumber ?? session.steps.length + 1;
    const totalSteps = params.totalSteps ?? session.totalSteps;
    if (totalSteps !== undefined) {
      session.totalSteps = totalSteps;
    }

    const stepId = randomBytes(6).toString("hex");
    const step: WalkthroughStep = {
      id: stepId,
      sessionId: session.sessionId,
      worktreePath: canonWt,
      stepNumber,
      totalSteps,
      title: params.title?.trim() || resolvedTarget.targetPath || `Step ${stepNumber}`,
      body: params.body ?? "",
      targetKind: resolvedTarget.targetKind,
      targetPath: resolvedTarget.targetPath,
      folderFiles: resolvedTarget.folderFiles,
      startLine: resolvedTarget.startLine,
      endLine: resolvedTarget.endLine,
      diffScope: resolvedTarget.diffScope,
      markdownMode: params.markdownMode,
      final: params.final,
      createdAt: Date.now(),
    };

    session.worktreePath = canonWt;
    session.steps.push(step);
    session.activeStepId = step.id;
    session.bufferedResponse = null;

    const shouldWait = params.wait !== false;
    session.awaitingUser = shouldWait;
    session.agentThinking = false;

    this.broadcastRepoWalkthroughs(canonRepo);

    if (!shouldWait) {
      return {
        status: "no_wait",
        sessionId: session.sessionId,
        stepId: step.id,
        stepNumber: step.stepNumber,
      };
    }

    return this.attachWaiter(session, step.id, step.stepNumber, params.waitTimeoutMs, conn);
  }

  private async handleWait(params: TourWaitParams, conn?: Socket): Promise<TourStepRpcResult> {
    const repoInfo = await this.host.ensureRepoWindow({
      cwd: params.cwd,
      worktree: params.worktree,
      focusWindow: false,
    });
    const canonRepo = this.canonPath(repoInfo.repoCommonDir);
    const canonWt = this.canonPath(repoInfo.worktreePath);
    const session = this.findTourSession(canonRepo, canonWt, params.sessionId);
    if (!session || session.steps.length === 0) {
      return { status: "idle", sessionId: "" };
    }

    const activeStep =
      session.steps.find((s) => s.id === session.activeStepId) ??
      session.steps[session.steps.length - 1]!;

    if (session.bufferedResponse) {
      const buffered = session.bufferedResponse;
      session.bufferedResponse = null;
      if (buffered.action === "finish" || buffered.action === "stop") {
        this.sessions.delete(session.sessionId);
        this.broadcastRepoWalkthroughs(canonRepo);
      }
      return {
        status: "responded",
        sessionId: session.sessionId,
        stepId: buffered.stepId,
        stepNumber: activeStep.stepNumber,
        action: buffered.action,
        message: buffered.message,
      };
    }

    if (!session.awaitingUser) {
      return {
        status: "idle",
        sessionId: session.sessionId,
        stepId: activeStep.id,
        stepNumber: activeStep.stepNumber,
      };
    }

    return this.attachWaiter(
      session,
      activeStep.id,
      activeStep.stepNumber,
      params.waitTimeoutMs,
      conn,
    );
  }

  private attachWaiter(
    session: RepoTourSession,
    stepId: string,
    stepNumber: number,
    waitTimeoutMs: number | undefined,
    conn?: Socket,
  ): Promise<TourStepRpcResult> {
    const timeoutMs = waitTimeoutMs ?? 90_000;
    return new Promise<TourStepRpcResult>((resolveWait) => {
      const waiter: PendingWaiter = {
        stepId,
        stepNumber,
        resolve: resolveWait,
      };

      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          if (session.waiter === waiter) {
            session.waiter = null;
          }
          resolveWait({
            status: "waiting",
            sessionId: session.sessionId,
            stepId,
            stepNumber,
          });
        }, timeoutMs);
      }

      if (conn) {
        const onClose = () => {
          if (session.waiter === waiter) {
            if (waiter.timer) clearTimeout(waiter.timer);
            session.waiter = null;
          }
        };
        conn.once("close", onClose);
      }

      session.waiter = waiter;
    });
  }

  private async handleStatus(params: {
    cwd: string;
    worktree?: string;
    sessionId?: string;
  }): Promise<{
    active: boolean;
    sessionId?: string;
    worktreePath?: string;
    title?: string;
    stepCount: number;
    activeStepNumber?: number;
    awaitingUser: boolean;
    agentThinking: boolean;
  }> {
    const repoInfo = await this.host.ensureRepoWindow({
      cwd: params.cwd,
      worktree: params.worktree,
      focusWindow: false,
    });
    const canonRepo = this.canonPath(repoInfo.repoCommonDir);
    const canonWt = this.canonPath(repoInfo.worktreePath);
    const session = this.findTourSession(canonRepo, canonWt, params.sessionId);
    if (!session || session.steps.length === 0 || this.isTourEndedBuffered(session)) {
      return {
        active: false,
        stepCount: 0,
        awaitingUser: false,
        agentThinking: false,
      };
    }
    const activeStep =
      session.steps.find((s) => s.id === session.activeStepId) ??
      session.steps[session.steps.length - 1];
    return {
      active: true,
      sessionId: session.sessionId,
      worktreePath: session.worktreePath,
      title: session.title,
      stepCount: session.steps.length,
      activeStepNumber: activeStep?.stepNumber,
      awaitingUser: session.awaitingUser,
      agentThinking: session.agentThinking,
    };
  }

  private async handleEnd(params: {
    cwd: string;
    worktree?: string;
    sessionId?: string;
  }): Promise<{ ended: boolean }> {
    const repoInfo = await this.host.ensureRepoWindow({
      cwd: params.cwd,
      worktree: params.worktree,
      focusWindow: false,
    });
    const canonRepo = this.canonPath(repoInfo.repoCommonDir);
    const canonWt = this.canonPath(repoInfo.worktreePath);
    const session = this.findTourSession(canonRepo, canonWt, params.sessionId);
    if (!session) {
      return { ended: false };
    }
    if (session.waiter) {
      const w = session.waiter;
      session.waiter = null;
      if (w.timer) clearTimeout(w.timer);
      w.resolve({
        status: "responded",
        sessionId: session.sessionId,
        stepId: w.stepId,
        stepNumber: w.stepNumber,
        action: "finish",
      });
    }
    this.sessions.delete(session.sessionId);
    this.broadcastRepoWalkthroughs(canonRepo);
    return { ended: true };
  }

  private async handleReviewWait(
    params: ReviewWaitParams,
    conn?: Socket,
  ): Promise<ReviewWaitRpcResult> {
    const canonCwd = this.canonPath(params.cwd);
    const hasReviewForCwd = Array.from(this.reviewSessions.values()).some(
      (s) => canonCwd === s.worktreePath || canonCwd.startsWith(`${s.worktreePath}${sep}`),
    );
    const repoInfo = await this.host.ensureRepoWindow({
      cwd: params.cwd,
      worktree: params.worktree,
      diff: params.diff,
      focusWindow: !hasReviewForCwd,
    });
    const canonRepo = this.canonPath(repoInfo.repoCommonDir);
    const canonWt = this.canonPath(repoInfo.worktreePath);

    let session: RepoReviewSession | undefined;
    if (params.sessionId) {
      const exact = this.reviewSessions.get(params.sessionId);
      if (exact && exact.repoCommonDir === canonRepo) {
        session = exact;
      }
    } else {
      const wtSessions = Array.from(this.reviewSessions.values()).filter(
        (s) => s.repoCommonDir === canonRepo && s.worktreePath === canonWt,
      );
      // 1. Prefer any session with a buffered click (e.g. Approve/Send right between wait-timeout & resume)
      session = wtSessions.find((s) => s.bufferedResponse !== null);
      // 2. Otherwise reuse a session that is not currently blocked on another live waiter (same agent looping Round 2+)
      if (!session) {
        session = wtSessions.find((s) => s.waiter === null);
      }
      // 3. If ALL existing sessions on this worktree currently have an active waiter, a second simultaneous
      //    agent just connected to the same worktree -> allocate a new distinct session instead of evicting Agent 1!
    }

    if (!session) {
      const sessionId = params.sessionId?.trim() || randomBytes(8).toString("hex");
      session = {
        sessionId,
        repoCommonDir: canonRepo,
        worktreePath: canonWt,
        label: params.label,
        awaitingUser: true,
        agentWorking: false,
        round: 0,
        resolveOnSend: params.resolveOnSend !== false,
        updatedAt: Date.now(),
        waiter: null,
        bufferedResponse: null,
      };
      this.reviewSessions.set(sessionId, session);
    } else {
      if (session.bufferedResponse) {
        const buffered = session.bufferedResponse;
        session.bufferedResponse = null;
        if (buffered.action === "approve" || buffered.action === "cancel") {
          this.reviewSessions.delete(session.sessionId);
          this.broadcastRepoReviews(canonRepo);
        }
        return {
          status: "responded",
          sessionId: session.sessionId,
          round: buffered.round,
          action: buffered.action,
          count: buffered.count,
          markdown: buffered.markdown,
        };
      }

      if (session.waiter) {
        const prev = session.waiter;
        session.waiter = null;
        if (prev.timer) clearTimeout(prev.timer);
        prev.resolve({
          status: "waiting",
          sessionId: session.sessionId,
          round: session.round,
        });
      }

      session.worktreePath = canonWt;
      if (params.label !== undefined) session.label = params.label;
      if (params.resolveOnSend !== undefined) session.resolveOnSend = params.resolveOnSend;
      session.awaitingUser = true;
      session.agentWorking = false;
      session.updatedAt = Date.now();
    }

    this.broadcastRepoReviews(canonRepo);

    const timeoutMs = params.waitTimeoutMs ?? 90_000;
    const activeSession = session;
    return new Promise<ReviewWaitRpcResult>((resolveWait) => {
      const waiter: PendingReviewWaiter = {
        resolve: resolveWait,
      };

      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          if (activeSession.waiter === waiter) {
            activeSession.waiter = null;
          }
          resolveWait({
            status: "waiting",
            sessionId: activeSession.sessionId,
            round: activeSession.round,
          });
        }, timeoutMs);
      }

      if (conn) {
        conn.once("close", () => {
          if (activeSession.waiter === waiter) {
            if (waiter.timer) clearTimeout(waiter.timer);
            activeSession.waiter = null;
          }
        });
      }

      activeSession.waiter = waiter;
    });
  }

  private async handleReviewStatus(params: {
    cwd: string;
    worktree?: string;
    sessionId?: string;
  }): Promise<{
    active: boolean;
    sessionId?: string;
    worktreePath?: string;
    awaitingUser: boolean;
    agentWorking: boolean;
    round: number;
    sessions: ReviewSessionState[];
  }> {
    const repoInfo = await this.host.ensureRepoWindow({
      cwd: params.cwd,
      worktree: params.worktree,
      focusWindow: false,
    });
    const canonRepo = this.canonPath(repoInfo.repoCommonDir);
    const canonWt = this.canonPath(repoInfo.worktreePath);
    const allRepoSessions = this.getReviewStates(canonRepo);
    const matching = params.sessionId
      ? allRepoSessions.filter((s) => s.sessionId === params.sessionId)
      : allRepoSessions.filter((s) => s.worktreePath === canonWt);
    const primary = matching.find((s) => s.awaitingUser) ?? matching[0];
    if (!primary) {
      return {
        active: false,
        awaitingUser: false,
        agentWorking: false,
        round: 0,
        sessions: allRepoSessions,
      };
    }
    return {
      active: true,
      sessionId: primary.sessionId,
      worktreePath: primary.worktreePath,
      awaitingUser: primary.awaitingUser,
      agentWorking: primary.agentWorking,
      round: primary.round,
      sessions: matching,
    };
  }

  private async handleReviewEnd(params: {
    cwd: string;
    worktree?: string;
    sessionId?: string;
  }): Promise<{ ended: boolean }> {
    const repoInfo = await this.host.ensureRepoWindow({
      cwd: params.cwd,
      worktree: params.worktree,
      focusWindow: false,
    });
    const canonRepo = this.canonPath(repoInfo.repoCommonDir);
    const canonWt = this.canonPath(repoInfo.worktreePath);

    const targets = params.sessionId
      ? (() => {
          const exact = this.reviewSessions.get(params.sessionId!);
          return exact && exact.repoCommonDir === canonRepo ? [exact] : [];
        })()
      : Array.from(this.reviewSessions.values()).filter(
          (s) => s.repoCommonDir === canonRepo && s.worktreePath === canonWt,
        );

    if (targets.length === 0) {
      return { ended: false };
    }
    for (const session of targets) {
      if (session.waiter) {
        const w = session.waiter;
        session.waiter = null;
        if (w.timer) clearTimeout(w.timer);
        w.resolve({
          status: "responded",
          sessionId: session.sessionId,
          round: session.round,
          action: "cancel",
        });
      }
      this.reviewSessions.delete(session.sessionId);
    }
    this.broadcastRepoReviews(canonRepo);
    return { ended: true };
  }
}
