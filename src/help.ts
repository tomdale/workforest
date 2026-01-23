import chalk from "chalk";
import { loadWorkspaceConfig } from "./config.ts";
import { listTemplates } from "./templates/index.ts";

export async function help(): Promise<string> {
  let configPath = "(unavailable)";
  try {
    const loaded = await loadWorkspaceConfig();
    configPath = loaded.path;
  } catch {
    // Ignore errors
  }

  const templates = await listTemplates();
  const templateText =
    templates.length === 0
      ? `    ${chalk.dim("(none)")}`
      : templates
          .map(
            (t) =>
              `    ${t.id.padEnd(16)}${t.config.description ? chalk.dim(t.config.description) : chalk.dim(t.config.repos.join(", "))}`,
          )
          .join("\n");

  return `
  ${chalk.bold("workforest")} <command> [options]

  ${chalk.dim("Commands:")}

    new [template|org/repo...]   Create a new workspace
    clean [workspace]            Clean up a workspace
    config                       Show config file location
    template                     Manage templates

  ${chalk.bold("workforest new")} [template|org/repo...] [options]

  ${chalk.dim("Options:")}

    --description, -d <text>   Feature name or description (bypasses prompt)
    --help, -h                 Show this help

  ${chalk.dim("Examples:")}

  ${chalk.gray("–")} Create a workspace with a template

    ${chalk.cyan("$ wf new dashboard")}

  ${chalk.gray("–")} Create a workspace with specific repositories

    ${chalk.cyan("$ wf new vercel/front vercel/api")}

  ${chalk.gray("–")} Create a workspace non-interactively

    ${chalk.cyan('$ wf new dashboard -d "Fix auth bug"')}

  ${chalk.bold("workforest clean")} [workspace-dir] [options]

  ${chalk.dim("Clean up a workspace and remove its worktrees from mirrors.")}

  ${chalk.dim("Options:")}

    --keep-mirrors  Don't prune unused mirrors
    --dry-run, -n   Show what would be deleted without deleting
    --force, -f     Skip confirmation prompt
    --help, -h      Show this help

  ${chalk.dim("Examples:")}

  ${chalk.gray("–")} Clean up the current directory

    ${chalk.cyan("$ wf clean")}

  ${chalk.gray("–")} Clean up a specific workspace

    ${chalk.cyan("$ wf clean ~/workspaces/my-feature")}

  ${chalk.gray("–")} Preview what would be deleted

    ${chalk.cyan("$ wf clean --dry-run")}

  ${chalk.dim("Templates:")}

${templateText}

  ${chalk.dim(`Config: ${configPath}`)}
`;
}
