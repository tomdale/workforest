import { Box } from "@unblessed/node";
import {
  isEnvironmentVariableSet,
  STANDARD_ENVIRONMENT_VARIABLES,
  WORKFOREST_ENVIRONMENT_VARIABLES,
} from "../environment.ts";
import { escapeBlessedTags } from "../terminal/command-stream-adapter.ts";
import {
  createFullscreenScreen,
  FULLSCREEN_QUIT_KEYS,
} from "../terminal/fullscreen-surface.ts";
import { renderReport } from "../terminal/report.ts";
import { fullscreenColor } from "../terminal/theme.ts";
import {
  DASHBOARD_ROUTES,
  type DashboardAction,
  type DashboardRoute,
  dashboardActionsForRoute,
  formatDashboardCommand,
} from "./routes.ts";

export {
  DASHBOARD_ACTIONS,
  DASHBOARD_ROUTES,
  type DashboardAction,
  type DashboardRoute,
  type DashboardRouteId,
  dashboardActionsForRoute,
  dashboardRouteForInvocation,
  formatDashboardCommand,
  getDashboardRoute,
} from "./routes.ts";

type DashboardTerminal = Readonly<{
  stdin: Pick<NodeJS.ReadStream, "isTTY">;
  stdout: Pick<NodeJS.WriteStream, "columns" | "isTTY" | "rows">;
  env: NodeJS.ProcessEnv;
}>;

const MIN_DASHBOARD_COLUMNS = 80;
const MIN_DASHBOARD_ROWS = 20;

export function shouldUseDashboardTui(
  terminal: DashboardTerminal = {
    stdin: process.stdin,
    stdout: process.stdout,
    env: process.env,
  },
): boolean {
  if (!terminal.stdin.isTTY || !terminal.stdout.isTTY) return false;
  if (
    isEnvironmentVariableSet(STANDARD_ENVIRONMENT_VARIABLES.ci, terminal.env) ||
    isEnvironmentVariableSet(
      WORKFOREST_ENVIRONMENT_VARIABLES.noTui,
      terminal.env,
    )
  ) {
    return false;
  }

  const columns = terminal.stdout.columns ?? 80;
  const rows = terminal.stdout.rows ?? 24;
  return columns >= MIN_DASHBOARD_COLUMNS && rows >= MIN_DASHBOARD_ROWS;
}

export function renderDashboardReport(route: DashboardRoute): string {
  const actions = dashboardActionsForRoute(route);
  return renderReport({
    title: `Workforest ${route.title}`,
    sections: [
      {
        title: "Route",
        fields: [
          { label: "Screen", value: route.title },
          { label: "Purpose", value: route.description },
        ],
      },
      {
        title: "Actions",
        entries:
          actions.length === 0
            ? [
                {
                  title: "No actions yet",
                  description:
                    "This dashboard screen will be expanded in the next dashboard milestone.",
                },
              ]
            : actions.map((action) => ({
                title: action.label,
                description: action.description,
                details: actionDetails(action),
              })),
      },
    ],
    footer:
      "Interactive dashboard opens in a capable TTY. Use explicit wf commands for scripts.",
  });
}

export async function runDashboardTui(route: DashboardRoute): Promise<void> {
  return new Promise((resolve) => {
    const screen = createFullscreenScreen();
    const sidebar = new Box({
      parent: screen,
      top: 0,
      left: 0,
      width: 24,
      height: "100%-1",
      border: { type: "line" },
      label: " Workforest ",
      tags: true,
      padding: { left: 1, top: 1 },
      style: {
        border: { fg: fullscreenColor.accent },
      },
    });
    const workbench = new Box({
      parent: screen,
      top: 0,
      left: 24,
      width: "55%-24",
      height: "100%-1",
      border: { type: "line" },
      label: ` ${route.title} `,
      tags: true,
      padding: { left: 1, top: 1 },
      style: {
        border: { fg: fullscreenColor.accent },
      },
    });
    const inspector = new Box({
      parent: screen,
      top: 0,
      right: 0,
      width: "45%",
      height: "100%-1",
      border: { type: "line" },
      label: " Inspector ",
      tags: true,
      padding: { left: 1, top: 1 },
      style: {
        border: { fg: fullscreenColor.muted },
      },
    });
    const footer = new Box({
      parent: screen,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 1,
      tags: true,
      padding: { left: 1 },
      style: { fg: fullscreenColor.muted },
    });

    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      screen.destroy();
      resolve();
    };

    screen.key([...FULLSCREEN_QUIT_KEYS], finish);

    renderDashboardScreen({ route, sidebar, workbench, inspector, footer });
    screen.render();
  });
}

