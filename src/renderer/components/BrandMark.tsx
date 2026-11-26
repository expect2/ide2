import React from "react";

// Exact 43x10 pixel-art wordmark from expect2-site (retrofuture-site branch, src/cells.js & build.mjs):
// lowercase `expect` + knocked-out cursor-`2` block at col 36, with optional 4-colour stepped echo trail.
const PX: Record<string, [number, string[]]> = {
  e: [3, [".###.", "#...#", "#####", "#....", ".####"]],
  x: [3, ["#...#", ".#.#.", "..#..", ".#.#.", "#...#"]],
  p: [3, ["####.", "#...#", "#...#", "#...#", "####.", "#....", "#...."]],
  c: [3, [".####", "#....", "#....", "#....", ".####"]],
  t: [1, [".#...", ".#...", "#####", ".#...", ".#...", ".#...", ".####"]],
  "2": [1, [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"]],
};

const BLOCK_AT = 36;
const LOGO_W = 43;
const LOGO_H = 10;

function buildBitmapPaths(markOnly: boolean): { lettersPath: string; blockPath: string; width: number; height: number } {
  const g: number[][] = Array.from({ length: LOGO_H }, () => Array(LOGO_W).fill(0));
  [..."expect"].forEach((ch, i) => {
    const entry = PX[ch];
    if (!entry) return;
    const [top, rows] = entry;
    rows.forEach((line, r) => {
      [...line].forEach((v, c) => {
        if (v === "#") g[top + r]![i * 6 + c] = 1;
      });
    });
  });
  for (let r = 0; r < LOGO_H; r += 1) {
    for (let c = BLOCK_AT; c < LOGO_W; c += 1) {
      g[r]![c] = 2;
    }
  }
  const two = PX["2"]![1];
  two.forEach((line, r) => {
    [...line].forEach((v, c) => {
      if (v === "#") g[1 + r]![BLOCK_AT + 1 + c] = 0;
    });
  });

  const grid = markOnly ? g.map((r) => r.slice(BLOCK_AT)) : g;
  const P = 10;
  let lettersPath = "";
  let blockPath = "";

  grid.forEach((line, r) => {
    for (let c = 0; c < line.length; ) {
      const v = line[c]!;
      if (!v) {
        c += 1;
        continue;
      }
      let e = c;
      while (e < line.length && line[e] === v) e += 1;
      const seg = `M${c * P} ${r * P}h${(e - c) * P}v${P}h${-(e - c) * P}z`;
      if (v === 1) lettersPath += seg;
      else blockPath += seg;
      c = e;
    }
  });

  return {
    lettersPath,
    blockPath,
    width: (grid[0]?.length ?? LOGO_W) * P,
    height: grid.length * P,
  };
}

const FULL_WORDMARK = buildBitmapPaths(false);
const BARE_MARK = buildBitmapPaths(true);

export const Expect2Wordmark: React.FC<{
  height?: number;
  withTrail?: boolean;
  className?: string;
}> = ({ height = 18, withTrail = true, className }) => {
  const vw = withTrail ? 470 : FULL_WORDMARK.width;
  const vh = withTrail ? 140 : FULL_WORDMARK.height;
  const width = Math.round((vw / vh) * height);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${vw} ${vh}`}
      width={width}
      height={height}
      className={className}
      role="img"
      aria-label="expect2"
      style={{ display: "block", flexShrink: 0 }}
    >
      {withTrail && (
        <>
          <rect x="400" y="40" width="70" height="100" fill="var(--sky)" />
          <rect x="390" y="30" width="70" height="100" fill="var(--unsafe)" />
          <rect x="380" y="20" width="70" height="100" fill="var(--unknown)" />
          <rect x="370" y="10" width="70" height="100" fill="var(--safe)" />
          <rect x="360" y="0" width="70" height="100" fill="var(--paper)" />
        </>
      )}
      <path fill="var(--ink)" d={FULL_WORDMARK.lettersPath} />
      <path fill="var(--ink)" d={FULL_WORDMARK.blockPath} />
    </svg>
  );
};

export const Expect2CursorMark: React.FC<{
  height?: number;
  fill?: string;
  withTrail?: boolean;
}> = ({ height = 14, fill = "var(--ink)", withTrail = false }) => {
  const vw = withTrail ? 110 : BARE_MARK.width;
  const vh = withTrail ? 140 : BARE_MARK.height;
  const width = Math.round((vw / vh) * height);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${vw} ${vh}`}
      width={width}
      height={height}
      role="img"
      aria-label="expect2 mark"
      style={{ display: "block", flexShrink: 0 }}
    >
      {withTrail && (
        <>
          <rect x="40" y="40" width="70" height="100" fill="var(--sky)" />
          <rect x="30" y="30" width="70" height="100" fill="var(--unsafe)" />
          <rect x="20" y="20" width="70" height="100" fill="var(--unknown)" />
          <rect x="10" y="10" width="70" height="100" fill="var(--safe)" />
          <rect x="0" y="0" width="70" height="100" fill="var(--paper)" />
        </>
      )}
      <path fill={fill} d={BARE_MARK.blockPath} />
    </svg>
  );
};

/* Minimal JetBrains New UI-style 16x16 SVG Icons */

export const IconProject: React.FC<{ size?: number }> = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 4.25C2 3.56 2.56 3 3.25 3h3.1l1.4 1.5h5c.69 0 1.25.56 1.25 1.25v6c0 .69-.56 1.25-1.25 1.25h-9.5C2.56 13 2 12.44 2 11.75v-7.5Z" />
  </svg>
);

export const IconStructure: React.FC<{ size?: number }> = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2.5" y="2.5" width="4" height="3.5" rx="0.8" />
    <rect x="9.5" y="6.25" width="4" height="3.5" rx="0.8" />
    <rect x="9.5" y="11" width="4" height="2.75" rx="0.8" />
    <path d="M4.5 6v6.3h5M4.5 8h5" />
  </svg>
);

export const IconGitBranch: React.FC<{ size?: number }> = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="4.5" cy="3.5" r="1.75" />
    <circle cx="4.5" cy="12.5" r="1.75" />
    <circle cx="11.5" cy="5.5" r="1.75" />
    <path d="M4.5 5.25v5.5M11.5 7.25c0 2.5-1.8 3.25-7 3.25" />
  </svg>
);

export const IconAnnotations: React.FC<{ size?: number }> = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 3.5C3 2.95 3.45 2.5 4 2.5h8c.55 0 1 .45 1 1v6.25c0 .55-.45 1-1 1H6.5L3.5 13.5v-2.75H4c-.55 0-1-.45-1-1V3.5Z" />
    <path d="M5.5 6h5M5.5 8.25h3.2" />
  </svg>
);

export const IconSearch: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5L13.5 13.5" />
  </svg>
);

export const IconDiff: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
    <path d="M8 2.5v11M4.2 6h1.6M5 5.2v1.6M10.2 9.5h1.6" />
  </svg>
);

export const IconSplit: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
    <path d="M8 2.5v11" />
  </svg>
);

export const IconExport: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 2.5v7.5M5 5.5L8 2.5l3 3M3 10.5v2c0 .55.45 1 1 1h8c.55 0 1-.45 1-1v-2" />
  </svg>
);

export const IconNewWindow: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
    <path d="M2 5.5h12M8 7.75v3.5M6.25 9.5h3.5" />
  </svg>
);

export const IconWalkthrough: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="8" cy="8" r="6" />
    <polygon points="6.6,6.6 10.8,5.2 9.4,9.4 5.2,10.8" />
  </svg>
);
