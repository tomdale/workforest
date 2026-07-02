import { createHash, randomUUID } from "node:crypto";
import { promises as fs, constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type AiModelCategory,
  type AiProgressEvent,
  pathExists,
} from "@wf-plugin/core";
import { getCacheDir } from "../config.ts";
import { resolveMirrorDir } from "../repositories.ts";
import { generateText, getAiStatus } from "../services/ai/index.ts";
import { createDefaultBranchResolver, runGit } from "../services/git.ts";
import type { RepositorySource, TemplateAgentsMdConfig } from "../types.ts";
import { ensureDir } from "../utils/fs.ts";
import { resolveContainedPath } from "../utils/path-safety.ts";
import { ensureMirrorRepoGenerator } from "../workspace/repository.ts";
import type { Template } from "./index.ts";

export const AGENTS_MD_DEFAULT_MAX_AGE_HOURS = 24;
export const AGENTS_MD_MANIFEST_VERSION = 1;
const MANIFEST_FILE = "manifest.json";
const ARTIFACT_DIR = "agents-md";
const TEMPLATE_FILES_DIR = "files";
const STAGED_TEMPLATE_FILES_DIR = ".workforest/template-files";
const MAX_GUIDANCE_LENGTH = 16_000;
const AGENTS_MD_MODEL_CATEGORY: AiModelCategory = "generate-context";
const AGENTS_MD_MIN_AI_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_AGENTS_MD_FILE = "AGENTS.md";
const DEFAULT_AGENTS_MD_SYMLINKS = ["CLAUDE.md"] as const;

export type TemplateAgentsMdState =
  | "disabled"
  | "missing"
  | "fresh"
  | "expired"
  | "scope-changed"
  | "modified"
  | "conflict";

export type AgentsMdManifest = Readonly<{
  version: 1;
  templateId: string;
  artifact: string;
  sha256: string;
  scopeFingerprint: string;
  generatedAt: string;
  expiresAt: string;
  sourceRevisions: Record<string, string>;
  templateFilesFingerprint?: string;
  provider: string;
  model: string | null;
}>;

export type TemplateAgentsMdStatus = Readonly<{
  state: TemplateAgentsMdState;
  templateId: string;
  manifest: AgentsMdManifest | null;
  artifactPath: string | null;
}>;

type PreparedRepository = Readonly<{
  name: string;
  path: string;
  mirror: string;
  revision: string;
  hints: readonly string[];
}>;

type PreparedSources = Readonly<{
  root: string;
  repositories: readonly PreparedRepository[];
  templateRootFiles: readonly PreparedTemplateRootFile[];
}>;

type PreparedTemplateRootFile = Readonly<{
  workspacePath: string;
  stagedPath: string;
  size: number;
  sha256: string;
}>;

type TemplateRootFile = Readonly<{
  workspacePath: string;
  absolutePath: string;
  size: number;
  sha256: string;
}>;

export function agentsMdDirectory(template: Template): string {
  return path.join(path.dirname(template.path), ARTIFACT_DIR);
}

function authoredAgentsMdPaths(template: Template): string[] {
  const file = agentsMdFile(template);
  return [
    ...(template.parentPath
      ? [path.join(path.dirname(template.parentPath), "files", file)]
      : []),
    path.join(path.dirname(template.path), "files", file),
  ];
}

function ownedAuthoredAgentsMdPath(template: Template): string {
  return path.join(
    path.dirname(template.path),
    "files",
    agentsMdFile(template),
  );
}

export function agentsMdScopeFingerprint(template: Template): string {
  return sha256(
    JSON.stringify({
      templateId: template.id,
      repos: [...template.config.repos].sort(),
      config: template.config["AGENTS.md"] ?? null,
    }),
  );
}

export async function getTemplateAgentsMdStatus(
  template: Template,
  now = new Date(),
): Promise<TemplateAgentsMdStatus> {
  if (!template.config["AGENTS.md"]) {
    return status(template, "disabled", null, null);
  }
  if (
    (await Promise.all(authoredAgentsMdPaths(template).map(pathExists))).some(
      Boolean,
    )
  ) {
    return status(template, "conflict", await readManifest(template), null);
  }
  const manifest = await readManifest(template);
  if (!manifest) return status(template, "missing", null, null);
  if (
    manifest.templateId !== template.id ||
    manifest.scopeFingerprint !== agentsMdScopeFingerprint(template)
  ) {
    return status(
      template,
      "scope-changed",
      manifest,
      artifactPath(template, manifest),
    );
  }
  if (
    manifest.templateFilesFingerprint !==
    (await agentsMdTemplateFilesFingerprint(template))
  ) {
    return status(
      template,
      "scope-changed",
      manifest,
      artifactPath(template, manifest),
    );
  }
  const activePath = artifactPath(template, manifest);
  if (!(await pathExists(activePath)))
    return status(template, "missing", manifest, activePath);
  if (sha256(await fs.readFile(activePath)) !== manifest.sha256) {
    return status(template, "modified", manifest, activePath);
  }
  if (now.getTime() >= Date.parse(manifest.expiresAt)) {
    return status(template, "expired", manifest, activePath);
  }
  return status(template, "fresh", manifest, activePath);
}

