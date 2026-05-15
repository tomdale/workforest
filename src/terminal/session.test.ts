import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { TerminalSession } from "./session.ts";

class FakeInput extends EventEmitter {
  isRaw = false;
  setRawMode = vi.fn((value: boolean) => {
    this.isRaw = value;
  });
  resume = vi.fn();
  pause = vi.fn();
}

class FakeOutput {
  writes: string[] = [];
  write = vi.fn((chunk: string) => {
    this.writes.push(chunk);
    return true;
  });
}

describe("TerminalSession", () => {
  it("restores raw mode and cursor exactly once", () => {
    const stdin = new FakeInput();
    const stdout = new FakeOutput();
    const session = new TerminalSession({
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      rawMode: true,
      cursor: "hide",
    });

    session.teardown();
    session.teardown();

    expect(stdin.setRawMode).toHaveBeenCalledWith(true);
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(stdin.pause).toHaveBeenCalledTimes(1);
    expect(stdout.writes).toEqual(["\x1B[?25l", "\x1B[?25h"]);
  });

  it("restores state when callback throws", async () => {
    const stdin = new FakeInput();
    const stdout = new FakeOutput();

    await expect(
      TerminalSession.run(
        {
          stdin: stdin as unknown as NodeJS.ReadStream,
          stdout: stdout as unknown as NodeJS.WriteStream,
          rawMode: true,
          cursor: "hide",
        },
        () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");

    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(stdout.writes).toEqual(["\x1B[?25l", "\x1B[?25h"]);
  });
});
