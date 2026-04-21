#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { Screen } from "@unblessed/node";
import { renderPipelinesGrid } from "../src/ui/grid-consumer.ts";
import type { RepoPipelineState } from "../src/workspace/pipeline.ts";

type Options = {
  repoCount: number;
  linesPerPhase: number;
  lineWidth: number;
  yieldEvery: number;
  yieldMs: number;
  metricsFile?: string;
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

type StatSummary = {
  median: number;
  mean: number;
  p95: number;
  stddev: number;
  min: number;
  max: number;
};

type SessionMetrics = {
  wallMs: number;
  renderCount: number;
  overallFps: number;
  activeSpanMs: number;
  activeFps: number;
  totalOutputBytes: number;
  viewportCells: number;
  changedCells: StatSummary;
  changedSpanCells: StatSummary;
  blankCells: StatSummary;
  dirtyLines: StatSummary;
  repaintRatio: StatSummary;
  spanRatio: StatSummary;
  outputBytes: StatSummary;
  largeRepaintFrames: {
    over25Pct: number;
    over50Pct: number;
    over75Pct: number;
  };
  frames: FrameMetric[];
};

type PendingFrame = Omit<FrameMetric, "dirtyLineRatio" | "repaintRatio" | "spanRatio"> & {
  dirtyLineRatio?: number;
  repaintRatio?: number;
  spanRatio?: number;
};

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const options: Options = {
    repoCount: 9,
    linesPerPhase: 120,
    lineWidth: 48,
    yieldEvery: 0,
    yieldMs: 0,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--repos" && args[i + 1]) {
      options.repoCount = Number.parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--lines" && args[i + 1]) {
      options.linesPerPhase = Number.parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--line-width" && args[i + 1]) {
      options.lineWidth = Number.parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--yield-every" && args[i + 1]) {
      options.yieldEvery = Number.parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--yield-ms" && args[i + 1]) {
      options.yieldMs = Number.parseFloat(args[i + 1]);
      i++;
    } else if (arg === "--metrics" && args[i + 1]) {
      options.metricsFile = args[i + 1];
      i++;
    }
  }

  return options;
}