export async function refreshTemplateAgentsMd(
  template: Template,
  repos: readonly RepositorySource[],
  options: {
    force?: boolean;
    now?: Date;
    onProgress?: (message: string) => void;
    onEvent?: (event: AiProgressEvent) => void;
  } = {},
): Promise<TemplateAgentsMdStatus> {
  const config = template.config["AGENTS.md"];
  if (!config)
    throw new Error(
      `Template "${template.id}" does not enable AGENTS.md generation.`,
    );
  validateConfiguredRepositories(config, repos);
  const ownedAuthoredPath = ownedAuthoredAgentsMdPath(template);
  const inheritedAuthoredPaths = (
    await Promise.all(
      (template.parentPath
        ? [
            path.join(
              path.dirname(template.parentPath),
              "files",
              agentsMdFile(template),
            ),
          ]
        : []
      ).map(async (candidate) =>
        (await pathExists(candidate)) ? candidate : null,
      ),
    )
  ).filter((candidate): candidate is string => candidate !== null);
  const existingOwnedAuthoredPath = (await pathExists(ownedAuthoredPath))
    ? ownedAuthoredPath
    : null;
  const existingAuthoredPaths = [
    ...inheritedAuthoredPaths,
    ...(existingOwnedAuthoredPath ? [existingOwnedAuthoredPath] : []),
  ];
  if (existingAuthoredPaths.length > 0 && !options.force) {
    throw new Error(
      `Template contains files/${agentsMdFile(template)}. Remove it or refresh with --force.`,
    );
  }
  if (inheritedAuthoredPaths.length > 0 && options.force) {
    throw new Error(
      `Template inherits files/${agentsMdFile(template)} from its parent. Remove it from the parent template before refreshing "${template.id}".`,
    );
  }
  options.onProgress?.("Synchronizing clean default-branch sources…");
  const sources = await prepareSources(repos, config, template, (repo) =>
    options.onProgress?.(`Preparing ${repo}…`),
  );
  try {
    const ai = await getAiStatus({
      cwd: sources.root,
      category: AGENTS_MD_MODEL_CATEGORY,
    });
    const provider = ai.selectedProvider ?? "configured AI provider";
    const timeoutMs = Math.max(ai.timeoutMs, AGENTS_MD_MIN_AI_TIMEOUT_MS);
    options.onProgress?.(
      `Generating focused guidance with ${provider} (${ai.model ?? AGENTS_MD_MODEL_CATEGORY})…`,
    );
    const markdown = validateGeneratedMarkdown(
      await generateText({
        cwd: sources.root,
        category: AGENTS_MD_MODEL_CATEGORY,
        timeoutMs,
        prompt: generationPrompt(template, config, sources),
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      }),
    );

    if (options.force) {
      if (existingOwnedAuthoredPath) {
        await backupFile(existingOwnedAuthoredPath);
        await fs.rm(existingOwnedAuthoredPath);
      }
    }
    options.onProgress?.("Publishing guidance…");

    const now = options.now ?? new Date();
    const generatedAt = now.toISOString();
    const maxAgeHours = config.maxAgeHours ?? AGENTS_MD_DEFAULT_MAX_AGE_HOURS;
    const expiresAt = new Date(
      now.getTime() + maxAgeHours * 3_600_000,
    ).toISOString();
    const document = renderManagedDocument(markdown, generatedAt, expiresAt);
    const directory = agentsMdDirectory(template);
    await ensureDir(directory);
    const artifact = await nextArtifactName(directory, now);
    const target = resolveContainedPath(directory, artifact);
    await fs.writeFile(target, document, { encoding: "utf8", flag: "wx" });

    const manifest: AgentsMdManifest = {
      version: AGENTS_MD_MANIFEST_VERSION,
      templateId: template.id,
      artifact,
      sha256: sha256(document),
      scopeFingerprint: agentsMdScopeFingerprint(template),
      generatedAt,
      expiresAt,
      sourceRevisions: Object.fromEntries(
        sources.repositories.map((repo) => [repo.name, repo.revision]),
      ),
      templateFilesFingerprint: templateRootFilesFingerprint(
        sources.templateRootFiles,
      ),
      provider: ai.selectedProvider ?? "unknown",
      model: ai.model ?? null,
    };
    try {
      await atomicWriteJson(path.join(directory, MANIFEST_FILE), manifest);
    } catch (error) {
      await fs.rm(target, { force: true });
      throw error;
    }
    await removeSupersededArtifacts(directory, artifact);
    return status(template, "fresh", manifest, target);
  } finally {
    await cleanupSources(sources);
  }
}

