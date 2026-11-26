import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import YAML from "yaml";
import type * as Mdast from "mdast";
import type {
  Annotation,
  CodeSymbol,
  FileDocument,
  LineBlame,
} from "../../shared/protocol";
import { AnnotationComposer, AnnotationThreadCard } from "./AnnotationCard";
import { CodeViewport, type CodeViewportHandle } from "./CodeViewport";

export type MarkdownViewMode = "preview" | "split" | "raw";

export interface MarkdownViewerProps {
  document: FileDocument;
  symbols?: CodeSymbol[];
  blame?: LineBlame[];
  showBlame?: boolean;
  annotations?: Annotation[];
  mode?: MarkdownViewMode;
  onModeChange?: (mode: MarkdownViewMode) => void;
  scrollToRequest?: {
    line: number;
    column?: number;
    flash?: boolean;
    seq: number;
  } | null;
  recentlyUpdatedAt?: number;
  onCreateAnnotation?: (input: {
    startLine: number;
    endLine: number;
    selectedText: string;
    contextBefore: string;
    contextAfter: string;
    comment: string;
  }) => void | Promise<void>;
  onUpdateAnnotation?: (
    annotation: Annotation,
    updates: { comment: string },
  ) => void | Promise<void>;
  onResolveAnnotation?: (annotation: Annotation) => void | Promise<void>;
  onUnresolveAnnotation?: (annotation: Annotation) => void | Promise<void>;
  onDeleteAnnotation?: (annotation: Annotation) => void | Promise<void>;
  onSymbolActivate?: (params: {
    symbolName: string;
    line: number;
    mode: "definition" | "usages";
  }) => void;
  onOpenRelativeLink?: (targetPath: string, lineOrAnchor?: string) => void;
  onOpenExternalUrl?: (url: string) => void;
  readAssetDataUrl?: (
    relativeFromFile: string,
    rawHref: string,
  ) => Promise<string | null>;
  onCursorChange?: (pos: {
    line: number;
    column: number;
    startLine?: number;
    endLine?: number;
  }) => void;
  findOpenTrigger?: number;
  annotateTrigger?: number;
  fontSizePx?: number;
}

const mdParser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, ["yaml"]);

let mermaidInitialized = false;
let mermaidCounter = 0;

type AlertKind = "note" | "tip" | "important" | "warning" | "caution";

interface YamlNode {
  type: "yaml";
  value: string;
  position?: Mdast.Node["position"];
}

function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

function extractPlainText(node: Mdast.Nodes | YamlNode): string {
  if ("value" in node && typeof node.value === "string") {
    return node.value;
  }
  if ("children" in node && Array.isArray(node.children)) {
    return (node.children as Mdast.Nodes[]).map(extractPlainText).join("");
  }
  return "";
}

function resolveRelativeRepoPath(
  currentFilePath: string,
  rawHref: string,
): { targetPath: string; fragment?: string } {
  const hashIdx = rawHref.indexOf("#");
  const pathPartRaw = hashIdx >= 0 ? rawHref.slice(0, hashIdx) : rawHref;
  const fragment = hashIdx >= 0 ? rawHref.slice(hashIdx + 1) : undefined;

  // Support optional :line suffix (e.g. ./src/foo.ts:42)
  const colonLineMatch = /^(.*?):(\d+)$/.exec(pathPartRaw);
  const pathPart = colonLineMatch ? colonLineMatch[1]! : pathPartRaw;
  const lineFragment = colonLineMatch ? `L${colonLineMatch[2]}` : fragment;

  const baseSegments = currentFilePath.split("/").slice(0, -1);
  const relSegments = pathPart.split("/");
  const stack = pathPart.startsWith("/") ? [] : [...baseSegments];

  for (const seg of relSegments) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      stack.pop();
    } else {
      stack.push(seg);
    }
  }

  return {
    targetPath: stack.join("/"),
    fragment: lineFragment,
  };
}

function detectGitDiffStatusForRange(
  markers: Record<number, "added" | "modified" | "deleted-after"> | undefined,
  startLine: number,
  endLine: number,
): "added" | "modified" | null {
  if (!markers) return null;
  let foundAdded = false;
  for (let l = startLine; l <= endLine; l++) {
    const m = markers[l];
    if (m === "modified") return "modified";
    if (m === "added") foundAdded = true;
  }
  return foundAdded ? "added" : null;
}

