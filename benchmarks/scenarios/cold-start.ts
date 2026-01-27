import { stampWorkspaceGenerator } from "../../src/workspace/index.ts";
import type { RepoConfig } from "../../src/types.ts";
import { Timer, type BenchmarkTiming } from "../utils/timing.ts";
import { cleanupBenchmarkDirs } from "../utils/cleanup.ts";

export type ColdStartOptions = {
  repos: RepoConfig[];
  cacheDir: string;
  workspaceDir: string;
};

/**
 * Run a cold-start benchmark (no cached mirrors).
 * Measures full clone + worktree + install time.
 */
export async function runColdStart(options: ColdStartOptions): Promise<BenchmarkTiming> {
  const { repos, cacheDir, workspaceDir } = options;

  // Clean both cache and workspace for true cold start
  await cleanupBenchmarkDirs({ cacheDir, workspaceDir, keepCache: false });

  // Set up environment variables for isolated directories
  process.env["WORKFOREST_CACHE_DIR"] = cacheDir;

  const timer = new Timer();

  // Track per-repo timing
  const gitPerRepo: Record<string, { mirror: number; cleanup: number; worktree: number; total: number }> = {};
  const installPerRepo: Record<string, number> = {};
  let currentRepo: string | null = null;
  let currentRepoStartTime: Record<string, number> = {};

  timer.startPhase("git");

  for await (const state of stampWorkspaceGenerator({
    featureName: "benchmark-test",
    workspaceDir,
    repos,
  })) {
    switch (state.phase) {
      case "git":
        if (currentRepo !== state.repo) {
          // New repo starting
          if (currentRepo) {
            timer.endSubPhase("git", `${currentRepo}:total`);
            const repoTiming = gitPerRepo[currentRepo];
            if (repoTiming) {
              repoTiming.total = timer.getSubPhaseDuration("git", `${currentRepo}:total`);
            }
          }
          currentRepo = state.repo;
          timer.startSubPhase("git", `${currentRepo}:total`);
          gitPerRepo[currentRepo] = { mirror: 0, cleanup: 0, worktree: 0, total: 0 };
        }
        // End previous step if any
        if (gitPerRepo[currentRepo]) {
          const steps = ["mirror", "cleanup", "worktree"];
          for (const step of steps) {
            const duration = timer.getSubPhaseDuration("git", `${currentRepo}:${step}`);
            if (duration > 0) {
              (gitPerRepo[currentRepo] as Record<string, number>)[step] = duration;
            }
          }
        }
        timer.startSubPhase("git", `${currentRepo}:${state.step}`);
        break;

      case "git-complete":
        // End the last step (worktree)
        if (currentRepo) {
          timer.endSubPhase("git", `${currentRepo}:worktree`);
          const repoTiming = gitPerRepo[state.repo];
          if (repoTiming) {
            repoTiming.mirror = timer.getSubPhaseDuration("git", `${currentRepo}:mirror`);
            repoTiming.cleanup = timer.getSubPhaseDuration("git", `${currentRepo}:cleanup`);
            repoTiming.worktree = timer.getSubPhaseDuration("git", `${currentRepo}:worktree`);
          }
        }
        break;

      case "initializers-start":
        if (currentRepo) {
          timer.endSubPhase("git", `${currentRepo}:total`);
          const lastRepoTiming = gitPerRepo[currentRepo];
          if (lastRepoTiming) {
            lastRepoTiming.total = timer.getSubPhaseDuration("git", `${currentRepo}:total`);
          }
        }
        timer.endPhase("git");
        timer.startPhase("install");
        break;

      case "initializer":
        if (state.state.phase === "running") {
          const { repoName, state: taskState } = state.state;
          if (taskState.status === "running" && !currentRepoStartTime[repoName]) {
            // Start timing for this repo's install
            timer.startSubPhase("install", repoName);
            currentRepoStartTime[repoName] = performance.now();
          } else if (taskState.status === "completed" || taskState.status === "failed") {
            // End timing for this repo's install
            timer.endSubPhase("install", repoName);
            installPerRepo[repoName] = timer.getSubPhaseDuration("install", repoName);
            delete currentRepoStartTime[repoName];
          }
        } else if (state.state.phase === "repo-complete") {
          // Ensure timing is captured if not already
          const { repoName } = state.state;
          if (!installPerRepo[repoName]) {
            timer.endSubPhase("install", repoName);
            installPerRepo[repoName] = timer.getSubPhaseDuration("install", repoName);
          }
        }
        break;

      case "initializers-complete":
        timer.endPhase("install");
        break;

      case "hooks-start":
        timer.startPhase("hooks");
        break;

      case "hooks-complete":
        timer.endPhase("hooks");
        break;

      case "finalize":
        if (!timer.getPhaseDuration("finalize")) {
          timer.startPhase("finalize");
        }
        break;

      case "complete":
        timer.endPhase("finalize");
        break;
    }
  }

  // Clean up environment
  delete process.env["WORKFOREST_CACHE_DIR"];

  return {
    scenario: "cold",
    repoCount: repos.length,
    totalMs: timer.getTotalMs(),
    phases: {
      git: {
        total: timer.getPhaseDuration("git"),
        perRepo: gitPerRepo,
      },
      install: {
        total: timer.getPhaseDuration("install"),
        perRepo: installPerRepo,
      },
      hooks: timer.getPhaseDuration("hooks"),
      finalize: timer.getPhaseDuration("finalize"),
    },
  };
}
