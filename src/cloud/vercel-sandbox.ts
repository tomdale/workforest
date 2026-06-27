import { type NetworkPolicy, Sandbox } from "@vercel/sandbox";
import type { CloudSandboxMetadata } from "../types.ts";
import type { CloudCredentials } from "./credentials.ts";
import {
  decodeCloudSandbox,
  isManagedSandbox,
  isWorkspaceSandboxName,
} from "./tags.ts";

/**
 * The single boundary between workforest and the `@vercel/sandbox` SDK. Keeping
 * every import of the SDK here means the rest of the cloud module is written
 * against workforest types, so a future provider can be introduced by adding a
 * sibling wrapper without an interface refactor reaching into provisioning.
 *
 * Every static SDK call is passed explicit {@link CloudCredentials} (token +
 * team + project slugs); nothing is inferred ambiently and the `sandbox` CLI is
 * never used. Instance methods (runCommand, domain, stop) reuse the client the
 * sandbox was created with, so they need no credentials.
 */

/** A live cloud sandbox handle. Re-exported so callers avoid importing the SDK. */
export type CloudSandbox = Sandbox;

/**
 * Tokens the firewall injects into outbound requests so they never live inside
 * the sandbox. A prompt-injected or compromised process in the box cannot read
 * or exfiltrate them — the secret-injection proxy adds the header in transit.
 */
export type CredentialBrokering = Readonly<{
  /** A GitHub token (e.g. `gh auth token`) used for HTTPS clone and push. */
  githubToken?: string;
  /** A Vercel token used for `vercel env pull` against api.vercel.com. */
  vercelToken?: string;
}>;

/**
 * Build a network policy that keeps open egress (so installs and dev servers
 * work) while brokering credentials for git and the Vercel API. Git smart-HTTP
 * sends Basic auth, so GitHub gets a `Basic x-access-token:<token>` header; the
 * Vercel API gets a Bearer token. Injected headers overwrite any the sandbox
 * sets, defeating credential substitution.
 */
export function buildNetworkPolicy(
  brokering: CredentialBrokering,
): NetworkPolicy {
  const allow: Record<
    string,
    { transform?: { headers?: Record<string, string> }[] }[]
  > = {};

  if (brokering.githubToken) {
    const basic = `Basic ${Buffer.from(
      `x-access-token:${brokering.githubToken}`,
    ).toString("base64")}`;
    const rule = [{ transform: [{ headers: { authorization: basic } }] }];
    allow["github.com"] = rule;
    allow["*.github.com"] = rule;
  }

  if (brokering.vercelToken) {
    allow["api.vercel.com"] = [
      {
        transform: [
          { headers: { authorization: `Bearer ${brokering.vercelToken}` } },
        ],
      },
    ];
  }

  // Everything else is reachable with no transform (open egress, phase 1).
  allow["*"] = [];
  return { allow };
}

export type CreateBaseSandboxParams = Readonly<{
  name: string;
  tags: Record<string, string>;
  vcpus?: number;
  timeoutMs?: number;
  runtime?: string;
  networkPolicy: NetworkPolicy;
  credentials: CloudCredentials;
}>;

/**
 * Create the empty base sandbox a per-template snapshot is built into. The repos
 * are cloned and dependencies installed by the caller before the sandbox is
 * stopped (which snapshots its filesystem).
 */
export function createBaseSandbox(
  params: CreateBaseSandboxParams,
): Promise<CloudSandbox> {
  return Sandbox.create({
    ...params.credentials,
    name: params.name,
    tags: params.tags,
    networkPolicy: params.networkPolicy,
    persistent: true,
    ...(params.vcpus !== undefined
      ? { resources: { vcpus: params.vcpus } }
      : {}),
    ...(params.timeoutMs !== undefined ? { timeout: params.timeoutMs } : {}),
    ...(params.runtime !== undefined ? { runtime: params.runtime } : {}),
  });
}

export type ForkWorkspaceParams = Readonly<{
  sourceSandbox: string;
  name: string;
  tags: Record<string, string>;
  ports: number[];
  vcpus?: number;
  timeoutMs?: number;
  networkPolicy: NetworkPolicy;
  credentials: CloudCredentials;
}>;

/**
 * Fork a base snapshot into a new workspace sandbox. The fork inherits the
 * base's filesystem (repos + installed dependencies), which is what makes
 * spin-up near-instant; the caller then fetches and branches on top.
 */
