import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudSandbox } from "./vercel-sandbox.ts";

const mockCloud = vi.hoisted(() => ({
  createBaseSandbox: vi.fn(),
  getSandbox: vi.fn(),
  runToCompletion: vi.fn(),
}));

vi.mock("./vercel-sandbox.ts", () => mockCloud);

import { ensureBaseSnapshot } from "./snapshot.ts";

const credentials = {
  token: "token",
  teamId: "team",
  projectId: "project",
};

const repo = {
  name: "web",
  remote: "git@github.com:vercel/web.git",
};

function sandbox(): CloudSandbox {
  return {
    delete: vi.fn(),
    stop: vi.fn(),
    update: vi.fn(),
  } as unknown as CloudSandbox;
}

describe("ensureBaseSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCloud.getSandbox.mockResolvedValue(null);
    mockCloud.runToCompletion.mockResolvedValue(0);
  });

  it("marks a base snapshot fresh only after the build is complete", async () => {
    const base = sandbox();
    mockCloud.createBaseSandbox.mockResolvedValue(base);

    await expect(
      ensureBaseSnapshot({
        group: "tpl-web",
        repos: [repo],
        ttlMs: 1000,
        nowMs: 5000,
        networkPolicy: { allow: {} },
        credentials,
      }),
    ).resolves.toBe("wfbase-tpl-web");

    expect(mockCloud.createBaseSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: {
          wf: "1",
          wfBase: "tpl-web",
        },
      }),
    );
    expect(base.update).toHaveBeenCalledWith({
      tags: {
        wf: "1",
        wfBase: "tpl-web",
        wfBuiltAt: "5000",
      },
    });
  });

  it("deletes a partial base when setup fails", async () => {
    const base = sandbox();
    mockCloud.createBaseSandbox.mockResolvedValue(base);
    mockCloud.runToCompletion.mockResolvedValueOnce(1);

    await expect(
      ensureBaseSnapshot({
        group: "tpl-web",
        repos: [repo],
        ttlMs: 1000,
        nowMs: 5000,
        networkPolicy: { allow: {} },
        credentials,
      }),
    ).resolves.toBeNull();

    expect(base.update).not.toHaveBeenCalled();
    expect(base.delete).toHaveBeenCalled();
  });
});
