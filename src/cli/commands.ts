import type {
  AliasDefinition,
  Cardinality,
  CommandExample,
  CommandGroup,
  CommandLeaf,
  CommandNode,
  CommandRegistry,
  FlagDefinition,
  HelpReference,
  OperandSpec,
  OutputMode,
  ShellHandoff,
  TtyRequirement,
  Visibility,
} from "./types.ts";

const visible: Visibility = "visible";
const hidden: Visibility = "hidden";
const noTty: TtyRequirement = { kind: "none" };
const optionalStdin: TtyRequirement = {
  kind: "optional",
  streams: ["stdin"],
};
const requiredStdin: TtyRequirement = {
  kind: "required",
  streams: ["stdin"],
};

function booleanFlag(
  name: string,
  long: `--${string}`,
  short?: `-${string}`,
  description?: string,
): FlagDefinition {
  return {
    name,
    long,
    kind: "boolean",
    ...(short ? { short } : {}),
    ...(description ? { description } : {}),
  };
}

function stringFlag(
  name: string,
  long: `--${string}`,
  valueName: string,
  options: {
    short?: `-${string}`;
    required?: boolean;
    description?: string;
  } = {},
): FlagDefinition {
  return {
    name,
    long,
    kind: "string",
    valueName,
    ...(options.short ? { short: options.short } : {}),
    ...(options.required ? { required: true } : {}),
    ...(options.description ? { description: options.description } : {}),
  };
}

function cardinality(
  min: number,
  max: number | null,
  label = "operands",
  usage?: string,
  description?: string,
): Cardinality {
  return {
    min,
    max,
    label,
    ...(usage ? { usage } : {}),
    ...(description ? { description } : {}),
  };
}

function operands(
  min: number,
  max: number | null,
  label = "operands",
  usage?: string,
  description?: string,
): OperandSpec {
  return {
    variants: [
      {
        beforeDoubleDash: cardinality(min, max, label, usage, description),
        delimiter: "forbidden",
      },
    ],
  };
}

function leaf(options: {
  name: string;
  path: readonly string[];
  summary: string;
  description?: string;
  handler: string;
  help: HelpReference;
  operands?: OperandSpec;
  aliases?: readonly AliasDefinition[];
  flags?: readonly FlagDefinition[];
  examples?: readonly CommandExample[];
  outputModes?: readonly OutputMode[];
  tty?: TtyRequirement;
  shellHandoff?: ShellHandoff;
  visibility?: Visibility;
}): CommandLeaf {
  return {
    kind: "leaf",
    name: options.name,
    path: options.path,
    aliases: options.aliases ?? [],
    visibility: options.visibility ?? visible,
    summary: options.summary,
    ...(options.description ? { description: options.description } : {}),
    help: options.help,
    operands: options.operands ?? operands(0, 0),
    flags: options.flags ?? [],
    examples: options.examples ?? [],
    outputModes: options.outputModes ?? ["human"],
    tty: options.tty ?? noTty,
    shellHandoff: options.shellHandoff ?? "none",
    handler: options.handler,
  };
}

function group(options: {
  name: string;
  path: readonly string[];
  summary: string;
  description?: string;
  help: HelpReference;
  children: readonly CommandNode[];
  default?: CommandLeaf;
  aliases?: readonly AliasDefinition[];
  visibility?: Visibility;
}): CommandGroup {
  return {
    kind: "group",
    name: options.name,
    path: options.path,
    aliases: options.aliases ?? [],
    visibility: options.visibility ?? visible,
    summary: options.summary,
    ...(options.description ? { description: options.description } : {}),
    help: options.help,
    children: options.children,
    ...(options.default ? { default: options.default } : {}),
  };
}

function nestedHelp(command: string, subcommand: string): HelpReference {
  return { kind: "nested", command, subcommand };
}

const workspaceCreateOperands: OperandSpec = {
  variants: [
    {
      beforeDoubleDash: cardinality(0, 0),
      delimiter: "forbidden",
      when: { flag: "like", present: false, interactive: true },
    },
    {
      beforeDoubleDash: cardinality(
        1,
        null,
        "templates or repositories",
        undefined,
        "A template name, or one or more repositories as a cached repo name, `org/repo` GitHub shorthand, or full git URL.",
      ),
      delimiter: "required",
      afterDoubleDash: cardinality(
        1,
        null,
        "work words",
        undefined,
        "Free-text after `--` describing the work; becomes the workspace name and branch.",
      ),
      when: { flag: "like", present: false, interactive: false },
    },
    {
      beforeDoubleDash: cardinality(0, 0),
      delimiter: "required",
      afterDoubleDash: cardinality(1, null, "work words"),
      when: { flag: "like", present: true },
    },
  ],
};

const workspaceDeleteFlags = [
  booleanFlag(
    "dryRun",
    "--dry-run",
    "-n",
    "Show what would be removed without deleting anything.",
  ),
  booleanFlag(
    "force",
    "--force",
    "-f",
    "Skip the confirmation prompt; required to proceed without a terminal.",
  ),
  booleanFlag(
    "deleteMirrors",
    "--delete-mirrors",
    undefined,
    "Also remove the cached bare mirror, not just the worktree; it must be re-cloned next time.",
  ),
  booleanFlag(
    "deleteRemoteBranches",
    "--delete-remote-branches",
    "-r",
    "Also delete each repository's merged feature branch from its remote.",
  ),
] as const;

const configDefault = leaf({
  name: "",
  path: ["config"],
  summary: "Show configuration",
  description:
    "Prints the resolved global configuration and the path of the `config.json` it read. This is what `wf config` runs with no subcommand.",
  handler: "config.show",
  help: { kind: "command", command: "config" },
  outputModes: ["report"],
});

const skillsDefault = leaf({
  name: "",
  path: ["skills"],
  summary: "List bundled agent skills",
  description:
    "Lists the available bundled skills with their names and descriptions. This is what `wf skills` runs with no subcommand.",
  handler: "skills.list",
  help: { kind: "command", command: "skills" },
  flags: [
    booleanFlag(
      "json",
      "--json",
      undefined,
      "Emit the skill list as a JSON envelope instead of the report.",
    ),
  ],
  outputModes: ["report", "json"],
});

const changeList = leaf({
  name: "list",
  path: ["list"],
  summary: "List Workforest changes",
  description:
    "Shows a compact inventory of Workforest-managed workspace and repository changes, grouped by their human-facing directory layout.",
  handler: "change.list",
  help: { kind: "command", command: "list" },
  flags: [
    stringFlag("repo", "--repo", "repo", {
      description: "Show only changes containing this repository.",
    }),
    stringFlag("group", "--group", "group", {
      description:
        "Show one workspace recipe group, repository group, or _adhoc.",
    }),
    booleanFlag(
      "paths",
      "--paths",
      undefined,
      "Include the absolute path for each change.",
    ),
    booleanFlag(
      "json",
      "--json",
      undefined,
      "Emit the change inventory as a JSON envelope instead of the report.",
    ),
  ],
  examples: [
    {
      command: "wf list",
      description: "Show all workspace and repository changes.",
    },
    {
      command: "wf list --repo workforest",
      description: "Show changes containing the workforest repository.",
    },
    {
      command: "wf list --group _adhoc --paths",
      description: "Show _adhoc workspace changes with paths.",
    },
  ],
  outputModes: ["report", "json"],
});

