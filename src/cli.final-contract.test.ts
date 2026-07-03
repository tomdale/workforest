import { describe, expect, it } from "vitest";
import { commandRegistry } from "./cli/commands.ts";
import { parseInvocation } from "./cli/parse-invocation.ts";
import { resolveCommand } from "./cli/resolve-command.ts";
import type { ResolvedCommand } from "./cli/types.ts";

const REQUIRED_COMMANDS: readonly (readonly string[])[] = [
  ["new"],
  ["add"],
  ["switch"],
  ["list"],
  ["status"],
  ["delete"],
  ["migrate", "workspaces"],
  ["task", "new"],
  ["task", "list"],
  ["task", "delete"],
  ["cache", "list"],
  ["cache", "show"],
  ["cache", "sync"],
  ["cache", "doctor"],
  ["cache", "delete"],
  ["cache", "clean"],
  ["cache", "worktree", "list"],
  ["cache", "worktree", "add"],
  ["cache", "worktree", "move"],
  ["cache", "worktree", "remove"],
  ["review"],
  ["template", "open"],
  ["template", "show"],
  ["shell", "init"],
];

describe("final CLI contract", () => {
  it.each(
    REQUIRED_COMMANDS.map((path) => ({ name: path.join(" "), path })),
  )("registers wf $name", ({ path }) => {
    expect(resolve(path)).toMatchObject({
      canonicalPath: path,
    });
  });

  it.each([
    ["task delete", ["task", "delete"]],
    ["cache delete", ["cache", "delete"]],
    ["review", ["review"]],
  ] as const)("%s requires an explicit target", (_name, argv) => {
    expect(() => parseInvocation(resolve(argv))).toThrow(/Invalid operands/);
  });
});

function resolve(argv: readonly string[]): ResolvedCommand {
  const resolution = resolveCommand(commandRegistry, argv);
  if (resolution.kind !== "command") {
    throw new Error(`Expected command resolution for wf ${argv.join(" ")}`);
  }
  return resolution;
}
