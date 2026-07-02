import type { RepositorySource } from "../../src/types.ts";

/**
 * Small, public repositories for benchmarking.
 * Selected for:
 * - Fast clone times (~100-200KB)
 * - Have pnpm lockfiles for testing install phase
 * - Reproducible results
 */
export const BENCHMARK_REPOS: RepositorySource[] = [
  {
    name: "citty",
    remote: "git@github.com:unjs/citty.git",
  },
  {
    name: "scule",
    remote: "git@github.com:unjs/scule.git",
  },
  {
    name: "pathe",
    remote: "git@github.com:unjs/pathe.git",
  },
  {
    name: "ohash",
    remote: "git@github.com:unjs/ohash.git",
  },
];

/**
 * Subset for quick validation runs.
 */
export const QUICK_BENCHMARK_REPOS: RepositorySource[] = BENCHMARK_REPOS.slice(0, 2);
