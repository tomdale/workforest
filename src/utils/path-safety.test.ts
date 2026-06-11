import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertContainedPathWithoutSymlinks,
  resolveContainedPath,
  validateResourceName,
} from "./path-safety.ts";

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

describe("assertContainedPathWithoutSymlinks", () => {
  it("rejects a symlink in an existing path component", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workforest-root-"));
    const outside = await mkdtemp(
      path.join(os.tmpdir(), "workforest-outside-"),
    );

    try {
      await symlink(outside, path.join(root, "redirect"));

      await expect(
        assertContainedPathWithoutSymlinks(
          root,
          path.join(root, "redirect", "file.txt"),
        ),
      ).rejects.toThrow("symbolic link");
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });

  it("allows missing descendants beneath real directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workforest-root-"));

    try {
      await mkdir(path.join(root, "nested"));
      await expect(
        assertContainedPathWithoutSymlinks(
          root,
          path.join(root, "nested", "file.txt"),
        ),
      ).resolves.toBe(path.join(root, "nested", "file.txt"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
