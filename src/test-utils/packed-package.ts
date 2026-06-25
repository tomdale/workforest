import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSubprocess } from "./subprocess.ts";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const BASE_ENV = { ...process.env };
const PACKAGE_DIRS = [
  "packages/core",
  "packages/codex-cli",
  "packages/claude-cli",
  "packages/package-managers",
  "packages/turbo",
  "packages/vercel",
  ".",
] as const;
const PROJECT_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "README.md",
  "tsconfig.json",
] as const;
const PROJECT_DIRS = ["bin", "packages", "skill-data", "src"] as const;

type PackageManifest = {
  name: string;
  version: string;
};

export type PackedPackageFixture = {
  rootDir: string;
  consumerDir: string;
  extractedPackageDir: string;
  installedPackageDir: string;
  workspaceDir: string;
  tarballs: ReadonlyMap<string, string>;
  bins: {
    wf: string;
    workforest: string;
  };
  env: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
  extractRootPackage(destination: string): Promise<string>;
};

export async function preparePackedPackage(): Promise<PackedPackageFixture> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "workforest-packed-"));

  try {
    const packDir = path.join(rootDir, "packs");
    const stagingDir = path.join(rootDir, "staging");
    const consumerDir = path.join(rootDir, "consumer");
    const extractedDir = path.join(rootDir, "extracted");
    const configDir = path.join(rootDir, "config");
    const cacheDir = path.join(rootDir, "cache");
    const homeDir = path.join(rootDir, "home");
    const workspaceDir = path.join(rootDir, "workspaces");
    const tmpDir = path.join(rootDir, "tmp");
    const userConfigPath = path.join(rootDir, "empty-npmrc");
    const xdgConfigDir = path.join(rootDir, "xdg-config");

    await Promise.all(
      [
        packDir,
        stagingDir,
        consumerDir,
        extractedDir,
        configDir,
        cacheDir,
        homeDir,
        workspaceDir,
        tmpDir,
        xdgConfigDir,
      ].map((dir) => mkdir(dir, { recursive: true })),
    );
    await writeFile(userConfigPath, "", "utf8");
    const packageManagerEnv: NodeJS.ProcessEnv = {
      ...withoutPackageCredentials(BASE_ENV),
      HOME: homeDir,
      NPM_CONFIG_USERCONFIG: userConfigPath,
      XDG_CONFIG_HOME: xdgConfigDir,
    };
    await copyPackingWorkspace(stagingDir);
    await runChecked(
      "pnpm",
      ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"],
      { cwd: stagingDir, env: packageManagerEnv },
    );

    const tarballs = new Map<string, string>();
    for (const relativeDir of PACKAGE_DIRS) {
      const packageDir = path.resolve(stagingDir, relativeDir);
      const manifest = await readManifest(packageDir);
      await runChecked("pnpm", ["pack", "--pack-destination", packDir], {
        cwd: packageDir,
        env: packageManagerEnv,
      });

      const tarball = path.join(packDir, tarballName(manifest));
      tarballs.set(manifest.name, tarball);
    }

    const dependencyEntries = [...tarballs].map(([name, tarball]) => [
      name,
      `file:${tarball}`,
    ]);
    const packedDependencies = Object.fromEntries(dependencyEntries);
    const consumerManifest = {
      name: "workforest-packed-consumer",
      private: true,
      type: "module",
      dependencies: packedDependencies,
      devDependencies: {
        typescript: "5.9.3",
      },
    };
    await writeFile(
      path.join(consumerDir, "package.json"),
      `${JSON.stringify(consumerManifest, null, 2)}\n`,
    );
    await writeFile(
      path.join(consumerDir, "pnpm-workspace.yaml"),
      renderConsumerWorkspaceConfig({
        ...packedDependencies,
        semver: "7.7.3",
      }),
    );
    await runChecked("pnpm", ["install", "--offline", "--ignore-scripts"], {
      cwd: consumerDir,
      env: packageManagerEnv,
    });

    const rootTarball = requiredTarball(tarballs, "workforest");
    await extractTarball(rootTarball, extractedDir);

    const env: NodeJS.ProcessEnv = {
      ...withoutPackageCredentials(BASE_ENV),
      HOME: homeDir,
      NO_COLOR: "1",
      TMPDIR: tmpDir,
      WORKFOREST_CACHE_DIR: cacheDir,
      WORKFOREST_CONFIG_DIR: configDir,
    };
    Reflect.deleteProperty(env, "FORCE_COLOR");
    Reflect.deleteProperty(env, "WORKFOREST_CD_PATH_FILE");
    Reflect.deleteProperty(env, "WORKFOREST_SKILLS_DIR");

    return {
      rootDir,
      consumerDir,
      extractedPackageDir: path.join(extractedDir, "package"),
      installedPackageDir: path.join(consumerDir, "node_modules", "workforest"),
      workspaceDir,
      tarballs,
      bins: {
        wf: path.join(consumerDir, "node_modules", ".bin", "wf"),
        workforest: path.join(
          consumerDir,
          "node_modules",
          ".bin",
          "workforest",
        ),
      },
      env,
      cleanup: () => rm(rootDir, { recursive: true, force: true }),
      async extractRootPackage(destination: string): Promise<string> {
        await mkdir(destination, { recursive: true });
        await extractTarball(rootTarball, destination);
        return path.join(destination, "package");
      },
    };
  } catch (error) {
    await rm(rootDir, { recursive: true, force: true });
    throw error;
  }
}

