#!/usr/bin/env node
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

type BenchmarkOptions = {
  runs: number;
  warmupRuns: number;
  repoCount: number;
  linesPerPhase: number;
  lineWidth: number;
  yieldEvery: number;
  yieldMs: number;
  width: number;
  height: number;
  fps: number;
  timeoutMs: number;
  outputFile?: string;
};

type GhosttyBenchResult = {
  wallMs: number;
  userCpuMs: number;
  systemCpuMs: number;
  maxRssBytes: number;
  drawCalls: number;
  wakeups: number;
  ticks: number;
  processAliveOnClose: boolean;
};

type FrameMetric = {
  index: number;
  timestampMs: number;
  renderDurationMs: number;
  drawDurationMs: number;
  dirtyLines: number;
  dirtyLineRatio: number;
  changedCells: number;
  changedSpanCells: number;
  blankCells: number;
  repaintRatio: number;
  spanRatio: number;
  outputBytes: number;
  viewportCells: number;
};

type SessionStatSummary = {
  median: number;
  mean: number;
  p95: number;
  stddev: number;
  min: number;
  max: number;
};

type PaneRenderMetrics = {
  wallMs: number;
  renderCount: number;
  overallFps: number;
  activeSpanMs: number;
  activeFps: number;
  totalOutputBytes: number;
  viewportCells: number;
  changedCells: SessionStatSummary;
  changedSpanCells: SessionStatSummary;
  blankCells: SessionStatSummary;
  dirtyLines: SessionStatSummary;
  repaintRatio: SessionStatSummary;
  spanRatio: SessionStatSummary;
  outputBytes: SessionStatSummary;
  largeRepaintFrames: {
    over25Pct: number;
    over50Pct: number;
    over75Pct: number;
  };
  frames: FrameMetric[];
};

type RunMetrics = {
  runIndex: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  crashReportCount: number;
  crashReportPaths: string[];
  result: GhosttyBenchResult;
  pane: PaneRenderMetrics;
};

type AggregateStats = {
  median: number;
  mean: number;
  stddev: number;
  min: number;
  max: number;
};

type AggregateSummary = {
  wallMs: AggregateStats;
  userCpuMs: AggregateStats;
  systemCpuMs: AggregateStats;
  maxRssBytes: AggregateStats;
  drawCalls: AggregateStats;
  wakeups: AggregateStats;
  ticks: AggregateStats;
  paneRenderCount: AggregateStats;
  paneOverallFps: AggregateStats;
  paneActiveFps: AggregateStats;
  paneOutputBytes: AggregateStats;
  paneMeanRepaintRatio: AggregateStats;
  paneMaxRepaintRatio: AggregateStats;
  paneLargeRepaintFramesOver25Pct: AggregateStats;
  crashReportCount: AggregateStats;
  exitCodes: Array<number | null>;
};

