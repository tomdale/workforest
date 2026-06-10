import arg from "arg";
import { getCacheDir } from "./config.ts";
import { commandHelp, nestedCommandHelp } from "./help.ts";
import { log } from "./logger.ts";
import {
  addCachedRepository,
  type CachedRepository,
  cleanCachedRepositories,
  deleteCachedRepository,
  formatByteSize,
  listCachedRepositories,
  repairCachedRepository,
  repositoryDisplayName,
  resolveCachedRepository,
  updateCachedRepository,
} from "./repositories.ts";
import { qualifyRepositorySpecifiers } from "./repository-specifiers.ts";
import { printReport } from "./terminal/report.ts";
import {
  isInteractive,
  promptConfirm,
  promptText,
  withSpinner,
} from "./ui/prompts/index.ts";

export async function runRepositoryCommand(
  argv: string[],
  command = "repository",
): Promise<void> {
  const subcommand = argv[0];
  const subArgv = argv.slice(1);

  switch (subcommand) {
    case "--help":
    case "-h":
      console.log(commandHelp(command));
      return;
    case undefined:
      if (isInteractive()) {
        await runRepositoryManagerCommand();
      } else {
        await runRepositoryList([]);
      }
      return;
    case "list":
    case "ls":
      if (hasHelpFlag(subArgv)) {
        console.log(nestedCommandHelp("repository", "list"));
        return;
      }
      await runRepositoryList(subArgv);
      return;
    case "info":
      if (hasHelpFlag(subArgv)) {
        console.log(nestedCommandHelp("repository", "info"));
        return;
      }
      await runRepositoryInfo(subArgv);
      return;
    case "path":
      if (hasHelpFlag(subArgv)) {
        console.log(nestedCommandHelp("repository", "path"));
        return;
      }
      await runRepositoryPath(subArgv);
      return;
    case "add":
    case "cache":
      if (hasHelpFlag(subArgv)) {
        console.log(nestedCommandHelp("repository", "add"));
        return;
      }
      await runRepositoryAdd(subArgv);
      return;
    case "update":
    case "fetch":
      if (hasHelpFlag(subArgv)) {
        console.log(nestedCommandHelp("repository", "update"));
        return;
      }
      await runRepositoryUpdate(subArgv);
      return;
    case "doctor":
    case "check":
      if (hasHelpFlag(subArgv)) {
        console.log(nestedCommandHelp("repository", "doctor"));
        return;
      }
      await runRepositoryDoctor(subArgv);
      return;
    case "repair":
      if (hasHelpFlag(subArgv)) {
        console.log(nestedCommandHelp("repository", "repair"));
        return;
      }
      await runRepositoryRepair(subArgv);
      return;
    case "delete":
    case "remove":
    case "rm":
      if (hasHelpFlag(subArgv)) {
        console.log(nestedCommandHelp("repository", "delete"));
        return;
      }
      await runRepositoryDelete(subArgv);
      return;
    case "clean":
    case "prune":
      if (hasHelpFlag(subArgv)) {
        console.log(nestedCommandHelp("repository", "clean"));
        return;
      }
      await runRepositoryClean(subArgv);
      return;
    default:
      log.error(`Unknown repository subcommand: ${subcommand}`);
      log.info(
        "Available: list, info, path, add, update, doctor, repair, delete, clean",
      );
      process.exitCode = 1;
  }
}

export async function runRepositoriesCommand(argv: string[]): Promise<void> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    console.log(commandHelp("repositories"));
    return;
  }
  if (argv.length > 0) {
    await runRepositoryCommand(argv);
    return;
  }
  if (isInteractive()) {
    await runRepositoryManagerCommand();
  } else {
    await runRepositoryList([]);
  }
}

async function runRepositoryList(argv: string[]): Promise<void> {
  const args = arg(
    {
      "--json": Boolean,
    },
    { argv },
  );
  if (args._.length > 0) {
    fail("Usage: wf repository list [--json]");
    return;
  }

  const repositories = await listCachedRepositories();
  if (args["--json"]) {
    console.log(JSON.stringify(repositories.map(toJson), null, 2));
    return;
  }
  if (repositories.length === 0) {
    log.info("No cached repositories.");
    log.info(`Cache directory: ${getCacheDir()}`);
    return;
  }

  printReport({
    title: "Cached repositories",
    sections: [
      {
        entries: repositories.map((repository) => ({
          title: repositoryDisplayName(repository),
          description: healthSummary(repository),
          details: [
            { label: "Size", value: formatByteSize(repository.sizeBytes) },
            {
              label: "Worktrees",
              value: String(activeWorktreeCount(repository)),
            },
            {
              label: "Updated",
              value: formatDate(repository.lastFetchedAt),
            },
          ],
        })),
      },
    ],
    footer: [
      `Directory: ${getCacheDir()}`,
      `${repositories.length} repositor${repositories.length === 1 ? "y" : "ies"}, ${formatByteSize(totalSize(repositories))}`,
    ].join("\n"),
  });
}

