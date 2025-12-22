#!/usr/bin/env node
import { type Subtask, TerminalUI } from "./terminal.ts";

/**
 * Demo of the TerminalUI
 *
 * Run with: pnpm tsx src/ui/demo.ts
 */
async function main() {
  const subtasks: Subtask[] = [
    {
      id: "subtask-1",
      name: "Clone repo A",
      command: "sh",
      args: [
        "-c",
        "echo 'Cloning repository A...'; for i in 1 2 3; do echo '  Fetching objects: $i/3'; sleep 0.35; done; echo 'Repository A cloned successfully'",
      ],
    },
    {
      id: "subtask-2",
      name: "Install deps A",
      command: "sh",
      args: [
        "-c",
        "echo 'Installing dependencies for A...'; for i in 1 2 3 4 5; do echo '  Installing package $i/5'; sleep 0.35; done; echo 'Dependencies for A installed'",
      ],
    },
    {
      id: "subtask-3",
      name: "Build A",
      command: "sh",
      args: [
        "-c",
        "echo 'Building project A...'; for i in A B C D; do echo '  Compiling module $i'; sleep 0.25; done; echo 'Build A complete'",
      ],
    },
    {
      id: "subtask-4",
      name: "Clone repo B",
      command: "sh",
      args: [
        "-c",
        "echo 'Cloning repository B...'; for i in 1 2 3 4; do echo '  Fetching objects: $i/4'; sleep 0.3; done; echo 'Repository B cloned successfully'",
      ],
    },
    {
      id: "subtask-5",
      name: "Install deps B",
      command: "sh",
      args: [
        "-c",
        "echo 'Installing dependencies for B...'; for i in 1 2 3 4; do echo '  Installing package $i/4'; sleep 0.4; done; echo 'Dependencies for B installed'",
      ],
    },
    {
      id: "subtask-6",
      name: "Build B (fails)",
      command: "sh",
      args: [
        "-c",
        "echo 'Building project B...'; for i in 1 2; do echo '  Compiling module $i'; sleep 0.4; done; echo 'Link error: missing symbol'; exit 1",
      ],
    },
  ];

  const ui = new TerminalUI({
    primaryTask: "Initializing workspace...",
    subtasks,
    maxConcurrent: 3,
  });

  // Update primary task dynamically
  setTimeout(() => {
    ui.updatePrimaryTask("Preparing repositories...");
  }, 1000);

  setTimeout(() => {
    ui.updatePrimaryTask("Running concurrent tasks...");
  }, 3000);

  // Start all subtasks concurrently
  try {
    await ui.startAllSubtasks();
    if (ui.hasAnyErrors()) {
      ui.updatePrimaryTask("✗ Some tasks failed");
    } else {
      ui.updatePrimaryTask("✓ All tasks completed successfully!");
    }

    // Keep UI alive for a few seconds to see results
    setTimeout(() => {
      ui.cleanup();
      process.exit(0);
    }, 2000);
  } catch (error) {
    ui.updatePrimaryTask("✗ Some tasks failed");
    console.error(error);
    setTimeout(() => {
      ui.cleanup();
      process.exit(1);
    }, 2000);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
