import { describe, expect, it } from "vitest";
import {
  dashboardActionsForRoute,
  dashboardRouteForInvocation,
  formatDashboardCommand,
  getDashboardRoute,
} from "./routes.ts";

describe("dashboard routes", () => {
  it.each([
    [["dashboard"], "home"],
    [["start"], "start"],
    [["templates"], "templates"],
    [["tasks"], "tasks"],
    [["reviews"], "reviews"],
    [["cache"], "cache"],
    [["config"], "config"],
  ])("maps invocation %j to route %s", (invokedPath, routeId) => {
    expect(dashboardRouteForInvocation(invokedPath).id).toBe(routeId);
  });

  it("exposes route-specific action models", () => {
    expect(
      dashboardActionsForRoute(getDashboardRoute("start")).map(
        (action) => action.id,
      ),
    ).toEqual(["start.repository", "start.template", "start.adhoc"]);

    expect(
      dashboardActionsForRoute(getDashboardRoute("cache")).map(
        (action) => action.id,
      ),
    ).toEqual(["cache.list", "cache.doctor", "cache.sync"]);

    expect(
      dashboardActionsForRoute(getDashboardRoute("help")).map(
        (action) => action.id,
      ),
    ).toEqual(["help.overview", "help.workflow", "help.skills"]);
  });

  it("formats command actions for display", () => {
    expect(formatDashboardCommand(["start", "<change>", "<repo>"])).toBe(
      "wf start <change> <repo>",
    );
  });
});
