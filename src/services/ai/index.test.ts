import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AiUnavailableError, generateText, getAiStatus } from "./index.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("AI provider resolver", () => {
  it("auto-selects Codex CLI before Claude CLI", async () => {
    const fixture = await createFixture(["codex", "claude"]);

    const status = await getAiStatus({
      cwd: fixture.cwd,
      env: fixture.env,
      config: {},
    });
    const text = await generateText({
      prompt: "name this",
      cwd: fixture.cwd,
      env: fixture.env,
      config: {},
    });

    expect(status.selectedProvider).toBe("codex-cli");
    expect(text).toBe("codex:name this");
  });

  it("falls back to Claude CLI when Codex CLI is unavailable", async () => {
    const fixture = await createFixture(["claude"]);

    const status = await getAiStatus({
      cwd: fixture.cwd,
      env: fixture.env,
      config: {},
    });
    const text = await generateText({
      prompt: "name this",
      cwd: fixture.cwd,
      env: fixture.env,
      config: {},
    });

    expect(status.selectedProvider).toBe("claude-cli");
    expect(text).toBe("claude:name this");
  });

  it("streams concise Codex events while retaining the final response", async () => {
    const fixture = await createFixture(["codex"]);
    const events: unknown[] = [];

    const text = await generateText({
      prompt: "name this",
      cwd: fixture.cwd,
      env: fixture.env,
      config: {},
      onEvent: (event) => events.push(event),
    });

    expect(text).toBe("codex:name this");
    expect(events).toContainEqual({
      type: "activity",
      source: "Codex",
      activity: "command",
      description: "rg -n account src",
    });
    expect(events).toContainEqual({
      type: "usage",
      source: "Codex",
      inputTokens: 120,
      outputTokens: 8,
    });
  });

  it("uses env provider override before config provider override", async () => {
    const fixture = await createFixture(["codex", "claude"], {
      WORKFOREST_AI_PROVIDER: "claude-cli",
    });

    const status = await getAiStatus({
      cwd: fixture.cwd,
      env: fixture.env,
      config: { ai: { provider: "codex-cli" } },
    });

    expect(status.selectedProvider).toBe("claude-cli");
  });

  it("uses config provider override when env is unset", async () => {
    const fixture = await createFixture(["codex", "claude"]);

    const status = await getAiStatus({
      cwd: fixture.cwd,
      env: fixture.env,
      config: { ai: { provider: "claude-cli" } },
    });

    expect(status.selectedProvider).toBe("claude-cli");
  });

  it("resolves the mini model category through each provider", async () => {
    const codex = await createFixture(["codex"]);
    const claude = await createFixture(["claude"]);

    await expect(
      generateText({
        prompt: "report model",
        cwd: codex.cwd,
        env: codex.env,
        config: {},
        modelCategory: "mini",
      }),
    ).resolves.toBe("codex-model:gpt-5.4-mini");
    await expect(
      generateText({
        prompt: "report model",
        cwd: claude.cwd,
        env: claude.env,
        config: {},
        modelCategory: "mini",
      }),
    ).resolves.toBe("claude-model:haiku");
  });

  it("lets an explicit model override a normalized model category", async () => {
    const codex = await createFixture(["codex"]);

    await expect(
      generateText({
        prompt: "report model",
        cwd: codex.cwd,
        env: codex.env,
        config: { ai: { model: "configured-model" } },
        modelCategory: "mini",
      }),
    ).resolves.toBe("codex-model:configured-model");
  });

  it("passes structured output schemas through each provider", async () => {
    const schema = { type: "object" };
    const codex = await createFixture(["codex"]);
    const claude = await createFixture(["claude"]);

    await expect(
      generateText({
        prompt: "report schema",
        cwd: codex.cwd,
        env: codex.env,
        config: {},
        outputSchema: schema,
      }),
    ).resolves.toBe('codex-schema:{"type":"object"}');
    await expect(
      generateText({
        prompt: "report schema",
        cwd: claude.cwd,
        env: claude.env,
        config: {},
        outputSchema: schema,
      }),
    ).resolves.toBe('claude-schema:{"type":"object"}');
  });

  it("reports disabled mode and blocks generation", async () => {
    const fixture = await createFixture(["codex"]);

    const status = await getAiStatus({
      cwd: fixture.cwd,
      env: fixture.env,
      config: { ai: { disabled: true } },
    });

    expect(status.disabled).toBe(true);
    expect(status.selectedProvider).toBeNull();
    await expect(
      generateText({
        prompt: "name this",
        cwd: fixture.cwd,
        env: fixture.env,
        config: { ai: { disabled: true } },
      }),
    ).rejects.toThrow(AiUnavailableError);
  });

  it("hard-fails generation when no provider is available", async () => {
    const fixture = await createFixture([]);

    const status = await getAiStatus({
      cwd: fixture.cwd,
      env: fixture.env,
      config: {},
    });

    expect(status.selectedProvider).toBeNull();
    await expect(
      generateText({
        prompt: "name this",
        cwd: fixture.cwd,
        env: fixture.env,
        config: {},
      }),
    ).rejects.toThrow(/No usable AI provider|Install Codex CLI/);
  });
});

