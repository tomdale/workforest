import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGit } from "../services/git.ts";
import {
  agentsMdDirectory,
  agentsMdScopeFingerprint,
  agentsMdTemplateFilesFingerprint,
  getTemplateAgentsMdStatus,
  getWorkspaceAgentsMdStatus,
  materializeTemplateAgentsMd,
  refreshAndMaterializeTemplateAgentsMd,
  refreshTemplateAgentsMd,
} from "./agents-md.ts";
import {
  createTemplate,
  createTemplateVariant,
  loadTemplate,
  type Template,
} from "./index.ts";

const originalXdgConfigHome = process.env["XDG_CONFIG_HOME"];
const originalCacheDir = process.env["WORKFOREST_CACHE_DIR"];
const originalAiProvider = process.env["WORKFOREST_AI_PROVIDER"];
const originalAiDisabled = process.env["WORKFOREST_AI_DISABLED"];
const originalPath = process.env["PATH"];
const originalPromptLog = process.env["WORKFOREST_PROMPT_LOG"];
const originalShell = process.env["SHELL"];
const roots: string[] = [];

afterEach(async () => {
  if (originalXdgConfigHome === undefined)
    delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = originalXdgConfigHome;
  restoreEnvironment("WORKFOREST_CACHE_DIR", originalCacheDir);
  restoreEnvironment("WORKFOREST_AI_PROVIDER", originalAiProvider);
  restoreEnvironment("WORKFOREST_AI_DISABLED", originalAiDisabled);
  restoreEnvironment("PATH", originalPath);
  restoreEnvironment("WORKFOREST_PROMPT_LOG", originalPromptLog);
  restoreEnvironment("SHELL", originalShell);
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{ template: Template; workspace: string }> {
  const config = await mkdtemp(path.join(os.tmpdir(), "wf-agents-config-"));
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "wf-agents-workspace-"),
  );
  roots.push(config, workspace);
  process.env["XDG_CONFIG_HOME"] = config;
  await createTemplate("settings", {
    repos: ["vercel/front"],
    "AGENTS.md": { focus: "Settings flow", paths: { front: ["src"] } },
  });
  const template = await loadTemplate("settings");
  if (!template) throw new Error("Expected template");
  return { template, workspace };
}