const workspaceCreate = leaf({
  name: "create",
  path: ["workspace", "create"],
  summary: "Create a workspace",
  description:
    "Sets up a workspace directory with a git worktree per repository from a cached bare mirror, then runs the template's hooks; repository setup continues in the background, tracked by `wf workspace status`. In a terminal with no arguments, prompts interactively; without a TTY, arguments are required — one or more repositories or a template, then `--`, then the work words — and omitting them is a usage error. The work words name the workspace and its branch. Changes your shell's directory to the new workspace under shell integration. Also available as `wf new`.",
  handler: "workspace.create",
  help: nestedHelp("workspace", "create"),
  operands: workspaceCreateOperands,
  flags: [
    stringFlag("like", "--like", "workspace", {
      description:
        "Reuse another workspace's repository set instead of naming repos or a template; pass `current` to reuse the workspace you are in, with the work words after `--`.",
    }),
    stringFlag("description", "--description", "description", {
      short: "-d",
      description:
        "Set the workspace description; otherwise derived from the work words.",
    }),
    booleanFlag(
      "dryRun",
      "--dry-run",
      "-n",
      "Show the workspace, branch, and repositories that would be created without writing anything.",
    ),
  ],
  examples: [
    {
      command: 'wf workspace create vercel/next.js -- "update docs"',
      description:
        "Create a workspace with one repository, on a branch named for the work.",
    },
    {
      command: 'wf workspace create <template> -- "fix login bug"',
      description: "Create a workspace from a saved template's repository set.",
    },
    {
      command: 'wf workspace create --like current -- "try another approach"',
      description:
        "Reuse the current workspace's repositories in a fresh workspace.",
    },
  ],
  outputModes: ["interactive", "report"],
  tty: optionalStdin,
  shellHandoff: "optional-cd",
});

const workspaceDelete = leaf({
  name: "delete",
  path: ["workspace", "delete"],
  summary: "Delete a workspace",
  description:
    "Removes the workspace directory and the git worktrees inside it; with `-r` it also deletes each repository's merged feature branch from its remote, and with `--delete-mirrors` it also removes the cached bare mirrors. Shows a preview and prompts for confirmation in a terminal; without a TTY it refuses unless `--force` is passed, exiting 1. If you delete the workspace you are currently inside, your shell moves to the parent directory under shell integration. Also available as `wf clean`.",
  handler: "workspace.delete",
  help: nestedHelp("workspace", "delete"),
  operands: operands(
    1,
    1,
    "workspace",
    undefined,
    "The workspace to delete, as a path to its directory or a workspace name resolved under `defaultDir`.",
  ),
  flags: workspaceDeleteFlags,
  examples: [
    {
      command: "wf workspace delete <workspace>",
      description:
        "Preview and confirm removal of a workspace and its worktrees.",
    },
    {
      command: "wf workspace delete <workspace> --force",
      description:
        "Delete without prompting, for scripts or a non-interactive shell.",
    },
    {
      command: "wf workspace delete <workspace> -r --delete-mirrors",
      description: "Also delete merged remote branches and the cached mirrors.",
    },
  ],
  outputModes: ["human", "report"],
  tty: optionalStdin,
  shellHandoff: "optional-cd",
});

