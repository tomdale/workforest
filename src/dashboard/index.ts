import { Box } from "@unblessed/node";
import {
  isEnvironmentVariableSet,
  STANDARD_ENVIRONMENT_VARIABLES,
  WORKFOREST_ENVIRONMENT_VARIABLES,
} from "../environment.ts";
import { createFullscreenScreen } from "../terminal/fullscreen-surface.ts";
import {
  renderTerminalDocBlessed,
  type TerminalDoc,
  type TerminalLineInput,
  terminalDoc,
  terminalSpan,
} from "../terminal/render-model.ts";
import { renderReport } from "../terminal/report.ts";
import { activeTheme, toBlessed } from "../terminal/theme-system.ts";

/** Chrome tokens for the legacy dashboard, resolved from the active theme. */
function chromeTokens(): { accent: string; muted: string } {
  const { palette } = activeTheme();
  return { accent: toBlessed(palette.focus), muted: toBlessed(palette.muted) };
}

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

export type DashboardActionSelection = Readonly<{
  state: DashboardState;
  command: readonly string[] | null;
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
  return activateDashboardAction(state).state;
}

export function activateDashboardAction(
  state: DashboardState,
): DashboardActionSelection {
  const action = state.paletteOpen
    ? DASHBOARD_ACTIONS[state.paletteIndex]
    : currentActions(state)[state.actionIndex];
  if (!action) {
    return {
      state: {
        ...state,
        operationMessage: "No action selected",
      },
      command: null,
    };
  }

  if (action.kind === "navigate") {
    return selectDashboardRoute(state, action.route);
  }

  const dashboardRoute = dashboardCommandRoute(action.command);
  if (dashboardRoute) {
    return selectDashboardRoute(state, dashboardRoute);
  }

  if (dashboardCommandNeedsOperands(action.command)) {
    return {
      state: {
        ...state,
        paletteOpen: false,
        operationMessage: `${formatDashboardCommand(
          action.command,
        )} needs operands before it can run`,
      },
      command: null,
    };
  }

  return {
    state: {
      ...state,
      paletteOpen: false,
      operationMessage: `Exiting to run ${formatDashboardCommand(
        action.command,
      )}`,
    },
    command: action.command,
  };
}

