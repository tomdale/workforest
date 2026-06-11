import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveContainedPath, validateResourceName } from "./path-safety.ts";

describe("validateResourceName", () => {
  it.each([
    "",
    ".",
    "..",
    "name/",
    "name\\child",
    "/absolute",
    "C:\\absolute",
    "\\\\server\\share",
    "line\nbreak",
    "nul\0byte",
    "delete\u007f",
    "colon:name",
    "question?",
  ])("rejects %j", (value) => {
    expect(() => validateResourceName(value)).toThrow();
  });

  it.each([
    "workspace",
    "fix-auth",
    "task-2",
    "next.js",
    "Repo_Name",
  ])("accepts %j", (value) => {
    expect(validateResourceName(value)).toBe(value);
  });
});

describe("resolveContainedPath", () => {
  const root = path.resolve("/tmp/workforest-root");

  it.each([
    [".."],
    ["../outside"],
    ["..\\outside"],
    ["nested/../../outside"],
    ["nested\\..\\..\\outside"],
    ["/absolute"],
    ["C:\\absolute"],
    ["\\\\server\\share"],
    ["nul\0byte"],
    ["line\nbreak"],
  ])("rejects an escaping or invalid path %j", (...segments) => {
    expect(() => resolveContainedPath(root, ...segments)).toThrow();
  });

  it("resolves nested contained paths", () => {
    expect(resolveContainedPath(root, "nested/child", "file.txt")).toBe(
      path.join(root, "nested", "child", "file.txt"),
    );
    expect(resolveContainedPath(root, "nested\\child", "file.txt")).toBe(
      path.join(root, "nested", "child", "file.txt"),
    );
  });
});
