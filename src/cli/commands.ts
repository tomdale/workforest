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
  usage?: string,
): Cardinality {
  return { min, max, label, ...(usage ? { usage } : {}) };
}

function operands(
  min: number,
  max: number | null,
  label = "operands",
  usage?: string,
): OperandSpec {
  return {
    variants: [
      {
        beforeDoubleDash: cardinality(min, max, label, usage),
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
      beforeDoubleDash: cardinality(1, null, "templates or repositories"),
      delimiter: "required",
      afterDoubleDash: cardinality(1, null, "work words"),
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
  booleanFlag("dryRun", "--dry-run", "-n"),
  booleanFlag("force", "--force", "-f"),
  booleanFlag("deleteMirrors", "--delete-mirrors"),
  booleanFlag("deleteRemoteBranches", "--delete-remote-branches", "-r"),
] as const;

const configDefault = leaf({
  name: "",
  path: ["config"],
  summary: "Show configuration",
  handler: "config.show",
  help: { kind: "command", command: "config" },
  outputModes: ["report"],
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

const workspaceCreate = leaf({
  name: "create",
  path: ["workspace", "create"],
  summary: "Create a workspace",
  handler: "workspace.create",
  help: nestedHelp("workspace", "create"),
  operands: workspaceCreateOperands,
  flags: [
    stringFlag("like", "--like", "workspace"),
    stringFlag("description", "--description", "description", { short: "-d" }),
    booleanFlag("dryRun", "--dry-run", "-n"),
  ],
  outputModes: ["interactive", "report"],
  tty: optionalStdin,
  shellHandoff: "optional-cd",
});

const workspaceDelete = leaf({
  name: "delete",
  path: ["workspace", "delete"],
  summary: "Delete a workspace",
  handler: "workspace.delete",
  help: nestedHelp("workspace", "delete"),
  operands: operands(1, 1, "workspace"),
  flags: workspaceDeleteFlags,
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
      group({
        name: "workspace",
        path: ["workspace"],
        summary: "Manage workspaces",
        help: { kind: "command", command: "workspace" },
        children: [
          workspaceCreate,
          workspaceDelete,
          leaf({
            name: "open",
            path: ["workspace", "open"],
            summary: "Open a workspace",
            handler: "workspace.open",
            help: nestedHelp("workspace", "open"),
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
            help: nestedHelp("workspace", "list"),
            outputModes: ["report"],
          }),
          leaf({
            name: "status",
            path: ["workspace", "status"],
            summary: "Show repository initialization status",
            handler: "workspace.status",
            help: nestedHelp("workspace", "status"),
            flags: [
              booleanFlag("json", "--json"),
              stringFlag("workspace", "--workspace", "dir", { short: "-w" }),
            ],
            outputModes: ["interactive", "report", "json"],
            tty: optionalStdin,
          }),
          leaf({
            name: "add",
            path: ["workspace", "add"],
            summary: "Add repositories to a workspace",
            handler: "workspace.add",
            help: nestedHelp("workspace", "add"),
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
      group({
        name: "task",
        path: ["task"],
        summary: "Manage temporary workspace tasks",
        help: { kind: "command", command: "task" },
        children: [
          leaf({
            name: "create",
            path: ["task", "create"],
            summary: "Create temporary worktrees",
            handler: "task.create",
            help: nestedHelp("task", "create"),
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
            summary: "List temporary worktrees",
            handler: "task.list",
            help: nestedHelp("task", "list"),
            flags: [stringFlag("repo", "--repo", "repository")],
            outputModes: ["report"],
          }),
          leaf({
            name: "delete",
            path: ["task", "delete"],
            summary: "Delete temporary worktrees",
            handler: "task.delete",
            help: nestedHelp("task", "delete"),
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
        ],
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
            help: nestedHelp("worktree", "create"),
            operands: operands(
              2,
              2,
              "repository and worktree name",
              "<repository> <worktree name>",
            ),
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
            help: nestedHelp("worktree", "list"),
            operands: operands(0, 1, "repository"),
            outputModes: ["report"],
          }),
          leaf({
            name: "delete",
            path: ["worktree", "delete"],
            summary: "Delete a standalone worktree",
            handler: "worktree.delete",
            help: nestedHelp("worktree", "delete"),
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
        name: "cache",
        path: ["cache"],
        summary: "Manage cached repositories",
        help: { kind: "command", command: "cache" },
        children: [
          leaf({
            name: "list",
            path: ["cache", "list"],
            summary: "List cached repositories",
            handler: "cache.list",
            help: nestedHelp("cache", "list"),
            flags: [booleanFlag("json", "--json")],
            outputModes: ["report", "json"],
          }),
          leaf({
            name: "info",
            path: ["cache", "info"],
            summary: "Show cached repository information",
            handler: "cache.info",
            help: nestedHelp("cache", "info"),
            operands: operands(1, 1, "repository"),
            flags: [booleanFlag("json", "--json")],
            outputModes: ["report", "json"],
          }),
          leaf({
            name: "path",
            path: ["cache", "path"],
            summary: "Print a cached repository path",
            handler: "cache.path",
            help: nestedHelp("cache", "path"),
            operands: operands(0, 1, "repository"),
            outputModes: ["path"],
          }),
          leaf({
            name: "add",
            path: ["cache", "add"],
            summary: "Cache repositories",
            handler: "cache.add",
            help: nestedHelp("cache", "add"),
            operands: operands(1, null, "repositories"),
            tty: optionalStdin,
          }),
          leaf({
            name: "update",
            path: ["cache", "update"],
            summary: "Update cached repositories",
            handler: "cache.update",
            help: nestedHelp("cache", "update"),
            operands: operands(0, null, "repositories"),
            tty: optionalStdin,
          }),
          leaf({
            name: "doctor",
            path: ["cache", "doctor"],
            summary: "Check cached repositories",
            handler: "cache.doctor",
            help: nestedHelp("cache", "doctor"),
            operands: operands(0, null, "repositories"),
            flags: [booleanFlag("json", "--json")],
            outputModes: ["report", "json"],
          }),
          leaf({
            name: "repair",
            path: ["cache", "repair"],
            summary: "Repair cached repositories",
            handler: "cache.repair",
            help: nestedHelp("cache", "repair"),
            operands: operands(0, null, "repositories"),
            tty: optionalStdin,
          }),
          leaf({
            name: "delete",
            path: ["cache", "delete"],
            summary: "Delete cached repositories",
            handler: "cache.delete",
            help: nestedHelp("cache", "delete"),
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
            help: nestedHelp("cache", "prune"),
            flags: [
              booleanFlag("dryRun", "--dry-run", "-n"),
              booleanFlag("force", "--force", "-f"),
            ],
            tty: optionalStdin,
          }),
          leaf({
            name: "manage",
            path: ["cache", "manage"],
            summary: "Open the repository cache manager",
            handler: "cache.manage",
            help: nestedHelp("cache", "manage"),
            outputModes: ["interactive"],
            tty: requiredStdin,
          }),
        ],
      }),
      group({
        name: "review",
        path: ["review"],
        summary: "Manage review workspaces and PR worktrees",
        help: { kind: "command", command: "review" },
        children: [
          leaf({
            name: "open",
            path: ["review", "open"],
            summary: "Open a review workspace",
            handler: "review.open",
            help: nestedHelp("review", "open"),
            operands: operands(1, 1, "repository"),
            outputModes: ["human", "report"],
            tty: optionalStdin,
            shellHandoff: "optional-cd",
          }),
          leaf({
            name: "checkout",
            path: ["review", "checkout"],
            summary: "Check out a pull request worktree",
            handler: "review.checkout",
            help: nestedHelp("review", "checkout"),
            operands: operands(
              1,
              2,
              "review targets",
              "<review target> [pull request]",
            ),
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
        help: { kind: "command", command: "template" },
        children: [
          leaf({
            name: "list",
            path: ["template", "list"],
            summary: "List templates",
            handler: "template.list",
            help: nestedHelp("template", "list"),
            outputModes: ["report"],
          }),
          leaf({
            name: "open",
            path: ["template", "open"],
            summary: "Open a template directory",
            handler: "template.open",
            help: nestedHelp("template", "open"),
            operands: operands(1, 1, "template"),
            outputModes: ["path"],
            shellHandoff: "optional-cd",
          }),
          leaf({
            name: "show",
            path: ["template", "show"],
            summary: "Show template information",
            handler: "template.show",
            help: nestedHelp("template", "show"),
            operands: operands(1, 1, "template"),
            outputModes: ["report"],
          }),
          leaf({
            name: "manage",
            path: ["template", "manage"],
            summary: "Open the template manager",
            handler: "template.manage",
            help: nestedHelp("template", "manage"),
            outputModes: ["interactive"],
            tty: requiredStdin,
          }),
          leaf({
            name: "new",
            path: ["template", "new"],
            summary: "Create a template",
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
              }),
            ],
            tty: optionalStdin,
          }),
          leaf({
            name: "edit",
            path: ["template", "edit"],
            summary: "Edit a template",
            handler: "template.edit",
            help: nestedHelp("template", "edit"),
            operands: operands(1, 1, "template"),
            outputModes: ["interactive"],
            tty: requiredStdin,
          }),
          leaf({
            name: "add-file",
            path: ["template", "add-file"],
            summary: "Add files to a template",
            handler: "template.add-file",
            help: nestedHelp("template", "add-file"),
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
            help: nestedHelp("template", "copy"),
            operands: operands(
              2,
              2,
              "templates",
              "<source template> <destination template>",
            ),
          }),
          leaf({
            name: "delete",
            path: ["template", "delete"],
            summary: "Delete a template",
            handler: "template.delete",
            help: nestedHelp("template", "delete"),
            operands: operands(1, 1, "template"),
            flags: [booleanFlag("force", "--force", "-f")],
            tty: optionalStdin,
          }),
        ],
      }),
      group({
        name: "shell",
        path: ["shell"],
        summary: "Manage shell integration",
        help: { kind: "command", command: "shell" },
        children: [
          leaf({
            name: "init",
            path: ["shell", "init"],
            summary: "Print shell integration",
            handler: "shell.init",
            help: nestedHelp("shell", "init"),
            operands: operands(0, 1, "shell"),
            outputModes: ["shell"],
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
            help: nestedHelp("config", "show"),
            outputModes: ["report"],
          }),
          leaf({
            name: "init",
            path: ["config", "init"],
            summary: "Configure workforest interactively",
            handler: "config.init",
            help: nestedHelp("config", "init"),
            outputModes: ["interactive"],
            tty: requiredStdin,
          }),
          leaf({
            name: "edit",
            path: ["config", "edit"],
            summary: "Open the configuration editor",
            handler: "config.edit",
            help: nestedHelp("config", "edit"),
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
            help: nestedHelp("skills", "list"),
            flags: [booleanFlag("json", "--json")],
            outputModes: ["report", "json"],
          }),
          leaf({
            name: "get",
            path: ["skills", "get"],
            summary: "Print bundled skill content",
            handler: "skills.get",
            help: nestedHelp("skills", "get"),
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
            help: nestedHelp("skills", "path"),
            operands: operands(0, 1, "skill"),
            flags: [booleanFlag("json", "--json")],
            outputModes: ["path", "json"],
          }),
        ],
      }),
      leaf({
        name: "version",
        path: ["version"],
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
