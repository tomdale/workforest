import arg from "arg";
import { reposFromSlugs } from "./config.ts";
import { commandHelp, nestedCommandHelp } from "./help.ts";
import { log } from "./logger.ts";
import type { Template } from "./templates/index.ts";
import type { RepoConfig, WorkspaceConfig } from "./types.ts";
import { renderPipelinesGrid, shouldUseGrid } from "./ui/grid-consumer.ts";
import { note, outro, withSpinner } from "./ui/prompts/index.ts";
import { buildBranchName } from "./utils/branch-prefix.ts";
import type { RepoPipelineState } from "./workspace/pipeline.ts";

type DevNewOptions = {
  failRepo?: string;
  speed: "fast" | "normal" | "slow";
};

const SYNTHETIC_CONFIG: WorkspaceConfig = {
  defaultDir: "~/Code/workspaces",
  dirPrefix: "",
  branchPrefix: "tomdale/",
};

const SYNTHETIC_TEMPLATES: Template[] = [
  {
    id: "synthetic-fullstack",
    path: "<synthetic>",
    config: {
      description: "API, frontend, agent, and deployment setup",
      repos: ["vercel/api", "vercel/front", "vercel/agents", "vercel/vertex"],
      branchPrefix: "tomdale/",
      hooks: [
        {
          name: "Warm dev caches",
          run: "pnpm turbo run build --dry=json",
        },
      ],
    },
  },
  {
    id: "synthetic-two-repos",
    path: "<synthetic>",
    config: {
      description: "Small workspace that exercises repo panes",
      repos: ["vercel/api", "vercel/front"],
      branchPrefix: "tomdale/",
    },
  },
];

export async function runDevCommand(argv: string[]): Promise<void> {
  const subcommand = argv[0];

  if (
    subcommand === undefined ||
    subcommand === "--help" ||
    subcommand === "-h"
  ) {
    console.log(commandHelp("dev"));
    return;
  }

  if (subcommand !== "simulate" && subcommand !== "sim") {
    log.error(`Unknown dev subcommand: ${subcommand}`);
    console.log(commandHelp("dev"));
    process.exitCode = 1;
    return;
  }

  await runDevSimulateCommand(argv.slice(1));
}

async function runDevSimulateCommand(argv: string[]): Promise<void> {
  const flow = argv[0];

  if (flow === undefined || flow === "--help" || flow === "-h") {
    console.log(nestedCommandHelp("dev", "simulate"));
    return;
  }

  if (flow !== "new") {
    log.error(`Unknown dev simulation flow: ${flow}`);
    printSimulateUsage();
    process.exitCode = 1;
    return;
  }

  await runDevNewSimulation(argv.slice(1));
}

async function runDevNewSimulation(argv: string[]): Promise<void> {
  let args: {
    _: string[];
    "--help"?: boolean;
    "--fail-repo"?: string;
    "--speed"?: string;
  };

  try {
    args = arg(
      {
        "--help": Boolean,
        "--fail-repo": String,
        "--speed": String,
        "-h": "--help",
      },
      { argv },
    );
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    printNewSimulationUsage();
    process.exitCode = 1;
    return;
  }

  if (args["--help"]) {
    printNewSimulationUsage();
    return;
  }

  if (!process.stdout.isTTY) {
    log.error("Dev UI simulation requires an interactive TTY.");
    process.exitCode = 1;
    return;
  }

  const speed = parseSpeed(args["--speed"]);
  if (!speed) {
    log.error(
      `Invalid speed "${args["--speed"]}". Expected fast, normal, or slow.`,
    );
    process.exitCode = 1;
    return;
  }

  const { runNewWizard } = await import("./ui/new-wizard.ts");
  const wizardResult = await runNewWizard({
    config: SYNTHETIC_CONFIG,
    templates: SYNTHETIC_TEMPLATES,
    handleTemplateManagement: async () => {
      note(
        "Template management is not simulated here.\nReturning to the synthetic wf new flow.",
        "Dev simulator",
      );
      return null;
    },
    generateFeatureName: async (description) => {
      await sleep(durationFor(speed, 600));
      return syntheticSlug(description);
    },
  });

  const repoSlugs = wizardResult.templateId
    ? (SYNTHETIC_TEMPLATES.find(
        (template) => template.id === wizardResult.templateId,
      )?.config.repos ?? wizardResult.repoSlugs)
    : wizardResult.repoSlugs;
  const repos = reposFromSlugs(repoSlugs);
  const branchName = buildBranchName(
    wizardResult.featureName,
    wizardResult.templateBranchPrefix ?? SYNTHETIC_CONFIG.branchPrefix ?? "",
  );

  note(
    [
      `Feature: ${wizardResult.featureName}`,
      wizardResult.description
        ? `Description: ${wizardResult.description}`
        : null,
      `Branch: ${branchName}`,
      wizardResult.templateId ? `Template: ${wizardResult.templateId}` : null,
      "",
      "No filesystem, git, package manager, Vercel, or shell state will be changed.",
    ]
      .filter(Boolean)
      .join("\n"),
    "Synthetic wf new",
  );

  await renderSyntheticRepoSetup(repos, {
    speed,
    ...(args["--fail-repo"] ? { failRepo: args["--fail-repo"] } : {}),
  });

  note(
    [
      `cd ~/Code/workspaces/${wizardResult.featureName}`,
      `code ${wizardResult.featureName}.code-workspace`,
    ].join("\n"),
    "Synthetic next steps",
  );
  outro("Simulation complete");
}

