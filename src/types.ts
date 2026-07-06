export type RepositorySource = {
  name: string;
  remote: string;
};

export type VercelRepoOverride = {
  team?: string;
  disabled?: boolean;
};

export type VercelLinkConfig = {
  teamByGitHubOwner?: Record<string, string>;
  repoOverrides?: Record<string, VercelRepoOverride>;
};

export type WorkforestDirectoryConfig = {
  base?: string;
  repos?: string;
  workspaces?: string;
  reviews?: string;
};

export type AiConfig = {
  provider?: string;
  model?: string;
  timeoutMs?: number;
  disabled?: boolean;
};

export type NodeModulesCacheConfig = {
  enabled?: boolean;
  maxRetainedPerRepo?: number;
};

export type CacheConfig = {
  nodeModules?: NodeModulesCacheConfig;
};

/**
 * Provider-specific defaults for Vercel Sandbox provisioning. Nested under
 * `cloud.vercel` so the provider context is explicit and a future provider can
 * add a sibling block (e.g. `cloud.<provider>`). Every field is optional; unset
 * values fall back to the provider defaults resolved in `src/cloud/`.
 */
export type VercelCloudConfig = {
  /**
   * Vercel team slug that owns the sandboxes. Required for cloud commands and
   * passed to the SDK as the team scope (a slug, not a team_… id).
   */
  team?: string;
  /**
   * Vercel project slug to associate sandbox operations with. Required for cloud
   * commands and passed to the SDK as the project scope (a slug, not a prj_… id).
   */
  project?: string;
  /** vCPUs per sandbox (2048 MB memory per vCPU). */
  vcpus?: number;
  /** Sandbox runtime auto-terminate timeout, in milliseconds. */
  timeoutMs?: number;
  /** How long a per-template base snapshot stays fresh before a rebuild. */
  snapshotTtlMs?: number;
  /** Ports exposed at creation so `domain(port)` can resolve preview URLs. */
  ports?: number[];
  /** Sandbox runtime image, e.g. "node24". */
  runtime?: string;
};

/** Cloud provisioning settings, grouped by provider. */
export type CloudConfig = {
  vercel?: VercelCloudConfig;
};

export type SetupConfig = {
  /** Repositories set up concurrently during workspace creation. 0 = unlimited. */
  maxConcurrent?: number;
};

export type WorkspaceConfig = {
  directory?: WorkforestDirectoryConfig;
  branchPrefix?: string;
  cache?: CacheConfig;
  setup?: SetupConfig;
  vercelLink?: VercelLinkConfig;
  ai?: AiConfig;
  cloud?: CloudConfig;
};

export type ResolvedWorkspaceConfig = {
  path: string;
  config: WorkspaceConfig;
};

export type TemplateConfig = {
  repos: string[];
  "AGENTS.md"?: TemplateAgentsMdConfig;
  description?: string;
  hooks?: Hook[];
  /** Undefined inherits the global setting. Empty string disables it for this template. */
  branchPrefix?: string;
  /** Disable automatic initializers. Set to true to disable all, or an array of initializer IDs to disable specific ones. */
  disableInitializers?: boolean | string[];
};

export type TemplateConfigOverride = {
  repos?: string[] | null;
  "AGENTS.md"?: TemplateAgentsMdConfigOverride | null;
  description?: string | null;
  hooks?: Hook[] | null;
  branchPrefix?: string | null;
  disableInitializers?: boolean | string[] | null;
};

export type TemplateAgentsMdConfig = {
  /** The cross-repository workflow and components the generated guidance covers. */
  focus: string;
  /** Repository-relative component hints, keyed by repository name. */
  paths?: Record<string, string[]>;
  /** Guidance lifetime. Defaults to 24 hours. */
  maxAgeHours?: number;
  /** Workspace-root relative generated guidance file. Defaults to AGENTS.md. */
  file?: string;
  /** Workspace-root relative symlink paths pointing to file. Defaults to CLAUDE.md. */
  symlinks?: string[];
};

export type TemplateAgentsMdConfigOverride = {
  focus?: string | null;
  paths?: Record<string, string[] | null> | null;
  maxAgeHours?: number | null;
  file?: string | null;
  symlinks?: string[] | null;
};

export type Hook = {
  name: string;
  run: string;
  in?: string | string[];
  if?: { fileExists?: string };
  continueOnError?: boolean;
  /** Fail the hook command if it runs longer than this. Unlimited when unset. */
  timeoutMs?: number;
};

export type RunCommandOptions = {
  cwd?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  timeout?: number;
};

export type CleanupOptions = {
  keepMirrors?: boolean;
  dryRun?: boolean;
  force?: boolean;
  deleteRemoteBranches?: boolean;
};

/**
 * Metadata stored in .workforest/workspace.json at workspace root.
 * Used for workspace validation, cleanup, and introspection.
 */
export type WorkspaceMetadata = {
  workspace: {
    version: string;
    created_at: string;
    feature_name: string;
    description?: string;
    template_id?: string;
    template_variant?: string;
    type?: "review";
    review?: {
      owner: string;
      repo: string;
    };
  };
  repos: WorkspaceRepoMetadata[];
  tasks?: TaskMetadata[];
  review_worktrees?: ReviewWorktreeMetadata[];
};

export type WorkspaceRepoMetadata = {
  name: string;
  remote: string;
  has_lockfile: boolean;
  feature_branch?: string;
};

export type TaskMetadata = {
  slug: string;
  parent_repo: string;
  path: string;
  branch: string;
  base_branch: string;
  base_sha: string;
  created_at: string;
  setup_status: "ready" | "failed" | "skipped";
  setup_log?: string;
};

export type ReviewWorktreeMetadata = {
  pr_number: number;
  path: string;
  branch?: string;
  created_at: string;
};

/**
 * A cloud workspace's identity, reconstructed from a Vercel Sandbox's tags
 * (the source of truth) rather than persisted locally. One sandbox per change.
 */
export type CloudSandboxMetadata = {
  /** The Vercel Sandbox name, also the workforest change name. */
  name: string;
  changeName: string;
  branchName: string;
  templateId?: string;
  /** Repo names checked out in the sandbox (from the `wf:repos` tag). */
  repos: string[];
  status: string;
  createdAt: string;
};
