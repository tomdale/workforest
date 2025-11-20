#!/usr/bin/env node

import chalk from "chalk";

const log = (...args) => console.log(chalk.yellow(...args));
const error = (...args) => console.error(chalk.red(...args));

const { cli } = await import("../src/index.ts")
  .then((mod) => {
    log("Using local source version of CLI");
    return mod;
  })
  .catch(() =>
    import("../dist/index.mjs").catch((distError) => {
      error("Unable to load the CLI from either src/cli.ts or dist/cli.js.");
      throw distError;
    }),
  );

cli();
