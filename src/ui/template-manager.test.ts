import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type FakeKeyHandler = (
  ch: string,
  key: { name?: string; ctrl?: boolean },
) => void;

type FakeScreen = {
  handlers: Record<string, FakeKeyHandler>;
  render: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  width: number;
  height: number;
};

type FakeBox = {
  content: string;
  label: string;
  width: number;
  height: number;
  setContent: ReturnType<typeof vi.fn>;
  setLabel: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};

const screens = vi.hoisted(() => [] as FakeScreen[]);
const boxes = vi.hoisted(() => [] as FakeBox[]);

vi.mock("@unblessed/node", () => {
  function resolveDimension(value: unknown, total: number): number {
    if (typeof value === "number") return value;
    if (typeof value !== "string") return total;

    const match = value.match(/^(\d+)%(?:([+-])(\d+))?$/);
    if (!match?.[1]) return Number.parseInt(value, 10) || total;

    const base = Math.floor((Number.parseInt(match[1], 10) / 100) * total);
    if (match[2] && match[3]) {
      const offset = Number.parseInt(match[3], 10);
      return match[2] === "+" ? base + offset : base - offset;
    }
    return base;
  }

  return {
    setRuntime: vi.fn(),
    NodeRuntime: vi.fn(),
    Screen: vi.fn().mockImplementation(function (
      this: FakeScreen,
      options: { width?: number; height?: number } = {},
    ) {
      this.handlers = {};
      this.render = vi.fn();
      this.destroy = vi.fn();
      this.width = options.width ?? 120;
      this.height = options.height ?? 40;
      this["on" as keyof FakeScreen] = vi.fn(
        (event: string, handler: FakeKeyHandler) => {
          this.handlers[event] = handler;
        },
      ) as never;
      screens.push(this);
    }),
    Box: vi.fn().mockImplementation(function (
      this: FakeBox,
      options: { label?: string; width?: unknown; height?: unknown } = {},
    ) {
      this.content = "";
      this.label = options.label ?? "";
      this.width = resolveDimension(options.width, 120);
      this.height = resolveDimension(options.height, 40);
      this.setContent = vi.fn((content: string) => {
        this.content = content;
      });
      this.setLabel = vi.fn((label: string) => {
        this.label = label;
      });
      this.destroy = vi.fn();
      boxes.push(this);
    }),
  };
});

import { createTemplate, loadTemplate } from "../templates/index.ts";
import {
  runTemplateManager,
  shouldUseTemplateManager,
} from "./template-manager.ts";

const ORIGINAL_XDG_CONFIG_HOME = process.env["XDG_CONFIG_HOME"];
const ORIGINAL_STDIN_IS_TTY = process.stdin.isTTY;
const stdoutDescriptors = {
  isTTY: Object.getOwnPropertyDescriptor(process.stdout, "isTTY"),
  columns: Object.getOwnPropertyDescriptor(process.stdout, "columns"),
  rows: Object.getOwnPropertyDescriptor(process.stdout, "rows"),
};

const tempDirs: string[] = [];

afterEach(async () => {
  screens.splice(0);
  boxes.splice(0);
  vi.unstubAllEnvs();

  if (ORIGINAL_XDG_CONFIG_HOME === undefined) {
    delete process.env["XDG_CONFIG_HOME"];
  } else {
    process.env["XDG_CONFIG_HOME"] = ORIGINAL_XDG_CONFIG_HOME;
  }

  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: ORIGINAL_STDIN_IS_TTY,
  });

  for (const [key, descriptor] of Object.entries(stdoutDescriptors)) {
    if (descriptor) {
      Object.defineProperty(process.stdout, key, descriptor);
    }
  }

  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("shouldUseTemplateManager", () => {
  it("requires an adequately sized TTY", () => {
    stubTty({ stdin: true, stdout: true, columns: 100, rows: 30 });
    expect(shouldUseTemplateManager()).toBe(true);

    stubTty({ stdin: true, stdout: false, columns: 100, rows: 30 });
    expect(shouldUseTemplateManager()).toBe(false);

    stubTty({ stdin: true, stdout: true, columns: 79, rows: 30 });
    expect(shouldUseTemplateManager()).toBe(false);

    stubTty({ stdin: true, stdout: true, columns: 100, rows: 19 });
    expect(shouldUseTemplateManager()).toBe(false);
  });
});

