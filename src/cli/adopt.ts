import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists } from "@wf-plugin/core";
import { getCacheDir, loadWorkspaceConfig } from "../config.ts";
import { normalizeRemote, resolveMirrorDir } from "../repositories.ts";
import { validateRepositoryComponent } from "../repository-components.ts";
import { runGit, runGitWithStdin } from "../services/git.ts";
import { withGitWorktreeLock } from "../services/worktree.ts";
import { reportShellCdTarget } from "../shell.ts";
import { kindToTone, statusLine } from "../terminal/status-indicator.ts";
import type { RepositorySource } from "../types.ts";
import { compactHome } from "../utils/display-path.ts";
import { comparablePath, validateResourceName } from "../utils/path-safety.ts";
import { writeWorktreeMetadata } from "../workspace/metadata.ts";
import {
  getWorktreePath,
  resolveWorkforestDirectories,
} from "../workspace/paths.ts";
import { OperationalError } from "./errors.ts";
import { humanOutput, jsonSuccess, success } from "./output.ts";
import type { CommandResult, ParsedInvocation } from "./types.ts";

export type AdoptResult = Readonly<{
  selector: string;
  repository: string;
  changeName: string;
  sourcePath: string;
  targetPath: string;
  remote: string;
  branch: string;
  mirrorPath: string;
}>;

type AdoptOptions = Readonly<{
  writeShellCdPath: (targetDir: string) => Promise<void>;
}>;

const WORKFOREST_FETCH_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";

export async function runAdoptCommand(
  invocation: ParsedInvocation,
  options: AdoptOptions,
): Promise<CommandResult> {
  const pathArg = invocation.beforeDoubleDash[0];
  const nameOverride =
    typeof invocation.flags["name"] === "string"
      ? invocation.flags["name"]
      : undefined;
  const result = await adoptCheckout({
    ...(pathArg ? { pathArg } : {}),
    ...(nameOverride ? { nameOverride } : {}),
  });

  if (invocation.flags["json"] === true) {
    return jsonSuccess(result);
  }

  await reportShellCdTarget(result.targetPath, {
    writeShellCdPath: options.writeShellCdPath,
  });
  return success(
    humanOutput(
      statusLine(
        kindToTone("success"),
        `Adopted ${result.selector}: ${compactHome(result.targetPath)}`,
      ),
    ),
  );
}

async function adoptCheckout(input: {
  pathArg?: string;
  nameOverride?: string;
}): Promise<AdoptResult> {
  const sourcePath = await resolveCheckoutTopLevel(input.pathArg ?? ".");
  const [remote, branch] = await Promise.all([
    readRequiredOrigin(sourcePath),
    readCurrentBranch(sourcePath),
  ]);
  await assertCleanCheckout(sourcePath);

  const { config } = await loadWorkspaceConfig();
  const directories = resolveWorkforestDirectories(config);
  await assertNotManaged(sourcePath, directories);

  const repository = deriveRepositoryName(remote);
  const changeName = validateResourceName(
    input.nameOverride ?? defaultChangeName(branch),
    "Name",
  );
  const repo: RepositorySource = { name: repository, remote };
  const mirrorPath = await prepareMirrorFromCheckout(sourcePath, repo);
  const targetPath = getWorktreePath(directories, repository, changeName);

  if (await pathExists(targetPath)) {
    throw new OperationalError(`Destination already exists: ${targetPath}`);
  }

  const repoRootDir = path.dirname(targetPath);
  await fs.mkdir(repoRootDir, { recursive: true });

  await convertCheckoutToLinkedWorktree({
    sourcePath,
    targetPath,
    mirrorPath,
    branch,
  });

  await writeWorktreeMetadata(repoRootDir, {
    featureName: changeName,
    branchName: branch,
    repos: [{ ...repo, hasLockfile: await hasLockfile(targetPath) }],
  });

  return {
    selector: `${repository}/${changeName}`,
    repository,
    changeName,
    sourcePath,
    targetPath,
    remote,
    branch,
    mirrorPath,
  };
}

async function resolveCheckoutTopLevel(inputPath: string): Promise<string> {
  const cwd = path.resolve(inputPath);
  try {
    const { stdout } = await runGit(["rev-parse", "--show-toplevel"], { cwd });
    return path.resolve(stdout.trim());
  } catch {
    throw new OperationalError(`Not a Git checkout: ${cwd}`);
  }
}

async function readRequiredOrigin(sourcePath: string): Promise<string> {
  try {
    const { stdout } = await runGit(["remote", "get-url", "origin"], {
      cwd: sourcePath,
    });
    const remote = stdout.trim();
    if (remote) return remote;
  } catch {
    // Normalize the user-facing failure below.
  }
  throw new OperationalError(`Checkout has no origin remote: ${sourcePath}`);
}

