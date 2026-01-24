import * as p from "@clack/prompts";
import type { Hook, TemplateConfig } from "../types.ts";

type RenderTemplateEditorOptions = {
  templateId: string;
  initialConfig: TemplateConfig;
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

export async function renderTemplateEditor({
  templateId,
  initialConfig,
  onSave,
}: RenderTemplateEditorOptions): Promise<void> {
  p.intro(`Editing template: ${templateId}`);

  // Description
  const description = await p.text({
    message: "Description",
    placeholder: "(optional)",
    initialValue: initialConfig.description ?? "",
  });

  if (p.isCancel(description)) {
    p.cancel("Cancelled");
    return;
  }

  // Branch prefix
  const branchPrefix = await p.text({
    message: "Branch prefix",
    placeholder: "(optional)",
    initialValue: initialConfig.branchPrefix ?? "",
  });

  if (p.isCancel(branchPrefix)) {
    p.cancel("Cancelled");
    return;
  }

  // Repositories
  let repos: string[] = [...initialConfig.repos];

  // If there are existing repos, let user select which to keep
  if (repos.length > 0) {
    const keepRepos = await p.multiselect({
      message: "Select repositories to keep",
      options: repos.map((r) => ({ value: r, label: r })),
      initialValues: repos,
      required: false,
    });

    if (p.isCancel(keepRepos)) {
      p.cancel("Cancelled");
      return;
    }

    repos = keepRepos;
  }

  // Add new repos
  let addMore = repos.length === 0;
  if (!addMore && repos.length > 0) {
    const wantMore = await p.confirm({
      message: "Add more repositories?",
      initialValue: false,
    });
    if (p.isCancel(wantMore)) {
      p.cancel("Cancelled");
      return;
    }
    addMore = wantMore;
  }

  while (addMore) {
    const repo = await p.text({
      message: "Repository (org/repo or git URL)",
      placeholder: "e.g., vercel/next.js or git@gitlab.com:org/repo.git",
      validate: (value) => {
        if (!value) return "Repository is required";
        return validateRepo(value);
      },
    });

    if (p.isCancel(repo)) {
      p.cancel("Cancelled");
      return;
    }

    repos.push(repo);

    const continueAdding = await p.confirm({
      message: "Add another repository?",
      initialValue: false,
    });

    if (p.isCancel(continueAdding)) {
      p.cancel("Cancelled");
      return;
    }

    addMore = continueAdding;
  }

  if (repos.length === 0) {
    p.cancel("At least one repository is required");
    return;
  }

  // Hooks
  const hooks: Hook[] = [...(initialConfig.hooks ?? [])];

  if (hooks.length > 0) {
    p.note(
      hooks.map((h, i) => `${i + 1}. ${h.name}: ${h.run}`).join("\n"),
      "Current hooks",
    );
  }

  const addHooks = await p.confirm({
    message: hooks.length > 0 ? "Add more hooks?" : "Add hooks?",
    initialValue: false,
  });

  if (p.isCancel(addHooks)) {
    p.cancel("Cancelled");
    return;
  }

  if (addHooks) {
    let addingHooks = true;
    while (addingHooks) {
      const hookName = await p.text({
        message: "Hook name (or leave empty to continue)",
        placeholder: "e.g., post-install",
      });

      if (p.isCancel(hookName)) {
        p.cancel("Cancelled");
        return;
      }

      if (!hookName) {
        addingHooks = false;
        continue;
      }

      const hookRun = await p.text({
        message: "Hook command",
        placeholder: "e.g., pnpm build",
        validate: (value) => {
          if (!value) return "Command is required";
          return undefined;
        },
      });

      if (p.isCancel(hookRun)) {
        p.cancel("Cancelled");
        return;
      }

      hooks.push({ name: hookName, run: hookRun });
    }
  }

  // Build config
  const config: TemplateConfig = {
    repos,
    description: description || undefined,
    branchPrefix: branchPrefix || undefined,
    hooks: hooks.length > 0 ? hooks : undefined,
  };

  // Preview
  p.note(formatConfig(config), "Preview");

  // Confirm save
  const shouldSave = await p.confirm({
    message: "Save template?",
    initialValue: true,
  });

  if (p.isCancel(shouldSave) || !shouldSave) {
    p.cancel("Cancelled");
    return;
  }

  await onSave(config);
  p.outro("Template saved");
}