function renderDashboardScreen({
  route,
  sidebar,
  workbench,
  inspector,
  footer,
}: Readonly<{
  route: DashboardRoute;
  sidebar: Box;
  workbench: Box;
  inspector: Box;
  footer: Box;
}>): void {
  const actions = dashboardActionsForRoute(route);
  sidebar.setContent(renderSidebar(route));
  workbench.setContent(renderWorkbench(route, actions));
  inspector.setContent(renderInspector(route, actions));
  footer.setContent("q quit  Esc quit  Ctrl-C cancel");
}

function renderSidebar(route: DashboardRoute): string {
  return DASHBOARD_ROUTES.map((candidate) => {
    const marker = candidate.id === route.id ? "{cyan-fg}> {/cyan-fg}" : "  ";
    const label =
      candidate.id === route.id
        ? `{bold}${escapeBlessedTags(candidate.title)}{/bold}`
        : escapeBlessedTags(candidate.title);
    return `${marker}${label}`;
  }).join("\n");
}

function renderWorkbench(
  route: DashboardRoute,
  actions: readonly DashboardAction[],
): string {
  const lines = [
    `{bold}${escapeBlessedTags(route.title)}{/bold}`,
    "",
    escapeBlessedTags(route.description),
    "",
    "{gray-fg}Actions{/gray-fg}",
  ];

  if (actions.length === 0) {
    lines.push("No actions configured for this screen yet.");
    return lines.join("\n");
  }

  for (const [index, action] of actions.entries()) {
    const prefix = index === 0 ? "{cyan-fg}> {/cyan-fg}" : "  ";
    lines.push(
      `${prefix}{bold}${escapeBlessedTags(action.label)}{/bold}`,
      `   ${escapeBlessedTags(action.description)}`,
    );
  }
  return lines.join("\n");
}

function renderInspector(
  route: DashboardRoute,
  actions: readonly DashboardAction[],
): string {
  const primary = actions[0];
  const lines = [
    "{bold}Route metadata{/bold}",
    "",
    `{gray-fg}Screen{/gray-fg} ${escapeBlessedTags(route.id)}`,
    `{gray-fg}Title{/gray-fg}  ${escapeBlessedTags(route.title)}`,
    "",
    "{bold}Primary action{/bold}",
    "",
  ];

  if (!primary) {
    lines.push("No primary action.");
    return lines.join("\n");
  }

  lines.push(
    escapeBlessedTags(primary.label),
    escapeBlessedTags(primary.description),
  );
  if (primary.kind === "command") {
    lines.push(
      "",
      `{gray-fg}Command{/gray-fg} ${escapeBlessedTags(
        formatDashboardCommand(primary.command),
      )}`,
      `{gray-fg}Shell handoff{/gray-fg} ${primary.shellHandoff ? "yes" : "no"}`,
    );
  } else {
    lines.push(
      "",
      `{gray-fg}Route{/gray-fg} ${escapeBlessedTags(primary.route)}`,
    );
  }

  return lines.join("\n");
}

function actionDetails(action: DashboardAction) {
  if (action.kind === "navigate") {
    return [{ label: "Route", value: action.route }];
  }
  return [
    { label: "Command", value: formatDashboardCommand(action.command) },
    { label: "Shell handoff", value: action.shellHandoff ? "yes" : "no" },
  ];
}