function installRenderProbe() {
  const originalRender = Screen.prototype.render;
  const originalDraw = Screen.prototype.draw;
  const sessionStart = performance.now();
  const frames: FrameMetric[] = [];

  type InstrumentedScreen = Screen & {
    __workforestProbePatched?: boolean;
    __workforestFrameBytes?: number;
    __workforestTotalBytes?: number;
  };

  let activeFrame: PendingFrame | null = null;

  function ensureProgramPatched(screen: InstrumentedScreen): void {
    if (screen.__workforestProbePatched) return;
    screen.__workforestProbePatched = true;
    screen.__workforestFrameBytes = 0;
    screen.__workforestTotalBytes = 0;

    const originalWrite = screen.program._write.bind(screen.program);
    screen.program._write = ((data: Buffer | string) => {
      const bytes =
        typeof data === "string" ? Buffer.byteLength(data) : data.length;
      screen.__workforestFrameBytes =
        (screen.__workforestFrameBytes ?? 0) + bytes;
      screen.__workforestTotalBytes = (screen.__workforestTotalBytes ?? 0) + bytes;
      return originalWrite(data);
    }) as typeof screen.program._write;
  }

  Screen.prototype.render = function renderWithProbe(...args: Parameters<typeof originalRender>) {
    const screen = this as InstrumentedScreen;
    ensureProgramPatched(screen);
    screen.__workforestFrameBytes = 0;

    const start = performance.now();
    activeFrame = {
      index: frames.length + 1,
      timestampMs: start - sessionStart,
      renderDurationMs: 0,
      drawDurationMs: 0,
      dirtyLines: 0,
      changedCells: 0,
      changedSpanCells: 0,
      blankCells: 0,
      outputBytes: 0,
      viewportCells: getViewportCells(screen),
    };

    try {
      return originalRender.apply(this, args);
    } finally {
      const end = performance.now();
      if (activeFrame) {
        activeFrame.renderDurationMs = end - start;
        activeFrame.outputBytes = screen.__workforestFrameBytes ?? 0;
        const viewportCells = activeFrame.viewportCells || 1;
        const lineCount = screen.lines?.length ?? 1;
        const finalized: FrameMetric = {
          index: activeFrame.index,
          timestampMs: activeFrame.timestampMs,
          renderDurationMs: activeFrame.renderDurationMs,
          drawDurationMs: activeFrame.drawDurationMs,
          dirtyLines: activeFrame.dirtyLines,
          dirtyLineRatio: activeFrame.dirtyLines / lineCount,
          changedCells: activeFrame.changedCells,
          changedSpanCells: activeFrame.changedSpanCells,
          blankCells: activeFrame.blankCells,
          repaintRatio: activeFrame.changedCells / viewportCells,
          spanRatio: activeFrame.changedSpanCells / viewportCells,
          outputBytes: activeFrame.outputBytes,
          viewportCells,
        };
        frames.push(finalized);
      }
      activeFrame = null;
      screen.__workforestFrameBytes = 0;
    }
  };

  Screen.prototype.draw = function drawWithProbe(...args: Parameters<typeof originalDraw>) {
    const [start, end] = args;
    const before = performance.now();
    if (activeFrame) {
      Object.assign(activeFrame, inspectDamage(this as Screen, start, end));
    }

    try {
      return originalDraw.apply(this, args);
    } finally {
      if (activeFrame) {
        activeFrame.drawDurationMs = performance.now() - before;
      }
    }
  };

  return {
    snapshot(): SessionMetrics {
      const wallMs = performance.now() - sessionStart;
      const renderCount = frames.length;
      const firstTimestamp = frames[0]?.timestampMs ?? 0;
      const lastTimestamp = frames.at(-1)?.timestampMs ?? wallMs;
      const activeSpanMs =
        renderCount > 1 ? Math.max(lastTimestamp - firstTimestamp, 0) : wallMs;
      const totalOutputBytes = frames.reduce(
        (sum, frame) => sum + frame.outputBytes,
        0,
      );
      const viewportCells = frames.reduce(
        (max, frame) => Math.max(max, frame.viewportCells),
        0,
      );

      return {
        wallMs,
        renderCount,
        overallFps: renderCount > 0 ? renderCount / (wallMs / 1000) : 0,
        activeSpanMs,
        activeFps:
          renderCount > 1 && activeSpanMs > 0
            ? (renderCount - 1) / (activeSpanMs / 1000)
            : 0,
        totalOutputBytes,
        viewportCells,
        changedCells: summarize(frames.map((frame) => frame.changedCells)),
        changedSpanCells: summarize(frames.map((frame) => frame.changedSpanCells)),
        blankCells: summarize(frames.map((frame) => frame.blankCells)),
        dirtyLines: summarize(frames.map((frame) => frame.dirtyLines)),
        repaintRatio: summarize(frames.map((frame) => frame.repaintRatio)),
        spanRatio: summarize(frames.map((frame) => frame.spanRatio)),
        outputBytes: summarize(frames.map((frame) => frame.outputBytes)),
        largeRepaintFrames: {
          over25Pct: frames.filter((frame) => frame.repaintRatio >= 0.25).length,
          over50Pct: frames.filter((frame) => frame.repaintRatio >= 0.5).length,
          over75Pct: frames.filter((frame) => frame.repaintRatio >= 0.75).length,
        },
        frames,
      };
    },
    restore(): void {
      Screen.prototype.render = originalRender;
      Screen.prototype.draw = originalDraw;
    },
  };
}

function getViewportCells(screen: Screen): number {
  return (
    screen.lines?.reduce((sum, line) => sum + (line?.length ?? 0), 0) ?? 0
  );
}