function selectDashboardRoute(
  state: DashboardState,
  routeId: DashboardRoute["id"],
): DashboardActionSelection {
  const route = getDashboardRoute(routeId);
  return {
    state: {
      ...state,
      routeIndex: Math.max(
        0,
        DASHBOARD_ROUTES.findIndex((candidate) => candidate.id === route.id),
      ),
      actionIndex: 0,
      paletteOpen: false,
      operationMessage: `Opened ${route.title}`,
    },
    command: null,
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

export async function runDashboardTui(
  route: DashboardRoute,
): Promise<readonly string[] | null> {
  return new Promise((resolve) => {
    const screen = createFullscreenScreen();
    const layout = dashboardLayoutForSize(
      process.stdout.columns ?? 80,
      process.stdout.rows ?? 24,
    );
    const boxes = createDashboardBoxes(layout, screen);
    let state = createDashboardState(route);
    let done = false;

    const finish = (command: readonly string[] | null = null): void => {
      if (done) return;
      done = true;
      screen.destroy();
      resolve(command);
    };

    const refresh = (): void => {
      renderDashboardScreen(state, boxes);
      screen.render();
    };

    screen.key(["q", "C-c"], () => finish());
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
      const selection = activateDashboardAction(state);
      state = selection.state;
      if (selection.command) {
        finish(selection.command);
        return;
      }
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
      border: { fg: chromeTokens().muted },
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
    style: { fg: chromeTokens().muted },
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
        border: { fg: chromeTokens().accent },
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
      border: { fg: chromeTokens().accent },
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
      border: { fg: chromeTokens().accent },
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
      border: { fg: chromeTokens().muted },
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
      border: { fg: chromeTokens().accent },
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
    boxes.sidebar.setContent(renderDashboardDoc(renderSidebarDoc(state)));
    boxes.workbench.setLabel(` ${route.title} `);
    boxes.workbench.setContent(
      renderDashboardDoc(renderWorkbenchDoc(route, actions, state.actionIndex)),
    );
    boxes.inspector.setContent(
      renderDashboardDoc(renderInspectorDoc(route, selected)),
    );
  } else {
    boxes.workbench.setContent(
      renderDashboardDoc(
        renderCompactWorkbenchDoc(state, route, actions, selected),
      ),
    );
  }

  boxes.operations.setContent(
    renderDashboardDoc(renderOperationsDoc(state, selected)),
  );
  boxes.footer.setContent(
    renderDashboardDoc(
      terminalDoc([
        [
          terminalSpan(
            "↑/k ↓/j action  ←/h →/l route  / palette  Enter select  Esc close/quit  q/C-c quit",
            { role: "muted" },
          ),
        ],
      ]),
    ),
  );
  if (state.paletteOpen) {
    boxes.palette.show();
    boxes.palette.setContent(renderDashboardDoc(renderPaletteDoc(state)));
  } else {
    boxes.palette.hide();
  }
}

function renderDashboardDoc(doc: TerminalDoc): string {
  return renderTerminalDocBlessed(doc);
}

function renderSidebarDoc(state: DashboardState): TerminalDoc {
  return terminalDoc(
    DASHBOARD_ROUTES.map((candidate, index) => {
      const selected = index === state.routeIndex;
      return [
        terminalSpan(selected ? "> " : "  ", selected ? { role: "focus" } : {}),
        terminalSpan(
          candidate.title,
          selected ? { role: "primary", emphasis: "bold" } : {},
        ),
      ];
    }),
  );
}

function renderWorkbenchDoc(
  route: DashboardRoute,
  actions: readonly DashboardAction[],
  actionIndex: number,
): TerminalDoc {
  const lines: TerminalLineInput[] = [
    [terminalSpan(route.title, { role: "primary", emphasis: "bold" })],
    "",
    route.description,
    "",
    [terminalSpan("Actions", { role: "muted" })],
  ];

  for (const [index, action] of actions.entries()) {
    const selected = index === actionIndex;
    lines.push(
      [
        terminalSpan(selected ? "> " : "  ", selected ? { role: "focus" } : {}),
        terminalSpan(action.label, { role: "primary", emphasis: "bold" }),
      ],
      `   ${action.description}`,
    );
  }
  return terminalDoc(lines);
}

function renderCompactWorkbenchDoc(
  state: DashboardState,
  route: DashboardRoute,
  actions: readonly DashboardAction[],
  selected: DashboardAction | undefined,
): TerminalDoc {
  return mergeDashboardDocs(
    terminalDoc([
      [terminalSpan("Routes", { role: "primary", emphasis: "bold" })],
      DASHBOARD_ROUTES.flatMap((candidate, index) => {
        const selectedRoute = index === state.routeIndex;
        const spans = [
          terminalSpan(
            candidate.title,
            selectedRoute ? { role: "focus", emphasis: "bold" } : {},
          ),
        ];
        if (index < DASHBOARD_ROUTES.length - 1) {
          spans.push(terminalSpan("  "));
        }
        return spans;
      }),
      "",
    ]),
    renderWorkbenchDoc(route, actions, state.actionIndex),
    terminalDoc(["", [terminalSpan("Inspector", { role: "muted" })]]),
    renderInspectorDoc(route, selected),
  );
}

function renderInspectorDoc(
  route: DashboardRoute,
  action: DashboardAction | undefined,
): TerminalDoc {
  const lines: TerminalLineInput[] = [
    [terminalSpan("Route metadata", { role: "primary", emphasis: "bold" })],
    "",
    [terminalSpan("Screen", { role: "muted" }), ` ${route.id}`],
    [terminalSpan("Title", { role: "muted" }), `  ${route.title}`],
    "",
    [terminalSpan("Selected action", { role: "primary", emphasis: "bold" })],
    "",
  ];

  if (!action) {
    return terminalDoc([...lines, "No action selected."]);
  }

  lines.push(action.label, action.description);
  if (action.kind === "command") {
    lines.push("", [
      terminalSpan("Command", { role: "muted" }),
      ` ${formatDashboardCommand(action.command)}`,
    ]);
  } else {
    lines.push("", [
      terminalSpan("Route", { role: "muted" }),
      ` ${action.route}`,
    ]);
  }

  return terminalDoc(lines);
}

function renderOperationsDoc(
  state: DashboardState,
  action: DashboardAction | undefined,
): TerminalDoc {
  const actionLabel = action?.label ?? "None";
  return terminalDoc([
    state.operationMessage,
    [terminalSpan("Selected", { role: "muted" }), ` ${actionLabel}`],
  ]);
}

function renderPaletteDoc(state: DashboardState): TerminalDoc {
  const lines: TerminalLineInput[] = [
    [
      terminalSpan("Type / to open, Esc to close, Enter to select.", {
        role: "muted",
      }),
    ],
    "",
  ];
  for (const [index, action] of DASHBOARD_ACTIONS.entries()) {
    const selected = index === state.paletteIndex;
    const suffix =
      action.kind === "command"
        ? formatDashboardCommand(action.command)
        : action.route;
    lines.push(
      [
        terminalSpan(selected ? "> " : "  ", selected ? { role: "focus" } : {}),
        terminalSpan(action.label, { role: "primary", emphasis: "bold" }),
        " ",
        terminalSpan(suffix, { role: "muted" }),
      ],
      `   ${action.description}`,
    );
  }
  return terminalDoc(lines);
}

function mergeDashboardDocs(...docs: readonly TerminalDoc[]): TerminalDoc {
  return { lines: docs.flatMap((doc) => doc.lines) };
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
  return [{ label: "Command", value: formatDashboardCommand(action.command) }];
}

function dashboardCommandNeedsOperands(command: readonly string[]): boolean {
  return command.some((token) => /<[^>]+>/.test(token));
}

function dashboardCommandRoute(
  command: readonly string[],
): DashboardRoute["id"] | null {
  if (command.length !== 1) return null;

  switch (command[0]) {
    case "dashboard":
      return "home";
    case "templates":
      return "templates";
    case "tasks":
      return "tasks";
    case "reviews":
      return "reviews";
    default:
      return null;
  }
}

function wrapIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}
