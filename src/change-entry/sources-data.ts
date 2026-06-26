import path from "node:path";
import { loadWorkspaceConfig } from "../config.ts";
import { listCachedRepositories } from "../repositories.ts";
import { resolveRepositorySpecifiers } from "../repository-specifiers.ts";
import { listTemplates, loadTemplate } from "../templates/index.ts";
import {
  buildBranchName,
  resolveBranchPrefix,
} from "../utils/branch-prefix.ts";
import { validateResourceName } from "../utils/path-safety.ts";
import {
  ADHOC_WORKSPACE_GROUP,
  getRepositoryChangePath,
  getWorkspaceChangePath,
  resolveWorkforestDirectories,
} from "../workspace/paths.ts";

/**
 * A selectable source for a new change: a cached repository or a saved
 * template. Render-ready for the Phase 2 source picker.
 */
export type SourceCandidate = {
  kind: "repo" | "template";
  id: string;
  label: string;
  hint: string;
};

/**
 * A source the user has chosen. Repos carry a free-entry `token` (a cached
 * name, an org/repo slug, or a full git URL); templates carry a template name.
 */
export type ChosenSource =
  | { kind: "repo"; token: string }
  | { kind: "template"; name: string };

/**
 * The inferred shape of the change the user is about to create, derived from
 * the chosen sources using the same rules as `wf start`.
 */
export type InferredChange = {
  type: "repository" | "template" | "adhoc";
  relativePath: string;
  branch: string;
  repoPreview: string[];
};

export type InferChangeOptions = {
  changeName: string;
  sources: ChosenSource[];
};

/**
 * List every cached repository and saved template as a selectable source.
 * Repositories that are not valid bare mirrors are omitted.
 */
export async function listSourceCandidates(): Promise<SourceCandidate[]> {
  const [repositories, templates] = await Promise.all([
    listCachedRepositories(),
    listTemplates(),
  ]);

  const repoCandidates: SourceCandidate[] = repositories
    .filter((repository) => repository.health !== "invalid")
    .map((repository) => {
      const id = repository.slug ?? repository.name;
      return {
        kind: "repo",
        id,
        label: id,
        hint: "Cached repository",
      };
    });

  const templateCandidates: SourceCandidate[] = templates.map((template) => {
    const description = template.config.description?.trim();
    const repoCount = template.config.repos.length;
    return {
      kind: "template",
      id: template.id,
      label: template.id,
      hint:
        description && description.length > 0
          ? description
          : `Template · ${repoCount} repo${repoCount === 1 ? "" : "s"}`,
    };
  });

  return [...repoCandidates, ...templateCandidates];
}

/**
 * Case-insensitive subsequence filter over each source's label and id, stable
 * in input order.
 */
export function filterSourceCandidates(
  candidates: SourceCandidate[],
  query: string,
): SourceCandidate[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return [...candidates];
  }

  return candidates.filter((candidate) =>
    matchesSubsequence(`${candidate.label} ${candidate.id}`, trimmed),
  );
}

/**
 * Infer the target change layout, path, branch, and repo set from the chosen
 * sources, mirroring `wf start`:
 * - exactly one template -> template workspace
 * - exactly one repo      -> repository change
 * - two or more repos     -> ad-hoc workspace
 *
 * Throws if a template is combined with any other source, or if no usable
 * sources are provided.
 */
export async function inferChange(
  options: InferChangeOptions,
): Promise<InferredChange> {
  const changeName = validateResourceName(options.changeName, "Change name");
  const templates = options.sources.filter(
    (source): source is Extract<ChosenSource, { kind: "template" }> =>
      source.kind === "template",
  );
  const repoTokens = options.sources
    .filter(
      (source): source is Extract<ChosenSource, { kind: "repo" }> =>
        source.kind === "repo",
    )
    .map((source) => source.token);

  if (templates.length > 0 && options.sources.length !== 1) {
    throw new Error(
      "Template sources cannot be combined with repository sources.",
    );
  }

  const { config } = await loadWorkspaceConfig();
  const directories = resolveWorkforestDirectories(config);

  const template = templates[0];
  if (template) {
    const loaded = await loadTemplate(template.name);
    if (!loaded) {
      throw new Error(`Unknown template: @${template.name}`);
    }
    const repos = await resolveRepositorySpecifiers(loaded.config.repos);
    const branch = buildBranchName(
      changeName,
      resolveBranchPrefix(config.branchPrefix, loaded.config.branchPrefix),
    );
    const absolute = getWorkspaceChangePath(directories, loaded.id, changeName);
    return {
      type: "template",
      relativePath: path.relative(directories.base, absolute),
      branch,
      repoPreview: repos.map((repo) => repo.name),
    };
  }

  const repos = await resolveRepositorySpecifiers(repoTokens);
  if (repos.length === 0) {
    throw new Error("No repositories specified.");
  }

  const branch = buildBranchName(changeName, config.branchPrefix);

  if (repos.length === 1) {
    const repo = repos[0];
    if (!repo) {
      throw new Error("No repositories specified.");
    }
    const absolute = getRepositoryChangePath(
      directories,
      repo.name,
      changeName,
    );
    return {
      type: "repository",
      relativePath: path.relative(directories.base, absolute),
      branch,
      repoPreview: [repo.name],
    };
  }

  const absolute = getWorkspaceChangePath(
    directories,
    ADHOC_WORKSPACE_GROUP,
    changeName,
  );
  return {
    type: "adhoc",
    relativePath: path.relative(directories.base, absolute),
    branch,
    repoPreview: repos.map((repo) => repo.name),
  };
}

function matchesSubsequence(haystack: string, query: string): boolean {
  const target = haystack.toLowerCase();
  const needle = query.toLowerCase();
  let index = 0;
  for (const character of target) {
    if (character === needle[index]) {
      index += 1;
      if (index === needle.length) {
        return true;
      }
    }
  }
  return index === needle.length;
}
