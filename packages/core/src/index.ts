import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import semver from "semver";

export type RepoConfig = {
  name: string;
  remote: string;
  defaultBranch: string;
};

export type VercelRepoOverride = {
  team?: string;
  disabled?: boolean;
};

export type VercelLinkConfig = {
  teamByGitHubOwner?: Record<string, string>;
  repoOverrides?: Record<string, VercelRepoOverride>;
};

export type WorkforestDirectoryConfig = {
  base?: string;
  repos?: string;
  workspaces?: string;
  reviews?: string;
};

export type WorkspaceConfig = {
  directory?: WorkforestDirectoryConfig;
  branchPrefix?: string;
  vercelLink?: VercelLinkConfig;
};

export type InitializerContext = {
  repoDir: string;
  workspaceDir: string;
  repo: RepoConfig;
  workspaceConfig?: WorkspaceConfig;
};

export type InitializerDetection = {
  shouldRun: boolean;
  metadata?: Record<string, unknown>;
};

export type PluginDetection =
  | { activate: false }
  | { activate: true; initializers: string[] };

export type PluginDetect = (
  context: InitializerContext,
) => Promise<PluginDetection>;

export type TaskState =
  | { status: "pending" }
  | { status: "running"; message?: string }
  | { status: "output"; data: string }
  | { status: "log"; level: "info" | "warn" | "error"; message: string }
  | { status: "retrying"; reason: string; attempt: number }
  | { status: "completed" }
  | { status: "failed"; error: Error }
  | { status: "skipped"; reason: string };

export type TaskGenerator = AsyncGenerator<TaskState, void, undefined>;

export type InitializerDefinition = {
  id: string;
  name: string;
  execute: (
    context: InitializerContext,
    metadata: Record<string, unknown>,
  ) => TaskGenerator;
};

export type AiAvailability =
  | { available: true; setupHint?: string }
  | { available: false; setupHint: string; reason?: string };

export type SpawnEnvironment = Record<string, string | undefined>;

export type AiProviderContext = {
  cwd: string;
  env: SpawnEnvironment;
  model?: string;
  timeoutMs: number;
};

export type AiProgressEvent =
  | { type: "message"; source: string; text: string }
  | {
      type: "activity";
      source: string;
      activity: "command" | "search" | "tool";
      description: string;
    }
  | {
      type: "usage";
      source: string;
      inputTokens: number;
      outputTokens: number;
    }
  | { type: "diagnostic"; source: string; message: string }
  | { type: "error"; source: string; message: string };

export type AiModelCategory = "generate-context";

export type AiTextGenerationRequest = {
  prompt: string;
  model?: string;
  outputSchema?: Record<string, unknown>;
  timeoutMs?: number;
  onEvent?: (event: AiProgressEvent) => void;
};

export type AiTextGenerationResult = {
  text: string;
};

export type AiProviderClient = {
  generateText(
    request: AiTextGenerationRequest,
  ): Promise<AiTextGenerationResult>;
};

export type AiProviderDefinition = {
  id: string;
  label: string;
  priority: number;
  capabilities: string[];
  modelCategories: Record<AiModelCategory, string>;
  detect(context: AiProviderContext): Promise<AiAvailability>;
  create(
    context: AiProviderContext,
  ): Promise<AiProviderClient> | AiProviderClient;
};

export type RunCommandOptions = {
  cwd?: string;
};

type CommandExit =
  | { type: "close"; code: number | null }
  | { type: "error"; error: Error };

type QueuedOutput = {
  data: string;
  bytes: number;
};

const MAX_STDERR_CHARS = 4096;
const MAX_QUEUED_OUTPUT_BYTES = 1024 * 1024;
const RESUME_QUEUED_OUTPUT_BYTES = MAX_QUEUED_OUTPUT_BYTES / 2;

