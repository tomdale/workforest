import { describe, expect, it } from "vitest";
import { commandRegistry } from "./cli/commands.ts";
import { parseInvocation } from "./cli/parse-invocation.ts";
import { resolveCommand } from "./cli/resolve-command.ts";
import type { ResolvedCommand } from "./cli/types.ts";

const REQUIRED_COMMANDS: readonly (readonly string[])[] = [
  ["start"],
  ["add"],
  ["switch"],
  ["list"],
  ["status"],
  ["finish"],
  ["delete"],
  ["migrate", "workspaces"],
  ["task", "start"],
  ["task", "list"],
  ["task", "finish"],
  ["task", "delete"],
  ["cache", "list"],
  ["cache", "show"],
  ["cache", "sync"],
  ["cache", "doctor"],
  ["cache", "delete"],
  ["cache", "clean"],
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

  it.each(
    [
      ["new"],
      ["clean"],
      ["workspace"],
      ["worktree"],
      ["task", "create"],
      ["cache", "info"],
      ["cache", "path"],
      ["cache", "add"],
      ["cache", "update"],
      ["cache", "check"],
      ["cache", "repair"],
      ["cache", "prune"],
      ["cache", "manage"],
    ].map((argv) => ({ argv })),
  )("does not expose removed command wf %s", ({ argv }) => {
    expect(() => resolve(argv)).toThrow();
  });

  it.each([
    ["task delete", ["task", "delete"]],
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
