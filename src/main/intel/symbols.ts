import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, extname, join } from "node:path";
import uFuzzy from "@leeoniya/ufuzzy";
import type Parser from "web-tree-sitter";
import { insideWorktree, toPosixPath } from "../../shared/guard";
import type { CodeSymbol, SearchMatch, SymbolKind } from "../../shared/protocol";
import { findInPath, worktreeFileIndex } from "./search";

const require = createRequire(import.meta.url);

type TreeSitterLangId = "typescript" | "tsx" | "javascript" | "python" | "rust" | "go";

const EXT_TO_TS_LANG: Record<string, TreeSitterLangId> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".rs": "rust",
  ".go": "go",
};

const MARKDOWN_EXTS = new Set([".md", ".markdown", ".mdx"]);
const MAX_SYMBOL_INDEX_BYTES = 512 * 1024;
const DEFAULT_SYMBOL_SEARCH_LIMIT = 100;

const ufSymbol = new uFuzzy({
  intraMode: 1,
  intraIns: 1,
  intraSub: 1,
  intraTrn: 1,
  intraDel: 1,
});

function unpackAsarPath(p: string): string {
  return p.replace(/app\.asar([/\\])/g, "app.asar.unpacked$1");
}

function getTreeSitterRuntimeWasmPath(): string {
  return unpackAsarPath(require.resolve("web-tree-sitter/tree-sitter.wasm"));
}

function getTreeSitterWasmsOutDir(): string {
  const pkgJsonPath = unpackAsarPath(require.resolve("tree-sitter-wasms/package.json"));
  return join(dirname(pkgJsonPath), "out");
}

type ParserConstructor = typeof Parser;

async function loadParserModule(): Promise<ParserConstructor> {
  const mod = (await import("web-tree-sitter")) as unknown as {
    default?: ParserConstructor;
    Parser?: ParserConstructor;
  } & ParserConstructor;
  return mod.default ?? mod.Parser ?? mod;
}

let parserInitPromise: Promise<void> | null = null;
const loadedLanguages = new Map<TreeSitterLangId, Parser.Language>();
const loadingLanguages = new Map<TreeSitterLangId, Promise<Parser.Language | null>>();

async function ensureParserReady(): Promise<ParserConstructor> {
  const initial = await loadParserModule();
  if (!parserInitPromise) {
    const runtimeWasm = getTreeSitterRuntimeWasmPath();
    parserInitPromise = initial.init({
      locateFile: () => runtimeWasm,
    });
  }
  await parserInitPromise;
  return loadParserModule();
}

async function getLanguageGrammar(langId: TreeSitterLangId): Promise<Parser.Language | null> {
  const cached = loadedLanguages.get(langId);
  if (cached) return cached;

  const inflight = loadingLanguages.get(langId);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const ParserClass = await ensureParserReady();
      const wasmPath = join(getTreeSitterWasmsOutDir(), `tree-sitter-${langId}.wasm`);
      const lang = await ParserClass.Language.load(wasmPath);
      loadedLanguages.set(langId, lang);
      return lang;
    } catch {
      return null;
    } finally {
      loadingLanguages.delete(langId);
    }
  })();

  loadingLanguages.set(langId, promise);
  return promise;
}

/**
 * Extracts a hierarchical Markdown ATX heading outline (`#`..`######`),
 * ignoring `#` lines inside fenced code blocks (`` ``` `` or `~~~`).
 */
