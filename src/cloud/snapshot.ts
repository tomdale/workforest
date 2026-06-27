import { createHash } from "node:crypto";
import type { NetworkPolicy } from "@vercel/sandbox";
import type { ServiceEventSink } from "../services/events.ts";
import { emitServiceEvent } from "../services/events.ts";
import type { ResolvedStartSource } from "../workspace/create-change.ts";
import type { CloudCredentials } from "./credentials.ts";
import { baseSandboxName } from "./tags.ts";
import {
  type CloudSandbox,
  createBaseSandbox,
  getSandbox,
  runToCompletion,
} from "./vercel-sandbox.ts";
import { httpsCloneUrl } from "./vercel-team.ts";

/** Default freshness window for a base snapshot before it is rebuilt. */
export const DEFAULT_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

/** Where repos are checked out inside the sandbox. */
export const SANDBOX_WORKDIR = "/vercel/sandbox";

const BASE_GROUP_TAG = "wfBase";
const BUILT_AT_TAG = "wfBuiltAt";

export type CloudRepo = Readonly<{ name: string; remote: string }>;

/**
 * A stable identifier for the repo set a base snapshot serves. Templates key on
 * their id (so every change from a template shares one warm base); ad-hoc and
 * single-repo sets key on a short hash of their sorted remotes.
 */
export function baseSnapshotGroup(source: ResolvedStartSource): string {
  if (source.kind === "template") {
    return `tpl-${source.templateId}`;
  }
  const remotes =
    source.kind === "repository"
      ? [source.repo.remote]
      : source.repos.map((repo) => repo.remote);
  const digest = createHash("sha256")
    .update([...remotes].sort().join("\n"))
    .digest("hex")
    .slice(0, 10);
  return `set-${digest}`;
}

/** True when a base snapshot built at `builtAtMs` is still within its TTL. */
export function isSnapshotFresh(
  builtAtMs: number | undefined,
  ttlMs: number,
  nowMs: number,
): boolean {
  if (builtAtMs === undefined) return false;
  return nowMs - builtAtMs < ttlMs;
}

function readBuiltAt(sandbox: CloudSandbox): number | undefined {
  const raw = sandbox.tags?.[BUILT_AT_TAG];
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export type EnsureBaseSnapshotParams = Readonly<{
  group: string;
  repos: readonly CloudRepo[];
  ttlMs: number;
  nowMs: number;
  networkPolicy: NetworkPolicy;
  credentials: CloudCredentials;
  vcpus?: number;
  timeoutMs?: number;
  runtime?: string;
  onEvent?: ServiceEventSink;
}>;

/**
 * Ensure a fresh per-template base snapshot exists and return the base sandbox
 * name to fork from, or null when no usable base could be produced (the caller
 * then falls back to a cold create). A base is rebuilt when missing or older
 * than the TTL: the repos are cloned over HTTPS (credential brokered) and
 * dependencies installed, then the sandbox is stopped so its filesystem is
 * snapshotted.
 */
export async function ensureBaseSnapshot(
  params: EnsureBaseSnapshotParams,
): Promise<string | null> {
  const name = baseSandboxName(params.group);

  const existing = await getSandbox(name, params.credentials);
  if (
    existing &&
    isSnapshotFresh(readBuiltAt(existing), params.ttlMs, params.nowMs)
  ) {
    return name;
  }

  // Rebuild: a stale or partial base must not be forked. Delete it first so a
  // failed rebuild cannot be mistaken for a fresh snapshot on the next run.
  emitServiceEvent(params.onEvent, {
    type: "message",
    level: "info",
    message: existing
      ? `Refreshing cloud base environment (${params.group})…`
      : `Building cloud base environment (${params.group})…`,
  });

  if (existing) {
    try {
      await existing.delete();
    } catch (error) {
      emitServiceEvent(params.onEvent, {
        type: "message",
        level: "warning",
        message: `Could not replace stale base environment; provisioning cold. ${formatError(error)}`,
      });
      return null;
    }
  }

  let base: CloudSandbox;
  try {
    base = await createBaseSandbox({
      name,
      tags: {
        wf: "1",
        [BASE_GROUP_TAG]: params.group,
      },
      networkPolicy: params.networkPolicy,
      credentials: params.credentials,
      ...(params.vcpus !== undefined ? { vcpus: params.vcpus } : {}),
      ...(params.timeoutMs !== undefined
        ? { timeoutMs: params.timeoutMs }
        : {}),
      ...(params.runtime !== undefined ? { runtime: params.runtime } : {}),
    });
  } catch (error) {
    emitServiceEvent(params.onEvent, {
      type: "message",
      level: "warning",
      message: `Could not build base environment; provisioning cold. ${formatError(error)}`,
    });
    return null;
  }

  try {
    for (const repo of params.repos) {
      const cloneCode = await runToCompletion(base, {
        cmd: "git",
        args: ["clone", "--depth", "1", httpsCloneUrl(repo.remote), repo.name],
        cwd: SANDBOX_WORKDIR,
      });
      if (cloneCode !== 0) {
        throw new Error(
          `git clone failed for ${repo.name} (exit ${cloneCode}).`,
        );
      }
      await runToCompletion(base, {
        cmd: "sh",
        args: [
          "-c",
          "([ -f pnpm-lock.yaml ] || [ -f pnpm-lock.yml ]) && corepack pnpm install --frozen-lockfile || true",
        ],
        cwd: `${SANDBOX_WORKDIR}/${repo.name}`,
      });
    }
    await base.stop();
    await base.update({
      tags: {
        wf: "1",
        [BASE_GROUP_TAG]: params.group,
        [BUILT_AT_TAG]: String(params.nowMs),
      },
    });
    return name;
  } catch (error) {
    await deletePartialBase(base, params.onEvent);
    emitServiceEvent(params.onEvent, {
      type: "message",
      level: "warning",
      message: `Base environment build failed; provisioning cold. ${formatError(error)}`,
    });
    return null;
  }
}

async function deletePartialBase(
  sandbox: CloudSandbox,
  onEvent: ServiceEventSink | undefined,
): Promise<void> {
  try {
    await sandbox.delete();
  } catch (error) {
    emitServiceEvent(onEvent, {
      type: "message",
      level: "warning",
      message: `Could not delete partial base environment. ${formatError(error)}`,
    });
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
