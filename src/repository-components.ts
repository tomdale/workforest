import path from "node:path";

const REPOSITORY_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validateRepositoryComponent(
  value: string,
  label = "Repository component",
): string {
  if (value.length === 0) {
    throw new Error(`${label} is required.`);
  }
  if (value !== value.trim()) {
    throw new Error(`${label} must not have leading or trailing whitespace.`);
  }
  if (value === "." || value === "..") {
    throw new Error(`${label} must not be "." or "..".`);
  }
  if (hasControlCharacters(value)) {
    throw new Error(`${label} must not contain control characters.`);
  }
  if (
    value.includes("/") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    !REPOSITORY_COMPONENT.test(value)
  ) {
    throw new Error(`Invalid ${label}: ${value}`);
  }

  return value;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}
