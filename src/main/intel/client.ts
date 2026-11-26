import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import type {
  CodeSymbol,
  FindInPathQuery,
  FuzzyFileHit,
  SearchMatch,
  TokenSpan,
} from "../../shared/protocol";
import { coldTonalHighlighter, detectLanguageFromPath } from "./highlight";
import {
  findInPath,
  fuzzyFindFiles,
  type FuzzyFindFilesParams,
  worktreeFileIndex,
} from "./search";
import {
  findDefinitionAndUsages,
  type FindDefinitionAndUsagesParams,
  getStructure,
  searchSymbols,
  type SearchSymbolsParams,
  worktreeSymbolIndex,
} from "./symbols";
import type { IntelWorkerRequest, IntelWorkerResponse } from "./worker";

export interface IntelClientOptions {
  /** Optional path to the compiled `intel/worker` script. When present and existing, offloads `analyzeFile`. */
  workerPath?: string;
}

export interface AnalyzeFileResult {
  worktreePath: string;
  filePath: string;
  contentHash: string;
  tokens: TokenSpan[][];
  symbols: CodeSymbol[];
}

interface PendingRequest {
  resolve: (value: IntelWorkerResponse) => void;
  reject: (err: Error) => void;
}

type IntelWorkerPayload =
  | Omit<Extract<IntelWorkerRequest, { type: "analyzeFile" }>, "id">
  | Omit<Extract<IntelWorkerRequest, { type: "highlight" }>, "id">
  | Omit<Extract<IntelWorkerRequest, { type: "getStructure" }>, "id">;

/**
 * Facade for all code intelligence, syntax highlighting, AST structure, and search operations.
 * Runs cleanly in-process by default (ideal for tests and fast startup) or delegates heavy
 * `analyzeFile` work to a `worker_threads` worker when a bundled `workerPath` exists.
 */
export class IntelClient {
  private readonly workerPath?: string;
  private worker: Worker | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(options: IntelClientOptions = {}) {
    this.workerPath = options.workerPath;
  }

  private getOrSpawnWorker(): Worker | null {
    if (!this.workerPath || !existsSync(this.workerPath)) {
      return null;
    }
    if (this.worker) return this.worker;

    const worker = new Worker(this.workerPath);
    worker.on("message", (msg: IntelWorkerResponse) => {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      entry.resolve(msg);
    });
    worker.on("error", (err: Error) => {
      for (const [, entry] of this.pending) {
        entry.reject(err);
      }
      this.pending.clear();
      this.worker = null;
    });
    worker.on("exit", () => {
      if (this.pending.size > 0) {
        const err = new Error("Intel worker exited unexpectedly");
        for (const [, entry] of this.pending) {
          entry.reject(err);
        }
        this.pending.clear();
      }
      this.worker = null;
    });

    this.worker = worker;
    return worker;
  }

  private callWorker(req: IntelWorkerPayload): Promise<IntelWorkerResponse> {
    const worker = this.getOrSpawnWorker();
    if (!worker) {
      return Promise.reject(new Error("Intel worker not configured"));
    }

    const id = this.nextRequestId++;
    return new Promise<IntelWorkerResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ ...req, id } as IntelWorkerRequest);
    });
  }

  async highlight(
    content: string | readonly string[],
    language: string,
    contentHash?: string,
  ): Promise<TokenSpan[][]> {
    return coldTonalHighlighter.highlightLines(content, language, contentHash);
  }

  async getStructure(
    worktreePath: string,
    filePath: string,
    content?: string,
  ): Promise<CodeSymbol[]> {
    return getStructure(worktreePath, filePath, content, worktreeSymbolIndex);
  }

  async analyzeFile(
    worktreePath: string,
    filePath: string,
    contentHash: string,
    content: string,
    language?: string,
  ): Promise<AnalyzeFileResult> {
    const lang = language ?? detectLanguageFromPath(filePath);
    const worker = this.getOrSpawnWorker();

    if (worker) {
      try {
        const res = await this.callWorker({
          type: "analyzeFile",
          worktreePath,
          filePath,
          contentHash,
          content,
          language: lang,
        });
        if (res.ok && res.tokens && res.symbols) {
          worktreeSymbolIndex.setFileSymbols(worktreePath, filePath, res.symbols);
          return {
            worktreePath,
            filePath,
            contentHash,
            tokens: res.tokens,
            symbols: res.symbols,
          };
        }
      } catch {
        // Fall back to in-process analysis if worker fails
      }
    }

    const [tokens, symbols] = await Promise.all([
      coldTonalHighlighter.highlightLines(content, lang, contentHash),
      getStructure(worktreePath, filePath, content, worktreeSymbolIndex),
    ]);

    return {
      worktreePath,
      filePath,
      contentHash,
      tokens,
      symbols,
    };
  }

  async searchSymbols(params: SearchSymbolsParams): Promise<CodeSymbol[]> {
    return searchSymbols(params, worktreeSymbolIndex);
  }

  async findDefinitionAndUsages(
    params: FindDefinitionAndUsagesParams,
  ): Promise<{ definitions: SearchMatch[]; usages: SearchMatch[] }> {
    return findDefinitionAndUsages(params, worktreeSymbolIndex);
  }

  async fuzzyFindFiles(params: FuzzyFindFilesParams): Promise<FuzzyFileHit[]> {
    return fuzzyFindFiles(params, worktreeFileIndex);
  }

  async findInPath(
    query: FindInPathQuery,
    worktrees?: { path: string; name: string }[],
  ): Promise<SearchMatch[]> {
    return findInPath(query, worktrees);
  }

  invalidateWorktree(worktreePath: string, changedFiles?: string[]): void {
    worktreeFileIndex.invalidate(worktreePath);
    if (changedFiles && changedFiles.length > 0) {
      for (const file of changedFiles) {
        worktreeSymbolIndex.invalidate(worktreePath, file);
      }
    } else {
      worktreeSymbolIndex.invalidate(worktreePath);
    }
  }

  async dispose(): Promise<void> {
    if (this.worker) {
      const w = this.worker;
      this.worker = null;
      this.pending.clear();
      await w.terminate();
    }
  }
}

export const intelClient = new IntelClient();
