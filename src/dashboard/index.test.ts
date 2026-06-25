import { describe, expect, it } from "vitest";
import {
  createDashboardState,
  dashboardLayoutForSize,
  getDashboardRoute,
  moveDashboardAction,
  moveDashboardRoute,
  openDashboardPalette,
  renderDashboardReport,
  selectDashboardAction,
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

  it("selects wide and compact dashboard layouts from terminal size", () => {
    expect(dashboardLayoutForSize(120, 40)).toBe("wide");
    expect(dashboardLayoutForSize(90, 40)).toBe("compact");
    expect(dashboardLayoutForSize(120, 24)).toBe("compact");
  });

  it("moves between routes and route-specific actions", () => {
    const state = createDashboardState(getDashboardRoute("home"));
    const start = moveDashboardRoute(state, 1);
    const secondAction = moveDashboardAction(start, 1);

    expect(start.routeIndex).toBe(1);
    expect(start.actionIndex).toBe(0);
    expect(secondAction.actionIndex).toBe(1);
  });

  it("uses Enter to navigate or stage command actions", () => {
    const home = createDashboardState(getDashboardRoute("home"));
    const openedStart = selectDashboardAction(home);
    const startCommand = selectDashboardAction(openedStart);

    expect(openedStart.routeIndex).toBe(1);
    expect(openedStart.operationMessage).toBe("Opened Start");
    expect(startCommand.operationMessage).toContain("wf start <change> <repo>");
  });

  it("uses the palette as a global action selector", () => {
    const state = openDashboardPalette(
      createDashboardState(getDashboardRoute("home")),
    );
    const selected = selectDashboardAction(moveDashboardAction(state, 4));

    expect(selected.paletteOpen).toBe(false);
    expect(selected.operationMessage).toBe("Opened Cache");
  });

  it("renders a plain dashboard fallback report", () => {
    const report = renderDashboardReport(getDashboardRoute("templates"));

    expect(report).toContain("Workforest Templates");
    expect(report).toContain("Open manager");
    expect(report).toContain("Operations");
    expect(report).toContain("Interactive dashboard opens in a capable TTY");
  });
});
