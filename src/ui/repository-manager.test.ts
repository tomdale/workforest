import { afterEach, describe, expect, it, vi } from "vitest";

type FakeKeyHandler = (
  ch: string,
  key: { name?: string; ctrl?: boolean; shift?: boolean },
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
      boxes.push(this);
    }),
  };
});

import type { CachedRepository } from "../repositories.ts";
import {
  runRepositoryManager,
  shouldUseRepositoryManager,
} from "./repository-manager.ts";

const originalStdinIsTty = process.stdin.isTTY;
const stdoutDescriptors = {
  isTTY: Object.getOwnPropertyDescriptor(process.stdout, "isTTY"),
  columns: Object.getOwnPropertyDescriptor(process.stdout, "columns"),
  rows: Object.getOwnPropertyDescriptor(process.stdout, "rows"),
};

afterEach(() => {
  screens.splice(0);
  boxes.splice(0);
  vi.unstubAllEnvs();
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: originalStdinIsTty,
  });
  for (const [key, descriptor] of Object.entries(stdoutDescriptors)) {
    if (descriptor) Object.defineProperty(process.stdout, key, descriptor);
  }
});

describe("shouldUseRepositoryManager", () => {
  it("requires an adequately sized TTY", () => {
    stubTty({ stdin: true, stdout: true, columns: 100, rows: 30 });
    expect(shouldUseRepositoryManager()).toBe(true);

    stubTty({ stdin: true, stdout: false, columns: 100, rows: 30 });
    expect(shouldUseRepositoryManager()).toBe(false);

    stubTty({ stdin: true, stdout: true, columns: 79, rows: 30 });
    expect(shouldUseRepositoryManager()).toBe(false);
  });
});

describe("runRepositoryManager", () => {
  it("renders repository details and resolves update", async () => {
    const repository = cachedRepository();
    const promise = runRepositoryManager({
      repositories: [repository],
      cacheDir: "/tmp/cache",
    });

    await vi.waitFor(() => expect(screens.length).toBe(1));
    const content = boxes.map((box) => box.content).join("\n");
    expect(content).toContain("Repository cache");
    expect(content).toContain("1 cached");
    expect(content).toContain("vercel/front");
    expect(content).toContain("● Healthy");
    expect(content).toContain("git@github.com:vercel/front.git");
    expect(content).toContain("/tmp/workspaces/demo/front");
    expect(boxes.map((box) => box.label)).toContain(" Selected Repository ");
    expect(boxes.map((box) => box.label)).not.toContain(" Health and Actions ");

    screens[0]?.handlers["keypress"]?.("u", { name: "u" });

    await expect(promise).resolves.toEqual({
      type: "update",
      mirrorPath: repository.mirrorPath,
    });
    expect(screens[0]?.destroy).toHaveBeenCalled();
  });

  it("uses prune terminology for unused cache cleanup", async () => {
    const promise = runRepositoryManager({
      repositories: [cachedRepository()],
      cacheDir: "/tmp/cache",
    });

    await vi.waitFor(() => expect(screens.length).toBe(1));
    screens[0]?.handlers["keypress"]?.("?", { name: "?" });
    expect(boxes.map((box) => box.content).join("\n")).toContain(
      "prune unused",
    );

    screens[0]?.handlers["keypress"]?.("?", { name: "?" });
    screens[0]?.handlers["keypress"]?.("x", { name: "x" });
    await expect(promise).resolves.toEqual({ type: "prune" });
  });

  it("filters repositories before resolving delete", async () => {
    const front = cachedRepository();
    const api = cachedRepository({
      name: "api",
      slug: "vercel/api",
      remote: "git@github.com:vercel/api.git",
      mirrorPath: "/tmp/cache/api.git",
      directoryName: "api.git",
      worktrees: [],
    });
    const promise = runRepositoryManager({
      repositories: [front, api],
      cacheDir: "/tmp/cache",
    });

    await vi.waitFor(() => expect(screens.length).toBe(1));
    screens[0]?.handlers["keypress"]?.("/", { name: "/" });
    screens[0]?.handlers["keypress"]?.("a", { name: "a" });
    screens[0]?.handlers["keypress"]?.("p", { name: "p" });
    screens[0]?.handlers["keypress"]?.("i", { name: "i" });
    screens[0]?.handlers["keypress"]?.("\r", { name: "enter" });

    await expect(promise).resolves.toEqual({
      type: "info",
      mirrorPath: api.mirrorPath,
    });
  });

  it("uses the detail area for help and keeps safety guidance visible", async () => {
    const promise = runRepositoryManager({
      repositories: [cachedRepository()],
      cacheDir: "/tmp/cache",
    });

    await vi.waitFor(() => expect(screens.length).toBe(1));
    screens[0]?.handlers["keypress"]?.("?", { name: "?" });

    expect(boxes.map((box) => box.label)).toContain(" Keyboard Shortcuts ");
    const content = boxes.map((box) => box.content).join("\n");
    expect(content).toContain("search repositories");
    expect(content).toContain("Delete refuses mirrors with active worktrees");

    screens[0]?.handlers["keypress"]?.("q", { name: "q" });
    await expect(promise).resolves.toEqual({ type: "quit" });
  });
});

function cachedRepository(
  overrides: Partial<CachedRepository> = {},
): CachedRepository {
  return {
    name: "front",
    slug: "vercel/front",
    remote: "git@github.com:vercel/front.git",
    mirrorPath: "/tmp/cache/front.git",
    directoryName: "front.git",
    defaultBranch: "main",
    sizeBytes: 1024,
    lastFetchedAt: new Date("2026-06-10T12:00:00.000Z"),
    worktrees: [
      {
        path: "/tmp/workspaces/demo/front",
        branch: "tomdale/demo",
        detached: false,
        prunable: false,
        exists: true,
      },
    ],
    health: "healthy",
    issues: [],
    ...overrides,
  };
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
