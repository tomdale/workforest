import { promises as fs } from "node:fs";
import path from "node:path";
import { isRepoSlug, loadWorkspaceConfig } from "../config.ts";
import {
  type CachedRepository,
  listCachedRepositories,
  repositoryDisplayName,
} from "../repositories.ts";
import {
  createTemplate,
  listTemplates,
  type Template,
  validateTemplateName,
} from "../templates/index.ts";
import type { TemplateConfig, WorkspaceConfig } from "../types.ts";
import { runCommand } from "../utils/exec.ts";
import { ensureDir } from "../utils/fs.ts";
import { resolveWorkforestContext } from "../workspace/context.ts";
import { resolveWorkforestDirectories } from "../workspace/paths.ts";
import {
  type AiStatus,
  AiUnavailableError,
  DEFAULT_AI_TIMEOUT_MS,
  type GenerateJsonOptions,
  generateJson,
  getAiStatus,
} from "./ai/index.ts";

export const TEMPLATE_SUGGEST_DEFAULTS = {
  aiTimeoutMs: DEFAULT_AI_TIMEOUT_MS,
  heartbeatMs: 10_000,
  lookbackDays: 180,
  maxCachedRepositories: 120,
  maxExistingTemplates: 50,
  maxPathEnrichments: 24,
  maxPrsPerRole: 40,
  maxReposPerSuggestion: 12,
  maxSuggestions: 6,
  maxTotalPullRequests: 90,
} as const;

const TEMPLATE_SUGGEST_LOG_ROOT = path.join("ai", "template-suggest");

const ROLE_ORDER: TemplateEvidenceRole[] = [
  "authored",
  "reviewed",
  "commented",
];

export type TemplateEvidenceRole = "authored" | "reviewed" | "commented";

export type TemplateSuggestionStatus =
  | "started"
  | "heartbeat"
  | "completed"
  | "warning";

export type TemplateSuggestionPhase =
  | "provider-check"
  | "github-user"
  | "pr-search"
  | "path-enrichment"
  | "evidence-compaction"
  | "debug-log"
  | "ai-analysis"
  | "validation"
  | "save";

export type TemplateSuggestionStatusEvent = {
  phase: TemplateSuggestionPhase;
  status: TemplateSuggestionStatus;
  message: string;
};

export type TemplateSuggestion = {
  id: string;
  description: string;
  repos: string[];
  confidence: number;
  evidenceNotes: string[];
};

export type ExistingTemplateEvidence = {
  id: string;
  description?: string;
  repos: string[];
};

export type CachedRepositoryEvidence = {
  name: string;
  specifier: string;
  remote?: string;
};

export type RawPullRequestEvidence = {
  role: TemplateEvidenceRole;
  repository?: string | null;
  number?: number | null;
  title?: string | null;
  url?: string | null;
  labels?: string[];
  createdAt?: string | null;
  closedAt?: string | null;
  mergedAt?: string | null;
  updatedAt?: string | null;
  touchedPaths?: string[];
};

export type PullRequestEvidence = {
  repository: string;
  number: number;
  title: string;
  url?: string;
  roles: TemplateEvidenceRole[];
  labels: string[];
  createdAt?: string;
  closedAt?: string;
  mergedAt?: string;
  updatedAt?: string;
  pathSummary?: string;
  touchedPaths?: string[];
};

export type TemplateSuggestionEvidencePacket = {
  generatedAt: string;
  githubUser: string;
  lookbackDays: number;
  since: string;
  existingTemplates: ExistingTemplateEvidence[];
  cachedRepositories: CachedRepositoryEvidence[];
  pullRequests: PullRequestEvidence[];
  summary: {
    existingTemplateCount: number;
    cachedRepositoryCount: number;
    pullRequestCount: number;
    repositoriesSeenInPullRequests: string[];
  };
};

export type TemplateSuggestionAiInput = {
  schema: TemplateSuggestionJsonSchema;
  prompt: string;
  evidence: TemplateSuggestionEvidencePacket;
};

export type TemplateSuggestionJsonSchema = {
  type: "object";
  required: ["suggestions"];
  properties: {
    suggestions: {
      type: "array";
      minItems: 1;
      maxItems: number;
      items: {
        type: "object";
        required: ["id", "description", "repos", "confidence", "evidenceNotes"];
        properties: {
          id: { type: "string" };
          description: { type: "string" };
          repos: {
            type: "array";
            minItems: 1;
            maxItems: number;
            items: { type: "string" };
          };
          confidence: { type: "number"; minimum: 0; maximum: 1 };
          evidenceNotes: {
            type: "array";
            minItems: 1;
            items: { type: "string" };
          };
        };
      };
    };
  };
};