export async function materializeTemplateAgentsMd(
  template: Template,
  workspaceDir: string,
  options: { force?: boolean; now?: Date } = {},
): Promise<TemplateAgentsMdStatus> {
  const current = await getTemplateAgentsMdStatus(template, options.now);
  const target = workspaceAgentsMdFilePath(template, workspaceDir);
  const provenancePath = path.join(
    workspaceDir,
    ".workforest",
    "agents-md.json",
  );
  if (current.state === "disabled") return current;
  if (current.state !== "fresh" || !current.artifactPath || !current.manifest) {
    const contents = unavailableDocument(template.id, current.state);
    await replaceManagedFile(
      target,
      contents,
      provenancePath,
      options.force ?? false,
    );
    await updateWorkspaceAgentsMdSymlinks(template, workspaceDir, {
      force: options.force ?? false,
    });
    await atomicWriteJson(provenancePath, {
      version: 1,
      templateId: template.id,
      sha256: sha256(contents),
      scopeFingerprint: agentsMdScopeFingerprint(template),
      state: current.state,
    });
    return current;
  }
  const contents = await fs.readFile(current.artifactPath, "utf8");
  await replaceManagedFile(
    target,
    contents,
    provenancePath,
    options.force ?? false,
  );
  await updateWorkspaceAgentsMdSymlinks(template, workspaceDir, {
    force: options.force ?? false,
  });
  await atomicWriteJson(provenancePath, {
    version: 1,
    templateId: template.id,
    artifact: current.manifest.artifact,
    sha256: sha256(contents),
    generatedAt: current.manifest.generatedAt,
    expiresAt: current.manifest.expiresAt,
    scopeFingerprint: current.manifest.scopeFingerprint,
  });
  return current;
}

