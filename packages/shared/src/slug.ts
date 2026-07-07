const RESERVED_SLUGS = ["prj", "org"];

/**
 * Slugs no organization or project may claim: they collide with well-known
 * email local parts on the deployment's email domain (`<slug>@iterate.app`
 * shares an address space with `bot@iterate.app`, `noreply+auth@...`, etc. —
 * see apps/os/src/domains/email/). Auth slug resolution rejects them for
 * project creation and routes around them for org creation; the OS email
 * ingress checks inbound local parts against the same list.
 */
export const RESERVED_PLATFORM_SLUGS = [
  "bot",
  "admin",
  "administrator",
  "support",
  "help",
  "postmaster",
  "abuse",
  "security",
  "noreply",
  "no-reply",
  "mailer-daemon",
  "root",
  "info",
  "contact",
  "team",
  "hello",
];

export function isReservedPlatformSlug(slug: string): boolean {
  return RESERVED_PLATFORM_SLUGS.includes(slug.toLowerCase());
}

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

export async function resolveUniqueSlug(params: {
  name: string;
  slug?: string;
  isTaken: (slug: string) => Promise<boolean>;
}): Promise<string> {
  const baseSlug = params.slug ? slugify(params.slug) : slugify(params.name);
  return (await params.isTaken(baseSlug)) ? slugifyWithSuffix(baseSlug) : baseSlug;
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
