import { describe, expect, it } from "vitest";
import {
  type PluginPackage,
  validateAndOrderPluginInitializers,
} from "./index.ts";

function pluginPackage({
  name,
  pluginId,
  initializers,
  module = { detect: async () => ({ activate: false as const }) },
}: {
  name: string;
  pluginId?: string;
  initializers: Array<
    | string
    | {
        id: string;
        module?: string;
        export?: string;
        before?: string[];
        after?: string[];
        requires?: string[];
      }
  >;
  module?: Record<string, unknown>;
}): PluginPackage {
  return {
    manifest: {
      name,
      workforest: {
        plugin: {
          ...(pluginId ? { id: pluginId } : {}),
          initializers,
        },
      },
    },
    module,
  };
}

function orderedIds(packages: PluginPackage[]): string[] {
  return validateAndOrderPluginInitializers(packages).map(
    (initializer) => initializer.id,
  );
}

describe("plugin initializer metadata", () => {
  it("expands string shorthand to default initializer modules", () => {
    expect(
      validateAndOrderPluginInitializers([
        pluginPackage({
          name: "@wf-plugin/example",
          initializers: ["setup"],
        }),
      ]),
    ).toEqual([{ id: "setup", module: "initializers/setup" }]);
  });

  it("infers plugin ids from package names", () => {
    expect(
      orderedIds([
        pluginPackage({
          name: "@wf-plugin/example",
          initializers: [{ id: "setup" }],
        }),
      ]),
    ).toEqual(["setup"]);
  });

  it("rejects plugins without detect exports", () => {
    expect(() =>
      orderedIds([
        pluginPackage({
          name: "@wf-plugin/example",
          initializers: [{ id: "setup" }],
          module: {},
        }),
      ]),
    ).toThrow(/missing detect export/);
  });

  it("defaults object initializer metadata to conventional modules", () => {
    expect(
      validateAndOrderPluginInitializers([
        pluginPackage({
          name: "@wf-plugin/example",
          initializers: [{ id: "setup", after: ["other"] }, "other"],
        }),
      ]),
    ).toEqual([
      { id: "other", module: "initializers/other" },
      { id: "setup", module: "initializers/setup", after: ["other"] },
    ]);
  });

  it("accepts package-root-relative module overrides", () => {
    expect(
      validateAndOrderPluginInitializers([
        pluginPackage({
          name: "@wf-plugin/example",
          initializers: [{ id: "setup", module: "./custom/setup" }],
        }),
      ]),
    ).toEqual([{ id: "setup", module: "custom/setup" }]);
  });

  it("rejects package-qualified initializer modules", () => {
    expect(() =>
      orderedIds([
        pluginPackage({
          name: "@wf-plugin/example",
          initializers: [
            { id: "setup", module: "@wf-plugin/example/initializers/setup" },
          ],
        }),
      ]),
    ).toThrow(/relative to the plugin package root/);
  });

  it("rejects duplicate initializer ids", () => {
    expect(() =>
      orderedIds([
        pluginPackage({
          name: "@wf-plugin/one",
          initializers: [{ id: "setup" }],
        }),
        pluginPackage({
          name: "@wf-plugin/two",
          initializers: [{ id: "setup" }],
        }),
      ]),
    ).toThrow(/Duplicate initializer id/);
  });

  it("resolves local initializer ordering references only inside the same plugin", () => {
    expect(
      orderedIds([
        pluginPackage({
          name: "@wf-plugin/example",
          initializers: [{ id: "second", after: ["first"] }, { id: "first" }],
        }),
      ]),
    ).toEqual(["first", "second"]);
  });

  it("resolves cross-plugin initializer ordering references", () => {
    expect(
      orderedIds([
        pluginPackage({
          name: "@wf-plugin/two",
          initializers: [
            {
              id: "second",
              after: ["@wf-plugin/one:first"],
            },
          ],
        }),
        pluginPackage({
          name: "@wf-plugin/one",
          initializers: [{ id: "first" }],
        }),
      ]),
    ).toEqual(["first", "second"]);
  });

  it("expands plugin package ordering references", () => {
    expect(
      orderedIds([
        pluginPackage({
          name: "@wf-plugin/linkers",
          initializers: [{ id: "link", after: ["@wf-plugin/installers"] }],
        }),
        pluginPackage({
          name: "@wf-plugin/installers",
          initializers: [{ id: "pnpm" }, { id: "npm" }],
        }),
      ]),
    ).toEqual(["pnpm", "npm", "link"]);
  });

  it("ignores missing soft ordering targets", () => {
    expect(
      orderedIds([
        pluginPackage({
          name: "@wf-plugin/example",
          initializers: [{ id: "setup", after: ["missing"] }],
        }),
      ]),
    ).toEqual(["setup"]);
  });

  it("fails required inactive targets", () => {
    expect(() =>
      orderedIds([
        pluginPackage({
          name: "@wf-plugin/example",
          initializers: [{ id: "setup", requires: ["missing"] }],
        }),
      ]),
    ).toThrow(/requires inactive or missing initializer/);
  });

  it("does not treat requires as ordering", () => {
    expect(
      orderedIds([
        pluginPackage({
          name: "@wf-plugin/example",
          initializers: [
            { id: "second", requires: ["first"] },
            { id: "first" },
          ],
        }),
      ]),
    ).toEqual(["second", "first"]);
  });

  it("fails active ordering cycles", () => {
    expect(() =>
      orderedIds([
        pluginPackage({
          name: "@wf-plugin/example",
          initializers: [
            { id: "one", after: ["two"] },
            { id: "two", after: ["one"] },
          ],
        }),
      ]),
    ).toThrow(/cycle/);
  });
});
