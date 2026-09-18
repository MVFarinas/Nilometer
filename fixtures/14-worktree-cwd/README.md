# 14-worktree-cwd: One repository under three working directories

**Setup:** Sessions in a repo root, its worktree, and a subdirectory. `repo-groups.json` says all three resolve to one repository once the test harness creates `{{REPO}}` as a git repo with a worktree at `{{REPO}}-worktree`.

**Proves:** Request data is ordinary; the grouping is checked by loader tests only.

**Rules:** D-010; skill fixture 14. Expected values in `expected.json` were computed by hand from the setup above.
