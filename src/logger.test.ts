import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "./logger.ts";

describe("log", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the shared inline grammar: bar, semantic glyph, message", () => {
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    log.info("Reading config");
    log.success("Workspace ready");
    log.warn("Setup incomplete");
    log.error("Workspace failed");

    expect(stripAnsi(String(stdout.mock.calls[0]?.[0]))).toBe(
      "  │  ● Reading config",
    );
    expect(stripAnsi(String(stdout.mock.calls[1]?.[0]))).toBe(
      "  │  ✔︎ Workspace ready",
    );
    expect(stripAnsi(String(warning.mock.calls[0]?.[0]))).toBe(
      "  │  ▲ Setup incomplete",
    );
    expect(stripAnsi(String(stderr.mock.calls[0]?.[0]))).toBe(
      "  │  ✗ Workspace failed",
    );
  });

  it("joins multiple arguments into one grammar line", () => {
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});

    log.info("Run:", "cd ~/work");

    expect(stripAnsi(String(stdout.mock.calls[0]?.[0]))).toBe(
      "  │  ● Run: cd ~/work",
    );
    expect(stdout.mock.calls[0]?.[1]).toBeUndefined();
  });
});
