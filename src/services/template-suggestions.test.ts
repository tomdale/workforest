import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CachedRepository } from "../repositories.ts";
import type { Template } from "../templates/index.ts";
import {
  buildTemplateSuggestionAiInput,
  compactTemplateSuggestionEvidence,
  createTemplateSuggestionDebugLog,
  suggestTemplates,
  type TemplateSuggestionStatusEvent,
  validateTemplateSuggestionResponse,
  writeTemplateSuggestionInputLog,
  writeTemplateSuggestionOutputLog,
} from "./template-suggestions.ts";

const ORIGINAL_CACHE_DIR = process.env["WORKFOREST_CACHE_DIR"];
const ORIGINAL_XDG_CONFIG_HOME = process.env["XDG_CONFIG_HOME"];

const tempDirs: string[] = [];

afterEach(async () => {
  restoreEnv("WORKFOREST_CACHE_DIR", ORIGINAL_CACHE_DIR);
  restoreEnv("XDG_CONFIG_HOME", ORIGINAL_XDG_CONFIG_HOME);
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("template suggestion evidence", () => {
  it("compacts PRs, existing templates, cached repositories, duplicates, and missing fields", () => {
    const evidence = compactTemplateSuggestionEvidence(
      {
        generatedAt: "2026-06-25T12:00:00.000Z",
        githubUser: "tomdale",
        lookbackDays: 180,
        since: "2025-12-27",
        existingTemplates: [
          template("agent-stack", ["vercel/agents", "vercel/front"]),
        ],
        cachedRepositories: [cachedRepository("front", "vercel/front")],
        pullRequests: [
          {
            role: "authored",
            repository: "vercel/front",
            number: 10,
            title: "Add UI",
            url: "https://github.com/vercel/front/pull/10",
            labels: ["feature"],
            updatedAt: "2026-06-20T00:00:00.000Z",
            touchedPaths: ["apps/web/page.tsx"],
          },
          {
            role: "reviewed",
            repository: "vercel/front",
            number: 10,
            title: "Add UI",
            url: "https://github.com/vercel/front/pull/10",
            labels: ["ai"],
            updatedAt: "2026-06-21T00:00:00.000Z",
            touchedPaths: ["packages/ui/button.tsx"],
          },
          {
            role: "commented",
            repository: null,
            number: null,
          },
          {
            role: "commented",
            repository: "vercel/api",
            number: 11,
            title: null,
            updatedAt: "2026-06-19T00:00:00.000Z",
          },
        ],
      },
      {
        maxCachedRepositories: 10,
        maxExistingTemplates: 10,
        maxTotalPullRequests: 10,
      },
    );

    expect(evidence.existingTemplates).toEqual([
      {
        id: "agent-stack",
        repos: ["vercel/agents", "vercel/front"],
      },
    ]);
    expect(evidence.cachedRepositories).toEqual([
      {
        name: "front",
        specifier: "vercel/front",
        remote: "git@github.com:vercel/front.git",
      },
    ]);
    expect(evidence.pullRequests).toHaveLength(2);
    expect(evidence.pullRequests[0]).toMatchObject({
      repository: "vercel/front",
      number: 10,
      roles: ["authored", "reviewed"],
      labels: ["feature", "ai"],
      updatedAt: "2026-06-21T00:00:00.000Z",
    });
    expect(evidence.pullRequests[0]?.pathSummary).toContain("apps (1)");
    expect(evidence.pullRequests[1]).toMatchObject({
      repository: "vercel/api",
      number: 11,
      title: "(untitled pull request)",
      roles: ["commented"],
    });
    expect(evidence.summary.repositoriesSeenInPullRequests).toEqual([
      "vercel/api",
      "vercel/front",
    ]);
  });
});

describe("template suggestion validation", () => {
  it("accepts valid template suggestions", () => {
    expect(
      validateTemplateSuggestionResponse(validResponse(), {
        existingTemplates: [],
        maxReposPerSuggestion: 4,
      }),
    ).toEqual([
      {
        id: "agent-workflow",
        description: "Cross-repo agent workflow changes.",
        repos: ["vercel/agents", "vercel/front"],
        confidence: 0.82,
        evidenceNotes: ["Recent PRs touched both repositories."],
      },
    ]);
  });

  it.each([
    {
      label: "no suggestions",
      value: { suggestions: [] },
      message: "did not include any template suggestions",
    },
    {
      label: "invalid ids",
      value: validResponse({ id: "Bad Name" }),
      message: "Invalid template id",
    },
    {
      label: "duplicate ids",
      value: {
        suggestions: [
          validSuggestion({ id: "agent-workflow" }),
          validSuggestion({ id: "agent-workflow" }),
        ],
      },
      message: "duplicate template id",
    },
    {
      label: "existing id collision",
      value: validResponse({ id: "existing" }),
      existingTemplates: [{ id: "existing", repos: ["vercel/front"] }],
      message: 'Template "existing" already exists',
    },
    {
      label: "existing repo set collision",
      value: validResponse({ repos: ["vercel/front", "vercel/api"] }),
      existingTemplates: [
        { id: "web-stack", repos: ["vercel/api", "vercel/front"] },
      ],
      message: "duplicates the repository set",
    },
    {
      label: "invalid repos",
      value: validResponse({ repos: ["front"] }),
      message: "invalid repository specifier",
    },
    {
      label: "empty repo lists",
      value: validResponse({ repos: [] }),
      message: "must include at least one value",
    },
    {
      label: "oversized repo lists",
      value: validResponse({
        repos: ["a/one", "a/two", "a/three", "a/four", "a/five"],
      }),
      message: "maximum is 4",
    },
    {
      label: "duplicate repos",
      value: validResponse({ repos: ["vercel/front", "vercel/front"] }),
      message: "duplicate repository",
    },
    {
      label: "malformed object",
      value: { suggestions: [{ id: "missing-fields" }] },
      message: "description must be a non-empty string",
    },
  ])("rejects $label", ({ value, existingTemplates = [], message }) => {
    expect(() =>
      validateTemplateSuggestionResponse(value, {
        existingTemplates,
        maxReposPerSuggestion: 4,
      }),
    ).toThrow(message);
  });
});

describe("template suggestion debug logs", () => {
  it("writes deterministic input and output logs under cwd .workforest by default", async () => {
    const cwd = await createTempDir("workforest-template-suggest-logs-");
    const now = new Date("2026-01-02T03:04:05.000Z");
    const debugLog = await createTemplateSuggestionDebugLog({
      cwd,
      now,
      config: {},
    });

    expect(debugLog.dir).toBe(
      path.join(
        cwd,
        ".workforest",
        "ai",
        "template-suggest",
        "2026-01-02T03-04-05-000Z",
      ),
    );

    const input = buildTemplateSuggestionAiInput(
      {
        generatedAt: now.toISOString(),
        githubUser: "tomdale",
        lookbackDays: 180,
        since: "2025-07-06",
        existingTemplates: [],
        cachedRepositories: [],
        pullRequests: [],
        summary: {
          existingTemplateCount: 0,
          cachedRepositoryCount: 0,
          pullRequestCount: 0,
          repositoriesSeenInPullRequests: [],
        },
      },
      { maxReposPerSuggestion: 4, maxSuggestions: 2 },
    );
    await writeTemplateSuggestionInputLog(debugLog, input);
    await writeTemplateSuggestionOutputLog(debugLog, '{"suggestions":[]}');

    const inputLog = JSON.parse(await readFile(debugLog.inputPath, "utf8"));
    expect(inputLog).toMatchObject({
      schema: input.schema,
      evidence: input.evidence,
    });
    await expect(readFile(debugLog.outputPath, "utf8")).resolves.toBe(
      '{"suggestions":[]}',
    );
  });

  it("writes worktree logs under the repository metadata directory", async () => {
    const root = await createTempDir("workforest-template-suggest-repo-");
    const cwd = path.join(root, "Repos", "workforest", "ai-features");
    await mkdir(cwd, { recursive: true });
    const now = new Date("2026-01-02T03:04:05.000Z");

    const debugLog = await createTemplateSuggestionDebugLog({
      cwd,
      now,
      config: { directory: { base: root } },
    });

    expect(debugLog.dir).toBe(
      path.join(
        root,
        "Repos",
        "workforest",
        ".workforest",
        "ai-features",
        "ai",
        "template-suggest",
        "2026-01-02T03-04-05-000Z",
      ),
    );
  });
});

describe("suggestTemplates", () => {
  it("uses fake GitHub and AI providers, writes logs, and emits heartbeat status", async () => {
    const cwd = await createTempDir("workforest-template-suggest-service-");
    const configHome = path.join(cwd, "config");
    const cacheDir = path.join(cwd, "cache");
    await mkdir(configHome);
    await mkdir(cacheDir);
    process.env["XDG_CONFIG_HOME"] = configHome;
    process.env["WORKFOREST_CACHE_DIR"] = cacheDir;

    const events: TemplateSuggestionStatusEvent[] = [];
    const result = await suggestTemplates({
      cwd,
      now: new Date("2026-06-25T12:00:00.000Z"),
      config: {},
      heartbeatMs: 5,
      commandRunner: fakeGhRunner,
      getAiStatus: async () => {
        await delay(15);
        return {
          disabled: false,
          selectedProvider: "fake-ai",
          timeoutMs: 120_000,
          providers: [],
        };
      },
      generateJson: async (options) => {
        const raw = JSON.stringify(validResponse());
        await options.onRawText?.(raw);
        return options.validate?.(JSON.parse(raw)) as never;
      },
      onStatus: (event) => events.push(event),
    });

    expect(result.suggestions).toHaveLength(1);
    expect(result.evidence.pullRequests[0]).toMatchObject({
      repository: "vercel/front",
      pathSummary: "src (1)",
      mergedAt: "2026-06-22T00:00:00.000Z",
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "provider-check",
          status: "heartbeat",
        }),
        expect.objectContaining({
          phase: "ai-analysis",
          status: "completed",
        }),
      ]),
    );
    const inputLog = JSON.parse(
      await readFile(path.join(result.logDir, "input.json"), "utf8"),
    );
    expect(inputLog.evidence).toEqual(result.evidence);
    expect(
      JSON.parse(
        await readFile(path.join(result.logDir, "output.txt"), "utf8"),
      ),
    ).toEqual(validResponse());
  });
});

