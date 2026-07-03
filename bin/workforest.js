#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL, fileURLToPath as toPath } from "node:url";

const USE_SOURCE_ENV = "WORKFOREST_USE_SOURCE_CLI";
const entryProjectPath = dirname(dirname(toPath(import.meta.url)));
const entrySourceUrl = new URL("../src/cli.ts", import.meta.url);
const sourceCandidate = await findSourceCandidate();
const { cli } = sourceCandidate
  ? await getCLIFromSource(sourceCandidate)
  : await getCLIFromDist();
await cli();

function getCLIFromSource(source) {
  return import(source.url.href).then((mod) => {
    mod.log.warn(`Running local copy from ${projectPath(source.root)}/src`);
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

function projectPath(root = entryProjectPath) {
  return relative(process.cwd(), root) || ".";
}

function shouldUseSource() {
  return Boolean(process.env[USE_SOURCE_ENV]);
}

async function findSourceCandidate() {
  // `pnpm wf` sets this explicitly so source checkouts exercise ./src.
  if (shouldUseSource() && (await sourceExists(entrySourceUrl))) {
    return { root: entryProjectPath, url: entrySourceUrl };
  }

  // Keep installed `wf` fast; only repair the known `pnpm exec wf` fallback to
  // a global bin, where users reasonably expect the checkout under cwd to win.
  if (!shouldProbeCwdSourceCheckout()) {
    return null;
  }

  const sourceRoot = await findSourceCheckout(process.cwd());
  if (sourceRoot && resolve(sourceRoot) !== resolve(entryProjectPath)) {
    return {
      root: sourceRoot,
      url: pathToFileURL(resolve(sourceRoot, "src/cli.ts")),
    };
  }

  return null;
}

function shouldProbeCwdSourceCheckout() {
  // pnpm does not self-link the root package bin into node_modules/.bin.
  return (
    process.env.npm_command === "exec" &&
    process.env.npm_config_user_agent?.startsWith("pnpm/") === true
  );
}

async function findSourceCheckout(startDir) {
  let current = resolve(startDir);

  for (;;) {
    if (await isWorkforestSourceCheckout(current)) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function isWorkforestSourceCheckout(dir) {
  const sourceUrl = pathToFileURL(resolve(dir, "src/cli.ts"));
  if (!(await sourceExists(sourceUrl))) {
    return false;
  }

  if (!(await fileExists(resolve(dir, "bin/workforest.js")))) {
    return false;
  }

  try {
    const manifest = JSON.parse(
      await readFile(resolve(dir, "package.json"), "utf8"),
    );
    return manifest?.name === "workforest";
  } catch (err) {
    if (err?.code === "ENOENT" || err instanceof SyntaxError) {
      return false;
    }
    throw err;
  }
}

async function sourceExists(sourceUrl) {
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

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch (err) {
    if (err?.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}