export function extractMarkdownHeadings(
  worktreePath: string,
  filePath: string,
  content: string,
): CodeSymbol[] {
  const lines = content.split(/\r?\n/);
  const roots: CodeSymbol[] = [];
  const stack: { level: number; symbol: CodeSymbol }[] = [];

  let fenceChar: "`" | "~" | null = null;
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trimStart();

    const fenceMatch = /^(```+|~~~+)/.exec(trimmed);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      const markerChar = marker[0] as "`" | "~";
      if (!fenceChar) {
        fenceChar = markerChar;
        fenceLen = marker.length;
        continue;
      }
      if (fenceChar === markerChar && marker.length >= fenceLen && trimmed.slice(marker.length).trim() === "") {
        fenceChar = null;
        fenceLen = 0;
        continue;
      }
    }

    if (fenceChar) continue;

    const headingMatch = /^(#{1,6})\s+(.+?)\s*(?:#+\s*)?$/.exec(trimmed);
    if (!headingMatch) continue;

    const level = headingMatch[1]!.length;
    const title = headingMatch[2]!.trim();
    const lineNumber = i + 1;

    while (stack.length > 0 && stack[stack.length - 1]!.level >= level) {
      const popped = stack.pop()!;
      popped.symbol.endLine = Math.max(popped.symbol.startLine, lineNumber - 1);
    }

    const sym: CodeSymbol = {
      name: title,
      kind: "heading",
      filePath,
      worktreePath,
      startLine: lineNumber,
      endLine: lines.length,
      detail: `H${level}`,
    };

    const parent = stack[stack.length - 1];
    if (parent) {
      if (!parent.symbol.children) parent.symbol.children = [];
      parent.symbol.children.push(sym);
    } else {
      roots.push(sym);
    }

    stack.push({ level, symbol: sym });
  }

  while (stack.length > 0) {
    const popped = stack.pop()!;
    popped.symbol.endLine = Math.max(popped.symbol.startLine, lines.length);
  }

  return roots;
}

