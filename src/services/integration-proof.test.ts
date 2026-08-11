import { describe, expect, it, vi } from "vitest";
import {
  type IntegrationProof,
  integrationProofToBoolean,
  isProvenIntegrated,
  proveIntegration,
} from "./integration-proof.ts";

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PR_HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const EXTRA = "dddddddddddddddddddddddddddddddddddddddd";

describe("proveIntegration", () => {
  it("proves integration when on the default branch", async () => {
    const runGit = vi.fn();
    const runGh = vi.fn();

    const proof = await proveIntegration({
      cwd: "/repo",
      base: "origin/main",
      branch: "main",
      defaultBranch: "main",
      runGit,
      runGh,
    });

    expect(proof).toEqual({
      status: "integrated",
      method: "default-branch",
    });
    expect(runGit).not.toHaveBeenCalled();
    expect(runGh).not.toHaveBeenCalled();
  });

  it("proves integration via ancestry without calling gh", async () => {
    const runGit = gitMock({
      ancestor: true,
    });
    const runGh = vi.fn();

    const proof = await proveIntegration({
      cwd: "/repo",
      base: "origin/main",
      branch: "feature",
      defaultBranch: "main",
      runGit,
      runGh,
    });

    expect(proof).toEqual({ status: "integrated", method: "ancestor" });
    expect(runGh).not.toHaveBeenCalled();
    expect(runGit).toHaveBeenCalledWith(
      ["merge-base", "--is-ancestor", "HEAD", "origin/main"],
      { cwd: "/repo" },
    );
  });

  it("proves integration via merged PR matched by branch name", async () => {
    const runGit = gitMock({
      ancestor: false,
      headSha: HEAD,
      originUrl: "git@github.com:acme/widgets.git",
      // local HEAD is the PR head (not strictly ahead)
      aheadOf: {},
    });
    const runGh = vi.fn(async (args: string[]) => {
      if (args[0] === "pr" && args.includes("--head")) {
        return {
          stdout: JSON.stringify([
            {
              number: 42,
              url: "https://github.com/acme/widgets/pull/42",
              headRefOid: HEAD,
            },
          ]),
          stderr: "",
        };
      }
      throw new Error(`unexpected gh ${args.join(" ")}`);
    });

    const proof = await proveIntegration({
      cwd: "/repo",
      base: "origin/main",
      branch: "feature",
      defaultBranch: "main",
      runGit,
      runGh,
    });

    expect(proof).toEqual({
      status: "integrated",
      method: "github-pr",
      detail: "#42",
    });
  });

  it("proves integration via merged PR whose head SHA equals local HEAD", async () => {
    const runGit = gitMock({
      ancestor: false,
      headSha: HEAD,
      originUrl: "https://github.com/acme/widgets.git",
    });
    const runGh = vi.fn(async (args: string[]) => {
      // No branch-name PR (or branch unknown path uses commit API).
      if (args[0] === "pr") {
        return { stdout: "[]", stderr: "" };
      }
      if (args[0] === "api" && String(args[1]).includes("/commits/")) {
        return {
          stdout: JSON.stringify([
            {
              number: 99,
              url: "https://github.com/acme/widgets/pull/99",
              headRefOid: HEAD,
            },
          ]),
          stderr: "",
        };
      }
      throw new Error(`unexpected gh ${args.join(" ")}`);
    });

    const proof = await proveIntegration({
      cwd: "/repo",
      base: "origin/main",
      branch: "feature",
      defaultBranch: "main",
      runGit,
      runGh,
    });

    expect(proof).toEqual({
      status: "integrated",
      method: "github-pr",
      detail: "#99",
    });
  });

  it("proves integration via commit SHA when branch is unknown", async () => {
    const runGit = gitMock({
      ancestor: false,
      headSha: HEAD,
      originUrl: "git@github.com:acme/widgets.git",
    });
    const runGh = vi.fn(async (args: string[]) => {
      if (args[0] === "api") {
        return {
          stdout: JSON.stringify([
            {
              number: 7,
              url: "https://github.com/acme/widgets/pull/7",
              headRefOid: HEAD,
            },
          ]),
          stderr: "",
        };
      }
      throw new Error(`unexpected gh ${args.join(" ")}`);
    });

    const proof = await proveIntegration({
      cwd: "/repo",
      base: "origin/main",
      branch: null,
      defaultBranch: "main",
      runGit,
      runGh,
    });

    expect(proof).toEqual({
      status: "integrated",
      method: "github-pr",
      detail: "#7",
    });
  });

  it("enforces Rule C: branch-name-only match refuses when HEAD is strictly ahead of PR head", async () => {
    const runGit = gitMock({
      ancestor: false,
      headSha: EXTRA,
      originUrl: "git@github.com:acme/widgets.git",
      // EXTRA is strictly ahead of PR_HEAD
      aheadOf: { [PR_HEAD]: true },
    });
    const runGh = vi.fn(async (args: string[]) => {
      if (args[0] === "pr") {
        return {
          stdout: JSON.stringify([
            {
              number: 12,
              url: "https://github.com/acme/widgets/pull/12",
              headRefOid: PR_HEAD,
            },
          ]),
          stderr: "",
        };
      }
      throw new Error(`unexpected gh ${args.join(" ")}`);
    });

    const proof = await proveIntegration({
      cwd: "/repo",
      base: "origin/main",
      branch: "feature",
      defaultBranch: "main",
      runGit,
      runGh,
    });

    expect(proof).toEqual({
      status: "not-integrated",
      method: "rule-c",
      detail: "#12",
    });
    expect(isProvenIntegrated(proof)).toBe(false);
    // Should not fall through to commit API after Rule C refusal.
    expect(runGh.mock.calls.some((call) => call[0][0] === "api")).toBe(false);
  });

  it("accepts branch-name match when HEAD is the PR head (not ahead)", async () => {
    const runGit = gitMock({
      ancestor: false,
      headSha: PR_HEAD,
      originUrl: "git@github.com:acme/widgets.git",
      aheadOf: {},
    });
    const runGh = vi.fn(async (args: string[]) => {
      if (args[0] === "pr") {
        return {
          stdout: JSON.stringify([
            {
              number: 12,
              url: "https://github.com/acme/widgets/pull/12",
              headRefOid: PR_HEAD,
            },
          ]),
          stderr: "",
        };
      }
      throw new Error(`unexpected gh ${args.join(" ")}`);
    });

    const proof = await proveIntegration({
      cwd: "/repo",
      base: "origin/main",
      branch: "feature",
      defaultBranch: "main",
      runGit,
      runGh,
    });

    expect(proof).toEqual({
      status: "integrated",
      method: "github-pr",
      detail: "#12",
    });
  });

  it("accepts branch-name match when HEAD is behind the PR head", async () => {
    const runGit = gitMock({
      ancestor: false,
      headSha: HEAD,
      originUrl: "git@github.com:acme/widgets.git",
      // HEAD is not a descendant of PR_HEAD in the ahead sense
      aheadOf: {},
    });
    const runGh = vi.fn(async (args: string[]) => {
      if (args[0] === "pr") {
        return {
          stdout: JSON.stringify([
            {
              number: 15,
              url: "https://github.com/acme/widgets/pull/15",
              headRefOid: PR_HEAD,
            },
          ]),
          stderr: "",
        };
      }
      throw new Error(`unexpected gh ${args.join(" ")}`);
    });

    const proof = await proveIntegration({
      cwd: "/repo",
      base: "origin/main",
      branch: "feature",
      defaultBranch: "main",
      runGit,
      runGh,
    });

    expect(proof).toEqual({
      status: "integrated",
      method: "github-pr",
      detail: "#15",
    });
  });

  it("returns unknown when gh is unavailable after ancestry fails", async () => {
    const runGit = gitMock({
      ancestor: false,
      headSha: HEAD,
      originUrl: "git@github.com:acme/widgets.git",
    });
    const runGh = vi.fn(async () => {
      throw new Error("spawn gh ENOENT");
    });

    const proof = await proveIntegration({
      cwd: "/repo",
      base: "origin/main",
      branch: "feature",
      defaultBranch: "main",
      runGit,
      runGh,
    });

    expect(proof.status).toBe("unknown");
    if (proof.status === "unknown") {
      expect(proof.reason).toBe("gh-unavailable");
    }
    expect(integrationProofToBoolean(proof)).toBe(false);
  });

  it("returns unknown on gh API errors", async () => {
    const runGit = gitMock({
      ancestor: false,
      headSha: HEAD,
      originUrl: "git@github.com:acme/widgets.git",
    });
    const runGh = vi.fn(async () => {
      throw new Error("gh pr list exited with code 1. GraphQL error");
    });

    const proof = await proveIntegration({
      cwd: "/repo",
      base: "origin/main",
      branch: "feature",
      defaultBranch: "main",
      runGit,
      runGh,
    });

    expect(proof).toMatchObject({
      status: "unknown",
      reason: "gh-error",
    });
  });

  it("returns not-integrated for non-GitHub remotes after ancestry fails", async () => {
    const runGit = gitMock({
      ancestor: false,
      headSha: HEAD,
      originUrl: "git@gitlab.com:acme/widgets.git",
    });
    const runGh = vi.fn();

    const proof = await proveIntegration({
      cwd: "/repo",
      base: "origin/main",
      branch: "feature",
      defaultBranch: "main",
      runGit,
      runGh,
    });

    expect(proof).toEqual({
      status: "not-integrated",
      method: "ancestor",
      detail: "non-github-remote",
    });
    expect(runGh).not.toHaveBeenCalled();
  });

  it("returns not-integrated when no PR proof is found", async () => {
    const runGit = gitMock({
      ancestor: false,
      headSha: HEAD,
      originUrl: "git@github.com:acme/widgets.git",
    });
    const runGh = vi.fn(async (args: string[]) => {
      if (args[0] === "pr" || args[0] === "api") {
        return { stdout: "[]", stderr: "" };
      }
      throw new Error(`unexpected gh ${args.join(" ")}`);
    });

    const proof = await proveIntegration({
      cwd: "/repo",
      base: "origin/main",
      branch: "feature",
      defaultBranch: "main",
      runGit,
      runGh,
    });

    expect(proof).toEqual({ status: "not-integrated", method: "ancestor" });
  });

  it("returns unknown when base is empty", async () => {
    const proof = await proveIntegration({
      cwd: "/repo",
      base: "  ",
      branch: "feature",
      defaultBranch: "main",
      runGit: vi.fn(),
      runGh: vi.fn(),
    });

    expect(proof).toEqual({ status: "unknown", reason: "no-base" });
    expect(integrationProofToBoolean(proof)).toBeNull();
  });

  it("uses an explicit headRef for task/cleanup callers", async () => {
    const runGit = gitMock({
      ancestor: true,
      headRef: "tomdale/task-fix",
    });

    const proof = await proveIntegration({
      cwd: "/parent",
      base: "HEAD",
      branch: "tomdale/task-fix",
      headRef: "tomdale/task-fix",
      runGit,
      runGh: vi.fn(),
    });

    expect(proof).toEqual({ status: "integrated", method: "ancestor" });
    expect(runGit).toHaveBeenCalledWith(
      ["merge-base", "--is-ancestor", "tomdale/task-fix", "HEAD"],
      { cwd: "/parent" },
    );
  });
});