function parseArgs(): BenchmarkOptions {
  const args = process.argv.slice(2);
  const options: BenchmarkOptions = {
    runs: 5,
    warmupRuns: 1,
    repoCount: 9,
    linesPerPhase: 120,
    lineWidth: 48,
    yieldEvery: 0,
    yieldMs: 0,
    width: 1600,
    height: 1000,
    fps: 120,
    timeoutMs: 60_000,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--runs" && args[i + 1]) {
      options.runs = Number.parseInt(args[++i], 10);
    } else if (arg === "--warmup-runs" && args[i + 1]) {
      options.warmupRuns = Number.parseInt(args[++i], 10);
    } else if (arg === "--repos" && args[i + 1]) {
      options.repoCount = Number.parseInt(args[++i], 10);
    } else if (arg === "--lines" && args[i + 1]) {
      options.linesPerPhase = Number.parseInt(args[++i], 10);
    } else if (arg === "--line-width" && args[i + 1]) {
      options.lineWidth = Number.parseInt(args[++i], 10);
    } else if (arg === "--yield-every" && args[i + 1]) {
      options.yieldEvery = Number.parseInt(args[++i], 10);
    } else if (arg === "--yield-ms" && args[i + 1]) {
      options.yieldMs = Number.parseFloat(args[++i]);
    } else if (arg === "--width" && args[i + 1]) {
      options.width = Number.parseFloat(args[++i]);
    } else if (arg === "--height" && args[i + 1]) {
      options.height = Number.parseFloat(args[++i]);
    } else if (arg === "--fps" && args[i + 1]) {
      options.fps = Number.parseFloat(args[++i]);
    } else if (arg === "--timeout-ms" && args[i + 1]) {
      options.timeoutMs = Number.parseInt(args[++i], 10);
    } else if (arg === "--output" && args[i + 1]) {
      options.outputFile = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`
Ghostty Real Terminal Benchmark

Usage: pnpm exec tsx benchmarks/ghostty-real.ts [options]

Options:
  --runs N              Measured runs (default: 5)
  --warmup-runs N       Warmup runs excluded from summary (default: 1)
  --repos N             Number of panes/repos (default: 9)
  --lines N             Logical lines per phase per repo (default: 120)
  --line-width N        Width of generated log lines (default: 48)
  --yield-every N       Yield to the event loop every N logical lines per repo (default: 0)
  --yield-ms N          Delay for each yield in milliseconds (default: 0)
  --width N             Window width in points (default: 1600)
  --height N            Window height in points (default: 1000)
  --fps N               Ghostty draw polling rate (default: 120)
  --timeout-ms N        Per-run timeout in milliseconds (default: 60000)
  --output FILE         Write JSON results to a file
  --help, -h            Show this help
`);
}

async function main(): Promise<void> {
  const options = parseArgs();
  const cwd = process.cwd();

  console.log("=== Ghostty Real Terminal Benchmark ===");
  console.log(
    `Workload: ${options.repoCount} repos, ${options.linesPerPhase} lines/phase, ${options.lineWidth} chars/line`,
  );
  console.log(
    `Pacing: yield every ${options.yieldEvery || "never"} lines, delay ${options.yieldMs}ms`,
  );
  console.log(
    `Window: ${options.width}x${options.height} @ ${options.fps}fps, warmups: ${options.warmupRuns}, measured runs: ${options.runs}`,
  );

  const binaryPath = await buildBenchmarkHost(cwd);
  console.log(`Host binary: ${binaryPath}`);

  const warmups = await runSeries({
    count: options.warmupRuns,
    options,
    cwd,
    binaryPath,
    label: "warmup",
  });

  const runs = await runSeries({
    count: options.runs,
    options,
    cwd,
    binaryPath,
    label: "run",
  });

  const summary = aggregateRuns(runs);
  printSummary(summary);

  const payload = {
    timestamp: new Date().toISOString(),
    config: options,
    binaryPath,
    warmups,
    runs,
    summary,
  };

  if (options.outputFile) {
    await writeFile(options.outputFile, JSON.stringify(payload, null, 2), "utf8");
    console.log(`\nWrote results to ${options.outputFile}`);
  }
}

async function buildBenchmarkHost(cwd: string): Promise<string> {
  console.log("\nBuilding Ghostty host...");
  await runCommand(
    "swift",
    ["build", "--package-path", "benchmarks/ghostty-real"],
    cwd,
    0,
  );

  const binPathResult = await runCommand(
    "swift",
    ["build", "--package-path", "benchmarks/ghostty-real", "--show-bin-path"],
    cwd,
    0,
  );
  const binPath = binPathResult.stdout.trim().split("\n").at(-1)?.trim();
  if (!binPath) {
    throw new Error("Swift build did not return a bin path");
  }

  return join(binPath, "ghostty-real-bench");
}

async function runSeries(input: {
  count: number;
  options: BenchmarkOptions;
  cwd: string;
  binaryPath: string;
  label: string;
}): Promise<RunMetrics[]> {
  const runs: RunMetrics[] = [];
  for (let index = 0; index < input.count; index++) {
    const runNumber = index + 1;
    process.stdout.write(`\n${input.label} ${runNumber}/${input.count}... `);
    const run = await runBenchmark({
      options: input.options,
      cwd: input.cwd,
      binaryPath: input.binaryPath,
      runIndex: runNumber,
    });
    runs.push(run);
    console.log(
      `wall ${formatMs(run.result.wallMs)}, pane ${formatNumber(run.pane.activeFps)} fps, repaint ${formatPercent(run.pane.repaintRatio.mean)}, draws ${run.result.drawCalls}, crash reports ${run.crashReportCount}`,
    );
  }

  return runs;
}

