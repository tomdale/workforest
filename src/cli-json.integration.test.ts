import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import stripAnsi from "strip-ansi";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSubprocess } from "./test-utils/subprocess.ts";
import { writeWorkspaceMetadata } from "./workspace/metadata.ts";

const execFileAsync = promisify(execFile);
const CLI_MODULE_URL = pathToFileURL(path.resolve("src/cli.ts")).href;
const CLI_SCRIPT = [
  `const { cli } = await import(${JSON.stringify(CLI_MODULE_URL)});`,
  'process.argv = ["node", "wf", ...JSON.parse(process.env.WORKFOREST_TEST_ARGV ?? "[]")];',
  "await cli();",
].join("\n");
const tempDirs: string[] = [];

let baseConfigDir: string;
let baseHomeDir: string;
let skillsDir: string;
let unrelatedDir: string;

type JsonEnvelope =
  | { ok: true; data: unknown }
  | {
      ok: false;
      error: { kind: "usage" | "operational"; message: string };
    };

beforeAll(async () => {
  baseConfigDir = await createTempDir("workforest-json-config-");
  baseHomeDir = await createTempDir("workforest-json-home-");
  unrelatedDir = await createTempDir("workforest-json-unrelated-");
  skillsDir = await createSkillsFixture();
});

afterAll(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("JSON CLI integration", () => {
  it("reports change status with no initialization records", async () => {
    const workspaceDir = await createWorkspaceFixture();
    const result = await runJson(["status", "--json"], { cwd: workspaceDir });

    expectJsonResult(result, 0, {
      ok: true,
      data: expect.objectContaining({
        type: "adhoc-workspace",
        selector: "_adhoc/json-status",
        initialization: null,
      }),
    });
  });

  it("reports change lookup failures as operational JSON", async () => {
    const result = await runJson(["status", "--json"], {
      cwd: unrelatedDir,
    });

    expectJsonResult(result, 1, {
      ok: false,
      error: {
        kind: "operational",
        message:
          "Not in a Workforest change.\nRun: wf list\nOr start explicitly: wf start <change> <repo|@template>",
      },
    });
  });

  it("lists an empty cache", async () => {
    const cacheDir = await createTempDir("workforest-json-empty-cache-");
    const result = await runJson(["cache", "list", "--json"], { cacheDir });

    expectJsonResult(result, 0, { ok: true, data: [] });
  });

  it("returns cache information and missing-cache failures", async () => {
    const cacheDir = await createTempDir("workforest-json-info-cache-");
    const mirrorPath = await createMirror(cacheDir, "front.git");

    const success = await runJson(["cache", "info", "vercel/front", "--json"], {
      cacheDir,
    });
    const failure = await runJson(["cache", "info", "missing", "--json"], {
      cacheDir,
    });

    const successJson = expectJsonResult(success, 0);
    expect(successJson).toEqual({
      ok: true,
      data: expect.objectContaining({
        name: "front",
        slug: "vercel/front",
        mirrorPath,
        health: "healthy",
      }),
    });
    expectJsonResult(failure, 1, {
      ok: false,
      error: {
        kind: "operational",
        message: "Cached repository not found: missing",
      },
    });
  });

  it("reports healthy and unhealthy cache doctor results", async () => {
    const healthyCacheDir = await createTempDir(
      "workforest-json-healthy-cache-",
    );
    await createMirror(healthyCacheDir, "front.git");

    const unhealthyCacheDir = await createTempDir(
      "workforest-json-unhealthy-cache-",
    );
    await mkdir(path.join(unhealthyCacheDir, "broken.git"));
    await writeFile(
      path.join(unhealthyCacheDir, "broken.git", "README"),
      "not a repository\n",
      "utf8",
    );

    const healthy = await runJson(["cache", "doctor", "--json"], {
      cacheDir: healthyCacheDir,
    });
    const unhealthy = await runJson(["cache", "doctor", "--json"], {
      cacheDir: unhealthyCacheDir,
    });

    const healthyJson = expectJsonResult(healthy, 0);
    expect(healthyJson).toEqual({
      ok: true,
      data: [
        expect.objectContaining({
          slug: "vercel/front",
          health: "healthy",
          issues: [],
        }),
      ],
    });

    const unhealthyJson = expectJsonResult(unhealthy, 1);
    expect(unhealthyJson).toEqual({
      ok: true,
      data: [
        expect.objectContaining({
          name: "broken",
          health: "invalid",
          issues: ["Unreadable or invalid Git repository"],
        }),
      ],
    });
  });

  it("lists skills and reports a missing skills directory", async () => {
    const missingSkillsDir = path.join(
      await createTempDir("workforest-json-missing-skills-"),
      "absent",
    );
    const success = await runJson(["skills", "list", "--json"]);
    const failure = await runJson(["skills", "list", "--json"], {
      skillsDir: missingSkillsDir,
    });

    expectJsonResult(success, 0, {
      ok: true,
      data: [
        { name: "alpha", description: "Alpha skill" },
        { name: "beta", description: "Beta skill" },
      ],
    });
    expectJsonResult(failure, 1, {
      ok: false,
      error: {
        kind: "operational",
        message:
          "Skills directory not found. Set WORKFOREST_SKILLS_DIR or reinstall workforest.",
      },
    });
  });

  it("gets one or multiple skills as JSON", async () => {
    const single = await runJson(["skills", "get", "alpha", "--json"]);
    const multiple = await runJson([
      "skills",
      "get",
      "beta",
      "alpha",
      "--json",
    ]);

    expectJsonResult(single, 0, {
      ok: true,
      data: [{ name: "alpha", content: skillContent("alpha", "Alpha skill") }],
    });
    expectJsonResult(multiple, 0, {
      ok: true,
      data: [
        { name: "beta", content: skillContent("beta", "Beta skill") },
        { name: "alpha", content: skillContent("alpha", "Alpha skill") },
      ],
    });
  });

  it("gets all visible skills and full supplementary files as JSON", async () => {
    const all = await runJson(["skills", "get", "--all", "--json"]);
    const full = await runJson(["skills", "get", "alpha", "--full", "--json"]);

    expectJsonResult(all, 0, {
      ok: true,
      data: [
        {
          name: "alpha",
          content: skillContent("alpha", "Alpha skill"),
        },
        {
          name: "beta",
          content: skillContent("beta", "Beta skill"),
        },
      ],
    });
    expectJsonResult(full, 0, {
      ok: true,
      data: [
        {
          name: "alpha",
          content: skillContent("alpha", "Alpha skill"),
          files: [
            {
              path: "references/guide.md",
              content: "# Alpha guide\n",
            },
          ],
        },
      ],
    });
  });

  it("reports missing skills from get as operational JSON", async () => {
    const result = await runJson(["skills", "get", "missing", "--json"]);

    expectJsonResult(result, 1, {
      ok: false,
      error: {
        kind: "operational",
        message: "Skill not found: missing",
      },
    });
  });

  it("returns root, named, and missing skill paths as JSON", async () => {
    const root = await runJson(["skills", "path", "--json"]);
    const named = await runJson(["skills", "path", "alpha", "--json"]);
    const missing = await runJson(["skills", "path", "missing", "--json"]);

    expectJsonResult(root, 0, {
      ok: true,
      data: { paths: [skillsDir] },
    });
    expectJsonResult(named, 0, {
      ok: true,
      data: { name: "alpha", path: path.join(skillsDir, "alpha") },
    });
    expectJsonResult(missing, 1, {
      ok: false,
      error: {
        kind: "operational",
        message: "Skill not found: missing",
      },
    });
  });

  it.each([
    [
      ["status", "one", "two", "--json"],
      "Invalid operands for wf status. Expected 0-1 selector.",
    ],
    [
      ["cache", "list", "extra", "--json"],
      "Invalid operands for wf cache list. Expected no operands.",
    ],
    [
      ["cache", "info", "--json"],
      "Invalid operands for wf cache info. Expected 1 repository.",
    ],
    [
      ["cache", "doctor", "--force", "--json"],
      'Unknown flag "--force" for wf cache doctor.',
    ],
    [
      ["skills", "list", "extra", "--json"],
      "Invalid operands for wf skills list. Expected no operands.",
    ],
    [
      ["skills", "get", "--json"],
      "Invalid operands for wf skills get. Expected 1 or more skill names.",
    ],
    [
      ["skills", "path", "alpha", "beta", "--json"],
      "Invalid operands for wf skills path. Expected 0-1 skill.",
    ],
  ])("renders JSON usage failure for %j", async (argv, message) => {
    const result = await runJson(argv);

    expectJsonResult(result, 2, {
      ok: false,
      error: { kind: "usage", message },
    });
  });
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createSkillsFixture(): Promise<string> {
  const root = await createTempDir("workforest-json-skills-");
  await Promise.all([
    createSkill(root, "alpha", "Alpha skill", {
      "references/guide.md": "# Alpha guide\n",
    }),
    createSkill(root, "beta", "Beta skill"),
    createSkill(root, "hidden", "Hidden skill", {}, true),
  ]);
  return root;
}

async function createSkill(
  root: string,
  name: string,
  description: string,
  files: Readonly<Record<string, string>> = {},
  hidden = false,
): Promise<void> {
  const skillDir = path.join(root, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    skillContent(name, description, hidden),
    "utf8",
  );
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(skillDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
  }
}

function skillContent(
  name: string,
  description: string,
  hidden = false,
): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    ...(hidden ? ["hidden: true"] : []),
    "---",
    "",
    `# ${name}`,
    "",
  ].join("\n");
}

async function createWorkspaceFixture(): Promise<string> {
  const workspaceDir = path.join(
    baseHomeDir,
    "Code",
    "Workspaces",
    "_adhoc",
    "json-status",
  );
  await mkdir(path.join(workspaceDir, "front"), { recursive: true });
  await writeWorkspaceMetadata(workspaceDir, {
    featureName: "json-status",
    branchName: "tomdale/json-status",
    repos: [
      {
        name: "front",
        remote: "git@github.com:vercel/front.git",
        defaultBranch: "main",
        hasLockfile: false,
      },
    ],
  });
  return workspaceDir;
}

async function createMirror(
  cacheDir: string,
  directoryName: string,
): Promise<string> {
  const mirrorPath = path.join(cacheDir, directoryName);
  await mkdir(mirrorPath);
  await execFileAsync("git", ["init", "--bare", "--quiet"], {
    cwd: mirrorPath,
  });
  await execFileAsync(
    "git",
    ["remote", "add", "origin", "git@github.com:vercel/front.git"],
    { cwd: mirrorPath },
  );
  return mirrorPath;
}

async function runJson(
  argv: readonly string[],
  options: {
    cacheDir?: string;
    cwd?: string;
    skillsDir?: string;
  } = {},
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: baseHomeDir,
    NO_COLOR: "1",
    WORKFOREST_CACHE_DIR:
      options.cacheDir ??
      path.join(baseHomeDir, ".cache", "workforest-json-unused"),
    WORKFOREST_CONFIG_DIR: baseConfigDir,
    WORKFOREST_SKILLS_DIR: options.skillsDir ?? skillsDir,
    WORKFOREST_TEST_ARGV: JSON.stringify(argv),
  };
  delete env["FORCE_COLOR"];

  return runSubprocess(
    process.execPath,
    ["--input-type=module", "--eval", CLI_SCRIPT],
    {
      cwd: options.cwd ?? unrelatedDir,
      env,
      timeout: 10_000,
    },
  );
}

function expectJsonResult(
  result: Awaited<ReturnType<typeof runJson>>,
  exitCode: 0 | 1 | 2,
  expected?: unknown,
): JsonEnvelope {
  expect(result.exitCode).toBe(exitCode);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe(stripAnsi(result.stdout));
  expect(result.stdout.endsWith("\n")).toBe(true);

  const parsed = JSON.parse(result.stdout) as JsonEnvelope;
  expect(result.stdout).toBe(`${JSON.stringify(parsed)}\n`);
  expect(result.stdout).not.toContain('"stack"');
  expect(result.stdout).not.toContain("\\n    at ");
  expect(result.stdout).not.toContain("node_modules/");
  if (expected !== undefined) {
    expect(parsed).toEqual(expected);
  }
  return parsed;
}
