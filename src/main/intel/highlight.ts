import { extname } from "node:path";
import type { BundledLanguage, Highlighter, ThemeRegistration } from "shiki";
import type { TokenSpan } from "../../shared/protocol";

export type TokenClass = TokenSpan["cls"];

/**
 * Cold-tonal Retrofuture Night palette — strictly ice-blues, slate, cyan, and indigo.
 * Never uses green, red, or yellow hues.
 */
export const COLD_TONAL_COLORS: Record<TokenClass, string> = {
  id: "#cbd5e1",
  decl: "#7dd3fc",
  kw: "#818cf8",
  type: "#67e8f9",
  lit: "#a5b4fc",
  comment: "#64748b",
  punct: "#94a3b8",
};

export const EXPECT2_RETROFUTURE_NIGHT_THEME: ThemeRegistration = {
  name: "expect2-retrofuture-night",
  type: "dark",
  colors: {
    "editor.background": "#090d14",
    "editor.foreground": COLD_TONAL_COLORS.id,
  },
  tokenColors: [
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: COLD_TONAL_COLORS.comment } },
    { scope: ["keyword.operator", "punctuation", "meta.brace"], settings: { foreground: COLD_TONAL_COLORS.punct } },
    { scope: ["keyword", "storage", "modifier"], settings: { foreground: COLD_TONAL_COLORS.kw } },
    {
      scope: ["entity.name.function", "entity.name.class", "meta.definition"],
      settings: { foreground: COLD_TONAL_COLORS.decl },
    },
    { scope: ["entity.name.type", "support.type", "support.class"], settings: { foreground: COLD_TONAL_COLORS.type } },
    { scope: ["string", "constant", "variable.language"], settings: { foreground: COLD_TONAL_COLORS.lit } },
  ],
};

const MAX_SHIKI_LINES = 4000;
const LRU_CACHE_CAPACITY = 120;

const LANGUAGE_ALIASES: Record<string, BundledLanguage> = {
  ts: "ts",
  tsx: "tsx",
  typescript: "ts",
  mts: "ts",
  cts: "ts",
  js: "js",
  jsx: "jsx",
  javascript: "js",
  mjs: "js",
  cjs: "js",
  json: "json",
  jsonc: "jsonc",
  py: "python",
  python: "python",
  rs: "rust",
  rust: "rust",
  go: "go",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  shell: "shellscript",
  shellscript: "shellscript",
  css: "css",
  scss: "scss",
  html: "html",
  htm: "html",
  md: "markdown",
  markdown: "markdown",
  mdx: "mdx",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sql: "sql",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  java: "java",
  xml: "xml",
  svg: "xml",
  dockerfile: "dockerfile",
  graphql: "graphql",
  gql: "graphql",
};

/**
 * Infers a normalized language key from a file path.
 */
export function detectLanguageFromPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  const base = lower.split("/").pop() ?? lower;
  if (base === "dockerfile") return "dockerfile";
  const ext = extname(base).slice(1);
  return ext || "text";
}

function resolveShikiLanguage(language: string): BundledLanguage | undefined {
  const normalized = language.trim().toLowerCase();
  return LANGUAGE_ALIASES[normalized];
}

function hasScopePrefix(scope: string, prefix: string): boolean {
  return scope === prefix || scope.startsWith(`${prefix}.`);
}

/**
 * Maps TextMate scopes strictly to `TokenSpan["cls"]` using the Retrofuture Night cold-tonal taxonomy.
 */
export function mapScopesToClass(scopes: readonly string[]): TokenClass {
  // 1. Comments always win over nested punctuation/tags inside comments
  for (const scope of scopes) {
    if (hasScopePrefix(scope, "comment")) {
      return "comment";
    }
  }

  // 2. Inspect innermost-to-outermost for fine-grained token classification
  for (let i = scopes.length - 1; i >= 0; i--) {
    const scope = scopes[i]!;
    if (
      hasScopePrefix(scope, "keyword.operator") ||
      hasScopePrefix(scope, "punctuation") ||
      hasScopePrefix(scope, "meta.brace")
    ) {
      return "punct";
    }
    if (
      hasScopePrefix(scope, "entity.name.function") ||
      hasScopePrefix(scope, "entity.name.class")
    ) {
      return "decl";
    }
    if (
      hasScopePrefix(scope, "entity.name.type") ||
      hasScopePrefix(scope, "support.type") ||
      hasScopePrefix(scope, "support.class")
    ) {
      return "type";
    }
    if (
      hasScopePrefix(scope, "keyword") ||
      hasScopePrefix(scope, "storage") ||
      hasScopePrefix(scope, "modifier")
    ) {
      return "kw";
    }
    if (
      hasScopePrefix(scope, "string") ||
      hasScopePrefix(scope, "constant") ||
      hasScopePrefix(scope, "variable.language")
    ) {
      return "lit";
    }
    if (hasScopePrefix(scope, "meta.definition")) {
      return "decl";
    }
  }

  return "id";
}

