import { describe, expect, it } from "vitest";
import { filterFuzzySelectOptions } from "./fuzzy-select.ts";

describe("filterFuzzySelectOptions", () => {
  const options = [
    { label: "wf-fix-auth", value: "/workspaces/wf-fix-auth" },
    {
      label: "wf-billing-ui",
      hint: "2 repos (frontend)",
      value: "/workspaces/wf-billing-ui",
    },
    {
      label: "wf-docs",
      hint: "1 repo (documentation)",
      value: "/workspaces/wf-docs",
    },
  ];

  it("returns all options for an empty query", () => {
    expect(filterFuzzySelectOptions(options, "")).toEqual(options);
  });

  it("matches labels case-insensitively", () => {
    expect(filterFuzzySelectOptions(options, "BILLING")).toEqual([options[1]]);
  });

  it("matches hints case-insensitively", () => {
    expect(filterFuzzySelectOptions(options, "documentation")).toEqual([
      options[2],
    ]);
  });

  it("returns no options when nothing matches", () => {
    expect(filterFuzzySelectOptions(options, "payments")).toEqual([]);
  });
});
