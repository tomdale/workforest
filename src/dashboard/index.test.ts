import { describe, expect, it } from "vitest";
import {
  activateDashboardAction,
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

  it("uses Enter to navigate or mark commands that still need operands", () => {
    const home = createDashboardState(getDashboardRoute("home"));
    const openedStart = selectDashboardAction(home);
    const startCommand = activateDashboardAction(openedStart);

    expect(openedStart.routeIndex).toBe(1);
    expect(openedStart.operationMessage).toBe("Opened Start");
    expect(startCommand.command).toBeNull();
    expect(startCommand.state.operationMessage).toBe(
      "wf start <change> <repo> needs operands before it can run",
    );
  });

  it.each([
    ["changes", 0, ["list"], "wf list"],
    ["cache", 1, ["cache", "doctor"], "wf cache doctor"],
    ["config", 0, ["config", "show"], "wf config show"],
    ["help", 1, ["help", "workflow"], "wf help workflow"],
    ["help", 2, ["skills", "get", "core"], "wf skills get core"],
  ] as const)("returns %s dashboard command actions for CLI execution", (routeId, actionOffset, command, displayCommand) => {
    let state = createDashboardState(getDashboardRoute(routeId));
    for (let count = 0; count < actionOffset; count += 1) {
      state = moveDashboardAction(state, 1);
    }

    const selected = activateDashboardAction(state);

    expect(selected.command).toEqual(command);
    expect(selected.state.operationMessage).toBe(
      `Exiting to run ${displayCommand}`,
    );
  });

  it("keeps dashboard shortcut actions inside the dashboard", () => {
    const selected = activateDashboardAction(
      createDashboardState(getDashboardRoute("templates")),
    );

    expect(selected.command).toBeNull();
    expect(selected.state.routeIndex).toBe(4);
    expect(selected.state.operationMessage).toBe("Opened Templates");
  });

  it("uses the palette as a global action selector", () => {
    const state = openDashboardPalette(
      createDashboardState(getDashboardRoute("home")),
    );
    const selected = selectDashboardAction(moveDashboardAction(state, 4));

    expect(selected.paletteOpen).toBe(false);
    expect(selected.operationMessage).toBe("Opened Cache");
  });

  it("renders the selected route and its actions in the fallback report", () => {
    const report = renderDashboardReport(getDashboardRoute("templates"));
    const lines = report.split("\n");

    expect(lines[0]).toBe("Workforest Templates");
    expect(report).toContain("Route");
    expect(report).toContain("Actions");
    expect(report).toContain("wf templates");
    expect(report).toContain("wf template new");
  });
});
