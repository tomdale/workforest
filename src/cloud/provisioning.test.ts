import { describe, expect, it, vi } from "vitest";
import { OperationalError } from "../cli/errors.ts";
import type { ServiceEvent } from "../services/events.ts";
import type { RepositorySource } from "../types.ts";
import {
  cloudRepoPipeline,
  finalizeCloudProvisioning,
} from "./provisioning.ts";
import type { CloudSandbox, StreamCommand } from "./vercel-sandbox.ts";

type RecordedCommand = StreamCommand & { detached?: true };

type CommandResult = { output?: string; exitCode?: number };

/**
 * A fake sandbox that records every command. `respond` lets a test supply
 * streamed stdout and/or a non-zero exit for a given command (used to simulate
 * `git ls-remote --symref` reporting the remote's default branch); by default
 * commands emit no output and succeed.
 */
function sandboxRecorder(
  commands: RecordedCommand[],
  respond: (command: RecordedCommand) => CommandResult = () => ({}),
): CloudSandbox {
  return {
    runCommand: vi.fn(async (command: RecordedCommand) => {
      commands.push(command);
      const { output, exitCode = 0 } = respond(command);
      return {
        async *logs() {
          if (output) yield { data: output };
        },
        wait: async () => ({ exitCode }),
      };
    }),
  } as unknown as CloudSandbox;
}

/** The stdout `git ls-remote --symref <url> HEAD` prints for a default branch. */
function symrefHead(branch: string): string {
  return `ref: refs/heads/${branch}\tHEAD\n0000000000000000000000000000000000000000\tHEAD\n`;
}

function isLsRemote(command: RecordedCommand): boolean {
  return command.cmd === "git" && command.args?.[0] === "ls-remote";
}

async function drain(generator: AsyncGenerator<unknown>): Promise<void> {
  for await (const _state of generator) {
    // Consume every state so each command runs.
  }
}

const repo: RepositorySource = {
  name: "web",
  remote: "git@github.com:vercel/web.git",
};

describe("cloudRepoPipeline", () => {
  const cloneUrl = "https://github.com/vercel/web.git";

  it("probes the remote HEAD before touching the repo", async () => {
    const commands: RecordedCommand[] = [];

    await drain(
      cloudRepoPipeline({
        sandbox: sandboxRecorder(commands),
        repo,
        branchName: "tomdale/cloud-fix",
        mode: "forked",
        vercelEnvEnabled: false,
      }),
    );

    expect(commands[0]).toEqual({
      cmd: "git",
      args: ["ls-remote", "--symref", cloneUrl, "HEAD"],
      cwd: "/vercel/sandbox",
      detached: true,
    });
  });

  it("forks off the detected default branch, not the configured one", async () => {
    const commands: RecordedCommand[] = [];
    const respond = (command: RecordedCommand): CommandResult =>
      isLsRemote(command) ? { output: symrefHead("master") } : {};

    await drain(
      cloudRepoPipeline({
        sandbox: sandboxRecorder(commands, respond),
        repo,
        branchName: "tomdale/cloud-fix",
        mode: "forked",
        vercelEnvEnabled: false,
      }),
    );

    expect(commands.slice(1, 3)).toEqual([
      {
        cmd: "git",
        args: ["fetch", "origin", "master"],
        cwd: "/vercel/sandbox/web",
        detached: true,
      },
      {
        cmd: "git",
        args: ["checkout", "-B", "tomdale/cloud-fix", "origin/master"],
        cwd: "/vercel/sandbox/web",
        detached: true,
      },
    ]);
  });

  it("clones the detected default branch for a cold repo", async () => {
    const commands: RecordedCommand[] = [];
    const respond = (command: RecordedCommand): CommandResult =>
      isLsRemote(command) ? { output: symrefHead("canary") } : {};

    await drain(
      cloudRepoPipeline({
        sandbox: sandboxRecorder(commands, respond),
        repo,
        branchName: "tomdale/cloud-fix",
        mode: "cold",
        vercelEnvEnabled: false,
      }),
    );

    expect(commands.slice(1, 3)).toEqual([
      {
        cmd: "git",
        args: ["clone", "--branch", "canary", cloneUrl, "web"],
        cwd: "/vercel/sandbox",
        detached: true,
      },
      {
        cmd: "git",
        args: ["checkout", "-B", "tomdale/cloud-fix"],
        cwd: "/vercel/sandbox/web",
        detached: true,
      },
    ]);
  });

  it("falls back to the configured branch when detection fails", async () => {
    const commands: RecordedCommand[] = [];
    // ls-remote exits non-zero and prints nothing → detection is inconclusive.
    const respond = (command: RecordedCommand): CommandResult =>
      isLsRemote(command) ? { exitCode: 128 } : {};

    await drain(
      cloudRepoPipeline({
        sandbox: sandboxRecorder(commands, respond),
        repo,
        branchName: "tomdale/cloud-fix",
        mode: "forked",
        vercelEnvEnabled: false,
      }),
    );

    expect(commands.slice(1, 3)).toEqual([
      {
        cmd: "git",
        args: ["fetch", "origin", "main"],
        cwd: "/vercel/sandbox/web",
        detached: true,
      },
      {
        cmd: "git",
        args: ["checkout", "-B", "tomdale/cloud-fix", "origin/main"],
        cwd: "/vercel/sandbox/web",
        detached: true,
      },
    ]);
  });

  it("falls back to the default branch when the symref is unparseable", async () => {
    const commands: RecordedCommand[] = [];
    const respond = (command: RecordedCommand): CommandResult =>
      isLsRemote(command) ? { output: "not a symref line\n" } : {};

    await drain(
      cloudRepoPipeline({
        sandbox: sandboxRecorder(commands, respond),
        repo,
        branchName: "tomdale/cloud-fix",
        mode: "forked",
        vercelEnvEnabled: false,
      }),
    );

    expect(commands.slice(1, 3)).toEqual([
      {
        cmd: "git",
        args: ["fetch", "origin", "main"],
        cwd: "/vercel/sandbox/web",
        detached: true,
      },
      {
        cmd: "git",
        args: ["checkout", "-B", "tomdale/cloud-fix", "origin/main"],
        cwd: "/vercel/sandbox/web",
        detached: true,
      },
    ]);
  });
});

