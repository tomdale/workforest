import chalk from "chalk";

// Box drawing
export const S_BAR_START = "┌";
export const S_BAR = "│";
export const S_BAR_END = "└";
export const S_BAR_H = "─";
export const S_CONNECTOR = "├";

// Prompt state
export const S_STEP_ACTIVE = chalk.cyan("◆");
export const S_STEP_DONE = chalk.dim("◇");
export const S_STEP_CANCEL = chalk.red("■");
export const S_STEP_ERROR = chalk.yellow("▲");

// Select / radio
export const S_RADIO_ON = chalk.cyan("●");
export const S_RADIO_OFF = chalk.dim("○");

// Checkbox
export const S_CHECK_ON = chalk.cyan("◼");
export const S_CHECK_OFF = chalk.dim("◻");

// Spinner frames
export const SPINNER_FRAMES = ["◒", "◐", "◓", "◑"];
export const SPINNER_INTERVAL = 80;

// Log prefixes
export const S_INFO = chalk.cyan("●");
export const S_SUCCESS = chalk.green("✓");
export const S_WARNING = chalk.yellow("▲");
export const S_ERROR = chalk.red("✗");

// Colors applied to structural elements
export const barColor = chalk.dim;
