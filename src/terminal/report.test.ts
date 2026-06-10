import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { renderReport } from "./report.ts";

describe("renderReport", () => {
  it("renders headings, aligned fields, entries, and a footer", () => {
    const output = stripAnsi(
      renderReport({
        title: "Workspaces",
        sections: [
          {
            entries: [
              {
                title: "fix-auth",
                description: "Repair sign-in",
                details: [
                  { label: "Repositories", value: "2" },
                  { label: "Branch", value: "tomdale/fix-auth" },
                ],
              },
            ],
          },
        ],
        footer: "Directory: /tmp/workspaces\n1 workspace",
      }),
    );

    expect(output).toBe(
      [
        "Workspaces",
        "",
        "  fix-auth - Repair sign-in",
        "    Repositories: 2",
        "    Branch:       tomdale/fix-auth",
        "",
        "Directory: /tmp/workspaces",
        "1 workspace",
      ].join("\n"),
    );
  });
});
