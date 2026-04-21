import os from "node:os";
import path from "node:path";
import { Box, NodeRuntime, Screen, setRuntime } from "@unblessed/node";
import type { Template } from "../templates/index.ts";
import type { WorkspaceConfig } from "../types.ts";
import {
  buildBranchName,
  resolveBranchPrefix,
} from "../utils/branch-prefix.ts";
import { generateSlugFromDescription, isSlug } from "../utils/slug.ts";

setRuntime(new NodeRuntime());

export type WizardResult = {
  templateId: string | undefined;
  repoSlugs: string[];
  templateBranchPrefix: string | undefined;
  featureName: string;
  description: string | undefined;
};

type ManageAction = "create" | "edit" | "clone" | "back";

type HandleTemplateManagement = (
  templates: Template[],
) => Promise<{ action: ManageAction; newTemplateId?: string } | null>;

export type WizardOptions = {
  config: WorkspaceConfig;
  templates: Template[];
  handleTemplateManagement: HandleTemplateManagement;
};

type WizardPhase =
  | "selectTemplate"
  | "reposInput"
  | "featureName"
  | "generating";

type WizardState = {
  phase: WizardPhase;
  selectedIndex: number;
  templateId: string | undefined;
  templateBranchPrefix: string | undefined;
  repoSlugs: string[];
  reposInputText: string;
  inputValue: string;
  inputCursor: number;
  errorMessage: string;
  featureName: string | undefined;
  description: string | undefined;
  prevPhase: "selectTemplate" | "reposInput";
};

type ScreenResult =
  | { type: "done"; result: WizardResult }
  | { type: "templateManagement" }
  | { type: "cancel" };

const BRAILLE_FRAMES = [
  "\u2807",
  "\u280b",
  "\u2819",
  "\u2838",
  "\u2834",
  "\u2826",
];

// Step labels for the box title
const STEP_LABELS: Record<WizardPhase, string> = {
  selectTemplate: "Select Template",
  reposInput: "Repositories",
  featureName: "Feature Name",
  generating: "Feature Name",
};

export async function runNewWizard(
  options: WizardOptions,
): Promise<WizardResult> {
  let { templates } = options;

  while (true) {
    const result = await runWizardScreen(options.config, templates);

    if (result.type === "cancel") {
      const { CancelError } = await import("../ui/prompts/index.ts");
      throw new CancelError();
    }

    if (result.type === "done") {
      return result.result;
    }

    // Template management: destroy screen, run management flow, reload
    const mgmtResult = await options.handleTemplateManagement(templates);
    if (mgmtResult?.newTemplateId) {
      const { listTemplates } = await import("../templates/index.ts");
      templates = await listTemplates();
    }
  }
}

function buildSelectItems(
  templates: Template[],
): { label: string; description: string; templateId?: string }[] {
  const items: { label: string; description: string; templateId?: string }[] =
    [];

  if (templates.length === 0) {
    items.push({
      label: "Create a template",
      description: "Define a reusable workspace configuration",
    });
  }

  for (const t of templates) {
    const repos = t.config.repos.map(getRepoDisplayName).join(", ");
    const desc = t.config.description
      ? `${t.config.description} \u00b7 ${repos}`
      : repos;
    items.push({ label: t.id, description: desc, templateId: t.id });
  }

  items.push({
    label: "Enter repositories manually",
    description: "Provide org/repo slugs or git URLs",
  });

  return items;
}

function getRepoDisplayName(repo: string): string {
  const trimmed = repo.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) return trimmed;

  const sshMatch = trimmed.match(/^[\w-]+@[\w.-]+:(.+)$/);
  if (sshMatch?.[1]) {
    const p = sshMatch[1].replace(/\.git$/i, "");
    const parts = p.split("/");
    if (parts.length >= 2)
      return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    return parts[parts.length - 1] ?? trimmed;
  }

  const urlMatch = trimmed.match(/^(?:https?|ssh|git):\/\/[^/]+\/(.+)$/);
  if (urlMatch?.[1]) {
    const p = urlMatch[1].replace(/\.git$/i, "");
    const parts = p.split("/");
    if (parts.length >= 2)
      return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    return parts[parts.length - 1] ?? trimmed;
  }

  return trimmed;
}

function stepNumber(phase: WizardPhase): number {
  if (phase === "selectTemplate" || phase === "reposInput") return 1;
  return 2;
}