function makeSymbol(
  worktreePath: string,
  filePath: string,
  name: string,
  kind: SymbolKind,
  node: Parser.SyntaxNode,
  detail?: string,
  children?: CodeSymbol[],
): CodeSymbol {
  const sym: CodeSymbol = {
    name,
    kind,
    filePath,
    worktreePath,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
  if (detail) sym.detail = detail;
  if (children && children.length > 0) sym.children = children;
  return sym;
}

function getFieldText(node: Parser.SyntaxNode, fieldName: string): string | undefined {
  const child = node.childForFieldName(fieldName);
  return child ? child.text : undefined;
}

function extractTsJsSymbols(
  worktreePath: string,
  filePath: string,
  node: Parser.SyntaxNode,
  insideClass = false,
): CodeSymbol[] {
  const out: CodeSymbol[] = [];

  for (const child of node.namedChildren) {
    const unwrapped =
      child.type === "export_statement"
        ? child.namedChildren.find((c) => c.type !== "decorator") ?? child
        : child;

    switch (unwrapped.type) {
      case "function_declaration":
      case "generator_function_declaration": {
        const name = getFieldText(unwrapped, "name");
        if (name) {
          out.push(makeSymbol(worktreePath, filePath, name, "function", unwrapped));
        }
        break;
      }
      case "class_declaration":
      case "abstract_class_declaration": {
        const name = getFieldText(unwrapped, "name");
        const body = unwrapped.childForFieldName("body");
        const children = body ? extractTsJsSymbols(worktreePath, filePath, body, true) : undefined;
        if (name) {
          out.push(makeSymbol(worktreePath, filePath, name, "class", unwrapped, undefined, children));
        }
        break;
      }
      case "interface_declaration": {
        const name = getFieldText(unwrapped, "name");
        const body = unwrapped.childForFieldName("body");
        const children = body ? extractTsJsSymbols(worktreePath, filePath, body, true) : undefined;
        if (name) {
          out.push(makeSymbol(worktreePath, filePath, name, "interface", unwrapped, undefined, children));
        }
        break;
      }
      case "type_alias_declaration": {
        const name = getFieldText(unwrapped, "name");
        if (name) {
          out.push(makeSymbol(worktreePath, filePath, name, "type", unwrapped));
        }
        break;
      }
      case "enum_declaration": {
        const name = getFieldText(unwrapped, "name");
        if (name) {
          out.push(makeSymbol(worktreePath, filePath, name, "enum", unwrapped));
        }
        break;
      }
      case "method_definition":
      case "method_signature":
      case "abstract_method_signature": {
        const name = getFieldText(unwrapped, "name");
        if (name) {
          out.push(makeSymbol(worktreePath, filePath, name, "method", unwrapped));
        }
        break;
      }
      case "public_field_definition":
      case "field_definition":
      case "property_signature": {
        if (insideClass) {
          const name = getFieldText(unwrapped, "name");
          if (name) {
            out.push(makeSymbol(worktreePath, filePath, name, "property", unwrapped));
          }
        }
        break;
      }
      case "lexical_declaration":
      case "variable_declaration": {
        if (!insideClass) {
          const isConst = unwrapped.text.trimStart().startsWith("const ");
          for (const decl of unwrapped.namedChildren) {
            if (decl.type !== "variable_declarator") continue;
            const nameNode = decl.childForFieldName("name");
            const valNode = decl.childForFieldName("value");
            if (!nameNode || nameNode.type !== "identifier") continue;
            const isFunc =
              valNode?.type === "arrow_function" ||
              valNode?.type === "function_expression" ||
              valNode?.type === "function";
            out.push(
              makeSymbol(
                worktreePath,
                filePath,
                nameNode.text,
                isFunc ? "function" : isConst ? "const" : "variable",
                decl,
              ),
            );
          }
        }
        break;
      }
      case "module":
      case "internal_module": {
        const name = getFieldText(unwrapped, "name");
        const body = unwrapped.childForFieldName("body");
        const children = body ? extractTsJsSymbols(worktreePath, filePath, body, false) : undefined;
        if (name) {
          out.push(makeSymbol(worktreePath, filePath, name, "module", unwrapped, undefined, children));
        }
        break;
      }
      case "class_body":
      case "interface_body":
      case "object_type":
      case "statement_block": {
        out.push(...extractTsJsSymbols(worktreePath, filePath, unwrapped, insideClass));
        break;
      }
      default:
        break;
    }
  }

  return out;
}

function extractPythonSymbols(
  worktreePath: string,
  filePath: string,
  node: Parser.SyntaxNode,
  insideClass = false,
): CodeSymbol[] {
  const out: CodeSymbol[] = [];

  for (const child of node.namedChildren) {
    const target =
      child.type === "decorated_definition"
        ? child.childForFieldName("definition") ?? child
        : child;

    if (target.type === "function_definition") {
      const name = getFieldText(target, "name");
      if (name) {
        out.push(
          makeSymbol(
            worktreePath,
            filePath,
            name,
            insideClass ? "method" : "function",
            target,
          ),
        );
      }
    } else if (target.type === "class_definition") {
      const name = getFieldText(target, "name");
      const body = target.childForFieldName("body");
      const children = body ? extractPythonSymbols(worktreePath, filePath, body, true) : undefined;
      if (name) {
        out.push(makeSymbol(worktreePath, filePath, name, "class", target, undefined, children));
      }
    } else if (target.type === "expression_statement" && !insideClass) {
      const assign = target.namedChildren[0];
      if (assign?.type === "assignment") {
        const left = assign.childForFieldName("left");
        if (left?.type === "identifier") {
          const isConst = /^[A-Z_][A-Z0-9_]*$/.test(left.text);
          out.push(
            makeSymbol(worktreePath, filePath, left.text, isConst ? "const" : "variable", assign),
          );
        }
      }
    }
  }

  return out;
}

function extractRustSymbols(
  worktreePath: string,
  filePath: string,
  node: Parser.SyntaxNode,
  insideContainer = false,
): CodeSymbol[] {
  const out: CodeSymbol[] = [];

  for (const child of node.namedChildren) {
    switch (child.type) {
      case "function_item":
      case "function_signature_item": {
        const name = getFieldText(child, "name");
        if (name) {
          out.push(
            makeSymbol(
              worktreePath,
              filePath,
              name,
              insideContainer ? "method" : "function",
              child,
            ),
          );
        }
        break;
      }
      case "struct_item": {
        const name = getFieldText(child, "name");
        if (name) out.push(makeSymbol(worktreePath, filePath, name, "class", child, "struct"));
        break;
      }
      case "enum_item": {
        const name = getFieldText(child, "name");
        if (name) out.push(makeSymbol(worktreePath, filePath, name, "enum", child));
        break;
      }
      case "trait_item": {
        const name = getFieldText(child, "name");
        const body = child.childForFieldName("body");
        const children = body ? extractRustSymbols(worktreePath, filePath, body, true) : undefined;
        if (name) {
          out.push(makeSymbol(worktreePath, filePath, name, "interface", child, "trait", children));
        }
        break;
      }
      case "impl_item": {
        const typeNode = child.childForFieldName("type");
        const body = child.childForFieldName("body");
        const children = body ? extractRustSymbols(worktreePath, filePath, body, true) : undefined;
        if (typeNode) {
          out.push(makeSymbol(worktreePath, filePath, typeNode.text, "module", child, "impl", children));
        }
        break;
      }
      case "type_item": {
        const name = getFieldText(child, "name");
        if (name) out.push(makeSymbol(worktreePath, filePath, name, "type", child));
        break;
      }
      case "const_item": {
        const name = getFieldText(child, "name");
        if (name) out.push(makeSymbol(worktreePath, filePath, name, "const", child));
        break;
      }
      case "mod_item": {
        const name = getFieldText(child, "name");
        const body = child.childForFieldName("body");
        const children = body ? extractRustSymbols(worktreePath, filePath, body, false) : undefined;
        if (name) out.push(makeSymbol(worktreePath, filePath, name, "module", child, undefined, children));
        break;
      }
      default:
        break;
    }
  }

  return out;
}

function extractGoSymbols(
  worktreePath: string,
  filePath: string,
  node: Parser.SyntaxNode,
): CodeSymbol[] {
  const out: CodeSymbol[] = [];

  for (const child of node.namedChildren) {
    if (child.type === "function_declaration") {
      const name = getFieldText(child, "name");
      if (name) out.push(makeSymbol(worktreePath, filePath, name, "function", child));
    } else if (child.type === "method_declaration") {
      const name = getFieldText(child, "name");
      if (name) out.push(makeSymbol(worktreePath, filePath, name, "method", child));
    } else if (child.type === "type_declaration") {
      for (const spec of child.namedChildren) {
        if (spec.type !== "type_spec") continue;
        const name = getFieldText(spec, "name");
        const typeNode = spec.childForFieldName("type");
        const kind: SymbolKind =
          typeNode?.type === "struct_type"
            ? "class"
            : typeNode?.type === "interface_type"
              ? "interface"
              : "type";
        if (name) out.push(makeSymbol(worktreePath, filePath, name, kind, spec));
      }
    } else if (child.type === "const_declaration") {
      for (const spec of child.namedChildren) {
        if (spec.type !== "const_spec") continue;
        const name = getFieldText(spec, "name");
        if (name) out.push(makeSymbol(worktreePath, filePath, name, "const", spec));
      }
    }
  }

  return out;
}

function extractTreeSitterSymbols(
  langId: TreeSitterLangId,
  worktreePath: string,
  filePath: string,
  root: Parser.SyntaxNode,
): CodeSymbol[] {
  switch (langId) {
    case "typescript":
    case "tsx":
    case "javascript":
      return extractTsJsSymbols(worktreePath, filePath, root);
    case "python":
      return extractPythonSymbols(worktreePath, filePath, root);
    case "rust":
      return extractRustSymbols(worktreePath, filePath, root);
    case "go":
      return extractGoSymbols(worktreePath, filePath, root);
  }
}

/**
 * Fast structural regex fallback when Tree-sitter WASM is unavailable for a language.
 */
export function extractRegexSymbols(
  worktreePath: string,
  filePath: string,
  content: string,
): CodeSymbol[] {
  const lines = content.split(/\r?\n/);
  const symbols: CodeSymbol[] = [];

  const patterns: { re: RegExp; kind: SymbolKind }[] = [
    { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/, kind: "function" },
    { re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/, kind: "class" },
    { re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/, kind: "interface" },
    { re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:=|<)/, kind: "type" },
    { re: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][A-Za-z0-9_$]*)/, kind: "enum" },
    { re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/, kind: "function" },
    { re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/, kind: "const" },
    { re: /^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/, kind: "function" },
    { re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/, kind: "function" },
    { re: /^\s*(?:pub\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/, kind: "class" },
    { re: /^\s*(?:pub\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)/, kind: "interface" },
    { re: /^\s*func\s+(?:\([^)]+\)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/, kind: "function" },
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const { re, kind } of patterns) {
      const m = re.exec(line);
      if (m) {
        symbols.push({
          name: m[1]!,
          kind,
          filePath,
          worktreePath,
          startLine: i + 1,
          endLine: i + 1,
        });
        break;
      }
    }
  }

  return symbols;
}