function parseAlertBlockquote(node: Mdast.Blockquote): {
  kind: AlertKind;
  children: Array<Mdast.BlockContent | Mdast.DefinitionContent>;
} | null {
  const first = node.children[0];
  if (!first || first.type !== "paragraph") return null;
  const firstChild = first.children[0];
  if (!firstChild || firstChild.type !== "text") return null;

  const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\r?\n|\s+|$)/i.exec(
    firstChild.value,
  );
  if (!match) return null;

  const kind = match[1]!.toLowerCase() as AlertKind;
  const remainingText = firstChild.value.slice(match[0].length);
  const updatedFirstParagraph: Mdast.Paragraph = {
    ...first,
    children: remainingText
      ? [{ ...firstChild, value: remainingText }, ...first.children.slice(1)]
      : first.children.slice(1),
  };

  const rest = node.children.slice(1);
  const cleanedChildren: Array<Mdast.BlockContent | Mdast.DefinitionContent> =
    updatedFirstParagraph.children.length > 0
      ? [updatedFirstParagraph, ...rest]
      : rest;

  return { kind, children: cleanedChildren };
}

function getBlockLinesFromSelection(): {
  startLine: number;
  endLine: number;
} | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return null;

  const findBlockLines = (
    node: Node | null,
  ): { start: number; end: number } | null => {
    let cur: Node | null = node;
    while (cur) {
      if (
        cur instanceof HTMLElement &&
        cur.dataset.startLine &&
        cur.dataset.endLine
      ) {
        const start = Number.parseInt(cur.dataset.startLine, 10);
        const end = Number.parseInt(cur.dataset.endLine, 10);
        if (Number.isFinite(start) && Number.isFinite(end)) {
          return { start, end };
        }
      }
      cur = cur.parentNode;
    }
    return null;
  };

  const a = findBlockLines(sel.anchorNode);
  const b = findBlockLines(sel.focusNode);
  if (!a || !b) return null;

  return {
    startLine: Math.min(a.start, b.start),
    endLine: Math.max(a.end, b.end),
  };
}

const FencedCodeBlock: React.FC<{
  lang?: string | null;
  value: string;
}> = ({ lang, value }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      if (typeof window !== "undefined" && window.ide2?.copyToClipboard) {
        await window.ide2.copyToClipboard(value);
      } else {
        await navigator.clipboard.writeText(value);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard may be unavailable in restricted contexts
    }
  };

  return (
    <div className="md-code-block">
      <div className="md-code-header">
        <span>{lang ? lang.toUpperCase() : "TEXT"}</span>
        <button type="button" className="btn btn-ghost" onClick={handleCopy}>
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
      <pre className="md-code-pre">
        <code>{value}</code>
      </pre>
    </div>
  );
};

const MermaidBlock: React.FC<{ code: string }> = ({ code }) => {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [zoomScale, setZoomScale] = useState(1);

  useEffect(() => {
    let cancelled = false;
    setError(null);

    (async () => {
      const mod = await import("mermaid");
      const mermaid = mod.default;
      if (!mermaidInitialized) {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          themeVariables: {
            darkMode: true,
            background: "#1e1f22",
            primaryColor: "#2b2d34",
            primaryBorderColor: "#3d6bff",
            primaryTextColor: "#dfe1e5",
            secondaryColor: "#24262b",
            tertiaryColor: "#181a1f",
            lineColor: "#8b909a",
            textColor: "#dfe1e5",
            fontFamily:
              "-apple-system, BlinkMacSystemFont, Inter, Segoe UI, sans-serif",
          },
        });
        mermaidInitialized = true;
      }
      mermaidCounter += 1;
      const renderId = `expect2-mmd-${mermaidCounter}`;
      const rendered = await mermaid.render(renderId, code);
      if (!cancelled) {
        setSvg(rendered.svg);
      }
    })().catch((err: unknown) => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : "Mermaid render failed");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [code]);

  useEffect(() => {
    if (!zoomOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setZoomOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomOpen]);

  if (error) {
    return (
      <div className="md-code-block">
        <div className="md-code-header">
          <span style={{ color: "var(--unsafe)" }}>
            MERMAID ERROR: {error}
          </span>
        </div>
        <pre className="md-code-pre">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  return (
    <>
      <div className="md-mermaid-box">
        <div className="md-code-header">
          <span>MERMAID DIAGRAM</span>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setZoomScale(1);
              setZoomOpen(true);
            }}
          >
            Zoom ⤢
          </button>
        </div>
        {svg ? (
          <div
            className="md-mermaid-svg"
            title="Click to zoom diagram"
            onClick={() => {
              setZoomScale(1);
              setZoomOpen(true);
            }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <div style={{ padding: 14, color: "var(--dim)", fontSize: 12 }}>
            Rendering Mermaid diagram...
          </div>
        )}
      </div>

      {zoomOpen && svg && (
        <div
          className="md-mermaid-modal"
          onClick={() => setZoomOpen(false)}
        >
          <div
            className="md-mermaid-modal-inner"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="hud-header">
              <span className="hud-header-title">MERMAID DIAGRAM VIEWER</span>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setZoomScale((z) => Math.max(0.4, z - 0.2))}
                >
                  -
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setZoomScale(1)}
                >
                  {Math.round(zoomScale * 100)}%
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setZoomScale((z) => Math.min(3, z + 0.2))}
                >
                  +
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setZoomOpen(false)}
                >
                  Close Esc
                </button>
              </div>
            </div>
            <div className="md-mermaid-modal-canvas">
              <div
                style={{
                  transform: `scale(${zoomScale})`,
                  transformOrigin: "center center",
                }}
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
};

