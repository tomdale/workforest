import { describe, expect, it, vi } from "vitest";
import { printRepoSetupFailures } from "./index.ts";

describe("workspace stamping output", () => {
  it("prints setup failures to stdout", () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    printRepoSetupFailures([
      {
        repoName: "front",
        step: "initializer:Turbo link",
        message: "turbo link --yes failed to start: command not found (turbo)",
        logPath: "/workspace/.workforest/logs/front.log",
        logExcerpt: "[initializer:Turbo link] turbo link --yes",
      },
    ]);

    const output = writes.join("");

    expect(output).toContain("Some repositories did not complete setup");
    expect(output).toContain("front");
    expect(output).toContain("Step: initializer:Turbo link");
    expect(output).toContain("command not found");
    expect(output).toContain("/workspace/.workforest/logs/front.log");
  });
});