function validResponse(
  overrides: Partial<ReturnType<typeof validSuggestion>> = {},
): { suggestions: ReturnType<typeof validSuggestion>[] } {
  return { suggestions: [validSuggestion(overrides)] };
}

function validSuggestion(
  overrides: Partial<{
    id: string;
    description: string;
    repos: string[];
    confidence: number;
    evidenceNotes: string[];
  }> = {},
) {
  return {
    id: "agent-workflow",
    description: "Cross-repo agent workflow changes.",
    repos: ["vercel/agents", "vercel/front"],
    confidence: 0.82,
    evidenceNotes: ["Recent PRs touched both repositories."],
    ...overrides,
  };
}

function template(id: string, repos: string[]): Template {
  return {
    id,
    path: `/tmp/${id}/template.jsonc`,
    directory: `/tmp/${id}`,
    parentId: id,
    config: { repos },
  };
}

function cachedRepository(name: string, slug: string): CachedRepository {
  return {
    name,
    slug,
    remote: `git@github.com:${slug}.git`,
    defaultBranch: null,
    mirrorPath: `/tmp/${name}.git`,
    directoryName: `${name}.git`,
    sizeBytes: null,
    lastFetchedAt: null,
    worktrees: [],
    health: "healthy",
    issues: [],
  };
}

async function fakeGhRunner(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  expect(command).toBe("gh");

  if (args[0] === "api") {
    return { stdout: "tomdale\n", stderr: "" };
  }

  if (args[0] === "search") {
    const role = args.includes("--author")
      ? "author"
      : args.includes("--reviewed-by")
        ? "reviewed"
        : "commented";
    if (role !== "author") {
      return { stdout: "[]", stderr: "" };
    }
    return {
      stdout: JSON.stringify([
        {
          repository: { nameWithOwner: "vercel/front" },
          number: 123,
          title: "Add agent UI",
          url: "https://github.com/vercel/front/pull/123",
          labels: [{ name: "feature" }],
          createdAt: "2026-06-20T00:00:00.000Z",
          closedAt: "2026-06-22T00:00:00.000Z",
          updatedAt: "2026-06-22T00:00:00.000Z",
        },
      ]),
      stderr: "",
    };
  }

  if (args[0] === "pr") {
    return {
      stdout: JSON.stringify({
        mergedAt: "2026-06-22T00:00:00.000Z",
        files: [{ path: "src/app/page.tsx" }],
      }),
      stderr: "",
    };
  }

  throw new Error(`Unexpected gh command: ${args.join(" ")}`);
}

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
