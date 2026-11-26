import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { toPosixPath } from "../../shared/guard.js";
import { compileFeedbackPromptMarkdown } from "../../shared/prompt-compiler.js";
import type {
  Annotation,
  CreateAnnotationInput,
  ExportPromptOptions,
  UpdateAnnotationInput,
  WorktreeInfo,
} from "../../shared/protocol.js";

interface PersistedAnnotationsFile {
  version: 1;
  repoCommonDir: string;
  annotations: Annotation[];
}

function tryRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function scoreContextMatch(
  lines: readonly string[],
  candidateStart1Based: number,
  spanLength: number,
  contextBefore: string,
  contextAfter: string,
  originalStartLine: number,
): number {
  let score = 0;

  if (contextBefore) {
    const beforeExpected = contextBefore.split(/\r?\n/);
    const sliceStart = Math.max(0, candidateStart1Based - 1 - beforeExpected.length);
    const sliceEnd = candidateStart1Based - 1;
    const actualBefore = lines.slice(sliceStart, sliceEnd);
    const minLen = Math.min(beforeExpected.length, actualBefore.length);
    for (let i = 1; i <= minLen; i += 1) {
      if (actualBefore[actualBefore.length - i] === beforeExpected[beforeExpected.length - i]) {
        score += 10;
      } else {
        break;
      }
    }
  }

  if (contextAfter) {
    const afterExpected = contextAfter.split(/\r?\n/);
    const sliceStart = candidateStart1Based - 1 + spanLength;
    const sliceEnd = Math.min(lines.length, sliceStart + afterExpected.length);
    const actualAfter = lines.slice(sliceStart, sliceEnd);
    const minLen = Math.min(afterExpected.length, actualAfter.length);
    for (let i = 0; i < minLen; i += 1) {
      if (actualAfter[i] === afterExpected[i]) {
        score += 10;
      } else {
        break;
      }
    }
  }

  // Prefer closer match when context scores tie
  const distance = Math.abs(candidateStart1Based - originalStartLine);
  return score * 10000 - distance;
}

/**
 * Persistent annotation store scoped to a repository's `repoCommonDir`.
 * Stores annotations outside the repo in `<storageRoot>/workspaces/<sha256>/annotations.json`
 * using atomic tmp+rename writes and supports line-drift re-anchoring.
 */
