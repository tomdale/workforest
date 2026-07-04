import { afterEach, describe, expect, it } from "vitest";
import { resolveSetupMaxConcurrent } from "./setup-limits.ts";

const originalEnv = process.env["WORKFOREST_MAX_CONCURRENT"];

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env["WORKFOREST_MAX_CONCURRENT"];
  } else {
    process.env["WORKFOREST_MAX_CONCURRENT"] = originalEnv;
  }
});

describe("resolveSetupMaxConcurrent", () => {
  it("defaults to a bounded cap", () => {
    delete process.env["WORKFOREST_MAX_CONCURRENT"];
    expect(resolveSetupMaxConcurrent()).toBe(4);
  });

  it("uses the configured value and treats zero as unlimited", () => {
    delete process.env["WORKFOREST_MAX_CONCURRENT"];
    expect(resolveSetupMaxConcurrent(8)).toBe(8);
    expect(resolveSetupMaxConcurrent(0)).toBe(Number.POSITIVE_INFINITY);
  });

  it("lets the environment override config", () => {
    process.env["WORKFOREST_MAX_CONCURRENT"] = "2";
    expect(resolveSetupMaxConcurrent(8)).toBe(2);

    process.env["WORKFOREST_MAX_CONCURRENT"] = "0";
    expect(resolveSetupMaxConcurrent(8)).toBe(Number.POSITIVE_INFINITY);
  });

  it("ignores invalid environment values", () => {
    process.env["WORKFOREST_MAX_CONCURRENT"] = "lots";
    expect(resolveSetupMaxConcurrent(8)).toBe(8);

    process.env["WORKFOREST_MAX_CONCURRENT"] = "-3";
    expect(resolveSetupMaxConcurrent()).toBe(4);
  });
});
