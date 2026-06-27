import type {
  AiProviderContext,
  AiProviderDefinition,
  AiTextGenerationRequest,
  AiTextGenerationResult,
} from "@wf-plugin/core";
import { commandAvailable, formatCliFailure, runCli } from "@wf-plugin/core";

const SETUP_HINT = "Install Claude Code and run `claude auth login`.";

class ClaudeCliClient {
  readonly #context: AiProviderContext;

  constructor(context: AiProviderContext) {
    this.#context = context;
  }

  async generateText(
    request: AiTextGenerationRequest,
  ): Promise<AiTextGenerationResult> {
    const args = [
      "--print",
      "--input-format",
      "text",
      "--output-format",
      "text",
      "--no-session-persistence",
    ];
    const model = request.model ?? this.#context.model;
    if (model) {
      args.push("--model", model);
    }

    const result = await runCli("claude", args, {
      cwd: this.#context.cwd,
      env: this.#context.env,
      input: request.prompt,
      timeoutMs: request.timeoutMs ?? this.#context.timeoutMs,
    });
    if (result.code !== 0) {
      throw formatCliFailure("claude", result, SETUP_HINT);
    }

    return { text: result.stdout };
  }
}

const claudeCliProvider: AiProviderDefinition = {
  id: "claude-cli",
  label: "Claude CLI",
  priority: 50,
  capabilities: ["text"],
  async detect(context) {
    if (await commandAvailable("claude", ["--version"], context)) {
      return { available: true };
    }

    return {
      available: false,
      setupHint: SETUP_HINT,
      reason: "claude executable was not found on PATH.",
    };
  },
  create(context) {
    return new ClaudeCliClient(context);
  },
};

export default claudeCliProvider;