export type TemplateSuggestionResult = {
  suggestions: TemplateSuggestion[];
  evidence: TemplateSuggestionEvidencePacket;
  logDir: string;
};

export type TemplateSuggestionDebugLog = {
  dir: string;
  inputPath: string;
  outputPath: string;
};

export type TemplateSuggestionSaveResult = {
  saved: TemplateSuggestion[];
  skipped: Array<{ suggestion: TemplateSuggestion; reason: string }>;
};

export class TemplateSuggestionError extends Error {
  readonly logDir?: string;

  constructor(
    message: string,
    options: Readonly<{ logDir?: string; cause?: unknown }> = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "TemplateSuggestionError";
    if (options.logDir !== undefined) {
      this.logDir = options.logDir;
    }
  }
}

type CommandRunner = typeof runCommand;
type GenerateJson = <T>(options: GenerateJsonOptions<T>) => Promise<T>;
type AiStatusProvider = typeof getAiStatus;

export type SuggestTemplatesOptions = {
  cwd?: string;
  now?: Date;
  config?: WorkspaceConfig;
  commandRunner?: CommandRunner;
  generateJson?: GenerateJson;
  getAiStatus?: AiStatusProvider;
  onStatus?: ((event: TemplateSuggestionStatusEvent) => void) | undefined;
  heartbeatMs?: number;
  aiTimeoutMs?: number;
  lookbackDays?: number;
  maxCachedRepositories?: number;
  maxExistingTemplates?: number;
  maxPathEnrichments?: number;
  maxPrsPerRole?: number;
  maxReposPerSuggestion?: number;
  maxSuggestions?: number;
  maxTotalPullRequests?: number;
};

export async function suggestTemplates(
  options: SuggestTemplatesOptions = {},
): Promise<TemplateSuggestionResult> {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const config = options.config ?? (await loadWorkspaceConfig()).config;
  const onStatus = options.onStatus;
  const heartbeatMs =
    options.heartbeatMs ?? TEMPLATE_SUGGEST_DEFAULTS.heartbeatMs;
  const aiTimeoutMs =
    options.aiTimeoutMs ?? TEMPLATE_SUGGEST_DEFAULTS.aiTimeoutMs;

  const aiStatus = await withStatusPhase(
    "provider-check",
    "Checking AI provider availability",
    { heartbeatMs, onStatus },
    () =>
      (options.getAiStatus ?? getAiStatus)({
        cwd,
        config,
        timeoutMs: aiTimeoutMs,
      }),
  );
  requireAiProvider(aiStatus);

  const evidence = await collectTemplateSuggestionEvidence({
    ...options,
    cwd,
    now,
    config,
    onStatus,
    heartbeatMs,
  });
  const aiInput = buildTemplateSuggestionAiInput(evidence, {
    maxReposPerSuggestion:
      options.maxReposPerSuggestion ??
      TEMPLATE_SUGGEST_DEFAULTS.maxReposPerSuggestion,
    maxSuggestions:
      options.maxSuggestions ?? TEMPLATE_SUGGEST_DEFAULTS.maxSuggestions,
  });
  const debugLog = await createTemplateSuggestionDebugLog({
    cwd,
    now,
    config,
  });

  await withStatusPhase(
    "debug-log",
    "Writing AI input debug log",
    { heartbeatMs, onStatus },
    () => writeTemplateSuggestionInputLog(debugLog, aiInput),
  );

  let suggestions: TemplateSuggestion[];
  try {
    suggestions = await withStatusPhase(
      "ai-analysis",
      "Asking AI provider for template suggestions",
      { heartbeatMs, onStatus },
      () =>
        (options.generateJson ?? generateJson)<TemplateSuggestion[]>({
          prompt: aiInput.prompt,
          cwd,
          config,
          timeoutMs: aiTimeoutMs,
          onRawText: (text) => writeTemplateSuggestionOutputLog(debugLog, text),
          validate: (value) =>
            validateTemplateSuggestionResponse(value, {
              existingTemplates: evidence.existingTemplates,
              maxReposPerSuggestion:
                options.maxReposPerSuggestion ??
                TEMPLATE_SUGGEST_DEFAULTS.maxReposPerSuggestion,
              maxSuggestions:
                options.maxSuggestions ??
                TEMPLATE_SUGGEST_DEFAULTS.maxSuggestions,
            }),
        }),
    );
  } catch (error) {
    throw new TemplateSuggestionError(getErrorMessage(error), {
      logDir: debugLog.dir,
      cause: error,
    });
  }

  onStatus?.({
    phase: "validation",
    status: "completed",
    message: `Validated ${suggestions.length} template suggestion${suggestions.length === 1 ? "" : "s"}`,
  });

  return { suggestions, evidence, logDir: debugLog.dir };
}

