import type { RepoConfig } from "../../src/types.ts";

/**
 * Small, public repositories for benchmarking.
 * Selected for:
 * - Fast clone times (~100-200KB)
 * - Have pnpm lockfiles for testing install phase
 * - Reproducible results
 */
export const BENCHMARK_REPOS: RepoConfig[] = [
  {
    name: "citty",
    remote: "git@github.com:unjs/citty.git",
    defaultBranch: "main",
  },
  {
    name: "scule",
    remote: "git@github.com:unjs/scule.git",
    defaultBranch: "main",
  },
  {
    name: "pathe",
    remote: "git@github.com:unjs/pathe.git",
    defaultBranch: "main",
  },
  {
    name: "ohash",
    remote: "git@github.com:unjs/ohash.git",
    defaultBranch: "main",
  },
];

/**
 * Subset for quick validation runs.
 */
export const QUICK_BENCHMARK_REPOS: RepoConfig[] = BENCHMARK_REPOS.slice(0, 2);
