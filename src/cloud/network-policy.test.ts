import { describe, expect, it } from "vitest";
import { buildNetworkPolicy } from "./vercel-sandbox.ts";

describe("buildNetworkPolicy (credential brokering)", () => {
  it("keeps open egress with a catch-all and no transforms by default", () => {
    const policy = buildNetworkPolicy({});
    expect(policy).toEqual({ allow: { "*": [] } });
  });

  it("brokers a GitHub token as Basic x-access-token auth", () => {
    const policy = buildNetworkPolicy({ githubToken: "ghp_test" });
    if (
      typeof policy === "string" ||
      !policy.allow ||
      Array.isArray(policy.allow)
    ) {
      throw new Error("expected a record-form allow policy");
    }
    const expected = `Basic ${Buffer.from("x-access-token:ghp_test").toString("base64")}`;
    const rule = policy.allow["github.com"]?.[0];
    expect(rule?.transform?.[0]?.headers?.["authorization"]).toBe(expected);
    expect(policy.allow["*.github.com"]).toBeDefined();
    expect(policy.allow["*"]).toEqual([]);
  });

  it("brokers a Vercel token as Bearer auth for the API host", () => {
    const policy = buildNetworkPolicy({ vercelToken: "vc_test" });
    if (
      typeof policy === "string" ||
      !policy.allow ||
      Array.isArray(policy.allow)
    ) {
      throw new Error("expected a record-form allow policy");
    }
    const rule = policy.allow["api.vercel.com"]?.[0];
    expect(rule?.transform?.[0]?.headers?.["authorization"]).toBe(
      "Bearer vc_test",
    );
  });
});