export const commandRegistry: CommandRegistry = {
  shortcuts: [
    {
      name: "new",
      target: ["workspace", "create"],
      visibility: visible,
      summary: "Create a workspace",
      help: { kind: "command", command: "new" },
    },
    {
      name: "clean",
      target: ["workspace", "delete"],
      visibility: visible,
      summary: "Delete a workspace",
      help: { kind: "command", command: "clean" },
    },
  ],
  root: group({
    name: "",
    path: [],
    summary: "Workforest command line interface",
    help: { kind: "root" },
    children: [
      changeList,
      group({
        name: "workspace",
        path: ["workspace"],
        summary: "Manage workspaces",
        description:
          "Create, open, inspect, and delete workspaces — directories holding one git worktree per repository, set up from a template or repo set. See also `wf task` (temporary worktrees inside a workspace), `wf worktree` (standalone worktrees), and `wf review` (review workspaces for PRs).",
        help: { kind: "command", command: "workspace" },
        children: [
          workspaceCreate,
          workspaceDelete,
          leaf({
            name: "open",
            path: ["workspace", "open"],
            summary: "Open a workspace",
            description:
              "Resolves a workspace and changes your shell's directory to it under shell integration; as the bare binary it prints `cd <path>` instead. Given a name, resolves it under `defaultDir`. With no name in a terminal it shows a picker, or `--search` opens a fuzzy finder; without a TTY a name is required.",
            handler: "workspace.open",
            help: nestedHelp("workspace", "open"),
            operands: {
              variants: [
                {
                  beforeDoubleDash: cardinality(
                    0,
                    1,
                    "workspace",
                    undefined,
                    "The workspace to open, resolved by name under `defaultDir`. Required without a TTY.",
                  ),
                  delimiter: "forbidden",
                  when: { flag: "search", present: false },
                },
                {
                  beforeDoubleDash: cardinality(0, 0, "workspace"),
                  delimiter: "forbidden",
                  when: { flag: "search", present: true },
                },
              ],
            },
            flags: [
              booleanFlag(
                "search",
                "--search",
                undefined,
                "Open a fuzzy finder to pick a workspace; requires an interactive terminal.",
              ),
            ],
            examples: [
              {
                command: "wf workspace open <workspace>",
                description: "Switch to the named workspace's directory.",
              },
              {
                command: "wf workspace open --search",
                description:
                  "Fuzzy-find a workspace interactively, then switch to it.",
              },
            ],
            tty: optionalStdin,
            shellHandoff: "optional-cd",
          }),
          leaf({
            name: "list",
            path: ["workspace", "list"],
            summary: "List workspaces",
            description:
              "Prints each workspace found under `defaultDir` with its description, template, branch, and repository count. Entries with unreadable metadata are skipped. Errors if `defaultDir` is unset (set it with `wf config edit`).",
            handler: "workspace.list",
            help: nestedHelp("workspace", "list"),
            examples: [
              {
                command: "wf workspace list",
                description:
                  "Show every workspace under the configured directory.",
              },
            ],
            outputModes: ["report"],
          }),
          leaf({
            name: "status",
            path: ["workspace", "status"],
            summary: "Show repository initialization status",
            description:
              'Reports the background initialization state of each repository in a workspace — queued, running, failed, or cancelled — finalizing completed work before reporting. Run from inside a workspace, or target one with `-w`. With no recorded initialization it exits 0 with a message. With `--json` it emits `{ "ok": true, "data": { "workspace": …, "repos": [ … ] } }`.',
            handler: "workspace.status",
            help: nestedHelp("workspace", "status"),
            flags: [
              booleanFlag(
                "json",
                "--json",
                undefined,
                "Emit the machine-readable envelope instead of human output.",
              ),
              stringFlag("workspace", "--workspace", "dir", {
                short: "-w",
                description:
                  "Path to the workspace to inspect (default: the current workforest workspace).",
              }),
            ],
            examples: [
              {
                command: "wf workspace status",
                description:
                  "Show initialization progress for the current workspace.",
              },
              {
                command: "wf workspace status -w <dir> --json",
                description:
                  "Print another workspace's status as a JSON envelope.",
              },
            ],
            outputModes: ["interactive", "report", "json"],
            tty: optionalStdin,
          }),
          leaf({
            name: "add",
            path: ["workspace", "add"],
            summary: "Add repositories to a workspace",
            description:
              "Adds repositories to an existing workspace, creating a worktree for each on the workspace's feature branch and running the template's initializers. Run from inside a workspace or target one with `-w`. With no repositories in a terminal it prompts; without a TTY at least one repository is required.",
            handler: "workspace.add",
            help: nestedHelp("workspace", "add"),
            operands: {
              variants: [
                {
                  beforeDoubleDash: cardinality(
                    0,
                    null,
                    "repositories",
                    undefined,
                    "One or more repositories to add, each a cached repo name, `org/repo` shorthand, or git URL. Required without a TTY.",
                  ),
                  delimiter: "forbidden",
                  when: { interactive: true },
                },
                {
                  beforeDoubleDash: cardinality(1, null, "repositories"),
                  delimiter: "forbidden",
                  when: { interactive: false },
                },
              ],
            },
            flags: [
              stringFlag("workspace", "--workspace", "dir", {
                short: "-w",
                description:
                  "Path to the target workspace (default: the current workforest workspace).",
              }),
              booleanFlag(
                "dryRun",
                "--dry-run",
                "-n",
                "Show which repositories would be added without writing anything.",
              ),
            ],
            examples: [
              {
                command: "wf workspace add vercel/turborepo",
                description: "Add a repository to the current workspace.",
              },
              {
                command:
                  "wf workspace add vercel/next.js vercel/turborepo -w <dir>",
                description: "Add repositories to a specific workspace.",
              },
            ],
            outputModes: ["interactive", "report"],
            tty: optionalStdin,
          }),
        ],
      }),
      group({
        name: "task",
        path: ["task"],
        summary: "Manage temporary workspace tasks",
        description:
          "Create and remove short-lived task worktrees inside an existing workspace, each on its own branch off a parent repository's current HEAD. Run these from inside a workspace. A task is scoped to one repository in the workspace; for a worktree not tied to any workspace, see `wf worktree`.",
        help: { kind: "command", command: "task" },
        children: [
          leaf({
            name: "create",
            path: ["task", "create"],
            summary: "Create temporary worktrees",
            description:
              "Adds one or more task worktrees inside the current workspace, each on a new branch off the parent repository's current HEAD, then runs the template's setup initializers. Run from inside a workspace; the parent repository is inferred from the current directory unless set with `--repo`. Refuses to run when the parent has uncommitted changes unless you pass `--force`. When one task is created, changes your shell's directory to it under shell integration. See also `wf task delete`.",
            handler: "task.create",
            help: nestedHelp("task", "create"),
            operands: operands(
              1,
              null,
              "task names",
              undefined,
              "One or more task names, each a slug (lowercase words separated by hyphens); each names a worktree and its branch.",
            ),
            flags: [
              stringFlag("repo", "--repo", "repository", {
                description:
                  "Parent repository in the workspace to branch from; defaults to the one inferred from the current directory.",
              }),
              booleanFlag(
                "dryRun",
                "--dry-run",
                "-n",
                "Show the worktrees and branches that would be created without writing anything.",
              ),
              booleanFlag(
                "force",
                "--force",
                "-f",
                "Create even when the parent repository has uncommitted changes.",
              ),
            ],
            examples: [
              {
                command: "wf task create fix-login",
                description:
                  "Create one task worktree off the inferred parent repo and cd into it.",
              },
              {
                command: "wf task create fix-login add-tests --repo web",
                description:
                  "Create two task worktrees branched from the `web` repository.",
              },
            ],
            outputModes: ["human", "report"],
            tty: optionalStdin,
            shellHandoff: "optional-cd",
          }),
          leaf({
            name: "list",
            path: ["task", "list"],
            summary: "List temporary worktrees",
            description:
              "Lists the task worktrees tracked in the current workspace, showing each task's parent repository, branch, setup status, merge state, and path. Run from inside a workspace; the parent repository is inferred from the current directory unless `--repo` scopes the list. Exits 0 with a message when no tasks match.",
            handler: "task.list",
            help: nestedHelp("task", "list"),
            flags: [
              stringFlag("repo", "--repo", "repository", {
                description:
                  "Limit the list to tasks whose parent is this repository in the workspace.",
              }),
            ],
            examples: [
              {
                command: "wf task list",
                description:
                  "List every task tracked in the current workspace.",
              },
              {
                command: "wf task list --repo web",
                description:
                  "List only tasks branched from the `web` repository.",
              },
            ],
            outputModes: ["report"],
          }),
          leaf({
            name: "delete",
            path: ["task", "delete"],
            summary: "Delete temporary worktrees",
            description:
              "Removes one or more task worktrees and deletes their branches; this cannot be undone. Run from inside a workspace. Refuses a task with uncommitted changes or an unmerged branch unless you pass `--force`. Prompts for confirmation in a terminal; without a TTY it exits 1 unless `--force` or `--dry-run` is given. See also `wf task create`.",
            handler: "task.delete",
            help: nestedHelp("task", "delete"),
            operands: operands(
              1,
              null,
              "task names",
              undefined,
              "One or more task names (slugs) to remove, as shown by `wf task list`.",
            ),
            flags: [
              stringFlag("repo", "--repo", "repository", {
                description:
                  "Parent repository to disambiguate the named tasks; required when a name matches tasks in more than one repository.",
              }),
              booleanFlag(
                "dryRun",
                "--dry-run",
                "-n",
                "Show which task worktrees and branches would be removed without deleting anything.",
              ),
              booleanFlag(
                "force",
                "--force",
                "-f",
                "Delete without the prompt and even when a task is dirty or unmerged; required without a terminal.",
              ),
            ],
            examples: [
              {
                command: "wf task delete fix-login",
                description:
                  "Delete one task worktree and its branch after confirming.",
              },
              {
                command: "wf task delete fix-login add-tests --force",
                description:
                  "Delete two tasks with no prompt, including dirty or unmerged ones.",
              },
            ],
            outputModes: ["human", "report"],
            tty: optionalStdin,
            shellHandoff: "optional-cd",
          }),
        ],
      }),
      group({
        name: "worktree",
        path: ["worktree"],
        summary: "Manage standalone worktrees",
        description:
          "Create, list, and delete standalone worktrees — single git worktrees checked out from a cached bare mirror, each on its own branch, not tied to any workspace. Reach for these when you want one repository's worktree on its own. See also `wf task` for a worktree created inside a workspace.",
        help: { kind: "command", command: "worktree" },
        children: [
          leaf({
            name: "create",
            path: ["worktree", "create"],
            summary: "Create a standalone worktree",
            description:
              "Creates a git worktree from a cached bare mirror on a new branch, caching the mirror first if needed; the worktree is not attached to any workspace. The target path is `defaultDir/<repo>/<worktree-name>` unless `--dir` is passed. The branch is named for the worktree name using the configured `branchPrefix`. Changes your shell's directory into the new worktree under shell integration. See also `wf task create`.",
            handler: "worktree.create",
            help: nestedHelp("worktree", "create"),
            operands: operands(
              2,
              2,
              "repository and worktree name",
              "<repository> <worktree name>",
              "The repository (cached name, `org/repo`, or git URL) followed by the worktree name — a slug of lowercase letters, digits, and single hyphens.",
            ),
            flags: [
              stringFlag("dir", "--dir", "path", {
                description:
                  "Write the worktree to this explicit path instead of `defaultDir/<repo>/<worktree-name>`.",
              }),
              booleanFlag(
                "dryRun",
                "--dry-run",
                "-n",
                "Show the repository, branch, and target path without writing anything.",
              ),
            ],
            examples: [
              {
                command: "wf worktree create vercel/next.js fix-router",
                description:
                  "Check out a new worktree at `defaultDir/next.js/fix-router`.",
              },
              {
                command:
                  "wf worktree create <org/repo> <worktree-name> --dir <path>",
                description: "Place the worktree at an explicit path.",
              },
            ],
            outputModes: ["human", "report"],
            tty: optionalStdin,
            shellHandoff: "optional-cd",
          }),
          leaf({
            name: "list",
            path: ["worktree", "list"],
            summary: "List standalone worktrees",
            description:
              "Lists standalone worktrees recorded against cached bare mirrors, showing each worktree's path, repository, branch, and whether it still exists on disk. With no argument, lists across all cached repositories. Exits 0 with a message when none match. See also `wf cache list`.",
            handler: "worktree.list",
            help: nestedHelp("worktree", "list"),
            operands: operands(
              0,
              1,
              "repository",
              undefined,
              "Limit the listing to one cached repository (a cached repo name or `org/repo`). Omit to list all.",
            ),
            examples: [
              {
                command: "wf worktree list",
                description:
                  "List every standalone worktree across all cached repositories.",
              },
              {
                command: "wf worktree list <org/repo>",
                description:
                  "List only the standalone worktrees of one cached repository.",
              },
            ],
            outputModes: ["report"],
          }),
          leaf({
            name: "delete",
            path: ["worktree", "delete"],
            summary: "Delete a standalone worktree",
            description:
              "Removes the git worktree at the given path; this deletes its working directory and cannot be undone. Prompts for confirmation in a terminal; without a TTY it errors (exit 1) unless you pass `--force`. The cached bare mirror and its branch are left intact. See also `wf worktree create`.",
            handler: "worktree.delete",
            help: nestedHelp("worktree", "delete"),
            operands: operands(
              1,
              1,
              "worktree path",
              undefined,
              "Path to the standalone worktree directory to remove.",
            ),
            flags: [
              booleanFlag(
                "dryRun",
                "--dry-run",
                "-n",
                "Show which worktree and branch would be removed without deleting anything.",
              ),
              booleanFlag(
                "force",
                "--force",
                "-f",
                "Skip the confirmation prompt; required to proceed without a terminal.",
              ),
            ],
            examples: [
              {
                command: "wf worktree delete <path>",
                description:
                  "Delete the worktree at the given path after confirming.",
              },
              {
                command: "wf worktree delete <path> --force",
                description:
                  "Delete without prompting; use this in scripts and non-interactive shells.",
              },
            ],
            outputModes: ["human", "report"],
            tty: optionalStdin,
            shellHandoff: "optional-cd",
          }),
        ],
      }),
      group({
        name: "cache",
        path: ["cache"],
        summary: "Manage cached repositories",
        description:
          "The cached bare mirrors that workforest clones from to create workspaces and worktrees live under `$WORKFOREST_CACHE_DIR`, fetched with `--filter=blob:none` to stay small. The usual lifecycle is `add` to clone, `update` to fetch, `doctor`/`repair` to check and fix, and `delete`/`prune` to reclaim space.",
        help: { kind: "command", command: "cache" },
        children: [
          leaf({
            name: "list",
            path: ["cache", "list"],
            summary: "List cached repositories",
            description:
              'Lists every cached bare mirror with its size, active worktree count, last-fetched time, and health, plus the cache directory and totals. Reads only the local cache; touches no network. Exits 0 with a message when the cache is empty. With `--json` it emits `{ "ok": true, "data": [ … ] }`. See also `wf cache info`.',
            handler: "cache.list",
            help: nestedHelp("cache", "list"),
            flags: [
              booleanFlag(
                "json",
                "--json",
                undefined,
                "Emit the cache inventory as a JSON envelope instead of the report.",
              ),
            ],
            examples: [
              {
                command: "wf cache list",
                description: "List all cached mirrors with sizes and health.",
              },
              {
                command: "wf cache list --json",
                description:
                  "Emit the cache inventory as a JSON envelope for scripting.",
              },
            ],
            outputModes: ["report", "json"],
          }),
          leaf({
            name: "info",
            path: ["cache", "info"],
            summary: "Show cached repository information",
            description:
              'Shows one cached bare mirror in detail: health, origin remote, default branch, size, last-fetched time, path, any integrity issues, and every registered worktree. Reads only the local cache. Errors (exit 1) if the repository is not cached. With `--json` it emits `{ "ok": true, "data": { … } }`. See also `wf cache list`.',
            handler: "cache.info",
            help: nestedHelp("cache", "info"),
            operands: operands(
              1,
              1,
              "repository",
              undefined,
              "A cached repo name, `org/repo` shorthand, full git URL, or cache directory name.",
            ),
            flags: [
              booleanFlag(
                "json",
                "--json",
                undefined,
                "Emit the repository's record as a JSON envelope.",
              ),
            ],
            examples: [
              {
                command: "wf cache info vercel/next.js",
                description: "Show full detail for one cached mirror.",
              },
              {
                command: "wf cache info <org/repo> --json",
                description: "Emit one repository's record as a JSON envelope.",
              },
            ],
            outputModes: ["report", "json"],
          }),
          leaf({
            name: "path",
            path: ["cache", "path"],
            summary: "Print a cached repository path",
            description:
              "Prints the absolute path of a cached bare mirror to stdout with no other output, for capture in `$(wf cache path …)`. With no argument, prints the cache directory itself. With a repository, errors (exit 1) if it is not cached. Touches no network.",
            handler: "cache.path",
            help: nestedHelp("cache", "path"),
            operands: operands(
              0,
              1,
              "repository",
              undefined,
              "A cached repo name, `org/repo`, git URL, or directory name; omit for the cache directory.",
            ),
            examples: [
              {
                command: "wf cache path",
                description:
                  "Print the cache directory path for capture in a script.",
              },
              {
                command: 'cd "$(wf cache path vercel/next.js)"',
                description: "Capture one mirror's path and change into it.",
              },
            ],
            outputModes: ["path"],
          }),
          leaf({
            name: "add",
            path: ["cache", "add"],
            summary: "Cache repositories",
            description:
              "Clones one or more repositories as cached bare mirrors over the network, using `--filter=blob:none`. Each repository is reported independently: a failed clone does not stop the rest, and any failure exits 1. Run before creating a workspace so the mirror exists locally. See also `wf cache update` and `wf cache delete`.",
            handler: "cache.add",
            help: nestedHelp("cache", "add"),
            operands: operands(
              1,
              null,
              "repositories",
              undefined,
              "One or more repositories: a cached name, `org/repo` shorthand, or full git URL.",
            ),
            examples: [
              {
                command: "wf cache add vercel/next.js",
                description:
                  "Clone one repository into the cache as a bare mirror.",
              },
              {
                command: "wf cache add vercel/next.js facebook/react",
                description: "Clone several mirrors in one invocation.",
              },
            ],
            tty: optionalStdin,
          }),
          leaf({
            name: "update",
            path: ["cache", "update"],
            summary: "Update cached repositories",
            description:
              "Fetches new commits from the origin remote into cached bare mirrors over the network. With no repositories, updates every cached mirror; otherwise updates just those named. A failed fetch is reported and exits 1 but does not stop the others. Exits 0 with a message when the cache is empty. See also `wf cache add`.",
            handler: "cache.update",
            help: nestedHelp("cache", "update"),
            operands: operands(
              0,
              null,
              "repositories",
              undefined,
              "Zero or more repositories to update; omit to update all cached mirrors.",
            ),
            examples: [
              {
                command: "wf cache update",
                description: "Fetch new commits for every cached mirror.",
              },
              {
                command: "wf cache update vercel/next.js",
                description: "Update one cached mirror.",
              },
            ],
            tty: optionalStdin,
          }),
          leaf({
            name: "doctor",
            path: ["cache", "doctor"],
            summary: "Check cached repositories",
            description:
              "Checks cached bare mirrors for integrity problems — missing origin remote, non-bare or unreadable repositories, and stale worktree registrations — and reports each one's health. With no repositories, checks every mirror. Reads only the local cache. Exits 1 if any checked repository is unhealthy (in both report and JSON modes). See also `wf cache repair`.",
            handler: "cache.doctor",
            help: nestedHelp("cache", "doctor"),
            operands: operands(
              0,
              null,
              "repositories",
              undefined,
              "Zero or more repositories to check; omit to check all cached mirrors.",
            ),
            flags: [
              booleanFlag(
                "json",
                "--json",
                undefined,
                "Emit health records as a JSON envelope; exit code is still 1 if any are unhealthy.",
              ),
            ],
            examples: [
              {
                command: "wf cache doctor",
                description: "Report health for every cached mirror.",
              },
              {
                command: "wf cache doctor --json",
                description:
                  "Emit health records as JSON; nonzero exit flags problems.",
              },
            ],
            outputModes: ["report", "json"],
          }),
          leaf({
            name: "repair",
            path: ["cache", "repair"],
            summary: "Repair cached repositories",
            description:
              "Repairs cached bare mirrors by pruning stale worktree registrations and running a connectivity-only fsck. With no repositories, repairs every mirror. Touches no network. Cannot repair a mirror that is not a valid bare git repository — that case is reported and the mirror must be deleted and re-added. See also `wf cache doctor`.",
            handler: "cache.repair",
            help: nestedHelp("cache", "repair"),
            operands: operands(
              0,
              null,
              "repositories",
              undefined,
              "Zero or more repositories to repair; omit to repair all cached mirrors.",
            ),
            examples: [
              {
                command: "wf cache repair",
                description: "Prune and fsck every cached mirror.",
              },
              {
                command: "wf cache repair vercel/next.js",
                description: "Repair one cached mirror after doctor flags it.",
              },
            ],
            tty: optionalStdin,
          }),
          leaf({
            name: "delete",
            path: ["cache", "delete"],
            summary: "Delete cached repositories",
            description:
              "Permanently deletes cached bare mirrors from disk; the data must be re-cloned to use them again. Refuses (exit 1) any mirror that still has active worktrees unless you pass `--force`. Without a terminal it cannot prompt and exits 1; pass `--force` or `--dry-run` to proceed. See also `wf cache prune`.",
            handler: "cache.delete",
            help: nestedHelp("cache", "delete"),
            operands: operands(
              1,
              null,
              "repositories",
              undefined,
              "One or more repositories to delete: a cached name, `org/repo`, URL, or directory name.",
            ),
            flags: [
              booleanFlag(
                "dryRun",
                "--dry-run",
                "-n",
                "Show which mirrors would be deleted without removing anything.",
              ),
              booleanFlag(
                "force",
                "--force",
                "-f",
                "Skip the prompt and delete even mirrors with active worktrees; required without a terminal.",
              ),
            ],
            examples: [
              {
                command: "wf cache delete <org/repo>",
                description: "Delete one cached mirror after confirming.",
              },
              {
                command: "wf cache delete <org/repo> --force",
                description:
                  "Delete without prompting, even with active worktrees.",
              },
            ],
            tty: optionalStdin,
          }),
          leaf({
            name: "prune",
            path: ["cache", "prune"],
            summary: "Delete unused cached repositories",
            description:
              "Permanently deletes every cached bare mirror that has no active worktrees, reclaiming disk space; pruned data must be re-cloned to use again. Without a terminal it cannot prompt and exits 1; pass `--force` or `--dry-run` to proceed. Exits 0 with a message when nothing is unused. See also `wf cache delete`.",
            handler: "cache.prune",
            help: nestedHelp("cache", "prune"),
            flags: [
              booleanFlag(
                "dryRun",
                "--dry-run",
                "-n",
                "Show which unused mirrors would be deleted without removing anything.",
              ),
              booleanFlag(
                "force",
                "--force",
                "-f",
                "Skip the confirmation prompt; required to proceed without a terminal.",
              ),
            ],
            examples: [
              {
                command: "wf cache prune --dry-run",
                description: "List the unused mirrors prune would remove.",
              },
              {
                command: "wf cache prune --force",
                description: "Delete all unused mirrors without prompting.",
              },
            ],
            tty: optionalStdin,
          }),
          leaf({
            name: "manage",
            path: ["cache", "manage"],
            summary: "Open the repository cache manager",
            description:
              "Opens the interactive cache manager to browse cached bare mirrors and add, update, repair, delete, and prune them from one screen. Requires an interactive terminal; errors without one. For scripted access, use the individual `wf cache` subcommands.",
            handler: "cache.manage",
            help: nestedHelp("cache", "manage"),
            examples: [
              {
                command: "wf cache manage",
                description:
                  "Open the interactive manager to inspect and maintain the cache.",
              },
            ],
            outputModes: ["interactive"],
            tty: requiredStdin,
          }),
        ],
      }),
      group({
        name: "review",
        path: ["review"],
        summary: "Manage review workspaces and PR worktrees",
        description:
          "Set up review workspaces and check out pull request worktrees inside them, for reviewing someone else's PR without disturbing your own workspaces. `wf review open` creates the per-repository review workspace; `wf review checkout` adds a worktree for a specific PR. Both store worktrees under the configured `reviewsDir`.",
        help: { kind: "command", command: "review" },
        children: [
          leaf({
            name: "open",
            path: ["review", "open"],
            summary: "Open a review workspace",
            description:
              "Sets up a review workspace for a repository: caches its bare mirror and adds a detached worktree under the configured `reviewsDir`. Reads `reviewsDir` from config; in a terminal it prompts for and saves the directory when unset, but without a TTY an unset `reviewsDir` is an operational failure (exit 1). Changes your shell's directory to the workspace under shell integration. See also `wf review checkout`.",
            handler: "review.open",
            help: nestedHelp("review", "open"),
            operands: operands(
              1,
              1,
              "repository",
              undefined,
              "The repository to review, as `org/repo`, a cached repo name, or a git URL.",
            ),
            examples: [
              {
                command: "wf review open <owner>/<repo>",
                description:
                  "Set up a review workspace for the repository, then enter it.",
              },
            ],
            outputModes: ["human", "report"],
            tty: optionalStdin,
            shellHandoff: "optional-cd",
          }),
          leaf({
            name: "checkout",
            path: ["review", "checkout"],
            summary: "Check out a pull request worktree",
            description:
              "Adds a worktree for one pull request inside its review workspace, running `gh pr checkout` to fetch the PR branch — requires the `gh` CLI and network access. Run from inside a review workspace and you can pass just a PR number, taking the repository from the workspace's metadata. Reads `reviewsDir` from config (errors exit 1 without a TTY when unset). Changes your shell's directory to the worktree under shell integration. See also `wf review open`.",
            handler: "review.checkout",
            help: nestedHelp("review", "checkout"),
            operands: operands(
              1,
              2,
              "review targets",
              "<review target> [pull request]",
              "The PR to check out: a GitHub PR URL, `org/repo#<number>`, a bare `org/repo` slug, or — inside a review workspace — a bare `<number>`/`#<number>`. A second `[pull request]` argument gives the number, valid only when the target is a bare `org/repo` slug.",
            ),
            examples: [
              {
                command: "wf review checkout <owner>/<repo>#<number>",
                description: "Check out a PR by compact org/repo and number.",
              },
              {
                command: "wf review checkout <owner>/<repo> <number>",
                description:
                  "Same target supplied as two space-separated arguments.",
              },
              {
                command: "wf review checkout <number>",
                description:
                  "From inside a review workspace, check out a PR using the workspace's repository.",
              },
            ],
            outputModes: ["human", "report"],
            tty: optionalStdin,
            shellHandoff: "optional-cd",
          }),
        ],
      }),
      group({
        name: "template",
        path: ["template"],
        summary: "Manage templates",
        description:
          "Create, inspect, and maintain reusable workspace templates. A template names a set of repositories plus optional hooks, a branch prefix, and bundled files, stored at `~/.config/workforest/templates/<name>/template.jsonc`. Use `wf workspace create <template>` to build a workspace from one.",
        help: { kind: "command", command: "template" },
        children: [
          leaf({
            name: "list",
            path: ["template", "list"],
            summary: "List templates",
            description:
              "Lists every saved template with its description and repository set, and prints the templates directory. Exits 0 with a message when no templates exist. See also `wf template show` and `wf template new`.",
            handler: "template.list",
            help: nestedHelp("template", "list"),
            examples: [
              {
                command: "wf template list",
                description:
                  "Show all saved templates and where they live on disk.",
              },
            ],
            outputModes: ["report"],
          }),
          leaf({
            name: "open",
            path: ["template", "open"],
            summary: "Open a template directory",
            description:
              "Resolves a template to its directory for editing its files by hand, changing your shell's directory there under shell integration; as the bare binary it prints the path instead. Errors if the template does not exist. See also `wf template show`.",
            handler: "template.open",
            help: nestedHelp("template", "open"),
            operands: operands(
              1,
              1,
              "template",
              undefined,
              "Name of an existing template (lowercase, hyphen-separated).",
            ),
            examples: [
              {
                command: "wf template open <template>",
                description:
                  "Move into the template's directory to edit its files directly.",
              },
            ],
            outputModes: ["path"],
            shellHandoff: "optional-cd",
          }),
          leaf({
            name: "show",
            path: ["template", "show"],
            summary: "Show template information",
            description:
              "Prints one template's full configuration: description, effective branch prefix, bundled files directory if present, repository set, and any hooks, plus the path to its `template.jsonc`. Errors if the template does not exist. See also `wf template list` and `wf template edit`.",
            handler: "template.show",
            help: nestedHelp("template", "show"),
            operands: operands(
              1,
              1,
              "template",
              undefined,
              "Name of an existing template (lowercase, hyphen-separated).",
            ),
            examples: [
              {
                command: "wf template show <template>",
                description:
                  "Print one template's repositories, hooks, and branch prefix.",
              },
            ],
            outputModes: ["report"],
          }),
          leaf({
            name: "manage",
            path: ["template", "manage"],
            summary: "Open the template manager",
            description:
              "Opens an interactive manager to browse, create, edit, copy, and delete templates from one screen. Requires an interactive terminal; without a TTY (or under `$CI`/`$WORKFOREST_NO_TUI`) it falls back to `wf template list` and exits 0. For scripted use, drive the individual subcommands directly.",
            handler: "template.manage",
            help: nestedHelp("template", "manage"),
            examples: [
              {
                command: "wf template manage",
                description:
                  "Browse and edit all templates in an interactive screen.",
              },
            ],
            outputModes: ["interactive"],
            tty: requiredStdin,
          }),
          leaf({
            name: "new",
            path: ["template", "new"],
            summary: "Create a template",
            description:
              "Creates a new template directory and `template.jsonc` from a name and a repository set. In a terminal, prompts for anything missing; without a TTY the name and at least one repository are required, and omitting them is a usage error. Errors if a template with that name already exists. See also `wf template edit` and `wf workspace create <template>`.",
            handler: "template.new",
            help: nestedHelp("template", "new"),
            operands: {
              variants: [
                {
                  beforeDoubleDash: cardinality(
                    0,
                    null,
                    "template and repositories",
                    "[template] [repositories...]",
                    "A template name (lowercase, hyphen-separated), then one or more repositories (cached name, `org/repo`, or git URL). Both required without a TTY.",
                  ),
                  delimiter: "forbidden",
                  when: { interactive: true },
                },
                {
                  beforeDoubleDash: cardinality(
                    2,
                    null,
                    "template and repositories",
                    "<template> <repositories...>",
                  ),
                  delimiter: "forbidden",
                  when: { interactive: false },
                },
              ],
            },
            flags: [
              stringFlag("description", "--description", "description", {
                short: "-d",
                description:
                  "Set the template's description; otherwise prompted in a terminal.",
              }),
            ],
            examples: [
              {
                command: "wf template new",
                description:
                  "Prompt for the name, repositories, and description interactively.",
              },
              {
                command:
                  "wf template new my-stack vercel/next.js vercel/turborepo",
                description:
                  "Create a template from two GitHub repositories, non-interactively.",
              },
            ],
            tty: optionalStdin,
          }),
          leaf({
            name: "edit",
            path: ["template", "edit"],
            summary: "Edit a template",
            description:
              "Opens an interactive editor for one template's repositories, hooks, and branch prefix, saving changes back to its `template.jsonc`. Requires an interactive terminal; errors without one. To change a template in a script, edit its `template.jsonc` directly. See also `wf template show` and `wf template add-file`.",
            handler: "template.edit",
            help: nestedHelp("template", "edit"),
            operands: operands(
              1,
              1,
              "template",
              undefined,
              "Name of an existing template (lowercase, hyphen-separated).",
            ),
            examples: [
              {
                command: "wf template edit <template>",
                description:
                  "Edit one template's repositories and hooks interactively.",
              },
            ],
            outputModes: ["interactive"],
            tty: requiredStdin,
          }),
          leaf({
            name: "add-file",
            path: ["template", "add-file"],
            summary: "Add files to a template",
            description:
              "Copies files or directories into a template's `files/` directory so workspaces created from it start with those files. Without `--template`, run from inside a workspace to target its template. Prompts to resolve conflicts when a copied file differs from one already bundled. See also `wf template edit`.",
            handler: "template.add-file",
            help: nestedHelp("template", "add-file"),
            operands: operands(
              1,
              null,
              "paths",
              undefined,
              "One or more files or directories to copy into the template.",
            ),
            flags: [
              stringFlag("template", "--template", "template", {
                short: "-t",
                description:
                  "Template to add files to; otherwise inferred from the current workspace.",
              }),
            ],
            examples: [
              {
                command:
                  "wf template add-file -t my-stack .prettierrc tsconfig.base.json",
                description: "Bundle two config files into a named template.",
              },
              {
                command: "wf template add-file .editorconfig",
                description:
                  "From inside a workspace, add a file to that workspace's template.",
              },
            ],
            tty: optionalStdin,
          }),
          leaf({
            name: "copy",
            path: ["template", "copy"],
            summary: "Copy a template",
            description:
              "Duplicates a template's full configuration under a new name, source then destination. Errors if the source does not exist or the destination name is taken; the new template is independent of the source. See also `wf template new` and `wf template edit`.",
            handler: "template.copy",
            help: nestedHelp("template", "copy"),
            operands: operands(
              2,
              2,
              "templates",
              "<source template> <destination template>",
              "The source template name, then the new destination name (both lowercase, hyphen-separated).",
            ),
            examples: [
              {
                command: "wf template copy my-stack my-stack-experimental",
                description:
                  "Duplicate a template under a new name to modify independently.",
              },
            ],
          }),
          leaf({
            name: "delete",
            path: ["template", "delete"],
            summary: "Delete a template",
            description:
              "Permanently removes a template's directory, including its `template.jsonc` and any bundled files; this cannot be undone. Prompts for confirmation in a terminal; without a TTY it refuses and exits 1 unless `--force` is passed. Existing workspaces created from it are unaffected. See also `wf template copy`.",
            handler: "template.delete",
            help: nestedHelp("template", "delete"),
            operands: operands(
              1,
              1,
              "template",
              undefined,
              "Name of an existing template (lowercase, hyphen-separated).",
            ),
            flags: [
              booleanFlag(
                "force",
                "--force",
                "-f",
                "Skip the confirmation prompt; required to delete without a terminal.",
              ),
            ],
            examples: [
              {
                command: "wf template delete <template>",
                description:
                  "Delete a template after confirming at the prompt.",
              },
              {
                command: "wf template delete <template> --force",
                description: "Delete without confirmation, e.g. in a script.",
              },
            ],
            tty: optionalStdin,
          }),
        ],
      }),
      group({
        name: "shell",
        path: ["shell"],
        summary: "Manage shell integration",
        description:
          "Set up shell integration so directory-changing commands (`wf workspace create`/`open`/`delete`, `wf task`, `wf worktree`, `wf review`, `wf template open`) change your shell's working directory instead of just printing a path.",
        help: { kind: "command", command: "shell" },
        children: [
          leaf({
            name: "init",
            path: ["shell", "init"],
            summary: "Print shell integration",
            description:
              'Prints a shell integration script to stdout for `eval "$(wf shell init zsh)"`; the output is meant to be captured and nothing else is written to stdout. The script defines `wf`/`workforest` wrapper functions and completions and enables auto-cd. Pass `zsh` or `bash`, or omit to detect from `$SHELL`; an unsupported shell is a usage error. Add the `eval` line to your `.zshrc` or `.bashrc`.',
            handler: "shell.init",
            help: nestedHelp("shell", "init"),
            operands: operands(
              0,
              1,
              "shell",
              undefined,
              "`zsh` or `bash`. Omit to detect from `$SHELL`.",
            ),
            examples: [
              {
                command: 'eval "$(wf shell init zsh)"',
                description:
                  "Enable integration in the current zsh; put this in `.zshrc`.",
              },
              {
                command: 'eval "$(wf shell init bash)"',
                description:
                  "Enable integration in bash; put this in `.bashrc`.",
              },
            ],
            outputModes: ["shell"],
          }),
        ],
      }),
      group({
        name: "config",
        path: ["config"],
        summary: "Manage configuration",
        description:
          "Inspect and edit workforest's global settings — `defaultDir`, `reviewsDir`, `dirPrefix`, and `branchPrefix`, stored in `config.json` under `$WORKFOREST_CONFIG_DIR`. With no subcommand, `wf config` runs `wf config show`.",
        help: { kind: "command", command: "config" },
        default: configDefault,
        children: [
          leaf({
            name: "show",
            path: ["config", "show"],
            summary: "Show configuration",
            description:
              "Prints the resolved global configuration — `defaultDir`, `reviewsDir`, `dirPrefix`, `branchPrefix`, and any Vercel link settings — followed by the path of the `config.json` it read. Unset keys show their fallback behavior. Reads only; never writes. See also `wf config edit`.",
            handler: "config.show",
            help: nestedHelp("config", "show"),
            examples: [
              {
                command: "wf config show",
                description:
                  "Print the current configuration and the file it came from.",
              },
            ],
            outputModes: ["report"],
          }),
          leaf({
            name: "init",
            path: ["config", "init"],
            summary: "Configure workforest interactively",
            description:
              "Walks through prompts for `defaultDir`, `reviewsDir`, `dirPrefix`, and `branchPrefix`, shows a preview, and on confirmation writes `config.json`. Requires an interactive terminal; errors without one (exit 1). To set values without a TTY, use `wf config edit`. See also `wf config show`.",
            handler: "config.init",
            help: nestedHelp("config", "init"),
            examples: [
              {
                command: "wf config init",
                description:
                  "Set the directories and prefixes through guided prompts, then save.",
              },
            ],
            outputModes: ["interactive"],
            tty: requiredStdin,
          }),
          leaf({
            name: "edit",
            path: ["config", "edit"],
            summary: "Open the configuration editor",
            description:
              "Opens `config.json` in your editor to change settings by hand, then reports when the editor closes. Uses `$EDITOR`, falling back to `$VISUAL`, then `vi`. Requires an interactive terminal; errors without one. See also `wf config init`.",
            handler: "config.edit",
            help: nestedHelp("config", "edit"),
            examples: [
              {
                command: "wf config edit",
                description:
                  "Open the config file in `$EDITOR` to change settings directly.",
              },
            ],
            outputModes: ["interactive"],
            tty: requiredStdin,
          }),
        ],
      }),
      group({
        name: "skills",
        path: ["skills"],
        summary: "Inspect bundled agent skills",
        description:
          "List and read the agent skills bundled with workforest. These skills are written for AI coding agents driving `wf`, not for interactive use; start with the `core` skill. With no subcommand, `wf skills` runs `wf skills list`.",
        help: { kind: "command", command: "skills" },
        default: skillsDefault,
        children: [
          leaf({
            name: "list",
            path: ["skills", "list"],
            summary: "List bundled agent skills",
            description:
              'Lists the available bundled skills with their names and descriptions; hidden skills are omitted. The `core` skill is the recommended starting point. With `--json` it emits `{ "ok": true, "data": [ … ] }`. See also `wf skills get`.',
            handler: "skills.list",
            help: nestedHelp("skills", "list"),
            flags: [
              booleanFlag(
                "json",
                "--json",
                undefined,
                "Emit the skill list as a JSON envelope instead of the report.",
              ),
            ],
            examples: [
              {
                command: "wf skills list",
                description:
                  "List every bundled skill with a one-line description.",
              },
              {
                command: "wf skills list --json",
                description:
                  "Get the skill list as a JSON envelope for programmatic use.",
              },
            ],
            outputModes: ["report", "json"],
          }),
          leaf({
            name: "get",
            path: ["skills", "get"],
            summary: "Print bundled skill content",
            description:
              "Prints the full content of one or more skills to stdout, separated by `---`. Name one or more skills, or pass `--all` for every non-hidden skill (with no skill names). Naming an unknown skill exits 1. For an agent getting oriented, start with `get core`. With `--json` it emits the envelope instead of plain text. See also `wf skills list`.",
            handler: "skills.get",
            help: nestedHelp("skills", "get"),
            operands: {
              variants: [
                {
                  beforeDoubleDash: cardinality(
                    1,
                    null,
                    "skill names",
                    undefined,
                    "One or more skill names to print. Omit only when using `--all`.",
                  ),
                  delimiter: "forbidden",
                  when: { flag: "all", present: false },
                },
                {
                  beforeDoubleDash: cardinality(0, 0, "skill names"),
                  delimiter: "forbidden",
                  when: { flag: "all", present: true },
                },
              ],
            },
            flags: [
              booleanFlag(
                "full",
                "--full",
                undefined,
                "Also include the skill's supplementary `references/` and `templates/` files.",
              ),
              booleanFlag(
                "all",
                "--all",
                undefined,
                "Print every non-hidden skill; takes no skill-name arguments.",
              ),
              booleanFlag(
                "json",
                "--json",
                undefined,
                "Emit the JSON envelope instead of plain text.",
              ),
            ],
            examples: [
              {
                command: "wf skills get core",
                description:
                  "Print the `core` skill — the recommended starting point.",
              },
              {
                command: "wf skills get core terminal-ui",
                description: "Print several named skills, separated by `---`.",
              },
              {
                command: "wf skills get --all --full",
                description:
                  "Print every skill, including its reference and template files.",
              },
            ],
            outputModes: ["human", "json"],
          }),
          leaf({
            name: "path",
            path: ["skills", "path"],
            summary: "Print bundled skill paths",
            description:
              "Prints filesystem paths to stdout for capture in `$(…)`. With a skill name, prints that skill's directory; an unknown skill exits 1. With no name, prints the bundled skills directories, one per line. Nothing else is written to stdout. See also `wf skills get`.",
            handler: "skills.path",
            help: nestedHelp("skills", "path"),
            operands: operands(
              0,
              1,
              "skill",
              undefined,
              "A skill name whose directory to print. Omit to print the skills directories.",
            ),
            flags: [
              booleanFlag(
                "json",
                "--json",
                undefined,
                "Emit a JSON envelope instead of bare paths.",
              ),
            ],
            examples: [
              {
                command: "wf skills path core",
                description:
                  "Print the `core` skill's directory for use in a script.",
              },
              {
                command: 'cat "$(wf skills path core)/SKILL.md"',
                description:
                  "Capture a skill's directory and read a file from it.",
              },
            ],
            outputModes: ["path", "json"],
          }),
        ],
      }),
      group({
        name: "help",
        path: ["help"],
        summary: "Show help pages",
        description:
          "Prints the overview help page, the conceptual glossary, or the recommended workflow guide. With no subcommand, `wf help` prints the same overview as `wf --help`.",
        help: { kind: "command", command: "help" },
        default: leaf({
          name: "help",
          path: ["help"],
          summary: "Show overview help",
          description: "Prints the same overview as `wf --help`.",
          handler: "help",
          help: { kind: "command", command: "help" },
          outputModes: ["human"],
        }),
        children: [
          leaf({
            name: "concepts",
            path: ["help", "concepts"],
            summary: "Explain core concepts",
            description:
              "Describes the mental model behind workforest: what workspaces, tasks, templates, cached mirrors, and review workspaces are, and the git operations that underpin them.",
            handler: "help.concepts",
            help: nestedHelp("help", "concepts"),
            outputModes: ["human"],
            examples: [
              {
                command: "wf help concepts",
                description: "Read the conceptual glossary and the git model.",
              },
            ],
          }),
          leaf({
            name: "workflow",
            path: ["help", "workflow"],
            summary: "Show recommended workflows",
            description:
              "Describes recommended day-to-day workflows for both interactive users and AI agents, covering workspace creation, task management, PR review, and orientation patterns.",
            handler: "help.workflow",
            help: nestedHelp("help", "workflow"),
            outputModes: ["human"],
            examples: [
              {
                command: "wf help workflow",
                description:
                  "Read the recommended workflows for users and agents.",
              },
            ],
          }),
        ],
      }),
      leaf({
        name: "version",
        path: ["version"],
        summary: "Print the workforest version",
        description:
          "Prints the installed workforest version to stdout as `workforest <version>`.",
        handler: "version",
        help: { kind: "command", command: "version" },
        examples: [
          {
            command: "wf version",
            description: "Print the installed version.",
          },
        ],
      }),
      leaf({
        name: "_initialize-repo",
        path: ["_initialize-repo"],
        summary: "Run an internal repository initializer",
        handler: "initialize-repo",
        help: { kind: "command", command: "_initialize-repo" },
        flags: [
          stringFlag("workspace", "--workspace", "dir", { required: true }),
          stringFlag("repo", "--repo", "repository", { required: true }),
          stringFlag("runId", "--run-id", "id", { required: true }),
        ],
        visibility: hidden,
      }),
    ],
  }),
};

