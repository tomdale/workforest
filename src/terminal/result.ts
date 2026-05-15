export type PromptResult<T> =
  | { type: "submitted"; value: T }
  | { type: "cancelled" };

export class TerminalCancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancelError";
  }
}
