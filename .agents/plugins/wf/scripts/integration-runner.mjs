#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const integrationHelper = path.join(scriptDirectory, "integration.mjs");
const integrationReaper = path.join(scriptDirectory, "integration-reaper.mjs");
const piExecutable = process.argv[2] ?? "pi";
const prompt = [
  "Run the integrate skill now and autonomously drain every entry in the integration queue.",
  "This is the dedicated unattended integration session, so do not ask for cleanup confirmation; report eligible original worktrees for later cleanup instead.",
  "Do not stop after one branch. Re-list the queue after each entry and continue until it is empty.",
].join(" ");

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function queueSnapshot() {
  const result = spawnSync(process.execPath, [integrationHelper, "list", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Could not inspect the integration queue.");
  return result.stdout.trim();
}

function launchReaper(baseline) {
  const reaper = spawn(process.execPath, [integrationReaper, baseline], {
    detached: true,
    stdio: "ignore",
  });
  reaper.unref();
}

let exitCode = 0;
let reaperBaseline = "unknown";

try {
  reaperBaseline = queueSnapshot();
  while (true) {
    const turnBaseline = queueSnapshot();
    const piStatus = run(piExecutable, [
      "--name",
      "Workforest integration",
      "--approve",
      "--print",
      prompt,
    ]);
    if (piStatus !== 0) {
      exitCode = piStatus;
      reaperBaseline = turnBaseline;
      break;
    }

    const finish = spawnSync(process.execPath, [integrationHelper, "finish-pi"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    if (finish.error) throw finish.error;
    if (finish.status !== 0) {
      exitCode = finish.status ?? 1;
      reaperBaseline = turnBaseline;
      break;
    }
    if (JSON.parse(finish.stdout).status === "finished") {
      reaperBaseline = "[]";
      break;
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  exitCode = 1;
} finally {
  try {
    launchReaper(reaperBaseline);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    exitCode = 1;
  }
}

process.exitCode = exitCode;
