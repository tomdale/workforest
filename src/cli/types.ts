export type ExitCode = 0 | 1 | 2;

export type CliErrorKind = "operational" | "usage";

export type CommandPath = readonly string[];

export type Visibility = "visible" | "hidden";

export type OutputMode =
  | "human"
  | "interactive"
  | "json"
  | "path"
  | "report"
  | "shell";

export type ShellHandoff = "none" | "optional-cd";

export type TtyRequirement =
  | Readonly<{ kind: "none" }>
  | Readonly<{
      kind: "optional" | "required";
      streams: readonly ("stdin" | "stdout")[];
    }>
  | Readonly<{
      kind: "conditional";
      streams: readonly ("stdin" | "stdout")[];
      bypassFlags: readonly string[];
    }>;

export type HelpReference =
  | Readonly<{ kind: "root" }>
  | Readonly<{ kind: "command"; command: string }>
  | Readonly<{ kind: "nested"; command: string; subcommand: string }>;

export type AliasDefinition = Readonly<{
  name: string;
  visibility: Visibility;
  help?: HelpReference;
}>;

export type Cardinality = Readonly<{
  min: number;
  max: number | null;
  label: string;
  usage?: string;
  /** Explanation of this operand for the Arguments help section. */
  description?: string;
}>;

export type OperandVariant = Readonly<{
  beforeDoubleDash: Cardinality;
  delimiter: "forbidden" | "required";
  afterDoubleDash?: Cardinality;
  when?: Readonly<{
    flag?: string;
    present?: boolean;
    interactive?: boolean;
  }>;
}>;

export type OperandSpec = Readonly<{
  variants: readonly OperandVariant[];
}>;

export type FlagDefinition = Readonly<{
  name: string;
  long: `--${string}`;
  short?: `-${string}`;
  kind: "boolean" | "string";
  valueName?: string;
  required?: boolean;
  /** One-sentence explanation of the flag's effect for help output. */
  description?: string;
}>;

/** A copy-pasteable invocation plus the outcome it achieves. */
export type CommandExample = Readonly<{
  command: string;
  description?: string;
}>;

type CommandMetadata = Readonly<{
  name: string;
  path: CommandPath;
  aliases: readonly AliasDefinition[];
  visibility: Visibility;
  summary: string;
  /** Prose contract shown below the summary in help output. */
  description?: string;
  help: HelpReference;
}>;

export type CommandLeaf = CommandMetadata &
  Readonly<{
    kind: "leaf";
    operands: OperandSpec;
    flags: readonly FlagDefinition[];
    examples: readonly CommandExample[];
    outputModes: readonly OutputMode[];
    tty: TtyRequirement;
    shellHandoff: ShellHandoff;
    handler: string;
  }>;

export type CommandGroup = CommandMetadata &
  Readonly<{
    kind: "group";
    children: readonly CommandNode[];
    default?: CommandLeaf;
  }>;

export type CommandNode = CommandGroup | CommandLeaf;

export type CommandShortcut = Readonly<{
  name: string;
  target: CommandPath;
  visibility: Visibility;
  summary: string;
  help: HelpReference;
}>;

export type CommandRegistry = Readonly<{
  root: CommandGroup;
  shortcuts: readonly CommandShortcut[];
}>;

export type ResolvedCommand = Readonly<{
  kind: "command";
  leaf: CommandLeaf;
  canonicalPath: CommandPath;
  invokedPath: readonly string[];
  argv: readonly string[];
  help: HelpReference;
}>;

export type ResolvedHelp = Readonly<{
  kind: "help";
  canonicalPath: CommandPath;
  invokedPath: readonly string[];
  help: HelpReference;
}>;

export type CommandResolution = ResolvedCommand | ResolvedHelp;

export type ParsedInvocation = Readonly<{
  command: ResolvedCommand;
  flags: Readonly<Record<string, boolean | string | undefined>>;
  beforeDoubleDash: readonly string[];
  afterDoubleDash: readonly string[];
  hadDoubleDash: boolean;
  helpRequested: boolean;
}>;

export type InvocationContext = Readonly<{
  interactive: boolean;
}>;

export type JsonSuccessEnvelope<Data = unknown> = Readonly<{
  ok: true;
  data: Data;
}>;

export type JsonError = Readonly<{
  kind: CliErrorKind;
  message: string;
}>;

export type JsonFailureEnvelope = Readonly<{
  ok: false;
  error: JsonError;
}>;

export type JsonEnvelope<Data = unknown> =
  | JsonSuccessEnvelope<Data>
  | JsonFailureEnvelope;

export type TextOutputKind = "human" | "path" | "report" | "shell";

export type RenderModel =
  | Readonly<{ kind: "none" }>
  | Readonly<{
      kind: "text";
      value: string;
      stream: "stdout" | "stderr";
      trailingNewline?: boolean;
      outputKind?: TextOutputKind;
    }>
  | Readonly<{
      kind: "json";
      value: unknown;
      stream: "stdout" | "stderr";
    }>
  | Readonly<{
      kind: "json-error";
      error: JsonError;
      stream: "stdout" | "stderr";
    }>;

export type CommandResult = Readonly<{
  exitCode: ExitCode;
  render: RenderModel;
}>;

export type OutputWriter = Readonly<{
  stdout: (value: string) => void;
  stderr: (value: string) => void;
}>;
