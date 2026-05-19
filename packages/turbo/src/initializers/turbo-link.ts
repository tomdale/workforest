import {
  runCommandGenerator,
  type InitializerContext,
  type InitializerDefinition,
} from "@wf-plugin/core";

async function* execute(context: InitializerContext) {
  const { repoDir } = context;
  const args = ["link", "--yes"];

  yield { status: "running" as const, message: `turbo ${args.join(" ")}` };

  const link = runCommandGenerator("turbo", args, { cwd: repoDir });
  for await (const state of link) {
    yield state;
  }
}

const turboLinkInitializer: InitializerDefinition = {
  id: "turbo-link",
  name: "Turbo link",
  execute,
};

export default turboLinkInitializer;
