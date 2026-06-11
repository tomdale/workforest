import fs from "node:fs/promises";
import path from "node:path";
import { Box, NodeRuntime, Screen, setRuntime } from "@unblessed/node";
import stringWidth from "string-width";
import type { Template } from "../templates/index.ts";
import { escapeBlessedTags } from "../terminal/command-stream-adapter.ts";
import { fullscreenColor } from "../terminal/theme.ts";
import type { Hook, WorkspaceConfig } from "../types.ts";
import { pathExists } from "../utils/fs.ts";

setRuntime(new NodeRuntime());

export type TemplateManagerAction =
  | { type: "quit" }
  | { type: "create" }
  | { type: "edit"; templateId: string }
  | { type: "copy"; templateId: string }
  | { type: "delete"; templateId: string }
  | { type: "show"; templateId: string }
  | { type: "reload" };

export type TemplateManagerOptions = {
  templates: Template[];
  templatesDir: string;
  workspaceConfig?: WorkspaceConfig;
  initialTemplateId?: string;
};

type TemplateArtifactSummary = {
  filesDir: string;
  exists: boolean;
  fileCount: number;
  dirCount: number;
  previewLines: string[];
  truncated: boolean;
};

type TemplateManagerState = {
  selectedIndex: number;
  listOffset: number;
  query: string;
  searchActive: boolean;
  showHelp: boolean;
  status: string;
};

const MAX_FILE_PREVIEW_ENTRIES = 80;
const MIN_TEMPLATE_MANAGER_COLUMNS = 80;
const MIN_TEMPLATE_MANAGER_ROWS = 20;

export function shouldUseTemplateManager(): boolean {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  if (process.env["CI"] || process.env["WORKFOREST_NO_TUI"]) return false;
  const columns = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  return (
    columns >= MIN_TEMPLATE_MANAGER_COLUMNS && rows >= MIN_TEMPLATE_MANAGER_ROWS
  );
}

