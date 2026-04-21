import type { Hook, TemplateConfig, WorkspaceConfig } from "../types.ts";
import {
  CancelError,
  cancel,
  intro,
  note,
  outro,
  promptConfirm,
  promptMultiSelect,
  promptSelect,
  promptText,
} from "./prompts/index.ts";

type RenderTemplateEditorOptions = {
  templateId: string;
  initialConfig: TemplateConfig;
  workspaceConfig?: WorkspaceConfig;
  onSave: (config: TemplateConfig) => Promise<void>;
};

function validateRepo(repo: string): string | undefined {
  if (!repo.includes("/")) {
    return "Invalid format: use org/repo or git URL";
  }
  return undefined;
}

function formatConfig(config: TemplateConfig): string {
  return JSON.stringify(config, null, 2);
}

function sortBranchPrefixOptions(
  options: { value: "inherit" | "override" | "disable"; label: string; description: string }[],
  selected: "inherit" | "override" | "disable",
) {
  const selectedOption = options.find((option) => option.value === selected);
  const remaining = options.filter((option) => option.value !== selected);
  return selectedOption ? [selectedOption, ...remaining] : options;
}

export async function renderTemplateEditor({
  templateId,
  initialConfig,
  workspaceConfig,
  onSave,
}: RenderTemplateEditorOptions): Promise<void> {
  intro(`Editing template: ${templateId}`);

  try {
    // Description
    const description = await promptText("Description", {
      placeholder: "(optional)",
      defaultValue: initialConfig.description ?? "",
      throwOnCancel: true,
    });

    // Branch prefix
    const globalBranchPrefix = workspaceConfig?.branchPrefix;
    const initialBranchMode =
      initialConfig.branchPrefix === undefined
        ? "inherit"
        : initialConfig.branchPrefix === ""
          ? "disable"
          : "override";

    const branchPrefixMode = await promptSelect("Branch prefix behavior", {
      options: sortBranchPrefixOptions(
        [
          {
            value: "inherit",
            label: "Use global setting",
            description: globalBranchPrefix
              ? `${globalBranchPrefix}`
              : "(no global prefix)",
          },
          {
            value: "override",
            label: "Override for this template",
            description: "Set a template-specific prefix",
          },
          {
            value: "disable",
            label: "Disable for this template",
            description: "Create branches without any prefix",
          },
        ],
        initialBranchMode,
      ),
      throwOnCancel: true,
    });

    let branchPrefix: string | undefined;
    if (branchPrefixMode === "override") {
      branchPrefix = await promptText("Branch prefix override", {
        placeholder: "feature/",
        defaultValue:
          initialBranchMode === "override"
            ? initialConfig.branchPrefix
            : undefined,
        validate: (value) => {
          if (!value.trim()) {
            return "Branch prefix is required";
          }
          return null;
        },
        throwOnCancel: true,
      });
    } else if (branchPrefixMode === "disable") {
      branchPrefix = "";
    }

    // Repositories
    let repos: string[] = [...initialConfig.repos];

    // If there are existing repos, let user select which to keep
    if (repos.length > 0) {
      repos = await promptMultiSelect("Select repositories to keep", {
        options: repos.map((r) => ({ value: r, label: r })),
        initialValues: repos,
        required: false,
        throwOnCancel: true,
      });
    }

    // Add new repos
    let addMore = repos.length === 0;
    if (!addMore && repos.length > 0) {
      addMore = await promptConfirm("Add more repositories?", false, {
        throwOnCancel: true,
      });
    }

    while (addMore) {
      const repo = await promptText("Repository (org/repo or git URL)", {
        placeholder: "e.g., vercel/next.js or git@gitlab.com:org/repo.git",
        validate: (value) => {
          if (!value) return "Repository is required";
          return validateRepo(value) ?? null;
        },
        throwOnCancel: true,
      });

      repos.push(repo);

      addMore = await promptConfirm("Add another repository?", false, {
        throwOnCancel: true,
      });
    }

    if (repos.length === 0) {
      cancel("At least one repository is required");
      return;
    }

    // Hooks
    const hooks: Hook[] = [...(initialConfig.hooks ?? [])];

    if (hooks.length > 0) {
      note(
        hooks.map((h, i) => `${i + 1}. ${h.name}: ${h.run}`).join("\n"),
        "Current hooks",
      );
    }

    const addHooks = await promptConfirm(
      hooks.length > 0 ? "Add more hooks?" : "Add hooks?",
      false,
      { throwOnCancel: true },
    );

    if (addHooks) {
      let addingHooks = true;
      while (addingHooks) {
        const hookName = await promptText(
          "Hook name (or leave empty to continue)",
          {
            placeholder: "e.g., post-install",
            throwOnCancel: true,
          },
        );

        if (!hookName) {
          addingHooks = false;
          continue;
        }

        const hookRun = await promptText("Hook command", {
          placeholder: "e.g., pnpm build",
          validate: (value) => {
            if (!value) return "Command is required";
            return null;
          },
          throwOnCancel: true,
        });

        hooks.push({ name: hookName, run: hookRun });
      }
    }

    // Build config
    const config: TemplateConfig = {
      repos,
      ...(description && { description }),
      ...(branchPrefix !== undefined && { branchPrefix }),
      ...(hooks.length > 0 && { hooks }),
    };

    // Preview
    note(formatConfig(config), "Preview");

    // Confirm save
    const shouldSave = await promptConfirm("Save template?", true, {
      throwOnCancel: true,
    });

    if (!shouldSave) {
      cancel("Cancelled");
      return;
    }

    await onSave(config);
    outro("Template saved");
  } catch (e) {
    if (e instanceof CancelError) {
      cancel("Cancelled");
      return;
    }
    throw e;
  }
}
