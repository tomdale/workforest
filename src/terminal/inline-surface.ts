import { wrap } from "./text.ts";

export class InlineSurface {
  private readonly out: NodeJS.WriteStream;
  private readonly width: number;
  private renderedLineCount = 0;

  constructor(
    out: NodeJS.WriteStream = process.stdout,
    width = process.stdout.columns ?? 80,
  ) {
    this.out = out;
    this.width = width;
  }

  render(lines: string[]): void {
    this.erase();
    const wrapped = lines.flatMap((line) => wrap(line, this.width));
    this.out.write(`${wrapped.join("\n")}\n`);
    this.renderedLineCount = wrapped.length;
  }

  commit(lines: string[]): void {
    this.erase();
    if (lines.length > 0) {
      this.out.write(`${lines.join("\n")}\n`);
    }
    this.renderedLineCount = 0;
  }

  clear(): void {
    this.commit([]);
  }

  private erase(): void {
    if (this.renderedLineCount === 0) return;

    this.out.write(`\x1B[${this.renderedLineCount}A`);
    for (let i = 0; i < this.renderedLineCount; i++) {
      this.out.write("\x1B[2K");
      if (i < this.renderedLineCount - 1) {
        this.out.write("\x1B[1B");
      }
    }
    if (this.renderedLineCount > 1) {
      this.out.write(`\x1B[${this.renderedLineCount - 1}A`);
    }
    this.renderedLineCount = 0;
  }
}