export async function collectTemplateSuggestionEvidence(
  options: SuggestTemplatesOptions = {},
): Promise<TemplateSuggestionEvidencePacket> {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const commandRunner = options.commandRunner ?? runCommand;
  const onStatus = options.onStatus;
  const heartbeatMs =
    options.heartbeatMs ?? TEMPLATE_SUGGEST_DEFAULTS.heartbeatMs;
  const lookbackDays =
    options.lookbackDays ?? TEMPLATE_SUGGEST_DEFAULTS.lookbackDays;
  const since = dateOnly(daysBefore(now, lookbackDays));

  const githubUser = await withStatusPhase(
    "github-user",
    "Checking GitHub CLI authentication",
    { heartbeatMs, onStatus },
    () => getGithubUser(commandRunner, cwd),
  );

  const [templates, cachedRepositories] = await Promise.all([
    listTemplates(),
    listCachedRepositories(),
  ]);

  const pullRequests = (
    await Promise.all(
      ROLE_ORDER.map((role) =>
        withStatusPhase(
          "pr-search",
          `Searching ${role} pull requests since ${since}`,
          { heartbeatMs, onStatus },
          () =>
            searchPullRequests({
              role,
              githubUser,
              since,
              cwd,
              commandRunner,
              limit:
                options.maxPrsPerRole ??
                TEMPLATE_SUGGEST_DEFAULTS.maxPrsPerRole,
            }),
        ),
      ),
    )
  ).flat();

  const compacted = await withStatusPhase(
    "evidence-compaction",
    "Compacting GitHub and Workforest evidence",
    { heartbeatMs, onStatus },
    () =>
      Promise.resolve(
        compactTemplateSuggestionEvidence(
          {
            generatedAt: now.toISOString(),
            githubUser,
            lookbackDays,
            since,
            existingTemplates: templates,
            cachedRepositories,
            pullRequests,
          },
          {
            maxCachedRepositories:
              options.maxCachedRepositories ??
              TEMPLATE_SUGGEST_DEFAULTS.maxCachedRepositories,
            maxExistingTemplates:
              options.maxExistingTemplates ??
              TEMPLATE_SUGGEST_DEFAULTS.maxExistingTemplates,
            maxTotalPullRequests:
              options.maxTotalPullRequests ??
              TEMPLATE_SUGGEST_DEFAULTS.maxTotalPullRequests,
          },
        ),
      ),
  );

  return enrichPullRequestPaths(compacted, {
    cwd,
    commandRunner,
    heartbeatMs,
    maxPathEnrichments:
      options.maxPathEnrichments ??
      TEMPLATE_SUGGEST_DEFAULTS.maxPathEnrichments,
    onStatus,
  });
}

export function compactTemplateSuggestionEvidence(
  input: Readonly<{
    generatedAt: string;
    githubUser: string;
    lookbackDays: number;
    since: string;
    existingTemplates: readonly Template[];
    cachedRepositories: readonly CachedRepository[];
    pullRequests: readonly RawPullRequestEvidence[];
  }>,
  limits: Readonly<{
    maxCachedRepositories: number;
    maxExistingTemplates: number;
    maxTotalPullRequests: number;
  }>,
): TemplateSuggestionEvidencePacket {
  const existingTemplates = input.existingTemplates
    .slice(0, limits.maxExistingTemplates)
    .map(templateToEvidence);
  const cachedRepositories = input.cachedRepositories
    .slice(0, limits.maxCachedRepositories)
    .map(cachedRepositoryToEvidence);
  const pullRequests = compactPullRequests(input.pullRequests).slice(
    0,
    limits.maxTotalPullRequests,
  );
  const repositoriesSeenInPullRequests = [
    ...new Set(pullRequests.map((pullRequest) => pullRequest.repository)),
  ].sort((left, right) => left.localeCompare(right));

  return {
    generatedAt: input.generatedAt,
    githubUser: input.githubUser,
    lookbackDays: input.lookbackDays,
    since: input.since,
    existingTemplates,
    cachedRepositories,
    pullRequests,
    summary: {
      existingTemplateCount: input.existingTemplates.length,
      cachedRepositoryCount: input.cachedRepositories.length,
      pullRequestCount: pullRequests.length,
      repositoriesSeenInPullRequests,
    },
  };
}

