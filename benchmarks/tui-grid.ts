#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import type {
  GridLayoutLike,
  GridPaneLike,
  GridRenderEnvironment,
  GridScreenLike,
} from "../src/ui/grid-consumer.ts";
import { renderPipelinesGrid } from "../src/ui/grid-consumer.ts";
import type { RepoPipelineState } from "../src/workspace/pipeline.ts";

type BenchmarkMode = "batched" | "eager";

type BenchmarkOptions = {
  runs: number;
  repoCount: number;
  linesPerPhase: number;
  lineWidth: number;
  renderCostMs: number;
  outputFile?: string;
};

type RunMetrics = {
  mode: BenchmarkMode;
  elapsedMs: number;
  renderCalls: number;
  labelCalls: number;
  labelMutations: number;
  appendCalls: number;
  setContentCalls: number;
  totalEvents: number;
  outputEvents: number;
};

type AggregateStats = {
  median: number;
  mean: number;
  stddev: number;
  min: number;
  max: number;
};

type AggregateMetrics = {
  mode: BenchmarkMode;
  elapsedMs: AggregateStats;
  renderCalls: AggregateStats;
  labelMutations: AggregateStats;
  setContentCalls: AggregateStats;
  outputEvents: AggregateStats;
};

function parseArgs(): BenchmarkOptions {
  const args = process.argv.slice(2);
  const options: BenchmarkOptions = {
    runs: 10,
    repoCount: 9,
    linesPerPhase: 120,
    lineWidth: 48,
    renderCostMs: 0.2,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--runs" && args[i + 1]) {
      options.runs = Number.parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--repos" && args[i + 1]) {
      options.repoCount = Number.parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--lines" && args[i + 1]) {
      options.linesPerPhase = Number.parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--line-width" && args[i + 1]) {
      options.lineWidth = Number.parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--render-cost-ms" && args[i + 1]) {
      options.renderCostMs = Number.parseFloat(args[i + 1]);
      i++;
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
TUI Grid Benchmark

Usage: pnpm exec tsx benchmarks/tui-grid.ts [options]

Options:
  --runs N              Number of runs per mode (default: 10)
  --repos N             Number of panes/repos to simulate (default: 9)
  --lines N             Logical output lines per phase per repo (default: 120)
  --line-width N        Width of generated log lines (default: 48)
  --render-cost-ms N    Simulated terminal render cost per draw (default: 0.2)
  --output FILE         Write JSON results to a file
  --help, -h            Show this help
`);
}

class BenchmarkScreen implements GridScreenLike {
  key(): void {}
  destroy(): void {}
}

class BenchmarkPane implements GridPaneLike {
  private lines: string[] = [];
  private currentLabel: string | null = null;
  private maxLines = 200;

  metrics = {
    labelCalls: 0,
    labelMutations: 0,
    appendCalls: 0,
    setContentCalls: 0,
  };

  setLabel(label: string): void {
    this.metrics.labelCalls++;
    if (label === this.currentLabel) {
      return;
    }

    this.currentLabel = label;
    this.metrics.labelMutations++;
  }

  appendLine(line: string): void {
    this.metrics.appendCalls++;
    this.lines.push(...line.split("\n"));
    if (this.lines.length > this.maxLines) {
      this.lines = this.lines.slice(this.lines.length - this.maxLines);
    }

    // Match GridPaneImpl's current append cost by rebuilding the joined content.
    this.lines.join("\n");
    this.metrics.setContentCalls++;
  }
}

class BenchmarkGrid implements GridLayoutLike {
  readonly panes: BenchmarkPane[];
  renderCalls = 0;

  constructor(
    paneCount: number,
    private renderCostMs: number,
  ) {
    this.panes = Array.from({ length: paneCount }, () => new BenchmarkPane());
  }

  getPane(index: number): GridPaneLike | undefined {
    return this.panes[index];
  }

  render(): void {
    this.renderCalls++;
    busyWait(this.renderCostMs);
  }

  destroy(): void {}
}

function createBenchmarkEnvironment(options: {
  paneCount: number;
  renderCostMs: number;
  renderIntervalMs: number;
}): GridRenderEnvironment & { grid: BenchmarkGrid } {
  const screen = new BenchmarkScreen();
  const grid = new BenchmarkGrid(options.paneCount, options.renderCostMs);

  return {
    grid,
    createScreen: () => screen,
    createGrid: () => grid,
    renderIntervalMs: options.renderIntervalMs,
    finalHoldMs: 0,
  };
}

async function* createStressPipeline(options: {
  repoName: string;
  linesPerPhase: number;
  lineWidth: number;
}): AsyncGenerator<RepoPipelineState> {
  const phases = [
    {
      phase: "git" as const,
      step: "mirror" as const,
      message: `Fetching ${options.repoName}`,
      prefix: "mirror",
    },
    {
      phase: "git" as const,
      step: "worktree" as const,
      message: `Creating worktree for ${options.repoName}`,
      prefix: "worktree",
    },
    {
      phase: "initializer" as const,
      name: "pnpm",
      message: `Installing dependencies for ${options.repoName}`,
      prefix: "install",
    },
  ];

  for (const phase of phases) {
    if (phase.phase === "git") {
      yield {
        phase: "git",
        step: phase.step,
        status: "running",
        message: phase.message,
      };
    } else {
      yield {
        phase: "initializer",
        name: phase.name,
        status: "running",
        message: phase.message,
      };
    }

    for (let i = 0; i < options.linesPerPhase; i++) {
      yield {
        phase: phase.phase,
        ...(phase.phase === "git" ? { step: phase.step } : { name: phase.name }),
        status: "output",
        output: `${phase.prefix}:${options.repoName}:${i.toString().padStart(3, "0")} ${"=".repeat(options.lineWidth)}\r`,
      };
      yield {
        phase: phase.phase,
        ...(phase.phase === "git" ? { step: phase.step } : { name: phase.name }),
        status: "output",
        output: `${phase.prefix}:${options.repoName}:${i.toString().padStart(3, "0")} ${"#".repeat(options.lineWidth / 2)} `,
      };
      yield {
        phase: phase.phase,
        ...(phase.phase === "git" ? { step: phase.step } : { name: phase.name }),
        status: "output",
        output: `${"*".repeat(options.lineWidth / 2)}\n`,
      };
    }
  }

  yield { phase: "complete", hasLockfile: true };
}

function createPipelines(options: BenchmarkOptions): {
  pipelines: Map<string, AsyncGenerator<RepoPipelineState>>;
  repoNames: string[];
  totalEvents: number;
  outputEvents: number;
} {
  const repoNames = Array.from({ length: options.repoCount }, (_, index) =>
    `repo-${index + 1}`,
  );
  const pipelines = new Map<string, AsyncGenerator<RepoPipelineState>>();

  for (const repoName of repoNames) {
    pipelines.set(
      repoName,
      createStressPipeline({
        repoName,
        linesPerPhase: options.linesPerPhase,
        lineWidth: options.lineWidth,
      }),
    );
  }

  const eventsPerRepo = 3 + options.linesPerPhase * 9 + 1;
  const outputEventsPerRepo = options.linesPerPhase * 9;

  return {
    pipelines,
    repoNames,
    totalEvents: repoNames.length * eventsPerRepo,
    outputEvents: repoNames.length * outputEventsPerRepo,
  };
}

async function runMode(
  mode: BenchmarkMode,
  options: BenchmarkOptions,
): Promise<RunMetrics[]> {
  const runs: RunMetrics[] = [];

  for (let i = 0; i < options.runs; i++) {
    const { pipelines, repoNames, totalEvents, outputEvents } =
      createPipelines(options);
    const environment = createBenchmarkEnvironment({
      paneCount: repoNames.length,
      renderCostMs: options.renderCostMs,
      renderIntervalMs: mode === "batched" ? 33 : 0,
    });

    const start = performance.now();
    await renderPipelinesGrid({
      pipelines,
      repoNames,
      environment,
    });
    const elapsedMs = performance.now() - start;

    const paneMetrics = environment.grid.panes.reduce(
      (totals, pane) => ({
        labelCalls: totals.labelCalls + pane.metrics.labelCalls,
        labelMutations: totals.labelMutations + pane.metrics.labelMutations,
        appendCalls: totals.appendCalls + pane.metrics.appendCalls,
        setContentCalls: totals.setContentCalls + pane.metrics.setContentCalls,
      }),
      { labelCalls: 0, labelMutations: 0, appendCalls: 0, setContentCalls: 0 },
    );

    runs.push({
      mode,
      elapsedMs,
      renderCalls: environment.grid.renderCalls,
      labelCalls: paneMetrics.labelCalls,
      labelMutations: paneMetrics.labelMutations,
      appendCalls: paneMetrics.appendCalls,
      setContentCalls: paneMetrics.setContentCalls,
      totalEvents,
      outputEvents,
    });
  }

  return runs;
}

function calculateStats(values: number[]): AggregateStats {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const median =
    sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[Math.floor(sorted.length / 2)];
  const variance =
    sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    sorted.length;

  return {
    median,
    mean,
    stddev: Math.sqrt(variance),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function aggregate(mode: BenchmarkMode, runs: RunMetrics[]): AggregateMetrics {
  return {
    mode,
    elapsedMs: calculateStats(runs.map((run) => run.elapsedMs)),
    renderCalls: calculateStats(runs.map((run) => run.renderCalls)),
    labelMutations: calculateStats(runs.map((run) => run.labelMutations)),
    setContentCalls: calculateStats(runs.map((run) => run.setContentCalls)),
    outputEvents: calculateStats(runs.map((run) => run.outputEvents)),
  };
}

function formatMs(ms: number): string {
  if (ms < 1000) {
    return `${ms.toFixed(1)}ms`;
  }

  return `${(ms / 1000).toFixed(2)}s`;
}

function formatNumber(value: number): string {
  return value.toFixed(1);
}

function printSummary(summary: AggregateMetrics): void {
  console.log(`\n=== ${summary.mode.toUpperCase()} ===`);
  console.log(
    `Elapsed: median ${formatMs(summary.elapsedMs.median)}, mean ${formatMs(summary.elapsedMs.mean)}, stddev ${formatMs(summary.elapsedMs.stddev)}`,
  );
  console.log(
    `Renders: median ${formatNumber(summary.renderCalls.median)}, mean ${formatNumber(summary.renderCalls.mean)}`,
  );
  console.log(
    `Label mutations: median ${formatNumber(summary.labelMutations.median)}`,
  );
  console.log(
    `setContent calls: median ${formatNumber(summary.setContentCalls.median)}`,
  );
  console.log(
    `Output events: median ${formatNumber(summary.outputEvents.median)}`,
  );
}

function printComparison(
  eager: AggregateMetrics,
  batched: AggregateMetrics,
): void {
  const elapsedReduction =
    ((eager.elapsedMs.median - batched.elapsedMs.median) /
      eager.elapsedMs.median) *
    100;
  const renderReduction =
    ((eager.renderCalls.median - batched.renderCalls.median) /
      eager.renderCalls.median) *
    100;

  console.log("\n=== COMPARISON ===");
  console.log(`Median elapsed improvement: ${elapsedReduction.toFixed(1)}%`);
  console.log(`Median render reduction:    ${renderReduction.toFixed(1)}%`);
}

function busyWait(ms: number): void {
  if (ms <= 0) return;

  const start = performance.now();
  while (performance.now() - start < ms) {
    // Busy wait to simulate terminal draw cost in a deterministic way.
  }
}

async function main(): Promise<void> {
  const options = parseArgs();
  console.log("=== TUI Grid Benchmark ===");
  console.log(
    `Workload: ${options.repoCount} repos, ${options.linesPerPhase} lines/phase, ${options.lineWidth} chars/line`,
  );
  console.log(
    `Render cost: ${options.renderCostMs}ms, runs/mode: ${options.runs}`,
  );

  const eagerRuns = await runMode("eager", options);
  const batchedRuns = await runMode("batched", options);

  const eagerSummary = aggregate("eager", eagerRuns);
  const batchedSummary = aggregate("batched", batchedRuns);

  printSummary(eagerSummary);
  printSummary(batchedSummary);
  printComparison(eagerSummary, batchedSummary);

  if (options.outputFile) {
    const payload = {
      timestamp: new Date().toISOString(),
      config: options,
      results: {
        eager: { runs: eagerRuns, summary: eagerSummary },
        batched: { runs: batchedRuns, summary: batchedSummary },
      },
    };
    await writeFile(options.outputFile, JSON.stringify(payload, null, 2), "utf8");
    console.log(`\nWrote results to ${options.outputFile}`);
  }
}

main().catch((error) => {
  console.error("TUI benchmark failed:", error);
  process.exit(1);
});