export async function refreshAndMaterializeTemplateAgentsMd(
  template: Template,
  workspaceDir: string,
  repos: readonly RepositorySource[],
  options: {
    force?: boolean;
    now?: Date;
    onProgress?: (message: string) => void;
    onWarning?: (message: string) => void;
    onEvent?: (event: AiProgressEvent) => void;
  } = {},
): Promise<TemplateAgentsMdStatus> {
  const current = await getTemplateAgentsMdStatus(template, options.now);
  if (current.state === "disabled") return current;

  if (shouldRefreshForWorkspace(current.state)) {
    options.onProgress?.(
      `AGENTS.md guidance is ${current.state}; refreshing automatically…`,
    );
    try {
      await refreshTemplateAgentsMd(template, repos, {
        ...(options.force !== undefined ? { force: options.force } : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      });
    } catch (error) {
      options.onWarning?.(
        `Could not refresh AGENTS.md guidance: ${formatError(error)}`,
      );
    }
  }

  options.onProgress?.("Materializing AGENTS.md guidance…");
  return materializeTemplateAgentsMd(template, workspaceDir, {
    ...(options.force !== undefined ? { force: options.force } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
}

export async function getWorkspaceAgentsMdStatus(
  template: Template,
  workspaceDir: string,
  now = new Date(),
): Promise<TemplateAgentsMdStatus> {
  const templateStatus = await getTemplateAgentsMdStatus(template, now);
  if (templateStatus.state === "disabled") return templateStatus;
  const target = workspaceAgentsMdFilePath(template, workspaceDir);
  const provenancePath = path.join(
    workspaceDir,
    ".workforest",
    "agents-md.json",
  );
  if (!(await pathExists(target)))
    return status(template, "missing", templateStatus.manifest, null);
  const provenance = (await readJson(provenancePath)) as {
    sha256?: unknown;
    scopeFingerprint?: unknown;
  } | null;
  if (!provenance || typeof provenance.sha256 !== "string")
    return status(template, "conflict", templateStatus.manifest, target);
  if (sha256(await fs.readFile(target)) !== provenance.sha256)
    return status(template, "modified", templateStatus.manifest, target);
  const symlinks = await getWorkspaceAgentsMdSymlinkState(
    template,
    workspaceDir,
  );
  if (symlinks === "missing")
    return status(template, "missing", templateStatus.manifest, null);
  if (symlinks === "conflict")
    return status(template, "conflict", templateStatus.manifest, target);
  if (provenance.scopeFingerprint !== agentsMdScopeFingerprint(template))
    return status(template, "scope-changed", templateStatus.manifest, target);
  return { ...templateStatus, artifactPath: target };
}

export async function maintainWorkspaceAgentsMd(
  template: Template,
  workspaceDir: string,
  now = new Date(),
): Promise<TemplateAgentsMdStatus> {
  const workspaceStatus = await getWorkspaceAgentsMdStatus(
    template,
    workspaceDir,
    now,
  );
  if (["expired", "scope-changed", "missing"].includes(workspaceStatus.state)) {
    await materializeTemplateAgentsMd(template, workspaceDir, { now });
    return getWorkspaceAgentsMdStatus(template, workspaceDir, now);
  }
  return workspaceStatus;
}

export async function invalidateWorkspaceAgentsMd(
  template: Template,
  workspaceDir: string,
): Promise<void> {
  if (!template.config["AGENTS.md"]) return;
  const target = workspaceAgentsMdFilePath(template, workspaceDir);
  const provenancePath = path.join(
    workspaceDir,
    ".workforest",
    "agents-md.json",
  );
  const contents = unavailableDocument(template.id, "scope-changed");
  await replaceManagedFile(target, contents, provenancePath, false);
  await updateWorkspaceAgentsMdSymlinks(template, workspaceDir, {
    force: false,
  });
  await atomicWriteJson(provenancePath, {
    version: 1,
    templateId: template.id,
    sha256: sha256(contents),
    scopeFingerprint: "workspace-repository-set-changed",
  });
}

export async function agentsMdTemplateFilesFingerprint(
  template: Template,
): Promise<string> {
  const files = await collectTemplateRootFiles(template);
  return templateRootFilesFingerprint(files);
}

function shouldRefreshForWorkspace(state: TemplateAgentsMdState): boolean {
  return ["missing", "expired", "scope-changed", "modified"].includes(state);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function replaceManagedFile(
  target: string,
  contents: string,
  provenancePath: string,
  force: boolean,
): Promise<void> {
  if (await pathExists(target)) {
    const provenance = (await readJson(provenancePath)) as {
      sha256?: unknown;
    } | null;
    const existing = await fs.readFile(target);
    const managedUnmodified =
      typeof provenance?.sha256 === "string" &&
      sha256(existing) === provenance.sha256;
    if (!managedUnmodified && !force)
      throw new Error(
        `Refusing to replace existing or modified ${target}. Use --force.`,
      );
    if (!managedUnmodified && force) await backupFile(target);
  }
  await ensureDir(path.dirname(target));
  await fs.writeFile(target, contents, "utf8");
}

type WorkspaceAgentsMdSymlinkState = "fresh" | "missing" | "conflict";

async function getWorkspaceAgentsMdSymlinkState(
  template: Template,
  workspaceDir: string,
): Promise<WorkspaceAgentsMdSymlinkState> {
  const file = workspaceAgentsMdFilePath(template, workspaceDir);
  for (const symlink of agentsMdSymlinks(template)) {
    const target = resolveContainedPath(workspaceDir, symlink);
    try {
      const stat = await fs.lstat(target);
      if (!stat.isSymbolicLink()) return "conflict";
      const expected = relativeSymlinkTarget(path.dirname(target), file);
      if ((await fs.readlink(target)) !== expected) return "conflict";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
  }
  return "fresh";
}

async function updateWorkspaceAgentsMdSymlinks(
  template: Template,
  workspaceDir: string,
  options: { force: boolean },
): Promise<void> {
  const file = workspaceAgentsMdFilePath(template, workspaceDir);
  for (const symlink of agentsMdSymlinks(template)) {
    const target = resolveContainedPath(workspaceDir, symlink);
    await updateWorkspaceAgentsMdSymlink(
      target,
      relativeSymlinkTarget(path.dirname(target), file),
      options,
    );
  }
}

async function updateWorkspaceAgentsMdSymlink(
  target: string,
  linkTarget: string,
  options: { force: boolean },
): Promise<void> {
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() && (await fs.readlink(target)) === linkTarget) {
      return;
    }

    if (!options.force) {
      throw new Error(`Refusing to replace existing ${target}. Use --force.`);
    }
    if (stat.isDirectory()) {
      throw new Error(`Refusing to replace directory ${target}.`);
    }
    if (stat.isSymbolicLink()) {
      await fs.rename(target, backupPath(target));
    } else {
      await backupFile(target);
      await fs.rm(target);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await ensureDir(path.dirname(target));
  await fs.symlink(linkTarget, target);
}

function workspaceAgentsMdFilePath(
  template: Template,
  workspaceDir: string,
): string {
  return resolveContainedPath(workspaceDir, agentsMdFile(template));
}

function agentsMdFile(template: Template): string {
  return template.config["AGENTS.md"]?.file ?? DEFAULT_AGENTS_MD_FILE;
}

function agentsMdSymlinks(template: Template): readonly string[] {
  return template.config["AGENTS.md"]?.symlinks ?? DEFAULT_AGENTS_MD_SYMLINKS;
}

function relativeSymlinkTarget(fromDirectory: string, target: string): string {
  return path.relative(fromDirectory, target).split(path.sep).join("/");
}

async function prepareSources(
  repos: readonly RepositorySource[],
  config: TemplateAgentsMdConfig,
  template: Template,
  onRepository?: (repository: string) => void,
): Promise<PreparedSources> {
  const cacheDir = getCacheDir();
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "workforest-agents-md-"),
  );
  const prepared: PreparedRepository[] = [];
  const defaultBranchResolver = createDefaultBranchResolver();
  try {
    for (const repo of repos) {
      onRepository?.(repo.name);
      const mirror = await resolveMirrorDir(repo, cacheDir);
      for await (const state of ensureMirrorRepoGenerator(repo, mirror)) {
        if (state.status === "failed") throw state.error;
      }
      const ref = await resolveDefaultRef(mirror, defaultBranchResolver);
      const { stdout: revisionOut } = await runGit(["rev-parse", ref], {
        cwd: mirror,
      });
      const target = resolveContainedPath(root, repo.name);
      await runGit(["worktree", "add", "--detach", target, ref], {
        cwd: mirror,
      });
      const hints = config.paths?.[repo.name] ?? [];
      prepared.push({
        name: repo.name,
        path: repo.name,
        mirror,
        revision: revisionOut.trim(),
        hints,
      });
      for (const hint of hints) {
        const hintPath = resolveContainedPath(target, hint);
        if (!(await pathExists(hintPath))) {
          throw new Error(
            `Configured AGENTS.md path does not exist at ${repo.name}/${hint}.`,
          );
        }
      }
    }
    const templateRootFiles = await stageTemplateRootFiles(template, root);
    return { root, repositories: prepared, templateRootFiles };
  } catch (error) {
    await cleanupSources({
      root,
      repositories: prepared,
      templateRootFiles: [],
    });
    throw error;
  }
}

async function stageTemplateRootFiles(
  template: Template,
  sourcesRoot: string,
): Promise<PreparedTemplateRootFile[]> {
  const files = await collectTemplateRootFiles(template);
  if (files.length === 0) return [];

  const stagingRoot = resolveContainedPath(
    sourcesRoot,
    STAGED_TEMPLATE_FILES_DIR,
  );
  const prepared: PreparedTemplateRootFile[] = [];
  for (const file of files) {
    const target = resolveContainedPath(stagingRoot, file.workspacePath);
    await ensureDir(path.dirname(target));
    await fs.copyFile(file.absolutePath, target);
    prepared.push({
      workspacePath: file.workspacePath,
      stagedPath: path.posix.join(
        STAGED_TEMPLATE_FILES_DIR,
        file.workspacePath,
      ),
      size: file.size,
      sha256: file.sha256,
    });
  }
  return prepared;
}

async function collectTemplateRootFiles(
  template: Template,
): Promise<TemplateRootFile[]> {
  const filesRoot = path.join(path.dirname(template.path), TEMPLATE_FILES_DIR);
  if (!(await pathExists(filesRoot))) return [];

  const rootStat = await fs.lstat(filesRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(
      `Template files path must be a real directory: ${filesRoot}`,
    );
  }

  const files: TemplateRootFile[] = [];
  await collectTemplateRootFilesFromDirectory(
    filesRoot,
    "",
    agentsMdFile(template),
    files,
  );
  return files.sort((a, b) => a.workspacePath.localeCompare(b.workspacePath));
}

async function collectTemplateRootFilesFromDirectory(
  directory: string,
  relativeDirectory: string,
  generatedFile: string,
  files: TemplateRootFile[],
): Promise<void> {
  const entries = (await fs.readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  );

  for (const entry of entries) {
    const absolutePath = resolveContainedPath(directory, entry.name);
    const workspacePath = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name;
    if (workspacePath === generatedFile) continue;
    const stat = await fs.lstat(absolutePath);

    if (stat.isSymbolicLink()) {
      throw new Error(
        `Template files must not contain symlinks: ${absolutePath}`,
      );
    }
    if (stat.isDirectory()) {
      await collectTemplateRootFilesFromDirectory(
        absolutePath,
        workspacePath,
        generatedFile,
        files,
      );
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`Unsupported template file type: ${absolutePath}`);
    }

    files.push({
      workspacePath,
      absolutePath,
      size: stat.size,
      sha256: sha256(await fs.readFile(absolutePath)),
    });
  }
}

function templateRootFilesFingerprint(
  files: readonly Pick<TemplateRootFile, "workspacePath" | "size" | "sha256">[],
): string {
  return sha256(
    JSON.stringify(
      files.map((file) => ({
        path: file.workspacePath,
        size: file.size,
        sha256: file.sha256,
      })),
    ),
  );
}

async function cleanupSources(sources: PreparedSources): Promise<void> {
  await Promise.all(
    sources.repositories.map(async (repo) => {
      try {
        await runGit(
          ["worktree", "remove", "--force", path.join(sources.root, repo.path)],
          { cwd: repo.mirror },
        );
      } catch {
        // The temporary root is removed below even if Git already forgot it.
      }
    }),
  );
  await fs.rm(sources.root, { recursive: true, force: true });
}

async function resolveDefaultRef(
  mirror: string,
  defaultBranchResolver = createDefaultBranchResolver(),
): Promise<string> {
  const branch =
    await defaultBranchResolver.resolveBareMirrorDefaultBranch(mirror);
  for (const ref of [
    `refs/remotes/origin/${branch}`,
    `refs/heads/${branch}`,
    branch,
  ]) {
    try {
      await runGit(["rev-parse", "--verify", ref], { cwd: mirror });
      return ref;
    } catch {
      /* try next */
    }
  }
  throw new Error(`Default branch ${branch} was not found in ${mirror}.`);
}

function validateGeneratedMarkdown(markdown: string): string {
  const trimmed = markdown.trim();
  if (!trimmed) throw new Error("Generated guidance is missing.");
  const normalized = extractTaggedMarkdown(trimmed);
  if (!normalized || normalized.length > MAX_GUIDANCE_LENGTH)
    throw new Error("Generated guidance is missing or excessive.");
  if (normalized.startsWith("{") || normalized.startsWith("["))
    throw new Error("Generated guidance must be raw AGENTS.md content.");
  // Fail closed only for output that is unsafe or structurally unusable.
  // Formatting preferences are prompt-steered because the file is read by
  // coding agents, not rendered as human documentation.
  rejectUnsafeContent(normalized);
  return normalized;
}

function extractTaggedMarkdown(value: string): string {
  const matches = [
    ...value.matchAll(/<agents_md>\s*([\s\S]*?)\s*<\/agents_md>/gi),
  ];
  if (matches.length !== 1)
    throw new Error(
      "Generated guidance must include exactly one <agents_md> block.",
    );
  return matches[0]?.[1]?.trim() ?? "";
}

function rejectUnsafeContent(value: string): void {
  if (
    /(?:AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9_]{20,})/.test(
      value,
    )
  )
    throw new Error("Generated guidance appears to contain a secret.");
  if (
    /\b(?:rm\s+-rf|git\s+(?:reset\s+--hard|push\s+--force)|sudo\s+)\b/i.test(
      value,
    )
  )
    throw new Error("Generated guidance contains a destructive command.");
}

function generationPrompt(
  template: Template,
  config: TemplateAgentsMdConfig,
  sources: PreparedSources,
): string {
  const repositories = sources.repositories
    .map(({ name, path: repoPath, hints }) => {
      const hintText =
        hints.length > 0
          ? hints.map((hint) => `\`${repoPath}/${hint}\``).join(", ")
          : "no configured path hints";
      return `- ${name}: checkout directory \`${repoPath}/\`; path hints: ${hintText}`;
    })
    .join("\n");
  const templateRootFiles = formatTemplateRootFiles(sources.templateRootFiles);

  return [
    `You are drafting the compact instruction body for the root AGENTS.md for Workforest template \`${template.id}\`. It will later be copied to workspace roots and read by coding agents before edits.`,
    [
      "Operating context:",
      "A Workforest workspace is a local working directory created from a template, with related repository checkouts side-by-side and a root AGENTS.md above them.",
      "The coding agent reading the generated file may not know Workforest. Assume it starts at the workspace root, then enters repository directories. Orient it to the multi-repository layout and focused workflow before it follows each repository's own AGENTS.md and commands.",
    ].join("\n"),
    [
      "Why this file exists:",
      "Without a root guide, coding agents waste context rediscovering repository boundaries, cross-repository seams, commands, and nested instructions. The useful outcome is a compact router that helps the next agent choose the right repository, files, existing AGENTS.md instructions, and verification command for the configured workflow.",
      "Repository and nested AGENTS.md files remain authoritative for local conventions. This template-owned file should add only the cross-repository and workflow-specific context those files do not already provide.",
    ].join("\n"),
    `Configured focus:\n${config.focus}`,
    `Checked-out clean default-branch repositories are available from the current working directory:\n${repositories}`,
    [
      "Template-provided workspace root files:",
      "The template's `files/` directory is staged read-only at `.workforest/template-files/`. These files will be copied to the workspace root; paths under repository names act as overlays on those checkouts. The configured generated guidance file is excluded because Workforest writes it.",
      "Inspect only the staged files relevant to the configured focus, and do not repeat secrets or environment values from `.env`, credential, token, key, or certificate files.",
      templateRootFiles,
    ].join("\n"),
    [
      "Success criteria:",
      "- A coding agent can tell which repository owns each common part of the focused workflow.",
      "- The first files or directories to inspect are named with repo-prefixed paths.",
      "- Cross-repository control flow, data flow, proxying, generated-client boundaries, or shared contracts are summarized only where they affect the configured focus.",
      "- Applicable repo-level and nested AGENTS.md files are listed without duplicating their instructions.",
      "- Template-provided root files that affect setup, environment, routing, or repository overlays are accounted for without dumping their contents.",
      "- Verification commands are included only when found in package scripts or local docs, with the directory they run from.",
    ].join("\n"),
    [
      "Exploration budget and stop rules:",
      "- Treat the configured path hints as entry points, not as the complete source of truth.",
      "- Treat `.workforest/template-files/` as workspace-root context, not as a repository. Use it to understand template-provided scripts, docs, config, or repo overlays that future agents will see.",
      "- Search each repository for applicable AGENTS.md files, then read only the repo-level and nested instruction files that govern the hinted paths.",
      "- Prefer a small number of high-signal reads, roughly 6-12 shell commands across all repositories for normal templates. If that is not enough, choose the missing evidence needed for the success criteria and omit lower-confidence detail.",
      "- Inspect the smallest useful set of implementation paths, nearby tests, package scripts, and local docs that directly affect the configured focus. A useful root guide usually needs representative owner files and seams, not every helper in the call graph.",
      "- Follow cross-repository calls, API routes, generated clients, shared packages, or data contracts only until the handoff is clear enough to route a future task.",
      "- Stop exploring and draft once you can name the owning repo, first files, governing AGENTS.md files, cross-repository handoff, and verification lane for the focused workflow. Do not inspect another file just to make the guide more complete.",
    ].join("\n"),
    [
      "Final response contract:",
      "The final answer must contain exactly one `<agents_md>` block. Workforest always extracts and publishes only the text inside that block. If the block is missing or repeated, refresh fails.",
      'When ready to answer, return the block directly without preamble. Do not start the final response with phrases like "Here is", "Based on", "I have enough", or "Now I".',
      "The content inside the block is for another LLM, not for rendered documentation. Write compact plain agent guidance.",
      "Do not create, edit, or request permission to write files. The checked-out repositories are read-only evidence for this drafting run. Workforest will write the artifact after your final answer.",
      "Do not return JSON, YAML frontmatter, code fences, citations metadata, analysis notes, or generation/expiry metadata.",
    ].join("\n"),
    [
      "Required content:",
      `- Identify this as guidance for template \`${template.id}\` without using a Markdown heading.`,
      "- Keep it compact enough to be useful at the start of an agent session; optimize for fast routing, not broad education.",
      "- Cover scope, in-scope paths, template-provided root context, cross-repository flow, task routing hints, reusable exploration recipes, verified commands, and existing AGENTS.md instructions.",
      "- Use repo-prefixed paths like `front/path/to/file.ts` so agents can jump directly to the right files.",
    ].join("\n"),
    [
      "Output style for an LLM reader:",
      "- Markdown is visual chrome. Do not use Markdown headings, tables, fenced code blocks, decorative file trees, bold, italics, horizontal rules, or blank lines used only for visual spacing.",
      "- Prefer dense labeled lines, short paragraphs, comma-separated inline lists, and colon-delimited key-value lines. Factor repeated path prefixes once, then list relative files.",
      "- Write commands as single lines like `front/: pnpm type-check -F vercel-site`, not fenced shell blocks.",
      "- Every token must route future agents faster; omit visual formatting that only helps human scanning.",
    ].join("\n"),
    [
      "Final response example:",
      "<agents_md>",
      `Template: ${template.id}. Purpose: route agents through the configured workflow without duplicating repository AGENTS.md files.`,
      "Scope: Start in `repo/path` for the primary owner; follow `other-repo/path` for the cross-repository handoff.",
      "Commands: `repo/: pnpm test`; `other-repo/: pnpm typecheck`.",
      "</agents_md>",
    ].join("\n"),
    [
      "Quality bar:",
      "- Answer the startup questions: which repository owns the work, which files should be inspected first, which existing instructions apply, and which command verifies the change.",
      "- Be specific about how the focused workflow is wired together.",
      "- Prefer concrete modules, route files, scripts, and tests over broad repository summaries.",
      "- Account for template files that will exist at the workspace root or overlay repositories; mention only the files that materially affect this focused workflow.",
      "- Do not duplicate instructions already covered by repository or nested AGENTS.md files; list the applicable AGENTS.md paths and add only the template-specific context agents need on top.",
      "- Do not inline exhaustive research notes, architecture walkthroughs, API inventories, or incident histories. If deeper context is useful, point to existing source files, docs, or AGENTS.md files and summarize only the route to them.",
      "- Memoize repeated exploration patterns as short recipes: the search terms, source paths, and package scripts an agent should try first.",
      "- Include only statements supported by files you actually inspected.",
      "- Include only commands you found in package scripts or local docs, and state the repository directory they should run from.",
      "- Omit unrelated components, generic coding advice, and speculative behavior.",
      "- If a detail cannot be verified from the checked-out files, leave it out.",
    ].join("\n"),
    [
      "Safety:",
      "- Do not include secrets or environment values.",
      "- Do not recommend destructive commands such as force pushes, hard resets, recursive deletes, or sudo.",
    ].join("\n"),
  ].join("\n\n");
}

function formatTemplateRootFiles(
  files: readonly PreparedTemplateRootFile[],
): string {
  if (files.length === 0) return "- none";
  return files
    .map(
      (file) =>
        `- workspace \`${file.workspacePath}\`: staged at \`${file.stagedPath}\` (${file.size} bytes)`,
    )
    .join("\n");
}

function renderManagedDocument(
  markdown: string,
  generatedAt: string,
  expiresAt: string,
): string {
  return `<!-- Managed by Workforest. Generated ${generatedAt}; expires ${expiresAt}. Disregard this document after expiration. -->\n\n${markdown.trim()}\n`;
}

function unavailableDocument(
  templateId: string,
  state: TemplateAgentsMdState,
): string {
  return `# Workspace guidance unavailable\n\nFocused guidance for template \`${templateId}\` is ${state}. Do not infer repository behavior from stale guidance.\n\nRun \`wf template agents-md refresh ${templateId}\` to regenerate it.\n`;
}

async function readManifest(
  template: Template,
): Promise<AgentsMdManifest | null> {
  const value = await readJson(
    path.join(agentsMdDirectory(template), MANIFEST_FILE),
  );
  if (
    !value ||
    typeof value !== "object" ||
    (value as { version?: unknown }).version !== AGENTS_MD_MANIFEST_VERSION
  )
    return null;
  return value as AgentsMdManifest;
}

async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, file);
}

