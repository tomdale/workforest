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
      expect(files.some((file) => file.startsWith("package/src/"))).toBe(false);
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
    expect(files.some((file) => file.startsWith("package/src/"))).toBe(false);
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
    expect(help.stdout).toContain("Start here (for AI agents):");
    expect(help.stderr).not.toContain("Running local copy");

    const version = await runSubprocess(bin, ["--version"], {
      cwd,
      env: fixture.env,
      timeout: 10_000,
    });
    expect(version).toEqual({
      exitCode: 0,
      stdout: "workforest 0.0.1\n",
      stderr: "",
    });

    const newHelp = await runSubprocess(bin, ["new", "--help"], {
      cwd,
      env: fixture.env,
      timeout: 10_000,
    });
    expect(newHelp.exitCode).toBe(0);
    expect(newHelp.stdout).toContain("Usage: wf new");
    expect(newHelp.stderr).toBe("");
  });

  it("supports runtime imports and declaration resolution", async () => {
    const runtime = await runSubprocess(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'import("workforest").then(({ cli }) => console.log(typeof cli))',
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

    const pluginImports = await runSubprocess(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `Promise.all([
          import("@wf-plugin/core"),
          import("@wf-plugin/package-managers"),
          import("@wf-plugin/package-managers/initializers/pnpm-install"),
          import("@wf-plugin/turbo"),
          import("@wf-plugin/turbo/initializers/turbo-link"),
          import("@wf-plugin/vercel"),
          import("@wf-plugin/vercel/initializers/vercel-link")
        ]).then(() => console.log("ok"))`,
      ],
      {
        cwd: fixture.consumerDir,
        env: fixture.env,
        timeout: 10_000,
      },
    );
    expect(pluginImports).toEqual({
      exitCode: 0,
      stdout: "ok\n",
      stderr: "",
    });

    await writeFile(
      path.join(fixture.consumerDir, "import-workforest.ts"),
      [
        'import { cli } from "workforest";',
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

  it("falls back to dist only when the source entry is absent", async () => {
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
        env: fixture.env,
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
