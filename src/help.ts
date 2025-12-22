import chalk from "chalk";
import { getDefaultRepoTokens, getRepoAliases } from "./config.ts";

export const help = () => {
  const aliases = getRepoAliases();
  const aliasEntries = Object.entries(aliases);
  const aliasText =
    aliasEntries.length === 0
      ? `    ${chalk.dim("(none)")}`
      : aliasEntries
          .map(
            ([alias, repos]) =>
              `    ${alias.padEnd(12)}${chalk.dim("->")} ${repos.join(", ")}`,
          )
          .join("\n");

  const defaultTokens = getDefaultRepoTokens();
  const defaultSelection =
    defaultTokens.length > 0 ? defaultTokens.join(" ") : chalk.dim("(none)");

  return `
  ${chalk.bold("vercel-workspace")} <feature-name> [repo|alias ...]

  ${chalk.dim("Examples:")}

  ${chalk.gray("–")} Create a workspace with specific repositories

    ${chalk.cyan("$ vercel-workspace my-feature front api agents")}

  ${chalk.gray("–")} Create a workspace using an alias

    ${chalk.cyan("$ vercel-workspace my-feature @dashboard agents")}

  ${chalk.dim("Aliases:")}

${aliasText}

  ${chalk.dim(
    `If no repos or aliases are provided, the default selection "${defaultSelection}" is used. Each repo name maps to git@github.com:vercel/<name>.git and is cloned from cached bare mirrors under $XDG_CACHE_HOME/vercel-workspace.`,
  )}
`;
};
