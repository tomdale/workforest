import { describe, expect, it } from "vitest";
import { commandRegistry } from "./cli/commands.ts";
import { parseInvocation } from "./cli/parse-invocation.ts";
import { resolveCommand } from "./cli/resolve-command.ts";
import type { ResolvedCommand } from "./cli/types.ts";

const REQUIRED_COMMANDS: readonly (readonly string[])[] = [
  ["start"],
  ["add"],
  ["switch"],
  ["finish"],
  ["delete"],
  ["workspace", "create"],
  ["workspace", "delete"],
  ["workspace", "open"],
  ["workspace", "list"],
  ["workspace", "status"],
  ["workspace", "add"],
  ["task", "start"],
  ["task", "list"],
  ["task", "finish"],
  ["task", "delete"],
  ["worktree", "create"],
  ["worktree", "list"],
  ["worktree", "delete"],
  ["cache", "list"],
  ["cache", "info"],
  ["cache", "path"],
  ["cache", "add"],
  ["cache", "update"],
  ["cache", "doctor"],
  ["cache", "repair"],
  ["cache", "delete"],
  ["cache", "prune"],
  ["cache", "manage"],
  ["review", "open"],
  ["review", "checkout"],
  ["template", "open"],
  ["template", "show"],
  ["template", "manage"],
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
    [["new"], ["workspace", "create"]],
    [
      ["clean", "example"],
      ["workspace", "delete"],
    ],
  ] as const)("keeps the published %s shortcut", (argv, canonicalPath) => {
    expect(resolve(argv)).toMatchObject({ canonicalPath });
  });

  it.each([
    ["workspace delete", ["workspace", "delete"]],
    ["task delete", ["task", "delete"]],
    ["worktree delete", ["worktree", "delete"]],
    ["cache delete", ["cache", "delete"]],
    ["delete", ["delete"]],
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
