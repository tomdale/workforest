import { describe, expect, it } from "vitest";
import {
  buildBranchName,
  inferBranchPrefix,
  normalizeBranchPrefix,
} from "./branch-prefix.ts";

describe("normalizeBranchPrefix", () => {
  it("appends a trailing slash when missing", () => {
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
  it("uses the normalized prefix when building branch names", () => {
    expect(buildBranchName("feature-work", "tomdale")).toBe(
      "tomdale/feature-work",
    );
  });

  it("falls back to the feature name when no prefix is set", () => {
    expect(buildBranchName("feature-work", undefined)).toBe("feature-work");
  });
});

describe("inferBranchPrefix", () => {
  it("normalizes prefixes inferred from older malformed branch names", () => {
    expect(inferBranchPrefix("tomdalefeature-work", "feature-work")).toBe(
      "tomdale/",
    );
  });

  it("preserves already-normalized prefixes", () => {
    expect(inferBranchPrefix("tomdale/feature-work", "feature-work")).toBe(
      "tomdale/",
    );
  });
});