function mergeAdjacentSpans(spans: TokenSpan[]): TokenSpan[] {
  if (spans.length <= 1) return spans;
  const merged: TokenSpan[] = [];
  for (const span of spans) {
    if (span.text.length === 0) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.cls === span.cls) {
      prev.text += span.text;
    } else {
      merged.push({ text: span.text, cls: span.cls });
    }
  }
  return merged;
}

const FALLBACK_KEYWORDS = new Set([
  "async", "await", "break", "case", "catch", "class", "const", "continue",
  "def", "default", "delete", "do", "else", "enum", "export", "extends",
  "finally", "fn", "for", "from", "func", "function", "if", "impl", "import",
  "in", "interface", "let", "match", "mod", "new", "of", "package", "private",
  "protected", "pub", "public", "raise", "readonly", "return", "static",
  "struct", "switch", "throw", "trait", "try", "type", "typeof", "use",
  "var", "void", "while", "with", "yield",
]);

const FALLBACK_LITERALS = new Set([
  "true", "false", "null", "undefined", "None", "True", "False", "self", "this", "super",
]);

const FALLBACK_TOKEN_RE =
  /\/\/.*$|#.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|\b[A-Za-z_$][A-Za-z0-9_$]*\b|[()[\]{}.,:;?!+\-*/%=&|^~<>]+|\s+/g;

/**
 * Fast O(n) single-pass lexical fallback for unknown languages or files exceeding 4,000 lines.
 */
export function lexFallbackLines(lines: readonly string[]): TokenSpan[][] {
  const result: TokenSpan[][] = new Array(lines.length);

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!;
    if (line.length === 0) {
      result[lineIdx] = [];
      continue;
    }

    const spans: TokenSpan[] = [];
    FALLBACK_TOKEN_RE.lastIndex = 0;
    let lastEnd = 0;
    let prevWord = "";
    let m: RegExpExecArray | null;

    while ((m = FALLBACK_TOKEN_RE.exec(line)) !== null) {
      if (m.index > lastEnd) {
        spans.push({ text: line.slice(lastEnd, m.index), cls: "id" });
      }
      const token = m[0];
      lastEnd = m.index + token.length;

      let cls: TokenClass = "id";
      const ch = token[0]!;
      if (token.startsWith("//") || token.startsWith("#")) {
        cls = "comment";
      } else if (ch === '"' || ch === "'" || ch === "`" || (ch >= "0" && ch <= "9")) {
        cls = "lit";
      } else if (/^\s+$/.test(token)) {
        cls = "id";
      } else if (/^[()[\]{}.,:;?!+\-*/%=&|^~<>]+$/.test(token)) {
        cls = "punct";
      } else if (FALLBACK_KEYWORDS.has(token)) {
        cls = "kw";
      } else if (FALLBACK_LITERALS.has(token)) {
        cls = "lit";
      } else if (
        prevWord === "function" ||
        prevWord === "class" ||
        prevWord === "def" ||
        prevWord === "fn" ||
        prevWord === "func"
      ) {
        cls = "decl";
      } else if (
        prevWord === "interface" ||
        prevWord === "type" ||
        prevWord === "struct" ||
        /^[A-Z][A-Za-z0-9_]*$/.test(token)
      ) {
        cls = "type";
      }

      if (!/^\s+$/.test(token)) {
        prevWord = token;
      }
      spans.push({ text: token, cls });
    }

    if (lastEnd < line.length) {
      spans.push({ text: line.slice(lastEnd), cls: "id" });
    }

    result[lineIdx] = mergeAdjacentSpans(spans);
  }

  return result;
}

