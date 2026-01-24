# workforest

A CLI tool for creating workspaces of multiple git worktrees.

## Why workforest?

[Git worktrees](https://git-scm.com/docs/git-worktree) let you have multiple
checkouts of a repository simultaneously, helping you juggle between feature
work, code review, and bug fixes without constant stashing or branch switching.
But worktrees only help within a single repository.

I've found that giving coding agents like Claude Code access to the entire
system, like both the frontend and backend repos, is like giving them
superpowers. However, manually setting up groups of multiple worktrees and
getting each repo up and running is a pain in the ass.

Workforest just extends the worktree concept to multi-repo development. It
creates a single directory containing coordinated worktrees with all the repos
you need, each on a consistently-named feature branch, with dependencies
installed and ready to go.

## Installation

```bash
npm install -g workforest
```

Or use npx without installing:

```bash
npx workforest new ...
```

## Quick Start

```bash
# Create a workspace with the frontend and backend repos
# on new branches named after the feature.
wf new vercel/front vercel/api -d "fixing the auth bug"

# Or save frequently used groups as templates
wf template new full-stack org/frontend org/api
wf new full-stack -d "implementing user avatars"
```

This example creates a directory like `user-avatars/` containing:

- Fresh checkouts of each repository
- Feature branches (e.g., `feature/user-avatars`) created from each repo's
  default branch
- Dependencies installed
- A VS Code workspace file for multi-root editing

## Use Cases

### Feature Development Across Repos

When a feature spans your frontend and API, create a workspace that includes
both:

```bash
wf new frontend backend -d "add dark mode support"
```

Both repos get a `dark-mode-support` branch, ready for coordinated development.

### Code Review

Check out someone's PR across multiple repos without switching branches in your
main workspace:

```bash
wf new site -d "reviewing alices pr"
cd reviewing-alices-pr/frontend
gh pr checkout 123
```

While the PR is in the frontend repo, now coding agents have a pristine copy of
the backend repo to reference as they help review the change, providing deeper
context.

## Templates

Templates save your common workspace configurations. Instead of remembering
which repos to include, create a template once:

```bash
# Create a `site` template with the frontend and backend repos
wf template new site org/frontend org/api

# Follow the prompts to name a new template and add repos
wf template new
```

Templates are stored as JSONC files in
`~/.config/workforest/templates/<name>/template.jsonc`:

```jsonc
{
  // Repositories to clone (GitHub shorthand or full git URLs)
  "repos": [
    "my-org/frontend", // GitHub shorthand
    "my-org/api",
    "git@gitlab.com:team/lib.git", // Full URL
  ],

  // Optional description shown in template list
  "description": "Full stack development",

  // Optional branch prefix
  "branchPrefix": "feature/",

  // Optional hooks run after setup
  "hooks": [
    {
      "name": "Install dependencies",
      "run": "pnpm install",
      "in": ["frontend", "api"],
    },
    {
      "name": "Link to Vercel",
      "run": "pnpm run vercel link --yes",
      "in": ["frontend"],
    },
    {
      "name": "Enable remote caching",
      "run": "pnpm turbo link",
      "in": ["frontend", "api"],
    },
  ],
}
```

Repos can be specified as:

- `org/repo` — GitHub shorthand
- `git@host:path/repo.git` — SSH URL
- `https://host/path/repo.git` — HTTPS URL

List your templates:

```bash
wf template list
```

## Configuration

Global settings live in `~/.config/workforest/config.json`:

```json
{
  "defaultDir": "~/Code/workspaces",
  "dirPrefix": "workspace-",
  "branchPrefix": "feature/"
}
```

- **defaultDir**: Where workspaces are created
- **dirPrefix**: Prefix for workspace directory names
- **branchPrefix**: Default prefix for feature branch names (can be overridden
  per-template)

## Performance

Workforest attempts to optimize creating new worktrees as much as possible.

**Cached bare mirrors**: The first time you use a repository, workforest clones
it as a bare mirror to `~/.cache/workforest/`. Subsequent workspaces reuse this
mirror to avoid re-downloading.

**Partial clones**: Mirrors use `--filter=blob:none`, downloading only commits
and trees. File contents are fetched on-demand when you actually access them.
This dramatically reduces initial clone time and disk usage for large repos.

**Git worktrees**: Instead of cloning repos into each workspace, workforest
creates [worktrees](https://git-scm.com/docs/git-worktree) from the cached
mirror. Worktree creation is nearly instant since no data transfer is needed.

**Parallel installation**: Hooks such as dependency installation (pnpm install)
run in parallel.

## Commands

```
wf new [template|repo...]       Create a workspace
wf clean [dir]                  Remove a workspace
wf template list                List templates
wf template new                 Create a template
wf template edit <name>         Edit a template
wf template show <name>         Show template details
wf template rm <name>           Delete a template
wf config                       Show config file location
```

## Building from Source

Requires Node.js 25+ and pnpm.

```bash
# Clone and build
git clone https://github.com/your-org/workforest
cd workforest
pnpm install
pnpm build

# Link globally
pnpm link --global
```

## Cleanup

Remove a workspace and its worktree references:

```bash
wf clean ~/Code/my-workspace
```

Mirrors in `~/.cache/workforest/` are preserved by default—they'll speed up
future workspace creation. To remove everything including mirrors, delete the
cache directory manually.
