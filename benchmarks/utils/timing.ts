/**
 * High-resolution timing utilities for benchmarks.
 */

export type PhaseTiming = {
  name: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  children?: PhaseTiming[];
};

export type BenchmarkTiming = {
  scenario: "cold" | "warm";
  repoCount: number;
  totalMs: number;
  phases: {
    git: {
      total: number;
      perRepo: Record<string, { mirror: number; cleanup: number; worktree: number; total: number }>;
    };
    install: {
      total: number;
      perRepo: Record<string, number>;
    };
    hooks: number;
    finalize: number;
  };
};

/**
 * Timer class for tracking phase durations with high-resolution timestamps.
 */
export class Timer {
  private startTime: number;
  private phases: Map<string, { start: number; end?: number }> = new Map();
  private subPhases: Map<string, Map<string, { start: number; end?: number }>> = new Map();

  constructor() {
    this.startTime = performance.now();
  }

  /**
   * Start timing a phase.
   */
  startPhase(name: string): void {
    this.phases.set(name, { start: performance.now() });
  }

  /**
   * End timing a phase.
   */
  endPhase(name: string): void {
    const phase = this.phases.get(name);
    if (phase) {
      phase.end = performance.now();
    }
  }

  /**
   * Start timing a sub-phase within a parent phase.
   */
  startSubPhase(parentName: string, subName: string): void {
    if (!this.subPhases.has(parentName)) {
      this.subPhases.set(parentName, new Map());
    }
    this.subPhases.get(parentName)?.set(subName, { start: performance.now() });
  }

  /**
   * End timing a sub-phase.
   */
  endSubPhase(parentName: string, subName: string): void {
    const sub = this.subPhases.get(parentName)?.get(subName);
    if (sub) {
      sub.end = performance.now();
    }
  }

  /**
   * Get the duration of a phase in milliseconds.
   */
  getPhaseDuration(name: string): number {
    const phase = this.phases.get(name);
    if (!phase) return 0;
    const end = phase.end ?? performance.now();
    return end - phase.start;
  }

  /**
   * Get the duration of a sub-phase in milliseconds.
   */
  getSubPhaseDuration(parentName: string, subName: string): number {
    const sub = this.subPhases.get(parentName)?.get(subName);
    if (!sub) return 0;
    const end = sub.end ?? performance.now();
    return end - sub.start;
  }

  /**
   * Get all sub-phases for a parent.
   */
  getSubPhases(parentName: string): Map<string, { start: number; end?: number }> {
    return this.subPhases.get(parentName) ?? new Map();
  }

  /**
   * Get total elapsed time since timer creation.
   */
  getTotalMs(): number {
    return performance.now() - this.startTime;
  }
}

/**
 * Format milliseconds for display.
 */
export function formatMs(ms: number): string {
  if (ms < 1000) {
    return `${ms.toFixed(0)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}
