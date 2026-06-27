import { describe, expect, it } from "vitest";
import { isCliError, OperationalError, UsageError } from "./errors.ts";

describe("CLI errors", () => {
  it("assigns stable kinds and exit codes to expected errors", () => {
    expect(new UsageError("bad invocation").exitCode).toBe(2);
    expect(new UsageError("bad invocation").kind).toBe("usage");
    expect(new OperationalError("failed").exitCode).toBe(1);
    expect(new OperationalError("failed").kind).toBe("operational");
  });

  it("identifies expected CLI errors without treating arbitrary errors as expected", () => {
    expect(isCliError(new UsageError("bad invocation"))).toBe(true);
    expect(isCliError(new Error("unexpected"))).toBe(false);
  });
});
