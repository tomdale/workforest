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
  clean [dir]                  Remove a workspace (or run inside workspace)
  list                         List workspaces
  template list|show|new|...   Manage templates
  config [show|edit|init]      Manage configuration

${chalk.bold("Clean options:")}
  -r, --delete-remote-branches Delete merged remote branches (prompts if not set)
  -f, --force                  Skip confirmation prompts
  -n, --dry-run                Preview without deleting
  --keep-mirrors               Keep cached git mirrors (default: true)

${chalk.bold("Examples:")}
  wf new my-template -d "fixing the auth bug"
  wf new vercel/front vercel/api -d "new feature"
  wf new my-template --dry-run      Preview without creating
  wf list                           Show all workspaces
  wf clean                          Clean current workspace (self-destruct)
  wf clean ./my-workspace -r        Clean and delete merged remote branches
  wf template new my-template org/repo1 org/repo2
  wf config init                    Interactive setup

${chalk.bold("Templates:")}
  ${templateLines.join("\n  ")}

${chalk.dim(`Config:     ${configPath}`)}
${chalk.dim(`Templates:  ${templatesDir}`)}
`;
}
