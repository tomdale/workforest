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
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
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
    args.push("-");

    try {
      const result = await runCli("codex", args, {
        cwd: this.#context.cwd,
        env: this.#context.env,
        input: request.prompt,
        timeoutMs: request.timeoutMs ?? this.#context.timeoutMs,
      });
      if (result.code !== 0) {
        throw formatCliFailure("codex", result, SETUP_HINT);
      }

      const text = await fs.readFile(outputFile, "utf8");
      return { text };
    } finally {
      await fs.rm(outputFile, { force: true });
    }
  }
}

const codexCliProvider: AiProviderDefinition = {
  id: "codex-cli",
  label: "Codex CLI",
  priority: 100,
  capabilities: ["text"],
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
