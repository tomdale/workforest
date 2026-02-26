export class CancelError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancelError";
  }
}

export type PromptBaseOptions = {
  throwOnCancel?: boolean;
};
