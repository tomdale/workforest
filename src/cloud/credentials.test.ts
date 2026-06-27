import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceConfig } from "../types.ts";

type Auth = {
  token?: string;
  refreshToken?: string;
  expiresAt?: Date;
} | null;
type TokenSet = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
};

// Controlled per test; the `mock` prefix lets the hoisted vi.mock factory read them.
let mockAuth: Auth = null;
let mockRefresh: (token: string) => Promise<TokenSet> = async () => {
  throw new Error("refresh not configured");
};
let mockUpdated: unknown;

vi.mock("@vercel/sandbox/dist/auth/index.js", () => ({
  getAuth: () => mockAuth,
  OAuth: async () => ({ refreshToken: (t: string) => mockRefresh(t) }),
  updateAuthConfig: (config: unknown) => {
    mockUpdated = config;
  },
}));

const { resolveCloudCredentials } = await import("./credentials.ts");

const ENV_KEYS = ["VERCEL_TOKEN", "VERCEL_OIDC_TOKEN"] as const;
const original = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) original.set(key, process.env[key]);
  for (const key of ENV_KEYS) delete process.env[key];
  mockAuth = null;
  mockUpdated = undefined;
  mockRefresh = async () => {
    throw new Error("refresh not configured");
  };
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const configured: WorkspaceConfig = {
  cloud: { vercel: { team: "acme", project: "site" } },
};

describe("resolveCloudCredentials", () => {
  it("returns the env token with team/project slugs as scope", async () => {
    process.env["VERCEL_TOKEN"] = "vc_pat";
    expect(await resolveCloudCredentials(configured)).toEqual({
      token: "vc_pat",
      teamId: "acme",
      projectId: "site",
    });
  });

  it("falls back to VERCEL_OIDC_TOKEN, then to the vercel CLI login", async () => {
    process.env["VERCEL_OIDC_TOKEN"] = "oidc_jwt";
    expect((await resolveCloudCredentials(configured)).token).toBe("oidc_jwt");

    delete process.env["VERCEL_OIDC_TOKEN"];
    mockAuth = {
      token: "cli_token",
      expiresAt: new Date(Date.now() + 3_600_000),
    };
    expect((await resolveCloudCredentials(configured)).token).toBe("cli_token");
  });

  it("uses a login token with no expiry (a PAT in auth.json) as-is", async () => {
    mockAuth = { token: "stored_pat" };
    expect((await resolveCloudCredentials(configured)).token).toBe(
      "stored_pat",
    );
  });

  it("refreshes an expired login token via its refresh token and persists it", async () => {
    mockAuth = {
      token: "stale",
      refreshToken: "rt",
      expiresAt: new Date(Date.now() - 1000),
    };
    mockRefresh = async (t) => {
      expect(t).toBe("rt");
      return { access_token: "fresh", expires_in: 3600, refresh_token: "rt2" };
    };
    expect((await resolveCloudCredentials(configured)).token).toBe("fresh");
    expect(mockUpdated).toMatchObject({ token: "fresh", refreshToken: "rt2" });
  });

  it("errors when the login token is expired and cannot be refreshed", async () => {
    mockAuth = { token: "stale", expiresAt: new Date(Date.now() - 1000) };
    await expect(resolveCloudCredentials(configured)).rejects.toThrow(
      /No Vercel token/,
    );
  });

  it("requires team and project to be configured", async () => {
    await expect(resolveCloudCredentials({})).rejects.toThrow(
      /team and project/,
    );
    await expect(
      resolveCloudCredentials({ cloud: { vercel: { team: "acme" } } }),
    ).rejects.toThrow(/team and project/);
    await expect(
      resolveCloudCredentials({ cloud: { vercel: { project: "site" } } }),
    ).rejects.toThrow(/team and project/);
  });

  it("errors when no token is available anywhere", async () => {
    await expect(resolveCloudCredentials(configured)).rejects.toThrow(
      /No Vercel token/,
    );
  });
});
