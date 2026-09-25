#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const sessionName = "workforest-integration";
const integrationHelper = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "integration.mjs",
);
const baseline = process.argv[2] ?? "[]";

for (let attempt = 0; attempt < 200; attempt += 1) {
  const active = spawnSync("tmux", ["has-session", "-t", `=${sessionName}`], {
    stdio: "ignore",
  });
  if (active.error) process.exit(1);
  if (active.status !== 0) {
    const queue = spawnSync(process.execPath, [integrationHelper, "list", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (queue.error || queue.status !== 0) {
      await delay(50);
      continue;
    }
    if (baseline !== "unknown" && queue.stdout.trim() === baseline) process.exit(0);

    const restart = spawnSync(
      process.execPath,
      [integrationHelper, "start-pi", "--if-queued"],
      { stdio: "ignore" },
    );
    if (restart.status === 0) process.exit(0);
  }
  await delay(50);
}

process.exit(1);
