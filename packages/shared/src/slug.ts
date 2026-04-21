const RESERVED_SLUGS = ["prj", "org"];

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 50);

  if (!slug || !/[a-z]/.test(slug) || RESERVED_SLUGS.includes(slug)) {
    return "unnamed";
  }

  return slug;
}

export function slugifyWithSuffix(name: string): string {
  return `${slugify(name)}-${generateRandomSuffix(6)}`;
}

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
