#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import process from "node:process";

const QUEUE_PREFIX = "refs/workforest/integration-ready";
const BRANCH_PREFIX = "tomdale/";
const MAIN_BRANCH = "main";

function runGit(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function runGitAllowEmpty(args, options = {}) {
  try {
    return runGit(args, options);
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 1) {
      return "";
    }
    throw error;
  }
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function gitSucceeds(args, options = {}) {
  try {
    runGit(args, options);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 1) {
      return false;
    }
    throw error;
  }
}

function currentBranch() {
  return runGit(["branch", "--show-current"]);
}

function assertCleanWorktree() {
  const status = runGitAllowEmpty(["status", "--short"]);
  if (!status) return;
  throw new Error(
    [
      "Cannot enqueue with a dirty working tree.",
      "Commit, stash, or discard the following changes, then rerun enqueue:",
      status,
    ].join("\n"),
  );
}

function shortRefName(ref) {
  return ref.startsWith(`${QUEUE_PREFIX}/`) ? ref.slice(QUEUE_PREFIX.length + 1) : ref;
}

function parseEntry(refName, sha) {
  const rest = shortRefName(refName);
  const parts = rest.split("/").filter(Boolean);
  const timestamp = parts.shift() ?? "";
  const branch = parts.join("/");
  return {
    id: refName,
    timestamp,
    branch,
    sha,
  };
}

function queueEntries() {
  const output = runGitAllowEmpty([
    "for-each-ref",
    `--format=%(refname) %(objectname)`,
    QUEUE_PREFIX,
  ]);
  if (!output) return [];
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const space = line.indexOf(" ");
      const refName = line.slice(0, space);
      const sha = line.slice(space + 1);
      return parseEntry(refName, sha);
    })
    .sort((a, b) => compareEntries(a, b));
}

function branchHead(branch) {
  return (
    runGitAllowEmpty(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) || null
  );
}

function refExists(refName) {
  return gitSucceeds(["rev-parse", "--verify", "--quiet", refName]);
}

function timestampSortKey(timestamp) {
  const match = timestamp.match(/^(\d{8})T(\d{6})(\d{3})?Z$/);
  if (!match) return "99999999999999999";
  const [, date, time, milliseconds = "000"] = match;
  return `${date}${time}${milliseconds}`;
}

function compareEntries(a, b) {
  const byTimestamp = timestampSortKey(a.timestamp).localeCompare(
    timestampSortKey(b.timestamp),
  );
  if (byTimestamp !== 0) return byTimestamp;
  return a.id.localeCompare(b.id);
}

function statusFor(entry) {
  const head = branchHead(entry.branch);
  if (!head) return { state: "missing", head: null };
  if (head !== entry.sha) return { state: "stale", head };
  const merged = gitSucceeds(["merge-base", "--is-ancestor", entry.sha, "main"]);
  return { state: merged ? "integrated" : "ready", head };
}

function refNameFor(branch, timestamp) {
  return `${QUEUE_PREFIX}/${timestamp}/${branch}`;
}

function formatTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(".", "");
}

function ensureUniqueTimestamp(branch) {
  const start = new Date();
  for (let offset = 0; offset < 1000; offset += 1) {
    const timestamp = formatTimestamp(new Date(start.getTime() + offset));
    if (!refExists(refNameFor(branch, timestamp))) return timestamp;
  }
  throw new Error(`Could not allocate a unique queue timestamp for ${branch}`);
}

function assertQueueableBranch(branch) {
  if (branch === MAIN_BRANCH) {
    throw new Error("Cannot enqueue main for integration.");
  }
  if (!branch.startsWith(BRANCH_PREFIX)) {
    throw new Error(`Cannot enqueue ${branch}; branch names must start with ${BRANCH_PREFIX}`);
  }
}

