import chalk from "chalk";

export const log = {
  info: (...messages: unknown[]) =>
    console.log(chalk.cyan("[info]"), ...messages),
  warn: (...messages: unknown[]) =>
    console.warn(chalk.yellow("[warn]"), ...messages),
  error: (...messages: unknown[]) =>
    console.error(chalk.red("[error]"), ...messages),
  success: (...messages: unknown[]) =>
    console.log(chalk.green("[done]"), ...messages),
};