async function backupFile(file: string): Promise<void> {
  await fs.copyFile(file, backupPath(file), fsConstants.COPYFILE_EXCL);
}

function backupPath(file: string): string {
  return `${file}.backup-${portableTimestamp(new Date())}`;
}

async function removeSupersededArtifacts(
  directory: string,
  active: string,
): Promise<void> {
  const entries = await fs.readdir(directory);
  await Promise.all(
    entries
      .filter(
        (entry) => /^AGENTS-\d{8}T\d{6}Z\.md$/.test(entry) && entry !== active,
      )
      .map((entry) => fs.rm(path.join(directory, entry), { force: true })),
  );
}

function artifactPath(template: Template, manifest: AgentsMdManifest): string {
  return resolveContainedPath(agentsMdDirectory(template), manifest.artifact);
}

function status(
  template: Template,
  state: TemplateAgentsMdState,
  manifest: AgentsMdManifest | null,
  artifact: string | null,
): TemplateAgentsMdStatus {
  return { state, templateId: template.id, manifest, artifactPath: artifact };
}

function validateConfiguredRepositories(
  config: TemplateAgentsMdConfig,
  repos: readonly RepositorySource[],
): void {
  const names = new Set(repos.map((repo) => repo.name));
  for (const repo of Object.keys(config.paths ?? {}))
    if (!names.has(repo))
      throw new Error(
        `AGENTS.md paths references unknown repository "${repo}".`,
      );
}

function portableTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}
async function nextArtifactName(directory: string, now: Date): Promise<string> {
  for (let offset = 0; offset < 60; offset += 1) {
    const artifact = `AGENTS-${portableTimestamp(
      new Date(now.getTime() + offset * 1000),
    )}.md`;
    if (!(await pathExists(path.join(directory, artifact)))) return artifact;
  }
  throw new Error("Could not allocate a unique AGENTS.md artifact timestamp.");
}
function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
