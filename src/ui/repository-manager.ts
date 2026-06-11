import path from "node:path";
import { Box, NodeRuntime, Screen, setRuntime } from "@unblessed/node";
import stringWidth from "string-width";
import {
  type CachedRepository,
  formatByteSize,
  repositoryDisplayName,
} from "../repositories.ts";
import { escapeBlessedTags } from "../terminal/command-stream-adapter.ts";
import { fullscreenColor } from "../terminal/theme.ts";

setRuntime(new NodeRuntime());

export type RepositoryManagerAction =
  | { type: "quit" }
  | { type: "reload" }
  | { type: "add" }
  | { type: "prune" }
  | { type: "info"; mirrorPath: string }
  | { type: "update"; mirrorPath: string }
  | { type: "repair"; mirrorPath: string }
  | { type: "delete"; mirrorPath: string };

export type RepositoryManagerOptions = {
  repositories: CachedRepository[];
  cacheDir: string;
  initialMirrorPath?: string;
};

type RepositoryManagerState = {
  selectedIndex: number;
  listOffset: number;
  query: string;
  searchActive: boolean;
  showHelp: boolean;
  status: string;
};

const MIN_COLUMNS = 80;
const MIN_ROWS = 20;
const HEADER_HEIGHT = 3;
const FOOTER_HEIGHT = 1;

export function shouldUseRepositoryManager(): boolean {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  if (process.env["CI"] || process.env["WORKFOREST_NO_TUI"]) return false;
  return (
    (process.stdout.columns ?? 80) >= MIN_COLUMNS &&
    (process.stdout.rows ?? 24) >= MIN_ROWS
  );
}