validateCommandRegistry(commandRegistry);

export function validateCommandRegistry(registry: CommandRegistry): void {
  if (registry.root.path.length !== 0 || registry.root.name !== "") {
    throw new Error(
      "The command registry root must use an empty name and path.",
    );
  }
  validateGroup(registry.root);
  validateShortcuts(registry);
}

function validateShortcuts(registry: CommandRegistry): void {
  const tokens = new Set<string>();
  for (const child of registry.root.children) {
    registerToken(tokens, child.name, []);
    for (const childAlias of child.aliases) {
      registerToken(tokens, childAlias.name, []);
    }
  }
  for (const shortcut of registry.shortcuts) {
    registerToken(tokens, shortcut.name, []);
    if (!shortcut.summary.trim()) {
      throw new Error(`Shortcut ${shortcut.name} is missing a summary.`);
    }
    const target = findNode(registry.root, shortcut.target);
    if (!target || target.kind !== "leaf") {
      throw new Error(
        `Shortcut ${shortcut.name} targets unknown command ${formatPath(shortcut.target)}.`,
      );
    }
  }
}

function findNode(
  root: CommandGroup,
  path: readonly string[],
): CommandNode | undefined {
  let node: CommandNode = root;
  for (const segment of path) {
    if (node.kind !== "group") {
      return undefined;
    }
    const child: CommandNode | undefined = node.children.find(
      (candidate) => candidate.name === segment,
    );
    if (!child) {
      return undefined;
    }
    node = child;
  }
  return node;
}

