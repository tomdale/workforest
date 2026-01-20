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

export type RunCommandOptions = {
  cwd?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};
