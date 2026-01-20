import {
  Box,
  ListTable,
  Message,
  Prompt,
  Question,
  Screen,
} from "@unblessed/node";
import { loadWorkspaceConfig, saveWorkspaceConfig } from "../config.ts";
import type { WorkspaceConfig } from "../types.ts";

type PromptInput = string | null;

type Mode = "main" | "aliases";

type AliasRows = {
  rows: string[][];
  map: Array<string | null>;
};

export async function editConfigWithUI(): Promise<void> {
  const { config: existing, path } = await loadWorkspaceConfig();
  const config: WorkspaceConfig = { ...existing };
  let isDirty = false;
  let mode: Mode = "main";
  let isModalActive = false;
  let mainSelection = 1;
  let aliasSelection = 1;
  let aliasRows: AliasRows = { rows: [], map: [] };

  const screen = new Screen({
    smartCSR: true,
    title: "Workspace Config",
    fullUnicode: true,
  });

  new Box({
    parent: screen,
    top: 0,
    left: 0,
    width: "100%",
    height: 4,
    padding: { left: 1, right: 1 },
    tags: true,
    style: { fg: "white", bg: "blue" },
    content: renderHeader(path),
  });

  const mainTable = new ListTable({
    parent: screen,
    top: 4,
    left: 0,
    width: "100%",
    height: "100%-8",
    border: { type: "line" },
    label: " {cyan-fg}Config{/} ",
    tags: true,
    keys: true,
    vi: true,
    mouse: true,
    style: {
      header: { fg: "white", bold: true },
      cell: {
        selected: { bg: "blue" },
      },
    },
    data: buildMainRows(config),
  });

  const aliasTable = new ListTable({
    parent: screen,
    top: 4,
    left: 0,
    width: "100%",
    height: "100%-8",
    border: { type: "line" },
    label: " {cyan-fg}Aliases{/} ",
    tags: true,
    keys: true,
    vi: true,
    mouse: true,
    hidden: true,
    style: {
      header: { fg: "white", bold: true },
      cell: {
        selected: { bg: "blue" },
      },
    },
  });

  const footer = new Box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 4,
    padding: { left: 1, right: 1 },
    tags: true,
    style: { fg: "white", bg: "black" },
    content: renderFooter(mode, isDirty),
  });

  const prompt = new Prompt({
    parent: screen,
    border: { type: "line" },
    label: " {green-fg}Edit Value{/} ",
    width: "70%",
    height: 7,
    top: "center",
    left: "center",
    tags: true,
    hidden: true,
  });

  const question = new Question({
    parent: screen,
    border: { type: "line" },
    label: " {yellow-fg}Confirm{/} ",
    width: "70%",
    height: 7,
    top: "center",
    left: "center",
    tags: true,
    hidden: true,
  });

  const message = new Message({
    parent: screen,
    border: { type: "line" },
    label: " {red-fg}Error{/} ",
    width: "70%",
    height: 7,
    top: "center",
    left: "center",
    tags: true,
    hidden: true,
  });

  screen.key(["escape", "q", "C-c"], () => {
    if (isModalActive) return;
    if (mode === "aliases") {
      switchMode("main");
      return;
    }
    void maybeExit();
  });

  mainTable.on("select", (_item: unknown, index: number) => {
    mainSelection = index;
  });

  aliasTable.on("select", (_item: unknown, index: number) => {
    aliasSelection = index;
  });

  mainTable.key(["enter", "space"], () => {
    void runWithErrors(handleMainSelection);
  });

  mainTable.key(["s"], () => {
    void runWithErrors(saveConfig);
  });

  aliasTable.key(["enter", "space"], () => {
    void runWithErrors(handleAliasSelection);
  });

  aliasTable.key(["a"], () => {
    void runWithErrors(addAlias);
  });

  aliasTable.key(["d", "delete", "backspace"], () => {
    void runWithErrors(deleteAlias);
  });

  aliasTable.key(["s"], () => {
    void runWithErrors(saveConfig);
  });

  refreshMainTable();
  switchMode("main");

  try {
    screen.render();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    await showMessage(message, text);
    screen.destroy();
  }

  async function handleMainSelection(): Promise<void> {
    const index = Math.max(1, mainSelection);
    switch (index) {
      case 1:
        await editDefaultDir();
        break;
      case 2:
        await editDirPrefix();
        break;
      case 3:
        await editDefaultRepos();
        break;
      case 4:
        switchMode("aliases");
        break;
      default:
        break;
    }
  }

  async function editDefaultDir(): Promise<void> {
    const input = await askInput(
      prompt,
      "Default workspace directory (blank for cwd):",
      config.defaultDir ?? "",
    );
    if (input !== null) {
      config.defaultDir = normalizeValue(input);
      markDirty();
    }
    refreshMainTable();
  }

  async function editDirPrefix(): Promise<void> {
    const input = await askInput(
      prompt,
      "Workspace directory prefix:",
      config.dirPrefix ?? "workspace-",
    );
    if (input !== null) {
      config.dirPrefix = normalizeValue(input) ?? "workspace-";
      markDirty();
    }
    refreshMainTable();
  }

  async function editDefaultRepos(): Promise<void> {
    const input = await askInput(
      prompt,
      "Default repos (@alias or org/repo, + separated):",
      (config.defaultRepos ?? []).join("+"),
    );
    if (input !== null) {
      config.defaultRepos = splitTokens(input);
      markDirty();
    }
    refreshMainTable();
  }

  async function handleAliasSelection(): Promise<void> {
    const rowIndex = Math.max(1, aliasSelection) - 1;
    const alias = aliasRows.map[rowIndex];
    if (!alias) {
      await addAlias();
      return;
    }
    await editAlias(alias);
  }

  async function addAlias(): Promise<void> {
    const aliasInput = await askInput(prompt, "Alias name (start with @):", "");
    const normalizedAlias = normalizeAlias(aliasInput);
    if (!normalizedAlias) {
      return;
    }
    await editAlias(normalizedAlias);
  }

  async function editAlias(alias: string): Promise<void> {
    const existing = config.aliases?.[alias] ?? [];
    const repoInput = await askInput(
      prompt,
      `Repos for ${alias} (org/repo, + separated). Blank removes alias:`,
      existing.join("+"),
    );
    if (repoInput === null) {
      return;
    }
    const tokens = splitTokens(repoInput);
    const nextAliases = { ...(config.aliases ?? {}) };
    if (tokens.length === 0) {
      delete nextAliases[alias];
    } else {
      nextAliases[alias] = tokens;
    }
    config.aliases = nextAliases;
    markDirty();
    refreshAliasTable();
    refreshMainTable();
  }

  async function deleteAlias(): Promise<void> {
    const rowIndex = Math.max(1, aliasSelection) - 1;
    const alias = aliasRows.map[rowIndex];
    if (!alias) return;
    const confirmed = await askQuestion(question, `Delete alias ${alias}?`);
    if (!confirmed) return;
    const nextAliases = { ...(config.aliases ?? {}) };
    delete nextAliases[alias];
    config.aliases = nextAliases;
    markDirty();
    refreshAliasTable();
    refreshMainTable();
  }

  function refreshMainTable(): void {
    mainTable.setData(buildMainRows(config));
    mainTable.select(Math.max(1, mainSelection));
  }

  function refreshAliasTable(): void {
    aliasRows = buildAliasRows(config);
    aliasTable.setData(aliasRows.rows);
    const maxSelection = Math.max(1, aliasRows.rows.length - 1);
    aliasTable.select(Math.min(Math.max(1, aliasSelection), maxSelection));
  }

  function switchMode(nextMode: Mode): void {
    mode = nextMode;
    mainTable.hide();
    aliasTable.hide();

    if (mode === "main") {
      mainTable.show();
      mainTable.focus();
    } else {
      refreshAliasTable();
      aliasTable.show();
      aliasTable.focus();
    }

    footer.setContent(renderFooter(mode, isDirty));
    screen.render();
  }

  function markDirty(): void {
    if (!isDirty) {
      isDirty = true;
      footer.setContent(renderFooter(mode, isDirty));
      screen.render();
    }
  }

  async function saveConfig(): Promise<void> {
    try {
      await saveWorkspaceConfig(path, config);
      isDirty = false;
      footer.setContent(renderFooter(mode, isDirty));
      screen.render();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      await showMessage(message, text);
    }
  }

  async function maybeExit(): Promise<void> {
    if (!isDirty) {
      screen.destroy();
      process.exit(0);
      return;
    }
    const confirmed = await askQuestion(question, "Discard unsaved changes?");
    if (confirmed) {
      screen.destroy();
      process.exit(0);
    }
  }

  async function askInput(
    uiPrompt: Prompt,
    label: string,
    value: string,
  ): Promise<PromptInput> {
    isModalActive = true;
    return new Promise((resolve, reject) => {
      uiPrompt.readInput(label, value, (err, data) => {
        isModalActive = false;
        if (err) {
          reject(err);
          return;
        }
        resolve(typeof data === "string" ? data : null);
      });
    });
  }

  async function askQuestion(
    uiQuestion: Question,
    label: string,
  ): Promise<boolean> {
    isModalActive = true;
    return new Promise((resolve, reject) => {
      uiQuestion.ask(label, (err, data) => {
        isModalActive = false;
        if (err) {
          reject(err);
          return;
        }
        resolve(Boolean(data));
      });
    });
  }

  async function runWithErrors(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      await showMessage(message, text);
    }
  }
}

