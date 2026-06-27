import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AiProviderContext,
  AiProviderDefinition,
  AiTextGenerationRequest,
  AiTextGenerationResult,
} from "@wf-plugin/core";
import { commandAvailable, formatCliFailure, runCli } from "@wf-plugin/core";
import { createCodexEventStream } from "./codex-events.ts";

const SETUP_HINT = "Install Codex CLI and run `codex login`.";

class CodexCliClient {
  readonly #context: AiProviderContext;

  constructor(context: AiProviderContext) {
    this.#context = context;
  }

  async generateText(
    request: AiTextGenerationRequest,
  ): Promise<AiTextGenerationResult> {
    const outputFile = path.join(
      os.tmpdir(),
      `workforest-codex-${process.pid}-${Date.now()}.txt`,
    );
    const schemaFile = `${outputFile}.schema.json`;
    const debug = isAiDebugEnabled(this.#context.env);
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--json",
      "--color",
      "never",
      "--sandbox",
      "read-only",
      "-C",
      this.#context.cwd,
      "--output-last-message",
      outputFile,
    ];
    const model = request.model ?? this.#context.model;
    if (model) {
      args.push("--model", model);
    }
    if (request.outputSchema) {
      await fs.writeFile(schemaFile, JSON.stringify(request.outputSchema));
      args.push("--output-schema", schemaFile);
    }
    args.push("-");

    const eventStream = request.onEvent
      ? createCodexEventStream(request.onEvent, { debug })
      : null;
    try {
      const onDebug =
        debug && request.onEvent
          ? (message: string) =>
              request.onEvent?.({
                type: "diagnostic",
                source: "Codex",
                message,
              })
          : undefined;
      onDebug?.(`output-last-message: ${outputFile}`);
      onDebug?.(`command: codex ${args.map(quoteArg).join(" ")}`);
      const result = await runCli("codex", args, {
        cwd: this.#context.cwd,
        env: this.#context.env,
        input: request.prompt,
        timeoutMs: request.timeoutMs ?? this.#context.timeoutMs,
        ...(eventStream ? { onOutput: eventStream.write } : {}),
        ...(onDebug ? { onDebug } : {}),
      });
      if (result.code !== 0) {
        throw formatCliFailure("codex", result, SETUP_HINT);
      }

      const text = await fs.readFile(outputFile, "utf8");
      return { text };
    } finally {
      eventStream?.finish();
      await Promise.all([
        fs.rm(outputFile, { force: true }),
        fs.rm(schemaFile, { force: true }),
      ]);
    }
  }
}

function isAiDebugEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env["WORKFOREST_AI_DEBUG"];
  return value === "1" || value === "true" || value === "yes";
}

function quoteArg(value: string): string {
  return /^[A-Za-z0-9_./:=@-]+$/.test(value)
    ? value
    : JSON.stringify(value);
}

const codexCliProvider: AiProviderDefinition = {
  id: "codex-cli",
  label: "Codex CLI",
  priority: 100,
  capabilities: ["text"],
  modelCategories: { mini: "gpt-5.4-mini" },
  async detect(context) {
    if (await commandAvailable("codex", ["--version"], context)) {
      return { available: true };
    }

    return {
      available: false,
      setupHint: SETUP_HINT,
      reason: "codex executable was not found on PATH.",
    };
  },
  create(context) {
    return new CodexCliClient(context);
  },
};

export default codexCliProvider;
