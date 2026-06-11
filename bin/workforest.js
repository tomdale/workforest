#!/usr/bin/env node

import { access } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { fileURLToPath as toPath } from "node:url";

const sourceUrl = new URL("../src/cli.ts", import.meta.url);
const { cli } = (await sourceExists())
  ? await getCLIFromSource()
  : await getCLIFromDist();
await cli();

function getCLIFromSource() {
  return import(sourceUrl.href).then((mod) => {
    mod.log.warn(`Running local copy from ${projectPath()}/src`);
    return mod;
  });
}

function getCLIFromDist() {
  return import("../dist/index.mjs").catch((distError) => {
    error("Unable to load the CLI from dist/index.mjs.");
    throw distError;
  });
}

function error(...args) {
  console.error(...args);
}

function projectPath() {
  return (
    relative(process.cwd(), dirname(dirname(toPath(import.meta.url)))) || "."
  );
}

async function sourceExists() {
  try {
    await access(sourceUrl);
    return true;
  } catch (err) {
    if (err?.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}
