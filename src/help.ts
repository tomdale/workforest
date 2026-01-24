import chalk from "chalk";
import { loadWorkspaceConfig } from "./config.ts";
import { getTemplatesDir, listTemplates } from "./templates/index.ts";

export async function help(): Promise<string> {
  let configPath = "(unavailable)";
  try {
    const loaded = await loadWorkspaceConfig();
    configPath = loaded.path;
  } catch {
    // Ignore errors
  }

  const templatesDir = getTemplatesDir();
  const templates = await listTemplates();
  const templateLines =
    templates.length === 0
      ? [chalk.dim("(none)")]
      : templates.map(
          (t) =>
            `${t.id.padEnd(16)}${chalk.dim(t.config.description ?? t.config.repos.join(", "))}`,
        );

  return `
${chalk.bold("Usage:")} wf <command> [options]

${chalk.bold("Commands:")}
  new [template|repo...]       Create a workspace
  clean [dir]                  Remove a workspace
  template list|new|edit|rm    Manage templates
  config                       Show config location

${chalk.bold("Examples:")}
  wf new my-template
  wf new vercel/front vercel/api
  wf new git@gitlab.com:org/repo.git
  wf new my-template -d "fixing the auth bug"
  wf template new my-template org/repo1 org/repo2

${chalk.bold("Templates:")}
  ${templateLines.join("\n  ")}

${chalk.dim(`Config:     ${configPath}`)}
${chalk.dim(`Templates:  ${templatesDir}`)}
`;
}
