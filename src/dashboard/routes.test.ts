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
    [["new"], "new"],
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
      dashboardActionsForRoute(getDashboardRoute("new")).map(
        (action) => action.id,
      ),
    ).toEqual(["new.worktree", "new.template", "new.adhoc"]);

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
    expect(formatDashboardCommand(["new", "<name>", "<repo>"])).toBe(
      "wf new <name> <repo>",
    );
  });
});
