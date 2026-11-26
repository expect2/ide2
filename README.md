# ide2

**A fast, read-only desktop IDE built for reviewing AI-authored code across Git worktrees.**

---

## Motivation

The way we write software has changed. When coding agents do most of the typing — often in parallel across multiple Git worktrees — your job shifts from editing text to **navigating the codebase, inspecting diffs, reading specs and plans, and steering the agent with clear feedback**.

Traditional IDEs weren't built for this loop:

- **They assume you're editing**, filling the screen with refactorings, formatters, and write-heavy tooling while competing with your agents for filesystem and Git index locks.
- **They treat worktrees as an afterthought**, forcing you to juggle separate windows or lose track of which branch an agent is touching right now.
- **They make reviewing specs and giving agent feedback clunky**, leaving you copying file paths, line ranges, and snippets by hand into a terminal prompt.

`ide2` is a dedicated companion for agent-driven development: open any Git repository from your terminal, inspect every worktree and diff at a glance, annotate code or Markdown directly, and export structured feedback back to your coding agent in one keystroke.

---

## Principles

1. **Strictly read-only & lock-safe** — `ide2` never edits source files, never stages changes, and never mutates Git state. Every Git command runs with `--no-optional-locks`, so it will never collide with an agent running in the same worktree.
2. **Worktrees as a first-class unit** — Parallel agent branches belong in one place. All worktrees of the opened repository appear in an always-visible strip with independent tab sessions, live file-change indicators, and instant switching.
3. **Closed feedback loop with your agent** — Annotations are stored outside your repository (`~/.expect2-ide/`), automatically re-anchor when the agent shifts lines above them, and compile into a clean Markdown **Feedback Prompt** ready to paste or pipe straight into your agent.
4. **Familiar, keyboard-first navigation** — Built around JetBrains shortcuts (`Shift+Shift`, `⌘⇧O`, `⌘E`, `⌘⇧F`, `⌘B`, `⌘D`, `F7`) so you can jump across files, symbols, diffs, and worktrees without taking your hands off the keyboard.
5. **Fast by default** — Virtualized code and diff viewports, native `ripgrep` full-repo search, Tree-sitter symbol outlines, and live filesystem watching without heavy IDE indexing overhead.

---

## Key Features

### Multi-Worktree Git & Diffs
- Automatically discovers all worktrees belonging to the opened repository (including `.claude/worktrees/*` and sibling checkouts) while excluding unrelated repos.
- Always-visible **Worktree Strip** with live activity indicators, changed-file counts, and per-worktree tab sessions.
- Four diff scopes in both **Split** and **Unified** views with intra-line word diffs and `F7` / `⇧F7` hunk navigation:
  - **Branch vs Base** (`merge-base` ↔ working tree — ideal for reviewing an entire agent task)
  - **Working Tree vs HEAD** (uncommitted and untracked changes)
  - **Commit** (inspect any commit from the Git log)
  - **Worktree vs Worktree** (compare two agent worktrees side by side)
- Create new linked worktrees directly from the top bar (`+ Worktree`) or copy a worktree's path / `cd` command with one click.

### Inline Annotations & Agent Feedback Prompt
- Annotate any single line, multi-line selection, deleted diff line, or Markdown block with free-text Markdown notes (`⌘/` / `Ctrl+/` or the gutter `+` button).
- Add high-level worktree instructions in the **Annotations** tool window (`⌘6` / `Alt+6`).
- **Drift-resilient anchoring** — when an agent edits earlier lines in a file, open annotations automatically shift to the new line numbers (or flag as `OUTDATED` if the anchored lines themselves were rewritten).
- Export all open annotations for the active worktree as a clean Markdown prompt via `⇧⌘C` (`Ctrl+Shift+C`), preview & customize via `⇧⌘E` (`Ctrl+Shift+E`), or print to `stdout` from the CLI with `ide2 --export`.

### First-Class Markdown Viewer
- Switch smoothly between **Preview**, **Split** (scroll-synced), and **Raw** (`⇧⌘V` / `Ctrl+Shift+V`).
- Renders GitHub Flavored Markdown (tables, task lists, callout alerts), YAML frontmatter, Mermaid diagrams (with zoom modal), and local repository images.
- Clickable repo-relative links (including `#heading` anchors and `file.ts:42` line jumps) open directly inside `ide2`.
- Annotate rendered blocks right inside Preview — annotations map back to exact raw file line numbers.

### Navigation, Search & Multi-Window Support
- **Search Everywhere** (`Shift+Shift`), **Go to File** (`⇧⌘O` / `Ctrl+Shift+O`, press again to expand across all worktrees), **Go to Symbol** (`⌥⌘O` / `Ctrl+Alt+O`), and **Recent Files / Switcher** (`⌘E` / `Ctrl+E`).
- **Find in Path** (`⇧⌘F` / `Ctrl+Shift+F`) powered by `ripgrep` with case, whole-word, regex, file-mask, and all-worktrees filters plus live surrounding-line preview.
- **Structure** outline (`⌘7` / `Alt+7`), sticky enclosing-symbol header, **Go to Declaration** (`⌘B` / `Ctrl+B`), **Find Usages** (`⌥F7` / `Alt+F7`), and optional inline Git blame.
- **Tab ergonomics**: JetBrains-style right-click context menu (pin/unpin, close others/left/right/unmodified, split right/down, copy path, open in diff, locate in Project tree).
- **Multiple projects**: Open additional repositories in separate windows via **Window → Open Project in New Window…** (`⇧⌘N` / `Ctrl+Shift+N`), the top-bar project switcher, or `ide2 /path/to/repo`.

