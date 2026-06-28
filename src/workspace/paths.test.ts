import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkforestContext } from "./context.ts";
import {
  getRepositoryTaskPath,
  getReviewRepoPath,
  getWorkspacePath,
  getWorkspaceRepoPath,
  getWorkspaceTaskPath,
  getWorktreePath,
  isPathInsideOrEqual,
  resolveWorkforestDirectories,
} from "./paths.ts";

const roots = resolveWorkforestDirectories({
  directory: {
    base: "/workspace",
    repos: "Repos",
    workspaces: "Workspaces",
    reviews: "/reviews",
  },
});

describe("Workforest path helpers", () => {
  it("builds repository, workspace, review, and task paths", () => {
    expect(getWorktreePath(roots, "workforest", "cli-redesign")).toBe(
      path.join("/workspace", "Repos", "workforest", "cli-redesign"),
    );
    expect(getWorkspacePath(roots, "vercel-agent", "auth-fix")).toBe(
      path.join("/workspace", "Workspaces", "vercel-agent", "auth-fix"),
    );
    expect(getWorkspaceRepoPath(roots, "vercel-agent", "auth-fix", "api")).toBe(
      path.join("/workspace", "Workspaces", "vercel-agent", "auth-fix", "api"),
    );
    expect(getReviewRepoPath(roots, "workforest")).toBe(
      path.join("/reviews", "workforest"),
    );
    expect(
      getRepositoryTaskPath(roots, "workforest", "cli-redesign", "parser"),
    ).toBe(
      path.join(
        "/workspace",
        "Repos",
        "workforest",
        "_tasks",
        "cli-redesign",
        "parser",
      ),
    );
    expect(
      getWorkspaceTaskPath(roots, "vercel-agent", "auth-fix", "api", "parser"),
    ).toBe(
      path.join(
        "/workspace",
        "Workspaces",
        "vercel-agent",
        "auth-fix",
        "_tasks",
        "api",
        "parser",
      ),
    );
  });

  it("rejects unsafe path components", () => {
    expect(() => getWorktreePath(roots, "workforest", "../escape")).toThrow(
      "Name",
    );
    expect(() =>
      getWorkspaceRepoPath(roots, "vercel-agent", "auth-fix", "../api"),
    ).toThrow("Repository name");
  });

  it("does not reject contained path components that merely start with dots", () => {
    expect(isPathInsideOrEqual("/workspace", "/workspace/..group")).toBe(true);
    expect(isPathInsideOrEqual("/workspace", "/outside")).toBe(false);
    expect(isPathInsideOrEqual("/workspace", "/workspace/../outside")).toBe(
      false,
    );
  });
});

describe("resolveWorkforestContext", () => {
  it("classifies repository roots", () => {
    expect(
      resolveWorkforestContext(
        path.join("/workspace", "Repos", "workforest"),
        roots,
      ),
    ).toEqual({
      kind: "repository-root",
      repoName: "workforest",
      path: path.join("/workspace", "Repos", "workforest"),
    });
  });

  it("classifies repository changes", () => {
    expect(
      resolveWorkforestContext(
        path.join("/workspace", "Repos", "workforest", "cli-redesign", "src"),
        roots,
      ),
    ).toMatchObject({
      kind: "worktree",
      selector: "workforest/cli-redesign",
      repoName: "workforest",
      changeName: "cli-redesign",
    });
  });

  it("classifies workspace roots and repos", () => {
    expect(
      resolveWorkforestContext(
        path.join("/workspace", "Workspaces", "vercel-agent", "auth-fix"),
        roots,
      ),
    ).toMatchObject({
      kind: "template-workspace",
      selector: "vercel-agent/auth-fix",
    });

    expect(
      resolveWorkforestContext(
        path.join(
          "/workspace",
          "Workspaces",
          "vercel-agent",
          "auth-fix",
          "api",
          "src",
        ),
        roots,
      ),
    ).toMatchObject({
      kind: "workspace-repo",
      selector: "vercel-agent/auth-fix",
      repoName: "api",
    });
  });

  it("does not invent workspace repos from invalid root children", () => {
    expect(
      resolveWorkforestContext(
        path.join(
          "/workspace",
          "Workspaces",
          "vercel-agent",
          "auth-fix",
          ".workforest",
          "logs",
        ),
        roots,
      ),
    ).toMatchObject({
      kind: "template-workspace",
      selector: "vercel-agent/auth-fix",
    });

    expect(
      resolveWorkforestContext(
        path.join(
          "/workspace",
          "Workspaces",
          "vercel-agent",
          "auth-fix",
          "bad repo",
        ),
        roots,
      ),
    ).toMatchObject({
      kind: "template-workspace",
      selector: "vercel-agent/auth-fix",
    });
  });

  it("classifies _adhoc workspaces", () => {
    expect(
      resolveWorkforestContext(
        path.join("/workspace", "Workspaces", "_adhoc", "billing"),
        roots,
      ),
    ).toMatchObject({
      kind: "adhoc-workspace",
      selector: "_adhoc/billing",
    });
  });

  it("classifies reserved nested task paths", () => {
    expect(
      resolveWorkforestContext(
        path.join(
          "/workspace",
          "Repos",
          "workforest",
          "_tasks",
          "cli-redesign",
          "parser",
          "src",
        ),
        roots,
      ),
    ).toMatchObject({
      kind: "nested-task",
      parentKind: "worktree",
      parentSelector: "workforest/cli-redesign",
      taskName: "parser",
    });

    expect(
      resolveWorkforestContext(
        path.join(
          "/workspace",
          "Workspaces",
          "vercel-agent",
          "auth-fix",
          "_tasks",
          "api",
          "parser",
        ),
        roots,
      ),
    ).toMatchObject({
      kind: "nested-task",
      parentKind: "workspace",
      parentSelector: "vercel-agent/auth-fix",
      repoName: "api",
      taskName: "parser",
    });
  });

  it("classifies review checkouts and outside paths", () => {
    expect(
      resolveWorkforestContext(
        path.join("/reviews", "workforest", "pr-1"),
        roots,
      ),
    ).toMatchObject({
      kind: "review-checkout",
      repoName: "workforest",
    });
    expect(resolveWorkforestContext("/tmp/random", roots)).toEqual({
      kind: "outside-workforest",
      path: path.resolve("/tmp/random"),
    });
  });

  it("returns outside context when managed path metadata is invalid", () => {
    expect(
      resolveWorkforestContext(
        path.join("/workspace", "Repos", "bad repo", "cli-redesign"),
        roots,
      ),
    ).toEqual({
      kind: "outside-workforest",
      path: path.join("/workspace", "Repos", "bad repo", "cli-redesign"),
    });

    expect(
      resolveWorkforestContext(path.join("/reviews", "bad repo"), roots),
    ).toEqual({
      kind: "outside-workforest",
      path: path.join("/reviews", "bad repo"),
    });
  });
});