function validateGroup(groupNode: CommandGroup): void {
  const tokens = new Set<string>();
  for (const child of groupNode.children) {
    validateChildPath(groupNode, child);
    registerToken(tokens, child.name, groupNode.path);
    for (const childAlias of child.aliases) {
      registerToken(tokens, childAlias.name, groupNode.path);
    }
    validateNode(child);
  }

  if (groupNode.default) {
    if (!pathsEqual(groupNode.default.path, groupNode.path)) {
      throw new Error(
        `Default command path must match group path: ${formatPath(groupNode.path)}`,
      );
    }
    validateLeaf(groupNode.default);
  }
}

function validateNode(node: CommandNode): void {
  if (!node.summary.trim()) {
    throw new Error(`Command ${formatPath(node.path)} is missing a summary.`);
  }
  if (node.kind === "group") {
    validateGroup(node);
  } else {
    validateLeaf(node);
  }
}

function validateLeaf(leafNode: CommandLeaf): void {
  if (!leafNode.handler.trim()) {
    throw new Error(
      `Command ${formatPath(leafNode.path)} is missing a handler.`,
    );
  }
  if (leafNode.operands.variants.length === 0) {
    throw new Error(
      `Command ${formatPath(leafNode.path)} must define operand cardinality.`,
    );
  }

  const flagNames = new Set<string>();
  const flagTokens = new Set<string>(["--help", "-h"]);
  for (const flag of leafNode.flags) {
    registerUnique(flagNames, flag.name, "flag name", leafNode.path);
    registerUnique(flagTokens, flag.long, "flag", leafNode.path);
    if (flag.short) {
      registerUnique(flagTokens, flag.short, "flag", leafNode.path);
    }
    if (flag.kind === "string" && !flag.valueName) {
      throw new Error(
        `String flag ${flag.long} must define a value name for ${formatPath(leafNode.path)}.`,
      );
    }
  }

  for (const variant of leafNode.operands.variants) {
    validateCardinality(variant.beforeDoubleDash, leafNode.path);
    if (variant.afterDoubleDash) {
      validateCardinality(variant.afterDoubleDash, leafNode.path);
    }
    if (variant.delimiter === "required" && !variant.afterDoubleDash) {
      throw new Error(
        `Delimited operands need afterDoubleDash cardinality for ${formatPath(leafNode.path)}.`,
      );
    }
    if (variant.when?.flag !== undefined && !flagNames.has(variant.when.flag)) {
      throw new Error(
        `Operand condition references unknown flag "${variant.when.flag}" for ${formatPath(leafNode.path)}.`,
      );
    }
    if (
      variant.when?.flag !== undefined &&
      variant.when.present === undefined
    ) {
      throw new Error(
        `Operand flag condition must declare presence for ${formatPath(leafNode.path)}.`,
      );
    }
  }
}