function validateBranchForEnqueue(branch, branchArg) {
  const checkedOutBranch = currentBranch();
  if (!checkedOutBranch) {
    throw new Error("Cannot enqueue a detached HEAD without checking out a branch.");
  }
  if (branchArg && branch !== checkedOutBranch) {
    throw new Error(
      [
        `Cannot validate ${branch} from checked-out branch ${checkedOutBranch}.`,
        `Switch to ${branch} or run enqueue from that branch's worktree.`,
      ].join("\n"),
    );
  }

  assertCleanWorktree();
  console.error("Running validation: pnpm check");
  const status = runCommand("pnpm", ["check"]);
  if (status !== 0) {
    throw new Error(
      [
        `Validation failed for ${branch}: pnpm check exited with code ${status}.`,
        "Fix the reported errors, commit the fixes, and rerun enqueue.",
      ].join("\n"),
    );
  }
  assertCleanWorktree();
}

function pruneQueuedBranchEntries(branch, keepRefName) {
  const removedRefs = [];
  for (const entry of queueEntries()) {
    if (entry.branch !== branch || entry.id === keepRefName) continue;
    runGit(["update-ref", "-d", entry.id]);
    removedRefs.push(entry.id);
  }
  return removedRefs;
}

function findEntry(identifier) {
  const entries = queueEntries();
  const exactEntry =
    entries.find((entry) => entry.id === identifier) ||
    entries.find((entry) => shortRefName(entry.id) === identifier);
  if (exactEntry) return exactEntry;

  const branchMatches = entries.filter((entry) => entry.branch === identifier);
  if (branchMatches.length > 1) {
    const ids = branchMatches.map((entry) => entry.id).join(", ");
    throw new Error(
      `Multiple queue entries found for ${identifier}; use the full queue id: ${ids}`,
    );
  }
  return branchMatches[0];
}

function entryForIdentifier(identifier) {
  const entry = findEntry(identifier);
  if (entry) return entry;
  const head = branchHead(identifier);
  if (!head) return null;
  return {
    id: identifier,
    timestamp: "",
    branch: identifier,
    sha: head,
  };
}

function printHelp() {
  console.log(`Usage:
  integration.mjs enqueue [branch]
  integration.mjs list [--json]
  integration.mjs refresh <branch|id>
  integration.mjs sync-worktree <branch|id> [--target <commit>]
  integration.mjs dequeue <branch|id>`);
}

function enqueue(branchArg) {
  const branch = branchArg ?? currentBranch();
  if (!branch) {
    throw new Error("Cannot enqueue a detached HEAD without an explicit branch name.");
  }
  assertQueueableBranch(branch);
  validateBranchForEnqueue(branch, branchArg);

  const sha = branchArg
    ? runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])
    : runGit(["rev-parse", "HEAD"]);
  if (!sha) {
    throw new Error(`Branch ${branch} does not exist`);
  }
  const timestamp = ensureUniqueTimestamp(branch);
  const refName = refNameFor(branch, timestamp);
  runGit(["update-ref", refName, sha]);
  const removedRefs = pruneQueuedBranchEntries(branch, refName);
  return { branch, sha, refName, timestamp, removedRefs };
}

function refresh(identifier) {
  const entry = findEntry(identifier);
  if (!entry) {
    throw new Error(`No queue entry found for ${identifier}`);
  }
  const head = branchHead(entry.branch);
  if (!head) {
    throw new Error(`Branch ${entry.branch} no longer exists`);
  }
  runGit(["update-ref", entry.id, head]);
  return { ...entry, sha: head };
}

function dequeue(identifier) {
  const entry = findEntry(identifier);
  if (!entry) {
    throw new Error(`No queue entry found for ${identifier}`);
  }
  runGit(["update-ref", "-d", entry.id]);
  return entry;
}

function parseWorktreeList(output) {
  const entries = [];
  let current = null;
  for (const line of output.split("\n")) {
    if (!line) {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length), branch: null };
      continue;
    }
    if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    }
  }
  if (current) entries.push(current);
  return entries;
}

function worktreeForBranch(branch) {
  const worktrees = parseWorktreeList(runGit(["worktree", "list", "--porcelain"]));
  return (
    worktrees.find((worktree) => worktree.branch === `refs/heads/${branch}`) ?? null
  );
}

function mainHead() {
  return runGit(["rev-parse", MAIN_BRANCH]);
}

