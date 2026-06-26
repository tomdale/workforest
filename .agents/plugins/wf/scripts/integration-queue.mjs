#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import process from "node:process";

const QUEUE_PREFIX = "refs/workforest/integration-ready";

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
    .sort((a, b) => a.id.localeCompare(b.id));
}

function branchHead(branch) {
  return runGitAllowEmpty(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) || null;
}

function statusFor(entry) {
  const head = branchHead(entry.branch);
  if (!head) return { state: "missing", head: null };
  if (head !== entry.sha) return { state: "stale", head };
  const merged = runGitAllowEmpty(["merge-base", "--is-ancestor", entry.sha, "main"]);
  if (merged === "") {
    return { state: "ready", head };
  }
  return { state: "integrated", head };
}

function ensureTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function refNameFor(branch, timestamp) {
  return `${QUEUE_PREFIX}/${timestamp}/${branch}`;
}

function findEntry(identifier) {
  const entries = queueEntries();
  return (
    entries.find((entry) => entry.id === identifier) ||
    entries.find((entry) => entry.branch === identifier) ||
    entries.find((entry) => shortRefName(entry.id) === identifier)
  );
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

  const sha = branchArg
    ? runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])
    : runGit(["rev-parse", "HEAD"]);
  if (!sha) {
    throw new Error(`Branch ${branch} does not exist`);
  }
  const timestamp = ensureTimestamp();
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