export class AnnotationStore {
  private readonly repoCommonDir: string;
  private readonly storageFilePath: string;
  private annotations: Annotation[] = [];
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    repoCommonDir: string,
    storageRoot: string = join(homedir(), ".expect2-ide"),
  ) {
    this.repoCommonDir = tryRealpath(repoCommonDir);
    const workspaceHash = createHash("sha256").update(this.repoCommonDir).digest("hex");
    this.storageFilePath = join(storageRoot, "workspaces", workspaceHash, "annotations.json");
  }

  /** Returns the resolved path of the backing JSON file on disk. */
  getStorageFilePath(): string {
    return this.storageFilePath;
  }

  /** Lists annotations, optionally filtered to a specific worktree path. */
  async list(worktreePath?: string): Promise<Annotation[]> {
    await this.ensureLoaded();
    if (!worktreePath) {
      return this.annotations.map((a) => ({ ...a, anchor: a.anchor ? { ...a.anchor } : undefined }));
    }
    const canonWt = tryRealpath(worktreePath);
    return this.annotations
      .filter((a) => a.worktreePath === canonWt)
      .map((a) => ({ ...a, anchor: a.anchor ? { ...a.anchor } : undefined }));
  }

  /** Creates and persists a new annotation. */
  async create(input: CreateAnnotationInput): Promise<Annotation> {
    await this.ensureLoaded();
    const now = new Date().toISOString();
    const canonWt = tryRealpath(input.worktreePath);
    const filePath = input.filePath ? toPosixPath(input.filePath) : undefined;
    const endLine =
      input.startLine !== undefined ? (input.endLine ?? input.startLine) : undefined;

    const annotation: Annotation = {
      id: randomUUID(),
      worktreePath: canonWt,
      filePath,
      side: input.side ?? (filePath ? "new" : undefined),
      startLine: input.startLine,
      endLine,
      comment: input.comment,
      anchor:
        input.selectedText !== undefined || input.contentHash !== undefined
          ? {
              selectedText: input.selectedText ?? "",
              contextBefore: input.contextBefore ?? "",
              contextAfter: input.contextAfter ?? "",
              contentHash: input.contentHash ?? "",
              language: input.language,
            }
          : undefined,
      status: "open",
      createdAt: now,
      updatedAt: now,
    };

    this.annotations.push(annotation);
    await this.persist();
    return { ...annotation, anchor: annotation.anchor ? { ...annotation.anchor } : undefined };
  }

  /** Updates an existing annotation's comment or status. */
  async update(input: UpdateAnnotationInput): Promise<Annotation> {
    await this.ensureLoaded();
    const idx = this.annotations.findIndex((a) => a.id === input.id);
    if (idx === -1) {
      throw new Error(`Annotation not found: ${input.id}`);
    }
    const existing = this.annotations[idx]!;
    const updated: Annotation = {
      ...existing,
      comment: input.comment !== undefined ? input.comment : existing.comment,
      status: input.status !== undefined ? input.status : existing.status,
      updatedAt: new Date().toISOString(),
    };
    this.annotations[idx] = updated;
    await this.persist();
    return { ...updated, anchor: updated.anchor ? { ...updated.anchor } : undefined };
  }

  /** Deletes an annotation by ID. */
  async delete(id: string): Promise<void> {
    await this.ensureLoaded();
    const before = this.annotations.length;
    this.annotations = this.annotations.filter((a) => a.id !== id);
    if (this.annotations.length !== before) {
      await this.persist();
    }
  }

  /**
   * Re-anchors open/outdated annotations on the new side of a file after edits.
   * Shifts `startLine`/`endLine` when `selectedText` moved cleanly, or marks `"outdated"`
   * when the anchored snippet was rewritten or removed.
   */
  async reconcileFile(
    worktreePath: string,
    filePath: string,
    lines: readonly string[],
    contentHash: string,
  ): Promise<Annotation[]> {
    await this.ensureLoaded();
    const canonWt = tryRealpath(worktreePath);
    const normFile = toPosixPath(filePath);
    const now = new Date().toISOString();
    let changed = false;

    for (const ann of this.annotations) {
      if (ann.worktreePath !== canonWt || ann.filePath !== normFile) continue;
      if (ann.side === "old") continue;
      if (ann.status !== "open" && ann.status !== "outdated") continue;
      if (!ann.anchor || !ann.anchor.selectedText || ann.startLine === undefined) continue;

      const startLine = ann.startLine;
      const endLine = ann.endLine ?? startLine;

      // 1. Check exact line range first
      if (startLine >= 1 && endLine <= lines.length) {
        const sliceText = lines.slice(startLine - 1, endLine).join("\n");
        if (sliceText === ann.anchor.selectedText) {
          if (ann.status !== "open" || ann.anchor.contentHash !== contentHash) {
            ann.status = "open";
            ann.anchor.contentHash = contentHash;
            ann.updatedAt = now;
            changed = true;
          }
          continue;
        }
      }

      // 2. Search file lines for multi-line sequence of selectedText
      const needleLines = ann.anchor.selectedText.split(/\r?\n/);
      const span = needleLines.length;
      const candidates: number[] = [];

      if (span > 0 && span <= lines.length) {
        for (let i = 0; i <= lines.length - span; i += 1) {
          let allMatch = true;
          for (let j = 0; j < span; j += 1) {
            if (lines[i + j] !== needleLines[j]) {
              allMatch = false;
              break;
            }
          }
          if (allMatch) {
            candidates.push(i + 1);
          }
        }
      }

      if (candidates.length > 0) {
        let bestStart = candidates[0]!;
        if (candidates.length > 1) {
          let bestScore = -Infinity;
          for (const cand of candidates) {
            const score = scoreContextMatch(
              lines,
              cand,
              span,
              ann.anchor.contextBefore,
              ann.anchor.contextAfter,
              startLine,
            );
            if (score > bestScore) {
              bestScore = score;
              bestStart = cand;
            }
          }
        }

        ann.startLine = bestStart;
        ann.endLine = bestStart + span - 1;
        ann.status = "open";
        ann.anchor.contentHash = contentHash;
        ann.updatedAt = now;
        changed = true;
      } else if (ann.status === "open") {
        // 3. Could not find anchored snippet -> mark outdated
        ann.status = "outdated";
        ann.updatedAt = now;
        changed = true;
      }
    }

    if (changed) {
      await this.persist();
    }

    return this.list(canonWt);
  }

  /**
   * Compiles a deterministic Markdown prompt for a worktree's annotations,
   * optionally marking included annotations as `"resolved"`.
   */
  async compilePrompt(
    worktree: WorktreeInfo,
    options: ExportPromptOptions,
  ): Promise<{ markdown: string; count: number }> {
    await this.ensureLoaded();
    const canonWt = tryRealpath(options.worktreePath);
    const normalizedWorktree: WorktreeInfo =
      worktree.path === canonWt ? worktree : { ...worktree, path: canonWt };

    const { markdown, includedIds } = compileFeedbackPromptMarkdown({
      worktree: normalizedWorktree,
      annotations: this.annotations,
      includeOutdated: options.includeOutdated,
    });

    if (options.resolveAfterExport && includedIds.length > 0) {
      const idSet = new Set(includedIds);
      const now = new Date().toISOString();
      for (const ann of this.annotations) {
        if (idSet.has(ann.id)) {
          ann.status = "resolved";
          ann.updatedAt = now;
        }
      }
      await this.persist();
    }

    return { markdown, count: includedIds.length };
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (existsSync(this.storageFilePath)) {
      try {
        const raw = await readFile(this.storageFilePath, "utf8");
        const parsed = JSON.parse(raw) as Partial<PersistedAnnotationsFile>;
        if (Array.isArray(parsed.annotations)) {
          this.annotations = parsed.annotations;
        }
      } catch {
        this.annotations = [];
      }
    }
    this.loaded = true;
  }

  private persist(): Promise<void> {
    const payload: PersistedAnnotationsFile = {
      version: 1,
      repoCommonDir: this.repoCommonDir,
      annotations: this.annotations,
    };
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;

    const task = this.writeQueue.then(async () => {
      const dir = dirname(this.storageFilePath);
      await mkdir(dir, { recursive: true });
      const tmpPath = `${this.storageFilePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(tmpPath, serialized, "utf8");
      await rename(tmpPath, this.storageFilePath);
    });

    this.writeQueue = task.catch(() => {});
    return task;
  }
}
