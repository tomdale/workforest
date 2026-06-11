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
  booleanFlag("keepMirrors", "--keep-mirrors"),
  booleanFlag("deleteRemoteBranches", "--delete-remote-branches", "-r"),
] as const;

const worktreeDefault = leaf({
  name: "",
  path: ["worktree"],
  summary: "Create a contextual worktree",
  handler: "worktree.create",
  help: { kind: "command", command: "worktree" },
  operands: operands(1, null, "worktree operands"),
  flags: [
    stringFlag("dir", "--dir", "path"),
    stringFlag("repo", "--repo", "repository"),
    booleanFlag("dryRun", "--dry-run", "-n"),
    booleanFlag("force", "--force", "-f"),
  ],
  outputModes: ["human", "report"],
  tty: optionalStdin,
  shellHandoff: "optional-cd",
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

const statusDefault = leaf({
  name: "",
  path: ["status"],
  summary: "Show repository initialization status",
  handler: "status.show",
  help: { kind: "command", command: "status" },
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
        handler: "new",
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
        name: "status",
        path: ["status"],
        summary: "Monitor repository initialization",
        help: { kind: "command", command: "status" },
        default: statusDefault,
        children: [
          leaf({
            name: "cancel",
            path: ["status", "cancel"],
            summary: "Cancel repository initializers",
            handler: "status.cancel",
            help: { kind: "nested", command: "status", subcommand: "cancel" },
            operands: operands(0, null, "repositories"),
            flags: [
              stringFlag("workspace", "--workspace", "dir", { short: "-w" }),
            ],
          }),
          leaf({
            name: "retry",
            path: ["status", "retry"],
            summary: "Retry repository initializers",
            handler: "status.retry",
            help: { kind: "nested", command: "status", subcommand: "retry" },
            operands: operands(0, null, "repositories"),
            flags: [
              stringFlag("workspace", "--workspace", "dir", { short: "-w" }),
            ],
          }),
        ],
      }),
      group({
        name: "worktree",
        path: ["worktree"],
        aliases: [
          alias("wt", {
            help: { kind: "command", command: "wt" },
          }),
        ],
        summary: "Manage contextual worktrees",
        help: { kind: "command", command: "worktree" },
        default: worktreeDefault,
        defaultOn: "unmatched",
        children: [
          leaf({
            name: "new",
            path: ["worktree", "new"],
            summary: "Create a managed worktree",
            handler: "worktree.new",
            help: { kind: "nested", command: "worktree", subcommand: "new" },
            operands: operands(1, 2, "worktree operands"),
            flags: [booleanFlag("dryRun", "--dry-run", "-n")],
            outputModes: ["human", "report"],
            tty: optionalStdin,
            shellHandoff: "optional-cd",
          }),
          leaf({
            name: "promote",
            path: ["worktree", "promote"],
            summary: "Promote a managed worktree",
            handler: "worktree.promote",
            help: {
              kind: "nested",
              command: "worktree",
              subcommand: "promote",
            },
            operands: operands(0, null, "templates or repositories"),
            flags: [booleanFlag("dryRun", "--dry-run", "-n")],
            outputModes: ["human", "report"],
            tty: optionalStdin,
            shellHandoff: "optional-cd",
          }),
          leaf({
            name: "list",
            path: ["worktree", "list"],
            summary: "List contextual worktrees",
            handler: "worktree.list",
            help: { kind: "nested", command: "worktree", subcommand: "list" },
            flags: [stringFlag("repo", "--repo", "repository")],
            outputModes: ["report"],
          }),
          leaf({
            name: "delete",
            path: ["worktree", "delete"],
            aliases: [alias("rm")],
            summary: "Delete contextual worktrees",
            handler: "worktree.delete",
            help: {
              kind: "nested",
              command: "worktree",
              subcommand: "delete",
            },
            operands: operands(0, null, "worktree names"),
            flags: [
              stringFlag("repo", "--repo", "repository"),
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
        name: "review",
        path: ["review"],
        summary: "Open review repositories and check out pull requests",
        help: { kind: "command", command: "review" },
        children: [
          leaf({
            name: "open",
            path: ["review", "open"],
            summary: "Open a review repository",
            handler: "review.open",
            help: { kind: "nested", command: "review", subcommand: "open" },
            operands: operands(1, 1, "repository"),
            outputModes: ["human", "report"],
            tty: optionalStdin,
            shellHandoff: "optional-cd",
          }),
          leaf({
            name: "checkout",
            path: ["review", "checkout"],
            summary: "Check out a pull request for review",
            handler: "review.checkout",
            help: {
              kind: "nested",
              command: "review",
              subcommand: "checkout",
            },
            operands: operands(1, 2, "review targets"),
            outputModes: ["human", "report"],
            tty: optionalStdin,
            shellHandoff: "optional-cd",
          }),
        ],
      }),
      leaf({
        name: "delete",
        path: ["delete"],
        summary: "Delete the current tracked resource",
        handler: "delete",
        help: { kind: "command", command: "delete" },
        operands: operands(0, 1, "workspace"),
        flags: workspaceDeleteFlags,
        outputModes: ["human", "report"],
        tty: optionalStdin,
        shellHandoff: "optional-cd",
      }),
      group({
        name: "workspace",
        path: ["workspace"],
        summary: "Manage workspaces",
        help: { kind: "command", command: "workspace" },
        children: [
          leaf({
            name: "delete",
            path: ["workspace", "delete"],
            aliases: [alias("rm")],
            summary: "Delete a workspace",
            handler: "workspace.delete",
            help: {
              kind: "nested",
              command: "workspace",
              subcommand: "delete",
            },
            operands: operands(0, 1, "workspace"),
            flags: workspaceDeleteFlags,
            outputModes: ["human", "report"],
            tty: optionalStdin,
            shellHandoff: "optional-cd",
          }),
        ],
      }),
      leaf({
        name: "cd",
        path: ["cd"],
        summary: "Open a workspace",
        handler: "cd",
        help: { kind: "command", command: "cd" },
        operands: {
          variants: [
            {
              beforeDoubleDash: cardinality(1, 1, "workspace"),
              delimiter: "forbidden",
            },
            {
              beforeDoubleDash: cardinality(0, 0, "workspace"),
              delimiter: "forbidden",
              when: { interactive: true },
            },
          ],
        },
        tty: optionalStdin,
        shellHandoff: "optional-cd",
      }),
      leaf({
        name: "find",
        path: ["find"],
        summary: "Fuzzy-find a workspace",
        handler: "find",
        help: { kind: "command", command: "find" },
        tty: requiredStdin,
        shellHandoff: "optional-cd",
      }),
      leaf({
        name: "add",
        path: ["add"],
        summary: "Add repositories to a workspace",
        handler: "add",
        help: { kind: "command", command: "add" },
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
      leaf({
        name: "fork",
        path: ["fork"],
        summary: "Fork the current workspace",
        handler: "fork",
        help: { kind: "command", command: "fork" },
        operands: {
          variants: [
            {
              beforeDoubleDash: cardinality(1, 1, "name or description"),
              delimiter: "forbidden",
            },
            {
              beforeDoubleDash: cardinality(0, 0, "name or description"),
              delimiter: "forbidden",
              when: { flag: "description", present: true },
            },
            {
              beforeDoubleDash: cardinality(0, 0, "name or description"),
              delimiter: "forbidden",
              when: {
                flag: "description",
                present: false,
                interactive: true,
              },
            },
          ],
        },
        flags: [
          stringFlag("description", "--description", "description", {
            short: "-d",
          }),
          booleanFlag("dryRun", "--dry-run", "-n"),
        ],
        outputModes: ["interactive", "report"],
        tty: optionalStdin,
        shellHandoff: "optional-cd",
      }),
      leaf({
        name: "clean",
        path: ["clean"],
        summary: "Delete a workspace",
        handler: "clean",
        help: { kind: "command", command: "clean" },
        operands: operands(0, 1, "workspace"),
        flags: workspaceDeleteFlags,
        outputModes: ["human", "report"],
        tty: optionalStdin,
        shellHandoff: "optional-cd",
      }),
      leaf({
        name: "list",
        path: ["list"],
        aliases: [
          alias("ls", {
            help: { kind: "command", command: "ls" },
          }),
        ],
        summary: "List workspaces",
        handler: "list",
        help: { kind: "command", command: "list" },
        outputModes: ["report"],
      }),
      group({
        name: "shell",
        path: ["shell"],
        summary: "Configure shell integration",
        help: { kind: "command", command: "shell" },
        children: [
          leaf({
            name: "init",
            path: ["shell", "init"],
            summary: "Print shell integration",
            handler: "shell.init",
            help: { kind: "nested", command: "shell", subcommand: "init" },
            operands: operands(0, 1, "shell"),
            outputModes: ["shell"],
          }),
        ],
      }),
      group({
        name: "template",
        path: ["template"],
        summary: "Manage templates",
        help: { kind: "command", command: "template" },
        children: [
          leaf({
            name: "manage",
            path: ["template", "manage"],
            summary: "Open the template manager",
            handler: "template.manage",
            help: { kind: "nested", command: "template", subcommand: "manage" },
            outputModes: ["interactive", "report"],
            tty: optionalStdin,
          }),
          leaf({
            name: "list",
            path: ["template", "list"],
            summary: "List templates",
            handler: "template.list",
            help: { kind: "nested", command: "template", subcommand: "list" },
            outputModes: ["report"],
          }),
          leaf({
            name: "open",
            path: ["template", "open"],
            summary: "Open a template directory",
            handler: "template.open",
            help: { kind: "nested", command: "template", subcommand: "open" },
            operands: operands(1, 1, "template"),
            outputModes: ["path"],
            shellHandoff: "optional-cd",
          }),
          leaf({
            name: "show",
            path: ["template", "show"],
            summary: "Show template information",
            handler: "template.show",
            help: { kind: "nested", command: "template", subcommand: "show" },
            operands: operands(1, 1, "template"),
            outputModes: ["report"],
          }),
          leaf({
            name: "new",
            path: ["template", "new"],
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
            summary: "Copy a template",
            handler: "template.copy",
            help: { kind: "nested", command: "template", subcommand: "copy" },
            operands: operands(2, 2, "templates"),
          }),
          leaf({
            name: "delete",
            path: ["template", "delete"],
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
        name: "cache",
        path: ["cache"],
        summary: "Manage cached repositories",
        help: { kind: "command", command: "cache" },
        children: [
          leaf({
            name: "manage",
            path: ["cache", "manage"],
            summary: "Open the cache manager",
            handler: "cache.manage",
            help: { kind: "nested", command: "cache", subcommand: "manage" },
            outputModes: ["interactive", "report"],
            tty: optionalStdin,
          }),
          leaf({
            name: "list",
            path: ["cache", "list"],
            summary: "List cached repositories",
            handler: "cache.list",
            help: {
              kind: "nested",
              command: "cache",
              subcommand: "list",
            },
            flags: [booleanFlag("json", "--json")],
            outputModes: ["report", "json"],
          }),
          leaf({
            name: "info",
            path: ["cache", "info"],
            summary: "Show cached repository information",
            handler: "cache.info",
            help: {
              kind: "nested",
              command: "cache",
              subcommand: "info",
            },
            operands: operands(1, 1, "repository"),
            flags: [booleanFlag("json", "--json")],
            outputModes: ["report", "json"],
          }),
          leaf({
            name: "path",
            path: ["cache", "path"],
            summary: "Print a cached repository path",
            handler: "cache.path",
            help: {
              kind: "nested",
              command: "cache",
              subcommand: "path",
            },
            operands: operands(0, 1, "repository"),
            outputModes: ["path"],
          }),
          leaf({
            name: "add",
            path: ["cache", "add"],
            summary: "Cache repositories",
            handler: "cache.add",
            help: {
              kind: "nested",
              command: "cache",
              subcommand: "add",
            },
            operands: operands(1, null, "repositories"),
            tty: optionalStdin,
          }),
          leaf({
            name: "update",
            path: ["cache", "update"],
            summary: "Update cached repositories",
            handler: "cache.update",
            help: {
              kind: "nested",
              command: "cache",
              subcommand: "update",
            },
            operands: operands(0, null, "repositories"),
            tty: optionalStdin,
          }),
          leaf({
            name: "doctor",
            path: ["cache", "doctor"],
            summary: "Check cached repositories",
            handler: "cache.doctor",
            help: {
              kind: "nested",
              command: "cache",
              subcommand: "doctor",
            },
            operands: operands(0, null, "repositories"),
            flags: [booleanFlag("json", "--json")],
            outputModes: ["report", "json"],
          }),
          leaf({
            name: "repair",
            path: ["cache", "repair"],
            summary: "Repair cached repositories",
            handler: "cache.repair",
            help: {
              kind: "nested",
              command: "cache",
              subcommand: "repair",
            },
            operands: operands(0, null, "repositories"),
            tty: optionalStdin,
          }),
          leaf({
            name: "delete",
            path: ["cache", "delete"],
            summary: "Delete cached repositories",
            handler: "cache.delete",
            help: {
              kind: "nested",
              command: "cache",
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
            name: "prune",
            path: ["cache", "prune"],
            summary: "Delete unused cached repositories",
            handler: "cache.prune",
            help: {
              kind: "nested",
              command: "cache",
              subcommand: "prune",
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
