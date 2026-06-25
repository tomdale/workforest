import { Box } from "@unblessed/node";
import {
  isEnvironmentVariableSet,
  STANDARD_ENVIRONMENT_VARIABLES,
  WORKFOREST_ENVIRONMENT_VARIABLES,
} from "../environment.ts";
import { escapeBlessedTags } from "../terminal/command-stream-adapter.ts";
import { createFullscreenScreen } from "../terminal/fullscreen-surface.ts";
import { renderReport } from "../terminal/report.ts";
import { fullscreenColor } from "../terminal/theme.ts";
import {
  DASHBOARD_ACTIONS,
  DASHBOARD_ROUTES,
  type DashboardAction,
  type DashboardRoute,
  dashboardActionsForRoute,
  formatDashboardCommand,
  getDashboardRoute,
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

export type DashboardLayout = "wide" | "compact";

export type DashboardState = Readonly<{
  routeIndex: number;
  actionIndex: number;
  paletteOpen: boolean;
  paletteIndex: number;
  operationMessage: string;
}>;

type DashboardTerminal = Readonly<{
  stdin: Pick<NodeJS.ReadStream, "isTTY">;
  stdout: Pick<NodeJS.WriteStream, "columns" | "isTTY" | "rows">;
  env: NodeJS.ProcessEnv;
}>;

type DashboardBoxes =
  | Readonly<{
      layout: "wide";
      sidebar: Box;
      workbench: Box;
      inspector: Box;
      operations: Box;
      footer: Box;
      palette: Box;
    }>
  | Readonly<{
      layout: "compact";
      workbench: Box;
      operations: Box;
      footer: Box;
      palette: Box;
    }>;

const MIN_DASHBOARD_COLUMNS = 80;
const MIN_DASHBOARD_ROWS = 20;
const WIDE_DASHBOARD_COLUMNS = 104;
const WIDE_DASHBOARD_ROWS = 28;

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

export function dashboardLayoutForSize(
  columns: number,
  rows: number,
): DashboardLayout {
  return columns >= WIDE_DASHBOARD_COLUMNS && rows >= WIDE_DASHBOARD_ROWS
    ? "wide"
    : "compact";
}

export function createDashboardState(route: DashboardRoute): DashboardState {
  return {
    routeIndex: Math.max(
      0,
      DASHBOARD_ROUTES.findIndex((candidate) => candidate.id === route.id),
    ),
    actionIndex: 0,
    paletteOpen: false,
    paletteIndex: 0,
    operationMessage: "Idle",
  };
}

export function moveDashboardRoute(
  state: DashboardState,
  delta: number,
): DashboardState {
  const routeIndex = wrapIndex(
    state.routeIndex + delta,
    DASHBOARD_ROUTES.length,
  );
  return {
    ...state,
    routeIndex,
    actionIndex: 0,
    operationMessage: `Opened ${DASHBOARD_ROUTES[routeIndex]?.title ?? "Dashboard"}`,
  };
}

export function moveDashboardAction(
  state: DashboardState,
  delta: number,
): DashboardState {
  if (state.paletteOpen) {
    return {
      ...state,
      paletteIndex: wrapIndex(
        state.paletteIndex + delta,
        DASHBOARD_ACTIONS.length,
      ),
    };
  }

  const actions = currentActions(state);
  return {
    ...state,
    actionIndex:
      actions.length === 0
        ? 0
        : wrapIndex(state.actionIndex + delta, actions.length),
  };
}

export function openDashboardPalette(state: DashboardState): DashboardState {
  return {
    ...state,
    paletteOpen: true,
    paletteIndex: 0,
    operationMessage: "Command palette open",
  };
}

export function closeDashboardPalette(state: DashboardState): DashboardState {
  return {
    ...state,
    paletteOpen: false,
    operationMessage: "Command palette closed",
  };
}

export function selectDashboardAction(state: DashboardState): DashboardState {
  const action = state.paletteOpen
    ? DASHBOARD_ACTIONS[state.paletteIndex]
    : currentActions(state)[state.actionIndex];
  if (!action) {
    return {
      ...state,
      operationMessage: "No action selected",
    };
  }

  if (action.kind === "navigate") {
    const route = getDashboardRoute(action.route);
    return {
      ...state,
      routeIndex: Math.max(
        0,
        DASHBOARD_ROUTES.findIndex((candidate) => candidate.id === route.id),
      ),
      actionIndex: 0,
      paletteOpen: false,
      operationMessage: `Opened ${route.title}`,
    };
  }

  return {
    ...state,
    paletteOpen: false,
    operationMessage: `${formatDashboardCommand(action.command)} ${
      action.shellHandoff ? "requests shell handoff" : "is ready to run"
    }`,
  };
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
        entries: actions.map((action) => ({
          title: action.label,
          description: action.description,
          details: actionDetails(action),
        })),
      },
      {
        title: "Operations",
        fields: [
          { label: "State", value: "Idle" },
          {
            label: "Fallback",
            value: "Use explicit wf commands for scripts and automation.",
          },
        ],
      },
    ],
    footer:
      "Interactive dashboard opens in a capable TTY. Use explicit wf commands for scripts.",
  });
}

