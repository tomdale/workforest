import { describe, expect, it } from "vitest";
import { normalizeWorkspaceConfig } from "../configuration-registry.ts";

describe("cloud config normalization", () => {
  it("accepts a full cloud.vercel block", () => {
    const config = normalizeWorkspaceConfig(
      {
        cloud: {
          vercel: {
            team: "vercel",
            project: "my-app",
            vcpus: 4,
            timeoutMs: 14_400_000,
            snapshotTtlMs: 86_400_000,
            ports: [3000, 8000],
            runtime: "node24",
          },
        },
      },
      "/tmp/config.json",
    );
    expect(config.cloud).toEqual({
      vercel: {
        team: "vercel",
        project: "my-app",
        vcpus: 4,
        timeoutMs: 14_400_000,
        snapshotTtlMs: 86_400_000,
        ports: [3000, 8000],
        runtime: "node24",
      },
    });
  });

  it("omits cloud entirely when unset", () => {
    const config = normalizeWorkspaceConfig({}, "/tmp/config.json");
    expect(config.cloud).toBeUndefined();
  });

  it("omits cloud when vercel is empty", () => {
    const config = normalizeWorkspaceConfig(
      { cloud: { vercel: {} } },
      "/tmp/config.json",
    );
    expect(config.cloud).toBeUndefined();
  });

  it("rejects non-positive port entries", () => {
    expect(() =>
      normalizeWorkspaceConfig(
        { cloud: { vercel: { ports: [3000, 0] } } },
        "/tmp/config.json",
      ),
    ).toThrow(/vercel\.ports\[1\] must be a positive integer/);
  });

  it("rejects a non-integer vcpus", () => {
    expect(() =>
      normalizeWorkspaceConfig(
        { cloud: { vercel: { vcpus: 1.5 } } },
        "/tmp/config.json",
      ),
    ).toThrow(/vercel\.vcpus must be a positive integer/);
  });
});