function flattenSymbols(symbols: readonly CodeSymbol[]): CodeSymbol[] {
  const flat: CodeSymbol[] = [];
  const visit = (list: readonly CodeSymbol[]) => {
    for (const sym of list) {
      flat.push(sym);
      if (sym.children && sym.children.length > 0) {
        visit(sym.children);
      }
    }
  };
  visit(symbols);
  return flat;
}

export class WorktreeSymbolIndex {
  private readonly byWorktree = new Map<string, Map<string, CodeSymbol[]>>();

  invalidate(worktreePath: string, filePath?: string): void {
    if (!filePath) {
      this.byWorktree.delete(worktreePath);
      return;
    }
    this.byWorktree.get(worktreePath)?.delete(toPosixPath(filePath));
  }

  invalidateAll(): void {
    this.byWorktree.clear();
  }

  setFileSymbols(worktreePath: string, filePath: string, symbols: CodeSymbol[]): void {
    let map = this.byWorktree.get(worktreePath);
    if (!map) {
      map = new Map();
      this.byWorktree.set(worktreePath, map);
    }
    map.set(toPosixPath(filePath), symbols);
  }

  getWorktreeSymbols(worktreePath: string): CodeSymbol[] {
    const map = this.byWorktree.get(worktreePath);
    if (!map) return [];
    const all: CodeSymbol[] = [];
    for (const list of map.values()) {
      all.push(...flattenSymbols(list));
    }
    return all;
  }

