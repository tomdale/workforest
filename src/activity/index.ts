import path from "node:path";
import { WORKFOREST_ENVIRONMENT_VARIABLES } from "../environment.ts";
import type { WorkspaceConfig } from "../types.ts";
import type { InventoryFilters } from "../workspace/inventory.ts";
import {
  type ActivityEngineOptions,
  isRunAlive,
  readServiceStatus,
  type ServiceStatus,
} from "./engine.ts";
import { createProviderDigestGenerator } from "./generate.ts";
import { toActivityView } from "./policy.ts";
import {
  type ActivityPaths,
  activityPaths,
  mutateInputs,
  readInputs,
  readRecord,
} from "./store.ts";
import { type ActivityTarget, collectActivityTargets } from "./targets.ts";
import type { ActivityEvent, ActivityView } from "./types.ts";

export {
  generateForTarget,
  runService,
  runSweep,
  type SweepSummary,
} from "./engine.ts";
export { activityTargetForEntry, collectActivityTargets } from "./targets.ts";
export type { ActivityView } from "./types.ts";

const MAX_EVENTS = 20;
const MAX_INPUT_CHARS = 500;

export function defaultEngineOptions(
  config: WorkspaceConfig,
  signal?: AbortSignal,
): ActivityEngineOptions {
  const paths = activityPaths();
  return {
    paths,
    generator: createProviderDigestGenerator(
      path.join(paths.cacheRoot, "sandbox"),
    ),
    inferenceEnabled: !aiDisabled(config),
    ...(signal ? { signal } : {}),
  };
}

function aiDisabled(config: WorkspaceConfig): boolean {
  const raw = process.env[WORKFOREST_ENVIRONMENT_VARIABLES.aiDisabled]
    ?.trim()
    .toLowerCase();
  if (raw && ["1", "true", "yes", "on"].includes(raw)) return true;
  if (raw && ["0", "false", "no", "off"].includes(raw)) return false;
  return config.ai?.disabled === true;
}

/**
 * Cached bulk read for UI clients: inventory metadata plus two small JSON
 * files per checkout (cache record and authored inputs). Never runs Git or a
 * model.
 */
export async function readActivityViews(
  config: WorkspaceConfig,
  filters: InventoryFilters = {},
  paths: ActivityPaths = activityPaths(),
  nowMs = Date.now(),
): Promise<ActivityView[]> {
  const { targets } = await collectActivityTargets(config, filters);
  return Promise.all(
    targets.map((target) => readActivityView(target, paths, nowMs)),
  );
}

export async function readActivityView(
  target: ActivityTarget,
  paths: ActivityPaths = activityPaths(),
  nowMs = Date.now(),
): Promise<ActivityView> {
  const [record, inputs] = await Promise.all([
    readRecord(paths, target.identity),
    readInputs(paths, target.identity),
  ]);
  return toActivityView({ record, inputs }, nowMs, { isRunAlive });
}

export type ActivityInput =
  | Readonly<{ kind: "purpose"; purpose: string | null }>
  | Readonly<{ kind: "pin"; pinned: boolean }>
  | Readonly<{
      kind: "note";
      source: string;
      summary: string | null;
      next: string | null;
    }>;

/**
 * Explicit inputs from people or agents, stored durably. A purpose outranks
 * inference, a pin keeps the checkout active, and a note is the bounded
 * ingestion seam for externally supplied activity (for example a BB thread
 * handoff). Purpose and note changes bump the inputs revision, which makes
 * the cached digest `outdated` and the next detection due immediately.
 */
export async function recordActivityInput(
  target: ActivityTarget,
  input: ActivityInput,
  paths: ActivityPaths = activityPaths(),
  nowMs = Date.now(),
): Promise<ActivityView> {
  const now = new Date(nowMs).toISOString();
  await mutateInputs(paths, target.identity, (current) => {
    switch (input.kind) {
      case "purpose": {
        const purpose = clipInput(input.purpose);
        if (purpose === current.purpose) return current;
        return {
          ...current,
          purpose,
          revision: current.revision + 1,
          activityAt: now,
        };
      }
      case "pin":
        return { ...current, pinned: input.pinned };
      case "note": {
        const event: ActivityEvent = {
          at: now,
          source: clipInput(input.source) ?? "manual",
          summary: clipInput(input.summary),
          next: clipInput(input.next),
        };
        return {
          ...current,
          events: [...current.events, event].slice(-MAX_EVENTS),
          revision: current.revision + 1,
          activityAt: now,
        };
      }
    }
  });
  return readActivityView(target, paths, nowMs);
}

function clipInput(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_INPUT_CHARS);
}

export type ActivityStatus = Readonly<{
  cacheRoot: string;
  inputsRoot: string;
  inference: "enabled" | "disabled";
  service: ServiceStatus;
  counts: Readonly<{
    targets: number;
    active: number;
    current: number;
    outdated: number;
    missing: number;
    queued: number;
    running: number;
    failed: number;
  }>;
}>;

export async function readActivityStatus(
  config: WorkspaceConfig,
  paths: ActivityPaths = activityPaths(),
  nowMs = Date.now(),
): Promise<ActivityStatus> {
  const [views, service] = await Promise.all([
    readActivityViews(config, {}, paths, nowMs),
    readServiceStatus(paths),
  ]);
  const count = (predicate: (view: ActivityView) => boolean) =>
    views.filter(predicate).length;
  return {
    cacheRoot: paths.cacheRoot,
    inputsRoot: paths.inputsRoot,
    inference: aiDisabled(config) ? "disabled" : "enabled",
    service,
    counts: {
      targets: views.length,
      active: count((view) => view.active),
      current: count((view) => view.freshness === "current"),
      outdated: count((view) => view.freshness === "outdated"),
      missing: count((view) => view.freshness === "missing"),
      queued: count((view) => view.generationState === "queued"),
      running: count((view) => view.generationState === "running"),
      failed: count((view) => view.generationState === "failed"),
    },
  };
}