async function runRepositoryInfo(argv: string[]): Promise<void> {
  const args = arg({ "--json": Boolean }, { argv });
  if (args._.length !== 1) {
    fail("Usage: wf repository info <repo> [--json]");
    return;
  }

  const repository = await requireRepository(args._[0] ?? "");
  if (!repository) return;
  if (args["--json"]) {
    console.log(JSON.stringify(toJson(repository), null, 2));
    return;
  }

  printRepositoryInfo(repository);
}

async function runRepositoryPath(argv: string[]): Promise<void> {
  if (argv.length > 1) {
    fail("Usage: wf repository path [repo]");
    return;
  }
  if (argv.length === 0) {
    console.log(getCacheDir());
    return;
  }

  const repository = await requireRepository(argv[0] ?? "");
  if (repository) console.log(repository.mirrorPath);
}

async function runRepositoryAdd(argv: string[]): Promise<void> {
  if (argv.length === 0) {
    fail("Usage: wf repository add <repo...>");
    return;
  }

  let inputs: string[];
  try {
    inputs = await qualifyRepositorySpecifiers(argv);
  } catch (error) {
    log.error(getErrorMessage(error));
    process.exitCode = 1;
    return;
  }

  for (const [index, input] of inputs.entries()) {
    const displayInput = argv[index] ?? input;
    try {
      const repository = await runWithOptionalSpinner(
        `Caching ${displayInput}`,
        () => addCachedRepository(input),
        `Cached ${displayInput}`,
      );
      log.success(
        `${repositoryDisplayName(repository)}: ${repository.mirrorPath}`,
      );
    } catch (error) {
      log.error(`${displayInput}: ${getErrorMessage(error)}`);
      process.exitCode = 1;
    }
  }
}

async function runRepositoryUpdate(argv: string[]): Promise<void> {
  const repositories = await resolveRepositorySelection(argv);
  if (!repositories) return;
  if (repositories.length === 0) {
    log.info("No cached repositories to update.");
    return;
  }

  for (const repository of repositories) {
    const name = repositoryDisplayName(repository);
    try {
      await runWithOptionalSpinner(
        `Updating ${name}`,
        () => updateCachedRepository(repository),
        `Updated ${name}`,
      );
    } catch (error) {
      log.error(`${name}: ${getErrorMessage(error)}`);
      process.exitCode = 1;
    }
  }
}

async function runRepositoryDoctor(argv: string[]): Promise<void> {
  const args = arg({ "--json": Boolean }, { argv });
  const repositories = await resolveRepositorySelection(args._);
  if (!repositories) return;

  if (args["--json"]) {
    console.log(JSON.stringify(repositories.map(toJson), null, 2));
  } else if (repositories.length === 0) {
    log.info("No cached repositories.");
  } else {
    printReport({
      title: "Repository cache health",
      sections: [
        {
          entries: repositories.map((repository) => ({
            title: repositoryDisplayName(repository),
            description: healthSummary(repository),
            details:
              repository.issues.length > 0
                ? [{ label: "Issues", value: repository.issues.join("; ") }]
                : [{ label: "Issues", value: "none" }],
          })),
        },
      ],
      footer: `${repositories.filter((repository) => repository.health !== "healthy").length} need attention`,
    });
  }

  if (repositories.some((repository) => repository.health !== "healthy")) {
    process.exitCode = 1;
  }
}

async function runRepositoryRepair(argv: string[]): Promise<void> {
  const repositories = await resolveRepositorySelection(argv);
  if (!repositories) return;
  if (repositories.length === 0) {
    log.info("No cached repositories to repair.");
    return;
  }

  for (const repository of repositories) {
    const name = repositoryDisplayName(repository);
    try {
      const repaired = await runWithOptionalSpinner(
        `Repairing ${name}`,
        () => repairCachedRepository(repository),
        `Repaired ${name}`,
      );
      if (repaired.health !== "healthy") {
        log.warn(`${name}: ${repaired.issues.join("; ")}`);
        process.exitCode = 1;
      }
    } catch (error) {
      log.error(`${name}: ${getErrorMessage(error)}`);
      process.exitCode = 1;
    }
  }
}

