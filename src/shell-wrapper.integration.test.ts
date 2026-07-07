import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { renderShellInit, type SupportedShell } from "./shell.ts";
import { runSubprocess } from "./test-utils/subprocess.ts";

const FIXTURE_BIN = fileURLToPath(
  new URL("./test-fixtures/shell-wrapper-bin.sh", import.meta.url),
);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("generated shell wrappers", () => {
  it.each([
    ["bash", "wf"],
    ["bash", "workforest"],
    ["zsh", "wf"],
    ["zsh", "workforest"],
  ] as const)("hands off a successful bare %s %s invocation", async (shell, binName) => {
    const fixture = await createShellFixture(shell, []);
    const target = path.join(fixture.rootDir, "existing change");
    await mkdir(target);

    const result = await invokeWrapper(fixture, binName, {
      WORKFOREST_FAKE_CD_TARGET: target,
    });

    expect(result.exitCode).toBe(0);
    expect(parseValue(result.stdout, "status")).toBe("0");
    expect(await realpath(parseValue(result.stdout, "cwd") ?? "")).toBe(
      await realpath(target),
    );
    expect(result.stderr).toBe("");
    expect(await readFile(fixture.logPath, "utf8")).toBe("\n");
    expect(await readdir(fixture.tmpDir)).toEqual([]);
  });

  it.each([
    ["bash", "wf"],
    ["bash", "workforest"],
    ["zsh", "wf"],
    ["zsh", "workforest"],
  ] as const)("hands off a successful %s %s invocation to a path containing spaces", async (shell, binName) => {
    const fixture = await createShellFixture(shell);
    const target = path.join(fixture.rootDir, "workspace with spaces");
    await mkdir(target);

    const result = await invokeWrapper(fixture, binName, {
      WORKFOREST_FAKE_CD_TARGET: target,
    });

    expect(result.exitCode).toBe(0);
    expect(parseValue(result.stdout, "status")).toBe("0");
    expect(await realpath(parseValue(result.stdout, "cwd") ?? "")).toBe(
      await realpath(target),
    );
    expect(result.stderr).toBe("");
    expect(await readFile(fixture.logPath, "utf8")).toBe("switch\n");
    expect(await readdir(fixture.tmpDir)).toEqual([]);
  });

  it.each([
    "bash",
    "zsh",
  ] as const)("follows a cd target and preserves status after a failed %s invocation", async (shell) => {
    const fixture = await createShellFixture(shell);
    const target = path.join(fixture.rootDir, "failed target");
    await mkdir(target);

    const result = await invokeWrapper(fixture, "wf", {
      WORKFOREST_FAKE_CD_TARGET: target,
      WORKFOREST_FAKE_EXIT_CODE: "7",
    });

    expect(result.exitCode).toBe(0);
    expect(parseValue(result.stdout, "status")).toBe("7");
    expect(await realpath(parseValue(result.stdout, "cwd") ?? "")).toBe(
      await realpath(target),
    );
    expect(result.stderr).toBe("");
    expect(await readdir(fixture.tmpDir)).toEqual([]);
  });

  it("loads in pristine zsh without requiring compinit", async () => {
    const fixture = await createShellFixture("zsh");
    const result = await runSubprocess("/bin/zsh", ["-f", fixture.initPath], {
      env: fixture.env,
      timeout: 10_000,
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  });
});

type ShellFixture = {
  shell: SupportedShell;
  rootDir: string;
  initPath: string;
  invocationPath: string;
  startDir: string;
  tmpDir: string;
  logPath: string;
  env: NodeJS.ProcessEnv;
};

async function createShellFixture(
  shell: SupportedShell,
  invocationArgs: string[] = ["switch"],
): Promise<ShellFixture> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "workforest-wrapper-"));
  tempDirs.push(rootDir);

  const binDir = path.join(rootDir, "bin");
  const startDir = path.join(rootDir, "start");
  const tmpDir = path.join(rootDir, "tmp");
  const initPath = path.join(rootDir, `workforest-init.${shell}`);
  const invocationPath = path.join(rootDir, `invoke.${shell}`);
  const logPath = path.join(rootDir, "invocations.log");
  await Promise.all(
    [binDir, startDir, tmpDir].map((dir) => mkdir(dir, { recursive: true })),
  );
  await Promise.all(
    ["wf", "workforest"].map(async (name) => {
      const target = path.join(binDir, name);
      await copyFile(FIXTURE_BIN, target);
      await chmod(target, 0o755);
    }),
  );
  await writeFile(initPath, renderShellInit(shell));
  await writeFile(
    invocationPath,
    [
      `. ${shellQuote(initPath)}`,
      `cd ${shellQuote(startDir)}`,
      [
        '"$WORKFOREST_TEST_BIN"',
        ...invocationArgs.map((arg) => shellQuote(arg)),
      ].join(" "),
      "workforest_status=$?",
      'printf "status=%s\\ncwd=%s\\n" "$workforest_status" "$PWD"',
      "",
    ].join("\n"),
  );

  return {
    shell,
    rootDir,
    initPath,
    invocationPath,
    startDir,
    tmpDir,
    logPath,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
      TMPDIR: tmpDir,
      WORKFOREST_FAKE_LOG: logPath,
    },
  };
}

async function invokeWrapper(
  fixture: ShellFixture,
  binName: "wf" | "workforest",
  env: NodeJS.ProcessEnv,
) {
  const args =
    fixture.shell === "bash"
      ? ["--noprofile", "--norc", fixture.invocationPath]
      : ["-f", fixture.invocationPath];

  return runSubprocess(`/bin/${fixture.shell}`, args, {
    env: {
      ...fixture.env,
      ...env,
      WORKFOREST_TEST_BIN: binName,
    },
    timeout: 10_000,
  });
}

function parseValue(output: string, key: string): string | undefined {
  return output
    .split("\n")
    .find((line) => line.startsWith(`${key}=`))
    ?.slice(key.length + 1);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
