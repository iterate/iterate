// Reserved slugs that conflict with TypeID prefixes or routes
const RESERVED_SLUGS = ["prj", "org"];

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, "-") // alphanumeric and hyphens only (no dots/underscores)
    .replace(/^-+|-+$/g, "") // trim leading/trailing hyphens
    .replace(/-+/g, "-") // collapse multiple hyphens
    .slice(0, 50);
  // must contain at least one letter (not all numbers), and not be reserved
  if (!slug || !/[a-z]/.test(slug) || RESERVED_SLUGS.includes(slug)) {
    return "unnamed";
  }
  return slug;
}

export function slugifyWithSuffix(name: string): string {
  return `${slugify(name)}-${generateRandomSuffix(6)}`;
}

/**
 * Generate a random alphanumeric string
 */
function generateRandomSuffix(length: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  for (let i = 0; i < length; i++) {
    result += chars[array[i]! % chars.length];
  }
  return result;
}

/**
 * Validate that a slug is URL-safe (alphanumeric and hyphens, contains at least one letter, not reserved)
 */
export function isValidSlug(slug: string): boolean {
  return (
    /^[a-z0-9-]+$/.test(slug) &&
    /[a-z]/.test(slug) &&
    slug.length <= 50 &&
    !RESERVED_SLUGS.includes(slug)
  );
}
