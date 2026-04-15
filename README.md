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

# Add another repo to the current workspace later
wf add vercel/docs

# Or save frequently used groups as templates
wf template new full-stack org/frontend org/api
wf new full-stack -d "implementing user avatars"
```

### Interactive Wizard

Run `wf new` without arguments for the interactive wizard:

```bash
wf new
```

The wizard guides you through:

1. **Template selection** — Choose a template or enter repositories manually
2. **Template preview** — See full details before committing to a template
3. **Feature name** — Describe your work in prose or enter a slug directly

When you select a template, you'll see a preview showing repositories, hooks,
and branch prefix. From the preview, you can:

- **Use this template** — Proceed with workspace creation
- **Edit template first** — Modify the template before using it
- **Choose different template** — Go back to template selection

The wizard also provides inline **template management** without leaving the
flow. Select "Manage templates..." to:

- **Create new template** — Start from scratch with the interactive editor
- **Edit existing template** — Modify any saved template
- **Clone and modify** — Copy a template as a starting point for a new one

If no templates exist, the wizard offers to create one before falling back to
manual repository entry.

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

### Adding a Repo Later

If the workspace already exists and you need to bring in another repository,
run `wf add` from inside that workspace:

```bash
cd ~/Code/workspaces/fix-auth-bug
wf add vercel/docs
```

You can also target a workspace explicitly:

```bash
wf add vercel/docs --workspace ~/Code/workspaces/fix-auth-bug
```

The new repo is checked out onto the workspace's existing feature branch, then
the `.workforest` metadata and VS Code workspace file are updated in place.

### Forking a Workspace

When you want to try a different approach without losing your current work, fork
the workspace. This creates a new sibling workspace with the same repos and
template hooks, but with fresh branches off each repo's default branch:

```bash
cd ~/Code/workspaces/fix-auth-bug
wf fork new-approach
```

The fork inherits the branch prefix, directory prefix, and template from the
source workspace. You can also use a description:

```bash
wf fork -d "trying a different strategy"
```

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

  // Optional hooks run after automatic initializers
  "hooks": [
    {
      "name": "Build project",
      "run": "pnpm build",
      "in": ["frontend"],
    },
  ],
}
```

## Automatic Initializers

Workforest automatically detects project configurations and runs setup commands
during workspace creation. Initializers run in priority order before any custom
hooks.

**Built-in initializers:**

| Initializer      | Priority | Detects                                   |
| ---------------- | -------- | ----------------------------------------- |
| `pnpm-install`   | 100      | `pnpm-lock.yaml` or `pnpm-lock.yml`       |
| `yarn-install`   | 101      | `yarn.lock` (no pnpm lockfile)            |
| `npm-install`    | 102      | `package-lock.json` (no pnpm/yarn)        |
| `vercel-link`    | 200      | `vercel.json` or vercel in package.json   |
| `turbo-link`     | 201      | `turbo.json` in repo or workspace root    |

The `vercel-link` initializer is fail-closed. When it can resolve a Vercel
team for a GitHub repo, it runs `vercel link --yes --repo --scope <team>` and
only succeeds if Vercel already has an existing project linked to that GitHub
repository under the chosen team. It will not create a new Vercel project
automatically.

**Disabling initializers:**

You can disable initializers per-template using `disableInitializers`:

```jsonc
{
  "repos": ["org/repo"],

  // Disable all automatic initializers
  "disableInitializers": true,

  // Or disable specific ones
  "disableInitializers": ["vercel-link", "turbo-link"],
}
```

### Hook Configuration

Hooks run shell commands after workspace setup. Each hook supports:

- **name** (required): Description shown during execution
- **run** (required): Shell command to execute
- **in** (optional): Array of repo names to run in (runs in all repos if omitted)
- **if** (optional): Only run if this file exists relative to the repo root
- **continueOnError** (optional): Continue with next hook if this one fails

```jsonc
{
  "hooks": [
    // Run in specific repos
    {
      "name": "Install frontend deps",
      "run": "pnpm install",
      "in": ["frontend"],
    },

    // Conditional execution - only run if file exists
    {
      "name": "Setup database",
      "run": "./scripts/setup-db.sh",
      "if": "scripts/setup-db.sh",
    },

    // Continue even if hook fails
    {
      "name": "Optional optimization",
      "run": "pnpm run optimize",
      "continueOnError": true,
    },

    // Run in all repos (no "in" field)
    {
      "name": "Configure git hooks",
      "run": "git config core.hooksPath .githooks",
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

```jsonc
{
  "defaultDir": "~/Code/workspaces",
  "dirPrefix": "workspace-",
  "branchPrefix": "feature/",
  "vercelLink": {
    "teamByGitHubOwner": {
      "vercel": "vercel",
      "vercel-labs": "vercel-labs"
    },
    "repoOverrides": {
      "vercel/omniagent": {
        "team": "vercel"
      },
      "vercel/internal-only": {
        "disabled": true
      }
    }
  }
}
```

- **defaultDir**: Where workspaces are created
- **dirPrefix**: Prefix for workspace directory names
- **branchPrefix**: Default prefix for feature branch names (can be overridden
  per-template)
- **vercelLink.teamByGitHubOwner**: Optional owner-to-team mappings for
  automatic Vercel repo-linking
- **vercelLink.repoOverrides**: Optional per-repo overrides or disables for
  Vercel auto-linking

Workforest includes built-in Vercel owner defaults for `vercel -> vercel` and
`vercel-labs -> vercel-labs`. Any other owner must be configured explicitly or
automatic Vercel linking is skipped.

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
wf fork <name>                  Fork current workspace with new branches
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

## Troubleshooting

### Git clone fails

**SSH key issues**: Ensure your SSH key is added to the agent:

```bash
ssh-add -l  # List loaded keys
ssh-add ~/.ssh/id_ed25519  # Add your key if missing
```

**Permission denied**: Verify you have access to the repository:

```bash
ssh -T git@github.com  # Test GitHub access
```

### Slow clone times

Initial clones can be slow for large repositories. Workforest uses partial clones
(`--filter=blob:none`) to minimize data transfer. Subsequent workspace creation
is much faster since it reuses cached mirrors.

### "Directory already exists" error

This happens when you try to create a workspace in a directory that already has
content. Either:

- Choose a different feature name/description
- Remove the existing directory: `rm -rf ~/Code/workspaces/existing-name`

### Hooks fail

If a hook command fails, workforest will stop and report the error. Common
issues:

- **Command not found**: Ensure the command is installed and in your PATH
- **File not found**: Check that the `if` condition file path is correct
- **Permission denied**: Make scripts executable: `chmod +x script.sh`

To allow hooks to fail without stopping workspace creation, add
`"continueOnError": true` to the hook.

### Template not found

Templates are stored in `~/.config/workforest/templates/`. List available
templates with:

```bash
wf template list
```

### Cache directory issues

Workforest caches bare mirrors in `~/.cache/workforest/`. If you encounter
issues, you can safely delete this directory—it will be recreated on next use:

```bash
rm -rf ~/.cache/workforest
```
