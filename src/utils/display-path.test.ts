import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compactHome } from "./display-path.ts";

describe("compactHome", () => {
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    if (homedirSpy) {
      homedirSpy.mockRestore();
    }
  });

  it("contracts exact home directory to ~", () => {
    homedirSpy = vi.spyOn(os, "homedir").mockReturnValue("/Users/alice");
    expect(compactHome("/Users/alice")).toBe("~");
  });

  it("contracts home-relative paths to ~/...", () => {
    homedirSpy = vi.spyOn(os, "homedir").mockReturnValue("/Users/alice");
    expect(compactHome("/Users/alice/projects/my-app")).toBe(
      "~/projects/my-app",
    );
  });

  it("leaves sibling paths unchanged", () => {
    homedirSpy = vi.spyOn(os, "homedir").mockReturnValue("/Users/alice");
    expect(compactHome("/Users/bob/projects/app")).toBe(
      "/Users/bob/projects/app",
    );
  });

  it("leaves non-home paths unchanged", () => {
    homedirSpy = vi.spyOn(os, "homedir").mockReturnValue("/Users/alice");
    expect(compactHome("/var/log/system.log")).toBe("/var/log/system.log");
  });

  it("handles trailing slashes correctly", () => {
    homedirSpy = vi.spyOn(os, "homedir").mockReturnValue("/Users/alice");
    expect(compactHome("/Users/alice/projects")).toBe("~/projects");
  });
});
