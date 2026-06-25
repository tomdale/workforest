import { describe, expect, it } from "vitest";
import {
  getDashboardRoute,
  renderDashboardReport,
  shouldUseDashboardTui,
} from "./index.ts";

describe("dashboard rendering", () => {
  it("requires a capable TTY and honors dashboard-disabling env vars", () => {
    const tty = {
      stdin: { isTTY: true },
      stdout: { isTTY: true, columns: 120, rows: 40 },
      env: {},
    };

    expect(shouldUseDashboardTui(tty)).toBe(true);
    expect(
      shouldUseDashboardTui({
        ...tty,
        env: { WORKFOREST_NO_TUI: "1" },
      }),
    ).toBe(false);
    expect(
      shouldUseDashboardTui({
        ...tty,
        stdout: { isTTY: false, columns: 120, rows: 40 },
      }),
    ).toBe(false);
    expect(
      shouldUseDashboardTui({
        ...tty,
        stdout: { isTTY: true, columns: 79, rows: 40 },
      }),
    ).toBe(false);
  });

  it("renders a plain dashboard fallback report", () => {
    const report = renderDashboardReport(getDashboardRoute("templates"));

    expect(report).toContain("Workforest Templates");
    expect(report).toContain("Templates screen");
    expect(report).toContain("Interactive dashboard opens in a capable TTY");
  });
});