async function runRepositoryDelete(argv: string[]): Promise<void> {
  const args = arg(
    {
      "--dry-run": Boolean,
      "--force": Boolean,
      "-n": "--dry-run",
      "-f": "--force",
    },
    { argv },
  );
  if (args._.length === 0) {
    fail("Usage: wf repository delete <repo...> [--dry-run] [--force]");
    return;
  }

  const repositories = await resolveRepositorySelection(args._);
  if (!repositories) return;
  const activeRepositories = repositories.filter(
    (repository) => activeWorktreeCount(repository) > 0,
  );
  if (activeRepositories.length > 0 && !args["--force"]) {
    log.error(
      `Cannot delete cached repositories with active worktrees: ${activeRepositories.map(repositoryDisplayName).join(", ")}. Delete those worktrees first or pass --force.`,
    );
    process.exitCode = 1;
    return;
  }
  if (
    !(await confirmDeletion(
      repositories,
      args["--force"] ?? false,
      args["--dry-run"] ?? false,
    ))
  ) {
    return;
  }

  for (const repository of repositories) {
    try {
      await deleteCachedRepository(repository, {
        dryRun: args["--dry-run"] ?? false,
        force: args["--force"] ?? false,
      });
      const verb = args["--dry-run"] ? "Would delete" : "Deleted";
      log.success(`${verb} ${repositoryDisplayName(repository)}`);
    } catch (error) {
      log.error(getErrorMessage(error));
      process.exitCode = 1;
    }
  }
}

async function runRepositoryClean(argv: string[]): Promise<void> {
  const args = arg(
    {
      "--dry-run": Boolean,
      "--force": Boolean,
      "-n": "--dry-run",
      "-f": "--force",
    },
    { argv },
  );
  if (args._.length > 0) {
    fail("Usage: wf repository clean [--dry-run] [--force]");
    return;
  }

  const repositories = (await listCachedRepositories()).filter(
    (repository) => activeWorktreeCount(repository) === 0,
  );
  if (repositories.length === 0) {
    log.info("No unused cached repositories.");
    return;
  }
  if (
    !(await confirmDeletion(
      repositories,
      args["--force"] ?? false,
      args["--dry-run"] ?? false,
    ))
  ) {
    return;
  }

  const results = await cleanCachedRepositories({
    dryRun: args["--dry-run"] ?? false,
    force: args["--force"] ?? false,
  });
  const verb = args["--dry-run"] ? "Would delete" : "Deleted";
  log.success(
    `${verb} ${results.length} unused repositor${results.length === 1 ? "y" : "ies"} (${formatByteSize(totalSize(results.map((result) => result.repository)))})`,
  );
}

async function runRepositoryManagerCommand(): Promise<void> {
  const { shouldUseRepositoryManager } = await import(
    "./ui/repository-manager.ts"
  );
  if (!shouldUseRepositoryManager()) {
    await runRepositoryList([]);
    return;
  }

  let initialMirrorPath: string | undefined;
  while (true) {
    const repositories = await listCachedRepositories();
    const { runRepositoryManager } = await import("./ui/repository-manager.ts");
    const action = await runRepositoryManager({
      repositories,
      cacheDir: getCacheDir(),
      ...(initialMirrorPath ? { initialMirrorPath } : {}),
    });

    switch (action.type) {
      case "quit":
        return;
      case "reload":
        continue;
      case "add": {
        const input = await promptText(
          "Repository (cached name, owner/repo, or git URL)",
        );
        await runRepositoryAdd([input]);
        initialMirrorPath = (await resolveCachedRepository(input))?.mirrorPath;
        continue;
      }
      case "info": {
        const repository = repositories.find(
          (candidate) => candidate.mirrorPath === action.mirrorPath,
        );
        if (repository) printRepositoryInfo(repository);
        return;
      }
      case "update":
        initialMirrorPath = action.mirrorPath;
        await runRepositoryUpdate([action.mirrorPath]);
        continue;
      case "repair":
        initialMirrorPath = action.mirrorPath;
        await runRepositoryRepair([action.mirrorPath]);
        continue;
      case "delete":
        await runRepositoryDelete([action.mirrorPath]);
        initialMirrorPath = undefined;
        continue;
      case "clean":
        await runRepositoryClean([]);
        initialMirrorPath = undefined;
        continue;
    }
  }
}

