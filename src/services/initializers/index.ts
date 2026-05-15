import type { TaskState } from "../../utils/task-generator.ts";
import { runParallel } from "../../utils/task-generator.ts";
import { npmInstallInitializer } from "./npm-install.ts";
import { pnpmInstallInitializer } from "./pnpm-install.ts";
import { turboLinkInitializer } from "./turbo-link.ts";
import type {
  InitializerContext,
  InitializerDefinition,
  InitializerDetection,
} from "./types.ts";
import { vercelLinkInitializer } from "./vercel-link.ts";
import { yarnInstallInitializer } from "./yarn-install.ts";

// Re-export types
export type { InitializerContext, InitializerDefinition, InitializerDetection };

/**
 * State emitted by the initializer runner.
 */
export type InitializerState =
  | { phase: "detecting"; repoName: string }
  | {
      phase: "running";
      repoName: string;
      initializerId: string;
      initializerName: string;
      state: TaskState;
    }
  | {
      phase: "skipped";
      repoName: string;
      initializerId: string;
      reason: string;
    }
  | { phase: "repo-complete"; repoName: string };

/**
 * State emitted by a single-repo initializer run.
 * Used for per-repo pipeline orchestration.
 */
export type SingleRepoInitializerState =
  | { phase: "detecting" }
  | {
      phase: "running";
      initializerId: string;
      initializerName: string;
      state: TaskState;
    }
  | {
      phase: "skipped";
      initializerId: string;
      reason: string;
    }
  | { phase: "complete" };

/**
 * Registry of built-in initializers, sorted by priority.
 */
export const builtInInitializers: InitializerDefinition[] = [
  pnpmInstallInitializer,
  yarnInstallInitializer,
  npmInstallInitializer,
  vercelLinkInitializer,
  turboLinkInitializer,
].sort((a, b) => a.priority - b.priority);

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export type RunInitializersOptions = {
  contexts: InitializerContext[];
  disabledInitializers?: boolean | string[];
};

/**
 * Detect which initializers should run for a given context.
 * Returns initializers paired with their detection metadata.
 */
async function detectInitializers(
  context: InitializerContext,
  initializers: InitializerDefinition[],
): Promise<
  Array<{
    initializer: InitializerDefinition;
    metadata: Record<string, unknown>;
  }>
> {
  const results: Array<{
    initializer: InitializerDefinition;
    metadata: Record<string, unknown>;
  }> = [];

  for (const initializer of initializers) {
    const detection = await initializer.detect(context);
    if (detection.shouldRun) {
      results.push({
        initializer,
        metadata: detection.metadata ?? {},
      });
    }
  }

  return results;
}

/**
 * Get the list of enabled initializers based on disabledInitializers config.
 */
function getEnabledInitializers(
  disabledInitializers: boolean | string[] | undefined,
): InitializerDefinition[] {
  if (disabledInitializers === true) {
    return [];
  }

  if (Array.isArray(disabledInitializers)) {
    return builtInInitializers.filter(
      (init) => !disabledInitializers.includes(init.id),
    );
  }

  return builtInInitializers;
}

/**
 * Generator that runs initializers for multiple repositories.
 * Yields state updates for progress tracking.
 *
 * Initializers are run in priority order within each repo.
 * Install initializers (priority 100-199) run first, then linking (200-299).
 */
