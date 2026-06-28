import { describe, expect, it } from "vitest";
import type { ResolvedSource } from "../workspace/create.ts";
import { baseSnapshotGroup, isSnapshotFresh } from "./snapshot.ts";

const repo = (name: string, remote: string) => ({
  name,
  remote,
  defaultBranch: "main",
});

describe("baseSnapshotGroup", () => {
  it("keys templates on their id", () => {
    const source: ResolvedSource = {
      kind: "template",
      groupName: "vercel-agent",
      templateId: "vercel-agent",
      repos: [repo("web", "git@github.com:vercel/web.git")],
    };
    expect(baseSnapshotGroup(source)).toBe("tpl-vercel-agent");
  });

  it("hashes a repo set stably and independent of order", () => {
    const a: ResolvedSource = {
      kind: "adhoc",
      repos: [
        repo("web", "git@github.com:vercel/web.git"),
        repo("api", "git@github.com:vercel/api.git"),
      ],
    };
    const b: ResolvedSource = {
      kind: "adhoc",
      repos: [
        repo("api", "git@github.com:vercel/api.git"),
        repo("web", "git@github.com:vercel/web.git"),
      ],
    };
    expect(baseSnapshotGroup(a)).toBe(baseSnapshotGroup(b));
    expect(baseSnapshotGroup(a)).toMatch(/^set-[0-9a-f]{10}$/);
  });
});

describe("isSnapshotFresh", () => {
  it("is stale when never built", () => {
    expect(isSnapshotFresh(undefined, 1000, 5000)).toBe(false);
  });

  it("is fresh within the TTL and stale past it", () => {
    expect(isSnapshotFresh(4000, 1000, 4500)).toBe(true);
    expect(isSnapshotFresh(4000, 1000, 5000)).toBe(false);
    expect(isSnapshotFresh(4000, 1000, 5001)).toBe(false);
  });
});