async function readCurrentBranch(sourcePath: string): Promise<string> {
  try {
    const { stdout } = await runGit(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      {
        cwd: sourcePath,
      },
    );
    const branch = stdout.trim();
    if (branch) return branch;
  } catch {
    // Normalize the user-facing failure below.
  }
  throw new OperationalError(`Checkout is in detached HEAD: ${sourcePath}`);
}

async function assertCleanCheckout(sourcePath: string): Promise<void> {
  const { stdout } = await runGit(
    ["status", "--porcelain", "--untracked-files=all"],
    { cwd: sourcePath },
  );
  if (stdout.trim()) {
    throw new OperationalError(
      `Checkout has tracked or untracked changes: ${sourcePath}`,
    );
  }
}

async function assertNotManaged(
  sourcePath: string,
  directories: ReturnType<typeof resolveWorkforestDirectories>,
): Promise<void> {
  const resolved = await comparablePath(sourcePath);
  for (const managedRoot of [
    directories.repos,
    directories.workspaces,
    directories.reviews,
  ]) {
    if (isPathInsideOrEqual(await comparablePath(managedRoot), resolved)) {
      throw new OperationalError(
        `Checkout is already inside Workforest-managed directories: ${sourcePath}`,
      );
    }
  }
}

function isPathInsideOrEqual(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function defaultChangeName(branch: string): string {
  return branch.split("/").filter(Boolean).at(-1) ?? branch;
}

function deriveRepositoryName(remote: string): string {
  const withoutTrailingSlash = remote.trim().replace(/[\\/]+$/, "");
  const last = withoutTrailingSlash
    .replace(/\.git$/i, "")
    .split(/[/:\\]/)
    .at(-1);
  if (!last) {
    throw new OperationalError(
      `Unable to derive repository name from ${remote}`,
    );
  }
  try {
    return validateRepositoryComponent(
      decodeURIComponent(last),
      "Repository name",
    );
  } catch (error) {
    throw new OperationalError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function prepareMirrorFromCheckout(
  sourcePath: string,
  repo: RepositorySource,
): Promise<string> {
  const cacheDir = getCacheDir();
  await fs.mkdir(cacheDir, { recursive: true });
  const mirrorPath = await resolveMirrorDir(repo, cacheDir);

  if (!(await pathExists(mirrorPath))) {
    await fs.mkdir(mirrorPath, { recursive: true });
    await runGit(["init", "--bare", "--quiet"], { cwd: mirrorPath });
    await runGit(["remote", "add", "origin", repo.remote], { cwd: mirrorPath });
    await configureMirrorFetch(mirrorPath);
  } else {
    await verifyMirrorRemote(mirrorPath, repo.remote);
    await configureMirrorFetch(mirrorPath);
  }

  await importCheckoutRefs(sourcePath, mirrorPath);
  await setMirrorHeadFromCheckout(sourcePath, mirrorPath);
  return mirrorPath;
}

async function configureMirrorFetch(mirrorPath: string): Promise<void> {
  await runGit(["config", "remote.origin.fetch", WORKFOREST_FETCH_REFSPEC], {
    cwd: mirrorPath,
  });
}

async function verifyMirrorRemote(
  mirrorPath: string,
  remote: string,
): Promise<void> {
  let mirrorRemote: string;
  try {
    const { stdout } = await runGit(["remote", "get-url", "origin"], {
      cwd: mirrorPath,
    });
    mirrorRemote = stdout.trim();
  } catch {
    throw new OperationalError(
      `Existing cache mirror has no origin remote: ${mirrorPath}`,
    );
  }
  if (normalizeRemote(mirrorRemote) !== normalizeRemote(remote)) {
    throw new OperationalError(
      `Existing cache mirror remote does not match ${remote}: ${mirrorPath}`,
    );
  }
}

async function importCheckoutRefs(
  sourcePath: string,
  mirrorPath: string,
): Promise<void> {
  const refs = await listSourceRefs(sourcePath);
  const commands: string[] = [];

  for (const ref of refs) {
    const destination = destinationRef(ref.name);
    if (!destination) continue;

    if (destination.startsWith("refs/heads/")) {
      const existing = await readRef(mirrorPath, destination);
      if (existing && existing !== ref.sha) {
        throw new OperationalError(
          `Cached branch ${destination.replace(/^refs\/heads\//, "")} already points at a different commit in ${mirrorPath}.`,
        );
      }
    }

    commands.push(`update ${destination} ${ref.sha}`);
  }

  if (commands.length === 0) return;
  const temporaryRefs = await fetchRefsIntoTemporaryNamespace(
    sourcePath,
    mirrorPath,
    refs,
  );
  try {
    await runGitWithStdin(
      ["update-ref", "--stdin"],
      `${commands.join("\n")}\n`,
      {
        cwd: mirrorPath,
      },
    );
  } finally {
    await deleteTemporaryRefs(mirrorPath, temporaryRefs);
  }
}

async function fetchRefsIntoTemporaryNamespace(
  sourcePath: string,
  mirrorPath: string,
  refs: readonly { name: string; sha: string }[],
): Promise<string[]> {
  const namespace = `refs/workforest-adopt/${randomUUID()}`;
  const temporaryRefs = refs.map(
    (ref) => `${namespace}/${ref.name.replace(/^refs\//, "")}`,
  );
  const refspecs = refs.map(
    (ref, index) => `+${ref.name}:${temporaryRefs[index]}`,
  );
  await runGit(["fetch", "--no-tags", sourcePath, ...refspecs], {
    cwd: mirrorPath,
  });
  return temporaryRefs;
}

async function deleteTemporaryRefs(
  mirrorPath: string,
  refs: readonly string[],
): Promise<void> {
  if (refs.length === 0) return;
  await runGitWithStdin(
    ["update-ref", "--stdin"],
    `${refs.map((ref) => `delete ${ref}`).join("\n")}\n`,
    { cwd: mirrorPath },
  );
}

async function listSourceRefs(
  sourcePath: string,
): Promise<Array<{ name: string; sha: string }>> {
  const { stdout } = await runGit(
    [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)",
      "refs/heads",
      "refs/tags",
      "refs/remotes",
      "refs/stash",
    ],
    { cwd: sourcePath },
  );
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, sha] = line.split("\0");
      if (!name || !sha) {
        throw new OperationalError(`Unable to parse Git ref: ${line}`);
      }
      return { name, sha };
    });
}

