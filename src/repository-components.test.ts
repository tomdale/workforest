import { describe, expect, it } from "vitest";
import { validateRepositoryComponent } from "./repository-components.ts";

describe("validateRepositoryComponent", () => {
  it.each([
    "",
    ".",
    "..",
    " owner",
    "owner ",
    "owner/repo",
    "owner\\repo",
    "/absolute",
    "C:\\absolute",
    "\\\\server\\share",
    "line\nbreak",
    "nul\0byte",
    "delete\u007f",
    "-leading",
    "not allowed",
  ])("rejects %j", (value) => {
    expect(() => validateRepositoryComponent(value)).toThrow();
  });

  it.each([
    "vercel",
    "vercel-labs",
    "next.js",
    "repo_name",
    "Repo-2",
  ])("accepts %j", (value) => {
    expect(validateRepositoryComponent(value)).toBe(value);
  });

  it("preserves valid components ending in .git", () => {
    expect(validateRepositoryComponent("next.js.git")).toBe("next.js.git");
  });
});
