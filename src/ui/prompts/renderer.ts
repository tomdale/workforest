/**
 * FrameRenderer manages a region of terminal lines that can be redrawn
 * on each keystroke, then committed as permanent scrollback.
 */
export class FrameRenderer {
  private lineCount = 0;
  private out: NodeJS.WriteStream;

  constructor(out: NodeJS.WriteStream = process.stdout) {
    this.out = out;
  }

  /**
   * Erase the previous frame and write new lines in place.
   * Tracks line count so the next call can erase correctly.
   */
  render(lines: string[]): void {
    // Move cursor up to erase the previous frame
    if (this.lineCount > 0) {
      this.out.write(`\x1B[${this.lineCount}A`);
    }

    for (let i = 0; i < this.lineCount; i++) {
      this.out.write("\x1B[2K"); // clear line
      if (i < this.lineCount - 1) {
        this.out.write("\x1B[1B"); // move down
      }
    }

    // Move back to the start position
    if (this.lineCount > 0) {
      this.out.write(`\x1B[${this.lineCount - 1}A`);
    }

    // Write new frame
    this.out.write(`${lines.join("\n")}\n`);
    this.lineCount = lines.length;
  }

  /**
   * Erase the current frame and write final lines as permanent stdout.
   * Resets line count to 0 — nothing will be erased on subsequent calls.
   */
  commit(lines: string[]): void {
    // Erase active frame
    if (this.lineCount > 0) {
      this.out.write(`\x1B[${this.lineCount}A`);
      for (let i = 0; i < this.lineCount; i++) {
        this.out.write("\x1B[2K");
        if (i < this.lineCount - 1) {
          this.out.write("\x1B[1B");
        }
      }
      if (this.lineCount > 1) {
        this.out.write(`\x1B[${this.lineCount - 1}A`);
      }
    }

    // Write committed output
    if (lines.length > 0) {
      this.out.write(`${lines.join("\n")}\n`);
    }

    this.lineCount = 0;
  }

  /**
   * Erase the current frame without writing anything new.
   */
  clear(): void {
    this.commit([]);
  }
}
