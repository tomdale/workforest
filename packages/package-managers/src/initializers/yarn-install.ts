import {
  getNodeVersionPrefix,
  spawnCommand,
  type InitializerContext,
  type InitializerDefinition,
} from "@wf-plugin/core";

async function* execute(context: InitializerContext) {
  const { repoDir } = context;
  const versionPrefix = await getNodeVersionPrefix(repoDir);

  yield { status: "running" as const, message: "Installing (frozen-lockfile)" };

  let command: string;
  let args: string[];
  if (versionPrefix) {
    command = versionPrefix.command;
    args = [...versionPrefix.args, "yarn", "install", "--frozen-lockfile"];
  } else {
    command = "yarn";
    args = ["install", "--frozen-lockfile"];
  }

  const install = spawnCommand(command, args, { cwd: repoDir, pty: true });
  for await (const state of install) {
    yield state;
  }
}

const yarnInstallInitializer: InitializerDefinition = {
  id: "yarn-install",
  name: "yarn install",
  execute,
};

export default yarnInstallInitializer;
