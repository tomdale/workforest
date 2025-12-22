import { Box, Screen, ScrollableBox } from "@unblessed/node";
import type { TaskState } from "../utils/task-generator.ts";
import {
  type StampWorkspaceOptions,
  stampWorkspaceGenerator,
  type WorkspaceState,
} from "../workspace/index.ts";

type RepoStatus =
  | "pending"
  | "git"
  | "installing"
  | "turbo"
  | "completed"
  | "error";

interface RepoPane {
  box: ScrollableBox;
  status: RepoStatus;
  startTime?: number;
  lastOutput?: string;
}

/**
 * TUI-based workspace stamping with split panes for parallel installs.
 * Consumes the stampWorkspaceGenerator and displays progress in a beautiful interface.
 */
export class WorkspaceUI {
  private screen: Screen;
  private headerBox: Box;
  private statusBox: Box;
  private paneContainer: Box;
  private panes: Map<string, RepoPane> = new Map();
  private options: StampWorkspaceOptions;
  private hasErrors = false;

  constructor(options: StampWorkspaceOptions) {
    this.options = options;

    this.screen = new Screen({
      smartCSR: true,
      title: `Vercel Workspace: ${options.featureName}`,
      fullUnicode: true,
    });

    // Handle exit
    this.screen.key(["escape", "q", "C-c"], () => {
      this.cleanup();
      process.exit(this.hasErrors ? 1 : 0);
    });

    // Create UI components
    this.headerBox = new Box({
      top: 0,
      left: 0,
      width: "100%",
      height: 3,
      content: this.renderHeader(),
      style: {
        fg: "white",
        bg: "blue",
      },
      padding: {
        left: 1,
        right: 1,
      },
      tags: true,
    });

    this.statusBox = new Box({
      top: 3,
      left: 0,
      width: "100%",
      height: 5,
      border: {
        type: "line",
      },
      style: {
        border: {
          fg: "cyan",
        },
      },
      padding: {
        left: 1,
        right: 1,
      },
      tags: true,
      label: " {cyan-fg}Progress{/} ",
    });

    this.paneContainer = new Box({
      top: 8,
      left: 0,
      width: "100%",
      height: "100%-8",
    });

    this.screen.append(this.headerBox);
    this.screen.append(this.statusBox);
    this.screen.append(this.paneContainer);

    this.setupPanes();
    this.render();
  }

  private renderHeader(): string {
    const title = "{bold}⚡ Vercel Workspace{/bold}";
    const feature = `Feature: {bold}${this.options.featureName}{/bold}`;
    return `${title}  │  ${feature}`;
  }

  private setupPanes(): void {
    const repos = this.options.repos;
    const count = repos.length;

    // Calculate grid layout
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    const paneHeight = Math.floor(100 / rows);
    const paneWidth = Math.floor(100 / cols);

    repos.forEach((repo, index) => {
      const row = Math.floor(index / cols);
      const col = index % cols;

      const box = new ScrollableBox({
        parent: this.paneContainer,
        top: `${row * paneHeight}%`,
        left: `${col * paneWidth}%`,
        width: `${paneWidth}%`,
        height: `${paneHeight}%`,
        border: {
          type: "line",
        },
        style: {
          border: {
            fg: "gray",
          },
        },
        alwaysScroll: true,
        scrollbar: {
          ch: " ",
          track: {
            bg: "black",
          },
          style: {
            inverse: true,
          },
        },
        tags: true,
        keys: true,
        vi: true,
        mouse: true,
        label: this.formatPaneLabel(repo.name, "pending"),
      });

      // Enable scrolling
      box.key(["up", "down", "pageup", "pagedown"], (_, key) => {
        if (key.name === "up") box.scroll(-1);
        else if (key.name === "down") box.scroll(1);
        else if (key.name === "pageup") box.scroll(-(box.height as number));
        else if (key.name === "pagedown") box.scroll(box.height as number);
        this.screen.render();
      });

      this.panes.set(repo.name, {
        box,
        status: "pending",
      });
    });
  }

  private formatPaneLabel(
    repoName: string,
    status: RepoStatus,
    duration?: number,
    snippet?: string,
  ): string {
    const icons: Record<RepoStatus, string> = {
      pending: "○",
      git: "⟳",
      installing: "⟳",
      turbo: "⟳",
      completed: "✓",
      error: "✗",
    };

    const colors: Record<RepoStatus, string> = {
      pending: "gray",
      git: "blue",
      installing: "yellow",
      turbo: "cyan",
      completed: "green",
      error: "red",
    };

    const statusLabels: Record<RepoStatus, string> = {
      pending: "waiting",
      git: "git",
      installing: "installing",
      turbo: "turbo",
      completed: "done",
      error: "failed",
    };

    const icon = icons[status];
    const color = colors[status];
    const label = statusLabels[status];
    const durationStr = duration ? ` ${(duration / 1000).toFixed(1)}s` : "";
    const snippetStr = snippet ? ` • ${snippet.slice(0, 30)}` : "";

    return ` {${color}-fg}${icon}{/} {bold}${repoName}{/bold} {gray-fg}(${label}${durationStr})${snippetStr}{/} `;
  }

