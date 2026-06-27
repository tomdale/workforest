import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudCredentials } from "./credentials.ts";

const mockSdk = vi.hoisted(() => {
  class MockAPIError extends Error {
    response: Response;

    constructor(status: number) {
      super(`HTTP ${status}`);
      this.response = new Response(null, { status });
    }
  }

  return {
    APIError: MockAPIError,
    Sandbox: {
      get: vi.fn(),
    },
  };
});

vi.mock("@vercel/sandbox", () => mockSdk);

import { deleteSandbox, getSandbox } from "./vercel-sandbox.ts";

const credentials: CloudCredentials = {
  token: "token",
  teamId: "team",
  projectId: "project",
};

describe("vercel sandbox wrapper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null for missing sandboxes", async () => {
    mockSdk.Sandbox.get.mockRejectedValue(new mockSdk.APIError(404));

    await expect(getSandbox("missing", credentials)).resolves.toBeNull();
  });

  it("propagates non-not-found SDK failures", async () => {
    const error = new mockSdk.APIError(401);
    mockSdk.Sandbox.get.mockRejectedValue(error);

    await expect(getSandbox("private", credentials)).rejects.toBe(error);
  });

  it("deletes existing sandboxes", async () => {
    const sandbox = { delete: vi.fn() };
    mockSdk.Sandbox.get.mockResolvedValue(sandbox);

    await expect(deleteSandbox("workspace", credentials)).resolves.toBe(true);

    expect(sandbox.delete).toHaveBeenCalled();
  });
});
