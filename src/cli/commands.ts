import type {
  AliasDefinition,
  Cardinality,
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
const requiredStdout: TtyRequirement = {
  kind: "required",
  streams: ["stdout"],
};

function alias(
  name: string,
  options: { visibility?: Visibility; help?: HelpReference } = {},
): AliasDefinition {
  return {
    name,
    visibility: options.visibility ?? visible,
    ...(options.help ? { help: options.help } : {}),
  };
}

function booleanFlag(
  name: string,
  long: `--${string}`,
  short?: `-${string}`,
): FlagDefinition {
  return {
    name,
    long,
    kind: "boolean",
    ...(short ? { short } : {}),
  };
}

function stringFlag(
  name: string,
  long: `--${string}`,
  valueName: string,
  options: { short?: `-${string}`; required?: boolean } = {},
): FlagDefinition {
  return {
    name,
    long,
    kind: "string",
    valueName,
    ...(options.short ? { short: options.short } : {}),
    ...(options.required ? { required: true } : {}),
  };
}

function cardinality(
  min: number,
  max: number | null,
  label = "operands",
): Cardinality {
  return { min, max, label };
}

function operands(
  min: number,
  max: number | null,
  label = "operands",
): OperandSpec {
  return {
    variants: [
      {
        beforeDoubleDash: cardinality(min, max, label),
        delimiter: "forbidden",
      },
    ],
  };
}

function leaf(options: {
  name: string;
  path: readonly string[];
  summary: string;
  handler: string;
  help: HelpReference;
  operands?: OperandSpec;
  aliases?: readonly AliasDefinition[];
  flags?: readonly FlagDefinition[];
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
    help: options.help,
    operands: options.operands ?? operands(0, 0),
    flags: options.flags ?? [],
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
  help: HelpReference;
  children: readonly CommandNode[];
  default?: CommandLeaf;
  defaultOn?: "empty" | "unmatched";
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
    help: options.help,
    children: options.children,
    ...(options.default ? { default: options.default } : {}),
    defaultOn: options.defaultOn ?? "empty",
  };
}

const workspaceDeleteFlags = [
  booleanFlag("dryRun", "--dry-run", "-n"),
  booleanFlag("force", "--force", "-f"),
  booleanFlag("deleteMirrors", "--delete-mirrors"),
  booleanFlag("deleteRemoteBranches", "--delete-remote-branches", "-r"),
] as const;

const reviewDefault = leaf({
  name: "",
  path: ["review"],
  summary: "Create a review workspace or PR worktree",
  handler: "review.create",
  help: { kind: "command", command: "review" },
  operands: operands(1, 2, "review targets"),
  outputModes: ["human", "report"],
  tty: optionalStdin,
  shellHandoff: "optional-cd",
});

const templateDefault = leaf({
  name: "",
  path: ["template"],
  summary: "Open the template manager or list templates",
  handler: "template.default",
  help: { kind: "command", command: "template" },
  outputModes: ["interactive", "report"],
  tty: optionalStdin,
});

const repositoryDefault = leaf({
  name: "",
  path: ["repository"],
  summary: "Open the repository manager or list cached repositories",
  handler: "repository.default",
  help: { kind: "command", command: "repository" },
  outputModes: ["interactive", "report"],
  tty: optionalStdin,
});

const skillsDefault = leaf({
  name: "",
  path: ["skills"],
  summary: "List bundled agent skills",
  handler: "skills.list",
  help: { kind: "command", command: "skills" },
  flags: [booleanFlag("json", "--json")],
  outputModes: ["report", "json"],
});

const workspaceStatus = leaf({
  name: "status",
  path: ["workspace", "status"],
  summary: "Show repository initialization status",
  handler: "workspace.status",
  help: { kind: "nested", command: "workspace", subcommand: "status" },
  flags: [
    booleanFlag("json", "--json"),
    stringFlag("workspace", "--workspace", "dir", { short: "-w" }),
  ],
  outputModes: ["interactive", "report", "json"],
  tty: optionalStdin,
});

const configDefault = leaf({
  name: "",
  path: ["config"],
  summary: "Show configuration",
  handler: "config.show",
  help: { kind: "command", command: "config" },
  outputModes: ["report"],
});

export const commandRegistry: CommandRegistry = {
  root: group({
    name: "",
    path: [],
    summary: "Workforest command line interface",
    help: { kind: "root" },
    children: [
      leaf({
        name: "new",
        path: ["new"],
        summary: "Create a workspace",
        handler: "workspace.create",
        help: { kind: "command", command: "new" },
        operands: {
          variants: [
            {
              beforeDoubleDash: cardinality(0, 0),
              delimiter: "forbidden",
              when: { interactive: true },
            },
            {
              beforeDoubleDash: cardinality(
                1,
                null,
                "templates or repositories",
              ),
              delimiter: "required",
              afterDoubleDash: cardinality(1, null, "work words"),
            },
          ],
        },
        flags: [booleanFlag("dryRun", "--dry-run", "-n")],
        outputModes: ["interactive", "report"],
        tty: optionalStdin,
        shellHandoff: "optional-cd",
      }),
      group({
        name: "worktree",
        path: ["worktree"],
        summary: "Manage standalone worktrees",
        help: { kind: "command", command: "worktree" },
        children: [
          leaf({
            name: "create",
            path: ["worktree", "create"],
            summary: "Create a standalone worktree",
            handler: "worktree.create",
            help: {
              kind: "nested",
              command: "worktree",
              subcommand: "create",
            },
            operands: operands(2, 2, "repository and slug"),
            flags: [
              stringFlag("dir", "--dir", "path"),
              booleanFlag("dryRun", "--dry-run", "-n"),
            ],
            outputModes: ["human", "report"],
            tty: optionalStdin,
            shellHandoff: "optional-cd",
          }),
          leaf({
            name: "list",
            path: ["worktree", "list"],
            summary: "List standalone worktrees",
            handler: "worktree.list",
            help: { kind: "nested", command: "worktree", subcommand: "list" },
            operands: operands(0, 1, "repository"),
            outputModes: ["report"],
          }),
          leaf({
            name: "delete",
            path: ["worktree", "delete"],
            summary: "Delete a standalone worktree",
            handler: "worktree.delete",
            help: {
              kind: "nested",
              command: "worktree",
              subcommand: "delete",
            },
            operands: operands(1, 1, "worktree path"),
            flags: [
              booleanFlag("dryRun", "--dry-run", "-n"),
              booleanFlag("force", "--force", "-f"),
            ],
            outputModes: ["human", "report"],
            tty: optionalStdin,
            shellHandoff: "optional-cd",
          }),
        ],
      }),
      group({
        name: "task",
        path: ["task"],
        summary: "Manage workspace tasks",
        help: { kind: "command", command: "task" },
        children: [
          leaf({
            name: "create",
            path: ["task", "create"],
            summary: "Create workspace task worktrees",
            handler: "task.create",
            help: { kind: "nested", command: "task", subcommand: "create" },
            operands: operands(1, null, "task names"),
            flags: [
              stringFlag("repo", "--repo", "repository"),
              booleanFlag("dryRun", "--dry-run", "-n"),
              booleanFlag("force", "--force", "-f"),
            ],
            outputModes: ["human", "report"],
            tty: optionalStdin,
            shellHandoff: "optional-cd",
          }),
          leaf({
            name: "list",
            path: ["task", "list"],
            summary: "List workspace tasks",
            handler: "task.list",
            help: { kind: "nested", command: "task", subcommand: "list" },
            flags: [stringFlag("repo", "--repo", "repository")],
            outputModes: ["report"],
          }),
          leaf({
            name: "delete",
            path: ["task", "delete"],
            summary: "Delete workspace tasks",
            handler: "task.delete",
            help: { kind: "nested", command: "task", subcommand: "delete" },
            operands: operands(1, null, "task names"),
            flags: [
              stringFlag("repo", "--repo", "repository"),
              booleanFlag("dryRun", "--dry-run", "-n"),
              booleanFlag("force", "--force", "-f"),
            ],
            outputModes: ["human", "report"],
            tty: optionalStdin,
          }),
        ],
      }),
      group({
        name: "review",
        path: ["review"],
        summary: "Manage review workspaces and PR worktrees",
        help: { kind: "command", command: "review" },
        default: reviewDefault,
        defaultOn: "unmatched",
        children: [
          leaf({
            name: "list",
            path: ["review", "list"],
            aliases: [alias("ls")],
            summary: "List review worktrees",
            handler: "review.list",
            help: { kind: "nested", command: "review", subcommand: "list" },
            operands: operands(0, 1, "repository"),
            outputModes: ["report"],
          }),
          leaf({
            name: "delete",
            path: ["review", "delete"],
            aliases: [alias("rm"), alias("remove")],
            summary: "Delete a review worktree",
            handler: "review.delete",
            help: { kind: "nested", command: "review", subcommand: "delete" },
            operands: operands(1, 2, "review targets"),
            flags: [
              booleanFlag("dryRun", "--dry-run", "-n"),
              booleanFlag("force", "--force", "-f"),
            ],
            outputModes: ["human", "report"],
            tty: optionalStdin,
            shellHandoff: "optional-cd",
          }),
        ],
      }),
      group({
        name: "workspace",
        path: ["workspace"],
        summary: "Manage workspaces",
        help: { kind: "command", command: "workspace" },
        children: [
          leaf({
            name: "create",
            path: ["workspace", "create"],
            summary: "Create a workspace",
            handler: "workspace.create",
            help: {
              kind: "nested",
              command: "workspace",
              subcommand: "create",
            },
            operands: {
              variants: [
                {
                  beforeDoubleDash: cardinality(0, 0),
                  delimiter: "forbidden",
                  when: {
                    flag: "like",
                    present: false,
                    interactive: true,
                  },
                },
                {
                  beforeDoubleDash: cardinality(
                    1,
                    null,
                    "templates or repositories",
                  ),
                  delimiter: "required",
                  afterDoubleDash: cardinality(1, null, "work words"),
                  when: { flag: "like", present: false },
                },
                {
                  beforeDoubleDash: cardinality(0, 0),
                  delimiter: "required",
                  afterDoubleDash: cardinality(1, null, "work words"),
                  when: { flag: "like", present: true },
                },
              ],
            },
            flags: [
              stringFlag("like", "--like", "workspace"),
              booleanFlag("dryRun", "--dry-run", "-n"),
            ],
            outputModes: ["interactive", "report"],
            tty: optionalStdin,
            shellHandoff: "optional-cd",
          }),
          leaf({
            name: "delete",
            path: ["workspace", "delete"],
            summary: "Delete a workspace",
            handler: "workspace.delete",
            help: {
              kind: "nested",
              command: "workspace",
              subcommand: "delete",
            },
            operands: operands(1, 1, "workspace"),
            flags: workspaceDeleteFlags,
            outputModes: ["human", "report"],
            tty: optionalStdin,
            shellHandoff: "optional-cd",
          }),
          leaf({
            name: "open",
            path: ["workspace", "open"],
            summary: "Open a workspace",
            handler: "workspace.open",
            help: {
              kind: "nested",
              command: "workspace",
              subcommand: "open",
            },
            operands: {
              variants: [
                {
                  beforeDoubleDash: cardinality(0, 1, "workspace"),
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
            flags: [booleanFlag("search", "--search")],
            tty: optionalStdin,
            shellHandoff: "optional-cd",
          }),
          leaf({
            name: "list",
            path: ["workspace", "list"],
            summary: "List workspaces",
            handler: "workspace.list",
            help: {
              kind: "nested",
              command: "workspace",
              subcommand: "list",
            },
            outputModes: ["report"],
          }),
          workspaceStatus,
          leaf({
            name: "add",
            path: ["workspace", "add"],
            summary: "Add repositories to a workspace",
            handler: "workspace.add",
            help: {
              kind: "nested",
              command: "workspace",
              subcommand: "add",
            },
            operands: {
              variants: [
                {
                  beforeDoubleDash: cardinality(0, null, "repositories"),
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
              stringFlag("workspace", "--workspace", "dir", { short: "-w" }),
              booleanFlag("dryRun", "--dry-run", "-n"),
            ],
            outputModes: ["interactive", "report"],
            tty: optionalStdin,
          }),
        ],
      }),
      leaf({
        name: "clean",
        path: ["clean"],
        summary: "Delete a workspace",
        handler: "clean",
        help: { kind: "command", command: "clean" },
        operands: operands(1, 1, "workspace"),
        flags: workspaceDeleteFlags,
        outputModes: ["human", "report"],
        tty: optionalStdin,
        shellHandoff: "optional-cd",
      }),
      leaf({
        name: "init",
        path: ["init"],
        summary: "Print shell integration",
        handler: "init",
        help: { kind: "command", command: "init" },
        operands: operands(0, 1, "shell"),
        outputModes: ["shell"],
      }),
      group({
        name: "template",
        path: ["template"],
        aliases: [
          alias("templates", {
            help: { kind: "command", command: "templates" },
          }),
        ],
        summary: "Manage templates",
        help: { kind: "command", command: "template" },
        default: templateDefault,
        children: [
          leaf({
            name: "list",
            path: ["template", "list"],
            aliases: [alias("ls")],
            summary: "List templates",
            handler: "template.list",
            help: { kind: "nested", command: "template", subcommand: "list" },
            outputModes: ["report"],
          }),
          leaf({
            name: "show",
            path: ["template", "show"],
            summary: "Open a template directory",
            handler: "template.show",
            help: { kind: "nested", command: "template", subcommand: "show" },
            operands: operands(1, 1, "template"),
            outputModes: ["path"],
            shellHandoff: "optional-cd",
          }),
          leaf({
            name: "info",
            path: ["template", "info"],
            summary: "Show template information",
            handler: "template.info",
            help: { kind: "nested", command: "template", subcommand: "info" },
            operands: operands(1, 1, "template"),
            outputModes: ["report"],
          }),
          leaf({
            name: "new",
            path: ["template", "new"],
            aliases: [alias("create")],
            summary: "Create a template",
            handler: "template.new",
            help: { kind: "nested", command: "template", subcommand: "new" },
            operands: {
              variants: [
                {
                  beforeDoubleDash: cardinality(
                    0,
                    null,
                    "template and repositories",
                  ),
                  delimiter: "forbidden",
                  when: { interactive: true },
                },
                {
                  beforeDoubleDash: cardinality(
                    2,
                    null,
                    "template and repositories",
                  ),
                  delimiter: "forbidden",
                  when: { interactive: false },
                },
              ],
            },
            flags: [
              stringFlag("description", "--description", "description", {
                short: "-d",
              }),
            ],
            tty: optionalStdin,
          }),
          leaf({
            name: "edit",
            path: ["template", "edit"],
            summary: "Edit a template",
            handler: "template.edit",
            help: { kind: "nested", command: "template", subcommand: "edit" },
            operands: operands(1, 1, "template"),
            outputModes: ["interactive"],
            tty: requiredStdin,
          }),
          leaf({
            name: "add-file",
            path: ["template", "add-file"],
            summary: "Add files to a template",
            handler: "template.add-file",
            help: {
              kind: "nested",
              command: "template",
              subcommand: "add-file",
            },
            operands: operands(1, null, "paths"),
            flags: [
              stringFlag("template", "--template", "template", {
                short: "-t",
              }),
            ],
            tty: optionalStdin,
          }),
          leaf({
            name: "copy",
            path: ["template", "copy"],
            aliases: [alias("cp")],
            summary: "Copy a template",
            handler: "template.copy",
            help: { kind: "nested", command: "template", subcommand: "copy" },
            operands: operands(2, 2, "templates"),
          }),
          leaf({
            name: "delete",
            path: ["template", "delete"],
            aliases: [alias("rm")],
            summary: "Delete a template",
            handler: "template.delete",
            help: {
              kind: "nested",
              command: "template",
              subcommand: "delete",
            },
            operands: operands(1, 1, "template"),
            flags: [booleanFlag("force", "--force", "-f")],
            tty: optionalStdin,
          }),
        ],
      }),
      group({
        name: "repository",
        path: ["repository"],
        aliases: [
          alias("repo", {
            help: { kind: "command", command: "repo" },
          }),
          alias("repositories", {
            help: { kind: "command", command: "repositories" },
          }),
          alias("repos", {
            help: { kind: "command", command: "repos" },
          }),
        ],
        summary: "Manage cached repositories",
        help: { kind: "command", command: "repository" },
        default: repositoryDefault,
        children: [
          leaf({
            name: "list",
            path: ["repository", "list"],
            aliases: [alias("ls")],
            summary: "List cached repositories",
            handler: "repository.list",
            help: {
              kind: "nested",
              command: "repository",
              subcommand: "list",
            },
            flags: [booleanFlag("json", "--json")],
            outputModes: ["report", "json"],
          }),
          leaf({
            name: "info",
            path: ["repository", "info"],
            summary: "Show cached repository information",
            handler: "repository.info",
            help: {
              kind: "nested",
              command: "repository",
              subcommand: "info",
            },
            operands: operands(1, 1, "repository"),
            flags: [booleanFlag("json", "--json")],
            outputModes: ["report", "json"],
          }),
          leaf({
            name: "path",
            path: ["repository", "path"],
            summary: "Print a cached repository path",
            handler: "repository.path",
            help: {
              kind: "nested",
              command: "repository",
              subcommand: "path",
            },
            operands: operands(0, 1, "repository"),
            outputModes: ["path"],
          }),
          leaf({
            name: "add",
            path: ["repository", "add"],
            aliases: [alias("cache")],
            summary: "Cache repositories",
            handler: "repository.add",
            help: {
              kind: "nested",
              command: "repository",
              subcommand: "add",
            },
            operands: operands(1, null, "repositories"),
            tty: optionalStdin,
          }),
          leaf({
            name: "update",
            path: ["repository", "update"],
            aliases: [alias("fetch")],
            summary: "Update cached repositories",
            handler: "repository.update",
            help: {
              kind: "nested",
              command: "repository",
              subcommand: "update",
            },
            operands: operands(0, null, "repositories"),
            tty: optionalStdin,
          }),
          leaf({
            name: "doctor",
            path: ["repository", "doctor"],
            aliases: [alias("check")],
            summary: "Check cached repositories",
            handler: "repository.doctor",
            help: {
              kind: "nested",
              command: "repository",
              subcommand: "doctor",
            },
            operands: operands(0, null, "repositories"),
            flags: [booleanFlag("json", "--json")],
            outputModes: ["report", "json"],
          }),
          leaf({
            name: "repair",
            path: ["repository", "repair"],
            summary: "Repair cached repositories",
            handler: "repository.repair",
            help: {
              kind: "nested",
              command: "repository",
              subcommand: "repair",
            },
            operands: operands(0, null, "repositories"),
            tty: optionalStdin,
          }),
          leaf({
            name: "delete",
            path: ["repository", "delete"],
            aliases: [alias("rm"), alias("remove")],
            summary: "Delete cached repositories",
            handler: "repository.delete",
            help: {
              kind: "nested",
              command: "repository",
              subcommand: "delete",
            },
            operands: operands(1, null, "repositories"),
            flags: [
              booleanFlag("dryRun", "--dry-run", "-n"),
              booleanFlag("force", "--force", "-f"),
            ],
            tty: optionalStdin,
          }),
          leaf({
            name: "clean",
            path: ["repository", "clean"],
            aliases: [alias("prune")],
            summary: "Delete unused cached repositories",
            handler: "repository.clean",
            help: {
              kind: "nested",
              command: "repository",
              subcommand: "clean",
            },
            flags: [
              booleanFlag("dryRun", "--dry-run", "-n"),
              booleanFlag("force", "--force", "-f"),
            ],
            tty: optionalStdin,
          }),
        ],
      }),
      group({
        name: "config",
        path: ["config"],
        summary: "Manage configuration",
        help: { kind: "command", command: "config" },
        default: configDefault,
        children: [
          leaf({
            name: "show",
            path: ["config", "show"],
            summary: "Show configuration",
            handler: "config.show",
            help: { kind: "nested", command: "config", subcommand: "show" },
            outputModes: ["report"],
          }),
          leaf({
            name: "init",
            path: ["config", "init"],
            summary: "Configure workforest interactively",
            handler: "config.init",
            help: { kind: "nested", command: "config", subcommand: "init" },
            outputModes: ["interactive"],
            tty: requiredStdin,
          }),
          leaf({
            name: "edit",
            path: ["config", "edit"],
            summary: "Open the configuration editor",
            handler: "config.edit",
            help: { kind: "nested", command: "config", subcommand: "edit" },
            outputModes: ["interactive"],
            tty: requiredStdin,
          }),
        ],
      }),
      group({
        name: "skills",
        path: ["skills"],
        summary: "Inspect bundled agent skills",
        help: { kind: "command", command: "skills" },
        default: skillsDefault,
        children: [
          leaf({
            name: "list",
            path: ["skills", "list"],
            summary: "List bundled agent skills",
            handler: "skills.list",
            help: { kind: "nested", command: "skills", subcommand: "list" },
            flags: [booleanFlag("json", "--json")],
            outputModes: ["report", "json"],
          }),
          leaf({
            name: "get",
            path: ["skills", "get"],
            summary: "Print bundled skill content",
            handler: "skills.get",
            help: { kind: "nested", command: "skills", subcommand: "get" },
            operands: {
              variants: [
                {
                  beforeDoubleDash: cardinality(1, null, "skill names"),
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
              booleanFlag("full", "--full"),
              booleanFlag("all", "--all"),
              booleanFlag("json", "--json"),
            ],
            outputModes: ["human", "json"],
          }),
          leaf({
            name: "path",
            path: ["skills", "path"],
            summary: "Print bundled skill paths",
            handler: "skills.path",
            help: { kind: "nested", command: "skills", subcommand: "path" },
            operands: operands(0, 1, "skill"),
            flags: [booleanFlag("json", "--json")],
            outputModes: ["path", "json"],
          }),
        ],
      }),
      group({
        name: "dev",
        path: ["dev"],
        summary: "Run development simulations",
        help: { kind: "command", command: "dev" },
        visibility: hidden,
        children: [
          group({
            name: "simulate",
            path: ["dev", "simulate"],
            aliases: [alias("sim", { visibility: hidden })],
            summary: "Run a development UI simulation",
            help: { kind: "dev-simulation", flow: "simulate" },
            visibility: hidden,
            children: [
              leaf({
                name: "new",
                path: ["dev", "simulate", "new"],
                summary: "Run the workspace creation simulation",
                handler: "dev.simulate.new",
                help: { kind: "dev-simulation", flow: "new" },
                flags: [
                  stringFlag("failRepo", "--fail-repo", "repository"),
                  stringFlag("speed", "--speed", "speed"),
                ],
                outputModes: ["interactive"],
                tty: requiredStdout,
                visibility: hidden,
              }),
              leaf({
                name: "confetti",
                path: ["dev", "simulate", "confetti"],
                summary: "Run the completion simulation",
                handler: "dev.simulate.confetti",
                help: { kind: "dev-simulation", flow: "confetti" },
                flags: [
                  stringFlag("workspace", "--workspace", "path"),
                  stringFlag("repos", "--repos", "repositories"),
                ],
                outputModes: ["interactive"],
                tty: requiredStdout,
                visibility: hidden,
              }),
            ],
          }),
        ],
      }),
      leaf({
        name: "version",
        path: ["version"],
        aliases: [
          alias("--version", { visibility: hidden }),
          alias("-V", { visibility: hidden }),
        ],
        summary: "Print the workforest version",
        handler: "version",
        help: { kind: "command", command: "version" },
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
  } else if (groupNode.defaultOn === "unmatched") {
    throw new Error(
      `Command group ${formatPath(groupNode.path)} cannot use unmatched defaults without a default leaf.`,
    );
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
