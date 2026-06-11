import path from "node:path";

const WINDOWS_RESERVED_CHARACTERS = /[<>:"/\\|?*]/;

export function validateResourceName(
  value: string,
  label = "Resource name",
): string {
  if (value.length === 0) {
    throw new Error(`${label} is required.`);
  }
  if (value !== value.trim()) {
    throw new Error(`${label} must not have leading or trailing whitespace.`);
  }
  if (hasControlCharacters(value)) {
    throw new Error(`${label} must not contain control characters.`);
  }
  if (
    value === "." ||
    value === ".." ||
    WINDOWS_RESERVED_CHARACTERS.test(value) ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
    throw new Error(`${label} must be a single safe path component.`);
  }
  return value;
}

export function resolveContainedPath(
  root: string,
  ...segments: string[]
): string {
  const resolvedRoot = path.resolve(root);
  const normalizedSegments = segments.map((segment) => {
    if (hasControlCharacters(segment)) {
      throw new Error("Path segments must not contain control characters.");
    }
    if (path.posix.isAbsolute(segment) || path.win32.isAbsolute(segment)) {
      throw new Error(`Path must be relative to ${resolvedRoot}: ${segment}`);
    }
    return segment.replace(/[\\/]/g, path.sep);
  });
  const candidate = path.resolve(resolvedRoot, ...normalizedSegments);
  const relative = path.relative(resolvedRoot, candidate);

  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Path escapes ${resolvedRoot}: ${segments.join("/")}`);
  }

  return candidate;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}
