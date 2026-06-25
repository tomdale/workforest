import { AiUnavailableError } from "../services/ai/index.ts";
import {
  saveTemplateSuggestions,
  suggestTemplates,
  TemplateSuggestionError,
  type TemplateSuggestionPhase,
  type TemplateSuggestionResult,
  type TemplateSuggestionStatusEvent,
} from "../services/template-suggestions.ts";
import { printReport } from "../terminal/report.ts";
import {
  CancelError,
  intro,
  outro,
  promptConfirm,
  promptLog,
  promptMultiSelect,
} from "../ui/prompts/index.ts";
import { OperationalError } from "./errors.ts";
import { success } from "./output.ts";
import type { CommandResult } from "./types.ts";

export type RunTemplateSuggestCommandOptions = {
  interactive: boolean;
  suggest?: typeof suggestTemplates;
  save?: typeof saveTemplateSuggestions;
};

export async function runTemplateSuggestCommand(
  options: RunTemplateSuggestCommandOptions,
): Promise<CommandResult> {
  if (!options.interactive) {
    throw new OperationalError(
      "Template suggestions require an interactive terminal.\nRun `wf template suggest` in a terminal so you can review and confirm templates before saving.",
    );
  }

  intro("Suggest templates");
  promptLog.info("Preparing GitHub PR evidence for template suggestions.");

  let lastCompletedPhase: TemplateSuggestionPhase | null = null;
  let logDir: string | undefined;

  try {
    const result = await (options.suggest ?? suggestTemplates)({
      onStatus(event) {
        if (event.status === "completed") {
          lastCompletedPhase = event.phase;
        }
        renderStatusEvent(event);
      },
    });
    logDir = result.logDir;

    renderTemplateSuggestionReport(result);

    const selectedIds = await promptMultiSelect("Templates to save", {
      options: result.suggestions.map((suggestion) => ({
        label: suggestion.id,
        value: suggestion.id,
        description: `${confidenceLabel(suggestion.confidence)} - ${suggestion.description}`,
      })),
      initialValues: result.suggestions.map((suggestion) => suggestion.id),
      required: true,
      throwOnCancel: true,
    });
    const selected = result.suggestions.filter((suggestion) =>
      selectedIds.includes(suggestion.id),
    );

    const confirmed = await promptConfirm(
      `Save ${selected.length} suggested template${selected.length === 1 ? "" : "s"}?`,
      false,
      { throwOnCancel: true },
    );
    if (!confirmed) {
      promptLog.info("No templates saved.");
      outro(`Raw AI logs: ${logDir}`);
      return success();
    }

    promptLog.info("Saving selected templates.");
    const saved = await (options.save ?? saveTemplateSuggestions)(selected);
    for (const suggestion of saved.saved) {
      promptLog.success(`Template "${suggestion.id}" saved.`);
    }
    for (const skipped of saved.skipped) {
      promptLog.warn(skipped.reason);
    }

    outro(`Raw AI logs: ${logDir}`);
    return success();
  } catch (error) {
    if (error instanceof CancelError) {
      if (logDir) {
        outro(`Cancelled. Raw AI logs: ${logDir}`);
      } else {
        outro("Cancelled.");
      }
      return success();
    }

    if (error instanceof TemplateSuggestionError) {
      logDir = error.logDir ?? logDir;
    }

    throw new OperationalError(
      renderTemplateSuggestFailure(error, {
        lastCompletedPhase,
        ...(logDir ? { logDir } : {}),
      }),
      { cause: error },
    );
  }
}

function renderStatusEvent(event: TemplateSuggestionStatusEvent): void {
  switch (event.status) {
    case "started":
      promptLog.info(event.message);
      break;
    case "heartbeat":
      promptLog.info(event.message);
      break;
    case "completed":
      promptLog.success(event.message);
      break;
    case "warning":
      promptLog.warn(event.message);
      break;
  }
}

function renderTemplateSuggestionReport(
  result: TemplateSuggestionResult,
): void {
  printReport({
    title: "Suggested templates",
    sections: [
      {
        entries: result.suggestions.map((suggestion) => ({
          title: suggestion.id,
          description: suggestion.description,
          details: [
            { label: "Repositories", value: suggestion.repos.join(", ") },
            {
              label: "Confidence",
              value: confidenceLabel(suggestion.confidence),
            },
            {
              label: "Evidence",
              value: suggestion.evidenceNotes.join("; "),
            },
          ],
        })),
      },
    ],
    footer: [
      `${result.evidence.pullRequests.length} pull request${result.evidence.pullRequests.length === 1 ? "" : "s"} analyzed`,
      `Raw AI logs: ${result.logDir}`,
    ].join("\n"),
  });
}

function renderTemplateSuggestFailure(
  error: unknown,
  context: Readonly<{
    lastCompletedPhase: TemplateSuggestionPhase | null;
    logDir?: string;
  }>,
): string {
  const message = getErrorMessage(error);
  const lines = [
    message,
    `Last completed phase: ${context.lastCompletedPhase ?? "none"}`,
    failureHint(error, message, context.logDir),
  ];
  if (context.logDir) {
    lines.push(`Raw AI logs: ${context.logDir}`);
  }
  return lines.join("\n");
}

function failureHint(
  error: unknown,
  message: string,
  logDir: string | undefined,
): string {
  if (error instanceof AiUnavailableError || message.includes("AI provider")) {
    return "Fix: run `wf ai status` and follow the provider setup hint.";
  }
  if (message.includes("GitHub CLI")) {
    return "Fix: install GitHub CLI if needed, then run `gh auth login`.";
  }
  if (logDir) {
    return "Fix: inspect output.txt in the raw log directory, then rerun the command.";
  }
  return "Fix: address the setup error above, then rerun `wf template suggest`.";
}

function confidenceLabel(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
