#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { BENCHMARK_REPOS, QUICK_BENCHMARK_REPOS } from "./fixtures/repos.ts";
import { runColdStart } from "./scenarios/cold-start.ts";
import { runWarmStart } from "./scenarios/warm-start.ts";
import {
  setupBenchmarkDirs,
  cleanupAllBenchmarkDirs,
} from "./utils/cleanup.ts";
import { type BenchmarkTiming, formatMs } from "./utils/timing.ts";
import {
  calculateStats,
  printBenchmarkSummary,
  exportResults,
  type BenchmarkResult,
} from "./utils/reporter.ts";

type BenchmarkScenario = "cold" | "warm" | "both";

type BenchmarkOptions = {
  scenario: BenchmarkScenario;
  runs: number;
  quick: boolean;
  clean: boolean;
  outputFile?: string;
};

function parseArgs(): BenchmarkOptions {
  const args = process.argv.slice(2);
  const options: BenchmarkOptions = {
    scenario: "both",
    runs: 5,
    quick: false,
    clean: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--cold") {
      options.scenario = "cold";
    } else if (arg === "--warm") {
      options.scenario = "warm";
    } else if (arg === "--runs" && args[i + 1]) {
      options.runs = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--quick") {
      options.quick = true;
    } else if (arg === "--clean") {
      options.clean = true;
    } else if (arg === "--output" && args[i + 1]) {
      options.outputFile = args[i + 1];
      i++;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`
Workforest Benchmark Runner

Usage: npx tsx benchmarks/run.ts [options]

Options:
  --cold        Run only cold-start benchmarks (no cached mirrors)
  --warm        Run only warm-start benchmarks (mirrors pre-cached)
  --runs N      Number of runs per scenario (default: 5)
  --quick       Use fewer repos for faster testing (2 instead of 4)
  --clean       Clean up benchmark directories before running
  --output FILE Write results to JSON file
  --help, -h    Show this help message

Examples:
  npx tsx benchmarks/run.ts                    # Full benchmark suite
  npx tsx benchmarks/run.ts --quick --runs 3   # Quick validation
  npx tsx benchmarks/run.ts --warm --runs 10   # Detailed warm-start analysis
`);
}

async function main(): Promise<void> {
  const options = parseArgs();
  const repos = options.quick ? QUICK_BENCHMARK_REPOS : BENCHMARK_REPOS;

  console.log("=== Workforest Benchmark ===");
  console.log(`Repos: ${repos.map((r) => r.name).join(", ")}`);
  console.log(`Runs per scenario: ${options.runs}`);
  console.log(`Scenario: ${options.scenario}`);
  console.log();

  // Set up isolated benchmark directories
  const { cacheDir, configDir, workspaceBaseDir } = await setupBenchmarkDirs();

  // Clean if requested
  if (options.clean) {
    console.log("Cleaning all benchmark directories...");
    await cleanupAllBenchmarkDirs();
    const dirs = await setupBenchmarkDirs();
    Object.assign({ cacheDir: dirs.cacheDir, configDir: dirs.configDir, workspaceBaseDir: dirs.workspaceBaseDir });
  }

  const results: BenchmarkResult[] = [];

  // Run cold-start benchmarks
  if (options.scenario === "cold" || options.scenario === "both") {
    console.log("Running cold-start benchmarks...");
    const coldRuns: BenchmarkTiming[] = [];

    for (let i = 0; i < options.runs; i++) {
      console.log(`  Run ${i + 1}/${options.runs}...`);
      const workspaceDir = path.join(workspaceBaseDir, `cold-${i}`);

      // Clean cache for each cold run
      await cleanupAllBenchmarkDirs();
      await setupBenchmarkDirs();

      const timing = await runColdStart({
        repos,
        cacheDir,
        workspaceDir,
      });

      coldRuns.push(timing);
      console.log(`    Total: ${formatMs(timing.totalMs)}`);
    }

    const coldResult: BenchmarkResult = {
      scenario: "cold",
      runs: coldRuns,
      stats: calculateStats(coldRuns),
    };

    results.push(coldResult);
    printBenchmarkSummary(coldResult);
  }

  // Run warm-start benchmarks
  if (options.scenario === "warm" || options.scenario === "both") {
    console.log("Running warm-start benchmarks...");

    // For warm benchmarks, we need to prime the cache first
    if (options.scenario === "warm") {
      console.log("  Priming cache...");
      const primeDir = path.join(workspaceBaseDir, "prime");
      await runColdStart({
        repos,
        cacheDir,
        workspaceDir: primeDir,
      });
    }

    const warmRuns: BenchmarkTiming[] = [];

    for (let i = 0; i < options.runs; i++) {
      console.log(`  Run ${i + 1}/${options.runs}...`);
      const workspaceDir = path.join(workspaceBaseDir, `warm-${i}`);

      const timing = await runWarmStart({
        repos,
        cacheDir,
        workspaceDir,
      });

      warmRuns.push(timing);
      console.log(`    Total: ${formatMs(timing.totalMs)}`);
    }

    const warmResult: BenchmarkResult = {
      scenario: "warm",
      runs: warmRuns,
      stats: calculateStats(warmRuns),
    };

    results.push(warmResult);
    printBenchmarkSummary(warmResult);
  }

  // Export results if requested
  if (options.outputFile) {
    const json = exportResults(results);
    await fs.writeFile(options.outputFile, json, "utf8");
    console.log(`Results written to ${options.outputFile}`);
  }

  // Print summary
  console.log();
  console.log("=== SUMMARY ===");
  for (const result of results) {
    console.log(`${result.scenario.toUpperCase()}: Median ${formatMs(result.stats.median)}`);
  }
}

main().catch((error) => {
  console.error("Benchmark failed:", error);
  process.exit(1);
});
