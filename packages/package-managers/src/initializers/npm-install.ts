import {
  getNodeVersionPrefix,
  spawnCommand,
  type InitializerContext,
  type InitializerDefinition,
} from "@wf-plugin/core";

async function* execute(context: InitializerContext) {
  const { repoDir } = context;
  const versionPrefix = await getNodeVersionPrefix(repoDir);

  yield { status: "running" as const, message: "Installing (npm ci)" };

  let command: string;
  let args: string[];
  if (versionPrefix) {
    command = versionPrefix.command;
    args = [...versionPrefix.args, "npm", "ci"];
  } else {
    command = "npm";
    args = ["ci"];
  }

  const install = spawnCommand(command, args, { cwd: repoDir });
  for await (const state of install) {
    yield state;
  }
}

const npmInstallInitializer: InitializerDefinition = {
  id: "npm-install",
  name: "npm install",
  execute,
};

export default npmInstallInitializer;
