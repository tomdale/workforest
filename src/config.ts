import type { RepoConfig } from "./types.ts";

const REPOSITORIES: RepoConfig[] = [
  {
    name: "front",
    remote: "git@github.com:vercel/front.git",
    defaultBranch: "main",
  },
  {
    name: "api",
    remote: "git@github.com:vercel/api.git",
    defaultBranch: "main",
  },
];

export function getRepositories(): readonly RepoConfig[] {
  return REPOSITORIES;
}
