import { describe, expect, it, vi } from "vitest";
import type { RepoConfig } from "../types.ts";
import { cloudRepoPipelineGenerator } from "./provisioning.ts";
import type { CloudSandbox, StreamCommand } from "./vercel-sandbox.ts";

type RecordedCommand = StreamCommand & { detached?: true };

function sandboxRecorder(commands: RecordedCommand[]): CloudSandbox {
  return {
    runCommand: vi.fn(async (command: RecordedCommand) => {
      commands.push(command);
      return {
        async *logs() {},
        wait: async () => ({ exitCode: 0 }),
      };
    }),
  } as unknown as CloudSandbox;
}

async function drain(generator: AsyncGenerator<unknown>): Promise<void> {
  for await (const _state of generator) {
    // Consume every state so each command runs.
  }
}

const repo: RepoConfig = {
  name: "web",
  remote: "git@github.com:vercel/web.git",
  defaultBranch: "trunk",
};

describe("cloudRepoPipelineGenerator", () => {
  it("resets forked workspaces to the latest remote default branch", async () => {
    const commands: RecordedCommand[] = [];

    await drain(
      cloudRepoPipelineGenerator({
        sandbox: sandboxRecorder(commands),
        repo,
        branchName: "tomdale/cloud-fix",
        mode: "forked",
        vercelEnvEnabled: false,
      }),
    );

    expect(commands.slice(0, 2)).toEqual([
      {
        cmd: "git",
        args: ["fetch", "origin", "trunk"],
        cwd: "/vercel/sandbox/web",
        detached: true,
      },
      {
        cmd: "git",
        args: ["checkout", "-B", "tomdale/cloud-fix", "origin/trunk"],
        cwd: "/vercel/sandbox/web",
        detached: true,
      },
    ]);
  });
});
