/**
 * Generate a URL-safe slug from a name with a random suffix
 *
 * @example
 * generateSlug("My Organization") // "my-organization-a1b2c3"
 * generateSlug("Test Instance") // "test-instance-x9y8z7"
 */
export function generateSlug(name: string): string {
  // Convert to lowercase and replace non-alphanumeric chars with hyphens
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") // Remove leading/trailing hyphens
    .slice(0, 50); // Limit base length

  // Generate a random 6-character suffix
  const suffix = generateRandomSuffix(6);

  return `${base}-${suffix}`;
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
 * Validate that a slug is URL-safe
 */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}