export function runRepositoryManager({
  repositories,
  cacheDir,
  initialMirrorPath,
}: RepositoryManagerOptions): Promise<RepositoryManagerAction> {
  const initialIndex = Math.max(
    0,
    repositories.findIndex(
      (repository) => repository.mirrorPath === initialMirrorPath,
    ),
  );

  return new Promise((resolve) => {
    const screen = new Screen({
      smartCSR: true,
      fullUnicode: true,
      title: "wf cache manage",
    });
    const initialLayout = repositoryManagerLayout(
      Number(screen.width),
      Number(screen.height),
    );
    const headerBox = new Box({
      parent: screen,
      top: 0,
      left: 0,
      width: "100%",
      height: HEADER_HEIGHT,
      tags: true,
      padding: { left: 1 },
      style: { fg: fullscreenColor.primary },
    });
    const listBox = new Box({
      parent: screen,
      top: HEADER_HEIGHT,
      left: 0,
      width: initialLayout.listWidth,
      height: initialLayout.contentHeight,
      border: { type: "line" },
      label: " Repositories ",
      tags: true,
      padding: { left: 1, top: 1 },
      style: { border: { fg: fullscreenColor.accent } },
    });
    const detailBox = new Box({
      parent: screen,
      top: HEADER_HEIGHT,
      left: initialLayout.listWidth,
      width: initialLayout.detailWidth,
      height: initialLayout.detailHeight,
      border: { type: "line" },
      label: " Selected Repository ",
      tags: true,
      padding: { left: 1, top: 1 },
      style: { border: { fg: fullscreenColor.muted } },
    });
    const worktreeBox = new Box({
      parent: screen,
      top: initialLayout.worktreeTop,
      left: initialLayout.listWidth,
      width: initialLayout.detailWidth,
      height: initialLayout.worktreeHeight,
      border: { type: "line" },
      label: " Worktrees ",
      tags: true,
      padding: { left: 1, top: 1 },
      style: { border: { fg: fullscreenColor.muted } },
    });
    const footerBox = new Box({
      parent: screen,
      bottom: 0,
      left: 0,
      width: "100%",
      height: FOOTER_HEIGHT,
      tags: true,
      padding: { left: 1 },
      style: { fg: fullscreenColor.muted },
    });
    const state: RepositoryManagerState = {
      selectedIndex: initialIndex,
      listOffset: 0,
      query: "",
      searchActive: false,
      showHelp: false,
      status: "",
    };
    let finished = false;

    function finish(action: RepositoryManagerAction): void {
      if (finished) return;
      finished = true;
      screen.destroy();
      resolve(action);
    }

    function filteredRepositories(): CachedRepository[] {
      const query = state.query.trim().toLowerCase();
      if (!query) return repositories;
      return repositories.filter((repository) =>
        [
          repositoryDisplayName(repository),
          repository.remote,
          repository.mirrorPath,
          repository.defaultBranch,
          ...repository.issues,
          ...repository.worktrees.flatMap((worktree) => [
            worktree.path,
            worktree.branch,
          ]),
        ]
          .filter(Boolean)
          .join("\n")
          .toLowerCase()
          .includes(query),
      );
    }

    function clampSelection(filtered = filteredRepositories()): void {
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

    function selectedRepository(): CachedRepository | undefined {
      const filtered = filteredRepositories();
      clampSelection(filtered);
      return filtered[state.selectedIndex];
    }

    function render(): void {
      applyLayout();
      const filtered = filteredRepositories();
      clampSelection(filtered);
      const selected = selectedRepository();
      renderHeader();
      renderList(filtered);
      if (state.showHelp) {
        renderHelp();
      } else {
        renderDetails(selected);
      }
      renderWorktrees(selected);
      renderFooter();
      screen.render();
    }

    function applyLayout(): void {
      const layout = repositoryManagerLayout(
        Number(screen.width),
        Number(screen.height),
      );
      headerBox.width = layout.screenWidth;
      listBox.width = layout.listWidth;
      listBox.height = layout.contentHeight;
      detailBox.left = layout.listWidth;
      detailBox.width = layout.detailWidth;
      detailBox.height = layout.detailHeight;
      worktreeBox.top = layout.worktreeTop;
      worktreeBox.left = layout.listWidth;
      worktreeBox.width = layout.detailWidth;
      worktreeBox.height = layout.worktreeHeight;
      footerBox.width = layout.screenWidth;
    }

    function renderHeader(): void {
      const attentionCount = repositories.filter(
        (repository) => repository.health !== "healthy",
      ).length;
      const activeCount = repositories.reduce(
        (total, repository) => total + activeWorktreeCount(repository),
        0,
      );
      const summary = [
        `${repositories.length} cached`,
        `${formatByteSize(totalCachedSize(repositories))}`,
        activeCount > 0
          ? `${activeCount} active worktree${activeCount === 1 ? "" : "s"}`
          : "no active worktrees",
        attentionCount > 0
          ? `{yellow-fg}${attentionCount} need${attentionCount === 1 ? "s" : ""} attention{/yellow-fg}`
          : "{green-fg}all healthy{/green-fg}",
      ].join("  {gray-fg}|{/gray-fg}  ");

      headerBox.setContent(
        [
          "{bold}Repository cache{/bold}",
          summary,
          `{gray-fg}${escapeBlessedTags(truncatePlain(shortenPath(cacheDir), Math.max(1, Number(screen.width) - 3)))}{/gray-fg}`,
        ].join("\n"),
      );
    }

    function renderList(filtered: CachedRepository[]): void {
      const lines: string[] = [];
      listBox.setLabel(
        state.query
          ? ` Repositories ${filtered.length}/${repositories.length} `
          : ` Repositories ${repositories.length} `,
      );

      if (repositories.length === 0) {
        lines.push(
          "{bold}No cached repositories{/bold}",
          "",
          "Press {white-fg}a{/white-fg} to cache one.",
          "",
          "{gray-fg}Cache directory{/gray-fg}",
          escapeBlessedTags(cacheDir),
        );
        listBox.setContent(padToBox(lines, listBox));
        return;
      }

      if (state.searchActive || state.query) {
        const cursor = state.searchActive ? "{inverse} {/inverse}" : "";
        const visibleQuery = truncatePlain(
          state.query,
          Math.max(1, contentWidth(listBox) - 10),
        );
        lines.push(
          `{gray-fg}Search{/gray-fg} /${escapeBlessedTags(visibleQuery)}${cursor}`,
          "",
        );
      }
      if (filtered.length === 0) {
        lines.push("{yellow-fg}No matching repositories{/yellow-fg}");
        listBox.setContent(padToBox(lines, listBox));
        return;
      }

      const height = Math.max(1, contentHeight(listBox) - lines.length);
      if (state.selectedIndex < state.listOffset) {
        state.listOffset = state.selectedIndex;
      } else if (state.selectedIndex >= state.listOffset + height) {
        state.listOffset = state.selectedIndex - height + 1;
      }

      for (const [visibleIndex, repository] of filtered
        .slice(state.listOffset, state.listOffset + height)
        .entries()) {
        const index = state.listOffset + visibleIndex;
        const selected = index === state.selectedIndex;
        const marker = selected ? "{cyan-fg}>{/cyan-fg}" : " ";
        const name = truncatePlain(
          repositoryDisplayName(repository),
          Math.max(8, contentWidth(listBox) - 4),
        );
        const usage =
          activeWorktreeCount(repository) > 0
            ? `${activeWorktreeCount(repository)} active`
            : "unused";
        const metadata = truncatePlain(
          `${healthLabel(repository)}  ${formatByteSize(repository.sizeBytes)}  ${usage}`,
          Math.max(8, contentWidth(listBox) - 4),
        );
        lines.push(
          `${marker} ${selected ? `{bold}${escapeBlessedTags(name)}{/bold}` : escapeBlessedTags(name)}`,
        );
        lines.push(
          `  ${healthMarker(repository)} {gray-fg}${escapeBlessedTags(metadata)}{/gray-fg}`,
        );
      }
      listBox.setContent(padToBox(lines, listBox));
    }

    function renderDetails(repository: CachedRepository | undefined): void {
      if (!repository) {
        detailBox.setLabel(" Selected Repository ");
        detailBox.setContent(
          padToBox(
            [
              "{bold}No repository selected{/bold}",
              "",
              "{gray-fg}Cache a repository to inspect it here.{/gray-fg}",
            ],
            detailBox,
          ),
        );
        return;
      }

      detailBox.setContent(
        padToBox(
          [
            `{bold}${escapeBlessedTags(repositoryDisplayName(repository))}{/bold}`,
            healthSummary(repository),
            ...(repository.issues.length > 0
              ? [
                  `{yellow-fg}${escapeBlessedTags(truncatePlain(repository.issues.join("; "), contentWidth(detailBox)))}{/yellow-fg}`,
                ]
              : []),
            "",
            detailField("Remote", repository.remote ?? "(missing)", detailBox),
            detailField(
              "Default branch",
              repository.defaultBranch ?? "(unknown)",
              detailBox,
            ),
            detailField(
              "Disk usage",
              formatByteSize(repository.sizeBytes),
              detailBox,
            ),
            detailField(
              "Updated",
              repository.lastFetchedAt?.toLocaleString() ?? "unknown",
              detailBox,
            ),
            detailField(
              "Mirror",
              shortenPath(repository.mirrorPath),
              detailBox,
            ),
          ],
          detailBox,
        ),
      );
      detailBox.setLabel(" Selected Repository ");
    }

    function renderWorktrees(repository: CachedRepository | undefined): void {
      const lines: string[] = [];
      if (!repository) {
        worktreeBox.setLabel(" Worktrees ");
        worktreeBox.setContent(padToBox(lines, worktreeBox));
        return;
      }
      const activeCount = activeWorktreeCount(repository);
      worktreeBox.setLabel(
        activeCount > 0 ? ` Worktrees ${activeCount} ` : " Worktrees ",
      );

      if (state.showHelp) {
        worktreeBox.setContent(
          padToBox(
            [
              "{bold}Safety{/bold}",
              "",
              "Delete refuses mirrors with active worktrees.",
              "Repair prunes stale registrations and verifies objects.",
              "Clean removes only unused mirrors.",
            ],
            worktreeBox,
          ),
        );
        return;
      }

      if (repository.worktrees.length === 0) {
        lines.push(
          "{green-fg}Unused mirror{/green-fg}",
          "{gray-fg}No worktrees depend on this cache entry. It is eligible for cleanup.{/gray-fg}",
        );
      } else {
        for (const worktree of repository.worktrees) {
          const state =
            worktree.prunable || !worktree.exists
              ? "{yellow-fg}stale{/yellow-fg}"
              : "{green-fg}active{/green-fg}";
          lines.push(
            truncateTagged(
              `${state}  ${escapeBlessedTags(shortenPath(worktree.path))}`,
              contentWidth(worktreeBox),
            ),
            `   {gray-fg}${escapeBlessedTags(worktree.detached ? "detached HEAD" : (worktree.branch ?? "unknown branch"))}{/gray-fg}`,
          );
        }
      }
      worktreeBox.setContent(padToBox(lines, worktreeBox));
    }

    function renderHelp(): void {
      detailBox.setLabel(" Keyboard Shortcuts ");
      detailBox.setContent(
        padToBox(
          [
            shortcutRow(["j/k/arrows", "navigate"]),
            shortcutRow(["/", "search repositories", "enter/i", "info"]),
            shortcutRow(["a", "add", "u", "update"]),
            shortcutRow(["r", "repair", "d", "delete"]),
            shortcutRow(["x", "prune unused"]),
            shortcutRow(["R", "reload", "?", "close help"]),
            shortcutRow(["q", "quit"]),
          ],
          detailBox,
        ),
      );
    }

    function renderFooter(): void {
      const mode = state.searchActive ? "search" : "browse";
      const status = state.status
        ? `  {gray-fg}|{/gray-fg}  ${escapeBlessedTags(state.status)}`
        : "";
      const width = Number(screen.width);
      const shortcuts =
        width < 100
          ? "j/k move  / search  enter info  ? help  q quit"
          : width < 130
            ? "j/k move  / search  enter info  u update  r repair  d delete  ? help  q quit"
            : "j/k navigate  enter info  a add  u update  r repair  d delete  x prune  / search  ? help  q quit";
      footerBox.setContent(
        `{white-fg}${mode}{/white-fg}  ${shortcuts}${status}`,
      );
    }

    function moveSelection(delta: number): void {
      const filtered = filteredRepositories();
      if (filtered.length === 0) return;
      state.selectedIndex = Math.min(
        filtered.length - 1,
        Math.max(0, state.selectedIndex + delta),
      );
    }

    function runSelectedAction(
      type: "info" | "update" | "repair" | "delete",
    ): void {
      const repository = selectedRepository();
      if (!repository) {
        state.status = "No repository selected";
        render();
        return;
      }
      finish({ type, mirrorPath: repository.mirrorPath });
    }

    screen.on(
      "keypress",
      (ch: string, key: { name?: string; ctrl?: boolean; shift?: boolean }) => {
        if (!key) return;
        if (key.ctrl && ch === "c") {
          finish({ type: "quit" });
          return;
        }
        if (state.searchActive) {
          if (key.name === "escape") {
            state.searchActive = false;
          } else if (key.name === "return" || key.name === "enter") {
            runSelectedAction("info");
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
            state.selectedIndex = Math.max(
              0,
              filteredRepositories().length - 1,
            );
            render();
            return;
          case "return":
          case "enter":
            runSelectedAction("info");
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
        } else if (ch === "a") {
          finish({ type: "add" });
        } else if (ch === "i") {
          runSelectedAction("info");
        } else if (ch === "u") {
          runSelectedAction("update");
        } else if (ch === "r") {
          runSelectedAction("repair");
        } else if (ch === "d") {
          runSelectedAction("delete");
        } else if (ch === "x") {
          finish({ type: "prune" });
        } else if (ch === "R") {
          finish({ type: "reload" });
        } else if (ch === "?") {
          state.showHelp = !state.showHelp;
          render();
        }
      },
    );
    screen.on("resize", render);
    render();
  });
}

function activeWorktreeCount(repository: CachedRepository): number {
  return repository.worktrees.filter(
    (worktree) => worktree.exists && !worktree.prunable,
  ).length;
}

function repositoryManagerLayout(
  screenWidth: number,
  screenHeight: number,
): {
  screenWidth: number;
  listWidth: number;
  detailWidth: number;
  contentHeight: number;
  detailHeight: number;
  worktreeTop: number;
  worktreeHeight: number;
} {
  const width = Math.max(MIN_COLUMNS, screenWidth);
  const height = Math.max(MIN_ROWS, screenHeight);
  const listWidth = Math.min(46, Math.max(30, Math.floor(width * 0.38)));
  const detailWidth = width - listWidth;
  const contentHeight = height - HEADER_HEIGHT - FOOTER_HEIGHT;
  const detailHeight = Math.min(
    16,
    Math.max(10, Math.floor(contentHeight * 0.55)),
  );
  const worktreeTop = HEADER_HEIGHT + detailHeight - 1;
  const worktreeHeight = height - worktreeTop - FOOTER_HEIGHT;

  return {
    screenWidth: width,
    listWidth,
    detailWidth,
    contentHeight,
    detailHeight,
    worktreeTop,
    worktreeHeight,
  };
}

function totalCachedSize(repositories: CachedRepository[]): number | null {
  const knownSizes = repositories
    .map((repository) => repository.sizeBytes)
    .filter((size): size is number => size !== null);
  if (knownSizes.length === 0 && repositories.length > 0) return null;
  return knownSizes.reduce((total, size) => total + size, 0);
}

function healthLabel(repository: CachedRepository): string {
  switch (repository.health) {
    case "healthy":
      return "healthy";
    case "attention":
      return "attention";
    case "invalid":
      return "invalid";
  }
}

function healthMarker(repository: CachedRepository): string {
  switch (repository.health) {
    case "healthy":
      return "{green-fg}●{/green-fg}";
    case "attention":
      return "{yellow-fg}▲{/yellow-fg}";
    case "invalid":
      return "{red-fg}✗{/red-fg}";
  }
}

function healthSummary(repository: CachedRepository): string {
  switch (repository.health) {
    case "healthy":
      return "{green-fg}● Healthy{/green-fg}";
    case "attention":
      return "{yellow-fg}▲ Needs attention{/yellow-fg}";
    case "invalid":
      return "{red-fg}✗ Invalid cache entry{/red-fg}";
  }
}

function detailField(label: string, value: string, box: Box): string {
  const available = Math.max(1, contentWidth(box) - label.length - 2);
  return `{gray-fg}${escapeBlessedTags(`${label}:`)}{/gray-fg} ${escapeBlessedTags(truncatePlain(value, available))}`;
}

function shortcut(key: string, label: string): string {
  return `{white-fg}${escapeBlessedTags(key)}{/white-fg}  ${escapeBlessedTags(label)}`;
}

function shortcutRow(parts: string[]): string {
  const pairs: string[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const key = parts[index];
    const label = parts[index + 1];
    if (!key || !label) continue;
    pairs.push(shortcut(key, label));
  }
  return pairs.join("    ");
}

function shortenPath(value: string): string {
  const home = process.env["HOME"];
  if (home && (value === home || value.startsWith(`${home}${path.sep}`))) {
    return `~${value.slice(home.length)}`;
  }
  return value;
}

function contentWidth(box: Box): number {
  return Math.max(1, Number(box.width) - 4);
}

function contentHeight(box: Box): number {
  return Math.max(1, Number(box.height) - 3);
}

function padToBox(lines: string[], box: Box): string {
  return lines.slice(0, contentHeight(box)).join("\n");
}

function truncatePlain(value: string, width: number): string {
  if (stringWidth(value) <= width) return value;
  if (width <= 3) return ".".repeat(Math.max(0, width));
  let result = "";
  for (const character of value) {
    if (stringWidth(`${result}${character}...`) > width) break;
    result += character;
  }
  return `${result}...`;
}

function truncateTagged(value: string, width: number): string {
  const plain = value.replace(/\{[^}]+\}/g, "");
  return stringWidth(plain) <= width ? value : truncatePlain(plain, width);
}
