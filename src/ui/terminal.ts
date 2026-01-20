import { type ChildProcess, spawn } from "node:child_process";
import { Box, Screen, ScrollableBox } from "@unblessed/node";

export interface Subtask {
  id: string;
  name: string;
  command: string;
  args: string[];
  cwd?: string;
}

export interface TerminalUIState {
  primaryTask: string;
  subtasks: Subtask[];
}

export interface TerminalUIOptions extends TerminalUIState {
  maxConcurrent?: number;
}

type SubtaskStatus = "pending" | "queued" | "running" | "completed" | "error";

export class TerminalUI {
  private screen: Screen;
  private primaryBox: Box;
  private panes: ScrollableBox[] = [];
  private processes: Map<string, ChildProcess> = new Map();
  private state: TerminalUIState;
  private options: Required<Pick<TerminalUIOptions, "maxConcurrent">>;
  private subtaskStatuses: Map<string, SubtaskStatus> = new Map();
  private subtaskToPane: Map<string, number> = new Map();
  private queuedSubtasks: Subtask[] = [];
  private hasErrors = false;

  constructor(state: TerminalUIOptions) {
    this.state = state;
    this.options = {
      maxConcurrent: state.maxConcurrent ?? 4,
    };

    this.screen = new Screen({
      smartCSR: true,
      title: "Vercel Workspace",
      fullUnicode: true,
    });

    // Primary task box - top section
    this.primaryBox = new Box({
      top: 0,
      left: 0,
      width: "100%",
      height: `${this.primaryHeight}%`,
      content: "",
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
        top: 1,
        bottom: 1,
      },
      tags: true,
    });

    // Handle exit
    this.screen.key(["escape", "q", "C-c"], () => {
      this.cleanup();
      process.exit(0);
    });