/** Build a fake sandbox exposing only what finalization touches (domain/delete). */
function finalizeSandbox(deleteImpl: () => Promise<void> = async () => {}): {
  sandbox: CloudSandbox;
  deleteSpy: ReturnType<typeof vi.fn>;
} {
  const deleteSpy = vi.fn(deleteImpl);
  const sandbox = {
    domain: (port: number) => `https://web-${port}.example.dev`,
    delete: deleteSpy,
    stop: vi.fn(async () => {}),
  } as unknown as CloudSandbox;
  return { sandbox, deleteSpy };
}

/** Only message events carry the success/warning signal finalization emits. */
function messagesOf(
  events: ServiceEvent[],
): Extract<ServiceEvent, { type: "message" }>[] {
  return events.filter(
    (event): event is Extract<ServiceEvent, { type: "message" }> =>
      event.type === "message",
  );
}

function completed(...names: string[]): Map<string, { hasLockfile: boolean }> {
  return new Map(
    names.map((name): [string, { hasLockfile: boolean }] => [
      name,
      { hasLockfile: true },
    ]),
  );
}

describe("finalizeCloudProvisioning", () => {
  it("reports ready without a warning when every repo completed", async () => {
    const { sandbox, deleteSpy } = finalizeSandbox();
    const events: ServiceEvent[] = [];

    await finalizeCloudProvisioning({
      sandbox,
      changeName: "fix-cloud",
      ports: [3000],
      repoNames: ["web", "api"],
      completed: completed("web", "api"),
      onEvent: (event) => events.push(event),
    });

    const messages = messagesOf(events);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(messages.some((event) => event.level === "success")).toBe(true);
    expect(messages.some((event) => event.level === "warning")).toBe(false);
  });

  it("reports ready but warns about the repos that failed", async () => {
    const { sandbox, deleteSpy } = finalizeSandbox();
    const events: ServiceEvent[] = [];

    await finalizeCloudProvisioning({
      sandbox,
      changeName: "fix-cloud",
      ports: [3000],
      repoNames: ["web", "api"],
      completed: completed("web"),
      onEvent: (event) => events.push(event),
    });

    const messages = messagesOf(events);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(messages.some((event) => event.level === "success")).toBe(true);
    const warning = messages.find((event) => event.level === "warning");
    expect(warning?.message).toContain("api");
  });

  it("tears down the sandbox and throws when every repo failed", async () => {
    const { sandbox, deleteSpy } = finalizeSandbox();
    const events: ServiceEvent[] = [];

    await expect(
      finalizeCloudProvisioning({
        sandbox,
        changeName: "fix-cloud",
        ports: [3000],
        repoNames: ["web", "api"],
        completed: new Map(),
        onEvent: (event) => events.push(event),
      }),
    ).rejects.toBeInstanceOf(OperationalError);

    expect(deleteSpy).toHaveBeenCalledTimes(1);
    // reportReady never ran, so no "provisioned" success event was emitted.
    expect(messagesOf(events).some((event) => event.level === "success")).toBe(
      false,
    );
  });

  it("still throws the provisioning failure when teardown itself fails", async () => {
    const { sandbox, deleteSpy } = finalizeSandbox(async () => {
      throw new Error("teardown boom");
    });

    await expect(
      finalizeCloudProvisioning({
        sandbox,
        changeName: "fix-cloud",
        ports: [3000],
        repoNames: ["web"],
        completed: new Map(),
        onEvent: undefined,
      }),
    ).rejects.toBeInstanceOf(OperationalError);

    expect(deleteSpy).toHaveBeenCalledTimes(1);
  });
});
