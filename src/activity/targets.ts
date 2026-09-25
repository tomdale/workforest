import { type Dirent, promises as fs } from "node:fs";
import path from "node:path";
import type { WorkspaceConfig, WorkspaceMetadata } from "../types.ts";
import {
  collectInventory,
  type InventoryEntry,
  type InventoryFilters,
} from "../workspace/inventory.ts";
import {
  readWorkspaceMetadata,
  readWorktreeMetadata,
} from "../workspace/metadata.ts";
import { TASKS_DIRECTORY_NAME } from "../workspace/paths.ts";
import { activityKey } from "./store.ts";
import type { ActivityTargetIdentity } from "./types.ts";

export type ActivityCheckout = Readonly<{
  /** Repository name, or `<repo>/<task>` for task worktrees. */
  label: string;
  path: string;
}>;

export type ActivityTask = Readonly<{
  repo: string;
  slug: string;
  branch: string | null;
  setupStatus: string | null;
}>;

/** Everything a detection or evidence pass needs, from local metadata only. */
export type ActivityTarget = Readonly<{
  identity: ActivityTargetIdentity;
  changeName: string;
  description: string | null;
  checkouts: readonly ActivityCheckout[];
  tasks: readonly ActivityTask[];
}>;

export type CollectedTargets = Readonly<{
  targets: ActivityTarget[];
  /**
   * False when a filter was applied or any entry's metadata was unreadable;
   * pruning cached records is only safe with a complete list.
   */
  complete: boolean;
}>;

export async function collectActivityTargets(
  config: WorkspaceConfig,
  filters: InventoryFilters = {},
): Promise<CollectedTargets> {
  const inventory = await collectInventory(config, filters);
  const entries: InventoryEntry[] = [
    ...inventory.workspaces,
    ...inventory.repositories,
  ];
  const resolved = await Promise.all(entries.map(activityTargetForEntry));
  const targets = resolved.filter((target) => target !== null);
  return {
    targets,
    complete:
      targets.length === entries.length && !filters.repo && !filters.group,
  };
}

export async function activityTargetForEntry(
  entry: InventoryEntry,
): Promise<ActivityTarget | null> {
  if (entry.type === "worktree") {
    const repoRoot = path.dirname(entry.path);
    const metadata = await readWorktreeMetadata(
      repoRoot,
      entry.changeName,
    ).catch(() => null);
    if (!metadata) return null;
    const taskRoot = path.join(
      repoRoot,
      TASKS_DIRECTORY_NAME,
      entry.changeName,
    );
    const taskSlugs = await childDirectoryNames(taskRoot);
    return {
      identity: identityFor(entry, metadata),
      changeName: entry.changeName,
      description: metadata.workspace.description ?? null,
      checkouts: [
        { label: entry.repository, path: entry.path },
        ...taskSlugs.map((slug) => ({
          label: `${entry.repository}/${slug}`,
          path: path.join(taskRoot, slug),
        })),
      ],
      tasks: taskSlugs.map((slug) => ({
        repo: entry.repository,
        slug,
        branch: null,
        setupStatus: null,
      })),
    };
  }

  const metadata = await readWorkspaceMetadata(entry.path).catch(() => null);
  if (!metadata) return null;
  const tasks = metadata.tasks ?? [];
  return {
    identity: identityFor(entry, metadata),
    changeName: entry.changeName,
    description: metadata.workspace.description ?? null,
    checkouts: [
      ...metadata.repos.map((repo) => ({
        label: repo.name,
        path: path.join(entry.path, repo.name),
      })),
      ...tasks.map((task) => ({
        label: `${task.parent_repo}/${task.slug}`,
        path: path.resolve(entry.path, task.path),
      })),
    ],
    tasks: tasks.map((task) => ({
      repo: task.parent_repo,
      slug: task.slug,
      branch: task.branch,
      setupStatus: task.setup_status,
    })),
  };
}

function identityFor(
  entry: InventoryEntry,
  metadata: WorkspaceMetadata,
): ActivityTargetIdentity {
  const createdAt = metadata.workspace.created_at;
  return {
    key: activityKey(entry.path, createdAt),
    selector: entry.selector,
    type: entry.type,
    path: entry.path,
    createdAt,
  };
}

async function childDirectoryNames(root: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}
