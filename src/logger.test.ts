import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "./logger.ts";

describe("log", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the shared semantic symbols and output streams", () => {
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    log.info("Reading config");
    log.success("Workspace ready");
    log.warn("Setup incomplete");
    log.error("Workspace failed");

    expect(stripAnsi(String(stdout.mock.calls[0]?.[0]))).toBe("●");
    expect(stdout.mock.calls[0]?.[1]).toBe("Reading config");
    expect(stripAnsi(String(stdout.mock.calls[1]?.[0]))).toBe("✓");
    expect(stdout.mock.calls[1]?.[1]).toBe("Workspace ready");
    expect(stripAnsi(String(warning.mock.calls[0]?.[0]))).toBe("▲");
    expect(warning.mock.calls[0]?.[1]).toBe("Setup incomplete");
    expect(stripAnsi(String(stderr.mock.calls[0]?.[0]))).toBe("✗");
    expect(stderr.mock.calls[0]?.[1]).toBe("Workspace failed");
  });
});