  private updatePane(
    repoName: string,
    status: RepoStatus,
    content?: string,
    append = false,
  ): void {
    const pane = this.panes.get(repoName);
    if (!pane) return;

    pane.status = status;

    if (status !== "pending" && !pane.startTime) {
      pane.startTime = Date.now();
    }

    const duration = pane.startTime ? Date.now() - pane.startTime : undefined;

    // Update content if provided
    if (content !== undefined) {
      if (append) {
        const current = pane.box.getContent();
        const next = this.limitBuffer(current + content);
        pane.box.setContent(next);
        pane.box.setScrollPerc(100);

        // Extract last line for label snippet
        const lines = content.split(/\r?\n/).filter(Boolean);
        if (lines.length > 0) {
          pane.lastOutput = lines[lines.length - 1].trim();
        }
      } else {
        pane.box.setContent(content);
      }
    }

    // Update label
    pane.box.setLabel(
      this.formatPaneLabel(repoName, status, duration, pane.lastOutput),
    );

    // Update border color
    const borderColors: Record<RepoStatus, string> = {
      pending: "gray",
      git: "blue",
      installing: "yellow",
      turbo: "cyan",
      completed: "green",
      error: "red",
    };
    pane.box.style.border = { fg: borderColors[status] };

    if (status === "error") {
      this.hasErrors = true;
    }

    this.updateStatusBox();
    this.render();
  }

  private limitBuffer(buffer: string, maxLength = 8000): string {
    if (buffer.length <= maxLength) return buffer;
    return buffer.slice(buffer.length - maxLength);
  }

  private updateStatusBox(): void {
    const statuses = Array.from(this.panes.values()).map((p) => p.status);
    const completed = statuses.filter((s) => s === "completed").length;
    const errors = statuses.filter((s) => s === "error").length;
    const inProgress = statuses.filter(
      (s) => s !== "pending" && s !== "completed" && s !== "error",
    ).length;
    const pending = statuses.filter((s) => s === "pending").length;

    const total = statuses.length;
    const progressBar = this.renderProgressBar(completed + errors, total, 40);

    const lines = [
      `${progressBar}  ${completed + errors}/${total}`,
      "",
      `  {green-fg}✓ ${completed} completed{/}  {yellow-fg}⟳ ${inProgress} in progress{/}  {gray-fg}○ ${pending} pending{/}${errors > 0 ? `  {red-fg}✗ ${errors} failed{/}` : ""}`,
    ];

    this.statusBox.setContent(lines.join("\n"));
  }

  private renderProgressBar(
    current: number,
    total: number,
    width: number,
  ): string {
    const filled = Math.round((current / total) * width);
    const empty = width - filled;
    const bar = "█".repeat(filled) + "░".repeat(empty);
    return `{green-fg}${bar}{/}`;
  }

  private appendOutput(repoName: string, data: string): void {
    const pane = this.panes.get(repoName);
    if (!pane) return;

    this.updatePane(repoName, pane.status, data, true);
  }

  /**
   * Run the workspace stamping with the TUI.
   */
  async run(): Promise<void> {
    this.render();

    try {
      for await (const state of stampWorkspaceGenerator(this.options)) {
        this.handleState(state);
      }

      // Wait a moment to show completion status
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error) {
      this.hasErrors = true;
      // Show error in header
      this.headerBox.setContent(
        `{red-fg}{bold}Error:{/bold} ${error instanceof Error ? error.message : String(error)}{/}`,
      );
      this.render();
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    this.cleanup();
  }

  private handleState(state: WorkspaceState): void {
    switch (state.phase) {
      case "init":
        this.updateStatusBox();
        break;

      case "git":
        this.updatePane(
          state.repo,
          "git",
          `{blue-fg}Git:{/} ${state.step}...\n`,
          true,
        );
        break;

      case "git-complete":
        this.appendOutput(state.repo, "{green-fg}✓ Git setup complete{/}\n\n");
        break;

      case "install-start":
        // Mark all repos as installing
        for (const { repo } of state.repos) {
          this.updatePane(
            repo.name,
            "installing",
            "{yellow-fg}Starting pnpm install...{/}\n",
          );
        }
        break;

      case "install":
        this.handleInstallState(state.repo, state.state);
        break;

      case "turbo":
        this.updatePane(
          state.repo,
          "turbo",
          "\n{cyan-fg}Linking turbo cache...{/}\n",
          true,
        );
        break;

      case "turbo-complete":
        this.appendOutput(state.repo, "{green-fg}✓ Turbo linked{/}\n");
        this.updatePane(state.repo, "completed");
        break;

      case "finalize":
        this.updateStatusBox();
        break;

      case "complete":
        // All done
        break;
    }
  }

  private handleInstallState(repo: string, state: TaskState): void {
    switch (state.status) {
      case "running":
        if (state.message) {
          this.appendOutput(repo, `{gray-fg}${state.message}{/}\n`);
        }
        break;

      case "output":
        this.appendOutput(repo, state.data);
        break;

      case "retrying":
        this.appendOutput(
          repo,
          `\n{yellow-fg}⚠ ${state.reason} (attempt ${state.attempt}){/}\n`,
        );
        break;

      case "completed":
        this.appendOutput(repo, "\n{green-fg}✓ Dependencies installed{/}\n");
        break;

      case "failed":
        this.appendOutput(
          repo,
          `\n{red-fg}✗ Failed: ${state.error.message}{/}\n`,
        );
        this.updatePane(repo, "error");
        break;

      case "skipped":
        this.appendOutput(repo, `{gray-fg}Skipped: ${state.reason}{/}\n`);
        this.updatePane(repo, "completed");
        break;
    }
  }

  private render(): void {
    this.screen.render();
  }

  private cleanup(): void {
    this.screen.destroy();
  }

  hasAnyErrors(): boolean {
    return this.hasErrors;
  }
}

/**
 * Run workspace stamping with the TUI.
 */
export async function stampWorkspaceWithUI(
  options: StampWorkspaceOptions,
): Promise<void> {
  const ui = new WorkspaceUI(options);
  await ui.run();

  if (ui.hasAnyErrors()) {
    process.exit(1);
  }
}