async function createFixture(
  binaries: Array<"codex" | "claude">,
  env: NodeJS.ProcessEnv = {},
): Promise<{ cwd: string; env: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "workforest-ai-"));
  tempDirs.push(root);
  const binDir = path.join(root, "bin");
  await mkdir(binDir);

  await Promise.all(
    binaries.map((binary) =>
      writeExecutable(
        path.join(binDir, binary),
        binary === "codex" ? codexScript() : claudeScript(),
      ),
    ),
  );

  return {
    cwd: root,
    env: {
      HOME: root,
      PATH: [binDir, "/usr/bin", "/bin"].join(path.delimiter),
      PWD: root,
      ...env,
    },
  };
}

async function writeExecutable(
  filePath: string,
  contents: string,
): Promise<void> {
  await writeFile(filePath, contents, "utf8");
  await chmod(filePath, 0o755);
}

function codexScript(): string {
  return `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'codex 1.0.0\\n'
  exit 0
fi
output_file=""
model=""
schema_file=""
previous=""
for arg in "$@"; do
  if [ "$previous" = "--output-last-message" ]; then
    output_file="$arg"
  fi
  if [ "$previous" = "--model" ]; then
    model="$arg"
  fi
  if [ "$previous" = "--output-schema" ]; then
    schema_file="$arg"
  fi
  previous="$arg"
done
input="$(cat)"
printf '%s\n' '{"type":"item.started","item":{"type":"command_execution","command":"rg -n account src","status":"in_progress"}}'
printf '%s\n' '{"type":"item.completed","item":{"type":"command_execution","aggregated_output":"large command output","status":"completed"}}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"result\\":\\"hidden final JSON\\"}"}}'
printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":120,"output_tokens":8}}'
if [ "$input" = "report model" ]; then
  printf 'codex-model:%s' "$model" >"$output_file"
elif [ "$input" = "report schema" ]; then
  printf 'codex-schema:' >"$output_file"
  cat "$schema_file" >>"$output_file"
else
  printf 'codex:%s' "$input" >"$output_file"
fi
`;
}

function claudeScript(): string {
  return `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'claude 1.0.0\\n'
  exit 0
fi
model=""
schema=""
previous=""
for arg in "$@"; do
  if [ "$previous" = "--model" ]; then model="$arg"; fi
  if [ "$previous" = "--json-schema" ]; then schema="$arg"; fi
  previous="$arg"
done
input="$(cat)"
if [ "$input" = "report model" ]; then
  printf 'claude-model:%s' "$model"
elif [ "$input" = "report schema" ]; then
  printf 'claude-schema:%s' "$schema"
else
  printf 'claude:%s' "$input"
fi
`;
}
