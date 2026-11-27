---
name: ide2-pr-checks
description: GitHub PR & CI Checks Lens inside ide2 — surfaces failing GitHub Actions check runs and inline file:line annotations directly in ide2 diffs and review prompts.
---

# ide2 GitHub PR & CI Checks Lens (`pr-checks`)

The `pr-checks` plugin automatically inspects the active worktree's GitHub Pull Request via `gh`, renders inline CI annotations on code and diff lines inside `ide2`, and appends failing check summaries when the developer sends review feedback via `ide2 review wait`.
