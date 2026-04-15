export function normalizeBranchPrefix(
  value: string | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

export function buildBranchName(
  featureName: string,
  branchPrefix: string | undefined,
): string {
  const normalizedPrefix = normalizeBranchPrefix(branchPrefix);
  return normalizedPrefix ? `${normalizedPrefix}${featureName}` : featureName;
}

export function inferBranchPrefix(
  featureBranch: string | undefined,
  featureName: string,
): string {
  if (!featureBranch) {
    return "";
  }

  if (!featureBranch.endsWith(featureName)) {
    return "";
  }

  return normalizeBranchPrefix(featureBranch.slice(0, -featureName.length)) ?? "";
}
