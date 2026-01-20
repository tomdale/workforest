import { beforeEach, describe, expect, it, vi } from "vitest";
import { getNodeVersionPrefix } from "./node-version.ts";

vi.mock("node:fs", () => ({
  promises: {
    readFile: vi.fn(),
  },
}));

vi.mock("./exec.ts", () => ({
  runCommand: vi.fn(),
}));

import { promises as fs } from "node:fs";
import { runCommand } from "./exec.ts";

const mockReadFile = vi.mocked(fs.readFile);
const mockRunCommand = vi.mocked(runCommand);

describe("getNodeVersionPrefix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when package.json does not exist", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    const result = await getNodeVersionPrefix("/some/dir");

    expect(result).toBeNull();
  });

  it("returns null when package.json has no engines field", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ name: "test" }));

    const result = await getNodeVersionPrefix("/some/dir");

    expect(result).toBeNull();
  });

  it("returns null when package.json has engines but no node field", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ name: "test", engines: { npm: ">=8" } }),
    );

    const result = await getNodeVersionPrefix("/some/dir");

    expect(result).toBeNull();
  });

  it("returns null when current Node version satisfies the requirement", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ engines: { node: ">=18" } }),
    );

    const result = await getNodeVersionPrefix("/some/dir");

    expect(result).toBeNull();
  });

  it("returns fnm prefix when fnm is available and version does not match", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ engines: { node: ">=99" } }),
    );
    mockRunCommand.mockImplementation((cmd, args) => {
      if (cmd === "command" && args[0] === "-v" && args[1] === "fnm") {
        return Promise.resolve({ stdout: "/usr/bin/fnm", stderr: "" });
      }
      return Promise.reject(new Error("not found"));
    });

    const result = await getNodeVersionPrefix("/some/dir");

    expect(result).toEqual({ command: "fnm", args: ["exec", "--"] });
  });

  it("returns asdf prefix when asdf is available and fnm is not", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ engines: { node: ">=99" } }),
    );
    mockRunCommand.mockImplementation((cmd, args) => {
      if (cmd === "command" && args[0] === "-v" && args[1] === "asdf") {
        return Promise.resolve({ stdout: "/usr/bin/asdf", stderr: "" });
      }
      return Promise.reject(new Error("not found"));
    });

    const result = await getNodeVersionPrefix("/some/dir");

    expect(result).toEqual({ command: "asdf", args: ["exec"] });
  });

  it("prefers fnm over asdf when both are available", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ engines: { node: ">=99" } }),
    );
    mockRunCommand.mockImplementation((cmd, args) => {
      if (cmd === "command" && args[0] === "-v") {
        return Promise.resolve({ stdout: `/usr/bin/${args[1]}`, stderr: "" });
      }
      return Promise.reject(new Error("not found"));
    });

    const result = await getNodeVersionPrefix("/some/dir");

    expect(result).toEqual({ command: "fnm", args: ["exec", "--"] });
  });

  it("returns null when no version manager is found", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ engines: { node: ">=99" } }),
    );
    mockRunCommand.mockRejectedValue(new Error("not found"));

    const result = await getNodeVersionPrefix("/some/dir");

    expect(result).toBeNull();
  });

  it("reads package.json from the correct path", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ name: "test" }));

    await getNodeVersionPrefix("/my/project/dir");

    expect(mockReadFile).toHaveBeenCalledWith(
      "/my/project/dir/package.json",
      "utf8",
    );
  });
});