    this.setupLayout();
  }

  protected primaryHeight = 32;

  protected setupLayout(): void {
    // Determine pane grid based on maxConcurrent and subtask count
    const paneCount = Math.min(
      this.options.maxConcurrent,
      Math.max(1, this.state.subtasks.length),
    );
    const cols = Math.ceil(Math.sqrt(paneCount));
    const rows = Math.ceil(paneCount / cols);
    const paneAreaHeight = 100 - this.primaryHeight;
    const paneHeight = paneAreaHeight / rows;
    const paneWidth = 100 / cols;

    for (let index = 0; index < paneCount; index++) {
      const row = Math.floor(index / cols);
      const col = index % cols;
      const top = this.primaryHeight + row * paneHeight;
      const left = col * paneWidth;

      const box = new ScrollableBox({
        top: `${top}%`,
        left: `${left}%`,
        width: `${paneWidth}%`,
        height: `${paneHeight}%`,
        border: {
          type: "line",
        },
        style: {
          border: {
            fg: "green",
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
        label: " {white-fg}waiting...{/} ",
      });

      // Enable scrolling with arrow keys
      box.key(["up", "down", "pageup", "pagedown"], (_, key) => {
        if (key.name === "up") {
          box.scroll(-1);
        } else if (key.name === "down") {
          box.scroll(1);
        } else if (key.name === "pageup") {
          box.scroll(-(box.height as number));
        } else if (key.name === "pagedown") {
          box.scroll(box.height as number);
        }
        this.screen.render();
      });

      this.panes.push(box);
      this.screen.append(box);
    }

    this.screen.append(this.primaryBox);

    // Initialize all subtask statuses as pending
    for (const subtask of this.state.subtasks) {
      this.subtaskStatuses.set(subtask.id, "pending");
    }

    this.updatePrimaryTask(this.state.primaryTask);
    this.render();
  }

  private renderTaskTree(): string {
    const lines: string[] = [];

    // Main task header
    const mainStatus = this.getOverallStatus();
    const mainStatusIcons: Record<typeof mainStatus, string> = {
      completed: "✓",
      error: "✗",
      running: "⟳",
      pending: "○",
    };
    const mainStatusColors: Record<typeof mainStatus, string> = {
      completed: "green",
      error: "red",
      running: "yellow",
      pending: "white",
    };
    const mainStatusIcon = mainStatusIcons[mainStatus];
    const mainStatusColor = mainStatusColors[mainStatus];

    lines.push(
      `{bold}{${mainStatusColor}-fg}${mainStatusIcon}{/} ${this.state.primaryTask}{/bold}`,
    );
    lines.push("");

    // Subtasks tree
    const subtaskIcons: Record<SubtaskStatus, string> = {
      pending: "○",
      queued: "…",
      running: "⟳",
      completed: "✓",
      error: "✗",
    };
    const subtaskColors: Record<SubtaskStatus, string> = {
      pending: "white",
      queued: "blue",
      running: "yellow",
      completed: "green",
      error: "red",
    };

    this.state.subtasks.forEach((subtask, index) => {
      const status = this.subtaskStatuses.get(subtask.id) ?? "pending";
      const isLast = index === this.state.subtasks.length - 1;
      const connector = isLast ? "└──" : "├──";
      const statusIcon = subtaskIcons[status];
      const statusColor = subtaskColors[status];

      lines.push(
        ` ${connector} {${statusColor}-fg}${statusIcon}{/} ${subtask.name}`,
      );
    });

    return lines.join("\n");
  }

  private getOverallStatus(): "pending" | "running" | "completed" | "error" {
    const statuses = Array.from(this.subtaskStatuses.values());

    if (statuses.some((s) => s === "error")) {
      return "error";
    }
    if (statuses.length && statuses.every((s) => s === "completed")) {
      return "completed";
    }
    if (statuses.some((s) => s === "running" || s === "queued")) {
      return "running";
    }
    return "pending";
  }

  updatePrimaryTask(message: string): void {
    this.state.primaryTask = message;
    this.primaryBox.setContent(this.renderTaskTree());
    this.render();
  }

  private updateSubtaskStatus(subtaskId: string, status: SubtaskStatus): void {
    const subtask = this.state.subtasks.find((s) => s.id === subtaskId);
    if (!subtask) return;

    // Update status tracking
    this.subtaskStatuses.set(subtaskId, status);
    if (status === "error") {
      this.hasErrors = true;
    }

    const paneIndex = this.subtaskToPane.get(subtaskId);
    if (paneIndex !== undefined) {
      this.updatePaneLabel(subtask, status);
    }

    // Update primary task tree
    this.primaryBox.setContent(this.renderTaskTree());
    this.render();
  }

  private appendToSubtask(subtaskId: string, data: string): void {
    const index = this.subtaskToPane.get(subtaskId);
    if (index === undefined) return;

    const box = this.panes[index];
    const currentContent = box.getContent();
    const nextContent = this.limitBuffer(currentContent + data);
    box.setContent(nextContent);
    // Auto-scroll to bottom
    box.setScrollPerc(100);
    this.render();
  }

  private limitBuffer(buffer: string, maxLength = 8000): string {
    if (buffer.length <= maxLength) return buffer;
    return buffer.slice(buffer.length - maxLength);
  }

  private formatDuration(start?: number): string {
    if (!start) return "0.0s";
    const seconds = (Date.now() - start) / 1000;
    return `${seconds.toFixed(1)}s`;
  }

  private async runSubtaskInPane(
    subtask: Subtask,
    paneIndex: number,
  ): Promise<void> {
    this.subtaskToPane.set(subtask.id, paneIndex);
    const box = this.panes[paneIndex];
    box.setContent("");

    // Show command being executed
    const commandLine = `$ ${subtask.command} ${subtask.args.join(" ")}\n\n`;
    this.appendToSubtask(subtask.id, commandLine);

    this.updateSubtaskStatus(subtask.id, "running");
    const startedAt = Date.now();
    this.updatePaneLabel(subtask, "running", startedAt);

    return new Promise((resolve) => {
      const child = spawn(subtask.command, subtask.args, {
        cwd: subtask.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FORCE_COLOR: "1" },
      });

      this.processes.set(subtask.id, child);

      let hasError = false;

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        this.appendToSubtask(subtask.id, chunk);
        this.updatePaneLabel(subtask, "running", startedAt, chunk);
      });

      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        hasError = true;
        this.appendToSubtask(subtask.id, chunk);
        this.updatePaneLabel(subtask, "running", startedAt, chunk);
      });

      child.on("error", (error: Error) => {
        this.appendToSubtask(
          subtask.id,
          `\n{red-fg}Error: ${error.message}{/}\n`,
        );
        this.updateSubtaskStatus(subtask.id, "error");
        this.processes.delete(subtask.id);
        resolve();
      });

      child.on("close", (code: number | null) => {
        this.processes.delete(subtask.id);
        if (code === 0 && !hasError) {
          this.updateSubtaskStatus(subtask.id, "completed");
          this.updatePaneLabel(subtask, "completed", startedAt);
        } else {
          this.updateSubtaskStatus(subtask.id, "error");
          this.appendToSubtask(
            subtask.id,
            `\n{red-fg}Process exited with code ${code}{/}\n`,
          );
          this.updatePaneLabel(subtask, "error", startedAt);
        }
        resolve();
      });
    });
  }

  private updatePaneLabel(
    subtask: Subtask,
    status: SubtaskStatus,
    startedAt?: number,
    latestChunk?: string,
  ): void {
    const paneIndex = this.subtaskToPane.get(subtask.id);
    if (paneIndex === undefined) return;
    const box = this.panes[paneIndex];

    const statusColors: Record<SubtaskStatus, string> = {
      pending: "gray",
      queued: "blue",
      running: "yellow",
      completed: "green",
      error: "red",
    };
    const statusIcons: Record<SubtaskStatus, string> = {
      pending: "○",
      queued: "…",
      running: "⟳",
      completed: "✓",
      error: "✗",
    };
    const statusColor = statusColors[status];
    const statusText = statusIcons[status];

    const snippet = latestChunk
      ? latestChunk.split(/\r?\n/).filter(Boolean).at(-1)
      : undefined;

    const duration = this.formatDuration(startedAt);
    const info = snippet ? ` • ${snippet.trim().slice(0, 40)}` : "";

    box.setLabel(
      ` {${statusColor}-fg}${statusText}{/} ${subtask.name} {gray-fg}(${duration})${info}{/} `,
    );
  }

  async startAllSubtasks(): Promise<void> {
    this.queuedSubtasks = [...this.state.subtasks];

    // Mark everything as queued initially
    this.queuedSubtasks.forEach((subtask) => {
      this.subtaskStatuses.set(subtask.id, "queued");
    });
    this.primaryBox.setContent(this.renderTaskTree());
    this.render();

    const runners = this.panes.map((_, paneIndex) =>
      this.runNextInPane(paneIndex),
    );
    await Promise.all(runners);
  }

  hasAnyErrors(): boolean {
    return this.hasErrors;
  }

  private async runNextInPane(paneIndex: number): Promise<void> {
    const next = this.queuedSubtasks.shift();
    if (!next) return;
    await this.runSubtaskInPane(next, paneIndex);
    return this.runNextInPane(paneIndex);
  }

  render(): void {
    this.screen.render();
  }

  cleanup(): void {
    // Kill all running processes
    this.processes.forEach((process) => {
      try {
        process.kill();
      } catch {
        // Ignore errors when killing processes
      }
    });
    this.processes.clear();
    this.screen.destroy();
  }
}