describe("runTemplateManager", () => {
  it("renders template details and resolves edit for enter", async () => {
    const xdgConfigHome = await createTempDir("workforest-template-manager-");
    process.env["XDG_CONFIG_HOME"] = xdgConfigHome;
    await createTemplate("demo", {
      repos: ["vercel/front", "vercel/api"],
      description: "Demo template",
      branchPrefix: "tomdale/",
      hooks: [{ name: "Build", run: "pnpm build" }],
    });
    await mkdir(
      path.join(
        xdgConfigHome,
        "workforest",
        "templates",
        "demo",
        "files",
        "front",
      ),
      { recursive: true },
    );
    await writeFile(
      path.join(
        xdgConfigHome,
        "workforest",
        "templates",
        "demo",
        "files",
        "front",
        ".env.local",
      ),
      "FEATURE_FLAG=1\n",
      "utf8",
    );

    const template = await loadTemplate("demo");
    expect(template).not.toBeNull();

    const promise = runTemplateManager({
      templates: template ? [template] : [],
      templatesDir: path.join(xdgConfigHome, "workforest", "templates"),
      workspaceConfig: { branchPrefix: "tomdale/" },
    });

    await vi.waitFor(() => expect(screens.length).toBe(1));
    expect(boxes.map((box) => box.content).join("\n")).toContain(
      "Demo template",
    );
    expect(boxes.map((box) => box.content).join("\n")).toContain(
      "front/.env.local",
    );

    screens[0]?.handlers["keypress"]?.("\r", { name: "enter" });

    await expect(promise).resolves.toEqual({
      type: "edit",
      templateId: "demo",
    });
    expect(screens[0]?.destroy).toHaveBeenCalled();
  });

  it("filters templates before resolving the selected action", async () => {
    const xdgConfigHome = await createTempDir("workforest-template-manager-");
    process.env["XDG_CONFIG_HOME"] = xdgConfigHome;
    await createTemplate("front", {
      repos: ["vercel/front"],
      description: "Frontend",
    });
    await createTemplate("api", {
      repos: ["vercel/api"],
      description: "Backend",
    });

    const templates = [
      await loadTemplate("front"),
      await loadTemplate("api"),
    ].filter((template) => template !== null);

    const promise = runTemplateManager({
      templates,
      templatesDir: path.join(xdgConfigHome, "workforest", "templates"),
    });

    await vi.waitFor(() => expect(screens.length).toBe(1));
    const keypress = screens[0]?.handlers["keypress"];
    keypress?.("/", { name: "/" });
    keypress?.("a", { name: "a" });
    keypress?.("p", { name: "p" });
    keypress?.("i", { name: "i" });
    keypress?.("\r", { name: "enter" });

    await expect(promise).resolves.toEqual({
      type: "edit",
      templateId: "api",
    });
  });

  it("resolves create from an empty manager", async () => {
    const promise = runTemplateManager({
      templates: [],
      templatesDir: "/tmp/workforest/templates",
    });

    await vi.waitFor(() => expect(screens.length).toBe(1));
    screens[0]?.handlers["keypress"]?.("n", { name: "n" });

    await expect(promise).resolves.toEqual({ type: "create" });
  });
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function stubTty({
  stdin,
  stdout,
  columns,
  rows,
}: {
  stdin: boolean;
  stdout: boolean;
  columns: number;
  rows: number;
}): void {
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: stdin,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: stdout,
  });
  Object.defineProperty(process.stdout, "columns", {
    configurable: true,
    value: columns,
  });
  Object.defineProperty(process.stdout, "rows", {
    configurable: true,
    value: rows,
  });
}
