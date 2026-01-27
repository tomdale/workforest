export type RepoConfig = {
  name: string;
  remote: string;
  defaultBranch: string;
};

export type WorkspaceConfig = {
  defaultDir?: string;
  dirPrefix?: string;
  branchPrefix?: string;
};

export type ResolvedWorkspaceConfig = {
  path: string;
  config: WorkspaceConfig;
};

export type TemplateConfig = {
  repos: string[];
  description?: string;
  hooks?: Hook[];
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
};

export type CleanupOptions = {
  keepMirrors?: boolean;
  dryRun?: boolean;
  force?: boolean;
};

/**
 * Metadata stored in the .workforest file at workspace root.
 * Used for workspace validation, cleanup, and introspection.
 */
export type WorkspaceMetadata = {
  workspace: {
    version: string;
    created_at: string;
    feature_name: string;
    description?: string;
    template_id?: string;
  };
  repos: WorkspaceRepoMetadata[];
};

export type WorkspaceRepoMetadata = {
  name: string;
  remote: string;
  default_branch: string;
  has_lockfile: boolean;
};