async function publish(
  template: Template,
  generatedAt: Date,
  expiresAt: Date,
): Promise<void> {
  const directory = agentsMdDirectory(template);
  const artifact = `AGENTS-${generatedAt
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")}.md`;
  const contents = `<!-- generated -->\n\n# Focus\n`;
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, artifact), contents, "utf8");
  await writeFile(
    path.join(directory, "manifest.json"),
    `${JSON.stringify(
      {
        version: 1,
        templateId: template.id,
        artifact,
        sha256: createHash("sha256").update(contents).digest("hex"),
        scopeFingerprint: agentsMdScopeFingerprint(template),
        generatedAt: generatedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        sourceRevisions: { front: "abc" },
        templateFilesFingerprint:
          await agentsMdTemplateFilesFingerprint(template),
        provider: "fake",
        model: null,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

describe("template AGENTS.md artifacts", () => {
  it("does not remove parent authored guidance when forcing a variant refresh", async () => {
    const config = await mkdtemp(path.join(os.tmpdir(), "wf-agents-config-"));
    roots.push(config);
    process.env["XDG_CONFIG_HOME"] = config;
    await createTemplate("settings", {
      repos: ["vercel/front"],
      "AGENTS.md": { focus: "Settings flow", paths: { front: ["src"] } },
    });
    await createTemplateVariant("settings", "chat", {
      "AGENTS.md": { focus: "Chat settings flow" },
    });
    const parentAgents = path.join(
      config,
      "workforest",
      "templates",
      "settings",
      "files",
      "AGENTS.md",
    );
    await mkdir(path.dirname(parentAgents), { recursive: true });
    await writeFile(parentAgents, "parent guidance\n", "utf8");
    const variant = await loadTemplate("settings+chat");
    if (!variant) throw new Error("Expected variant");

    await expect(
      refreshTemplateAgentsMd(
        variant,
        [
          {
            name: "front",
            remote: "git@github.com:vercel/front.git",
          },
        ],
        { force: true },
      ),
    ).rejects.toThrow("inherits files/AGENTS.md from its parent");
    await expect(readFile(parentAgents, "utf8")).resolves.toBe(
      "parent guidance\n",
    );
  });

  it("asks the provider to author markdown from compact exploration context", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wf-agents-explore-"));
    roots.push(root);
    const source = path.join(root, "source");
    const configHome = path.join(root, "config");
    const cache = path.join(root, "cache");
    const bin = path.join(root, "bin");
    const promptLog = path.join(root, "prompts.log");
    await mkdir(path.join(source, "src"), { recursive: true });
    await mkdir(bin);
    await runGit(["init", "-b", "main"], { cwd: source });
    await runGit(["config", "user.email", "test@example.com"], {
      cwd: source,
    });
    await runGit(["config", "user.name", "Test"], { cwd: source });
    await runGit(["config", "commit.gpgsign", "false"], { cwd: source });
    await writeFile(
      path.join(source, "src", "settings.ts"),
      `export const settings = true;\n${"// implementation detail\n".repeat(5_000)}`,
      "utf8",
    );
    await runGit(["add", "src/settings.ts"], { cwd: source });
    await runGit(["commit", "-m", "add settings"], { cwd: source });
    await writeFile(
      path.join(bin, "codex"),
      fakeCodexScript(
        [
          "<agents_md>",
          "Template: explore.",
          "Scope: Settings are loaded through `source/src/settings.ts`.",
          "</agents_md>",
          "",
        ].join("\n"),
      ),
      "utf8",
    );
    await chmod(path.join(bin, "codex"), 0o755);

    process.env["XDG_CONFIG_HOME"] = configHome;
    process.env["WORKFOREST_CACHE_DIR"] = cache;
    process.env["WORKFOREST_AI_PROVIDER"] = "codex-cli";
    delete process.env["WORKFOREST_AI_DISABLED"];
    process.env["WORKFOREST_PROMPT_LOG"] = promptLog;
    process.env["PATH"] = `${bin}${path.delimiter}${originalPath ?? ""}`;
    delete process.env["SHELL"];
    await createTemplate("explore", {
      repos: [`file://${source}`],
      "AGENTS.md": {
        focus: "How settings are loaded.",
        paths: { source: ["src"] },
      },
    });
    const template = await loadTemplate("explore");
    if (!template) throw new Error("Expected template");
    const filesDir = path.join(path.dirname(template.path), "files");
    await mkdir(path.join(filesDir, "source"), { recursive: true });
    await writeFile(
      path.join(filesDir, "README.md"),
      "Workspace root notes for settings work.\n",
      "utf8",
    );
    await writeFile(
      path.join(filesDir, "source", "AGENTS.md"),
      "Nested template overlay instructions.\n",
      "utf8",
    );

    const result = await refreshTemplateAgentsMd(template, [
      {
        name: "source",
        remote: `file://${source}`,
      },
    ]);

    const prompts = (await readFile(promptLog, "utf8"))
      .split("\n---PROMPT---\n")
      .filter(Boolean);
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0];
    if (!prompt) throw new Error("Expected prompt");
    expect(prompt).toEqual(expect.stringContaining("explore"));
    expect(prompt).toEqual(expect.stringContaining("How settings are loaded."));
    expect(prompt).toEqual(expect.stringContaining("source/src"));
    expect(prompt).toEqual(
      expect.stringContaining("Template-provided workspace root files:"),
    );
    expect(prompt).toEqual(
      expect.stringContaining(
        "workspace `README.md`: staged at `.workforest/template-files/README.md`",
      ),
    );
    expect(prompt).toEqual(
      expect.stringContaining(
        "workspace `source/AGENTS.md`: staged at `.workforest/template-files/source/AGENTS.md`",
      ),
    );
    expect(prompt).toMatch(/<agents_md>[\s\S]*<\/agents_md>/);
    expect(prompt).not.toContain("implementation detail");
    expect(result.manifest).not.toBeNull();
    expect(Object.keys(result.manifest ?? {})).toEqual([
      "version",
      "templateId",
      "artifact",
      "sha256",
      "scopeFingerprint",
      "generatedAt",
      "expiresAt",
      "sourceRevisions",
      "templateFilesFingerprint",
      "provider",
      "model",
    ]);
    expect(result.manifest?.sourceRevisions).toEqual({
      source: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    expect(result.manifest?.model).toBe("gpt-5.4");

    if (!result.artifactPath) throw new Error("Expected artifact path");
    const artifact = await readFile(result.artifactPath, "utf8");
    expect(artifact).toContain("<!-- Managed by Workforest.");
    expect(artifact).not.toContain("<agents_md>");
    expect(artifact).not.toMatch(/^# /m);
    expect(artifact).toContain("Template: explore.");
    expect(artifact).toContain("Scope: Settings");
  });

  it("uses the mirror default branch when preparing sources", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wf-agents-master-"));
    roots.push(root);
    const source = path.join(root, "source");
    const configHome = path.join(root, "config");
    const cache = path.join(root, "cache");
    const bin = path.join(root, "bin");
    await mkdir(path.join(source, "src"), { recursive: true });
    await mkdir(bin);
    await runGit(["init", "-b", "master"], { cwd: source });
    await runGit(["config", "user.email", "test@example.com"], {
      cwd: source,
    });
    await runGit(["config", "user.name", "Test"], { cwd: source });
    await runGit(["config", "commit.gpgsign", "false"], { cwd: source });
    await writeFile(
      path.join(source, "src", "integration.ts"),
      "export const integration = true;\n",
      "utf8",
    );
    await runGit(["add", "src/integration.ts"], { cwd: source });
    await runGit(["commit", "-m", "add integration"], { cwd: source });
    await mkdir(cache, { recursive: true });
    await runGit(
      ["clone", "--mirror", `file://${source}`, path.join(cache, "source.git")],
      { cwd: root },
    );
    await writeFile(
      path.join(bin, "codex"),
      fakeCodexScript(
        [
          "<agents_md>",
          "Template: master-default.",
          "Scope: Start in source/src/integration.ts.",
          "</agents_md>",
        ].join("\n"),
      ),
      "utf8",
    );
    await chmod(path.join(bin, "codex"), 0o755);

    process.env["XDG_CONFIG_HOME"] = configHome;
    process.env["WORKFOREST_CACHE_DIR"] = cache;
    process.env["WORKFOREST_AI_PROVIDER"] = "codex-cli";
    delete process.env["WORKFOREST_AI_DISABLED"];
    process.env["PATH"] = `${bin}${path.delimiter}${originalPath ?? ""}`;
    delete process.env["SHELL"];
    await createTemplate("master-default", {
      repos: [`file://${source}`],
      "AGENTS.md": {
        focus: "How integrations are wired.",
        paths: { source: ["src"] },
      },
    });
    const template = await loadTemplate("master-default");
    if (!template) throw new Error("Expected template");

    const result = await refreshTemplateAgentsMd(template, [
      {
        name: "source",
        remote: `file://${source}`,
      },
    ]);

    expect(result.state).toBe("fresh");
    if (!result.artifactPath) throw new Error("Expected artifact path");
    expect(await readFile(result.artifactPath, "utf8")).toContain(
      "Scope: Start in source/src/integration.ts.",
    );
  });

  it("requires generated guidance to use the agents_md envelope", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wf-agents-envelope-"));
    roots.push(root);
    const source = path.join(root, "source");
    const configHome = path.join(root, "config");
    const cache = path.join(root, "cache");
    const bin = path.join(root, "bin");
    const promptLog = path.join(root, "prompts.log");
    await mkdir(path.join(source, "src"), { recursive: true });
    await mkdir(bin);
    await runGit(["init", "-b", "main"], { cwd: source });
    await runGit(["config", "user.email", "test@example.com"], {
      cwd: source,
    });
    await runGit(["config", "user.name", "Test"], { cwd: source });
    await runGit(["config", "commit.gpgsign", "false"], { cwd: source });
    await writeFile(
      path.join(source, "src", "settings.ts"),
      "export const settings = true;\n",
      "utf8",
    );
    await runGit(["add", "src/settings.ts"], { cwd: source });
    await runGit(["commit", "-m", "add settings"], { cwd: source });
    await writeFile(
      path.join(bin, "codex"),
      fakeCodexScript(
        "Template: missing-envelope. Scope: usable but not wrapped.",
      ),
      "utf8",
    );
    await chmod(path.join(bin, "codex"), 0o755);

    process.env["XDG_CONFIG_HOME"] = configHome;
    process.env["WORKFOREST_CACHE_DIR"] = cache;
    process.env["WORKFOREST_AI_PROVIDER"] = "codex-cli";
    delete process.env["WORKFOREST_AI_DISABLED"];
    process.env["WORKFOREST_PROMPT_LOG"] = promptLog;
    process.env["PATH"] = `${bin}${path.delimiter}${originalPath ?? ""}`;
    delete process.env["SHELL"];
    await createTemplate("missing-envelope", {
      repos: [`file://${source}`],
      "AGENTS.md": {
        focus: "How settings are loaded.",
        paths: { source: ["src"] },
      },
    });
    const template = await loadTemplate("missing-envelope");
    if (!template) throw new Error("Expected template");

    await expect(
      refreshTemplateAgentsMd(template, [
        {
          name: "source",
          remote: `file://${source}`,
        },
      ]),
    ).rejects.toThrow(/<agents_md>/);
  });

  it("reports fresh and expired at the exact TTL boundary", async () => {
    const { template } = await fixture();
    const generated = new Date("2026-06-26T10:00:00.000Z");
    const expires = new Date("2026-06-27T10:00:00.000Z");
    await publish(template, generated, expires);

    expect(
      (
        await getTemplateAgentsMdStatus(
          template,
          new Date(expires.getTime() - 1),
        )
      ).state,
    ).toBe("fresh");
    expect((await getTemplateAgentsMdStatus(template, expires)).state).toBe(
      "expired",
    );
  });

  it("detects scope and artifact modifications", async () => {
    const { template } = await fixture();
    await publish(
      template,
      new Date("2026-06-26T10:00:00Z"),
      new Date("2026-06-27T10:00:00Z"),
    );
    const manifest = JSON.parse(
      await readFile(
        path.join(agentsMdDirectory(template), "manifest.json"),
        "utf8",
      ),
    );
    await writeFile(
      path.join(agentsMdDirectory(template), manifest.artifact),
      "changed\n",
      "utf8",
    );
    expect(
      (
        await getTemplateAgentsMdStatus(
          template,
          new Date("2026-06-26T11:00:00Z"),
        )
      ).state,
    ).toBe("modified");

    template.config["AGENTS.md"] = {
      focus: "A different scope",
      maxAgeHours: 24,
    };
    expect(
      (
        await getTemplateAgentsMdStatus(
          template,
          new Date("2026-06-26T11:00:00Z"),
        )
      ).state,
    ).toBe("scope-changed");
  });

  it("detects template root file changes as scope changes", async () => {
    const { template } = await fixture();
    await publish(
      template,
      new Date("2026-06-26T10:00:00Z"),
      new Date("2026-06-27T10:00:00Z"),
    );

    expect(
      (
        await getTemplateAgentsMdStatus(
          template,
          new Date("2026-06-26T11:00:00Z"),
        )
      ).state,
    ).toBe("fresh");

    const filesDir = path.join(path.dirname(template.path), "files");
    await mkdir(filesDir, { recursive: true });
    await writeFile(
      path.join(filesDir, "README.md"),
      "Workspace-level setup notes changed.\n",
      "utf8",
    );

    expect(
      (
        await getTemplateAgentsMdStatus(
          template,
          new Date("2026-06-26T11:00:00Z"),
        )
      ).state,
    ).toBe("scope-changed");
  });

  it("materializes with the default generated file and symlink", async () => {
    const { template, workspace } = await fixture();
    const generated = new Date("2026-06-26T10:00:00Z");
    const expires = new Date("2026-06-27T10:00:00Z");
    await publish(template, generated, expires);
    await materializeTemplateAgentsMd(template, workspace, { now: generated });
    expect(await readFile(path.join(workspace, "AGENTS.md"), "utf8")).toContain(
      "# Focus",
    );
    await materializeTemplateAgentsMd(template, workspace, { now: expires });
    expect(await readFile(path.join(workspace, "AGENTS.md"), "utf8")).toContain(
      "guidance unavailable",
    );
    await expect(readlink(path.join(workspace, "CLAUDE.md"))).resolves.toBe(
      "AGENTS.md",
    );
  });

  it("materializes a nested generated file and nested symlink", async () => {
    const { template, workspace } = await fixture();
    const generated = new Date("2026-06-26T10:00:00Z");
    const expires = new Date("2026-06-27T10:00:00Z");
    if (!template.config["AGENTS.md"]) throw new Error("Expected config");
    template.config["AGENTS.md"].file = ".agents/AGENTS.md";
    template.config["AGENTS.md"].symlinks = ["docs/CLAUDE.md"];
    await publish(template, generated, expires);

    await materializeTemplateAgentsMd(template, workspace, { now: generated });

    await expect(
      readFile(path.join(workspace, ".agents", "AGENTS.md"), "utf8"),
    ).resolves.toContain("# Focus");
    await expect(
      readlink(path.join(workspace, "docs", "CLAUDE.md")),
    ).resolves.toBe("../.agents/AGENTS.md");
  });

  it("reports missing workspace guidance when the default CLAUDE.md symlink is removed", async () => {
    const { template, workspace } = await fixture();
    const generated = new Date("2026-06-26T10:00:00Z");
    const expires = new Date("2026-06-27T10:00:00Z");
    await publish(template, generated, expires);
    await materializeTemplateAgentsMd(template, workspace, { now: generated });
    await rm(path.join(workspace, "CLAUDE.md"));

    await expect(
      getWorkspaceAgentsMdStatus(template, workspace, generated),
    ).resolves.toMatchObject({ state: "missing" });
  });

  it("does not create symlinks when configured with an empty symlink list", async () => {
    const { template, workspace } = await fixture();
    const generated = new Date("2026-06-26T10:00:00Z");
    const expires = new Date("2026-06-27T10:00:00Z");
    if (!template.config["AGENTS.md"]) throw new Error("Expected config");
    template.config["AGENTS.md"].symlinks = [];
    await publish(template, generated, expires);

    await materializeTemplateAgentsMd(template, workspace, { now: generated });

    await expect(readlink(path.join(workspace, "CLAUDE.md"))).rejects.toThrow();
  });

  it("excludes a custom generated file from template files", async () => {
    const { template } = await fixture();
    if (!template.config["AGENTS.md"]) throw new Error("Expected config");
    template.config["AGENTS.md"].file = ".agents/AGENTS.md";
    const filesDir = path.join(path.dirname(template.path), "files");
    await mkdir(path.join(filesDir, ".agents"), { recursive: true });
    await writeFile(
      path.join(filesDir, ".agents", "AGENTS.md"),
      "authored guidance\n",
      "utf8",
    );

    await expect(agentsMdTemplateFilesFingerprint(template)).resolves.toBe(
      createHash("sha256").update(JSON.stringify([])).digest("hex"),
    );
  });

  it("refreshes missing guidance automatically before materializing a workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wf-agents-auto-"));
    roots.push(root);
    const source = path.join(root, "source");
    const configHome = path.join(root, "config");
    const cache = path.join(root, "cache");
    const bin = path.join(root, "bin");
    const workspace = path.join(root, "workspace");
    const promptLog = path.join(root, "prompts.log");
    await mkdir(path.join(source, "src"), { recursive: true });
    await mkdir(bin);
    await mkdir(workspace);
    await runGit(["init", "-b", "main"], { cwd: source });
    await runGit(["config", "user.email", "test@example.com"], {
      cwd: source,
    });
    await runGit(["config", "user.name", "Test"], { cwd: source });
    await runGit(["config", "commit.gpgsign", "false"], { cwd: source });
    await writeFile(
      path.join(source, "src", "settings.ts"),
      "export const settings = true;\n",
      "utf8",
    );
    await runGit(["add", "src/settings.ts"], { cwd: source });
    await runGit(["commit", "-m", "add settings"], { cwd: source });
    await writeFile(
      path.join(bin, "codex"),
      fakeCodexScript(
        [
          "<agents_md>",
          "Template: auto.",
          "Scope: Start in source/src/settings.ts.",
          "</agents_md>",
        ].join("\n"),
      ),
      "utf8",
    );
    await chmod(path.join(bin, "codex"), 0o755);

    process.env["XDG_CONFIG_HOME"] = configHome;
    process.env["WORKFOREST_CACHE_DIR"] = cache;
    process.env["WORKFOREST_AI_PROVIDER"] = "codex-cli";
    delete process.env["WORKFOREST_AI_DISABLED"];
    process.env["WORKFOREST_PROMPT_LOG"] = promptLog;
    process.env["PATH"] = `${bin}${path.delimiter}${originalPath ?? ""}`;
    delete process.env["SHELL"];
    await createTemplate("auto", {
      repos: [`file://${source}`],
      "AGENTS.md": {
        focus: "How settings are loaded.",
        paths: { source: ["src"] },
      },
    });
    const template = await loadTemplate("auto");
    if (!template) throw new Error("Expected template");
    const progress: string[] = [];

    const result = await refreshAndMaterializeTemplateAgentsMd(
      template,
      workspace,
      [
        {
          name: "source",
          remote: `file://${source}`,
        },
      ],
      { onProgress: (message) => progress.push(message) },
    );

    expect(result.state).toBe("fresh");
    expect(progress).toEqual(
      expect.arrayContaining([
        "AGENTS.md guidance is missing; refreshing automatically…",
        "Materializing AGENTS.md guidance…",
      ]),
    );
    expect(await readFile(path.join(workspace, "AGENTS.md"), "utf8")).toContain(
      "Scope: Start in source/src/settings.ts.",
    );
  });

  it("falls closed to an unavailable workspace document when automatic refresh fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wf-agents-fail-"));
    roots.push(root);
    const source = path.join(root, "source");
    const configHome = path.join(root, "config");
    const cache = path.join(root, "cache");
    const workspace = path.join(root, "workspace");
    await mkdir(path.join(source, "src"), { recursive: true });
    await mkdir(workspace);
    await runGit(["init", "-b", "main"], { cwd: source });
    await runGit(["config", "user.email", "test@example.com"], {
      cwd: source,
    });
    await runGit(["config", "user.name", "Test"], { cwd: source });
    await runGit(["config", "commit.gpgsign", "false"], { cwd: source });
    await writeFile(
      path.join(source, "src", "settings.ts"),
      "export const settings = true;\n",
      "utf8",
    );
    await runGit(["add", "src/settings.ts"], { cwd: source });
    await runGit(["commit", "-m", "add settings"], { cwd: source });

    process.env["XDG_CONFIG_HOME"] = configHome;
    process.env["WORKFOREST_CACHE_DIR"] = cache;
    process.env["WORKFOREST_AI_DISABLED"] = "1";
    await createTemplate("auto-fail", {
      repos: [`file://${source}`],
      "AGENTS.md": {
        focus: "How settings are loaded.",
        paths: { source: ["src"] },
      },
    });
    const template = await loadTemplate("auto-fail");
    if (!template) throw new Error("Expected template");
    const warnings: string[] = [];

    const result = await refreshAndMaterializeTemplateAgentsMd(
      template,
      workspace,
      [
        {
          name: "source",
          remote: `file://${source}`,
        },
      ],
      { onWarning: (message) => warnings.push(message) },
    );

    expect(result.state).toBe("missing");
    expect(warnings[0]).toContain("Could not refresh AGENTS.md guidance:");
    expect(await readFile(path.join(workspace, "AGENTS.md"), "utf8")).toContain(
      "guidance unavailable",
    );
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function fakeCodexScript(response: string): string {
  return `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'codex 1.0.0\\n'
  exit 0
fi
output_file=""
model=""
previous=""
for arg in "$@"; do
  if [ "$previous" = "--output-last-message" ]; then output_file="$arg"; fi
  if [ "$previous" = "--model" ]; then model="$arg"; fi
  if [ "$arg" = "--output-schema" ]; then exit 3; fi
  previous="$arg"
done
[ "$model" = "gpt-5.4" ] || exit 2
input="$(cat)"
printf '%s\\n---PROMPT---\\n' "$input" >> "$WORKFOREST_PROMPT_LOG"
printf '%s' ${JSON.stringify(response)} > "$output_file"
`;
}
