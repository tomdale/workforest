export type RepoConfig = {
  name: string;
  remote: string;
  defaultBranch: string;
};

export type VercelRepoOverride = {
  team?: string;
  disabled?: boolean;
};

export type VercelLinkConfig = {
  teamByGitHubOwner?: Record<string, string>;
  repoOverrides?: Record<string, VercelRepoOverride>;
};

export type WorkspaceConfig = {
  defaultDir?: string;
  reviewsDir?: string;
  dirPrefix?: string;
  branchPrefix?: string;
  vercelLink?: VercelLinkConfig;
};

export type ResolvedWorkspaceConfig = {
  path: string;
  config: WorkspaceConfig;
};

export type TemplateConfig = {
  repos: string[];
  description?: string;
  hooks?: Hook[];
  /** Undefined inherits the global setting. Empty string disables it for this template. */
  branchPrefix?: string;
  /** Disable automatic initializers. Set to true to disable all, or an array of initializer IDs to disable specific ones. */
  disableInitializers?: boolean | string[];
};

export type Hook = {
  name: string;
  run: string;
  in?: string | string[];
  if?: { fileExists?: string };
  continueOnError?: boolean;
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
  default_branch: string;
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
  setup_status: "ready" | "failed";
  setup_log?: string;
};

export type ReviewWorktreeMetadata = {
  pr_number: number;
  path: string;
  branch?: string;
  created_at: string;
};
