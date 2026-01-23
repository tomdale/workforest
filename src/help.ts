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
    config               Edit configuration (TUI)

  ${chalk.dim("Options (for new command):")}

    --with <template|org/repo[+...]>   Repositories to include
    --help, -h                         Show this help

  ${chalk.dim("Examples:")}

  ${chalk.gray("-")} Create a workspace with specific repositories

    ${chalk.cyan("$ wf new my-feature --with vercel/front+vercel/agents")}

  ${chalk.gray("-")} Create a workspace using a template

    ${chalk.cyan("$ wf new my-feature --with @dashboard")}

  ${chalk.dim("Templates:")}

${templateText}

  ${chalk.dim(
    `If no --with selection is provided, the default selection "${defaultSelection}" is used. Config is loaded from ${configPath}.`,
  )}
`;
}
