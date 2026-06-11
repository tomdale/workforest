import { describe, expect, it } from "vitest";
import { commandRegistry } from "./commands.ts";
import { parseInvocation } from "./parse-invocation.ts";
import { resolveCommand } from "./resolve-command.ts";

const SUPPORTED_SHORTCUTS = [
  {
    alias: ["new", "vercel/next.js", "--", "update", "docs"],
    canonical: [
      "workspace",
      "create",
      "vercel/next.js",
      "--",
      "update",
      "docs",
    ],
  },
  {
    alias: ["clean", "update-docs", "--dry-run"],
    canonical: ["workspace", "delete", "update-docs", "--dry-run"],
  },
] as const;

describe("supported shortcut equivalence", () => {
  it("contains only the published new and clean shortcuts", () => {
    expect(commandRegistry.shortcuts.map((shortcut) => shortcut.name)).toEqual([
      "new",
      "clean",
    ]);
  });

  it.each(SUPPORTED_SHORTCUTS)("parses $alias like $canonical", ({
    alias,
    canonical,
  }) => {
    expect(parse(alias)).toEqual(parse(canonical));
  });
});

function parse(argv: readonly string[]) {
  const resolution = resolveCommand(commandRegistry, argv);
  if (resolution.kind !== "command") {
    throw new Error(`Expected command resolution for ${argv.join(" ")}`);
  }
  const invocation = parseInvocation(resolution, { interactive: false });

  return {
    canonicalPath: invocation.command.canonicalPath,
    handler: invocation.command.leaf.handler,
    flags: invocation.flags,
    beforeDoubleDash: invocation.beforeDoubleDash,
    afterDoubleDash: invocation.afterDoubleDash,
    hadDoubleDash: invocation.hadDoubleDash,
  };
}