export function buildTemplateSuggestionAiInput(
  evidence: TemplateSuggestionEvidencePacket,
  options: Readonly<{ maxReposPerSuggestion: number; maxSuggestions: number }>,
): TemplateSuggestionAiInput {
  const schema = templateSuggestionJsonSchema(options);
  const prompt = [
    "You are helping Workforest suggest reusable workspace templates from GitHub PR history.",
    "Return only JSON. Do not include Markdown fences or explanation outside the JSON object.",
    "",
    "Recommend one or more templates that would be useful for future multi-repository work.",
    "Use lowercase hyphenated template ids. Prefer stable org/repo repository specifiers already present in the evidence.",
    "Avoid suggestions that duplicate existing template ids or existing template repository sets.",
    `Each suggestion must include 1-${options.maxReposPerSuggestion} repositories.`,
    "",
    "Required JSON shape:",
    JSON.stringify(schema, null, 2),
    "",
    "Evidence packet:",
    JSON.stringify(evidence, null, 2),
  ].join("\n");

  return { schema, prompt, evidence };
}

export function validateTemplateSuggestionResponse(
  value: unknown,
  context: Readonly<{
    existingTemplates: readonly ExistingTemplateEvidence[];
    maxReposPerSuggestion?: number;
    maxSuggestions?: number;
  }>,
): TemplateSuggestion[] {
  if (!isRecord(value)) {
    throw new Error("AI response must be a JSON object.");
  }

  const rawSuggestions = value["suggestions"];
  if (!Array.isArray(rawSuggestions)) {
    throw new Error('AI response must include a "suggestions" array.');
  }
  if (rawSuggestions.length === 0) {
    throw new Error("AI response did not include any template suggestions.");
  }

  const maxSuggestions =
    context.maxSuggestions ?? TEMPLATE_SUGGEST_DEFAULTS.maxSuggestions;
  if (rawSuggestions.length > maxSuggestions) {
    throw new Error(
      `AI response included ${rawSuggestions.length} suggestions, but the maximum is ${maxSuggestions}.`,
    );
  }

  const existingIds = new Set(
    context.existingTemplates.map((template) => template.id.toLowerCase()),
  );
  const existingRepoSets = new Map(
    context.existingTemplates.map((template) => [
      normalizedRepoSetKey(template.repos),
      template.id,
    ]),
  );
  const seenIds = new Set<string>();
  const suggestions: TemplateSuggestion[] = [];

  for (let index = 0; index < rawSuggestions.length; index += 1) {
    const suggestion = rawSuggestions[index];
    if (!isRecord(suggestion)) {
      throw new Error(`Suggestion ${index + 1} must be an object.`);
    }

    const id = requiredString(suggestion["id"], `suggestions[${index}].id`);
    try {
      validateTemplateName(id);
    } catch (error) {
      throw new Error(`Invalid template id "${id}": ${getErrorMessage(error)}`);
    }

    const normalizedId = id.toLowerCase();
    if (seenIds.has(normalizedId)) {
      throw new Error(`AI response suggested duplicate template id "${id}".`);
    }
    if (existingIds.has(normalizedId)) {
      throw new Error(`Template "${id}" already exists.`);
    }
    seenIds.add(normalizedId);

    const description = requiredString(
      suggestion["description"],
      `suggestions[${index}].description`,
    );
    const repos = requiredStringArrayPreservingDuplicates(
      suggestion["repos"],
      `suggestions[${index}].repos`,
    );
    validateSuggestionRepos(id, repos, {
      maxRepos:
        context.maxReposPerSuggestion ??
        TEMPLATE_SUGGEST_DEFAULTS.maxReposPerSuggestion,
    });

    const repoSetKey = normalizedRepoSetKey(repos);
    const existingTemplateId = existingRepoSets.get(repoSetKey);
    if (existingTemplateId) {
      throw new Error(
        `Suggestion "${id}" duplicates the repository set from existing template "${existingTemplateId}".`,
      );
    }

    const confidence = suggestion["confidence"];
    if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
      throw new Error(`suggestions[${index}].confidence must be a number.`);
    }
    if (confidence < 0 || confidence > 1) {
      throw new Error(
        `suggestions[${index}].confidence must be between 0 and 1.`,
      );
    }

    const evidenceNotes = requiredStringArray(
      suggestion["evidenceNotes"],
      `suggestions[${index}].evidenceNotes`,
    );

    suggestions.push({
      id,
      description,
      repos,
      confidence,
      evidenceNotes,
    });
  }

  return suggestions;
}

export async function createTemplateSuggestionDebugLog(
  options: Readonly<{
    cwd: string;
    now: Date;
    config?: WorkspaceConfig;
  }>,
): Promise<TemplateSuggestionDebugLog> {
  const root = resolveTemplateSuggestionDebugRoot(
    path.resolve(options.cwd),
    options.config ?? {},
  );
  const dir = path.join(
    root,
    TEMPLATE_SUGGEST_LOG_ROOT,
    safeTimestamp(options.now),
  );
  await ensureDir(dir);
  return {
    dir,
    inputPath: path.join(dir, "input.json"),
    outputPath: path.join(dir, "output.txt"),
  };
}

