import { describe, expect, it } from "vitest";
import {
  baseSandboxName,
  buildWorkspaceTags,
  changeNameFromSandbox,
  cloudSandboxName,
  decodeCloudSandbox,
  isManagedSandbox,
  isWorkspaceSandboxName,
} from "./tags.ts";

describe("cloud sandbox naming", () => {
  it("namespaces and recovers the change name", () => {
    expect(cloudSandboxName("redesign-cli")).toBe("wf-redesign-cli");
    expect(changeNameFromSandbox("wf-redesign-cli")).toBe("redesign-cli");
  });

  it("treats base sandboxes as non-workspaces", () => {
    expect(isWorkspaceSandboxName(cloudSandboxName("x"))).toBe(true);
    expect(isWorkspaceSandboxName(baseSandboxName("tpl-foo"))).toBe(false);
    expect(isWorkspaceSandboxName("unrelated")).toBe(false);
  });
});

describe("workspace tags", () => {
  it("encodes the managed marker, branch, repos, and optional template", () => {
    const tags = buildWorkspaceTags({
      changeName: "auth-fix",
      branchName: "feature/auth-fix",
      repos: ["web", "api"],
      templateId: "vercel-agent",
    });
    expect(tags).toEqual({
      wf: "1",
      wfBranch: "feature/auth-fix",
      wfRepos: "web,api",
      wfTemplate: "vercel-agent",
    });
  });

  it("omits the template tag when there is none", () => {
    const tags = buildWorkspaceTags({
      changeName: "x",
      branchName: "x",
      repos: ["solo"],
    });
    expect(tags["wfTemplate"]).toBeUndefined();
  });

  it("round-trips through decode", () => {
    const tags = buildWorkspaceTags({
      changeName: "auth-fix",
      branchName: "feature/auth-fix",
      repos: ["web", "api"],
      templateId: "vercel-agent",
    });
    const decoded = decodeCloudSandbox({
      name: cloudSandboxName("auth-fix"),
      status: "running",
      createdAt: 0,
      tags,
    });
    expect(decoded).toEqual({
      name: "wf-auth-fix",
      changeName: "auth-fix",
      branchName: "feature/auth-fix",
      templateId: "vercel-agent",
      repos: ["web", "api"],
      status: "running",
      createdAt: new Date(0).toISOString(),
    });
  });

  it("recognizes the managed marker", () => {
    expect(
      isManagedSandbox({
        name: "wf-x",
        status: "running",
        createdAt: 0,
        tags: { wf: "1" },
      }),
    ).toBe(true);
    expect(
      isManagedSandbox({ name: "wf-x", status: "running", createdAt: 0 }),
    ).toBe(false);
  });
});
