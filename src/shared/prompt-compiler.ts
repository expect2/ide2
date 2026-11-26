import type { Annotation, AnnotationIntent, WorktreeInfo } from "./protocol.js";

const INTENT_LABELS: Record<AnnotationIntent, string> = {
  bug: "BUG",
  change: "CHANGE",
  question: "QUESTION",
  keep: "KEEP",
};

const INTENT_ORDER: Record<AnnotationIntent, number> = {
  bug: 0,
  change: 1,
  question: 2,
  keep: 3,
};

export interface CompilePromptInput {
  worktree: Pick<WorktreeInfo, "name" | "path" | "branch" | "baseRef" | "mergeBaseSha" | "headSha">;
  annotations: readonly Annotation[];
  includeOutdated?: boolean;
  intents?: readonly AnnotationIntent[];
}

/**
 * Compiles structured annotations for a worktree into a deterministic, token-efficient
 * Markdown Feedback Prompt ready to paste directly into an external coding agent.
 */
export function compileFeedbackPromptMarkdown(input: CompilePromptInput): {
  markdown: string;
  includedIds: string[];
} {
  const allowedIntents = input.intents ? new Set(input.intents) : null;
  const filtered = input.annotations.filter((a) => {
    if (a.worktreePath !== input.worktree.path) return false;
    if (a.status === "resolved") return false;
    if (a.status === "outdated" && !input.includeOutdated) return false;
    if (allowedIntents && !allowedIntents.has(a.intent)) return false;
    return true;
  });

  if (filtered.length === 0) {
    return { markdown: "", includedIds: [] };
  }

  const generalNotes = filtered.filter((a) => !a.filePath);
  const fileNotes = filtered
    .filter((a) => Boolean(a.filePath))
    .slice()
    .sort((a, b) => {
      const fileCmp = (a.filePath ?? "").localeCompare(b.filePath ?? "");
      if (fileCmp !== 0) return fileCmp;
      const lineCmp = (a.startLine ?? 0) - (b.startLine ?? 0);
      if (lineCmp !== 0) return lineCmp;
      return INTENT_ORDER[a.intent] - INTENT_ORDER[b.intent];
    });

  const lines: string[] = [];
  lines.push(`# Code Review Feedback — \`${input.worktree.name}\``);
  lines.push("");
  lines.push(`- **Worktree:** \`${input.worktree.path}\``);
  const baseDetail =
    input.worktree.baseRef && input.worktree.mergeBaseSha
      ? ` (base: \`${input.worktree.baseRef}\` @ \`${input.worktree.mergeBaseSha.slice(0, 7)}\`)`
      : "";
  lines.push(`- **Branch:** \`${input.worktree.branch}\` @ \`${input.worktree.headSha.slice(0, 7)}\`${baseDetail}`);

  if (generalNotes.length > 0) {
    lines.push("");
    lines.push("## Overall Notes");
    lines.push("");
    for (const note of generalNotes) {
      const prefix = note.intent !== "change" ? `**[${INTENT_LABELS[note.intent]}]** ` : "";
      lines.push(`${prefix}${note.comment.trim()}`);
      lines.push("");
    }
  }

  if (fileNotes.length > 0) {
    lines.push("");
    lines.push("---");
    lines.push("");

    let idx = 1;
    for (const ann of fileNotes) {
      const tag = INTENT_LABELS[ann.intent];
      const lineSuffix = formatLineRange(ann.startLine, ann.endLine);
      const sideNote = ann.side === "old" ? " *(deleted in diff)*" : "";
      const outdatedNote = ann.status === "outdated" ? " *(note: code changed since annotated)*" : "";

      lines.push(`## ${idx}. \`[${tag}]\` \`${ann.filePath}${lineSuffix}\`${sideNote}${outdatedNote}`);

      if (ann.anchor?.selectedText) {
        const snippetLines = ann.anchor.selectedText.split(/\r?\n/);
        const start = ann.startLine ?? 1;
        const padWidth = String(start + snippetLines.length - 1).length;
        if (ann.side === "old") {
          lines.push("```diff");
          for (const rawLine of snippetLines) {
            lines.push(`- ${rawLine}`);
          }
          lines.push("```");
        } else {
          const lang = ann.anchor.language ?? inferFenceLang(ann.filePath ?? "");
          lines.push(`\`\`\`${lang}`);
          snippetLines.forEach((rawLine, offset) => {
            const num = String(start + offset).padStart(padWidth, " ");
            lines.push(`${num} | ${rawLine}`);
          });
          lines.push("```");
        }
      }

      lines.push(ann.comment.trim());
      lines.push("");
      idx += 1;
    }
  }

  return {
    markdown: `${lines.join("\n").trimEnd()}\n`,
    includedIds: [...generalNotes.map((n) => n.id), ...fileNotes.map((n) => n.id)],
  };
}

function formatLineRange(start?: number, end?: number): string {
  if (!start) return "";
  if (!end || end === start) return `:${start}`;
  return `:${start}-${end}`;
}

function inferFenceLang(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "ts",
    tsx: "tsx",
    js: "js",
    jsx: "jsx",
    mjs: "js",
    cjs: "js",
    py: "py",
    rs: "rust",
    go: "go",
    md: "md",
    mdx: "mdx",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    css: "css",
    html: "html",
    sql: "sql",
    swift: "swift",
  };
  return map[ext] ?? ext;
}