async function resolveRepositorySelection(
  selectors: string[],
): Promise<CachedRepository[] | null> {
  const repositories = await listCachedRepositories();
  if (selectors.length === 0) return repositories;

  const selected = new Map<string, CachedRepository>();
  for (const selector of selectors) {
    try {
      const repository = await resolveCachedRepository(selector, repositories);
      if (!repository) {
        log.error(`Cached repository not found: ${selector}`);
        process.exitCode = 1;
        return null;
      }
      selected.set(repository.mirrorPath, repository);
    } catch (error) {
      log.error(getErrorMessage(error));
      process.exitCode = 1;
      return null;
    }
  }
  return [...selected.values()];
}

async function requireRepository(
  selector: string,
): Promise<CachedRepository | null> {
  const repositories = await resolveRepositorySelection([selector]);
  return repositories?.[0] ?? null;
}

async function confirmDeletion(
  repositories: CachedRepository[],
  force: boolean,
  dryRun: boolean,
): Promise<boolean> {
  if (dryRun || force) return true;
  if (!isInteractive()) {
    log.error("Cannot confirm in non-interactive mode. Use --force.");
    process.exitCode = 1;
    return false;
  }

  const size = formatByteSize(totalSize(repositories));
  return promptConfirm(
    `Delete ${repositories.length} cached repositor${repositories.length === 1 ? "y" : "ies"} (${size})?`,
    false,
  );
}

function printRepositoryInfo(repository: CachedRepository): void {
  printReport({
    title: `Cached repository ${repositoryDisplayName(repository)}`,
    sections: [
      {
        fields: [
          { label: "Health", value: healthSummary(repository) },
          { label: "Remote", value: repository.remote ?? "(missing)" },
          {
            label: "Default branch",
            value: repository.defaultBranch ?? "(unknown)",
          },
          { label: "Size", value: formatByteSize(repository.sizeBytes) },
          {
            label: "Last updated",
            value: formatDate(repository.lastFetchedAt),
          },
          { label: "Mirror", value: repository.mirrorPath },
        ],
      },
      ...(repository.issues.length > 0
        ? [
            {
              title: "Issues",
              entries: repository.issues.map((issue) => ({ title: issue })),
            },
          ]
        : []),
      {
        title: "Worktrees",
        entries:
          repository.worktrees.length > 0
            ? repository.worktrees.map((worktree) => ({
                title: worktree.path,
                details: [
                  {
                    label: "Branch",
                    value: worktree.detached
                      ? "(detached)"
                      : (worktree.branch ?? "(unknown)"),
                  },
                  {
                    label: "State",
                    value:
                      worktree.prunable || !worktree.exists
                        ? "stale"
                        : "active",
                  },
                ],
              }))
            : [{ title: "(none)" }],
      },
    ],
  });
}

function toJson(repository: CachedRepository): Record<string, unknown> {
  return {
    ...repository,
    lastFetchedAt: repository.lastFetchedAt?.toISOString() ?? null,
  };
}

function activeWorktreeCount(repository: CachedRepository): number {
  return repository.worktrees.filter(
    (worktree) => worktree.exists && !worktree.prunable,
  ).length;
}

function totalSize(repositories: CachedRepository[]): number | null {
  const known = repositories
    .map((repository) => repository.sizeBytes)
    .filter((size): size is number => size !== null);
  return known.length === 0 && repositories.length > 0
    ? null
    : known.reduce((total, size) => total + size, 0);
}

function healthSummary(repository: CachedRepository): string {
  if (repository.health === "healthy") return "healthy";
  if (repository.health === "invalid") return "invalid";
  return `needs attention: ${repository.issues.join("; ")}`;
}

function formatDate(date: Date | null): string {
  return date ? date.toLocaleString() : "unknown";
}

function hasHelpFlag(argv: readonly string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

function fail(message: string): void {
  log.error(message);
  process.exitCode = 1;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runWithOptionalSpinner<T>(
  message: string,
  task: () => Promise<T>,
  successMessage: string,
): Promise<T> {
  return isInteractive() ? withSpinner(message, task, successMessage) : task();
}
