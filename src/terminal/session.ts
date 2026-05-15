import { onExit } from "signal-exit";

export type TerminalSessionOptions = {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  rawMode?: boolean;
  cursor?: "show" | "hide" | "preserve";
  alternateScreen?: boolean;
};

export class TerminalSession {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;

  private readonly previousRawMode: boolean | undefined;
  private readonly restoreCursor: boolean;
  private readonly restoreAlternateScreen: boolean;
  private readonly removeExitHandler: () => void;
  private finished = false;
  private started = false;

  constructor(options: TerminalSessionOptions = {}) {
    this.stdin = options.stdin ?? process.stdin;
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
    this.previousRawMode = this.stdin.isRaw;
    this.restoreCursor =
      options.cursor !== undefined && options.cursor !== "preserve";
    this.restoreAlternateScreen = options.alternateScreen === true;
    this.removeExitHandler = onExit(() => {
      this.teardown();
    });

    this.start(options);
  }

  static run<T>(
    options: TerminalSessionOptions,
    callback: (session: TerminalSession) => Promise<T> | T,
  ): Promise<T> {
    const session = new TerminalSession(options);
    return Promise.resolve()
      .then(() => callback(session))
      .finally(() => {
        session.teardown();
      });
  }

  start(options: TerminalSessionOptions): void {
    if (this.started) return;
    this.started = true;

    if (options.alternateScreen) {
      this.stdout.write("\x1B[?1049h");
    }

    if (options.cursor === "hide") {
      this.stdout.write("\x1B[?25l");
    } else if (options.cursor === "show") {
      this.stdout.write("\x1B[?25h");
    }

    if (options.rawMode) {
      this.stdin.setRawMode?.(true);
      this.stdin.resume();
    }
  }

  teardown(): void {
    if (this.finished) return;
    this.finished = true;

    try {
      if (this.restoreAlternateScreen) {
        this.stdout.write("\x1B[?1049l");
      }

      if (this.restoreCursor) {
        this.stdout.write("\x1B[?25h");
      }

      if (this.started) {
        this.stdin.setRawMode?.(this.previousRawMode ?? false);
        if (this.previousRawMode !== true) {
          this.stdin.pause();
        }
      }
    } finally {
      this.removeExitHandler();
    }
  }
}