export async function* runCommandGenerator(
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): TaskGenerator {
  yield { status: "running", message: `${command} ${args.join(" ")}` };

  const child = spawn(command, args, {
    cwd: options.cwd,
    env: createSpawnEnv(options.cwd),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const outputQueue: QueuedOutput[] = [];
  let queuedBytes = 0;
  let streamsPaused = false;
  let wakeOutputConsumer: (() => void) | undefined;
  const stderrTail = new TailBuffer(MAX_STDERR_CHARS);

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  function wakeConsumer(): void {
    wakeOutputConsumer?.();
    wakeOutputConsumer = undefined;
  }

  function pauseStreamsIfNeeded(): void {
    if (streamsPaused || queuedBytes < MAX_QUEUED_OUTPUT_BYTES) {
      return;
    }

    child.stdout.pause();
    child.stderr.pause();
    streamsPaused = true;
  }

  function resumeStreamsIfNeeded(): void {
    if (!streamsPaused || queuedBytes > RESUME_QUEUED_OUTPUT_BYTES) {
      return;
    }

    child.stdout.resume();
    child.stderr.resume();
    streamsPaused = false;
  }

  function enqueueOutput(chunk: string): void {
    const bytes = Buffer.byteLength(chunk, "utf8");
    outputQueue.push({ data: chunk, bytes });
    queuedBytes += bytes;
    pauseStreamsIfNeeded();
    wakeConsumer();
  }

  child.stdout.on("data", enqueueOutput);

  child.stderr.on("data", (chunk: string) => {
    stderrTail.append(chunk);
    enqueueOutput(chunk);
  });

  let exitResult: CommandExit | undefined;
  const exitPromise = new Promise<CommandExit>((resolve) => {
    child.on("error", (error) => resolve({ type: "error", error }));
    child.on("close", (code) => resolve({ type: "close", code }));
  }).then((exit) => {
    exitResult = exit;
    wakeConsumer();
    return exit;
  });

  function* drainOutput(): Generator<TaskState> {
    let chunk = outputQueue.shift();
    while (chunk !== undefined) {
      queuedBytes -= chunk.bytes;
      resumeStreamsIfNeeded();
      yield { status: "output", data: chunk.data };
      chunk = outputQueue.shift();
    }
  }

  function waitForOutputOrExit(): Promise<void> {
    if (outputQueue.length > 0 || exitResult) {
      return Promise.resolve();
    }

    return Promise.race([
      exitPromise.then(() => {
        wakeOutputConsumer = undefined;
      }),
      new Promise<void>((resolve) => {
        wakeOutputConsumer = resolve;
      }),
    ]);
  }

  while (true) {
    yield* drainOutput();

    if (exitResult) {
      yield* drainOutput();

      if (exitResult.type === "error") {
        yield {
          status: "failed",
          error: formatCommandStartError(command, args, exitResult.error),
        };
      } else if (exitResult.code === 0) {
        yield { status: "completed" };
      } else {
        yield {
          status: "failed",
          error: new Error(
            `${command} ${args.join(" ")} exited with code ${exitResult.code}. ${stderrTail.toString()}`,
          ),
        };
      }
      return;
    }

    await waitForOutputOrExit();
  }
}

export function canRunForegroundTask(): boolean {
  return (
    process.env["WORKFOREST_BACKGROUND_WORKER"] !== "1" &&
    Boolean(process.stdin.isTTY) &&
    Boolean(process.stdout.isTTY) &&
    Boolean(process.stderr.isTTY)
  );
}

export async function* runForegroundTask(
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): TaskGenerator {
  yield { status: "running", message: `${command} ${args.join(" ")}` };

  const child = spawn(command, args, {
    cwd: options.cwd,
    env: createSpawnEnv(options.cwd),
    stdio: "inherit",
  });

  const exit = await new Promise<CommandExit>((resolve) => {
    child.on("error", (error) => resolve({ type: "error", error }));
    child.on("close", (code) => resolve({ type: "close", code }));
  });

  if (exit.type === "error") {
    yield {
      status: "failed",
      error: formatCommandStartError(command, args, exit.error),
    };
    return;
  }

  if (exit.code === 0) {
    yield { status: "completed" };
    return;
  }

  yield {
    status: "failed",
    error: new Error(`${command} ${args.join(" ")} exited with code ${exit.code}.`),
  };
}

function formatCommandStartError(
  command: string,
  args: string[],
  error: Error,
): Error {
  const commandLine = `${command} ${args.join(" ")}`.trim();
  const code = (error as NodeJS.ErrnoException).code;

  if (code === "ENOENT") {
    return new Error(
      `${commandLine} failed to start: command not found (${command}). Install ${command} or ensure it is available on PATH.`,
      { cause: error },
    );
  }

  return new Error(`${commandLine} failed to start: ${error.message}`, {
    cause: error,
  });
}

export type ParallelUpdate<T> = { id: string; state: T };

export type RunParallelOptions = {
  maxConcurrent?: number;
};

export async function* runParallel<T>(
  tasks: Map<string, AsyncGenerator<T>>,
  options: RunParallelOptions = {},
): AsyncGenerator<ParallelUpdate<T>> {
  const active = new Map<
    string,
    {
      iterator: AsyncIterator<T>;
      pendingPromise: Promise<{ id: string; result: IteratorResult<T> }> | null;
    }
  >();
  const pending = [...tasks.entries()];
  const maxConcurrent = normalizeMaxConcurrent(options.maxConcurrent);

  function startPendingTasks(): void {
    while (pending.length > 0 && active.size < maxConcurrent) {
      const next = pending.shift();
      if (!next) {
        return;
      }

      const [id, gen] = next;
      active.set(id, {
        iterator: gen[Symbol.asyncIterator](),
        pendingPromise: null,
      });
    }
  }

  function getPromise(
    id: string,
    entry: {
      iterator: AsyncIterator<T>;
      pendingPromise: Promise<{ id: string; result: IteratorResult<T> }> | null;
    },
  ): Promise<{ id: string; result: IteratorResult<T> }> {
    if (!entry.pendingPromise) {
      entry.pendingPromise = entry.iterator
        .next()
        .then((result) => ({ id, result }));
    }
    return entry.pendingPromise;
  }

  startPendingTasks();

  while (active.size > 0) {
    const promises = [...active.entries()].map(([id, entry]) =>
      getPromise(id, entry),
    );
    const { id, result } = await Promise.race(promises);
    const entry = active.get(id);
    if (!entry) {
      continue;
    }

    entry.pendingPromise = null;

    if (result.done) {
      active.delete(id);
      startPendingTasks();
    } else {
      yield { id, state: result.value };
    }
  }
}

function normalizeMaxConcurrent(value: number | undefined): number {
  if (value === undefined) {
    return Number.POSITIVE_INFINITY;
  }

  if (!Number.isFinite(value) || value < 1) {
    throw new RangeError("maxConcurrent must be a positive finite number.");
  }

  return Math.floor(value);
}

export class TailBuffer {
  readonly #maxChars: number;
  #value = "";

  constructor(maxChars: number) {
    this.#maxChars = maxChars;
  }

  append(chunk: string): void {
    if (chunk.length === 0 || this.#maxChars <= 0) {
      return;
    }

    this.#value = (this.#value + chunk).slice(-this.#maxChars);
  }

  toString(): string {
    return this.#value;
  }
}

export type CliRunOptions = {
  cwd: string;
  env: SpawnEnvironment;
  input?: string;
  timeoutMs: number;
  timeoutKillGraceMs?: number;
  onOutput?: (stream: "stdout" | "stderr", data: string) => void;
  onDebug?: (message: string) => void;
};

export type CliRunResult = {
  stdout: string;
  stderr: string;
  code: number | null;
};

const CLI_STDERR_TAIL_CHARS = 4096;
const CLI_TIMEOUT_KILL_GRACE_MS = 5000;

export async function commandAvailable(
  command: string,
  args: string[],
  options: Pick<CliRunOptions, "cwd" | "env">,
): Promise<boolean> {
  try {
    const result = await runCli(command, args, {
      ...options,
      timeoutMs: 5000,
    });
    return result.code === 0;
  } catch {
    return false;
  }
}

export function runCli(
  command: string,
  args: string[],
  options: CliRunOptions,
): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: string[] = [];
    const stderr = new TailBuffer(CLI_STDERR_TAIL_CHARS);
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const startedAt = Date.now();

    const timer = setTimeout(() => {
      timedOut = true;
      options.onDebug?.(
        `${command} timed out after ${options.timeoutMs}ms; sending SIGTERM to pid ${child.pid ?? "(unknown)"}.`,
      );
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        options.onDebug?.(
          `${command} did not exit after SIGTERM; sending SIGKILL to pid ${child.pid ?? "(unknown)"}.`,
        );
        child.kill("SIGKILL");
      }, options.timeoutKillGraceMs ?? CLI_TIMEOUT_KILL_GRACE_MS);
    }, options.timeoutMs);
    options.onDebug?.(
      `${command} spawned pid ${child.pid ?? "(unknown)"} in ${options.cwd} with timeout ${options.timeoutMs}ms.`,
    );

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout.push(chunk);
      options.onOutput?.("stdout", chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr.append(chunk);
      options.onOutput?.("stderr", chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.onDebug?.(
        `${command} exited with code ${code ?? "(signal)"} after ${Date.now() - startedAt}ms.`,
      );
      if (timedOut) {
        reject(
          new Error(
            `${command} timed out after ${options.timeoutMs}ms and exited after forced termination. Increase WORKFOREST_AI_TIMEOUT_MS if this is expected.`,
          ),
        );
        return;
      }
      resolve({ stdout: stdout.join(""), stderr: stderr.toString(), code });
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

export function formatCliFailure(
  command: string,
  result: CliRunResult,
  setupHint: string,
): Error {
  const stderr = result.stderr.trim();
  const detail = stderr ? ` ${stderr}` : "";
  return new Error(
    `${command} exited with code ${result.code}.${detail} ${setupHint}`,
  );
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch (error_) {
    if ((error_ as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error_;
  }
}

export async function hasAny(
  dir: string,
  filenames: string[],
): Promise<boolean> {
  for (const filename of filenames) {
    if (await pathExists(path.join(dir, filename))) {
      return true;
    }
  }
  return false;
}

export interface NodeVersionPrefix {
  command: string;
  args: string[];
}

export async function getNodeVersionPrefix(
  dir: string,
): Promise<NodeVersionPrefix | null> {
  const requiredRange = await getRequiredNodeRange(dir);
  if (requiredRange === null) {
    return null;
  }

  if (semver.satisfies(process.version, requiredRange)) {
    return null;
  }

  const versionManager = await detectVersionManager();
  if (versionManager === null) {
    return null;
  }

  if (versionManager === "fnm") {
    return { command: "fnm", args: ["exec", "--"] };
  }

  if (versionManager === "asdf") {
    return { command: "asdf", args: ["exec"] };
  }

  return null;
}

async function getRequiredNodeRange(dir: string): Promise<string | null> {
  try {
    const packageJsonPath = path.join(dir, "package.json");
    const content = await fs.readFile(packageJsonPath, "utf8");
    const pkg = JSON.parse(content) as {
      engines?: { node?: string };
    };
    return pkg.engines?.node ?? null;
  } catch {
    return null;
  }
}

async function detectVersionManager(): Promise<"fnm" | "asdf" | null> {
  if (await commandExists("fnm")) {
    return "fnm";
  }
  if (await commandExists("asdf")) {
    return "asdf";
  }
  return null;
}

async function commandExists(cmd: string): Promise<boolean> {
  const pathValue = process.env["PATH"] ?? "";
  const paths = pathValue.split(path.delimiter).filter(Boolean);

  for (const dir of paths) {
    try {
      await fs.access(path.join(dir, cmd), constants.X_OK);
      return true;
    } catch {
      // Keep scanning PATH.
    }
  }

  return false;
}

const INHERITED_ENV_KEYS = new Set([
  "CI",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GPG_AGENT_INFO",
  "SSH_AUTH_SOCK",
  "VERCEL_TOKEN",
]);

const INHERITED_ENV_PREFIXES = [
  "GITHUB_",
  "NPM_CONFIG_",
  "npm_config_",
  "TURBO_",
  "VERCEL_",
];

export function createSpawnEnv(cwd?: string): SpawnEnvironment | undefined {
  if (cwd === undefined) {
    return undefined;
  }

  const shellEnv = getShellEnv(cwd);
  if (shellEnv === null) {
    return { ...process.env, PWD: cwd };
  }

  return mergeShellEnv(process.env, shellEnv, cwd);
}

function mergeShellEnv(
  parentEnv: NodeJS.ProcessEnv,
  shellEnv: NodeJS.ProcessEnv,
  cwd: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...shellEnv };

  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined || key in shellEnv) {
      continue;
    }

    if (!shouldInheritFromParent(key)) {
      continue;
    }

    env[key] = value;
  }

  env["PWD"] = cwd;
  return env;
}

const shellEnvCache = new Map<string, NodeJS.ProcessEnv | null>();

function getShellEnv(cwd: string): NodeJS.ProcessEnv | null {
  const shell = process.env["SHELL"];
  if (!shell) {
    return null;
  }

  const cacheKey = `${shell}\0${cwd}`;
  const cached = shellEnvCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const result = spawnSync(shell, ["-lc", "env -0"], {
    cwd,
    env: minimalShellEnv(shell, cwd),
    encoding: "buffer",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (result.status !== 0 || result.error) {
    shellEnvCache.set(cacheKey, null);
    return null;
  }

  const env = parseNullSeparatedEnv(result.stdout);
  shellEnvCache.set(cacheKey, env);
  return env;
}

function minimalShellEnv(shell: string, cwd: string): NodeJS.ProcessEnv {
  return copyDefinedEnv({
    HOME: process.env["HOME"],
    USER: process.env["USER"],
    LOGNAME: process.env["LOGNAME"],
    SHELL: shell,
    TERM: process.env["TERM"],
    TMPDIR: process.env["TMPDIR"],
    PWD: cwd,
    PATH: defaultPath(),
  });
}

function copyDefinedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => {
      return entry[1] !== undefined;
    }),
  );
}

function defaultPath(): string {
  return [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
}

function parseNullSeparatedEnv(output: Buffer): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const entry of output.toString("utf8").split("\0")) {
    if (!entry) {
      continue;
    }

    const separator = entry.indexOf("=");
    if (separator === -1) {
      continue;
    }

    env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }

  return env;
}

function shouldInheritFromParent(key: string): boolean {
  return (
    INHERITED_ENV_KEYS.has(key) ||
    INHERITED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}