export async function writeTemplateSuggestionInputLog(
  debugLog: TemplateSuggestionDebugLog,
  input: TemplateSuggestionAiInput,
): Promise<void> {
  await fs.writeFile(debugLog.inputPath, `${JSON.stringify(input, null, 2)}\n`);
}

export async function writeTemplateSuggestionOutputLog(
  debugLog: TemplateSuggestionDebugLog,
  output: string,
): Promise<void> {
  await fs.writeFile(debugLog.outputPath, output, "utf8");
}

export async function saveTemplateSuggestions(
  suggestions: readonly TemplateSuggestion[],
): Promise<TemplateSuggestionSaveResult> {
  const saved: TemplateSuggestion[] = [];
  const skipped: Array<{ suggestion: TemplateSuggestion; reason: string }> = [];

  for (const suggestion of suggestions) {
    const existing = await listTemplates().then((templates) =>
      templates.find((template) => template.id === suggestion.id),
    );
    if (existing) {
      skipped.push({
        suggestion,
        reason: `Template "${suggestion.id}" already exists.`,
      });
      continue;
    }

    const config: TemplateConfig = {
      repos: suggestion.repos,
      description: suggestion.description,
    };
    await createTemplate(suggestion.id, config);
    saved.push(suggestion);
  }

  return { saved, skipped };
}

function requireAiProvider(status: AiStatus): void {
  if (status.disabled) {
    throw new AiUnavailableError(
      "AI features are disabled. Enable AI or unset WORKFOREST_AI_DISABLED.",
    );
  }
  if (!status.selectedProvider) {
    throw new AiUnavailableError(
      status.setupHint ??
        "No usable AI provider is available. Install and authenticate Codex CLI or Claude Code.",
    );
  }
}

async function getGithubUser(
  commandRunner: CommandRunner,
  cwd: string,
): Promise<string> {
  try {
    const { stdout } = await commandRunner(
      "gh",
      ["api", "user", "--jq", ".login"],
      {
        cwd,
        timeout: 30_000,
      },
    );
    const login = stdout.trim();
    if (!login) {
      throw new Error("GitHub CLI did not return an authenticated login.");
    }
    return login;
  } catch (error) {
    throw new Error(
      [
        "GitHub CLI is required and must be authenticated to inspect PR history.",
        "Run: gh auth login",
        `Details: ${getErrorMessage(error)}`,
      ].join("\n"),
    );
  }
}

async function searchPullRequests(
  options: Readonly<{
    role: TemplateEvidenceRole;
    githubUser: string;
    since: string;
    cwd: string;
    commandRunner: CommandRunner;
    limit: number;
  }>,
): Promise<RawPullRequestEvidence[]> {
  const args = [
    "search",
    "prs",
    "--archived=false",
    "--updated",
    `>=${options.since}`,
    "--sort",
    "updated",
    "--order",
    "desc",
    "--limit",
    String(options.limit),
    "--json",
    "repository,number,title,url,labels,createdAt,closedAt,updatedAt",
    ...roleSearchArgs(options.role, options.githubUser),
  ];

  const { stdout } = await options.commandRunner("gh", args, {
    cwd: options.cwd,
    timeout: 60_000,
  });
  const parsed = parseJsonArray(stdout, `gh ${args.join(" ")}`);
  return parsed.flatMap((value) => parseSearchPullRequest(value, options.role));
}

function roleSearchArgs(
  role: TemplateEvidenceRole,
  githubUser: string,
): string[] {
  switch (role) {
    case "authored":
      return ["--author", githubUser];
    case "reviewed":
      return ["--reviewed-by", githubUser];
    case "commented":
      return ["--commenter", githubUser];
  }
}

function parseSearchPullRequest(
  value: unknown,
  role: TemplateEvidenceRole,
): RawPullRequestEvidence[] {
  if (!isRecord(value)) {
    return [];
  }

  const repository = repositoryNameFromGhValue(value["repository"]);
  const number = typeof value["number"] === "number" ? value["number"] : null;
  if (!repository || !number) {
    return [];
  }

  const title = typeof value["title"] === "string" ? value["title"] : null;
  const url = typeof value["url"] === "string" ? value["url"] : null;
  const createdAt =
    typeof value["createdAt"] === "string" ? value["createdAt"] : null;
  const closedAt =
    typeof value["closedAt"] === "string" ? value["closedAt"] : null;
  const updatedAt =
    typeof value["updatedAt"] === "string" ? value["updatedAt"] : null;

  return [
    {
      role,
      repository,
      number,
      title,
      url,
      labels: labelsFromGhValue(value["labels"]),
      createdAt,
      closedAt,
      updatedAt,
    },
  ];
}

