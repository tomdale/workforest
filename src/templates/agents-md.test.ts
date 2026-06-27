import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
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
  getTemplateAgentsMdStatus,
  materializeTemplateAgentsMd,
  refreshTemplateAgentsMd,
} from "./agents-md.ts";
import { createTemplate, loadTemplate, type Template } from "./index.ts";

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
    await writeFile(
      path.join(source, "src", "settings.ts"),
      `export const settings = true;\n${"// implementation detail\n".repeat(5_000)}`,
      "utf8",
    );
    await runGit(["add", "src/settings.ts"], { cwd: source });
    await runGit(["commit", "-m", "add settings"], { cwd: source });
    await writeFile(path.join(bin, "codex"), fakeCodexScript(), "utf8");
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

    const result = await refreshTemplateAgentsMd(template, [
      {
        name: "source",
        remote: `file://${source}`,
        defaultBranch: "main",
      },
    ]);

    const prompts = (await readFile(promptLog, "utf8"))
      .split("\n---PROMPT---\n")
      .filter(Boolean);
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0];
    if (!prompt) throw new Error("Expected prompt");
    expect(prompt).toContain(
      "You are drafting the Markdown body for the root AGENTS.md for Workforest template `explore`.",
    );
    expect(prompt).toContain("Operating context:");
    expect(prompt).toContain(
      "A Workforest workspace is a local working directory created from a template,",
    );
    expect(prompt).toContain(
      "Assume it starts at the workspace root, then enters repository directories",
    );
    expect(prompt).toContain("Why this file exists:");
    expect(prompt).toContain(
      "Without a root guide, coding agents waste context rediscovering repository boundaries",
    );
    expect(prompt).toContain("Success criteria:");
    expect(prompt).toContain("Exploration budget and stop rules:");
    expect(prompt).toContain(
      "The useful outcome is a compact router that helps the next agent choose the right repository",
    );
    expect(prompt).toContain("Configured focus:\nHow settings are loaded.");
    expect(prompt).toContain(
      "- source: checkout directory `source/`; path hints: `source/src`",
    );
    expect(prompt).toContain("Output only Markdown for the file body.");
    expect(prompt).toContain(
      "Do not create, edit, or request permission to write files.",
    );
    expect(prompt).toContain(
      "Workforest will write the artifact after your final answer.",
    );
    expect(prompt).toContain(
      "Do not duplicate instructions already covered by repository or nested AGENTS.md files",
    );
    expect(prompt).toContain(
      "Do not inline exhaustive research notes, architecture walkthroughs, API inventories, or incident histories.",
    );
    expect(prompt).toContain(
      "representative owner files and seams, not every helper in the call graph.",
    );
    expect(prompt).toContain(
      "roughly 6-12 shell commands across all repositories for normal templates.",
    );
    expect(prompt).toContain(
      "Do not inspect another file just to make the guide more complete.",
    );
    expect(prompt).toContain(
      "Memoize repeated exploration patterns as short recipes",
    );
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
      "provider",
      "model",
    ]);
    expect(result.manifest?.sourceRevisions).toEqual({
      source: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    expect(result.manifest?.model).toBe("gpt-5.4-mini");

    if (!result.artifactPath) throw new Error("Expected artifact path");
    const artifact = await readFile(result.artifactPath, "utf8");
    expect(artifact).toContain("<!-- Managed by Workforest.");
    expect(artifact).toContain("# Workspace guidance for explore");
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

  it("materializes only at the workspace root and fails closed after expiry", async () => {
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
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function fakeCodexScript(): string {
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
[ "$model" = "gpt-5.4-mini" ] || exit 2
input="$(cat)"
printf '%s\\n---PROMPT---\\n' "$input" >> "$WORKFOREST_PROMPT_LOG"
response='# Workspace guidance for explore

## Scope

Settings are loaded through \`source/src/settings.ts\`.
'
printf '%s' "$response" > "$output_file"
`;
}
