import type { BenchmarkTiming } from "./timing.ts";
import { formatMs } from "./timing.ts";

export type BenchmarkResult = {
  scenario: "cold" | "warm";
  runs: BenchmarkTiming[];
  stats: {
    median: number;
    mean: number;
    stddev: number;
    min: number;
    max: number;
  };
};

/**
 * Calculate statistics for a set of benchmark runs.
 */
export function calculateStats(runs: BenchmarkTiming[]): BenchmarkResult["stats"] {
  const times = runs.map((r) => r.totalMs).sort((a, b) => a - b);

  const mean = times.reduce((sum, t) => sum + t, 0) / times.length;
  const median =
    times.length % 2 === 0
      ? (times[times.length / 2 - 1] + times[times.length / 2]) / 2
      : times[Math.floor(times.length / 2)];

  const variance =
    times.reduce((sum, t) => sum + Math.pow(t - mean, 2), 0) / times.length;
  const stddev = Math.sqrt(variance);

  return {
    median,
    mean,
    stddev,
    min: times[0],
    max: times[times.length - 1],
  };
}

/**
 * Print a summary of benchmark results.
 */
export function printBenchmarkSummary(result: BenchmarkResult): void {
  console.log();
  console.log(`=== ${result.scenario.toUpperCase()} START BENCHMARK ===`);
  console.log(`Runs: ${result.runs.length}`);
  console.log();
  console.log("Total Time:");
  console.log(`  Median: ${formatMs(result.stats.median)}`);
  console.log(`  Mean:   ${formatMs(result.stats.mean)}`);
  console.log(`  StdDev: ${formatMs(result.stats.stddev)}`);
  console.log(`  Min:    ${formatMs(result.stats.min)}`);
  console.log(`  Max:    ${formatMs(result.stats.max)}`);
  console.log();

  // Print phase breakdown from first run (representative)
  if (result.runs.length > 0) {
    const firstRun = result.runs[0];
    console.log("Phase Breakdown (first run):");
    console.log(`  Git:      ${formatMs(firstRun.phases.git.total)}`);
    console.log(`  Install:  ${formatMs(firstRun.phases.install.total)}`);
    console.log(`  Hooks:    ${formatMs(firstRun.phases.hooks)}`);
    console.log(`  Finalize: ${formatMs(firstRun.phases.finalize)}`);
    console.log();

    // Per-repo git breakdown
    console.log("Git Operations (first run):");
    for (const [repoName, timing] of Object.entries(firstRun.phases.git.perRepo)) {
      console.log(`  ${repoName}:`);
      console.log(`    Mirror:   ${formatMs(timing.mirror)}`);
      console.log(`    Cleanup:  ${formatMs(timing.cleanup)}`);
      console.log(`    Worktree: ${formatMs(timing.worktree)}`);
      console.log(`    Total:    ${formatMs(timing.total)}`);
    }
    console.log();

    // Per-repo install breakdown
    if (Object.keys(firstRun.phases.install.perRepo).length > 0) {
      console.log("Install Operations (first run):");
      for (const [repoName, time] of Object.entries(firstRun.phases.install.perRepo)) {
        console.log(`  ${repoName}: ${formatMs(time)}`);
      }
      console.log();
    }
  }
}

/**
 * Compare two benchmark results and print improvement.
 */
export function printComparison(
  baseline: BenchmarkResult,
  optimized: BenchmarkResult,
): void {
  console.log();
  console.log(`=== COMPARISON (${baseline.scenario.toUpperCase()}) ===`);

  const improvement =
    ((baseline.stats.median - optimized.stats.median) / baseline.stats.median) * 100;

  console.log(`Baseline Median: ${formatMs(baseline.stats.median)}`);
  console.log(`Optimized Median: ${formatMs(optimized.stats.median)}`);
  console.log(`Improvement: ${improvement.toFixed(1)}%`);
  console.log();

  if (improvement >= 30) {
    console.log("SUCCESS: Achieved 30%+ improvement!");
  } else {
    console.log(`Need ${(30 - improvement).toFixed(1)}% more to hit 30% target.`);
  }
}

/**
 * Export benchmark results to JSON.
 */
export function exportResults(results: BenchmarkResult[]): string {
  return JSON.stringify(
    {
      timestamp: new Date().toISOString(),
      results: results.map((r) => ({
        scenario: r.scenario,
        stats: r.stats,
        runs: r.runs,
      })),
    },
    null,
    2,
  );
}
