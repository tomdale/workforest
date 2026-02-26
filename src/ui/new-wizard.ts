import os from "node:os";
import path from "node:path";
import { Box, NodeRuntime, Screen, setRuntime } from "@unblessed/node";
import type { Template } from "../templates/index.ts";
import type { WorkspaceConfig } from "../types.ts";
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
      ? `${t.config.description} | ${repos}`
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
      height: "100%-2",
      border: { type: "line" },
      label: " wf new ",
      style: { border: { fg: "cyan" } },
      tags: true,
      padding: { left: 1, top: 1 },
    });

    const previewBox = new Box({
      parent: screen,
      top: 0,
      right: 0,
      width: "40%",
      height: "100%-2",
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

    function renderContent() {
      const lines: string[] = [];

      if (state.phase === "selectTemplate") {
        lines.push(
          "{bold}Choose a template or enter repos directly.{/bold}",
          "",
        );

        for (let i = 0; i < selectItems.length; i++) {
          const item = selectItems[i];
          if (i === state.selectedIndex) {
            lines.push(
              `  {cyan-fg}\u25cf{/cyan-fg} {bold}${item.label}{/bold}`,
            );
            if (item.description) {
              lines.push(`    {gray-fg}${item.description}{/gray-fg}`);
            }
          } else {
            lines.push(`  {gray-fg}\u25cb ${item.label}{/gray-fg}`);
            if (item.description) {
              lines.push(`    {gray-fg}${item.description}{/gray-fg}`);
            }
          }
        }
      } else if (state.phase === "reposInput") {
        lines.push(
          "{bold}Repositories{/bold} {gray-fg}(comma-separated){/gray-fg}",
          "",
        );

        const before = state.inputValue.slice(0, state.inputCursor);
        const cursor = state.inputValue[state.inputCursor] ?? " ";
        const after = state.inputValue.slice(state.inputCursor + 1);
        lines.push(`  > ${before}{inverse}${cursor}{/inverse}${after}`);

        if (state.errorMessage) {
          lines.push("", `  {red-fg}${state.errorMessage}{/red-fg}`);
        }
      } else if (state.phase === "featureName") {
        if (state.templateId) {
          lines.push(`  {green-fg}\u2713{/green-fg} ${state.templateId}`, "");
        } else {
          lines.push(
            `  {green-fg}\u2713{/green-fg} ${state.repoSlugs.map(getRepoDisplayName).join(", ")}`,
            "",
          );
        }

        lines.push(
          "{bold}What are you working on?{/bold}",
          "{gray-fg}slug or describe your task{/gray-fg}",
          "",
        );

        const before = state.inputValue.slice(0, state.inputCursor);
        const cursor = state.inputValue[state.inputCursor] ?? " ";
        const after = state.inputValue.slice(state.inputCursor + 1);
        lines.push(`  > ${before}{inverse}${cursor}{/inverse}${after}`);

        if (state.errorMessage) {
          lines.push("", `  {red-fg}${state.errorMessage}{/red-fg}`);
        }
      } else if (state.phase === "generating") {
        if (state.templateId) {
          lines.push(`  {green-fg}\u2713{/green-fg} ${state.templateId}`, "");
        } else {
          lines.push(
            `  {green-fg}\u2713{/green-fg} ${state.repoSlugs.map(getRepoDisplayName).join(", ")}`,
            "",
          );
        }

        const frame = BRAILLE_FRAMES[spinnerFrame % BRAILLE_FRAMES.length];
        lines.push(`  {cyan-fg}${frame}{/cyan-fg} Generating feature name...`);
      }

      contentBox.setContent(lines.join("\n"));
    }

    function renderPreview() {
      const lines: string[] = [];

      if (state.phase === "selectTemplate") {
        const item = selectItems[state.selectedIndex];
        if (item.templateId) {
          const template = templates.find((t) => t.id === item.templateId);
          if (template) {
            lines.push(`{bold}${template.id}{/bold}`, "");
            for (const repo of template.config.repos) {
              lines.push(`  ${getRepoDisplayName(repo)}`);
            }
            lines.push("");
            if (template.config.hooks?.length) {
              lines.push(
                `{gray-fg}${template.config.hooks.length} hook${template.config.hooks.length !== 1 ? "s" : ""}{/gray-fg}`,
              );
            }
            if (template.config.branchPrefix) {
              lines.push(
                `{gray-fg}prefix: ${template.config.branchPrefix}{/gray-fg}`,
              );
            }
          }
        } else {
          lines.push("{gray-fg}(select a template to preview){/gray-fg}");
        }
      } else if (state.phase === "reposInput") {
        const parsed = parseRepoInput(state.inputValue);
        if (parsed.length > 0) {
          for (const repo of parsed) {
            lines.push(`  ${getRepoDisplayName(repo)}`);
          }
        } else {
          lines.push("{gray-fg}(type repos to preview){/gray-fg}");
        }
      } else if (
        state.phase === "featureName" ||
        state.phase === "generating"
      ) {
        if (state.templateId) {
          lines.push(`{bold}${state.templateId}{/bold}`, "");
        }
        for (const repo of state.repoSlugs) {
          lines.push(`  ${getRepoDisplayName(repo)}`);
        }
        lines.push("");

        if (state.phase === "generating") {
          lines.push("{gray-fg}(generating...){/gray-fg}");
        } else {
          const trimmed = state.inputValue.trim();
          if (trimmed && isSlug(trimmed)) {
            const prefix = config.dirPrefix ?? "";
            const homeDir = os.homedir();
            const baseDir = config.defaultDir
              ? expandHome(config.defaultDir)
              : "...";
            const dirDisplay = `${shortenPath(baseDir, homeDir)}/${prefix}${trimmed}`;

            const branchPrefix =
              state.templateBranchPrefix ?? config.branchPrefix ?? "";
            const branchDisplay = branchPrefix
              ? `${branchPrefix}${trimmed}`
              : trimmed;

            lines.push(`{gray-fg}dir{/gray-fg}  ${dirDisplay}`);
            lines.push(`{gray-fg}git{/gray-fg}  ${branchDisplay}`);
          } else if (trimmed) {
            lines.push("{gray-fg}(enter to generate){/gray-fg}");
          }
        }
      }

      previewBox.setContent(lines.join("\n"));
    }

    function renderFooter() {
      let hint = "";
      if (state.phase === "selectTemplate") {
        const parts = ["\u2191\u2193 navigate", "enter select"];
        if (templates.length > 0) {
          parts.push("t templates");
        }
        parts.push("esc quit");
        hint = parts.join("  ");
      } else if (state.phase === "reposInput") {
        hint = "enter confirm  esc back";
      } else if (state.phase === "featureName") {
        hint = "enter confirm  esc back";
      } else if (state.phase === "generating") {
        hint = "ctrl-c cancel";
      }

      footerBox.setContent(`{gray-fg}${hint}{/gray-fg}`);
    }

    function render() {
      renderContent();
      renderPreview();
      renderFooter();
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
          state.inputValue = "";
          state.inputCursor = 0;
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
          state.phase = "selectTemplate";
          state.errorMessage = "";
        } else if (state.phase === "featureName") {
          state.phase = state.prevPhase;
          state.inputValue = "";
          state.inputCursor = 0;
          state.errorMessage = "";
          if (state.prevPhase === "selectTemplate") {
            state.templateId = undefined;
            state.templateBranchPrefix = undefined;
            state.repoSlugs = [];
          }
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
