export type RepoConfig = {
  name: string;
  remote: string;
  defaultBranch: string;
};

export type RunCommandOptions = {
  cwd?: string;
  capture?: boolean;
};
