import type { RepoConfig } from "../../types.ts";
import type { TaskGenerator } from "../../utils/task-generator.ts";

/**
 * Context provided to initializers for detection and execution.
 */
export type InitializerContext = {
  repoDir: string;
  workspaceDir: string;
  repo: RepoConfig;
};

/**
 * Result of running an initializer's detect function.
 */
export type InitializerDetection = {
  shouldRun: boolean;
  metadata?: Record<string, unknown>;
};

/**
 * Definition of an initializer.
 * Initializers run automatically based on project detection during workspace setup.
 */
export type InitializerDefinition = {
  /** Unique identifier for this initializer */
  id: string;
  /** Human-readable name */
  name: string;
  /** Priority for ordering (lower runs first). Install: 100-199, Linking: 200-299 */
  priority: number;
  /** Detect if this initializer should run */
  detect: (context: InitializerContext) => Promise<InitializerDetection>;
  /** Execute the initializer. Yields state updates for progress tracking. */
  execute: (
    context: InitializerContext,
    metadata: Record<string, unknown>,
  ) => TaskGenerator;
};