  private readonly inFlight = new Map<string, Promise<void>>();

  hasWorktree(worktreePath: string): boolean {
    return this.byWorktree.has(worktreePath);
  }

  async ensureWorktreeIndexed(worktreePath: string): Promise<void> {
    if (this.byWorktree.has(worktreePath)) return;
    const existing = this.inFlight.get(worktreePath);
    if (existing) return existing;

    const task = (async () => {
      const files = await worktreeFileIndex.getFiles(worktreePath);
      const indexable = files.filter((f) => {
        const ext = extname(f).toLowerCase();
        return ext in EXT_TO_TS_LANG || MARKDOWN_EXTS.has(ext);
      });

      const localMap = new Map<string, CodeSymbol[]>();
      this.byWorktree.set(worktreePath, localMap);

      const CONCURRENCY = 8;
      for (let i = 0; i < indexable.length; i += CONCURRENCY) {
        const batch = indexable.slice(i, i + CONCURRENCY);
        await Promise.all(
          batch.map(async (filePath) => {
            const safeAbs = insideWorktree(worktreePath, filePath);
            if (!safeAbs) return;
            try {
              const content = await readFile(safeAbs, "utf8");
              if (Buffer.byteLength(content, "utf8") > MAX_SYMBOL_INDEX_BYTES) return;
              await getStructure(worktreePath, filePath, content, this);
            } catch {
              // Skip unreadable files
            }
          }),
        );
      }
    })().finally(() => {
      this.inFlight.delete(worktreePath);
    });

    this.inFlight.set(worktreePath, task);
    return task;
  }
}

export const worktreeSymbolIndex = new WorktreeSymbolIndex();

/**
 * Extracts hierarchical `CodeSymbol[]` for a file using `web-tree-sitter` WASM grammars,
 * Markdown ATX heading parser, or fast regex fallback, and updates the per-worktree symbol cache.
 */