function validateChildPath(parent: CommandGroup, child: CommandNode): void {
  const expected = [...parent.path, child.name];
  if (!pathsEqual(child.path, expected)) {
    throw new Error(
      `Command path ${formatPath(child.path)} does not match ${formatPath(expected)}.`,
    );
  }
}

function validateCardinality(
  value: Cardinality,
  path: readonly string[],
): void {
  if (
    value.min < 0 ||
    !Number.isInteger(value.min) ||
    (value.max !== null &&
      (!Number.isInteger(value.max) || value.max < value.min))
  ) {
    throw new Error(`Invalid operand cardinality for ${formatPath(path)}.`);
  }
  if (value.label.trim() === "") {
    throw new Error(
      `Operand cardinality needs a label for ${formatPath(path)}.`,
    );
  }
  if (value.usage !== undefined && value.usage.trim() === "") {
    throw new Error(
      `Operand cardinality usage cannot be empty for ${formatPath(path)}.`,
    );
  }
}

function registerToken(
  tokens: Set<string>,
  token: string,
  path: readonly string[],
): void {
  registerUnique(tokens, token, "command or alias", path);
}

function registerUnique(
  values: Set<string>,
  value: string,
  kind: string,
  path: readonly string[],
): void {
  if (!value || values.has(value)) {
    throw new Error(`Duplicate ${kind} "${value}" in ${formatPath(path)}.`);
  }
  values.add(value);
}

function pathsEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) => segment === right[index])
  );
}

function formatPath(path: readonly string[]): string {
  return path.length === 0 ? "wf" : `wf ${path.join(" ")}`;
}