export async function runTemplateManager({
  templates,
  templatesDir,
  workspaceConfig,
  initialTemplateId,
}: TemplateManagerOptions): Promise<TemplateManagerAction> {
  const artifacts = await collectTemplateArtifactSummaries(templates);
  const initialIndex = Math.max(
    0,
    templates.findIndex((template) => template.id === initialTemplateId),
  );

  return new Promise((resolve) => {
    const screen = new Screen({
      smartCSR: true,
      fullUnicode: true,
      title: "wf template manage",
    });

    const listBox = new Box({
      parent: screen,
      top: 0,
      left: 0,
      width: "30%",
      height: "100%-1",
      border: { type: "line" },
      label: " Templates ",
      tags: true,
      padding: { left: 1, top: 1 },
      style: {
        border: { fg: fullscreenColor.accent },
      },
    });

    const detailBox = new Box({
      parent: screen,
      top: 0,
      left: "30%",
      width: "40%",
      height: "43%-1",
      border: { type: "line" },
      label: " Details ",
      tags: true,
      padding: { left: 1, top: 1 },
      style: {
        border: { fg: fullscreenColor.muted },
      },
    });

    const reposBox = new Box({
      parent: screen,
      top: "43%-1",
      left: "30%",
      width: "40%",
      height: "57%",
      border: { type: "line" },
      label: " Repositories and Hooks ",
      tags: true,
      padding: { left: 1, top: 1 },
      style: {
        border: { fg: fullscreenColor.muted },
      },
    });

    const filesBox = new Box({
      parent: screen,
      top: 0,
      right: 0,
      width: "30%",
      height: "100%-1",
      border: { type: "line" },
      label: " Files and Actions ",
      tags: true,
      padding: { left: 1, top: 1 },
      style: {
        border: { fg: fullscreenColor.muted },
      },
    });

    const footerBox = new Box({
      parent: screen,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 1,
      tags: true,
      padding: { left: 1 },
      style: { fg: fullscreenColor.muted },
    });

    const state: TemplateManagerState = {
      selectedIndex: initialIndex,
      listOffset: 0,
      query: "",
      searchActive: false,
      showHelp: false,
      status: "",
    };

    let finished = false;

    function cleanup(): void {
      screen.destroy();
    }

    function finish(action: TemplateManagerAction): void {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(action);
    }

    function filteredTemplates(): Template[] {
      const query = state.query.trim().toLowerCase();
      if (!query) return templates;

      return templates.filter((template) => {
        const haystack = [
          template.id,
          template.config.description,
          ...template.config.repos,
          ...(template.config.hooks ?? []).flatMap((hook) => [
            hook.name,
            hook.run,
          ]),
        ]
          .filter(Boolean)
          .join("\n")
          .toLowerCase();
        return haystack.includes(query);
      });
    }

    function selectedTemplate(): Template | undefined {
      const filtered = filteredTemplates();
      clampSelection(filtered);
      return filtered[state.selectedIndex];
    }

    function selectedArtifact(): TemplateArtifactSummary | undefined {
      const template = selectedTemplate();
      return template ? artifacts.get(template.id) : undefined;
    }

    function clampSelection(filtered = filteredTemplates()): void {
      if (filtered.length === 0) {
        state.selectedIndex = 0;
        state.listOffset = 0;
        return;
      }
      state.selectedIndex = Math.min(
        Math.max(0, state.selectedIndex),
        filtered.length - 1,
      );
    }

    function render(): void {
      const filtered = filteredTemplates();
      clampSelection(filtered);
      renderList(filtered);
      renderDetails(selectedTemplate(), selectedArtifact());
      renderRepos(selectedTemplate());
      renderFiles(selectedTemplate(), selectedArtifact());
      renderFooter();
      screen.render();
    }

    function renderList(filtered: Template[]): void {
      const lines: string[] = [];
      const querySuffix = state.query ? ` /${state.query}` : "";
      listBox.setLabel(
        ` Templates ${templates.length}${querySuffix ? ` ${querySuffix}` : ""} `,
      );

      if (templates.length === 0) {
        lines.push(
          "{bold}No templates configured{/bold}",
          "",
          "Press {white-fg}n{/white-fg} to create one.",
          "",
          "{gray-fg}Templates directory{/gray-fg}",
          escapeBlessedTags(templatesDir),
        );
        listBox.setContent(padToBox(lines, listBox));
        return;
      }

      if (state.searchActive || state.query) {
        const cursor = state.searchActive ? "{inverse} {/inverse}" : "";
        lines.push(
          `{gray-fg}Search{/gray-fg} /${escapeBlessedTags(state.query)}${cursor}`,
          "",
        );
      }

      if (filtered.length === 0) {
        lines.push(
          "{yellow-fg}No matching templates{/yellow-fg}",
          "",
          "{gray-fg}Backspace edits the search.{/gray-fg}",
        );
        listBox.setContent(padToBox(lines, listBox));
        return;
      }

      const listHeight = Math.max(1, contentHeight(listBox) - lines.length);
      if (state.selectedIndex < state.listOffset) {
        state.listOffset = state.selectedIndex;
      } else if (state.selectedIndex >= state.listOffset + listHeight) {
        state.listOffset = state.selectedIndex - listHeight + 1;
      }

      const visible = filtered.slice(
        state.listOffset,
        state.listOffset + listHeight,
      );

      for (const [visibleIndex, template] of visible.entries()) {
        const index = state.listOffset + visibleIndex;
        const artifact = artifacts.get(template.id);
        const selected = index === state.selectedIndex;
        const repoCount = template.config.repos.length;
        const hookCount = template.config.hooks?.length ?? 0;
        const fileCount = artifact?.exists ? artifact.fileCount : 0;
        const meta = [
          `${repoCount} repo${repoCount === 1 ? "" : "s"}`,
          hookCount > 0
            ? `${hookCount} hook${hookCount === 1 ? "" : "s"}`
            : null,
          fileCount > 0
            ? `${fileCount}${artifact?.truncated ? "+" : ""} file${fileCount === 1 ? "" : "s"}`
            : null,
        ]
          .filter(Boolean)
          .join("  ");
        const id = escapeBlessedTags(
          truncatePlain(template.id, Math.max(8, contentWidth(listBox) - 4)),
        );
        const desc = template.config.description
          ? truncatePlain(
              template.config.description,
              Math.max(8, contentWidth(listBox) - 6),
            )
          : "";

        if (selected) {
          lines.push(`{cyan-fg}>{/cyan-fg} {bold}${id}{/bold}`);
          if (desc) {
            lines.push(`  {white-fg}${escapeBlessedTags(desc)}{/white-fg}`);
          }
          if (meta) {
            lines.push(`  {gray-fg}${escapeBlessedTags(meta)}{/gray-fg}`);
          }
        } else {
          lines.push(`  ${id}`);
          if (desc) {
            lines.push(`  {gray-fg}${escapeBlessedTags(desc)}{/gray-fg}`);
          }
          if (meta) {
            lines.push(`  {gray-fg}${escapeBlessedTags(meta)}{/gray-fg}`);
          }
        }
      }

      listBox.setContent(padToBox(lines, listBox));
    }

    function renderDetails(
      template: Template | undefined,
      artifact: TemplateArtifactSummary | undefined,
    ): void {
      const lines: string[] = [];
      if (!template) {
        lines.push(
          "{bold}No template selected{/bold}",
          "",
          "{gray-fg}Create a template to start reusing workspace setup.{/gray-fg}",
        );
        detailBox.setContent(padToBox(lines, detailBox));
        return;
      }

      const hookCount = template.config.hooks?.length ?? 0;
      const disableInitializers = formatDisableInitializers(
        template.config.disableInitializers,
      );
      const artifactSummary = artifact?.exists
        ? `${artifact.fileCount}${artifact.truncated ? "+" : ""} files, ${artifact.dirCount}${artifact.truncated ? "+" : ""} dirs`
        : "none";

      lines.push(
        `{bold}${escapeBlessedTags(template.id)}{/bold}`,
        template.config.description
          ? escapeBlessedTags(template.config.description)
          : "{gray-fg}(no description){/gray-fg}",
        "",
        labeledValue("Repos", String(template.config.repos.length)),
        labeledValue("Hooks", String(hookCount)),
        labeledValue("Files", artifactSummary),
        labeledValue(
          "Branch",
          formatBranchPrefix(template.config.branchPrefix, workspaceConfig),
        ),
        labeledValue("Initializers", disableInitializers),
        "",
        "{gray-fg}Config{/gray-fg}",
        escapeBlessedTags(shortenPath(template.path)),
      );

      detailBox.setContent(padToBox(lines, detailBox));
    }

    function renderRepos(template: Template | undefined): void {
      const lines: string[] = [];
      if (!template) {
        reposBox.setContent(padToBox(lines, reposBox));
        return;
      }

      lines.push("{gray-fg}Repositories{/gray-fg}");
      for (const [index, repo] of template.config.repos.entries()) {
        lines.push(
          `${String(index + 1).padStart(2)}. ${escapeBlessedTags(truncatePlain(repo, contentWidth(reposBox) - 5))}`,
        );
      }

      const hooks = template.config.hooks ?? [];
      lines.push("", "{gray-fg}Hooks{/gray-fg}");
      if (hooks.length === 0) {
        lines.push("  {gray-fg}(none){/gray-fg}");
      } else {
        for (const [index, hook] of hooks.entries()) {
          lines.push(formatHook(index, hook, contentWidth(reposBox)));
        }
      }

      reposBox.setContent(padToBox(lines, reposBox));
    }

    function renderFiles(
      template: Template | undefined,
      artifact: TemplateArtifactSummary | undefined,
    ): void {
      const lines: string[] = [];

      if (state.showHelp) {
        lines.push(
          "{bold}Shortcuts{/bold}",
          "",
          shortcut("j/k or arrows", "navigate"),
          shortcut("enter or e", "edit selected"),
          shortcut("n", "new template"),
          shortcut("c", "copy selected"),
          shortcut("d", "delete selected"),
          shortcut("o", "jump to directory"),
          shortcut("/", "search"),
          shortcut("r", "reload"),
          shortcut("?", "toggle this help"),
          shortcut("q", "quit"),
        );
        filesBox.setContent(padToBox(lines, filesBox));
        return;
      }

      if (!template) {
        lines.push(
          "{bold}Actions{/bold}",
          "",
          shortcut("n", "new template"),
          shortcut("r", "reload"),
          shortcut("q", "quit"),
        );
        filesBox.setContent(padToBox(lines, filesBox));
        return;
      }

      lines.push("{gray-fg}Template files{/gray-fg}");

      if (!artifact?.exists) {
        lines.push("  {gray-fg}(none){/gray-fg}");
      } else if (artifact.previewLines.length === 0) {
        lines.push("  {gray-fg}(empty files directory){/gray-fg}");
      } else {
        const budget = Math.max(1, contentHeight(filesBox) - 12);
        for (const line of artifact.previewLines.slice(0, budget)) {
          lines.push(
            escapeBlessedTags(truncatePlain(line, contentWidth(filesBox))),
          );
        }
        if (artifact.truncated || artifact.previewLines.length > budget) {
          lines.push("  {gray-fg}...{/gray-fg}");
        }
      }

      lines.push(
        "",
        "{gray-fg}Location{/gray-fg}",
        escapeBlessedTags(shortenPath(path.dirname(template.path))),
        "",
        "{gray-fg}Actions{/gray-fg}",
        shortcut("enter/e", "edit"),
        shortcut("n", "new"),
        shortcut("c", "copy"),
        shortcut("d", "delete"),
        shortcut("o", "jump"),
      );

      filesBox.setContent(padToBox(lines, filesBox));
    }

    function renderFooter(): void {
      const mode = state.searchActive ? "search" : "browse";
      const status = state.status
        ? `  {gray-fg}|{/gray-fg}  ${escapeBlessedTags(state.status)}`
        : "";
      footerBox.setContent(
        `{white-fg}${mode}{/white-fg}  j/k navigate  enter edit  n new  c copy  d delete  / search  ? help  q quit${status}`,
      );
    }

    function moveSelection(delta: number): void {
      const filtered = filteredTemplates();
      if (filtered.length === 0) return;
      state.selectedIndex = Math.min(
        filtered.length - 1,
        Math.max(0, state.selectedIndex + delta),
      );
    }

    function runSelectedAction(
      type: "edit" | "copy" | "delete" | "show",
    ): void {
      const template = selectedTemplate();
      if (!template) {
        state.status = "No template selected";
        render();
        return;
      }
      finish({ type, templateId: template.id });
    }

    screen.on(
      "keypress",
      (ch: string, key: { name?: string; ctrl?: boolean }) => {
        if (!key) return;

        if (key.ctrl && ch === "c") {
          finish({ type: "quit" });
          return;
        }

        if (state.searchActive) {
          if (key.name === "escape") {
            state.searchActive = false;
          } else if (key.name === "return" || key.name === "enter") {
            runSelectedAction("edit");
            return;
          } else if (key.name === "backspace") {
            state.query = state.query.slice(0, -1);
            state.selectedIndex = 0;
            state.listOffset = 0;
          } else if (ch && !key.ctrl && ch.length === 1 && ch >= " ") {
            state.query += ch;
            state.selectedIndex = 0;
            state.listOffset = 0;
          }
          render();
          return;
        }

        switch (key.name) {
          case "up":
            moveSelection(-1);
            render();
            return;
          case "down":
            moveSelection(1);
            render();
            return;
          case "pageup":
            moveSelection(-Math.max(1, contentHeight(listBox) - 2));
            render();
            return;
          case "pagedown":
            moveSelection(Math.max(1, contentHeight(listBox) - 2));
            render();
            return;
          case "home":
            state.selectedIndex = 0;
            render();
            return;
          case "end":
            state.selectedIndex = Math.max(0, filteredTemplates().length - 1);
            render();
            return;
          case "return":
          case "enter":
            runSelectedAction("edit");
            return;
          case "escape":
            if (state.query) {
              state.query = "";
              state.selectedIndex = 0;
              state.listOffset = 0;
              render();
              return;
            }
            finish({ type: "quit" });
            return;
        }

        if (ch === "j") {
          moveSelection(1);
          render();
        } else if (ch === "k") {
          moveSelection(-1);
          render();
        } else if (ch === "/") {
          state.searchActive = true;
          render();
        } else if (ch === "q") {
          finish({ type: "quit" });
        } else if (ch === "n") {
          finish({ type: "create" });
        } else if (ch === "e") {
          runSelectedAction("edit");
        } else if (ch === "c") {
          runSelectedAction("copy");
        } else if (ch === "d") {
          runSelectedAction("delete");
        } else if (ch === "o") {
          runSelectedAction("show");
        } else if (ch === "r") {
          finish({ type: "reload" });
        } else if (ch === "?") {
          state.showHelp = !state.showHelp;
          render();
        }
      },
    );

    screen.on("resize", () => {
      render();
    });

    render();
  });
}