export async function getStructure(
  worktreePath: string,
  filePath: string,
  content?: string,
  symbolIndex: WorktreeSymbolIndex = worktreeSymbolIndex,
): Promise<CodeSymbol[]> {
  const normalizedPath = toPosixPath(filePath);
  let source = content;
  if (source === undefined) {
    const safeAbs = insideWorktree(worktreePath, normalizedPath);
    if (!safeAbs) return [];
    source = await readFile(safeAbs, "utf8");
  }

  const ext = extname(normalizedPath).toLowerCase();
  let symbols: CodeSymbol[];

  if (MARKDOWN_EXTS.has(ext)) {
    symbols = extractMarkdownHeadings(worktreePath, normalizedPath, source);
  } else {
    const tsLangId = EXT_TO_TS_LANG[ext];
    const grammar = tsLangId ? await getLanguageGrammar(tsLangId) : null;
    if (tsLangId && grammar) {
      const ParserClass = await ensureParserReady();
      const parser = new ParserClass();
      try {
        parser.setLanguage(grammar);
        const tree = parser.parse(source);
        try {
          symbols = extractTreeSitterSymbols(tsLangId, worktreePath, normalizedPath, tree.rootNode);
        } finally {
          tree.delete();
        }
      } catch {
        symbols = extractRegexSymbols(worktreePath, normalizedPath, source);
      } finally {
        parser.delete();
      }
    } else {
      symbols = extractRegexSymbols(worktreePath, normalizedPath, source);
    }
  }

  symbolIndex.setFileSymbols(worktreePath, normalizedPath, symbols);
  return symbols;
}

export interface SearchSymbolsParams {
  worktreePath: string;
  query: string;
  allWorktrees?: boolean;
  limit?: number;
  worktreePaths?: string[];
}

/**
 * Searches cached worktree symbols using `@leeoniya/ufuzzy` + exact/prefix boosting.
 */