async function enrichPullRequestPaths(
  evidence: TemplateSuggestionEvidencePacket,
  options: Readonly<{
    cwd: string;
    commandRunner: CommandRunner;
    heartbeatMs: number;
    maxPathEnrichments: number;
    onStatus?: ((event: TemplateSuggestionStatusEvent) => void) | undefined;
  }>,
): Promise<TemplateSuggestionEvidencePacket> {
  const enrichedPullRequests = [...evidence.pullRequests];
  const count = Math.min(
    options.maxPathEnrichments,
    enrichedPullRequests.length,
  );

  for (let index = 0; index < count; index += 1) {
    const pullRequest = enrichedPullRequests[index];
    if (!pullRequest?.url) {
      continue;
    }

    const detail = await withStatusPhase(
      "path-enrichment",
      `Enriching PR paths ${index + 1}/${count}: ${pullRequest.repository}#${pullRequest.number}`,
      {
        heartbeatMs: options.heartbeatMs,
        onStatus: options.onStatus,
        warnOnly: true,
      },
      () => fetchPullRequestDetail(pullRequest.url ?? "", options),
    );

    if (!detail) {
      continue;
    }

    enrichedPullRequests[index] = {
      ...pullRequest,
      ...(detail.mergedAt ? { mergedAt: detail.mergedAt } : {}),
      ...(detail.touchedPaths.length > 0
        ? {
            touchedPaths: detail.touchedPaths.slice(0, 12),
            pathSummary: summarizePaths(detail.touchedPaths),
          }
        : {}),
    };
  }

  return {
    ...evidence,
    pullRequests: enrichedPullRequests,
  };
}

async function fetchPullRequestDetail(
  url: string,
  options: Readonly<{ cwd: string; commandRunner: CommandRunner }>,
): Promise<{ touchedPaths: string[]; mergedAt?: string } | null> {
  try {
    const { stdout } = await options.commandRunner(
      "gh",
      ["pr", "view", url, "--json", "files,mergedAt"],
      {
        cwd: options.cwd,
        timeout: 30_000,
      },
    );
    const parsed = parseJsonObject(stdout, `gh pr view ${url}`);
    const files = parsed["files"];
    const touchedPaths = Array.isArray(files)
      ? files.flatMap((file) =>
          isRecord(file) && typeof file["path"] === "string"
            ? [file["path"]]
            : [],
        )
      : [];
    const mergedAt =
      typeof parsed["mergedAt"] === "string" ? parsed["mergedAt"] : undefined;
    return { touchedPaths, ...(mergedAt ? { mergedAt } : {}) };
  } catch {
    return null;
  }
}