async function renderSyntheticRepoSetup(
  repos: readonly RepoConfig[],
  options: DevNewOptions,
): Promise<void> {
  if (repos.length === 0) {
    throw new Error("Synthetic wf new simulation requires at least one repo.");
  }

  const pipelines = new Map(
    repos.map((repo) => [
      repo.name,
      syntheticRepoPipeline(repo, {
        ...options,
        shouldFail: options.failRepo === repo.name,
      }),
    ]),
  );

  if (shouldUseGrid(repos.length)) {
    await renderPipelinesGrid({
      pipelines,
      repoNames: repos.map((repo) => repo.name),
      onBeforeCompletionPrompt: async () => {
        await sleep(durationFor(options.speed, 350));
      },
    });
    return;
  }

  await withSpinner(
    "Running synthetic repository setup...",
    async (spinner) => {
      for (const repo of repos) {
        spinner.message(`${repo.name}: synthetic setup`);
        for await (const state of syntheticRepoPipeline(repo, {
          ...options,
          shouldFail: options.failRepo === repo.name,
        })) {
          if (state.phase === "git")
            spinner.message(`${repo.name}: ${state.step}`);
          if (state.phase === "initializer") {
            spinner.message(`${repo.name}: ${state.name}`);
          }
          if (state.phase === "failed") {
            log.error(`${repo.name}: ${state.error.message}`);
          }
        }
      }
    },
    "Synthetic setup complete",
  );
}

async function* syntheticRepoPipeline(
  repo: RepoConfig,
  options: DevNewOptions & { shouldFail: boolean },
): AsyncGenerator<RepoPipelineState> {
  const wait = (baseMs: number) => sleep(durationFor(options.speed, baseMs));

  yield {
    phase: "git",
    step: "mirror",
    status: "running",
    message: `Seeding pristine repo for ${repo.name}`,
  };
  await wait(350);
  yield {
    phase: "git",
    step: "mirror",
    status: "output",
    output: `Attempting to clone ${repo.remote}\nReceiving objects: 100% (synthetic)\n`,
  };
  await wait(250);
  yield { phase: "git", step: "mirror", status: "completed" };

  yield {
    phase: "git",
    step: "worktree",
    status: "running",
    message: `Creating worktree for ${repo.name}`,
  };
  await wait(300);
  yield {
    phase: "git",
    step: "worktree",
    status: "output",
    output: `Creating worktree on branch "tomdale/synthetic-flow"\n`,
  };
  await wait(250);
  yield { phase: "git", step: "worktree", status: "completed" };

  yield {
    phase: "initializer",
    name: "detecting",
    status: "running",
    message: "Detecting project type...",
  };
  await wait(250);

  yield {
    phase: "initializer",
    name: "pnpm install",
    status: "running",
    message: "Installing (synthetic)",
  };
  await wait(350);
  yield {
    phase: "initializer",
    name: "pnpm install",
    status: "output",
    output: "pnpm install --frozen-lockfile --prefer-offline\nDone in 1.2s\n",
  };
  await wait(300);

  if (options.shouldFail) {
    yield {
      phase: "failed",
      step: "initializer:pnpm install",
      error: new Error("Synthetic failure requested with --fail-repo."),
    };
    return;
  }

  yield {
    phase: "initializer",
    name: "vercel link",
    status: "running",
    message: "Linking Vercel project (synthetic)",
  };
  await wait(300);
  yield {
    phase: "initializer",
    name: "vercel link",
    status: "output",
    output:
      "vercel link --yes --repo --scope synthetic\nLinked to synthetic/project\n",
  };
  await wait(200);

  yield { phase: "complete", hasLockfile: true };
}

function printSimulateUsage(): void {
  log.info("Usage: wf dev simulate new [options]");
}

function printNewSimulationUsage(): void {
  log.info("Usage: wf dev simulate new [options]");
  log.info("Options:");
  log.info("  --fail-repo <name>  Mark one synthetic repo setup as failed");
  log.info("  --speed <speed>     fast, normal, or slow (default: normal)");
}

function parseSpeed(value: string | undefined): DevNewOptions["speed"] | null {
  if (value === undefined) return "normal";
  if (value === "fast" || value === "normal" || value === "slow") return value;
  return null;
}

function durationFor(speed: DevNewOptions["speed"], normalMs: number): number {
  if (speed === "fast") return Math.max(20, Math.floor(normalMs * 0.2));
  if (speed === "slow") return normalMs * 2;
  return normalMs;
}

function syntheticSlug(description: string): string {
  const slug = description
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

  return slug || "synthetic-workspace";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
