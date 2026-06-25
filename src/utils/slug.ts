import { generateText } from "../services/ai/index.ts";

/**
 * Check if a string is already a valid slug.
 * A slug is: lowercase, no spaces, only alphanumeric + hyphens.
 */
export function isSlug(input: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(input);
}

/**
 * Sanitizes a string into a URL-safe slug.
 * - Lowercase
 * - Hyphens instead of spaces
 * - Only alphanumeric and hyphens
 * - Max 40 characters
 */
export function sanitizeSlug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/**
 * Generates a slug from a description using the configured AI provider.
 * Returns null if generation fails or CLI is not available.
 */
export async function generateSlugFromDescription(
  description: string,
): Promise<string | null> {
  const prompt = `Generate a short URL-safe slug (2-4 words, lowercase, hyphenated) for a code workspace with this description: "${description}"

Rules:
- Use only lowercase letters, numbers, and hyphens
- No special characters or spaces
- Maximum 40 characters
- Be concise but descriptive
- Output ONLY the slug, nothing else`;

  try {
    const stdout = await generateText({ prompt });
    const rawSlug = stdout.trim();
    if (!rawSlug) {
      return null;
    }

    const sanitized = sanitizeSlug(rawSlug);
    return sanitized || null;
  } catch {
    // AI slug generation is opportunistic; callers can fall back to sanitizeSlug.
    return null;
  }
}
