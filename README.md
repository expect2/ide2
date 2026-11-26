# ide2

Read-only, dark-mode-only IDE by `expect2` designed for the AI coding era — where code is written by external coding agents across parallel Git worktrees, and the human developer navigates, reviews diffs, reads specs/docs, and exports structured Markdown **Feedback Prompts**.

- **JetBrains Ergonomics, Zero VIM Modalism:** `Shift+Shift` Search Everywhere, `Cmd/Ctrl+Shift+O` Go to File (double-tap for All Worktrees), `Cmd/Ctrl+E` Recent Files, `Cmd/Ctrl+Shift+F` Find in Path, `Cmd/Ctrl+B` Go to Declaration/Usages, `Cmd/Alt+1` Project, `Cmd/Alt+7` Structure, `Cmd/Alt+9` Git & Worktrees, `Cmd/Alt+6` Annotations, `Cmd/Ctrl+D` Diff, `F7` Next Change.
- **`expect2` Retrofuture Night Visual System:** `#05081a` / `#0a0f2c` deep night ground, bundled `Kode Mono`, square `1px`/`2px` HUD chrome, VIM-dense gutter & statusline, restrained cold-tonal syntax highlighting, and sacred semantic verdict colors (`#6dffa6` / `#ff5d4d` / `#ffe45c`) reserved strictly for Git diffs & annotations.
- **Multi-Worktree Native:** Always-visible top Worktree Strip with live agent activity indicator (`◻ ▣ ◼ ▣`), per-worktree tab sessions, `Branch vs Base` / `Working Tree` / `Cross-Worktree` diffs.
- **First-Class Markdown Viewer:** `Preview` / `Split` / `Raw` (`Cmd/Ctrl+Shift+V`), GFM tables, alerts, YAML frontmatter, offline Mermaid diagrams, repo-internal navigation links, and direct block-level annotation inside rendered Preview mapped back to raw file line numbers.
- **Obsidian-Style Performance (macOS, Linux, Windows):** Electron + TypeScript + bundled native Rust `@vscode/ripgrep` + hot in-RAM worktree/symbol caches + virtualized 120fps viewports.

## Install

```bash
./install.sh
```

## CLI Usage

```bash
ide2                          # Open repo/worktree of current directory
ide2 /path/to/repo            # Open specific repository or worktree
ide2 src/auth/session.ts:141  # Open file and jump straight to line 141
ide2 --diff                   # Launch straight into Branch Diff Review mode
ide2 --worktree api-v2        # Focus named worktree on launch
ide2 --export                 # Print active worktree's Markdown Feedback Prompt to stdout
```

## Development

```bash
bun install
bun run build
bun test
bun start
```
