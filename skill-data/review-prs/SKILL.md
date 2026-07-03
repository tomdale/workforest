---
name: review-prs
description: Workforest guidance for review workspaces and PR checkout flows.
---

# Review PRs

Use this skill when you need a dedicated review workspace for a pull request.

```sh
wf review vercel/next.js
wf review vercel/next.js#1234
```

Use `wf review --help` for the review workspace syntax.

## Review Flow

- Open the review workspace once with `wf review <repo>`.
- Check out individual PRs as separate worktrees with `wf review <repo>#<pr>`.
- Keep review workspaces separate from normal changes.

## Good Review Hygiene

- Verify the PR branch before making local edits.
- Treat PR worktrees as disposable inspection space.
- Use the review commands rather than manually building paths.
