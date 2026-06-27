import { isRepoSlug, reposFromSlugs } from "./config.ts";
import {
  type CachedRepositorySummary,
  listCachedRepositorySummaries,
  resolveRegisteredRepository,
} from "./repositories.ts";
import { listTemplates, loadTemplate } from "./templates/index.ts";
import type { RepoConfig, TemplateConfig } from "./types.ts";

export type ResolvedRepositorySelections = {
  repos: RepoConfig[];
  templateId?: string;
  templateBranchPrefix?: string;
};

export async function qualifyRepositorySpecifiers(
  specifiers: readonly string[],
): Promise<string[]> {
  let repositories: CachedRepositorySummary[] | undefined;
  const qualified: string[] = [];

  for (const specifier of specifiers) {
    const normalized = specifier.trim();
    if (isRepoSlug(normalized)) {
      qualified.push(normalized);
      continue;
    }

    repositories ??= await listCachedRepositorySummaries();
    const registered = await resolveRegisteredRepository(
      normalized,
      repositories,
    );
    if (!registered) {
      throw new Error(
        `Unknown repository "${specifier}". Expected "org/repo", a git URL, or a unique cached repository name.`,
      );
    }
    qualified.push(registered);
  }

  return qualified;
}

export async function resolveRepositorySpecifiers(
  specifiers: readonly string[],
): Promise<RepoConfig[]> {
  return reposFromSlugs(await qualifyRepositorySpecifiers(specifiers));
}

export async function qualifyTemplateRepositories(
  config: TemplateConfig,
): Promise<TemplateConfig> {
  return {
    ...config,
    repos: await qualifyRepositorySpecifiers(config.repos),
  };
}

/**
 * Resolve arguments accepted by change-starting commands. Qualified repository
 * references are used directly. Unqualified values prefer templates, then
 * cached repositories.
 */
export async function resolveRepositoryOrTemplateSpecifiers(
  selections: readonly string[],
): Promise<ResolvedRepositorySelections> {
  const repoSpecifiers: string[] = [];
  let repositories: CachedRepositorySummary[] | undefined;
  let templateId: string | undefined;
  let templateBranchPrefix: string | undefined;

  for (const selection of selections) {
    if (isRepoSlug(selection)) {
      repoSpecifiers.push(selection);
      continue;
    }

    const template = await loadTemplate(selection);
    if (template) {
      templateId = template.id;
      templateBranchPrefix = template.config.branchPrefix;
      repoSpecifiers.push(...template.config.repos);
      continue;
    }

    repositories ??= await listCachedRepositorySummaries();
    const registeredRepo = await resolveRegisteredRepository(
      selection,
      repositories,
    );
    if (registeredRepo) {
      repoSpecifiers.push(registeredRepo);
      continue;
    }

    const templates = await listTemplates();
    const available = templates.map((candidate) => candidate.id).join(", ");
    const suffix = available
      ? `Available templates: ${available}`
      : "No templates configured.";
    throw new Error(`Unknown template or repository "${selection}". ${suffix}`);
  }

  if (repoSpecifiers.length === 0) {
    throw new Error(
      "No repositories specified. Provide template names or org/repo arguments.",
    );
  }

  return {
    repos: await resolveRepositorySpecifiers(repoSpecifiers),
    ...(templateId && { templateId }),
    ...(templateBranchPrefix !== undefined && { templateBranchPrefix }),
  };
}
