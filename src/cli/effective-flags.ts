import type { CommandLeaf, FlagDefinition } from "./types.ts";

export function commandFlags(leaf: CommandLeaf): readonly FlagDefinition[] {
  const flags = [...leaf.flags];
  if (
    leaf.outputModes.includes("json") &&
    !flags.some((flag) => flag.long === "--json")
  ) {
    flags.push({
      name: "json",
      long: "--json",
      kind: "boolean",
      description: "Emit a machine-readable JSON envelope.",
    });
  }
  return flags;
}
