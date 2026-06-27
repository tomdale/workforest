import type {
  AiProviderContext,
  AiProviderDefinition,
  AiTextGenerationRequest,
  AiTextGenerationResult,
} from "@wf-plugin/core";
import { createClaudeEventStream } from "./claude-events.ts";
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
    const debug = isAiDebugEnabled(this.#context.env);
    const outputFormat = request.onEvent ? "stream-json" : "text";
    const args = [
      "--print",
      "--input-format",
      "text",
      "--output-format",
      outputFormat,
      "--no-session-persistence",
    ];
    const model = request.model ?? this.#context.model;
    if (model) {
      args.push("--model", model);
    }
    if (request.onEvent) {
      args.push("--verbose");
    }
    if (request.outputSchema) {
      args.push("--json-schema", JSON.stringify(request.outputSchema));
    }

    const eventStream = request.onEvent
      ? createClaudeEventStream(request.onEvent, { debug })
      : null;
    let streamFinished = false;
    try {
      const onDebug =
        debug && request.onEvent
          ? (message: string) =>
              request.onEvent?.({
                type: "diagnostic",
                source: "Claude",
                message,
              })
          : undefined;
      onDebug?.(`command: claude ${args.map(quoteArg).join(" ")}`);
      const result = await runCli("claude", args, {
        cwd: this.#context.cwd,
        env: this.#context.env,
        input: request.prompt,
        timeoutMs: request.timeoutMs ?? this.#context.timeoutMs,
        ...(eventStream ? { onOutput: eventStream.write } : {}),
        ...(onDebug ? { onDebug } : {}),
      });
      eventStream?.finish();
      streamFinished = true;
      if (result.code !== 0) {
        throw formatCliFailure("claude", result, SETUP_HINT);
      }

      return { text: eventStream?.text() ?? result.stdout };
    } finally {
      if (!streamFinished) eventStream?.finish();
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

const claudeCliProvider: AiProviderDefinition = {
  id: "claude-cli",
  label: "Claude CLI",
  priority: 50,
  capabilities: ["text"],
  modelCategories: { "generate-context": "claude-opus-4-5" },
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
