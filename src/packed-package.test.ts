import {
  access,
  chmod,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commandRegistry } from "./cli/commands.ts";
import {
  listPackedFiles,
  type PackedPackageFixture,
  preparePackedPackage,
} from "./test-utils/packed-package.ts";
import { runSubprocess } from "./test-utils/subprocess.ts";

const PACKAGE_NAMES = [
  "workforest",
  "@wf-plugin/core",
  "@wf-plugin/package-managers",
  "@wf-plugin/turbo",
  "@wf-plugin/vercel",
] as const;

const ROOT_HELP_COMMANDS = [
  ...commandRegistry.root.children
    .filter((command) => command.visibility === "visible")
    .map((command) => command.name),
  ...commandRegistry.shortcuts
    .filter((shortcut) => shortcut.visibility === "visible")
    .map((shortcut) => shortcut.name),
].sort();

let fixture: PackedPackageFixture;

beforeAll(async () => {
  fixture = await preparePackedPackage();
}, 120_000);

afterAll(async () => {
  await fixture?.cleanup();
});

describe("packed package", () => {
  it("packs the CLI and every local plugin", async () => {
    expect([...fixture.tarballs.keys()].sort()).toEqual(
      [...PACKAGE_NAMES].sort(),
    );

    for (const packageName of PACKAGE_NAMES.slice(1)) {
      const files = await listPackedFiles(
        requiredTarball(fixture.tarballs, packageName),
      );
      expect(files).toContain("package/dist/index.mjs");
      expect(files).toContain("package/dist/index.d.mts");
      expect(files.some(containsSourceDirectory)).toBe(false);
    }
  });

  it("contains built artifacts and skills without source files", async () => {
    const files = await listPackedFiles(
      requiredTarball(fixture.tarballs, "workforest"),
    );

    expect(files).toContain("package/dist/index.mjs");
    expect(files).toContain("package/dist/index.d.mts");
    expect(files).toContain("package/bin/workforest.js");
    expect(files).toContain("package/skill-data/core/SKILL.md");
    expect(files).toContain("package/skill-data/core/references/commands.md");
    expect(files).toContain(
      "package/skill-data/core/references/repository-cache.md",
    );
    expect(files).toContain("package/skill-data/parallel-worktrees/SKILL.md");
    expect(files).toContain(
      "package/skill-data/parallel-worktrees/references/subagent-lifecycle.md",
    );
    expect(files).toContain(
      "package/skill-data/setup-and-configuration/SKILL.md",
    );
    expect(files).toContain(
      "package/skill-data/setup-and-configuration/references/configuration.md",
    );
    expect(files.some(containsSourceDirectory)).toBe(false);
    expect(files.some((file) => file.startsWith("package/packages/"))).toBe(
      false,
    );
    expect(files.some((file) => file.startsWith("package/skills/"))).toBe(
      false,
    );
    expect(files.some((file) => file.startsWith("package/.agents/"))).toBe(
      false,
    );
  });

  it("publishes valid runtime, declaration, and bin targets", async () => {
    const manifest = JSON.parse(
      await readFile(
        path.join(fixture.extractedPackageDir, "package.json"),
        "utf8",
      ),
    ) as {
      main: string;
      types: string;
      exports: {
        ".": {
          import: string;
          types: string;
        };
      };
      bin: Record<string, string>;
    };

    expect(manifest.main).toBe("./dist/index.mjs");
    expect(manifest.types).toBe("./dist/index.d.mts");
    expect(manifest.exports["."].import).toBe("./dist/index.mjs");
    expect(manifest.exports["."].types).toBe("./dist/index.d.mts");
    expect(manifest.bin).toEqual({
      workforest: "bin/workforest.js",
      wf: "bin/workforest.js",
    });

    const targets = [
      manifest.main,
      manifest.types,
      manifest.exports["."].import,
      manifest.exports["."].types,
      ...Object.values(manifest.bin),
    ];
    await Promise.all(
      targets.map((target) =>
        access(path.resolve(fixture.extractedPackageDir, target)),
      ),
    );

    const binStat = await stat(
      path.join(fixture.extractedPackageDir, manifest.bin["wf"] ?? ""),
    );
    expect(binStat.mode & 0o111).not.toBe(0);
  });

  it.each([
    "wf",
    "workforest",
  ] as const)("installs and runs the %s bin from an unrelated directory", async (binName) => {
    const cwd = path.join(fixture.rootDir, `cwd-${binName}`);
    await mkdir(cwd);
    const bin = fixture.bins[binName];

    const help = await runSubprocess(bin, ["--help"], {
      cwd,
      env: fixture.env,
      timeout: 10_000,
    });
    expect(help.exitCode).toBe(0);
    expect(help.stderr).not.toContain("Running local copy");

    const version = await runSubprocess(bin, ["version"], {
      cwd,
      env: fixture.env,
      timeout: 10_000,
    });
    expect(version).toEqual({
      exitCode: 0,
      stdout: "workforest 0.0.1\n",
      stderr: "",
    });

    for (const command of ROOT_HELP_COMMANDS) {
      const commandHelp = await runSubprocess(bin, [command, "--help"], {
        cwd,
        env: fixture.env,
        timeout: 10_000,
      });
      expect(commandHelp, `${binName} ${command} --help`).toMatchObject({
        exitCode: 0,
        stderr: "",
      });
      expect(commandHelp.stdout).toContain(`wf ${command}`);
    }
  }, 60_000);

  it.each([
    "wf",
    "workforest",
  ] as const)("renders expected %s errors without stack traces", async (binName) => {
    const cwd = path.join(fixture.rootDir, `errors-${binName}`);
    await mkdir(cwd);
    const bin = fixture.bins[binName];

    const usage = await runSubprocess(bin, ["unknown-command"], {
      cwd,
      env: fixture.env,
      timeout: 10_000,
    });
    expect(usage).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "Unknown command: unknown-command\n",
    });

    const operational = await runSubprocess(bin, ["skills", "get", "missing"], {
      cwd,
      env: fixture.env,
      timeout: 10_000,
    });
    expect(operational).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "Skill not found: missing\n",
    });

    for (const result of [usage, operational]) {
      expect(result.stderr).not.toMatch(/\n\s+at /);
    }
  });

  it("supports every runtime and declaration export", async () => {
    const moduleSpecifiers = await exportedModuleSpecifiers(fixture);
    const runtime = await runSubprocess(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `Promise.all(${JSON.stringify(moduleSpecifiers)}.map((specifier) => import(specifier)))
          .then((modules) => console.log(typeof modules[0].cli))`,
      ],
      {
        cwd: fixture.consumerDir,
        env: fixture.env,
        timeout: 10_000,
      },
    );
    expect(runtime).toEqual({
      exitCode: 0,
      stdout: "function\n",
      stderr: "",
    });

    await writeFile(
      path.join(fixture.consumerDir, "import-workforest.ts"),
      [
        'import { cli } from "workforest";',
        ...moduleSpecifiers
          .filter((specifier) => specifier !== "workforest")
          .map((specifier) => `import "${specifier}";`),
        "const run: () => Promise<void> = cli;",
        "void run;",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(fixture.consumerDir, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            noEmit: true,
            strict: true,
            target: "ES2022",
          },
          include: ["import-workforest.ts"],
        },
        null,
        2,
      )}\n`,
    );

    const declarations = await runSubprocess(
      "pnpm",
      ["exec", "tsc", "--project", "tsconfig.json"],
      {
        cwd: fixture.consumerDir,
        env: fixture.env,
        timeout: 20_000,
      },
    );
    expect(declarations).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  });

  it("loads dist when the source entry is absent", async () => {
    const packageDir = fixture.installedPackageDir;
    await expect(
      access(path.join(packageDir, "src", "cli.ts")),
    ).rejects.toThrow();

    const result = await runSubprocess(
      process.execPath,
      [path.join(packageDir, "bin", "workforest.js"), "version"],
      {
        cwd: packageDir,
        env: fixture.env,
        timeout: 10_000,
      },
    );

    expect(result).toEqual({
      exitCode: 0,
      stdout: "workforest 0.0.1\n",
      stderr: "",
    });
  });

  it("does not hide opt-in source-load failures behind the dist fallback", async () => {
    const destination = path.join(fixture.rootDir, "source-error");
    const packageDir = await fixture.extractRootPackage(destination);
    await mkdir(path.join(packageDir, "src"));
    await writeFile(
      path.join(packageDir, "src", "cli.ts"),
      [
        'import "./missing-source-dependency.ts";',
        "export async function cli(): Promise<void> {}",
        "",
      ].join("\n"),
    );
    await chmod(path.join(packageDir, "bin", "workforest.js"), 0o755);

    const result = await runSubprocess(
      process.execPath,
      [path.join(packageDir, "bin", "workforest.js"), "--help"],
      {
        cwd: packageDir,
        env: {
          ...fixture.env,
          WORKFOREST_USE_SOURCE_CLI: "1",
        },
        timeout: 10_000,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("missing-source-dependency.ts");
    expect(result.stderr).not.toContain("Unable to load the CLI from dist");
  });
});

function requiredTarball(
  tarballs: ReadonlyMap<string, string>,
  name: string,
): string {
  const tarball = tarballs.get(name);
  if (!tarball) {
    throw new Error(`Missing tarball for ${name}`);
  }
  return tarball;
}

function containsSourceDirectory(file: string): boolean {
  return file.split("/").includes("src");
}

async function exportedModuleSpecifiers(
  packedFixture: PackedPackageFixture,
): Promise<string[]> {
  const specifiers: string[] = [];

  for (const packageName of PACKAGE_NAMES) {
    const manifestPath = path.join(
      packedFixture.consumerDir,
      "node_modules",
      ...packageName.split("/"),
      "package.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      exports: Record<string, string | { import?: string; types?: string }>;
    };

    for (const [exportName, target] of Object.entries(manifest.exports)) {
      if (
        typeof target === "string" ||
        typeof target.import !== "string" ||
        typeof target.types !== "string"
      ) {
        continue;
      }

      await Promise.all([
        access(path.resolve(path.dirname(manifestPath), target.import)),
        access(path.resolve(path.dirname(manifestPath), target.types)),
      ]);
      specifiers.push(
        exportName === "."
          ? packageName
          : `${packageName}/${exportName.replace(/^\.\//, "")}`,
      );
    }
  }

  return specifiers;
}