describe("integrationProofToBoolean", () => {
  it.each<[IntegrationProof, boolean | null]>([
    [{ status: "integrated", method: "ancestor" }, true],
    [{ status: "integrated", method: "github-pr", detail: "#1" }, true],
    [{ status: "not-integrated", method: "ancestor" }, false],
    [{ status: "not-integrated", method: "rule-c", detail: "#1" }, false],
    [{ status: "unknown", reason: "no-base" }, null],
    [{ status: "unknown", reason: "gh-unavailable" }, false],
    [{ status: "unknown", reason: "gh-error" }, false],
  ])("maps %j → %s", (proof, expected) => {
    expect(integrationProofToBoolean(proof)).toBe(expected);
  });
});

function gitMock(options: {
  ancestor?: boolean;
  headSha?: string;
  headRef?: string;
  originUrl?: string;
  /** Map of candidate ancestor SHA → whether it is an ancestor of HEAD. */
  aheadOf?: Record<string, boolean>;
}) {
  return vi.fn(async (args: string[]) => {
    if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
      const maybeAncestor = args[2] ?? "";
      const descendant = args[3] ?? "";
      // Standard ancestry check against base.
      if (
        (maybeAncestor === "HEAD" ||
          maybeAncestor === options.headRef ||
          maybeAncestor === options.headSha) &&
        (descendant === "origin/main" || descendant === "HEAD")
      ) {
        if (options.ancestor) {
          return { stdout: "", stderr: "" };
        }
        throw new Error("not an ancestor");
      }
      // Rule C: is PR head an ancestor of local head?
      if (descendant === (options.headSha ?? "HEAD")) {
        if (options.aheadOf?.[maybeAncestor]) {
          return { stdout: "", stderr: "" };
        }
        throw new Error("not an ancestor");
      }
      throw new Error(`unexpected merge-base ${args.join(" ")}`);
    }
    if (args[0] === "rev-parse") {
      return { stdout: `${options.headSha ?? HEAD}\n`, stderr: "" };
    }
    if (args[0] === "config" && args[1] === "--get") {
      if (!options.originUrl) {
        throw new Error("no remote");
      }
      return { stdout: `${options.originUrl}\n`, stderr: "" };
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  });
}