function inspectDamage(screen: Screen, start: number, end: number) {
  let dirtyLines = 0;
  let changedCells = 0;
  let changedSpanCells = 0;
  let blankCells = 0;

  const lines = screen.lines ?? [];
  const previousLines = screen.olines ?? [];

  for (let y = start; y <= end; y++) {
    const line = lines[y];
    const previousLine = previousLines[y];
    if (!line || !previousLine) continue;
    if (!line.dirty) continue;

    dirtyLines++;
    let firstChangedX = -1;
    let lastChangedX = -1;

    for (let x = 0; x < line.length; x++) {
      const currentCell = line[x];
      const previousCell = previousLine[x];
      if (!currentCell || !previousCell) continue;

      const changed =
        currentCell[0] !== previousCell[0] || currentCell[1] !== previousCell[1];
      if (!changed) continue;

      changedCells++;
      if (currentCell[1] === " ") {
        blankCells++;
      }
      if (firstChangedX === -1) {
        firstChangedX = x;
      }
      lastChangedX = x;
    }

    if (firstChangedX !== -1 && lastChangedX !== -1) {
      changedSpanCells += lastChangedX - firstChangedX + 1;
    }
  }

  return {
    dirtyLines,
    changedCells,
    changedSpanCells,
    blankCells,
  };
}

function summarize(values: number[]): StatSummary {
  if (values.length === 0) {
    return { median: 0, mean: 0, p95: 0, stddev: 0, min: 0, max: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const median =
    sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  const variance =
    sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sorted.length;

  return {
    median,
    mean,
    p95,
    stddev: Math.sqrt(variance),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

async function* createStressPipeline(options: {
  repoName: string;
  linesPerPhase: number;
  lineWidth: number;
  yieldEvery: number;
  yieldMs: number;
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
      const index = i.toString().padStart(3, "0");
      yield {
        phase: phase.phase,
        ...(phase.phase === "git" ? { step: phase.step } : { name: phase.name }),
        status: "output",
        output: `${phase.prefix}:${options.repoName}:${index} ${"=".repeat(options.lineWidth)}\r`,
      };
      yield {
        phase: phase.phase,
        ...(phase.phase === "git" ? { step: phase.step } : { name: phase.name }),
        status: "output",
        output: `${phase.prefix}:${options.repoName}:${index} ${"#".repeat(Math.floor(options.lineWidth / 2))} `,
      };
      yield {
        phase: phase.phase,
        ...(phase.phase === "git" ? { step: phase.step } : { name: phase.name }),
        status: "output",
        output: `${"*".repeat(Math.ceil(options.lineWidth / 2))}\n`,
      };

      if (
        options.yieldEvery > 0 &&
        options.yieldMs >= 0 &&
        (i + 1) % options.yieldEvery === 0
      ) {
        await sleep(options.yieldMs);
      }
    }
  }

  yield { phase: "complete", hasLockfile: true };
}

async function main(): Promise<void> {
  const options = parseArgs();
  const probe = installRenderProbe();
  const repoNames = Array.from({ length: options.repoCount }, (_, index) => {
    return `repo-${index + 1}`;
  });
  const pipelines = new Map<string, AsyncGenerator<RepoPipelineState>>();

  for (const repoName of repoNames) {
    pipelines.set(
      repoName,
      createStressPipeline({
        repoName,
        linesPerPhase: options.linesPerPhase,
        lineWidth: options.lineWidth,
        yieldEvery: options.yieldEvery,
        yieldMs: options.yieldMs,
      }),
    );
  }

  try {
    await renderPipelinesGrid({
      pipelines,
      repoNames,
    });
  } finally {
    const metrics = probe.snapshot();
    probe.restore();
    if (options.metricsFile) {
      await writeFile(options.metricsFile, JSON.stringify(metrics, null, 2), "utf8");
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
