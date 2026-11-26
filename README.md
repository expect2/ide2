# ide2

**A fast, read-only desktop IDE for reviewing AI-authored code across Git worktrees.**

When coding agents write code across parallel Git worktrees, you don't need another editor fighting them for file locks — you need a fast way to navigate the codebase, review diffs, read Markdown specs, and send precise feedback back to your agent.

`ide2` gives you familiar JetBrains navigation, multi-worktree awareness, a built-in Markdown reader, and line-anchored annotations that export as a clean Markdown prompt you can paste straight into your coding agent.

---

## Why ide2?

- **Strictly read-only & lock-safe** — Never modifies files in your repository, never stages or commits, and invokes Git with `--no-optional-locks` so it never collides with an agent working in the same tree.
- **Built for parallel Git worktrees** — Automatically discovers all worktrees of the opened repository (including `.claude/worktrees/*` and sibling checkouts), keeps independent tab sessions per worktree, watches for live agent edits, and lets you diff **Branch vs Base**, **Working Tree vs HEAD**, individual **Commits**, or **Worktree vs Worktree**.
- **Annotations → Agent Feedback Prompt** — Leave free-text notes on any code line, line range, diff deletion, or Markdown block. Notes are stored outside your repository (`~/.expect2-ide/`) and automatically re-anchor when the agent shifts lines above them. Copy everything as a structured Markdown prompt with one shortcut (`⇧⌘C` / `Ctrl+Shift+C`) or pipe it from your terminal with `ide2 --export`.
- **First-class Markdown viewer** — Switch between **Preview**, **Split**, and **Raw** (`⇧⌘V` / `Ctrl+Shift+V`) with GFM tables, GitHub alerts, YAML frontmatter, Mermaid diagrams, clickable repo-relative links, and inline block annotations.
- **JetBrains-style navigation & search** — `Shift+Shift` Search Everywhere, fuzzy file jump, ripgrep full-repo Find in Path, Tree-sitter AST structure & Go to Declaration / Find Usages, pinned tabs, tab right-click menu, and split panes.
- **Multi-project windows** — Open multiple repositories side by side in separate windows via **Window → Open Project in New Window…** (`⇧⌘N` / `Ctrl+Shift+N`), the top-bar project switcher, or `ide2 /path/to/repo`.

---

## Install

Works on **macOS**, **Linux**, and **Windows** (Git Bash / WSL).

### Prerequisites

- [Git](https://git-scm.com/)
- [Bun](https://bun.sh/) (if not installed, `install.sh` can install it automatically) and/or [Node.js](https://nodejs.org/)

### From source

```bash
git clone https://github.com/expect2/expect2-ide.git
cd expect2-ide
./install.sh
```

`install.sh` installs dependencies, builds `ide2`, and installs the `ide2` command into your `PATH` (typically `~/.local/bin/ide2`).

To install to a custom bin directory:

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

### Options

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

## Review & Feedback Workflow

1. **Inspect changes** across worktrees in the top Worktree Strip or the **Git** panel (`⌘9` / `Alt+9`).
2. **Annotate** any line, selection, diff hunk, or Markdown section with `⌘/` (`Ctrl+/`) or the gutter `+` button. Add optional high-level worktree instructions in the **Annotations** panel (`⌘6` / `Alt+6`).
3. **Export to your coding agent** via `⇧⌘C` (`Ctrl+Shift+C`), preview & customize via `⇧⌘E` (`Ctrl+Shift+E`), or run `ide2 --export` directly from the terminal.

Example exported prompt:

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
