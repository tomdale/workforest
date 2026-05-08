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
  cd <name>                    Jump to a workspace in defaultDir
  add <repo...>                Add repo(s) to an existing workspace
  fork <name>                  Fork current workspace with new branches
  clean [dir]                  Remove a workspace (or run inside workspace)
  list                         List workspaces
  init [shell]                 Print shell integration for auto-cd and completion
  template list|show|info|...  Manage templates
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
  wf cd fix-auth-bug                Jump into an existing workspace
  wf add vercel/docs               Add a repo from inside a workspace
  wf add vercel/docs -w ./my-ws    Add a repo to a specific workspace
  wf fork new-approach              Fork workspace with new branch names
  eval "$(wf init zsh)"            Auto-cd + zsh completion for workspace commands
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
