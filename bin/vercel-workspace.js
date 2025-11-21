#!/usr/bin/env node

import { dirname, relative } from "node:path";
import { fileURLToPath as toPath } from "node:url";
import chalk from "chalk";

const { cli } = await getCLIFromSource().catch(getCLIFromDist);
await cli();

function getCLIFromSource() {
  return import("../src/cli.ts").then((mod) => {
    mod.log.warn(`Running local copy from ${projectPath()}/src`);
    return mod;
  });
}

function getCLIFromDist(err) {
  return checkForActualError(err).then(() =>
    import("../dist/cli.mjs").catch((distError) => {
      error("Unable to load the CLI from either src/cli.ts or dist/cli.js.");
      throw distError;
    }),
  );
}

function error(...args) {
  console.error(chalk.red(...args));
}

function projectPath() {
  return (
    relative(process.cwd(), dirname(dirname(toPath(import.meta.url)))) || "."
  );
}

function checkForActualError(err) {
  if (err.code === "ENOENT") return;
  throw err;
}
