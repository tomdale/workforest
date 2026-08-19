import { describe, expect, it } from "vitest";
import type { TaskState } from "@wf-plugin/core";
import { PnpmNdjsonAdapter } from "./pnpm-ndjson.ts";

function collect(adapter: PnpmNdjsonAdapter, states: TaskState[]): TaskState[] {
  return states.flatMap((state) => [...adapter.push(state)]);
}

describe("PnpmNdjsonAdapter", () => {
  it("preserves output source while deriving progress", () => {
    const states = collect(new PnpmNdjsonAdapter(), [
      {
        status: "output",
        source: "stdout",
        data: '{"name":"pnpm:progress","current":12,"total":40,"status":"resolved"}\n',
      },
    ]);

    expect(states).toEqual([
      {
        status: "output",
        source: "stdout",
        format: "ndjson",
        data: '{"name":"pnpm:progress","current":12,"total":40,"status":"resolved"}\n',
      },
      {
        status: "progress",
        progress: { current: 12, total: 40, message: "pnpm resolved" },
      },
    ]);
  });

  it("preserves non-NDJSON output and stderr unchanged", () => {
    const adapter = new PnpmNdjsonAdapter();
    expect(
      collect(adapter, [
        { status: "output", source: "stdout", data: "plain output\n" },
        { status: "output", source: "stderr", data: "warning\n" },
      ]),
    ).toEqual([
      {
        status: "output",
        source: "stdout",
        data: "plain output\n",
      },
      { status: "output", source: "stderr", data: "warning\n" },
    ]);
  });
});
