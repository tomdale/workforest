import { spawnSync } from "node:child_process";
import { OperationalError, UsageError } from "../cli/errors.ts";
import { jsonSuccess, reportOutput, success } from "../cli/output.ts";
import type { CommandResult, ParsedInvocation } from "../cli/types.ts";
import { loadWorkspaceConfig } from "../config.ts";
import { renderReport } from "../terminal/report.ts";
import type { CloudSandboxMetadata } from "../types.ts";
import {
  type CloudCredentials,
  describeCloudError,
  resolveCloudCredentials,
} from "./credentials.ts";
import { cloudSandboxName } from "./tags.ts";
import {
  listManagedSandboxes,
  resumeSandboxSession,
  stopSandbox,
} from "./vercel-sandbox.ts";

/**
 * Read-side and teardown commands for cloud workspaces. State is reconstructed
 * from Vercel tags (see `tags.ts`) rather than any local registry, so these work
 * from any machine and survive reinstalls. Every command resolves explicit
 * credentials up front, so misconfiguration fails fast and uniformly.
 */
export async function runCloudInvocation(
  invocation: ParsedInvocation,
): Promise<CommandResult> {
  const operands = [...invocation.beforeDoubleDash];
  const json = invocation.flags["json"] === true;
  const { config } = await loadWorkspaceConfig();
  const credentials = await resolveCloudCredentials(config);

  try {
    switch (invocation.command.leaf.handler) {
      case "cloud.list":
        return await runCloudList(credentials, json);
      case "cloud.status":
        return await runCloudStatus(credentials, operands[0], json);
      case "cloud.stop":
      case "cloud.delete":
        return await runCloudStop(credentials, operands[0], json);
      case "cloud.attach":
        return await runCloudAttach(credentials, operands[0]);
      default:
        throw new Error(
          `No cloud handler registered for ${invocation.command.leaf.handler}.`,
        );
    }
  } catch (error) {
    throw describeCloudError(error, credentials);
  }
}

async function runCloudList(
  credentials: CloudCredentials,
  json: boolean,
): Promise<CommandResult> {
  const sandboxes = await listManagedSandboxes(credentials);
  if (json) {
    return jsonSuccess(sandboxes);
  }
  if (sandboxes.length === 0) {
    return success(reportOutput("No cloud workspaces."));
  }
  return success(reportOutput(renderSandboxTable(sandboxes)));
}

async function runCloudStatus(
  credentials: CloudCredentials,
  selector: string | undefined,
  json: boolean,
): Promise<CommandResult> {
  if (!selector) {
    throw new UsageError("wf cloud status requires a change name.");
  }
  const sandbox = await findByChangeName(credentials, selector);
  if (!sandbox) {
    throw new OperationalError(`No cloud workspace found for "${selector}".`);
  }
  if (json) {
    return jsonSuccess(sandbox);
  }
  return success(reportOutput(renderSandboxDetail(sandbox)));
}

async function runCloudStop(
  credentials: CloudCredentials,
  selector: string | undefined,
  json: boolean,
): Promise<CommandResult> {
  if (!selector) {
    throw new UsageError("A change name is required.");
  }
  const stopped = await stopSandbox(cloudSandboxName(selector), credentials);
  if (!stopped) {
    throw new OperationalError(`No cloud workspace found for "${selector}".`);
  }
  if (json) {
    return jsonSuccess({ stopped: selector });
  }
  return success(reportOutput(`Stopped cloud workspace: ${selector}`));
}

/**
 * Open an interactive shell in a cloud workspace via the `sandbox` CLI. The box
 * is resumed through the SDK (so a stopped workspace works) to resolve a live
 * session id, then `sandbox ssh` is exec'd with the configured team/project as
 * explicit scope — so it targets the same place the SDK provisioned, regardless
 * of the CLI's own default scope — and our token passed via the environment
 * (not argv, to keep it out of the process list).
 */
async function runCloudAttach(
  credentials: CloudCredentials,
  selector: string | undefined,
): Promise<CommandResult> {
  if (!selector) {
    throw new UsageError("wf cloud attach requires a change name.");
  }
  const sessionId = await resumeSandboxSession(
    cloudSandboxName(selector),
    credentials,
  );
  if (!sessionId) {
    throw new OperationalError(`No cloud workspace found for "${selector}".`);
  }

  const args = [
    "ssh",
    "--scope",
    credentials.teamId,
    "--project",
    credentials.projectId,
    sessionId,
  ];
  const result = spawnSync("sandbox", args, {
    stdio: "inherit",
    env: { ...process.env, VERCEL_AUTH_TOKEN: credentials.token },
  });
  if (result.error) {
    const reason =
      "code" in result.error && result.error.code === "ENOENT"
        ? "the `sandbox` CLI is not installed or not on PATH (npm i -g sandbox)"
        : result.error.message;
    throw new OperationalError(`Could not open a shell: ${reason}.`);
  }
  // A non-zero status is the user's interactive shell exiting, not a wf failure.
  return success();
}

async function findByChangeName(
  credentials: CloudCredentials,
  changeName: string,
): Promise<CloudSandboxMetadata | undefined> {
  const sandboxes = await listManagedSandboxes(credentials);
  return sandboxes.find((sandbox) => sandbox.changeName === changeName);
}

function renderSandboxTable(
  sandboxes: readonly CloudSandboxMetadata[],
): string {
  return renderReport({
    title: "Cloud workspaces",
    sections: [
      {
        entries: sandboxes.map((sandbox) => ({
          title: sandbox.changeName,
          description: sandbox.status,
          details: sandboxFields(sandbox),
        })),
      },
    ],
  });
}

function renderSandboxDetail(sandbox: CloudSandboxMetadata): string {
  return renderReport({
    title: `Cloud workspace: ${sandbox.changeName}`,
    sections: [{ fields: sandboxFields(sandbox) }],
  });
}

function sandboxFields(
  sandbox: CloudSandboxMetadata,
): { label: string; value: string }[] {
  const fields = [
    { label: "Status", value: sandbox.status },
    { label: "Branch", value: sandbox.branchName },
    { label: "Repos", value: sandbox.repos.join(", ") },
    { label: "Created", value: sandbox.createdAt },
  ];
  if (sandbox.templateId) {
    fields.push({ label: "Template", value: sandbox.templateId });
  }
  return fields;
}
