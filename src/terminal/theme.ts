import chalk from "chalk";

export const terminalColor = {
  accent: chalk.cyan,
  muted: chalk.dim,
  success: chalk.green,
  warning: chalk.yellow,
  error: chalk.red,
};

export const helpColor = {
  heading: chalk.cyanBright,
  program: chalk.whiteBright,
  command: chalk.cyan,
  option: chalk.yellow,
  argument: chalk.cyanBright,
  description: (value: string) => value,
  metadata: chalk.dim,
};

export const terminalSymbol = {
  active: "◆",
  done: "◇",
  cancel: "■",
  errorStep: "▲",
  radioOn: "●",
  radioOff: "○",
  checkOn: "◼",
  checkOff: "◻",
  info: "●",
  success: "✓",
  warning: "▲",
  error: "✗",
};
