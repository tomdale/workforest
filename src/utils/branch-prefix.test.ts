import { describe, expect, it } from "vitest";
import {
  buildBranchName,
  normalizeBranchPrefix,
  resolveBranchPrefix,
} from "./branch-prefix.ts";

describe("normalizeBranchPrefix", () => {
  it("adds a branch separator when missing", () => {
    expect(normalizeBranchPrefix("tomdale")).toBe("tomdale/");
  });

  it("preserves an existing trailing slash", () => {
    expect(normalizeBranchPrefix("tomdale/")).toBe("tomdale/");
  });

  it("returns undefined for empty input", () => {
    expect(normalizeBranchPrefix("   ")).toBeUndefined();
  });
});

describe("buildBranchName", () => {
  it("uses exactly one separator when the prefix omits a trailing slash", () => {
    expect(buildBranchName("feature-work", "tomdale")).toBe(
      "tomdale/feature-work",
    );
  });

  it("uses exactly one separator when the prefix includes a trailing slash", () => {
    expect(buildBranchName("feature-work", "tomdale/")).toBe(
      "tomdale/feature-work",
    );
  });

  it("falls back to the feature name when no prefix is set", () => {
    expect(buildBranchName("feature-work", undefined)).toBe("feature-work");
  });
});

describe("resolveBranchPrefix", () => {
  it("falls back to the workspace default when the template does not override", () => {
    expect(resolveBranchPrefix("feature/", undefined)).toBe("feature/");
  });

  it("uses the template override when provided", () => {
    expect(resolveBranchPrefix("feature/", "release")).toBe("release/");
  });

  it("allows a template to explicitly disable the global prefix", () => {
    expect(resolveBranchPrefix("feature/", "")).toBeUndefined();
  });
});