async function collectTemplateArtifactSummaries(
  templates: Template[],
): Promise<Map<string, TemplateArtifactSummary>> {
  const entries = await Promise.all(
    templates.map(
      async (template): Promise<[string, TemplateArtifactSummary]> => [
        template.id,
        await collectTemplateArtifactSummary(template),
      ],
    ),
  );
  return new Map(entries);
}

async function collectTemplateArtifactSummary(
  template: Template,
): Promise<TemplateArtifactSummary> {
  const filesDir = path.join(path.dirname(template.path), "files");
  if (!(await pathExists(filesDir))) {
    return {
      filesDir,
      exists: false,
      fileCount: 0,
      dirCount: 0,
      previewLines: [],
      truncated: false,
    };
  }

  const summary: TemplateArtifactSummary = {
    filesDir,
    exists: true,
    fileCount: 0,
    dirCount: 0,
    previewLines: [],
    truncated: false,
  };

  async function walk(dir: string, depth: number): Promise<void> {
    if (summary.previewLines.length >= MAX_FILE_PREVIEW_ENTRIES) {
      summary.truncated = true;
      return;
    }

    const dirents = await fs.readdir(dir, { withFileTypes: true });
    dirents.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) {
        return a.isDirectory() ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    for (const dirent of dirents) {
      if (summary.previewLines.length >= MAX_FILE_PREVIEW_ENTRIES) {
        summary.truncated = true;
        return;
      }

      const relativePath = path.relative(filesDir, path.join(dir, dirent.name));
      const indent = "  ".repeat(depth);

      if (dirent.isDirectory()) {
        summary.dirCount += 1;
        summary.previewLines.push(`${indent}${relativePath}/`);
        await walk(path.join(dir, dirent.name), depth + 1);
      } else if (dirent.isFile()) {
        summary.fileCount += 1;
        summary.previewLines.push(`${indent}${relativePath}`);
      }
    }
  }

  await walk(filesDir, 0);
  return summary;
}