export async function* runInitializersGenerator({
  contexts,
  disabledInitializers,
}: RunInitializersOptions): AsyncGenerator<InitializerState> {
  const enabledInitializers = getEnabledInitializers(disabledInitializers);

  if (enabledInitializers.length === 0) {
    return;
  }

  // Group initializers by priority range for parallel execution
  const installInitializers = enabledInitializers.filter(
    (init) => init.priority >= 100 && init.priority < 200,
  );
  const linkingInitializers = enabledInitializers.filter(
    (init) => init.priority >= 200 && init.priority < 300,
  );

  // Phase 1: Run install initializers in parallel across repos
  if (installInitializers.length > 0) {
    const installTasks = new Map<string, AsyncGenerator<TaskState>>();

    // Detect and queue install tasks for each repo
    for (const context of contexts) {
      yield { phase: "detecting", repoName: context.repo.name };

      let detected: Awaited<ReturnType<typeof detectInitializers>>;
      try {
        detected = await detectInitializers(context, installInitializers);
      } catch (error) {
        yield {
          phase: "running",
          repoName: context.repo.name,
          initializerId: "detection",
          initializerName: "Initializer detection",
          state: { status: "failed", error: toError(error) },
        };
        continue;
      }

      // Only one install initializer should run per repo (mutually exclusive)
      const detectedInstall = detected[0];
      if (detectedInstall) {
        const { initializer, metadata } = detectedInstall;
        const taskId = `${context.repo.name}:${initializer.id}`;

        // Create a wrapper generator that yields InitializerState
        async function* wrapWithMeta(): AsyncGenerator<TaskState> {
          try {
            for await (const state of initializer.execute(context, metadata)) {
              yield state;
            }
          } catch (error) {
            yield { status: "failed", error: toError(error) };
          }
        }

        installTasks.set(taskId, wrapWithMeta());
      }
    }

    // Run install tasks in parallel
    for await (const { id, state } of runParallel(installTasks)) {
      const [repoName = id, initializerId = ""] = id.split(":");
      const initializer = installInitializers.find(
        (i) => i.id === initializerId,
      );

      yield {
        phase: "running",
        repoName,
        initializerId,
        initializerName: initializer?.name ?? initializerId,
        state,
      };
    }
  }

  // Phase 2: Run linking initializers in parallel across repos
  if (linkingInitializers.length > 0) {
    const linkTasks = new Map<string, AsyncGenerator<TaskState>>();

    // Detect and queue linking tasks for each repo
    for (const context of contexts) {
      let detected: Awaited<ReturnType<typeof detectInitializers>>;
      try {
        detected = await detectInitializers(context, linkingInitializers);
      } catch (error) {
        yield {
          phase: "running",
          repoName: context.repo.name,
          initializerId: "detection",
          initializerName: "Initializer detection",
          state: { status: "failed", error: toError(error) },
        };
        continue;
      }

      for (const { initializer, metadata } of detected) {
        const taskId = `${context.repo.name}:${initializer.id}`;

        async function* wrapWithMeta(): AsyncGenerator<TaskState> {
          try {
            for await (const state of initializer.execute(context, metadata)) {
              yield state;
            }
          } catch (error) {
            yield { status: "failed", error: toError(error) };
          }
        }

        linkTasks.set(taskId, wrapWithMeta());
      }
    }

    // Run linking tasks in parallel
    for await (const { id, state } of runParallel(linkTasks)) {
      const [repoName = id, initializerId = ""] = id.split(":");
      const initializer = linkingInitializers.find(
        (i) => i.id === initializerId,
      );

      yield {
        phase: "running",
        repoName,
        initializerId,
        initializerName: initializer?.name ?? initializerId,
        state,
      };
    }
  }

  // Signal completion for each repo
  for (const context of contexts) {
    yield { phase: "repo-complete", repoName: context.repo.name };
  }
}

export type RunSingleRepoInitializersOptions = {
  context: InitializerContext;
  disabledInitializers?: boolean | string[];
};

/**
 * Generator that runs initializers for a single repository.
 * Used by the per-repo pipeline to enable cross-phase parallelism.
 *
 * Runs install initializers first (priority 100-199), then linking (200-299).
 * Within each phase, initializers run sequentially for this repo.
 */
export async function* runSingleRepoInitializersGenerator({
  context,
  disabledInitializers,
}: RunSingleRepoInitializersOptions): AsyncGenerator<SingleRepoInitializerState> {
  const enabledInitializers = getEnabledInitializers(disabledInitializers);

  if (enabledInitializers.length === 0) {
    yield { phase: "complete" };
    return;
  }

  // Group initializers by priority range
  const installInitializers = enabledInitializers.filter(
    (init) => init.priority >= 100 && init.priority < 200,
  );
  const linkingInitializers = enabledInitializers.filter(
    (init) => init.priority >= 200 && init.priority < 300,
  );

  yield { phase: "detecting" };

  // Phase 1: Run install initializer (only one per repo - mutually exclusive)
  if (installInitializers.length > 0) {
    let detected: Awaited<ReturnType<typeof detectInitializers>>;
    try {
      detected = await detectInitializers(context, installInitializers);
    } catch (error) {
      yield {
        phase: "running",
        initializerId: "detection",
        initializerName: "Initializer detection",
        state: { status: "failed", error: toError(error) },
      };
      return;
    }

    const detectedInstall = detected[0];
    if (detectedInstall) {
      const { initializer, metadata } = detectedInstall;

      try {
        for await (const state of initializer.execute(context, metadata)) {
          yield {
            phase: "running",
            initializerId: initializer.id,
            initializerName: initializer.name,
            state,
          };
        }
      } catch (error) {
        yield {
          phase: "running",
          initializerId: initializer.id,
          initializerName: initializer.name,
          state: { status: "failed", error: toError(error) },
        };
        return;
      }
    }
  }

  // Phase 2: Run linking initializers (can have multiple)
  if (linkingInitializers.length > 0) {
    let detected: Awaited<ReturnType<typeof detectInitializers>>;
    try {
      detected = await detectInitializers(context, linkingInitializers);
    } catch (error) {
      yield {
        phase: "running",
        initializerId: "detection",
        initializerName: "Initializer detection",
        state: { status: "failed", error: toError(error) },
      };
      return;
    }

    for (const { initializer, metadata } of detected) {
      try {
        for await (const state of initializer.execute(context, metadata)) {
          yield {
            phase: "running",
            initializerId: initializer.id,
            initializerName: initializer.name,
            state,
          };
        }
      } catch (error) {
        yield {
          phase: "running",
          initializerId: initializer.id,
          initializerName: initializer.name,
          state: { status: "failed", error: toError(error) },
        };
        return;
      }
    }
  }

  yield { phase: "complete" };
}
