import { describe, expect, it } from "vitest";
import type { WorkspaceConfig } from "../types.ts";
import { httpsCloneUrl, resolveVercelTeam } from "./vercel-team.ts";

describe("resolveVercelTeam", () => {
  it("prefers an explicit cloud.vercel.team", () => {
    const config: WorkspaceConfig = { cloud: { vercel: { team: "acme" } } };
    expect(resolveVercelTeam("git@github.com:vercel/web.git", config)).toBe(
      "acme",
    );
  });

  it("falls back to built-in owner mappings", () => {
    expect(resolveVercelTeam("git@github.com:vercel/web.git", {})).toBe(
      "vercel",
    );
    expect(resolveVercelTeam("https://github.com/vercel-labs/x.git", {})).toBe(
      "vercel-labs",
    );
  });

  it("honors per-repo overrides and disabling", () => {
    const config: WorkspaceConfig = {
      vercelLink: {
        repoOverrides: {
          "acme/site": { team: "acme-team" },
          "acme/secret": { disabled: true },
        },
      },
    };
    expect(resolveVercelTeam("git@github.com:acme/site.git", config)).toBe(
      "acme-team",
    );
    expect(
      resolveVercelTeam("git@github.com:acme/secret.git", config),
    ).toBeUndefined();
  });

  it("returns undefined for unmapped owners and non-GitHub remotes", () => {
    expect(
      resolveVercelTeam("git@github.com:unknown/x.git", {}),
    ).toBeUndefined();
    expect(
      resolveVercelTeam("git@gitlab.com:vercel/x.git", {}),
    ).toBeUndefined();
  });
});

describe("httpsCloneUrl", () => {
  it("rewrites SSH and https GitHub remotes to a canonical https URL", () => {
    expect(httpsCloneUrl("git@github.com:vercel/web.git")).toBe(
      "https://github.com/vercel/web.git",
    );
    expect(httpsCloneUrl("https://github.com/vercel/web")).toBe(
      "https://github.com/vercel/web.git",
    );
  });

  it("passes through non-GitHub remotes unchanged", () => {
    expect(httpsCloneUrl("git@gitlab.com:vercel/web.git")).toBe(
      "git@gitlab.com:vercel/web.git",
    );
  });
});
