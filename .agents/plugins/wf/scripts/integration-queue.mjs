#!/usr/bin/env node

import { execFileSync } from "node:child_process";
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

function printHelp() {
  console.log(`Usage:
  integration-queue.mjs enqueue [branch]
  integration-queue.mjs list [--json]
  integration-queue.mjs refresh <branch|id>
  integration-queue.mjs dequeue <branch|id>`);
}

function enqueue(branchArg) {
  const branch = branchArg ?? currentBranch();
  if (!branch) {
    throw new Error("Cannot enqueue a detached HEAD without an explicit branch name.");
  }
  assertQueueableBranch(branch);

  const sha = branchArg
    ? runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])
    : runGit(["rev-parse", "HEAD"]);
  if (!sha) {
    throw new Error(`Branch ${branch} does not exist`);
  }
  const timestamp = ensureUniqueTimestamp(branch);
  const refName = refNameFor(branch, timestamp);
  runGit(["update-ref", refName, sha]);
  return { branch, sha, refName, timestamp };
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

  throw new Error(`Unknown command: ${command}`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