export async function runDashboardTui(route: DashboardRoute): Promise<void> {
  return new Promise((resolve) => {
    const screen = createFullscreenScreen();
    const layout = dashboardLayoutForSize(
      process.stdout.columns ?? 80,
      process.stdout.rows ?? 24,
    );
    const boxes = createDashboardBoxes(layout, screen);
    let state = createDashboardState(route);
    let done = false;

    const finish = (): void => {
      if (done) return;
      done = true;
      screen.destroy();
      resolve();
    };

    const refresh = (): void => {
      renderDashboardScreen(state, boxes);
      screen.render();
    };

    screen.key(["q", "C-c"], finish);
    screen.key(["escape"], () => {
      if (!state.paletteOpen) {
        finish();
        return;
      }
      state = closeDashboardPalette(state);
      refresh();
    });
    screen.key(["left", "h"], () => {
      state = moveDashboardRoute(state, -1);
      refresh();
    });
    screen.key(["right", "l"], () => {
      state = moveDashboardRoute(state, 1);
      refresh();
    });
    screen.key(["up", "k"], () => {
      state = moveDashboardAction(state, -1);
      refresh();
    });
    screen.key(["down", "j"], () => {
      state = moveDashboardAction(state, 1);
      refresh();
    });
    screen.key(["/"], () => {
      state = openDashboardPalette(state);
      refresh();
    });
    screen.key(["enter"], () => {
      state = selectDashboardAction(state);
      refresh();
    });

    refresh();
  });
}

