export type DashboardRouteId =
  | "home"
  | "start"
  | "changes"
  | "tasks"
  | "templates"
  | "cache"
  | "reviews"
  | "config"
  | "help";

export type DashboardRoute = Readonly<{
  id: DashboardRouteId;
  title: string;
  description: string;
}>;

export type DashboardAction =
  | Readonly<{
      id: string;
      label: string;
      description: string;
      kind: "navigate";
      route: DashboardRouteId;
    }>
  | Readonly<{
      id: string;
      label: string;
      description: string;
      kind: "command";
      command: readonly string[];
      shellHandoff: boolean;
    }>;

export const DASHBOARD_ROUTES: readonly DashboardRoute[] = [
  {
    id: "home",
    title: "Dashboard",
    description: "Creation-first overview for changes and workspace activity.",
  },
  {
    id: "start",
    title: "Start",
    description:
      "Create a repository change, template workspace, adhoc workspace, or repeat the current context.",
  },
  {
    id: "changes",
    title: "Changes",
    description: "Inspect known repository changes and workspaces.",
  },
  {
    id: "tasks",
    title: "Tasks",
    description: "Inspect nested task worktrees for the current change.",
  },
  {
    id: "templates",
    title: "Templates",
    description: "Browse and manage workspace templates.",
  },
  {
    id: "cache",
    title: "Cache",
    description: "Inspect cached mirrors and repository health.",
  },
  {
    id: "reviews",
    title: "Reviews",
    description: "Open review workspaces and pull request worktrees.",
  },
  {
    id: "config",
    title: "Config",
    description: "Review resolved paths and edit Workforest configuration.",
  },
  {
    id: "help",
    title: "Help",
    description: "Read command help, concepts, workflow, and agent skills.",
  },
];

export const DASHBOARD_ACTIONS: readonly DashboardAction[] = [
  {
    id: "start.repository",
    label: "Repository change",
    description: "Create one change worktree for a single repository.",
    kind: "command",
    command: ["start", "<change>", "<repo>"],
    shellHandoff: true,
  },
  {
    id: "start.template",
    label: "Template workspace",
    description: "Create a workspace from a saved template.",
    kind: "command",
    command: ["start", "<change>", "@<template>"],
    shellHandoff: true,
  },
  {
    id: "start.adhoc",
    label: "Adhoc workspace",
    description: "Create a workspace from several repositories.",
    kind: "command",
    command: ["start", "<change>", "<repo...>"],
    shellHandoff: true,
  },
  {
    id: "changes.list",
    label: "List changes",
    description: "Show all known Workforest changes.",
    kind: "command",
    command: ["list"],
    shellHandoff: false,
  },
  {
    id: "tasks.list",
    label: "List tasks",
    description: "Show nested task worktrees for this change.",
    kind: "command",
    command: ["task", "list"],
    shellHandoff: false,
  },
  {
    id: "templates.screen",
    label: "Templates screen",
    description: "Open template management.",
    kind: "navigate",
    route: "templates",
  },
  {
    id: "cache.list",
    label: "Cache inventory",
    description: "Show cached mirror inventory.",
    kind: "command",
    command: ["cache", "list"],
    shellHandoff: false,
  },
  {
    id: "reviews.open",
    label: "Review workspace",
    description: "Open a repository review workspace.",
    kind: "command",
    command: ["review", "open", "<repo>"],
    shellHandoff: true,
  },
  {
    id: "config.screen",
    label: "Config screen",
    description: "Review and edit configuration.",
    kind: "navigate",
    route: "config",
  },
];

const ROUTES_BY_ID = new Map(
  DASHBOARD_ROUTES.map((route) => [route.id, route]),
);

export function getDashboardRoute(id: DashboardRouteId): DashboardRoute {
  const route = ROUTES_BY_ID.get(id);
  if (!route) {
    throw new Error(`Unknown dashboard route: ${id}`);
  }
  return route;
}

export function dashboardRouteForInvocation(
  invokedPath: readonly string[],
): DashboardRoute {
  const token = invokedPath[0];
  switch (token) {
    case "start":
      return getDashboardRoute("start");
    case "templates":
      return getDashboardRoute("templates");
    case "tasks":
      return getDashboardRoute("tasks");
    case "reviews":
      return getDashboardRoute("reviews");
    case "cache":
      return getDashboardRoute("cache");
    case "config":
      return getDashboardRoute("config");
    default:
      return getDashboardRoute("home");
  }
}

export function dashboardActionsForRoute(
  route: DashboardRoute,
): readonly DashboardAction[] {
  switch (route.id) {
    case "start":
      return DASHBOARD_ACTIONS.filter((action) =>
        action.id.startsWith("start."),
      );
    case "changes":
      return DASHBOARD_ACTIONS.filter((action) =>
        action.id.startsWith("changes."),
      );
    case "tasks":
      return DASHBOARD_ACTIONS.filter((action) =>
        action.id.startsWith("tasks."),
      );
    case "templates":
      return DASHBOARD_ACTIONS.filter((action) =>
        action.id.startsWith("templates."),
      );
    case "cache":
      return DASHBOARD_ACTIONS.filter((action) =>
        action.id.startsWith("cache."),
      );
    case "reviews":
      return DASHBOARD_ACTIONS.filter((action) =>
        action.id.startsWith("reviews."),
      );
    case "config":
      return DASHBOARD_ACTIONS.filter((action) =>
        action.id.startsWith("config."),
      );
    case "help":
      return [];
    case "home":
      return DASHBOARD_ACTIONS;
  }
}

export function formatDashboardCommand(command: readonly string[]): string {
  return `wf ${command.join(" ")}`;
}