export function forkWorkspaceSandbox(
  params: ForkWorkspaceParams,
): Promise<CloudSandbox> {
  return Sandbox.fork({
    ...params.credentials,
    sourceSandbox: params.sourceSandbox,
    name: params.name,
    tags: params.tags,
    ports: params.ports,
    networkPolicy: params.networkPolicy,
    persistent: true,
    ...(params.vcpus !== undefined
      ? { resources: { vcpus: params.vcpus } }
      : {}),
    ...(params.timeoutMs !== undefined ? { timeout: params.timeoutMs } : {}),
  });
}

export type CreateWorkspaceParams = Readonly<{
  name: string;
  tags: Record<string, string>;
  ports: number[];
  vcpus?: number;
  timeoutMs?: number;
  runtime?: string;
  networkPolicy: NetworkPolicy;
  credentials: CloudCredentials;
}>;

/**
 * Create a workspace sandbox directly (no base snapshot). Used as the cold
 * fallback when no fresh per-template snapshot is available.
 */
export function createWorkspaceSandbox(
  params: CreateWorkspaceParams,
): Promise<CloudSandbox> {
  return Sandbox.create({
    ...params.credentials,
    name: params.name,
    tags: params.tags,
    ports: params.ports,
    networkPolicy: params.networkPolicy,
    persistent: true,
    ...(params.vcpus !== undefined
      ? { resources: { vcpus: params.vcpus } }
      : {}),
    ...(params.timeoutMs !== undefined ? { timeout: params.timeoutMs } : {}),
    ...(params.runtime !== undefined ? { runtime: params.runtime } : {}),
  });
}

/** Retrieve a sandbox by name, or null when it does not exist. */
export async function getSandbox(
  name: string,
  credentials: CloudCredentials,
): Promise<CloudSandbox | null> {
  try {
    return await Sandbox.get({ ...credentials, name });
  } catch {
    return null;
  }
}

/** List every workforest-managed workspace sandbox, decoded from tags. */
export async function listManagedSandboxes(
  credentials: CloudCredentials,
): Promise<CloudSandboxMetadata[]> {
  const result = await Sandbox.list({ ...credentials });
  const managed: CloudSandboxMetadata[] = [];
  for await (const sandbox of result) {
    if (!isWorkspaceSandboxName(sandbox.name)) continue;
    if (!isManagedSandbox(sandbox)) continue;
    managed.push(decodeCloudSandbox(sandbox));
  }
  return managed;
}

/** Stop a sandbox by name, snapshotting its filesystem. Returns false if absent. */
export async function stopSandbox(
  name: string,
  credentials: CloudCredentials,
): Promise<boolean> {
  const sandbox = await getSandbox(name, credentials);
  if (!sandbox) return false;
  await sandbox.stop();
  return true;
}

/**
 * Resume a sandbox by name and return its live session id (sbx_…), or null when
 * it does not exist. `Sandbox.get` resumes a stopped box; the id is read fresh
 * (never persisted) because it changes across stop/resume. Used to hand a live
 * id to the `sandbox` CLI for an interactive shell.
 */
export async function resumeSandboxSession(
  name: string,
  credentials: CloudCredentials,
): Promise<string | null> {
  const sandbox = await getSandbox(name, credentials);
  if (!sandbox) return null;
  // A trivial command guarantees the session is fully resumed before its id is read.
  await runToCompletion(sandbox, { cmd: "true" });
  try {
    return sandbox.currentSession().sessionId;
  } catch {
    return null;
  }
}

export type StreamCommand = Readonly<{
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}>;

/**
 * Run a command in the sandbox, yielding each output chunk as it arrives and
 * returning the exit code. Driving the per-repo pipeline through a generator
 * lets provisioning map remote progress onto the existing grid's
 * `RepoPipelineState` vocabulary.
 */
export async function* streamCommand(
  sandbox: CloudSandbox,
  command: StreamCommand,
): AsyncGenerator<string, number> {
  const running = await sandbox.runCommand({
    cmd: command.cmd,
    detached: true,
    ...(command.args !== undefined ? { args: command.args } : {}),
    ...(command.cwd !== undefined ? { cwd: command.cwd } : {}),
    ...(command.env !== undefined ? { env: command.env } : {}),
  });
  for await (const log of running.logs()) {
    yield log.data;
  }
  const finished = await running.wait();
  return finished.exitCode;
}

/**
 * Run a command to completion, discarding output and returning the exit code.
 * Used for setup steps where progress streaming is not needed.
 */
export async function runToCompletion(
  sandbox: CloudSandbox,
  command: StreamCommand,
): Promise<number> {
  const stream = streamCommand(sandbox, command);
  let next = await stream.next();
  while (!next.done) {
    next = await stream.next();
  }
  return next.value;
}