function compactPullRequests(
  pullRequests: readonly RawPullRequestEvidence[],
): PullRequestEvidence[] {
  const byKey = new Map<string, PullRequestEvidence>();

  for (const raw of pullRequests) {
    const repository = raw.repository?.trim();
    const number = raw.number;
    if (!repository || typeof number !== "number") {
      continue;
    }

    const url = raw.url?.trim();
    const key = url || `${repository}#${number}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.roles = mergeRoles(existing.roles, [raw.role]);
      existing.labels = mergeStrings(existing.labels, raw.labels ?? []);
      const touchedPaths = mergeOptionalStrings(
        existing.touchedPaths,
        raw.touchedPaths,
      );
      assignOptional(existing, "touchedPaths", touchedPaths);
      assignOptional(
        existing,
        "createdAt",
        earlierDate(existing.createdAt, raw.createdAt),
      );
      assignOptional(
        existing,
        "closedAt",
        latestDate(existing.closedAt, raw.closedAt),
      );
      assignOptional(
        existing,
        "mergedAt",
        latestDate(existing.mergedAt, raw.mergedAt),
      );
      assignOptional(
        existing,
        "updatedAt",
        latestDate(existing.updatedAt, raw.updatedAt),
      );
      if (!existing.pathSummary && existing.touchedPaths) {
        existing.pathSummary = summarizePaths(existing.touchedPaths);
      }
      continue;
    }

    const touchedPaths = normalizeStringArray(raw.touchedPaths ?? []);
    byKey.set(key, {
      repository,
      number,
      title: raw.title?.trim() || "(untitled pull request)",
      ...(url ? { url } : {}),
      roles: [raw.role],
      labels: normalizeStringArray(raw.labels ?? []),
      ...(raw.createdAt ? { createdAt: raw.createdAt } : {}),
      ...(raw.closedAt ? { closedAt: raw.closedAt } : {}),
      ...(raw.mergedAt ? { mergedAt: raw.mergedAt } : {}),
      ...(raw.updatedAt ? { updatedAt: raw.updatedAt } : {}),
      ...(touchedPaths.length > 0
        ? {
            touchedPaths,
            pathSummary: summarizePaths(touchedPaths),
          }
        : {}),
    });
  }

  return [...byKey.values()].sort(comparePullRequests);
}

function comparePullRequests(
  left: PullRequestEvidence,
  right: PullRequestEvidence,
): number {
  return (
    dateValue(right.updatedAt ?? right.mergedAt ?? right.closedAt) -
    dateValue(left.updatedAt ?? left.mergedAt ?? left.closedAt)
  );
}

function templateToEvidence(template: Template): ExistingTemplateEvidence {
  return {
    id: template.id,
    ...(template.config.description
      ? { description: template.config.description }
      : {}),
    repos: template.config.repos,
  };
}

function cachedRepositoryToEvidence(
  repository: CachedRepository,
): CachedRepositoryEvidence {
  return {
    name: repository.name,
    specifier: repositoryDisplayName(repository),
    ...(repository.remote ? { remote: repository.remote } : {}),
  };
}

function resolveTemplateSuggestionDebugRoot(
  cwd: string,
  config: WorkspaceConfig,
): string {
  const directories = resolveWorkforestDirectories(config);
  const context = resolveWorkforestContext(cwd, directories);

  switch (context.kind) {
    case "repository-change":
      return path.join(
        path.dirname(context.path),
        ".workforest",
        context.changeName,
      );
    case "workspace-repo":
      return path.join(context.workspacePath, ".workforest");
    case "template-workspace-change":
    case "adhoc-workspace-change":
    case "review-checkout":
      return path.join(context.path, ".workforest");
    case "nested-task":
      return context.parentKind === "repository-change"
        ? path.join(
            directories.repos,
            context.repoName,
            ".workforest",
            context.changeName,
            "tasks",
            context.taskName,
          )
        : path.join(
            directories.workspaces,
            context.groupName ?? "",
            context.changeName,
            ".workforest",
            "tasks",
            context.repoName,
            context.taskName,
          );
    case "outside-workforest":
      return path.join(cwd, ".workforest");
  }
}

async function withStatusPhase<T>(
  phase: TemplateSuggestionPhase,
  message: string,
  options: Readonly<{
    heartbeatMs: number;
    onStatus?: ((event: TemplateSuggestionStatusEvent) => void) | undefined;
    warnOnly?: boolean;
  }>,
  task: () => Promise<T>,
): Promise<T> {
  options.onStatus?.({ phase, status: "started", message });
  const timer = setInterval(() => {
    options.onStatus?.({
      phase,
      status: "heartbeat",
      message: `${message} still running...`,
    });
  }, options.heartbeatMs);

  try {
    const result = await task();
    options.onStatus?.({ phase, status: "completed", message });
    return result;
  } catch (error) {
    if (options.warnOnly) {
      options.onStatus?.({
        phase,
        status: "warning",
        message: `${message} failed: ${getErrorMessage(error)}`,
      });
      return undefined as T;
    }
    throw error;
  } finally {
    clearInterval(timer);
  }
}

function templateSuggestionJsonSchema(
  options: Readonly<{ maxReposPerSuggestion: number; maxSuggestions: number }>,
): TemplateSuggestionJsonSchema {
  return {
    type: "object",
    required: ["suggestions"],
    properties: {
      suggestions: {
        type: "array",
        minItems: 1,
        maxItems: options.maxSuggestions,
        items: {
          type: "object",
          required: [
            "id",
            "description",
            "repos",
            "confidence",
            "evidenceNotes",
          ],
          properties: {
            id: { type: "string" },
            description: { type: "string" },
            repos: {
              type: "array",
              minItems: 1,
              maxItems: options.maxReposPerSuggestion,
              items: { type: "string" },
            },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            evidenceNotes: {
              type: "array",
              minItems: 1,
              items: { type: "string" },
            },
          },
        },
      },
    },
  };
}

function validateSuggestionRepos(
  id: string,
  repos: readonly string[],
  options: Readonly<{ maxRepos: number }>,
): void {
  if (repos.length === 0) {
    throw new Error(`Suggestion "${id}" must include at least one repository.`);
  }
  if (repos.length > options.maxRepos) {
    throw new Error(
      `Suggestion "${id}" includes ${repos.length} repositories, but the maximum is ${options.maxRepos}.`,
    );
  }

  const seen = new Set<string>();
  for (const repo of repos) {
    if (!isRepoSlug(repo)) {
      throw new Error(
        `Suggestion "${id}" includes invalid repository specifier "${repo}". Expected "org/repo" or a git URL.`,
      );
    }

    const normalized = repo.toLowerCase();
    if (seen.has(normalized)) {
      throw new Error(
        `Suggestion "${id}" includes duplicate repository "${repo}".`,
      );
    }
    seen.add(normalized);
  }
}

function parseJsonArray(raw: string, context: string): unknown[] {
  const value = parseJson(raw, context);
  if (!Array.isArray(value)) {
    throw new Error(`${context} returned JSON that was not an array.`);
  }
  return value;
}

function parseJsonObject(
  raw: string,
  context: string,
): Record<string, unknown> {
  const value = parseJson(raw, context);
  if (!isRecord(value)) {
    throw new Error(`${context} returned JSON that was not an object.`);
  }
  return value;
}

function parseJson(raw: string, context: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${context} returned invalid JSON: ${getErrorMessage(error)}`,
    );
  }
}

function repositoryNameFromGhValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value["nameWithOwner"] === "string") {
    return value["nameWithOwner"];
  }

  const name = typeof value["name"] === "string" ? value["name"] : null;
  const owner = value["owner"];
  if (!name || !isRecord(owner)) {
    return null;
  }
  const ownerLogin =
    typeof owner["login"] === "string"
      ? owner["login"]
      : typeof owner["name"] === "string"
        ? owner["name"]
        : null;
  return ownerLogin ? `${ownerLogin}/${name}` : null;
}

function labelsFromGhValue(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return normalizeStringArray(
    value.flatMap((label) => {
      if (typeof label === "string") {
        return [label];
      }
      if (isRecord(label) && typeof label["name"] === "string") {
        return [label["name"]];
      }
      return [];
    }),
  );
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function requiredStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings.`);
  }
  const normalized = normalizeStringArray(value);
  if (normalized.length === 0) {
    throw new Error(`${label} must include at least one value.`);
  }
  return normalized;
}

function requiredStringArrayPreservingDuplicates(
  value: unknown,
  label: string,
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings.`);
  }
  const normalized = value.flatMap((item) =>
    typeof item === "string" && item.trim() ? [item.trim()] : [],
  );
  if (normalized.length === 0) {
    throw new Error(`${label} must include at least one value.`);
  }
  if (normalized.length !== value.length) {
    throw new Error(`${label} must contain only non-empty strings.`);
  }
  return normalized;
}

function normalizeStringArray(values: readonly unknown[]): string[] {
  return [
    ...new Set(
      values.flatMap((value) =>
        typeof value === "string" && value.trim() ? [value.trim()] : [],
      ),
    ),
  ];
}

function mergeOptionalStrings(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): string[] | undefined {
  const merged = mergeStrings(left ?? [], right ?? []);
  return merged.length > 0 ? merged : undefined;
}

function mergeStrings(
  left: readonly string[],
  right: readonly string[],
): string[] {
  return normalizeStringArray([...left, ...right]);
}

function mergeRoles(
  left: readonly TemplateEvidenceRole[],
  right: readonly TemplateEvidenceRole[],
): TemplateEvidenceRole[] {
  const roles = new Set([...left, ...right]);
  return ROLE_ORDER.filter((role) => roles.has(role));
}

function summarizePaths(paths: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const filePath of normalizeStringArray(paths)) {
    const [first, second] = filePath.split("/");
    const bucket = second ? (first ?? filePath) : "(root)";
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )
    .slice(0, 5)
    .map(([bucket, count]) => `${bucket} (${count})`)
    .join(", ");
}

function normalizedRepoSetKey(repos: readonly string[]): string {
  return [...new Set(repos.map((repo) => repo.trim().toLowerCase()))]
    .sort((left, right) => left.localeCompare(right))
    .join("\n");
}

function assignOptional<Key extends OptionalPullRequestKey>(
  target: PullRequestEvidence,
  key: Key,
  value: PullRequestEvidence[Key] | undefined,
): void {
  if (value === undefined) {
    delete target[key];
  } else {
    target[key] = value;
  }
}

type OptionalPullRequestKey = {
  [Key in keyof PullRequestEvidence]-?: undefined extends PullRequestEvidence[Key]
    ? Key
    : never;
}[keyof PullRequestEvidence];

function latestDate(
  left: string | undefined,
  right: string | null | undefined,
): string | undefined {
  if (!right) return left;
  if (!left) return right;
  return dateValue(right) > dateValue(left) ? right : left;
}

function earlierDate(
  left: string | undefined,
  right: string | null | undefined,
): string | undefined {
  if (!right) return left;
  if (!left) return right;
  return dateValue(right) < dateValue(left) ? right : left;
}

function dateValue(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function daysBefore(date: Date, days: number): Date {
  return new Date(date.getTime() - days * 24 * 60 * 60 * 1000);
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function safeTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