export async function searchSymbols(
  params: SearchSymbolsParams,
  symbolIndex: WorktreeSymbolIndex = worktreeSymbolIndex,
): Promise<CodeSymbol[]> {
  const limit = params.limit && params.limit > 0 ? params.limit : DEFAULT_SYMBOL_SEARCH_LIMIT;
  const targets =
    params.allWorktrees && params.worktreePaths && params.worktreePaths.length > 0
      ? Array.from(new Set(params.worktreePaths))
      : [params.worktreePath];

  await Promise.all(targets.map((wt) => symbolIndex.ensureWorktreeIndexed(wt)));

  const allSymbols: CodeSymbol[] = [];
  for (const wt of targets) {
    allSymbols.push(...symbolIndex.getWorktreeSymbols(wt));
  }

  const cleanQuery = params.query.trim();
  if (!cleanQuery) {
    return allSymbols.slice(0, limit);
  }

  const names = allSymbols.map((s) => s.name);
  const [idxs, info, order] = ufSymbol.search(names, cleanQuery, 0, 2e3);
  const queryLower = cleanQuery.toLowerCase();

  const candidateIndices = new Set<number>();
  const rankBonus = new Map<number, number>();

  if (order && info) {
    for (let r = 0; r < order.length; r++) {
      const idx = info.idx[order[r]!]!;
      candidateIndices.add(idx);
      rankBonus.set(idx, 1000 + ((order.length - r) / Math.max(1, order.length)) * 500);
    }
  } else if (idxs) {
    for (const idx of idxs) {
      candidateIndices.add(idx);
      rankBonus.set(idx, 800);
    }
  }

  // Ensure exact/prefix/substring matches are always included even for short symbols
  for (let i = 0; i < allSymbols.length; i++) {
    const nameLower = allSymbols[i]!.name.toLowerCase();
    if (nameLower.includes(queryLower)) {
      candidateIndices.add(i);
    }
  }

  const scored: { sym: CodeSymbol; score: number }[] = [];
  for (const idx of candidateIndices) {
    const sym = allSymbols[idx]!;
    const nameLower = sym.name.toLowerCase();
    let score = rankBonus.get(idx) ?? 0;
    if (sym.name === cleanQuery) score += 10000;
    else if (nameLower === queryLower) score += 9000;
    else if (nameLower.startsWith(queryLower)) score += 5000;
    else if (nameLower.includes(queryLower)) score += 2500;
    score -= sym.name.length * 0.25;
    scored.push({ sym, score });
  }

  scored.sort((a, b) => b.score - a.score || a.sym.name.localeCompare(b.sym.name));
  return scored.slice(0, limit).map((item) => item.sym);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isDeclarationLineForSymbol(lineText: string, symbolName: string): boolean {
  const esc = escapeRegExp(symbolName);
  const declPatterns = [
    new RegExp(`\\b(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${esc}\\b`),
    new RegExp(`\\b(?:export\\s+)?(?:abstract\\s+)?class\\s+${esc}\\b`),
    new RegExp(`\\b(?:export\\s+)?interface\\s+${esc}\\b`),
    new RegExp(`\\b(?:export\\s+)?type\\s+${esc}\\b`),
    new RegExp(`\\b(?:export\\s+)?enum\\s+${esc}\\b`),
    new RegExp(`\\b(?:export\\s+)?(?:const|let|var)\\s+${esc}\\s*(?::[^=]+)?=`),
    new RegExp(`^\\s*(?:async\\s+)?def\\s+${esc}\\b`),
    new RegExp(`\\b(?:pub\\s+)?(?:async\\s+)?fn\\s+${esc}\\b`),
    new RegExp(`\\b(?:pub\\s+)?(?:struct|enum|trait|type|mod|const)\\s+${esc}\\b`),
    new RegExp(`\\bfunc\\s+(?:\\([^)]+\\)\\s+)?${esc}\\b`),
    new RegExp(`^\\s*(?:public|private|protected|static|async|readonly|override|\\s)*${esc}\\s*(?:<[^>]+>)?\\s*\\([^)]*\\)\\s*(?::[^{;]+)?\\{`),
  ];

  return declPatterns.some((re) => re.test(lineText));
}

export interface FindDefinitionAndUsagesParams {
  worktreePath: string;
  filePath: string;
  symbolName: string;
  line: number;
}

/**
 * Combines Tree-sitter AST symbol definitions across the worktree with fast `rg --word-regexp --fixed-strings`
 * matches to partition results into `definitions` and `usages`.
 */
export async function findDefinitionAndUsages(
  params: FindDefinitionAndUsagesParams,
  symbolIndex: WorktreeSymbolIndex = worktreeSymbolIndex,
): Promise<{ definitions: SearchMatch[]; usages: SearchMatch[] }> {
  const cleanSymbol = params.symbolName.trim();
  if (!cleanSymbol) {
    return { definitions: [], usages: [] };
  }

  const normalizedFilePath = toPosixPath(params.filePath);

  // Ensure current file & worktree AST symbols are populated
  if (!symbolIndex.hasWorktree(params.worktreePath)) {
    await symbolIndex.ensureWorktreeIndexed(params.worktreePath);
  }
  await getStructure(params.worktreePath, normalizedFilePath, undefined, symbolIndex);

  const astDefLocations = new Set<string>();
  const astMatchedDefs: SearchMatch[] = [];
  for (const sym of symbolIndex.getWorktreeSymbols(params.worktreePath)) {
    if (sym.name === cleanSymbol && sym.kind !== "heading") {
      astDefLocations.add(`${sym.filePath}:${sym.startLine}`);
      astMatchedDefs.push({
        worktreePath: sym.worktreePath,
        worktreeName: basename(sym.worktreePath) || sym.worktreePath,
        filePath: sym.filePath,
        line: sym.startLine,
        column: 1,
        lineText: "",
        matchStart: 0,
        matchEnd: 0,
      });
    }
  }

  const rawMatches = await findInPath(
    {
      worktreePath: params.worktreePath,
      query: cleanSymbol,
      isRegex: false,
      caseSensitive: true,
      wholeWord: true,
      limit: 500,
    },
    [{ path: params.worktreePath, name: basename(params.worktreePath) || params.worktreePath }],
  );

  const definitions: SearchMatch[] = [];
  const usages: SearchMatch[] = [];
  const seenDefLines = new Set<string>();

  for (const match of rawMatches) {
    const locKey = `${match.filePath}:${match.line}`;
    const isAstDef = astDefLocations.has(locKey);
    const isRegexDef = isDeclarationLineForSymbol(match.lineText, cleanSymbol);

    if (isAstDef || isRegexDef) {
      if (!seenDefLines.has(locKey)) {
        seenDefLines.add(locKey);
        definitions.push(match);
      }
    } else {
      usages.push(match);
    }
  }

  // If an AST definition was found on a line not returned by ripgrep (e.g. unsaved or skipped), preserve it
  for (const astDef of astMatchedDefs) {
    const locKey = `${astDef.filePath}:${astDef.line}`;
    if (!seenDefLines.has(locKey)) {
      seenDefLines.add(locKey);
      definitions.push(astDef);
    }
  }

  return { definitions, usages };
}