function formatBranchPrefix(
  templateBranchPrefix: string | undefined,
  workspaceConfig: WorkspaceConfig | undefined,
): string {
  if (templateBranchPrefix === undefined) {
    return workspaceConfig?.branchPrefix
      ? `inherits ${workspaceConfig.branchPrefix}`
      : "inherits none";
  }
  if (templateBranchPrefix === "") return "disabled";
  return templateBranchPrefix;
}

function formatDisableInitializers(
  value: boolean | string[] | undefined,
): string {
  if (value === true) return "all disabled";
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(", ") : "default";
  }
  return "default";
}

function formatHook(index: number, hook: Hook, width: number): string {
  const target = Array.isArray(hook.in) ? hook.in.join(", ") : hook.in;
  const suffix = target ? ` in ${target}` : "";
  const command = truncatePlain(hook.run, Math.max(10, width - 8));
  return [
    `${String(index + 1).padStart(2)}. ${escapeBlessedTags(hook.name)}${escapeBlessedTags(suffix)}`,
    `    {gray-fg}${escapeBlessedTags(command)}{/gray-fg}`,
  ].join("\n");
}

function labeledValue(label: string, value: string): string {
  return `{gray-fg}${label.padEnd(12)}{/gray-fg} ${escapeBlessedTags(value)}`;
}