function resolveExplicitTarget(target) {
  const resolved =
    runGitAllowEmpty(["rev-parse", "--verify", "--quiet", `${target}^{commit}`]) ||
    null;
  if (!resolved) {
    throw new Error(`Target ${target} does not name a commit.`);
  }
  if (!gitSucceeds(["merge-base", "--is-ancestor", resolved, MAIN_BRANCH])) {
    throw new Error(`Target ${target} is not reachable from ${MAIN_BRANCH}.`);
  }
  return resolved;
}

function allQueuedPatchesAreOnMain(commit) {
  const mergeBase = runGitAllowEmpty(["merge-base", commit, MAIN_BRANCH]);
  if (!mergeBase) return false;

  const output = runGitAllowEmpty(["cherry", MAIN_BRANCH, commit, mergeBase]);
  if (!output) return false;

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .every((line) => line.startsWith("-"));
}

function integrationTargetFor(entry, explicitTarget) {
  if (explicitTarget) return resolveExplicitTarget(explicitTarget);

  if (gitSucceeds(["merge-base", "--is-ancestor", entry.sha, MAIN_BRANCH])) {
    return mainHead();
  }
  if (allQueuedPatchesAreOnMain(entry.sha)) return mainHead();
  return null;
}

function syncWorktree(identifier, options = {}) {
  const entry = entryForIdentifier(identifier);
  if (!entry) {
    throw new Error(`No queue entry or branch found for ${identifier}`);
  }
  const worktree = worktreeForBranch(entry.branch);
  if (!worktree) {
    return {
      ...entry,
      status: "skipped",
      reason: `No worktree found with ${entry.branch} checked out.`,
    };
  }
  const dirty = runGitAllowEmpty(["status", "--porcelain"], { cwd: worktree.path });
  if (dirty) {
    return {
      ...entry,
      status: "skipped",
      reason: `Worktree has uncommitted changes at ${worktree.path}.`,
    };
  }
  const head = branchHead(entry.branch);
  if (head && head !== entry.sha) {
    return {
      ...entry,
      status: "skipped",
      reason: `Branch ${entry.branch} has moved from queued SHA ${entry.sha} to ${head}.`,
    };
  }
  const target = integrationTargetFor(entry, options.target);
  if (!target) {
    return {
      ...entry,
      status: "skipped",
      reason: `No commit on ${MAIN_BRANCH} contains ${entry.sha}.`,
    };
  }
  runGit(["reset", "--hard", target], { cwd: worktree.path });
  return {
    ...entry,
    status: "updated",
    worktree: worktree.path,
    target,
  };
}

function parseSyncArgs(args) {
  const [identifier, ...rest] = args;
  if (!identifier) throw new Error("sync-worktree requires a branch name or queue id");

  let target = null;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--target") {
      const value = rest[index + 1];
      if (!value) throw new Error("sync-worktree --target requires a commit");
      target = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--target=")) {
      target = arg.slice("--target=".length);
      if (!target) throw new Error("sync-worktree --target requires a commit");
      continue;
    }
    throw new Error(`Unknown sync-worktree option: ${arg}`);
  }

  return { identifier, target };
}

function printList(jsonOutput) {
  const entries = queueEntries().map((entry) => ({
    ...entry,
    status: statusFor(entry).state,
  }));
  if (jsonOutput) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  if (!entries.length) {
    console.log("No queued integration entries.");
    return;
  }
  for (const entry of entries) {
    const status = statusFor(entry);
    const suffix = status.state === "stale" ? ` (stale, branch head ${status.head})` : "";
    console.log(`${entry.id}\t${entry.sha}\t${status.state}${suffix}`);
  }
}

function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help") {
    printHelp();
    return;
  }

  if (command === "enqueue") {
    const branch = rest[0];
    const result = enqueue(branch);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "list") {
    printList(rest.includes("--json"));
    return;
  }

  if (command === "refresh") {
    const identifier = rest[0];
    if (!identifier) throw new Error("refresh requires a branch name or queue id");
    const result = refresh(identifier);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "dequeue") {
    const identifier = rest[0];
    if (!identifier) throw new Error("dequeue requires a branch name or queue id");
    const result = dequeue(identifier);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "sync-worktree") {
    const { identifier, target } = parseSyncArgs(rest);
    const result = syncWorktree(identifier, target ? { target } : {});
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