function renderHeader(configPath: string): string {
  return `{bold}Workspace Config{/bold}\nConfig file: ${configPath}\nUse arrows to navigate.`;
}

function renderFooter(mode: Mode, isDirty: boolean): string {
  const dirty = isDirty ? "{yellow-fg}* unsaved{/}" : "{gray-fg}saved{/}";
  if (mode === "aliases") {
    return `{gray-fg}Enter to edit • a add • d delete • esc back • s save{/}  ${dirty}`;
  }
  return `{gray-fg}Enter to edit • s save • q quit{/}  ${dirty}`;
}

function buildMainRows(config: WorkspaceConfig): string[][] {
  return [
    ["Setting", "Value"],
    ["Default directory", config.defaultDir ?? "(cwd)"],
    ["Directory prefix", config.dirPrefix ?? "workspace-"],
    [
      "Default repos",
      (config.defaultRepos ?? []).length > 0
        ? (config.defaultRepos ?? []).join("+")
        : "(none)",
    ],
    ["Aliases", summarizeAliases(config.aliases ?? {})],
  ];
}

function buildAliasRows(config: WorkspaceConfig): AliasRows {
  const entries = Object.entries(config.aliases ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const rows: string[][] = [["Alias", "Repos"]];
  const map: Array<string | null> = [];

  for (const [alias, repos] of entries) {
    rows.push([alias, repos.join("+")]);
    map.push(alias);
  }

  rows.push(["+ Add alias", ""]);
  map.push(null);

  return { rows, map };
}

function summarizeAliases(aliases: Record<string, string[]>): string {
  const count = Object.keys(aliases).length;
  if (count === 0) return "(none)";
  return `${count} alias${count === 1 ? "" : "es"}`;
}

function normalizeAlias(value: PromptInput): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

function normalizeValue(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function splitTokens(input: string): string[] {
  return input
    .split(/[+,]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function showMessage(message: Message, text: string): Promise<void> {
  return new Promise((resolve) => {
    message.display(text, 3, () => resolve());
  });
}