function withoutPackageCredentials(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) =>
        !/^(?:npm|pnpm)_config_/i.test(name) && !/(?:auth|token)/i.test(name),
    ),
  );
}

async function copyPackingWorkspace(destination: string): Promise<void> {
  await Promise.all(
    PROJECT_FILES.map((relativePath) =>
      cp(
        path.join(PROJECT_ROOT, relativePath),
        path.join(destination, relativePath),
      ),
    ),
  );
  await Promise.all(
    PROJECT_DIRS.map((relativePath) =>
      cp(
        path.join(PROJECT_ROOT, relativePath),
        path.join(destination, relativePath),
        {
          recursive: true,
          filter: (source) => {
            const segments = path
              .relative(PROJECT_ROOT, source)
              .split(path.sep);
            return (
              !segments.includes("dist") && !segments.includes("node_modules")
            );
          },
        },
      ),
    ),
  );
}

async function readManifest(packageDir: string): Promise<PackageManifest> {
  const value: unknown = JSON.parse(
    await readFile(path.join(packageDir, "package.json"), "utf8"),
  );
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !("version" in value) ||
    typeof value.version !== "string"
  ) {
    throw new Error(`Invalid package manifest in ${packageDir}`);
  }
  return { name: value.name, version: value.version };
}

function tarballName(manifest: PackageManifest): string {
  const packageName = manifest.name.replace(/^@/, "").replaceAll("/", "-");
  return `${packageName}-${manifest.version}.tgz`;
}

function renderConsumerWorkspaceConfig(
  overrides: Record<string, string>,
): string {
  const lines = ["packages:", '  - "."', "overrides:"];
  for (const [name, value] of Object.entries(overrides).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    lines.push(`  ${JSON.stringify(name)}: ${JSON.stringify(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

function requiredTarball(
  tarballs: ReadonlyMap<string, string>,
  name: string,
): string {
  const tarball = tarballs.get(name);
  if (!tarball) {
    throw new Error(`Missing packed tarball for ${name}`);
  }
  return tarball;
}

async function extractTarball(
  tarball: string,
  destination: string,
): Promise<void> {
  await runChecked("tar", ["-xzf", tarball, "-C", destination]);
}

async function runChecked(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const result = await runSubprocess(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    timeout: 120_000,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      [
        `${command} ${args.join(" ")} exited ${String(result.exitCode)}`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

export async function listPackedFiles(
  tarball: string,
): Promise<readonly string[]> {
  const files = await readdir(path.dirname(tarball));
  if (!files.includes(path.basename(tarball))) {
    throw new Error(`Packed tarball does not exist: ${tarball}`);
  }

  const result = await runSubprocess("tar", ["-tzf", tarball], {
    timeout: 10_000,
  });

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Could not inspect ${tarball}`);
  }
  return result.stdout.split("\n").filter(Boolean);
}