async function runBenchmark(input: {
  options: BenchmarkOptions;
  cwd: string;
  binaryPath: string;
  runIndex: number;
}): Promise<RunMetrics> {
  const tempDir = await mkdtemp(join(tmpdir(), "ghostty-real-bench-"));
  const resultPath = join(tempDir, "result.json");
  const paneMetricsPath = join(tempDir, "pane-metrics.json");
  const crashDir = `${process.env.HOME}/.local/state/ghostty/crash`;
  const beforeCrashReports = await listCrashReports(crashDir);
  const command =
    `pnpm exec tsx benchmarks/tui-grid-session.ts` +
    ` --repos ${input.options.repoCount}` +
    ` --lines ${input.options.linesPerPhase}` +
    ` --line-width ${input.options.lineWidth}` +
    ` --yield-every ${input.options.yieldEvery}` +
    ` --yield-ms ${input.options.yieldMs}` +
    ` --metrics ${paneMetricsPath}`;

  const start = performance.now();
  const runResult = await runCommand(
    input.binaryPath,
    [
      "--workdir",
      input.cwd,
      "--command",
      command,
      "--output",
      resultPath,
      "--width",
      String(input.options.width),
      "--height",
      String(input.options.height),
      "--fps",
      String(input.options.fps),
    ],
    input.cwd,
    input.options.timeoutMs,
    {
      GHOSTTY_LOG: "stderr",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
    },
  );
  const durationMs = performance.now() - start;

  const rawResult = await readFile(resultPath, "utf8").catch(() => {
    throw new Error(
      `Benchmark run ${input.runIndex} did not produce ${resultPath}\nstdout:\n${runResult.stdout}\nstderr:\n${runResult.stderr}`,
    );
  });
  const parsedResult = JSON.parse(rawResult) as GhosttyBenchResult;
  const rawPaneMetrics = await readFile(paneMetricsPath, "utf8").catch(() => {
    throw new Error(
      `Benchmark run ${input.runIndex} did not produce ${paneMetricsPath}\nstdout:\n${runResult.stdout}\nstderr:\n${runResult.stderr}`,
    );
  });
  const paneMetrics = JSON.parse(rawPaneMetrics) as PaneRenderMetrics;
  const afterCrashReports = await listCrashReports(crashDir);
  const newCrashReports = [...afterCrashReports].filter(
    (report) => !beforeCrashReports.has(report),
  );

  await rm(tempDir, { recursive: true, force: true });

  return {
    runIndex: input.runIndex,
    exitCode: runResult.exitCode,
    signal: runResult.signal,
    durationMs,
    crashReportCount: newCrashReports.length,
    crashReportPaths: newCrashReports.sort(),
    result: parsedResult,
    pane: paneMetrics,
  };
}

async function listCrashReports(crashDir: string): Promise<Set<string>> {
  try {
    const entries = await readdir(crashDir);
    return new Set(
      entries
        .filter((entry) => entry.endsWith(".ghosttycrash"))
        .map((entry) => join(crashDir, entry)),
    );
  } catch {
    return new Set();
  }
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeoutId: NodeJS.Timeout | undefined;

    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        child.kill("SIGKILL");
      }, timeoutMs);
    }

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (timeoutId) clearTimeout(timeoutId);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (exitCode, signal) => {
      if (timeoutId) clearTimeout(timeoutId);
      if (!settled) {
        settled = true;
        resolve({ exitCode, signal, stdout, stderr });
      }
    });
  });
}

