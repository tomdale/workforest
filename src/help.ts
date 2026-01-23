import chalk from "chalk";
import { loadWorkspaceConfig } from "./config.ts";
import type { WorkspaceConfig } from "./types.ts";

export async function help(): Promise<string> {
  let config: WorkspaceConfig = {};
  let configPath = "(unavailable)";
  try {
    const loaded = await loadWorkspaceConfig();
    config = loaded.config;
    configPath = loaded.path;
  } catch {
    config = { aliases: {}, defaultRepos: [] };
  }
  const templates = config.aliases ?? {};
  const templateEntries = Object.entries(templates);
  const templateText =
    templateEntries.length === 0
      ? `    ${chalk.dim("(none)")}`
      : templateEntries
          .map(
            ([name, repos]) =>
              `    ${name.padEnd(12)}${chalk.dim("->")} ${repos.join(", ")}`,
          )
          .join("\n");

  const defaultTokens = config.defaultRepos ?? [];
  const defaultSelection =
    defaultTokens.length > 0 ? defaultTokens.join("+") : chalk.dim("(none)");

  return `
  ${chalk.bold("workforest")} <command> [options]

  ${chalk.dim("Commands:")}

    new <feature-name>   Create a new workspace
    clean [workspace]    Clean up a workspace
    config               Show config file location

  ${chalk.bold("workforest new")} <feature-name> [options]

  ${chalk.dim("Options:")}

    --with <template|org/repo[+...]>   Repositories to include
    --template <template-id>           Apply template after workspace creation
    --help, -h                         Show this help

  ${chalk.dim("Examples:")}

  ${chalk.gray("–")} Create a workspace with specific repositories

    ${chalk.cyan("$ wf new my-feature --with vercel/front+vercel/agents")}

  ${chalk.gray("–")} Create a workspace using a template

    ${chalk.cyan("$ wf new my-feature --with @dashboard")}

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

  ${chalk.dim(
    `If no --with selection is provided, the default selection "${defaultSelection}" is used. Config is loaded from ${configPath}.`,
  )}
`;
}