class LruTokenCache {
  private readonly map = new Map<string, TokenSpan[][]>();
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  get(key: string): TokenSpan[][] | undefined {
    const val = this.map.get(key);
    if (!val) return undefined;
    this.map.delete(key);
    this.map.set(key, val);
    return val;
  }

  set(key: string, value: TokenSpan[][]): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey);
      }
    }
    this.map.set(key, value);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

export class ColdTonalHighlighter {
  private highlighterPromise: Promise<Highlighter | null> | null = null;
  private readonly loadedLangs = new Set<string>();
  private readonly loadingLangs = new Map<string, Promise<boolean>>();
  private readonly cache = new LruTokenCache(LRU_CACHE_CAPACITY);

  private getHighlighter(): Promise<Highlighter | null> {
    if (!this.highlighterPromise) {
      this.highlighterPromise = (async () => {
        try {
          const [{ createHighlighter }, { createJavaScriptRegexEngine }] = await Promise.all([
            import("shiki"),
            import("shiki/engine/javascript"),
          ]);
          return await createHighlighter({
            themes: [EXPECT2_RETROFUTURE_NIGHT_THEME],
            langs: [],
            engine: createJavaScriptRegexEngine({ forgiving: true }),
          });
        } catch {
          return null;
        }
      })();
    }
    return this.highlighterPromise;
  }

  private async ensureLanguageLoaded(highlighter: Highlighter, lang: BundledLanguage): Promise<boolean> {
    if (this.loadedLangs.has(lang)) return true;
    const inflight = this.loadingLangs.get(lang);
    if (inflight) return inflight;

    const promise = highlighter
      .loadLanguage(lang)
      .then(() => {
        this.loadedLangs.add(lang);
        return true;
      })
      .catch(() => false)
      .finally(() => {
        this.loadingLangs.delete(lang);
      });

    this.loadingLangs.set(lang, promise);
    return promise;
  }

  clearCache(): void {
    this.cache.clear();
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  async highlightLines(
    content: string | readonly string[],
    language: string,
    contentHash?: string,
  ): Promise<TokenSpan[][]> {
    const normalizedLang = language.trim().toLowerCase() || "text";
    const cacheKey = contentHash ? `${normalizedLang}:${contentHash}` : undefined;

    if (cacheKey) {
      const cached = this.cache.get(cacheKey);
      if (cached) return cached;
    }

    const lines = typeof content === "string" ? content.split(/\r?\n/) : [...content];
    const shikiLang = resolveShikiLanguage(normalizedLang);

    if (!shikiLang || lines.length > MAX_SHIKI_LINES) {
      const fallback = lexFallbackLines(lines);
      if (cacheKey) this.cache.set(cacheKey, fallback);
      return fallback;
    }

    const highlighter = await this.getHighlighter();
    if (!highlighter) {
      const fallback = lexFallbackLines(lines);
      if (cacheKey) this.cache.set(cacheKey, fallback);
      return fallback;
    }
    const ready = await this.ensureLanguageLoaded(highlighter, shikiLang);
    if (!ready) {
      const fallback = lexFallbackLines(lines);
      if (cacheKey) this.cache.set(cacheKey, fallback);
      return fallback;
    }

    const sourceText = typeof content === "string" ? content : lines.join("\n");
    const result = highlighter.codeToTokens(sourceText, {
      lang: shikiLang,
      theme: EXPECT2_RETROFUTURE_NIGHT_THEME.name!,
      includeExplanation: "scopeName",
    });

    const tokenLines: TokenSpan[][] = result.tokens.map((lineTokens) => {
      const spans: TokenSpan[] = [];
      for (const tok of lineTokens) {
        const explanationScopes =
          tok.explanation?.flatMap((exp) => exp.scopes.map((s) => s.scopeName)) ?? [];
        const cls = mapScopesToClass(explanationScopes);
        spans.push({ text: tok.content, cls });
      }
      return mergeAdjacentSpans(spans);
    });

    if (cacheKey) {
      this.cache.set(cacheKey, tokenLines);
    }
    return tokenLines;
  }
}

export const coldTonalHighlighter = new ColdTonalHighlighter();

export async function highlightLines(
  content: string | readonly string[],
  language: string,
  contentHash?: string,
): Promise<TokenSpan[][]> {
  return coldTonalHighlighter.highlightLines(content, language, contentHash);
}
