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
  TtyRequirement,
  Visibility,
} from "./types.ts";

const visible: Visibility = "visible";
const noTty: TtyRequirement = { kind: "none" };
const optionalStdin: TtyRequirement = {
  kind: "optional",
  streams: ["stdin"],
};
const optionalTerminal: TtyRequirement = {
  kind: "optional",
  streams: ["stdin", "stdout"],
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
  visibility?: Visibility;
  /** Opt out of the normal global JSON envelope for native command streams. */
  supportsJson?: boolean;
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
    outputModes: normalizeOutputModes(
      options.outputModes ?? ["human"],
      options.visibility ?? visible,
      options.supportsJson ?? true,
    ),
    tty: options.tty ?? noTty,
    handler: options.handler,
  };
}

function normalizeOutputModes(
  modes: readonly OutputMode[],
  visibility: Visibility,
  supportsJson: boolean,
): readonly OutputMode[] {
  if (visibility !== "visible" || !supportsJson || modes.includes("json"))
    return modes;
  return [...modes, "json"];
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

const dashboardOpen = leaf({
  name: "dashboard",
  path: ["dashboard"],
  summary: "Open the Workforest dashboard",
  description:
    "Opens the creation-first dashboard in an interactive terminal, or prints a compact dashboard report when a fullscreen terminal is unavailable.",
  handler: "dashboard.open",
  help: { kind: "command", command: "dashboard" },
  outputModes: ["interactive", "report"],
  tty: optionalTerminal,
  examples: [
    {
      command: "wf dashboard",
      description: "Open the dashboard home.",
    },
    {
      command: "wf templates",
      description: "Open the Templates dashboard screen.",
    },
  ],
});

const changeStart = leaf({
  name: "start",
  path: ["start"],
  summary: "Start a change",
  description:
    "Creates a new Workforest change. A single repository source creates `Repos/<repo>/<change>`, an `@template` source creates `Workspaces/<template>/<change>`, and multiple repository sources create `Workspaces/_adhoc/<change>`. With only a change name, repeats the current Workforest-managed context. With no operands in an interactive terminal, opens the new change dashboard flow; outside an interactive terminal a change name is required.",
  handler: "change.start",
  help: { kind: "command", command: "start" },
  flags: [
    stringFlag("branch", "--branch", "branch", {
      description:
        "Use this exact Git branch name instead of deriving one from `branchPrefix` and <change>.",
    }),
  ],
  operands: {
    variants: [
      {
        beforeDoubleDash: cardinality(0, 0, "arguments", undefined, undefined),
        delimiter: "forbidden",
        when: { interactive: true },
      },
      {
        beforeDoubleDash: cardinality(
          1,
          null,
          "arguments",
          "<change> [source...]",
          "A change name, optionally followed by one repository, multiple repositories, or one @template source.",
        ),
        delimiter: "forbidden",
      },
    ],
  },
  examples: [
    {
      command: "wf start redesign-cli tomdale/workforest",
      description: "Start a repository change.",
    },
    {
      command: "wf start auth-fix @vercel-agent",
      description: "Start a workspace change from a template.",
    },
    {
      command: "wf start billing vercel/front vercel/api",
      description: "Start an _adhoc workspace from several repositories.",
    },
    {
      command: "wf start follow-up",
      description: "Start another change from the current Workforest context.",
    },
  ],
  outputModes: ["human"],
});

const cacheDefault = leaf({
  name: "",
  path: ["cache"],
  summary: "Open the cache dashboard",
  description:
    "Opens the Cache dashboard screen in an interactive terminal. Scriptable cache operations remain available as explicit subcommands.",
  handler: "dashboard.open",
  help: { kind: "command", command: "cache" },
  outputModes: ["interactive", "report"],
  tty: optionalTerminal,
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

const changeStatus = leaf({
  name: "status",
  path: ["status"],
  summary: "Show change status",
  description:
    "Shows a static report for one Workforest change, resolving the current change from the working directory when no selector is provided.",
  handler: "change.status",
  help: { kind: "command", command: "status" },
  operands: operands(
    0,
    1,
    "selector",
    undefined,
    "Change selector as <group>/<change>, or a bare change name when unique.",
  ),
  flags: [
    booleanFlag(
      "json",
      "--json",
      undefined,
      "Emit the change status model as a JSON envelope instead of the report.",
    ),
    booleanFlag(
      "watch",
      "--watch",
      undefined,
      "Open the initialization watcher for the selected change when setup state exists.",
    ),
  ],
  examples: [
    {
      command: "wf status",
      description: "Show status for the current Workforest change.",
    },
    {
      command: "wf status workforest/cli-redesign",
      description: "Show a repository change by selector.",
    },
    {
      command: "wf status vercel-agent/auth-fix --json",
      description: "Print a workspace change status as JSON.",
    },
  ],
  outputModes: ["report", "json"],
});

const changeAdd = leaf({
  name: "add",
  path: ["add"],
  summary: "Add repositories to the current change",
  description:
    "Adds repositories to the current Workforest change. From a workspace change, missing repositories are added to that workspace. From a repository change, the change is promoted into a workspace and the existing worktree is moved there; pass @template to use the template's repository set.",
  handler: "change.add",
  help: { kind: "command", command: "add" },
  operands: operands(
    1,
    null,
    "sources",
    "<repo...|@template>",
    "One or more repositories, or one @template when promoting a repository change.",
  ),
  flags: [
    booleanFlag(
      "yes",
      "--yes",
      undefined,
      "Confirm repository-change promotion without prompting.",
    ),
  ],
  examples: [
    {
      command: "wf add vercel/api",
      description: "Add one repository to the current workspace change.",
    },
    {
      command: "wf add vercel/api vercel/dashboard",
      description: "Add several repositories to the current workspace change.",
    },
    {
      command: "wf add @vercel-agent --yes",
      description:
        "Promote the current repository change into a template workspace.",
    },
  ],
  tty: optionalStdin,
});

const changeSwitch = leaf({
  name: "switch",
  path: ["switch"],
  summary: "Switch to a Workforest change",
  description:
    "Changes your shell to a Workforest change. Use <group>/<change> to select exactly, a bare change name when unique, or no selector in an interactive terminal to fuzzy-pick from all known changes.",
  handler: "change.switch",
  help: { kind: "command", command: "switch" },
  operands: operands(
    0,
    1,
    "selector",
    "[selector]",
    "Change selector as <group>/<change>, or a bare change name when unique.",
  ),
  examples: [
    {
      command: "wf switch workforest/cli-redesign",
      description: "Switch to a repository change.",
    },
    {
      command: "wf switch vercel-agent/auth-fix",
      description: "Switch to a workspace change.",
    },
    {
      command: "wf switch",
      description: "Fuzzy-pick from known changes interactively.",
    },
  ],
  tty: optionalStdin,
});

const changeFinish = leaf({
  name: "finish",
  path: ["finish"],
  summary: "Finish an integrated change",
  description:
    "Removes a Workforest change after verifying every managed repository is clean, integrated into its remote default branch, and has no unmerged nested tasks. With no selector, resolves the current change from the working directory. Pass --force only for squash merges, cherry-picks, abandoned work, or proof Workforest cannot detect.",
  handler: "change.finish",
  help: { kind: "command", command: "finish" },
  operands: operands(
    0,
    1,
    "selector",
    "[selector]",
    "Change selector as <group>/<change>, or a bare change name when unique. Omit to finish the current change.",
  ),
  flags: [
    booleanFlag(
      "force",
      "--force",
      "-f",
      "Skip finish safety blockers for intentional squash merges, cherry-picks, or abandoned work.",
    ),
  ],
  examples: [
    {
      command: "wf finish workforest/cli-redesign",
      description: "Finish a repository change after integration.",
    },
    {
      command: "wf finish vercel-agent/auth-fix",
      description: "Finish a workspace change after integration.",
    },
    {
      command: "wf finish workforest/squashed-change --force",
      description:
        "Finish a change integrated in a way Workforest cannot prove.",
    },
  ],
});

const changeDelete = leaf({
  name: "delete",
  path: ["delete"],
  summary: "Delete a Workforest change",
  description:
    "Explicitly deletes a Workforest change without integration proof. Requires a selector and confirmation in an interactive terminal; scripts must pass --force. Cached mirrors are preserved.",
  handler: "change.delete",
  help: { kind: "command", command: "delete" },
  operands: operands(
    1,
    1,
    "selector",
    "<selector>",
    "Change selector as <group>/<change>, or a bare change name when unique.",
  ),
  flags: [
    booleanFlag(
      "force",
      "--force",
      "-f",
      "Skip the confirmation prompt; required to proceed without a terminal.",
    ),
  ],
  examples: [
    {
      command: "wf delete _adhoc/experiment",
      description: "Delete a change after confirming.",
    },
    {
      command: "wf delete _adhoc/experiment --force",
      description: "Delete without prompting.",
    },
  ],
  tty: optionalStdin,
});

const migrateWorkspaces = leaf({
  name: "workspaces",
  path: ["migrate", "workspaces"],
  summary: "Migrate workspace layouts and repository metadata",
  description:
    "Moves metadata-bearing direct workspace directories into the grouped workspace layout, moves legacy repo-only directories from <repo>/<change> into Repos/<repo>/<change>, and backfills repository-change metadata under Repos/<repo>/.workforest/changes/<change>.json. Without --apply it prints the migration plan and makes no changes.",
  handler: "migrate.workspaces",
  help: nestedHelp("migrate", "workspaces"),
  flags: [
    booleanFlag(
      "apply",
      "--apply",
      undefined,
      "Move directories and write repository metadata. Omit to preview the migration plan only.",
    ),
    booleanFlag(
      "json",
      "--json",
      undefined,
      "Emit the migration result as a JSON envelope instead of the report.",
    ),
  ],
  examples: [
    {
      command: "wf migrate workspaces",
      description:
        "Preview workspace moves, repository directory moves, and repository metadata backfills.",
    },
    {
      command: "wf migrate workspaces --apply",
      description:
        "Apply workspace moves, repository directory moves, and repository metadata backfills.",
    },
  ],
  outputModes: ["report", "json"],
});

const aiStatus = leaf({
  name: "status",
  path: ["ai", "status"],
  summary: "Show AI provider status",
  description:
    "Shows built-in AI provider detection results, the selected provider, model, timeout, and setup hints. With --json it emits the same status model as a JSON envelope.",
  handler: "ai.status",
  help: nestedHelp("ai", "status"),
  flags: [
    booleanFlag(
      "json",
      "--json",
      undefined,
      "Emit AI provider status as a JSON envelope instead of the report.",
    ),
  ],
  examples: [
    {
      command: "wf ai status",
      description: "Show detected AI providers and the selected provider.",
    },
    {
      command: "wf ai status --json",
      description: "Emit AI provider status as a JSON envelope.",
    },
  ],
  outputModes: ["report", "json"],
});

export const commandRegistry: CommandRegistry = {
  shortcuts: [
    {
      name: "templates",
      target: ["dashboard"],
      visibility: visible,
      summary: "Open the Templates dashboard screen",
      help: { kind: "command", command: "templates" },
    },
    {
      name: "tasks",
      target: ["dashboard"],
      visibility: visible,
      summary: "Open the Tasks dashboard screen",
      help: { kind: "command", command: "tasks" },
    },
    {
      name: "reviews",
      target: ["dashboard"],
      visibility: visible,
      summary: "Open the Reviews dashboard screen",
      help: { kind: "command", command: "reviews" },
    },
  ],
  root: group({
    name: "",
    path: [],
    summary: "Workforest command line interface",
    help: { kind: "root" },
    children: [
      dashboardOpen,
      changeStart,
      changeList,
      changeStatus,
      changeAdd,
      changeSwitch,
      changeFinish,
      changeDelete,
      group({
        name: "ai",
        path: ["ai"],
        summary: "Inspect AI provider setup",
        description:
          "Reports the built-in provider adapters available to AI-backed Workforest features.",
        help: { kind: "command", command: "ai" },
        children: [aiStatus],
      }),
      group({
        name: "migrate",
        path: ["migrate"],
        summary: "Migrate Workforest layouts",
        description:
          "Runs one-time migrations for Workforest-managed data layouts.",
        help: { kind: "command", command: "migrate" },
        children: [migrateWorkspaces],
      }),
      group({
        name: "task",
        path: ["task"],
        summary: "Manage temporary task worktrees",
        description:
          "Create, finish, list, and abandon short-lived task worktrees inside an existing Workforest change, each on its own branch off a parent repository's current HEAD. Run these from inside a workspace repo, repository change, or existing task.",
        help: { kind: "command", command: "task" },
        children: [
          leaf({
            name: "start",
            path: ["task", "start"],
            summary: "Start nested task lanes",
            description:
              "Adds one or more nested task worktrees under the current change's reserved _tasks directory, each on a new branch off the parent repository's committed HEAD, then runs setup initializers. Run from inside a workspace repo, repository change, or existing task; in workspaces, the parent repository is inferred from the current directory unless set with `--repo`. Refuses to run when the parent has uncommitted changes unless you pass `--force`. When one task is started, changes your shell's directory to it under shell integration. See also `wf task finish` and `wf task delete`.",
            handler: "task.start",
            help: nestedHelp("task", "start"),
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
                  "Parent repository in a workspace to branch from; defaults to the one inferred from the current directory.",
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
                command: "wf task start fix-login",
                description:
                  "Start one task lane off the inferred parent repo and cd into it.",
              },
              {
                command: "wf task start fix-login add-tests --repo web",
                description:
                  "Start two task lanes branched from the `web` repository.",
              },
            ],
            outputModes: ["human", "report"],
            tty: optionalStdin,
          }),
          leaf({
            name: "list",
            path: ["task", "list"],
            summary: "List temporary worktrees",
            description:
              "Lists task worktrees for the current managed change, grouped by parent repository. Shows each task's branch, setup status, merge state, and path. In workspaces, the parent repository is inferred from the current directory unless `--repo` scopes the list. Exits 0 with a message when no tasks match.",
            handler: "task.list",
            help: nestedHelp("task", "list"),
            flags: [
              stringFlag("repo", "--repo", "repository", {
                description:
                  "Limit the list to tasks whose parent is this repository in the current workspace.",
              }),
            ],
            examples: [
              {
                command: "wf task list",
                description:
                  "List every task tracked in the current managed change.",
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
            name: "finish",
            path: ["task", "finish"],
            summary: "Finish integrated task lanes",
            description:
              "Removes one or more clean task worktrees after verifying their branches are reachable from the parent repository. Run from inside a managed change. Use `wf task delete --force` for abandoned, dirty, or intentionally unmerged task lanes.",
            handler: "task.finish",
            help: nestedHelp("task", "finish"),
            operands: operands(
              1,
              null,
              "task names",
              undefined,
              "One or more task names (slugs) to finish, as shown by `wf task list`.",
            ),
            flags: [
              stringFlag("repo", "--repo", "repository", {
                description:
                  "Parent workspace repository to disambiguate the named tasks; required when a name matches tasks in more than one workspace repository.",
              }),
              booleanFlag(
                "dryRun",
                "--dry-run",
                "-n",
                "Show which task worktrees and branches would be removed without deleting anything.",
              ),
            ],
            examples: [
              {
                command: "wf task finish fix-login",
                description: "Finish one integrated task lane.",
              },
              {
                command: "wf task finish fix-login add-tests --repo web",
                description:
                  "Finish two integrated task lanes branched from the `web` repository.",
              },
            ],
            outputModes: ["human", "report"],
          }),
          leaf({
            name: "delete",
            path: ["task", "delete"],
            summary: "Delete temporary worktrees",
            description:
              "Explicitly abandons one or more task worktrees and deletes their branches; this cannot be undone. Run from inside a managed change. Refuses a task with uncommitted changes or an unmerged branch unless you pass `--force`. Prompts for confirmation in a terminal; without a TTY it exits 1 unless `--force` or `--dry-run` is given. See also `wf task finish`.",
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
                  "Parent workspace repository to disambiguate the named tasks; required when a name matches tasks in more than one workspace repository.",
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
          }),
        ],
      }),
      group({
        name: "cache",
        path: ["cache"],
        summary: "Manage cached repositories",
        description:
          "The cached bare mirrors that workforest clones from to create changes and task worktrees live under `$WORKFOREST_CACHE_DIR`, fetched with `--filter=blob:none` to stay small. The usual lifecycle is `sync` to clone or fetch, `doctor --fix` to inspect and repair, and `delete`/`clean` to reclaim space.",
        help: { kind: "command", command: "cache" },
        default: cacheDefault,
        children: [
          leaf({
            name: "list",
            path: ["cache", "list"],
            summary: "List cached repositories",
            description:
              'Lists every cached bare mirror with its size, active worktree count, last-fetched time, and health, plus the cache directory and totals. Reads only the local cache; touches no network. Exits 0 with a message when the cache is empty. With `--json` it emits `{ "ok": true, "data": [ … ] }`. See also `wf cache show`.',
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
            name: "show",
            path: ["cache", "show"],
            summary: "Show cached repository information",
            description:
              'Shows one cached bare mirror in detail: health, origin remote, default branch, size, last-fetched time, path, any integrity issues, and every registered worktree. Reads only the local cache. Errors (exit 1) if the repository is not cached. With `--json` it emits `{ "ok": true, "data": { … } }`. With `--path`, prints the cache root or selected mirror path with no decoration.',
            handler: "cache.show",
            help: nestedHelp("cache", "show"),
            operands: {
              variants: [
                {
                  beforeDoubleDash: cardinality(
                    0,
                    1,
                    "repository",
                    "[repository]",
                    "A cached repo name, `org/repo` shorthand, full git URL, or cache directory name.",
                  ),
                  delimiter: "forbidden",
                  when: { flag: "path", present: true },
                },
                {
                  beforeDoubleDash: cardinality(
                    1,
                    1,
                    "repository",
                    undefined,
                    "A cached repo name, `org/repo` shorthand, full git URL, or cache directory name.",
                  ),
                  delimiter: "forbidden",
                  when: { flag: "path", present: false },
                },
              ],
            },
            flags: [
              booleanFlag(
                "json",
                "--json",
                undefined,
                "Emit the repository's record as a JSON envelope.",
              ),
              booleanFlag(
                "path",
                "--path",
                undefined,
                "Print the cache root or selected mirror path with no decoration.",
              ),
            ],
            examples: [
              {
                command: "wf cache show vercel/next.js",
                description: "Show full detail for one cached mirror.",
              },
              {
                command: "wf cache show <org/repo> --json",
                description: "Emit one repository's record as a JSON envelope.",
              },
              {
                command: "wf cache show --path",
                description:
                  "Print the cache directory path for capture in a script.",
              },
              {
                command: 'cd "$(wf cache show vercel/next.js --path)"',
                description: "Capture one mirror's path and change into it.",
              },
            ],
            outputModes: ["report", "json", "path"],
          }),
          leaf({
            name: "sync",
            path: ["cache", "sync"],
            summary: "Sync cached repositories",
            description:
              "Fetches new commits for existing cached mirrors, or clones missing repository specifiers as cached bare mirrors over the network using `--filter=blob:none`. With no repositories, syncs every cached mirror. Each repository is reported independently: a failed sync does not stop the rest, and any failure exits 1.",
            handler: "cache.sync",
            help: nestedHelp("cache", "sync"),
            operands: operands(
              0,
              null,
              "repositories",
              undefined,
              "Zero or more repositories: a cached name, `org/repo` shorthand, or full git URL.",
            ),
            flags: [
              booleanFlag(
                "json",
                "--json",
                undefined,
                "Emit sync results as a JSON envelope.",
              ),
            ],
            examples: [
              {
                command: "wf cache sync",
                description: "Fetch new commits for every cached mirror.",
              },
              {
                command: "wf cache sync vercel/next.js facebook/react",
                description:
                  "Update cached matches and clone missing mirrors in one invocation.",
              },
            ],
            outputModes: ["report", "json"],
            tty: optionalStdin,
          }),
          leaf({
            name: "doctor",
            path: ["cache", "doctor"],
            summary: "Diagnose cached repositories",
            description:
              "Diagnoses cached bare mirrors for integrity problems — missing origin remote, non-bare or unreadable repositories, and stale worktree registrations — and reports each one's health. With no repositories, diagnoses every mirror. Reads only the local cache unless `--fix` is passed. Exits 1 if any diagnosed repository is unhealthy (in both report and JSON modes).",
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
                "fix",
                "--fix",
                undefined,
                "Repair selected mirrors before reporting health.",
              ),
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
              {
                command: "wf cache doctor vercel/next.js --fix",
                description:
                  "Repair one cached mirror before reporting health.",
              },
            ],
            outputModes: ["report", "json"],
          }),
          leaf({
            name: "delete",
            path: ["cache", "delete"],
            summary: "Delete cached repositories",
            description:
              "Permanently deletes cached bare mirrors from disk; the data must be re-cloned to use them again. Refuses (exit 1) any mirror that still has active worktrees unless you pass `--force`. Without a terminal it cannot prompt and exits 1; pass `--force` or `--dry-run` to proceed. See also `wf cache clean`.",
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
              booleanFlag(
                "json",
                "--json",
                undefined,
                "Emit deletion results as a JSON envelope.",
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
            outputModes: ["report", "json"],
            tty: optionalStdin,
          }),
          leaf({
            name: "clean",
            path: ["cache", "clean"],
            summary: "Delete unused cached repositories",
            description:
              "Permanently deletes every cached bare mirror that has no active worktrees, reclaiming disk space; cleaned data must be re-cloned to use again. Without a terminal it cannot prompt and exits 1; pass `--force` or `--dry-run` to proceed. Exits 0 with a message when nothing is unused. See also `wf cache delete`.",
            handler: "cache.clean",
            help: nestedHelp("cache", "clean"),
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
              booleanFlag(
                "json",
                "--json",
                undefined,
                "Emit cleanup results as a JSON envelope.",
              ),
            ],
            examples: [
              {
                command: "wf cache clean --dry-run",
                description: "List the unused mirrors clean would remove.",
              },
              {
                command: "wf cache clean --force",
                description: "Delete all unused mirrors without prompting.",
              },
            ],
            outputModes: ["report", "json"],
            tty: optionalStdin,
          }),
        ],
      }),
      group({
        name: "worktree",
        path: ["worktree"],
        summary: "Manage worktrees in cached repositories",
        description:
          "Runs a small fixed set of Git worktree operations against existing cached bare mirrors. These commands do not create or sync mirrors, write Workforest metadata, run setup or hooks, or filter Workforest-managed worktrees.",
        help: { kind: "command", command: "worktree" },
        children: [
          leaf({
            name: "list",
            path: ["worktree", "list"],
            summary: "List registered worktrees",
            description:
              "Lists every Git-registered worktree for an existing cached mirror, including Workforest-managed worktrees.",
            handler: "worktree.list",
            help: nestedHelp("worktree", "list"),
            operands: operands(
              1,
              1,
              "cached repository",
              undefined,
              "A cached repo name, `org/repo` shorthand, full Git URL, or cache directory name.",
            ),
            examples: [{ command: "wf worktree list vercel/front" }],
            outputModes: ["human"],
            supportsJson: false,
          }),
          leaf({
            name: "add",
            path: ["worktree", "add"],
            summary: "Add a worktree on a new branch",
            description:
              "Creates a worktree at the requested path on a new branch from the cached mirror's current HEAD. When branch is omitted, Git derives it from the destination directory name.",
            handler: "worktree.add",
            help: nestedHelp("worktree", "add"),
            operands: operands(
              2,
              3,
              "arguments",
              "<cached repository> <path> [branch]",
              "An existing cached repository, destination path, and optional new branch name.",
            ),
            examples: [
              {
                command: "wf worktree add vercel/front ~/Code/front-fix-auth",
                description:
                  "Let Git derive the new branch name from front-fix-auth.",
              },
              {
                command:
                  "wf worktree add vercel/front ~/Code/front-fix-auth tomdale/fix-auth",
                description:
                  "Create the worktree on an explicitly named branch.",
              },
            ],
            outputModes: ["human"],
            supportsJson: false,
          }),
          leaf({
            name: "move",
            path: ["worktree", "move"],
            summary: "Move a registered worktree",
            description:
              "Moves a registered worktree to a new path using Git's standard safety checks.",
            handler: "worktree.move",
            help: nestedHelp("worktree", "move"),
            operands: operands(
              3,
              3,
              "arguments",
              "<cached repository> <path> <new path>",
              "An existing cached repository, registered worktree path, and destination path.",
            ),
            examples: [
              {
                command:
                  "wf worktree move vercel/front ~/Code/front-fix-auth ~/Code/front-auth-fix",
              },
            ],
            outputModes: ["human"],
            supportsJson: false,
          }),
          leaf({
            name: "remove",
            path: ["worktree", "remove"],
            summary: "Remove a registered worktree",
            description:
              "Removes a clean registered worktree using Git's standard safety checks. The branch is left intact.",
            handler: "worktree.remove",
            help: nestedHelp("worktree", "remove"),
            operands: operands(
              2,
              2,
              "arguments",
              "<cached repository> <path>",
              "An existing cached repository and registered worktree path.",
            ),
            examples: [
              {
                command:
                  "wf worktree remove vercel/front ~/Code/front-fix-auth",
              },
            ],
            outputModes: ["human"],
            supportsJson: false,
          }),
        ],
      }),
      group({
        name: "review",
        path: ["review"],
        summary: "Manage review workspaces and PR worktrees",
        description:
          "Set up review workspaces and check out pull request worktrees inside them, for reviewing someone else's PR without disturbing your own workspaces. `wf review open` creates the per-repository review workspace; `wf review checkout` adds a worktree for a specific PR. Both store worktrees under `directory.reviews`.",
        help: { kind: "command", command: "review" },
        children: [
          leaf({
            name: "open",
            path: ["review", "open"],
            summary: "Open a review workspace",
            description:
              "Sets up a review workspace for a repository: caches its bare mirror and adds a detached worktree under `directory.reviews`, defaulting to `~/Code/Reviews`. Changes your shell's directory to the workspace under shell integration. See also `wf review checkout`.",
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
          }),
          leaf({
            name: "checkout",
            path: ["review", "checkout"],
            summary: "Check out a pull request worktree",
            description:
              "Adds a worktree for one pull request inside its review workspace, running `gh pr checkout` to fetch the PR branch — requires the `gh` CLI and network access. Run from inside a review workspace and you can pass just a PR number, taking the repository from the workspace's metadata. Uses `directory.reviews`, defaulting to `~/Code/Reviews`. Changes your shell's directory to the worktree under shell integration. See also `wf review open`.",
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
          }),
        ],
      }),
      group({
        name: "template",
        path: ["template"],
        summary: "Manage templates",
        description:
          "Create, inspect, and maintain reusable workspace templates. A template names a set of repositories plus optional hooks, a branch prefix, and bundled files, stored at `~/.config/workforest/templates/<name>/template.jsonc`. Use `wf start <change> @<template>` to build a workspace from one.",
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
            name: "suggest",
            path: ["template", "suggest"],
            summary: "Suggest templates from PR history",
            description:
              "Analyzes recent authored, reviewed, and commented GitHub pull requests with the configured AI provider, then lets you review and save suggested workspace templates. Requires an interactive terminal.",
            handler: "template.suggest",
            help: nestedHelp("template", "suggest"),
            examples: [
              {
                command: "wf template suggest",
                description:
                  "Analyze recent GitHub PR activity and choose suggested templates to save.",
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
              "Creates a new template directory and `template.jsonc` from a name and a repository set. In a terminal, prompts for anything missing; without a TTY the name and at least one repository are required, and omitting them is a usage error. Errors if a template with that name already exists. See also `wf template edit` and `wf start <change> @<template>`.",
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
          "Set up shell integration so directory-changing commands (`wf start`, `wf switch`, `wf finish`, `wf delete`, `wf task`, `wf review`, and `wf template open`) change your shell's working directory instead of just printing a path.",
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
          "Inspect and edit workforest's global settings, including `directory.base`, optional directory children, `branchPrefix`, and Vercel link settings stored in `config.json` under `$WORKFOREST_CONFIG_DIR`. With no subcommand, `wf config` runs `wf config show`.",
        help: { kind: "command", command: "config" },
        default: configDefault,
        children: [
          leaf({
            name: "show",
            path: ["config", "show"],
            summary: "Show configuration",
            description:
              "Prints the resolved global configuration, including checkout directories, branch prefix, and any Vercel link settings, followed by the path of the `config.json` it read. Unset keys show their fallback behavior. Reads only; never writes. See also `wf config edit`.",
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
              "Walks through prompts for the main checkout directories and branch prefix, shows a preview, and on confirmation writes `config.json`. Requires an interactive terminal; errors without one (exit 1). To set values without a TTY or to use the final nested `directory` shape directly, use `wf config edit`. See also `wf config show`.",
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
          "List and read the bundled agent skills. These skills are written for AI coding agents driving `wf`, not for interactive use; start with `core`. With no subcommand, `wf skills` runs `wf skills list`.",
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
              "Prints the full content of one or more skills to stdout, separated by `---`. Name one or more skills. Naming an unknown skill exits 1. For an agent getting oriented, start with `get core`. With `--json` it emits the envelope instead of plain text. See also `wf skills list`.",
            handler: "skills.get",
            help: nestedHelp("skills", "get"),
            operands: operands(
              1,
              null,
              "skill names",
              "<skill names...>",
              "One or more skill names to print.",
            ),
            flags: [
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
                command: "wf skills get core start-work",
                description: "Print several named skills, separated by `---`.",
              },
            ],
            outputModes: ["human", "json"],
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
