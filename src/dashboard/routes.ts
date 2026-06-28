export type DashboardRouteId =
  | "home"
  | "new"
  | "list"
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
    }>;

export const DASHBOARD_ROUTES: readonly DashboardRoute[] = [
  {
    id: "home",
    title: "Dashboard",
    description:
      "Creation-first overview of worktrees, workspaces, and activity.",
  },
  {
    id: "new",
    title: "New",
    description:
      "Create a worktree, template workspace, adhoc workspace, or repeat the current context.",
  },
  {
    id: "list",
    title: "List",
    description: "Inspect known worktrees and workspaces.",
  },
  {
    id: "tasks",
    title: "Tasks",
    description:
      "Inspect nested task worktrees for the current worktree or workspace.",
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
    id: "home.new",
    label: "New worktree or workspace",
    description: "Open the creation flow.",
    kind: "navigate",
    route: "new",
  },
  {
    id: "home.list",
    label: "Review worktrees & workspaces",
    description: "Inspect active worktrees and workspaces.",
    kind: "navigate",
    route: "list",
  },
  {
    id: "home.tasks",
    label: "Review tasks",
    description:
      "Inspect nested task worktrees for the current worktree or workspace.",
    kind: "navigate",
    route: "tasks",
  },
  {
    id: "home.templates",
    label: "Manage templates",
    description: "Open the Templates dashboard screen.",
    kind: "navigate",
    route: "templates",
  },
  {
    id: "home.cache",
    label: "Inspect cache",
    description: "Open the Cache dashboard screen.",
    kind: "navigate",
    route: "cache",
  },
  {
    id: "home.reviews",
    label: "Open reviews",
    description: "Open the Reviews dashboard screen.",
    kind: "navigate",
    route: "reviews",
  },
  {
    id: "home.config",
    label: "Edit config",
    description: "Open the Config dashboard screen.",
    kind: "navigate",
    route: "config",
  },
  {
    id: "new.worktree",
    label: "Worktree",
    description: "Create one worktree for a single repository.",
    kind: "command",
    command: ["new", "<name>", "<repo>"],
  },
  {
    id: "new.template",
    label: "Template workspace",
    description: "Create a workspace from a saved template.",
    kind: "command",
    command: ["new", "<name>", "@<template>"],
  },
  {
    id: "new.adhoc",
    label: "Adhoc workspace",
    description: "Create a workspace from several repositories.",
    kind: "command",
    command: ["new", "<name>", "<repo...>"],
  },
  {
    id: "list.all",
    label: "List worktrees & workspaces",
    description: "Show everything Workforest manages.",
    kind: "command",
    command: ["list"],
  },
  {
    id: "tasks.list",
    label: "List tasks",
    description: "Show nested task worktrees for this worktree or workspace.",
    kind: "command",
    command: ["task", "list"],
  },
  {
    id: "tasks.new",
    label: "New task",
    description: "Create one nested task worktree.",
    kind: "command",
    command: ["task", "new", "<task>"],
  },
  {
    id: "tasks.delete",
    label: "Delete task",
    description: "Remove a task after its branch is integrated.",
    kind: "command",
    command: ["task", "delete", "<task>"],
  },
  {
    id: "templates.screen",
    label: "Templates dashboard",
    description: "Open the dashboard-native templates screen.",
    kind: "command",
    command: ["templates"],
  },
  {
    id: "templates.list",
    label: "List templates",
    description: "Show saved workspace templates.",
    kind: "command",
    command: ["template", "list"],
  },
  {
    id: "templates.new",
    label: "New template",
    description: "Create a workspace template from repositories.",
    kind: "command",
    command: ["template", "new"],
  },
  {
    id: "cache.list",
    label: "Cache inventory",
    description: "Show cached mirror inventory.",
    kind: "command",
    command: ["cache", "list"],
  },
  {
    id: "cache.doctor",
    label: "Cache health",
    description: "Diagnose cached mirrors for integrity problems.",
    kind: "command",
    command: ["cache", "doctor"],
  },
  {
    id: "cache.sync",
    label: "Sync mirrors",
    description: "Fetch updates for selected or all cached mirrors.",
    kind: "command",
    command: ["cache", "sync"],
  },
  {
    id: "reviews.open",
    label: "Review workspace",
    description: "Open a repository review workspace.",
    kind: "command",
    command: ["review", "open", "<repo>"],
  },
  {
    id: "reviews.checkout",
    label: "Checkout PR",
    description: "Add a pull request worktree inside a review workspace.",
    kind: "command",
    command: ["review", "checkout", "<repo>#<number>"],
  },
  {
    id: "config.screen",
    label: "Show config",
    description: "Print resolved configuration and paths.",
    kind: "command",
    command: ["config", "show"],
  },
  {
    id: "config.init",
    label: "Initialize config",
    description: "Configure checkout directories and branch prefix.",
    kind: "command",
    command: ["config", "init"],
  },
  {
    id: "config.edit",
    label: "External editor",
    description: "Open config.json in the configured editor.",
    kind: "command",
    command: ["config", "edit"],
  },
  {
    id: "help.overview",
    label: "Overview help",
    description: "Show the Workforest command overview.",
    kind: "command",
    command: ["help"],
  },
  {
    id: "help.workflow",
    label: "Workflow guide",
    description: "Show recommended workflows for users and agents.",
    kind: "command",
    command: ["help", "workflow"],
  },
  {
    id: "help.skills",
    label: "Agent skill",
    description: "Print the bundled core agent skill.",
    kind: "command",
    command: ["skills", "get", "core"],
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
    case "new":
      return getDashboardRoute("new");
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
    case "new":
      return DASHBOARD_ACTIONS.filter((action) => action.id.startsWith("new."));
    case "list":
      return DASHBOARD_ACTIONS.filter((action) =>
        action.id.startsWith("list."),
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
      return DASHBOARD_ACTIONS.filter((action) =>
        action.id.startsWith("help."),
      );
    case "home":
      return DASHBOARD_ACTIONS;
  }
}

export function formatDashboardCommand(command: readonly string[]): string {
  return `wf ${command.join(" ")}`;
}
