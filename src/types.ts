export type RepoConfig = {
  name: string;
  remote: string;
  defaultBranch: string;
};

export type WorkspaceConfig = {
  defaultDir?: string;
  dirPrefix?: string;
  defaultRepos?: string[];
  aliases?: Record<string, string[]>;
};

export type ResolvedWorkspaceConfig = {
  path: string;
  config: WorkspaceConfig;
};

export type TemplateConfig = {
  name: string;
  description?: string;
  repos: string[];
  defaultBranch?: string;
  postInstallHooks?: PostInstallHook[];
};

export type PostInstallHook = {
  name: string;
  command: string;
  args: string[];
  condition?: {
    fileExists?: string[];
  };
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
