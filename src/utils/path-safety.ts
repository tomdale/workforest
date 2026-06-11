import { promises as fs } from "node:fs";
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

export async function assertContainedPathWithoutSymlinks(
  root: string,
  target: string,
): Promise<string> {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = resolveContainedPath(
    resolvedRoot,
    path.relative(resolvedRoot, path.resolve(target)),
  );
  const rootRealPath = await fs.realpath(resolvedRoot);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  const segments = relative ? relative.split(path.sep) : [];
  let current = resolvedRoot;

  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);

    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return resolvedTarget;
      }
      throw error;
    }

    if (stat.isSymbolicLink()) {
      throw new Error(`Path contains a symbolic link: ${current}`);
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`Path ancestor is not a directory: ${current}`);
    }

    const currentRealPath = await fs.realpath(current);
    resolveContainedPath(
      rootRealPath,
      path.relative(rootRealPath, currentRealPath),
    );
  }

  return resolvedTarget;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}