const MarkdownImage: React.FC<{
  src: string;
  alt?: string | null;
  title?: string | null;
  currentFilePath: string;
  readAssetDataUrl?: (
    relativeFromFile: string,
    rawHref: string,
  ) => Promise<string | null>;
}> = ({ src, alt, title, currentFilePath, readAssetDataUrl }) => {
  const isRemote =
    /^https?:\/\//i.test(src) || /^data:image\//i.test(src);
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(
    isRemote ? src : null,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (isRemote) {
      setResolvedUrl(src);
      setFailed(false);
      return;
    }
    if (!readAssetDataUrl) {
      setFailed(true);
      return;
    }
    let cancelled = false;
    readAssetDataUrl(currentFilePath, src)
      .then((url) => {
        if (!cancelled) {
          if (url) setResolvedUrl(url);
          else setFailed(true);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [src, isRemote, currentFilePath, readAssetDataUrl]);

  return (
    <span className="md-image-wrap">
      {resolvedUrl ? (
        <img src={resolvedUrl} alt={alt ?? ""} title={title ?? undefined} />
      ) : (
        <span style={{ fontSize: 12, color: failed ? "var(--unsafe)" : "var(--dim)" }}>
          {failed ? `[missing image: ${src}]` : `[loading image: ${src}]`}
        </span>
      )}
      {(alt || title) && (
        <span className="md-image-caption">{title ?? alt}</span>
      )}
    </span>
  );
};

const FrontmatterGrid: React.FC<{ rawYaml: string }> = ({ rawYaml }) => {
  const parsed = useMemo(() => {
    try {
      const val: unknown = YAML.parse(rawYaml);
      if (val && typeof val === "object" && !Array.isArray(val)) {
        return Object.entries(val as Record<string, unknown>);
      }
      return null;
    } catch {
      return null;
    }
  }, [rawYaml]);

  if (!parsed || parsed.length === 0) {
    return <FencedCodeBlock lang="yaml" value={rawYaml} />;
  }

  return (
    <div className="md-frontmatter">
      <div className="hud-header">
        <span className="hud-header-title">FRONTMATTER</span>
      </div>
      <div className="md-frontmatter-grid">
        {parsed.map(([key, val]) => (
          <React.Fragment key={key}>
            <div className="md-fm-key">{key}</div>
            <div className="md-fm-val">
              {typeof val === "string" ||
              typeof val === "number" ||
              typeof val === "boolean"
                ? String(val)
                : JSON.stringify(val)}
            </div>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
};

export const MarkdownViewer: React.FC<MarkdownViewerProps> = ({
  document: doc,
  symbols = [],
  blame,
  showBlame = false,
  annotations = [],
  mode: controlledMode,
  onModeChange,
  scrollToRequest,
  recentlyUpdatedAt,
  onCreateAnnotation,
  onUpdateAnnotation,
  onResolveAnnotation,
  onUnresolveAnnotation,
  onDeleteAnnotation,
  onSymbolActivate,
  onOpenRelativeLink,
  onOpenExternalUrl,
  readAssetDataUrl,
  onCursorChange,
  findOpenTrigger = 0,
  annotateTrigger = 0,
  fontSizePx = 13.5,
}) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const previewScrollRef = useRef<HTMLDivElement | null>(null);
  const rawCodeRef = useRef<CodeViewportHandle | null>(null);
  const syncLockRef = useRef<"raw" | "preview" | null>(null);
  const syncTimerRef = useRef<number | null>(null);

  const [localMode, setLocalMode] = useState<MarkdownViewMode>("preview");
  const viewMode = controlledMode ?? localMode;

  const setViewMode = useCallback(
    (next: MarkdownViewMode) => {
      if (onModeChange) onModeChange(next);
      else setLocalMode(next);
    },
    [onModeChange],
  );

  const cycleMode = useCallback(() => {
    const order: MarkdownViewMode[] = ["preview", "split", "raw"];
    const idx = order.indexOf(viewMode);
    setViewMode(order[(idx + 1) % order.length]!);
  }, [viewMode, setViewMode]);

  const [composerRange, setComposerRange] = useState<{
    startLine: number;
    endLine: number;
  } | null>(null);
  const [flashedBlockStart, setFlashedBlockStart] = useState<number | null>(
    null,
  );

  const rawText = useMemo(() => doc.lines.join("\n"), [doc.lines]);

  const wordCount = useMemo(() => {
    const trimmed = rawText.trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).length;
  }, [rawText]);

  const ast = useMemo(() => mdParser.parse(rawText), [rawText]);

  // Extract link definitions for reference links `[foo][bar]`
  const definitions = useMemo(() => {
    const map = new Map<string, { url: string; title?: string | null }>();
    for (const child of ast.children) {
      if (child.type === "definition") {
        map.set(child.identifier.toLowerCase(), {
          url: child.url,
          title: child.title,
        });
      }
    }
    return map;
  }, [ast]);

  // Scroll to requested line in preview
  useEffect(() => {
    if (!scrollToRequest || viewMode === "raw") return;
    const container = previewScrollRef.current;
    if (!container) return;
    const blocks = container.querySelectorAll<HTMLElement>("[data-start-line]");
    let targetEl: HTMLElement | null = null;
    for (const el of blocks) {
      const start = Number.parseInt(el.dataset.startLine ?? "0", 10);
      const end = Number.parseInt(el.dataset.endLine ?? "0", 10);
      if (scrollToRequest.line >= start && scrollToRequest.line <= end) {
        targetEl = el;
        break;
      }
      if (start >= scrollToRequest.line) {
        targetEl = el;
        break;
      }
    }
    if (targetEl) {
      targetEl.scrollIntoView({ block: "center" });
      const s = Number.parseInt(targetEl.dataset.startLine ?? "0", 10);
      if (scrollToRequest.flash && s) {
        setFlashedBlockStart(s);
      }
    }
  }, [scrollToRequest?.seq, scrollToRequest?.line, viewMode]);

  useEffect(() => {
    if (flashedBlockStart === null) return;
    const t = window.setTimeout(() => setFlashedBlockStart(null), 1200);
    return () => window.clearTimeout(t);
  }, [flashedBlockStart]);

  // Split mode scroll sync: Raw -> Preview
  const handleRawVisibleLineChange = useCallback(
    (firstVisibleLine: number) => {
      if (viewMode !== "split") return;
      if (syncLockRef.current === "preview") return;
      const container = previewScrollRef.current;
      if (!container) return;

      syncLockRef.current = "raw";
      if (syncTimerRef.current) window.clearTimeout(syncTimerRef.current);
      syncTimerRef.current = window.setTimeout(() => {
        syncLockRef.current = null;
      }, 120);

      const blocks =
        container.querySelectorAll<HTMLElement>("[data-start-line]");
      let best: HTMLElement | null = null;
      for (const el of blocks) {
        const start = Number.parseInt(el.dataset.startLine ?? "0", 10);
        if (start <= firstVisibleLine) {
          best = el;
        } else {
          break;
        }
      }
      if (best) {
        container.scrollTop = Math.max(0, best.offsetTop - 12);
      }
    },
    [viewMode],
  );

  // Split mode scroll sync: Preview -> Raw
  const handlePreviewScroll = useCallback(() => {
    if (viewMode !== "split") return;
    if (syncLockRef.current === "raw") return;
    const container = previewScrollRef.current;
    if (!container) return;

    syncLockRef.current = "preview";
    if (syncTimerRef.current) window.clearTimeout(syncTimerRef.current);
    syncTimerRef.current = window.setTimeout(() => {
      syncLockRef.current = null;
    }, 120);

    const blocks = container.querySelectorAll<HTMLElement>("[data-start-line]");
    const topThreshold = container.scrollTop + 20;
    for (const el of blocks) {
      if (el.offsetTop + el.offsetHeight >= topThreshold) {
        const start = Number.parseInt(el.dataset.startLine ?? "1", 10);
        rawCodeRef.current?.scrollToLine(start, {
          align: "start",
          flash: false,
        });
        break;
      }
    }
  }, [viewMode]);

  const handleLinkClick = useCallback(
    (e: React.MouseEvent, rawHref: string) => {
      e.preventDefault();
      if (!rawHref) return;

      if (rawHref.startsWith("#")) {
        const slug = rawHref.slice(1).toLowerCase();
        const container = previewScrollRef.current;
        if (container) {
          const target = container.querySelector<HTMLElement>(
            `[data-heading-slug="${CSS.escape(slug)}"]`,
          );
          target?.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        return;
      }

      if (/^(https?:|mailto:)/i.test(rawHref)) {
        onOpenExternalUrl?.(rawHref);
        return;
      }

      const resolved = resolveRelativeRepoPath(doc.filePath, rawHref);
      onOpenRelativeLink?.(resolved.targetPath, resolved.fragment);
    },
    [doc.filePath, onOpenExternalUrl, onOpenRelativeLink],
  );

  const renderPhrasing = useCallback(
    (nodes: Mdast.PhrasingContent[], keyPrefix: string): React.ReactNode => {
      return nodes.map((node, idx) => {
        const k = `${keyPrefix}-${idx}`;
        switch (node.type) {
          case "text":
            return <React.Fragment key={k}>{node.value}</React.Fragment>;
          case "emphasis":
            return <em key={k}>{renderPhrasing(node.children, k)}</em>;
          case "strong":
            return <strong key={k}>{renderPhrasing(node.children, k)}</strong>;
          case "delete":
            return <del key={k}>{renderPhrasing(node.children, k)}</del>;
          case "inlineCode":
            return (
              <code key={k} className="md-inline-code">
                {node.value}
              </code>
            );
          case "break":
            return <br key={k} />;
          case "link":
            return (
              <a
                key={k}
                href={node.url}
                className="md-link"
                title={node.title ?? node.url}
                onClick={(e) => handleLinkClick(e, node.url)}
              >
                {renderPhrasing(node.children, k)}
                {/^https?:\/\//i.test(node.url) ? " ↗" : ""}
              </a>
            );
          case "linkReference": {
            const def = definitions.get(node.identifier.toLowerCase());
            if (!def) {
              return (
                <React.Fragment key={k}>
                  [{renderPhrasing(node.children, k)}]
                </React.Fragment>
              );
            }
            return (
              <a
                key={k}
                href={def.url}
                className="md-link"
                title={def.title ?? def.url}
                onClick={(e) => handleLinkClick(e, def.url)}
              >
                {renderPhrasing(node.children, k)}
                {/^https?:\/\//i.test(def.url) ? " ↗" : ""}
              </a>
            );
          }
          case "image":
            return (
              <MarkdownImage
                key={k}
                src={node.url}
                alt={node.alt}
                title={node.title}
                currentFilePath={doc.filePath}
                readAssetDataUrl={readAssetDataUrl}
              />
            );
          case "imageReference": {
            const def = definitions.get(node.identifier.toLowerCase());
            if (!def) return <span key={k}>[{node.alt ?? node.identifier}]</span>;
            return (
              <MarkdownImage
                key={k}
                src={def.url}
                alt={node.alt}
                title={def.title}
                currentFilePath={doc.filePath}
                readAssetDataUrl={readAssetDataUrl}
              />
            );
          }
          case "footnoteReference":
            return (
              <sup key={k} style={{ color: "var(--syn-type)" }}>
                [{node.label ?? node.identifier}]
              </sup>
            );
          case "html":
            // Safe plain-text fallback for inline HTML
            return (
              <code key={k} className="md-inline-code">
                {node.value}
              </code>
            );
          default:
            return null;
        }
      });
    },
    [definitions, doc.filePath, handleLinkClick, readAssetDataUrl],
  );

  const renderBlockNode = useCallback(
    (node: Mdast.RootContent | YamlNode, key: string): React.ReactNode => {
      switch (node.type) {
        case "yaml":
          return <FrontmatterGrid key={key} rawYaml={node.value} />;

        case "heading": {
          const slug = slugifyHeading(extractPlainText(node));
          const children = renderPhrasing(node.children, key);
          const props = {
            key,
            id: slug,
            "data-heading-slug": slug,
          };
          switch (node.depth) {
            case 1:
              return <h1 {...props}>{children}</h1>;
            case 2:
              return <h2 {...props}>{children}</h2>;
            case 3:
              return <h3 {...props}>{children}</h3>;
            case 4:
              return <h4 {...props}>{children}</h4>;
            case 5:
              return <h5 {...props}>{children}</h5>;
            default:
              return <h6 {...props}>{children}</h6>;
          }
        }

        case "paragraph":
          return <p key={key}>{renderPhrasing(node.children, key)}</p>;

        case "thematicBreak":
          return <hr key={key} />;

        case "blockquote": {
          const alert = parseAlertBlockquote(node);
          if (alert) {
            return (
              <div key={key} className={`md-alert md-alert-${alert.kind}`}>
                <span className="md-alert-title">{alert.kind}</span>
                {alert.children.map((child, idx) =>
                  renderBlockNode(child, `${key}-a-${idx}`),
                )}
              </div>
            );
          }
          return (
            <blockquote key={key}>
              {node.children.map((child, idx) =>
                renderBlockNode(child, `${key}-bq-${idx}`),
              )}
            </blockquote>
          );
        }

        case "list": {
          const Tag = node.ordered ? "ol" : "ul";
          return (
            <Tag key={key} start={node.start ?? undefined}>
              {node.children.map((item, idx) => {
                const isTask = typeof item.checked === "boolean";
                return (
                  <li
                    key={`${key}-li-${idx}`}
                    className={isTask ? "md-task-item" : undefined}
                  >
                    {isTask && (
                      <span
                        className={`md-task-glyph ${
                          item.checked ? "checked" : "unchecked"
                        }`}
                      >
                        {item.checked ? "✔ " : "◻ "}
                      </span>
                    )}
                    {item.children.map((sub, sIdx) =>
                      renderBlockNode(sub, `${key}-li-${idx}-${sIdx}`),
                    )}
                  </li>
                );
              })}
            </Tag>
          );
        }

        case "code":
          if (node.lang?.toLowerCase() === "mermaid") {
            return <MermaidBlock key={key} code={node.value} />;
          }
          return (
            <FencedCodeBlock key={key} lang={node.lang} value={node.value} />
          );

        case "table": {
          const [headRow, ...bodyRows] = node.children;
          return (
            <div key={key} className="md-table-wrap">
              <table className="md-table">
                {headRow && (
                  <thead>
                    <tr>
                      {headRow.children.map((cell, cIdx) => (
                        <th
                          key={`${key}-th-${cIdx}`}
                          style={{
                            textAlign: node.align?.[cIdx] ?? "left",
                          }}
                        >
                          {renderPhrasing(cell.children, `${key}-th-${cIdx}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                )}
                {bodyRows.length > 0 && (
                  <tbody>
                    {bodyRows.map((row, rIdx) => (
                      <tr key={`${key}-tr-${rIdx}`}>
                        {row.children.map((cell, cIdx) => (
                          <td
                            key={`${key}-td-${rIdx}-${cIdx}`}
                            style={{
                              textAlign: node.align?.[cIdx] ?? "left",
                            }}
                          >
                            {renderPhrasing(
                              cell.children,
                              `${key}-td-${rIdx}-${cIdx}`,
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                )}
              </table>
            </div>
          );
        }

        case "footnoteDefinition":
          return (
            <div
              key={key}
              style={{
                fontSize: "0.9em",
                color: "var(--dim)",
                borderLeft: "2px solid var(--faint)",
                paddingLeft: 10,
                marginTop: 6,
              }}
            >
              <strong style={{ color: "var(--syn-type)" }}>
                [{node.label ?? node.identifier}]:{" "}
              </strong>
              {node.children.map((child, idx) =>
                renderBlockNode(child, `${key}-fn-${idx}`),
              )}
            </div>
          );

        case "definition":
          return null;

        case "html":
          return <FencedCodeBlock key={key} lang="html" value={node.value} />;

        default:
          return null;
      }
    },
    [renderPhrasing],
  );

  // Map top-level blocks and attach annotations cleanly to each block
  const { blockEntries, unmatchedAnnotations } = useMemo(() => {
    const rawChildren = ast.children as Array<Mdast.RootContent | YamlNode>;
    const blocks = rawChildren
      .filter((child) => child.type !== "definition")
      .map((node, index) => {
        const startLine = node.position?.start?.line ?? 1;
        const endLine = node.position?.end?.line ?? startLine;
        return { node, index, startLine, endLine };
      });

    const map = new Map<number, Annotation[]>();
    const leftover: Annotation[] = [];

    for (const ann of annotations) {
      if (ann.side === "old") continue;
      const anchorLine = ann.endLine ?? ann.startLine ?? 1;
      const target =
        blocks.find(
          (b) => anchorLine >= b.startLine && anchorLine <= b.endLine,
        ) ?? blocks.find((b) => b.endLine >= anchorLine);

      if (target) {
        const list = map.get(target.index);
        if (list) list.push(ann);
        else map.set(target.index, [ann]);
      } else {
        leftover.push(ann);
      }
    }

    return {
      blockEntries: blocks.map((b) => ({
        ...b,
        annotations: map.get(b.index) ?? [],
      })),
      unmatchedAnnotations: leftover,
    };
  }, [ast, annotations]);

  const handleSubmitBlockAnnotation = async (data: {
    comment: string;
  }) => {
    if (!composerRange || !onCreateAnnotation) return;
    const { startLine, endLine } = composerRange;
    const selectedText = doc.lines.slice(startLine - 1, endLine).join("\n");
    const contextBefore = doc.lines
      .slice(Math.max(0, startLine - 3), startLine - 1)
      .join("\n");
    const contextAfter = doc.lines
      .slice(endLine, Math.min(doc.lines.length, endLine + 2))
      .join("\n");

    await onCreateAnnotation({
      startLine,
      endLine,
      selectedText,
      contextBefore,
      contextAfter,
      comment: data.comment,
    });
    setComposerRange(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    if (
      mod &&
      e.shiftKey &&
      (e.key.toLowerCase() === "v" || e.key.toLowerCase() === "p")
    ) {
      e.preventDefault();
      e.stopPropagation();
      cycleMode();
    } else if (
      viewMode !== "raw" &&
      ((mod && e.key === "/") ||
        (mod && e.altKey && e.key.toLowerCase() === "m"))
    ) {
      if (onCreateAnnotation) {
        const range = getBlockLinesFromSelection();
        if (range) {
          e.preventDefault();
          e.stopPropagation();
          setComposerRange(range);
        }
      }
    } else if (e.key === "Escape" && composerRange) {
      e.stopPropagation();
      setComposerRange(null);
    }
  };

  const renderPreviewSurface = () => (
    <div
      ref={previewScrollRef}
      className="md-preview-scroll"
      onScroll={handlePreviewScroll}
    >
      <div className="md-prose">
        {blockEntries.map(({ node, index, startLine, endLine, annotations: blockAnns }) => {
          const gitStatus = detectGitDiffStatusForRange(
            doc.lineGitMarkers,
            startLine,
            endLine,
          );
          const showComposerHere =
            composerRange !== null &&
            composerRange.endLine >= startLine &&
            composerRange.endLine <= endLine;

          return (
            <div
              key={`blk-${index}-${startLine}`}
              data-start-line={startLine}
              data-end-line={endLine}
              className={[
                "md-block-wrap",
                gitStatus === "added"
                  ? "git-added"
                  : gitStatus === "modified"
                    ? "git-modified"
                    : "",
                flashedBlockStart === startLine ? "flash" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              {onCreateAnnotation && (
                <button
                  type="button"
                  className="md-block-gutter-btn"
                  title={`Annotate Markdown lines L${startLine}-${endLine}`}
                  onClick={() => setComposerRange({ startLine, endLine })}
                >
                  +
                </button>
              )}

              {renderBlockNode(node, `node-${index}`)}

              {blockAnns.length > 0 && (
                <AnnotationThreadCard
                  annotations={blockAnns}
                  compact
                  onEdit={onUpdateAnnotation}
                  onResolve={onResolveAnnotation}
                  onUnresolve={onUnresolveAnnotation}
                  onDelete={onDeleteAnnotation}
                />
              )}

              {showComposerHere && composerRange && (
                <div style={{ marginTop: 6 }}>
                  <AnnotationComposer
                    filePath={doc.filePath}
                    side="new"
                    startLine={composerRange.startLine}
                    endLine={composerRange.endLine}
                    selectedPreview={doc.lines
                      .slice(
                        composerRange.startLine - 1,
                        composerRange.endLine,
                      )
                      .join("\n")}
                    onSubmit={handleSubmitBlockAnnotation}
                    onCancel={() => setComposerRange(null)}
                  />
                </div>
              )}
            </div>
          );
        })}

        {unmatchedAnnotations.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <AnnotationThreadCard
              annotations={unmatchedAnnotations}
              compact
              onEdit={onUpdateAnnotation}
              onResolve={onResolveAnnotation}
              onUnresolve={onUnresolveAnnotation}
              onDelete={onDeleteAnnotation}
            />
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div
      ref={rootRef}
      className="md-viewer"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {/* Top 3-Mode JetBrains Bar */}
      <div className="md-toolbar">
        <div className="md-mode-tabs" role="tablist" aria-label="Markdown view mode">
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === "preview"}
            className={`md-mode-tab ${viewMode === "preview" ? "active" : ""}`}
            onClick={() => setViewMode("preview")}
          >
            Preview
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === "split"}
            className={`md-mode-tab ${viewMode === "split" ? "active" : ""}`}
            onClick={() => setViewMode("split")}
          >
            Split ◫
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === "raw"}
            className={`md-mode-tab ${viewMode === "raw" ? "active" : ""}`}
            onClick={() => setViewMode("raw")}
          >
            Raw
          </button>
        </div>

        <div className="md-meta-bar">
          <span>{wordCount.toLocaleString()} words</span>
          <span>·</span>
          <span>{doc.lines.length.toLocaleString()} lines</span>
          {annotations.length > 0 && (
            <>
              <span>·</span>
              <span style={{ color: "var(--unknown)" }}>
                ◆ {annotations.length} notes
              </span>
            </>
          )}
          <span className="kbd-hint">⇧⌘V cycle</span>
        </div>
      </div>

      {/* Mode Body */}
      {viewMode === "preview" && renderPreviewSurface()}

      {viewMode === "raw" && (
        <CodeViewport
          ref={rawCodeRef}
          document={doc}
          symbols={symbols}
          blame={blame}
          showBlame={showBlame}
          annotations={annotations}
          scrollToRequest={scrollToRequest}
          recentlyUpdatedAt={recentlyUpdatedAt}
          onCreateAnnotation={onCreateAnnotation}
          onUpdateAnnotation={onUpdateAnnotation}
          onResolveAnnotation={onResolveAnnotation}
          onUnresolveAnnotation={onUnresolveAnnotation}
          onDeleteAnnotation={onDeleteAnnotation}
          onSymbolActivate={onSymbolActivate}
          onCursorChange={onCursorChange}
          findOpenTrigger={findOpenTrigger}
          annotateTrigger={annotateTrigger}
          fontSizePx={fontSizePx}
        />
      )}

      {viewMode === "split" && (
        <div className="md-split-pane">
          <div className="md-split-raw">
            <CodeViewport
              ref={rawCodeRef}
              document={doc}
              symbols={symbols}
              blame={blame}
              showBlame={showBlame}
              annotations={annotations}
              scrollToRequest={scrollToRequest}
              recentlyUpdatedAt={recentlyUpdatedAt}
              onCreateAnnotation={onCreateAnnotation}
              onUpdateAnnotation={onUpdateAnnotation}
              onResolveAnnotation={onResolveAnnotation}
              onUnresolveAnnotation={onUnresolveAnnotation}
              onDeleteAnnotation={onDeleteAnnotation}
              onSymbolActivate={onSymbolActivate}
              onCursorChange={onCursorChange}
              onVisibleLineChange={handleRawVisibleLineChange}
              findOpenTrigger={findOpenTrigger}
              annotateTrigger={annotateTrigger}
              fontSizePx={fontSizePx}
            />
          </div>
          {renderPreviewSurface()}
        </div>
      )}
    </div>
  );
};