function createDashboardBoxes(
  layout: DashboardLayout,
  screen: ReturnType<typeof createFullscreenScreen>,
): DashboardBoxes {
  const operations = new Box({
    parent: screen,
    bottom: 1,
    left: 0,
    width: "100%",
    height: 3,
    border: { type: "line" },
    label: " Operations ",
    tags: true,
    padding: { left: 1 },
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
  if (layout === "compact") {
    const workbench = new Box({
      parent: screen,
      top: 0,
      left: 0,
      width: "100%",
      height: "100%-4",
      border: { type: "line" },
      label: " Workforest ",
      tags: true,
      padding: { left: 1, top: 1 },
      style: {
        border: { fg: fullscreenColor.accent },
      },
    });
    const palette = createDashboardPalette(screen);
    return { layout, workbench, operations, footer, palette };
  }

  const sidebar = new Box({
    parent: screen,
    top: 0,
    left: 0,
    width: 24,
    height: "100%-4",
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
    height: "100%-4",
    border: { type: "line" },
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
    height: "100%-4",
    border: { type: "line" },
    label: " Inspector ",
    tags: true,
    padding: { left: 1, top: 1 },
    style: {
      border: { fg: fullscreenColor.muted },
    },
  });

  const palette = createDashboardPalette(screen);
  return { layout, sidebar, workbench, inspector, operations, footer, palette };
}

function createDashboardPalette(
  screen: ReturnType<typeof createFullscreenScreen>,
): Box {
  return new Box({
    parent: screen,
    top: "center",
    left: "center",
    width: "70%",
    height: "60%",
    border: { type: "line" },
    label: " Command palette ",
    tags: true,
    padding: { left: 1, top: 1 },
    hidden: true,
    style: {
      border: { fg: fullscreenColor.accent },
    },
  });
}

function renderDashboardScreen(
  state: DashboardState,
  boxes: DashboardBoxes,
): void {
  const route = currentRoute(state);
  const actions = currentActions(state);
  const selected = state.paletteOpen
    ? DASHBOARD_ACTIONS[state.paletteIndex]
    : actions[state.actionIndex];

  if (boxes.layout === "wide") {
    boxes.sidebar.setContent(renderSidebar(state));
    boxes.workbench.setLabel(` ${route.title} `);
    boxes.workbench.setContent(
      renderWorkbench(route, actions, state.actionIndex),
    );
    boxes.inspector.setContent(renderInspector(route, selected));
  } else {
    boxes.workbench.setContent(
      renderCompactWorkbench(state, route, actions, selected),
    );
  }

  boxes.operations.setContent(renderOperations(state, selected));
  boxes.footer.setContent(
    "↑/k ↓/j action  ←/h →/l route  / palette  Enter select  Esc close/quit  q/C-c quit",
  );
  if (state.paletteOpen) {
    boxes.palette.show();
    boxes.palette.setContent(renderPalette(state));
  } else {
    boxes.palette.hide();
  }
}

function renderSidebar(state: DashboardState): string {
  return DASHBOARD_ROUTES.map((candidate, index) => {
    const marker = index === state.routeIndex ? "{cyan-fg}> {/cyan-fg}" : "  ";
    const label =
      index === state.routeIndex
        ? `{bold}${escapeBlessedTags(candidate.title)}{/bold}`
        : escapeBlessedTags(candidate.title);
    return `${marker}${label}`;
  }).join("\n");
}

function renderWorkbench(
  route: DashboardRoute,
  actions: readonly DashboardAction[],
  actionIndex: number,
): string {
  const lines = [
    `{bold}${escapeBlessedTags(route.title)}{/bold}`,
    "",
    escapeBlessedTags(route.description),
    "",
    "{gray-fg}Actions{/gray-fg}",
  ];

  for (const [index, action] of actions.entries()) {
    const prefix = index === actionIndex ? "{cyan-fg}> {/cyan-fg}" : "  ";
    lines.push(
      `${prefix}{bold}${escapeBlessedTags(action.label)}{/bold}`,
      `   ${escapeBlessedTags(action.description)}`,
    );
  }
  return lines.join("\n");
}

function renderCompactWorkbench(
  state: DashboardState,
  route: DashboardRoute,
  actions: readonly DashboardAction[],
  selected: DashboardAction | undefined,
): string {
  return [
    "{bold}Routes{/bold}",
    DASHBOARD_ROUTES.map((candidate, index) =>
      index === state.routeIndex
        ? `{cyan-fg}${escapeBlessedTags(candidate.title)}{/cyan-fg}`
        : escapeBlessedTags(candidate.title),
    ).join("  "),
    "",
    renderWorkbench(route, actions, state.actionIndex),
    "",
    "{gray-fg}Inspector{/gray-fg}",
    ...renderInspectorLines(route, selected),
  ].join("\n");
}

function renderInspector(
  route: DashboardRoute,
  action: DashboardAction | undefined,
): string {
  return renderInspectorLines(route, action).join("\n");
}

function renderInspectorLines(
  route: DashboardRoute,
  action: DashboardAction | undefined,
): string[] {
  const lines = [
    "{bold}Route metadata{/bold}",
    "",
    `{gray-fg}Screen{/gray-fg} ${escapeBlessedTags(route.id)}`,
    `{gray-fg}Title{/gray-fg}  ${escapeBlessedTags(route.title)}`,
    "",
    "{bold}Selected action{/bold}",
    "",
  ];

  if (!action) {
    return [...lines, "No action selected."];
  }

  lines.push(
    escapeBlessedTags(action.label),
    escapeBlessedTags(action.description),
  );
  if (action.kind === "command") {
    lines.push(
      "",
      `{gray-fg}Command{/gray-fg} ${escapeBlessedTags(
        formatDashboardCommand(action.command),
      )}`,
      `{gray-fg}Shell handoff{/gray-fg} ${action.shellHandoff ? "yes" : "no"}`,
    );
  } else {
    lines.push(
      "",
      `{gray-fg}Route{/gray-fg} ${escapeBlessedTags(action.route)}`,
    );
  }

  return lines;
}

function renderOperations(
  state: DashboardState,
  action: DashboardAction | undefined,
): string {
  const actionLabel = action?.label ?? "None";
  const handoff =
    action?.kind === "command" && action.shellHandoff
      ? "Shell handoff action"
      : "No shell handoff pending";
  return [
    `${escapeBlessedTags(state.operationMessage)}  {gray-fg}${escapeBlessedTags(
      handoff,
    )}{/gray-fg}`,
    `{gray-fg}Selected{/gray-fg} ${escapeBlessedTags(actionLabel)}`,
  ].join("\n");
}

function renderPalette(state: DashboardState): string {
  const lines = ["Type / to open, Esc to close, Enter to select.", ""];
  for (const [index, action] of DASHBOARD_ACTIONS.entries()) {
    const prefix =
      index === state.paletteIndex ? "{cyan-fg}> {/cyan-fg}" : "  ";
    const suffix =
      action.kind === "command"
        ? `{gray-fg}${escapeBlessedTags(
            formatDashboardCommand(action.command),
          )}{/gray-fg}`
        : `{gray-fg}${escapeBlessedTags(action.route)}{/gray-fg}`;
    lines.push(
      `${prefix}{bold}${escapeBlessedTags(action.label)}{/bold} ${suffix}`,
      `   ${escapeBlessedTags(action.description)}`,
    );
  }
  return lines.join("\n");
}

function currentRoute(state: DashboardState): DashboardRoute {
  return DASHBOARD_ROUTES[state.routeIndex] ?? getDashboardRoute("home");
}

function currentActions(state: DashboardState): readonly DashboardAction[] {
  return dashboardActionsForRoute(currentRoute(state));
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

function wrapIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}