function formatBranchPrefixSummary(
  templateBranchPrefix: string | undefined,
  workspaceBranchPrefix: string | undefined,
): string {
  if (templateBranchPrefix === undefined) {
    return workspaceBranchPrefix
      ? `inherits global: ${workspaceBranchPrefix}`
      : "inherits global: none";
  }

  if (templateBranchPrefix === "") {
    return "prefix: none";
  }

  return `prefix: ${templateBranchPrefix}`;
}

function formatFooterHint(pairs: [key: string, desc: string][]): string {
  return pairs
    .map(([key, desc]) => `{white-fg}${key}{/white-fg} ${desc}`)
    .join("  {gray-fg}\u2502{/gray-fg}  ");
}

function runWizardScreen(
  config: WorkspaceConfig,
  templates: Template[],
): Promise<ScreenResult> {
  return new Promise((resolve) => {
    const screen = new Screen({
      smartCSR: true,
      fullUnicode: true,
      title: "wf new",
    });

    const contentBox = new Box({
      parent: screen,
      top: 0,
      left: 0,
      width: "60%",
      height: "100%-1",
      border: { type: "line" },
      label: " wf new \u2500 Select Template ",
      style: { border: { fg: "cyan" } },
      tags: true,
      padding: { left: 1, top: 1 },
    });

    const previewBox = new Box({
      parent: screen,
      top: 0,
      right: 0,
      width: "40%",
      height: "100%-1",
      border: { type: "line" },
      label: " Preview ",
      style: { border: { fg: "gray" } },
      tags: true,
      padding: { left: 1, top: 1 },
    });

    const footerBox = new Box({
      parent: screen,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 1,
      tags: true,
      padding: { left: 1 },
      style: { fg: "gray" },
    });

    const selectItems = buildSelectItems(templates);

    const state: WizardState = {
      phase: "selectTemplate",
      selectedIndex: 0,
      templateId: undefined,
      templateBranchPrefix: undefined,
      repoSlugs: [],
      reposInputText: "",
      inputValue: "",
      inputCursor: 0,
      errorMessage: "",
      featureName: undefined,
      description: undefined,
      prevPhase: "selectTemplate",
    };

    let spinnerInterval: ReturnType<typeof setInterval> | undefined;
    let spinnerFrame = 0;
    let skipNextEnter = false;

    function cleanup() {
      if (spinnerInterval) {
        clearInterval(spinnerInterval);
        spinnerInterval = undefined;
      }
      screen.destroy();
    }

    function finish(result: ScreenResult) {
      cleanup();
      resolve(result);
    }

    // Available width inside the content box (accounting for border + padding)
    function contentWidth(): number {
      const w = contentBox.width as number;
      // border (1+1) + padding left (1+1 spaces from padding:{left:1}) = ~4
      return Math.max(20, w - 4);
    }

    function renderTextInput(value: string, cursor: number): string {
      const before = value.slice(0, cursor);
      const cursorChar = value[cursor] ?? " ";
      const after = value.slice(cursor + 1);
      return `  {cyan-fg}\u276f{/cyan-fg} ${before}{inverse}${cursorChar}{/inverse}${after}`;
    }

    function renderContent() {
      const lines: string[] = [];
      const step = stepNumber(state.phase);
      const stepHint = `{gray-fg}step ${step}/2{/gray-fg}`;

      if (state.phase === "selectTemplate") {
        lines.push(
          `{bold}Choose a template or enter repos directly{/bold}  ${stepHint}`,
          "",
        );

        const maxDescWidth = contentWidth() - 8; // account for indent + radio + spacing

        for (let i = 0; i < selectItems.length; i++) {
          const item = selectItems[i];
          const desc = item.description
            ? truncate(item.description, maxDescWidth)
            : "";

          if (i === state.selectedIndex) {
            lines.push(
              `  {cyan-fg}\u25cf{/cyan-fg} {bold}${item.label}{/bold}`,
            );
            if (desc) {
              lines.push(`    ${desc}`);
            }
          } else {
            lines.push(`  {gray-fg}\u25cb{/gray-fg} ${item.label}`);
            if (desc) {
              lines.push(`    {gray-fg}${desc}{/gray-fg}`);
            }
          }
        }
      } else if (state.phase === "reposInput") {
        lines.push(
          `{bold}Enter repositories{/bold}  ${stepHint}`,
          "{gray-fg}org/repo or git URL, comma-separated{/gray-fg}",
          "",
        );

        lines.push(renderTextInput(state.inputValue, state.inputCursor));

        if (state.errorMessage) {
          lines.push("", `  {red-fg}${state.errorMessage}{/red-fg}`);
        }
      } else if (state.phase === "featureName") {
        // Completed step summary
        if (state.templateId) {
          lines.push(
            `  {green-fg}\u2713{/green-fg} {green-fg}${state.templateId}{/green-fg}`,
          );
        } else {
          lines.push(
            `  {green-fg}\u2713{/green-fg} {green-fg}${state.repoSlugs.map(getRepoDisplayName).join(", ")}{/green-fg}`,
          );
        }

        lines.push("");

        lines.push(
          `{bold}What are you working on?{/bold}  ${stepHint}`,
          "{gray-fg}slug or describe your task{/gray-fg}",
          "",
        );

        lines.push(renderTextInput(state.inputValue, state.inputCursor));

        if (state.errorMessage) {
          lines.push("", `  {red-fg}${state.errorMessage}{/red-fg}`);
        }
      } else if (state.phase === "generating") {
        if (state.templateId) {
          lines.push(
            `  {green-fg}\u2713{/green-fg} {green-fg}${state.templateId}{/green-fg}`,
          );
        } else {
          lines.push(
            `  {green-fg}\u2713{/green-fg} {green-fg}${state.repoSlugs.map(getRepoDisplayName).join(", ")}{/green-fg}`,
          );
        }
        lines.push("");

        const frame = BRAILLE_FRAMES[spinnerFrame % BRAILLE_FRAMES.length];
        lines.push(`  {cyan-fg}${frame}{/cyan-fg} Generating feature name...`);
      }

      contentBox.setContent(padToBox(lines, contentBox));
    }

    function renderPreview() {
      const lines: string[] = [];

      if (state.phase === "selectTemplate") {
        const item = selectItems[state.selectedIndex];
        if (item.templateId) {
          const template = templates.find((t) => t.id === item.templateId);
          if (template) {
            lines.push(`{bold}${template.id}{/bold}`);
            if (template.config.description) {
              lines.push(`{gray-fg}${template.config.description}{/gray-fg}`);
            }
            lines.push("");

            lines.push("{gray-fg}Repos{/gray-fg}");
            for (const repo of template.config.repos) {
              lines.push(`  \u25e6 ${getRepoDisplayName(repo)}`);
            }

            const meta: string[] = [];
            if (template.config.hooks?.length) {
              meta.push(
                `${template.config.hooks.length} hook${template.config.hooks.length !== 1 ? "s" : ""}`,
              );
            }
            meta.push(
              formatBranchPrefixSummary(
                template.config.branchPrefix,
                config.branchPrefix,
              ),
            );
            if (meta.length > 0) {
              lines.push("");
              for (const m of meta) {
                lines.push(`{gray-fg}${m}{/gray-fg}`);
              }
            }
          }
        } else {
          lines.push(
            "{gray-fg}Select a template to see{/gray-fg}",
            "{gray-fg}its configuration here.{/gray-fg}",
          );
        }
      } else if (state.phase === "reposInput") {
        const parsed = parseRepoInput(state.inputValue);
        if (parsed.length > 0) {
          lines.push("{gray-fg}Repos{/gray-fg}");
          for (const repo of parsed) {
            lines.push(`  \u25e6 ${getRepoDisplayName(repo)}`);
          }
        } else {
          lines.push(
            "{gray-fg}Repos will appear here{/gray-fg}",
            "{gray-fg}as you type.{/gray-fg}",
          );
        }
      } else if (
        state.phase === "featureName" ||
        state.phase === "generating"
      ) {
        if (state.templateId) {
          lines.push(`{bold}${state.templateId}{/bold}`, "");
        }

        lines.push("{gray-fg}Repos{/gray-fg}");
        for (const repo of state.repoSlugs) {
          lines.push(`  \u25e6 ${getRepoDisplayName(repo)}`);
        }
        lines.push("");

        if (state.phase === "generating") {
          lines.push("{gray-fg}dir{/gray-fg}  {cyan-fg}\u2026{/cyan-fg}");
          lines.push("{gray-fg}git{/gray-fg}  {cyan-fg}\u2026{/cyan-fg}");
        } else {
          const trimmed = state.inputValue.trim();
          if (trimmed && isSlug(trimmed)) {
            const prefix = config.dirPrefix ?? "";
            const homeDir = os.homedir();
            const baseDir = config.defaultDir
              ? expandHome(config.defaultDir)
              : "...";
            const dirDisplay = `${shortenPath(baseDir, homeDir)}/${prefix}${trimmed}`;

            const branchDisplay = buildBranchName(
              trimmed,
              resolveBranchPrefix(
                config.branchPrefix,
                state.templateBranchPrefix,
              ),
            );

            lines.push(
              `{gray-fg}dir{/gray-fg}  {white-fg}${dirDisplay}{/white-fg}`,
            );
            lines.push(
              `{gray-fg}git{/gray-fg}  {white-fg}${branchDisplay}{/white-fg}`,
            );
          } else if (trimmed) {
            lines.push(
              "{gray-fg}dir{/gray-fg}  {gray-fg}(enter to generate){/gray-fg}",
            );
            lines.push(
              "{gray-fg}git{/gray-fg}  {gray-fg}(enter to generate){/gray-fg}",
            );
          }
        }
      }

      previewBox.setContent(padToBox(lines, previewBox));
    }

    function renderFooter() {
      let hint = "";
      if (state.phase === "selectTemplate") {
        const pairs: [string, string][] = [
          ["\u2191\u2193", "navigate"],
          ["\u23ce", "select"],
        ];
        if (templates.length > 0) {
          pairs.push(["t", "templates"]);
        }
        pairs.push(["esc", "quit"]);
        hint = formatFooterHint(pairs);
      } else if (state.phase === "reposInput") {
        hint = formatFooterHint([
          ["\u23ce", "confirm"],
          ["esc", "back"],
        ]);
      } else if (state.phase === "featureName") {
        hint = formatFooterHint([
          ["\u23ce", "confirm"],
          ["esc", "back"],
        ]);
      } else if (state.phase === "generating") {
        hint = formatFooterHint([["\u2303c", "cancel"]]);
      }

      footerBox.setContent(hint);
    }

    function updateBoxLabel() {
      const label = STEP_LABELS[state.phase];
      contentBox.setLabel(` wf new \u2500 ${label} `);
    }

    // Strip blessed tags to estimate visible character count
    function visibleLength(line: string): number {
      return line.replace(/\{[^}]+\}/g, "").length;
    }

    // Pad lines to fill box dimensions, clearing leftover content
    function padToBox(lines: string[], box: typeof contentBox): string {
      const availH = (box.height as number) - 2; // minus top+bottom border
      const availW = (box.width as number) - 3; // border left + padding left + border right
      const padded = lines.map((line) => {
        const gap = Math.max(0, availW - visibleLength(line));
        return gap > 0 ? `${line}${" ".repeat(gap)}` : line;
      });
      const blankLine = " ".repeat(Math.max(0, availW));
      while (padded.length < availH) {
        padded.push(blankLine);
      }
      return padded.join("\n");
    }

    function render() {
      updateBoxLabel();
      renderContent();
      renderPreview();
      renderFooter();
      screen.alloc();
      screen.render();
    }

    function handleSelectKey(
      _ch: string,
      key: { name: string; ctrl: boolean },
    ) {
      if (key.name === "up" || _ch === "k") {
        state.selectedIndex = Math.max(0, state.selectedIndex - 1);
      } else if (key.name === "down" || _ch === "j") {
        state.selectedIndex = Math.min(
          selectItems.length - 1,
          state.selectedIndex + 1,
        );
      } else if (key.name === "return" || key.name === "enter") {
        const item = selectItems[state.selectedIndex];

        // "Create a template" item (no-templates case)
        if (templates.length === 0 && state.selectedIndex === 0) {
          finish({ type: "templateManagement" });
          return;
        }

        if (item.templateId) {
          const template = templates.find((t) => t.id === item.templateId);
          if (template) {
            state.templateId = template.id;
            state.templateBranchPrefix = template.config.branchPrefix;
            state.repoSlugs = template.config.repos;
            state.phase = "featureName";
            state.prevPhase = "selectTemplate";
            state.inputValue = "";
            state.inputCursor = 0;
            state.errorMessage = "";
            skipNextEnter = true;
          }
        } else {
          // "Enter repositories manually"
          state.phase = "reposInput";
          state.inputValue = state.reposInputText;
          state.inputCursor = state.reposInputText.length;
          state.errorMessage = "";
          skipNextEnter = true;
        }
      } else if (_ch === "t" && templates.length > 0) {
        finish({ type: "templateManagement" });
        return;
      } else if (key.name === "escape" || (key.ctrl && _ch === "c")) {
        finish({ type: "cancel" });
        return;
      }

      render();
    }

    function handleTextKey(
      ch: string,
      key: { name: string; ctrl: boolean; shift: boolean },
    ) {
      if (key.ctrl && ch === "c") {
        finish({ type: "cancel" });
        return;
      }

      if (key.name === "escape") {
        if (state.phase === "reposInput") {
          state.reposInputText = state.inputValue;
          state.phase = "selectTemplate";
          state.errorMessage = "";
        } else if (state.phase === "featureName") {
          if (state.prevPhase === "reposInput") {
            state.phase = "reposInput";
            state.inputValue = state.reposInputText;
            state.inputCursor = state.reposInputText.length;
          } else {
            state.phase = "selectTemplate";
            state.templateId = undefined;
            state.templateBranchPrefix = undefined;
            state.repoSlugs = [];
          }
          state.errorMessage = "";
        }
        render();
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        if (skipNextEnter) {
          skipNextEnter = false;
          render();
          return;
        }

        const trimmed = state.inputValue.trim();

        if (state.phase === "reposInput") {
          const parsed = parseRepoInput(trimmed);
          if (parsed.length === 0) {
            state.errorMessage = "At least one repository is required";
            render();
            return;
          }
          state.reposInputText = state.inputValue;
          state.repoSlugs = parsed;
          state.templateId = undefined;
          state.templateBranchPrefix = undefined;
          state.phase = "featureName";
          state.prevPhase = "reposInput";
          state.inputValue = "";
          state.inputCursor = 0;
          state.errorMessage = "";
          skipNextEnter = true;
        } else if (state.phase === "featureName") {
          if (!trimmed) {
            state.errorMessage = "Please describe what you're working on";
            render();
            return;
          }

          if (isSlug(trimmed)) {
            finish({
              type: "done",
              result: {
                templateId: state.templateId,
                repoSlugs: state.repoSlugs,
                templateBranchPrefix: state.templateBranchPrefix,
                featureName: trimmed,
                description: undefined,
              },
            });
            return;
          }

          // Prose input — generate slug
          state.description = trimmed;
          state.phase = "generating";
          state.errorMessage = "";

          spinnerFrame = 0;
          spinnerInterval = setInterval(() => {
            spinnerFrame++;
            renderContent();
            screen.render();
          }, 80);

          generateSlugFromDescription(trimmed).then((generated) => {
            const featureName = generated ?? sanitizeToSlug(trimmed);
            finish({
              type: "done",
              result: {
                templateId: state.templateId,
                repoSlugs: state.repoSlugs,
                templateBranchPrefix: state.templateBranchPrefix,
                featureName,
                description: trimmed,
              },
            });
          });
          render();
          return;
        }

        render();
        return;
      }

      // Text editing
      if (key.name === "backspace") {
        if (state.inputCursor > 0) {
          state.inputValue =
            state.inputValue.slice(0, state.inputCursor - 1) +
            state.inputValue.slice(state.inputCursor);
          state.inputCursor--;
        }
      } else if (key.name === "delete") {
        if (state.inputCursor < state.inputValue.length) {
          state.inputValue =
            state.inputValue.slice(0, state.inputCursor) +
            state.inputValue.slice(state.inputCursor + 1);
        }
      } else if (key.name === "left") {
        state.inputCursor = Math.max(0, state.inputCursor - 1);
      } else if (key.name === "right") {
        state.inputCursor = Math.min(
          state.inputValue.length,
          state.inputCursor + 1,
        );
      } else if (key.name === "home" || (key.ctrl && ch === "a")) {
        state.inputCursor = 0;
      } else if (key.name === "end" || (key.ctrl && ch === "e")) {
        state.inputCursor = state.inputValue.length;
      } else if (ch && !key.ctrl && ch.length === 1 && ch >= " ") {
        state.inputValue =
          state.inputValue.slice(0, state.inputCursor) +
          ch +
          state.inputValue.slice(state.inputCursor);
        state.inputCursor++;
        state.errorMessage = "";
      }

      render();
    }

    screen.on(
      "keypress",
      (ch: string, key: { name: string; ctrl: boolean; shift: boolean }) => {
        if (!key) return;

        if (state.phase === "selectTemplate") {
          handleSelectKey(ch, key);
        } else if (
          state.phase === "reposInput" ||
          state.phase === "featureName"
        ) {
          handleTextKey(ch, key);
        } else if (state.phase === "generating") {
          if (key.ctrl && ch === "c") {
            finish({ type: "cancel" });
          }
        }
      },
    );

    render();
  });
}

function parseRepoInput(input: string): string[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function sanitizeToSlug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function shortenPath(p: string, homeDir: string): string {
  if (p.startsWith(homeDir)) return `~${p.slice(homeDir.length)}`;
  return p;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  if (maxLen <= 1) return "\u2026";
  return `${str.slice(0, maxLen - 1)}\u2026`;
}