function destinationRef(ref: string): string | null {
  if (ref.startsWith("refs/heads/")) return ref;
  if (ref.startsWith("refs/tags/")) return ref;
  if (ref === "refs/stash") return ref;
  if (ref.startsWith("refs/remotes/origin/")) return ref;
  return null;
}

async function readRef(cwd: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(["rev-parse", "--verify", ref], { cwd });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function setMirrorHeadFromCheckout(
  sourcePath: string,
  mirrorPath: string,
): Promise<void> {
  try {
    const { stdout } = await runGit(
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      { cwd: sourcePath },
    );
    const branch = stdout.trim().replace(/^origin\//, "");
    if (branch) {
      await runGit(["symbolic-ref", "HEAD", `refs/heads/${branch}`], {
        cwd: mirrorPath,
      });
    }
  } catch {
    // A checkout without origin/HEAD is still adoptable; the current branch is
    // imported and explicitly used for the linked worktree.
  }
}

async function convertCheckoutToLinkedWorktree(input: {
  sourcePath: string;
  targetPath: string;
  mirrorPath: string;
  branch: string;
}): Promise<void> {
  const { sourcePath, targetPath, mirrorPath, branch } = input;
  const temporaryPath = `${sourcePath}.workforest-adopt-${process.pid}`;
  await fs.rename(sourcePath, temporaryPath).catch((error) => {
    throw new OperationalError(
      `Unable to move checkout aside for adoption: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  let complete = false;
  try {
    await withGitWorktreeLock(mirrorPath, () =>
      runGit(["worktree", "add", "--no-checkout", targetPath, branch], {
        cwd: mirrorPath,
      }),
    );
    await moveCheckoutContents(temporaryPath, targetPath);
    await runGit(["reset", "--mixed", "--quiet", "HEAD"], { cwd: targetPath });
    await assertCleanCheckout(targetPath);
    await fs.rm(path.join(temporaryPath, ".git"), {
      recursive: true,
      force: true,
    });
    await fs.rmdir(temporaryPath);
    complete = true;
  } finally {
    if (!complete) {
      await fs.rm(targetPath, { recursive: true, force: true }).catch(() => {});
      await fs.rename(temporaryPath, sourcePath).catch(() => {});
    }
  }
}

async function moveCheckoutContents(
  fromPath: string,
  toPath: string,
): Promise<void> {
  const entries = await fs.readdir(fromPath);
  for (const entry of entries) {
    if (entry === ".git") continue;
    await fs
      .rename(path.join(fromPath, entry), path.join(toPath, entry))
      .catch((error) => {
        throw new OperationalError(
          `Unable to move checkout contents into linked worktree: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }
}

async function hasLockfile(targetPath: string): Promise<boolean> {
  for (const file of ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]) {
    if (await pathExists(path.join(targetPath, file))) return true;
  }
  return false;
}