function aggregateRuns(runs: RunMetrics[]): AggregateSummary {
  return {
    wallMs: calculateStats(runs.map((run) => run.result.wallMs)),
    userCpuMs: calculateStats(runs.map((run) => run.result.userCpuMs)),
    systemCpuMs: calculateStats(runs.map((run) => run.result.systemCpuMs)),
    maxRssBytes: calculateStats(runs.map((run) => run.result.maxRssBytes)),
    drawCalls: calculateStats(runs.map((run) => run.result.drawCalls)),
    wakeups: calculateStats(runs.map((run) => run.result.wakeups)),
    ticks: calculateStats(runs.map((run) => run.result.ticks)),
    paneRenderCount: calculateStats(runs.map((run) => run.pane.renderCount)),
    paneOverallFps: calculateStats(runs.map((run) => run.pane.overallFps)),
    paneActiveFps: calculateStats(runs.map((run) => run.pane.activeFps)),
    paneOutputBytes: calculateStats(runs.map((run) => run.pane.totalOutputBytes)),
    paneMeanRepaintRatio: calculateStats(
      runs.map((run) => run.pane.repaintRatio.mean),
    ),
    paneMaxRepaintRatio: calculateStats(
      runs.map((run) => run.pane.repaintRatio.max),
    ),
    paneLargeRepaintFramesOver25Pct: calculateStats(
      runs.map((run) => run.pane.largeRepaintFrames.over25Pct),
    ),
    crashReportCount: calculateStats(runs.map((run) => run.crashReportCount)),
    exitCodes: runs.map((run) => run.exitCode),
  };
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

function printSummary(summary: AggregateSummary): void {
  console.log("\n=== SUMMARY ===");
  console.log(
    `Wall time:   median ${formatMs(summary.wallMs.median)}, mean ${formatMs(summary.wallMs.mean)}, stddev ${formatMs(summary.wallMs.stddev)}`,
  );
  console.log(
    `User CPU:    median ${formatMs(summary.userCpuMs.median)}, mean ${formatMs(summary.userCpuMs.mean)}`,
  );
  console.log(
    `System CPU:  median ${formatMs(summary.systemCpuMs.median)}, mean ${formatMs(summary.systemCpuMs.mean)}`,
  );
  console.log(
    `Max RSS:     median ${formatBytes(summary.maxRssBytes.median)}, mean ${formatBytes(summary.maxRssBytes.mean)}`,
  );
  console.log(
    `Draw calls:  median ${formatNumber(summary.drawCalls.median)}, mean ${formatNumber(summary.drawCalls.mean)}`,
  );
  console.log(
    `Wakeups:     median ${formatNumber(summary.wakeups.median)}, mean ${formatNumber(summary.wakeups.mean)}`,
  );
  console.log(
    `Ticks:       median ${formatNumber(summary.ticks.median)}, mean ${formatNumber(summary.ticks.mean)}`,
  );
  console.log(
    `Pane FPS:    median ${formatNumber(summary.paneActiveFps.median)}, mean ${formatNumber(summary.paneActiveFps.mean)}`,
  );
  console.log(
    `Pane renders: median ${formatNumber(summary.paneRenderCount.median)}, mean ${formatNumber(summary.paneRenderCount.mean)}`,
  );
  console.log(
    `Pane bytes:  median ${formatDataSize(summary.paneOutputBytes.median)}, mean ${formatDataSize(summary.paneOutputBytes.mean)}`,
  );
  console.log(
    `Mean repaint/frame: median ${formatPercent(summary.paneMeanRepaintRatio.median)}, mean ${formatPercent(summary.paneMeanRepaintRatio.mean)}`,
  );
  console.log(
    `Max repaint/frame:  median ${formatPercent(summary.paneMaxRepaintRatio.median)}, mean ${formatPercent(summary.paneMaxRepaintRatio.mean)}`,
  );
  console.log(
    `Large repaint frames (>25%): median ${formatNumber(summary.paneLargeRepaintFramesOver25Pct.median)}, mean ${formatNumber(summary.paneLargeRepaintFramesOver25Pct.mean)}`,
  );
  console.log(
    `Crash files: median ${formatNumber(summary.crashReportCount.median)}, mean ${formatNumber(summary.crashReportCount.mean)}`,
  );
  console.log(`Exit codes:  ${summary.exitCodes.join(", ")}`);
}

function formatMs(ms: number): string {
  if (ms < 1000) {
    return `${ms.toFixed(1)}ms`;
  }

  return `${(ms / 1000).toFixed(2)}s`;
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatNumber(value: number): string {
  return value.toFixed(1);
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatDataSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes.toFixed(0)}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

main().catch((error) => {
  console.error("Ghostty real benchmark failed:", error);
  process.exit(1);
});
