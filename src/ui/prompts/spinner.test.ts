import { afterEach, describe, expect, it, vi } from "vitest";
import { withSpinner } from "./spinner.ts";

describe("withSpinner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("restores the cursor when the wrapped task throws", async () => {
    const writes: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write");
    writeSpy.mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    await expect(
      withSpinner("Working...", async () => {
        throw new Error("workspace setup failed");
      }),
    ).rejects.toThrow("workspace setup failed");

    expect(writes).toContain("\x1B[?25l");
    expect(writes).toContain("\x1B[?25h");
  });
});