function shortcut(key: string, value: string): string {
  return `  {white-fg}${key.padEnd(12)}{/white-fg} ${value}`;
}

function contentWidth(box: Box): number {
  const width = typeof box.width === "number" ? box.width : 80;
  return Math.max(10, width - 4);
}

function contentHeight(box: Box): number {
  const height = typeof box.height === "number" ? box.height : 20;
  return Math.max(1, height - 3);
}

function padToBox(lines: string[], box: Box): string {
  const width = contentWidth(box);
  const height = contentHeight(box);
  const padded = lines.slice(0, height).map((line) => {
    const gap = Math.max(0, width - visibleWidth(line));
    return gap > 0 ? `${line}${" ".repeat(gap)}` : line;
  });
  const blankLine = " ".repeat(width);
  while (padded.length < height) {
    padded.push(blankLine);
  }
  return padded.join("\n");
}

function visibleWidth(value: string): number {
  return stringWidth(value.replace(/\{[^}]*\}/g, ""));
}

function truncatePlain(value: string, maxWidth: number): string {
  if (stringWidth(value) <= maxWidth) return value;
  if (maxWidth <= 1) return "...".slice(0, maxWidth);

  let result = "";
  for (const char of value) {
    if (stringWidth(`${result}${char}...`) > maxWidth) break;
    result += char;
  }
  return `${result}...`;
}

function shortenPath(value: string): string {
  const home = process.env["HOME"];
  if (home && value.startsWith(home)) {
    return `~${value.slice(home.length)}`;
  }
  return value;
}
