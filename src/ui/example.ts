import { type Subtask, TerminalUI } from "./terminal.ts";

/**
 * Example usage of the TerminalUI
 *
 * This demonstrates how to create a terminal UI with:
 * - A primary task displayed at the top (1/3 of screen)
 * - Three subtasks running concurrently in virtual terminal windows (bottom 2/3)
 * - Each subtask streams stdout/stderr output in real-time
 */
async function _example() {
  const subtasks: Subtask[] = [
    {
      id: "subtask-1",
      name: "Repository Setup",
      command: "git",
      args: ["clone", "https://github.com/vercel/next.js.git", "/tmp/next.js"],
      cwd: "/tmp",
    },
    {
      id: "subtask-2",
      name: "Install Dependencies",
      command: "npm",
      args: ["install"],
      cwd: "/tmp/next.js",
    },
    {
      id: "subtask-3",
      name: "Build Project",
      command: "npm",
      args: ["run", "build"],
      cwd: "/tmp/next.js",
    },
  ];

  const ui = new TerminalUI({
    primaryTask: "Setting up workspace...",
    subtasks,
  });

  // Update primary task
  setTimeout(() => {
    ui.updatePrimaryTask("Preparing repositories...");
  }, 2000);

  setTimeout(() => {
    ui.updatePrimaryTask("Installing dependencies...");
  }, 5000);

  // Start all subtasks concurrently
  try {
    await ui.startAllSubtasks();
    ui.updatePrimaryTask("✓ All tasks completed!");
  } catch (error) {
    ui.updatePrimaryTask("✗ Some tasks failed");
    console.error(error);
  }

  // Keep UI alive for a few seconds to see results
  setTimeout(() => {
    ui.cleanup();
    process.exit(0);
  }, 10000);
}

// Uncomment to run example:
// example().catch(console.error);