---

## Install

Works on **macOS**, **Linux**, and **Windows** (Git Bash / WSL).

### Prerequisites

- [Git](https://git-scm.com/)
- [Bun](https://bun.sh/) (installed automatically by `install.sh` if missing) and/or [Node.js](https://nodejs.org/)

### Install from source

```bash
git clone https://github.com/expect2/expect2-ide.git
cd expect2-ide
./install.sh
```

`install.sh` installs dependencies, builds the app, and installs the `ide2` command onto your `PATH` (typically `~/.local/bin/ide2`). To choose a specific directory:

```bash
IDE2_BIN_DIR=~/.local/bin ./install.sh
```

---

## CLI Usage

Run `ide2` inside any Git repository or worktree:

```bash
ide2                          # Open the repo/worktree of the current directory
ide2 /path/to/repo            # Open a specific repository or worktree
ide2 src/auth/session.ts:141  # Open a file and jump straight to line 141
ide2 --diff                   # Launch directly in Branch Diff review mode
ide2 --base develop           # Override the base branch used for diffs
ide2 --worktree api-v2        # Focus a specific worktree by name or path
ide2 --export                 # Print the active worktree's Feedback Prompt to stdout
ide2 --export --resolve       # Print the Feedback Prompt and mark annotations resolved
```

| Flag | Description |
| --- | --- |
| `-d, --diff` | Open in Diff Review mode |
| `-b, --base <ref>` | Override the base branch ref for diffing (e.g. `main`) |
| `-w, --worktree <name>` | Select a worktree by name, branch, or path |
| `--export` | Compile and print the Markdown Feedback Prompt to stdout (headless) |
| `--resolve` | Used with `--export` to mark exported annotations as resolved |
| `--wait` | Wait until the `ide2` window closes before returning |
| `-v, --version` | Print version |
| `-h, --help` | Print help |

---

## Example Feedback Prompt

Running `⇧⌘C` (`Ctrl+Shift+C`) or `ide2 --export` produces a self-contained prompt you can paste directly into your coding agent:

````markdown
# Code Review Feedback — `wt-agent-a`

- **Worktree:** `/path/to/repo/.claude/worktrees/wt-agent-a`
- **Branch:** `feat/agent-a` @ `a1b2c3d` (base: `main` @ `9f8e7d6`)

## Overall Notes

Ensure all auth middleware paths enforce strict Bearer token validation.

---

## 1. `src/auth.ts:16-18`
```ts
16 |   const [scheme, token] = trimmed.split(' ');
17 |   if (scheme !== 'Bearer') return null;
18 |   return { userId: token.slice(0, 12), role: 'user' };
```
Guard against undefined `token` before calling `token.slice(0, 12)`.
````

---

## Keyboard Shortcuts

| Action | macOS | Linux / Windows |
| --- | --- | --- |
| Search Everywhere | `⇧⇧` | `Shift+Shift` |
| Go to File (press again for All Worktrees) | `⇧⌘O` / `⌘O` | `Ctrl+Shift+O` / `Ctrl+O` |
| Go to Symbol | `⌥⌘O` | `Ctrl+Alt+O` |
| Recent Files & Switcher | `⌘E` | `Ctrl+E` |
| Find in Path | `⇧⌘F` | `Ctrl+Shift+F` |
| Find in File | `⌘F` | `Ctrl+F` |
| Go to Line:Column | `⌘L` | `Ctrl+L` |
| Go to Declaration / Usages | `⌘B` / `⌥F7` | `Ctrl+B` / `Alt+F7` |
| Navigate Back / Forward | `⌘[` / `⌘]` | `Ctrl+Alt+Left` / `Right` |
| Toggle Diff View | `⌘D` | `Ctrl+D` |
| Next / Previous Diff Change | `F7` / `⇧F7` | `F7` / `Shift+F7` |
| Cycle Markdown Mode (Preview / Split / Raw) | `⇧⌘V` | `Ctrl+Shift+V` |
| Annotate Line or Selection | `⌘/` | `Ctrl+/` |
| Copy Feedback Prompt | `⇧⌘C` | `Ctrl+Shift+C` |
| Preview & Export Feedback Prompt | `⇧⌘E` | `Ctrl+Shift+E` |
| Switch Worktree | `⇧⌘W` | `Ctrl+Shift+W` |
| Open Project in New Window | `⇧⌘N` | `Ctrl+Shift+N` |
| Tool Windows: Project / Annotations / Structure / Git | `⌘1` / `⌘6` / `⌘7` / `⌘9` | `Alt+1` / `Alt+6` / `Alt+7` / `Alt+9` |
| Split Editor Right / Close Tab | `⌘\` / `⌘W` | `Ctrl+\` / `Ctrl+W` |

---

## Development

```bash
bun install           # Install dependencies
bun run build         # Build main, worker, preload, renderer, and CLI bundles
bun run typecheck     # Run TypeScript typechecking
bun test              # Run the test suite
bun start             # Build and launch ide2 on the current repository
```

---

## License

[MIT](./LICENSE)
