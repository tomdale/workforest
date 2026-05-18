import { afterEach, describe, expect, it } from "vitest";
import { createSpawnEnv, mergeShellEnv } from "./spawn-env.ts";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("createSpawnEnv", () => {
  it("returns undefined when no cwd is provided", () => {
    expect(createSpawnEnv()).toBeUndefined();
  });

  it("sets PWD to the child cwd", () => {
    const env = createSpawnEnv("/repo/front");

    expect(env?.["PWD"]).toBe("/repo/front");
  });

  it("uses shell values for cwd-sensitive variables", () => {
    const env = mergeShellEnv(
      {
        PATH: "/tools/runtime-a/bin:/usr/bin",
        TOOL_VERSION: "runtime-a",
      },
      {
        PATH: "/tools/shims:/usr/bin",
        TOOL_HOME: "/home/me/.tool",
      },
      "/repo/front",
    );

    expect(env["PATH"]).toBe("/tools/shims:/usr/bin");
    expect(env["PWD"]).toBe("/repo/front");
    expect(env["TOOL_HOME"]).toBe("/home/me/.tool");
    expect(env["TOOL_VERSION"]).toBeUndefined();
  });

  it("preserves allowlisted parent-only values", () => {
    const env = mergeShellEnv(
      {
        GH_TOKEN: "secret",
        GITHUB_ACTIONS: "true",
        NPM_CONFIG_USERCONFIG: "/tmp/.npmrc",
        SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
        TURBO_TOKEN: "turbo-token",
        VERCEL_TOKEN: "vercel-token",
      },
      {
        PATH: "/tools/shims:/usr/bin",
      },
      "/repo/front",
    );

    expect(env["GH_TOKEN"]).toBe("secret");
    expect(env["GITHUB_ACTIONS"]).toBe("true");
    expect(env["NPM_CONFIG_USERCONFIG"]).toBe("/tmp/.npmrc");
    expect(env["SSH_AUTH_SOCK"]).toBe("/tmp/ssh-agent.sock");
    expect(env["TURBO_TOKEN"]).toBe("turbo-token");
    expect(env["VERCEL_TOKEN"]).toBe("vercel-token");
  });

  it("does not preserve parent-only values outside the allowlist", () => {
    const env = mergeShellEnv(
      {
        API_TOKEN: "secret",
        TOOL_RUNTIME_VERSION: "runtime-a",
        TOOL_VERSION: "runtime-a",
      },
      {
        PATH: "/tools/shims:/usr/bin",
      },
      "/repo/front",
    );

    expect(env["API_TOKEN"]).toBeUndefined();
    expect(env["TOOL_RUNTIME_VERSION"]).toBeUndefined();
    expect(env["TOOL_VERSION"]).toBeUndefined();
  });
});
