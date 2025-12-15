import { isEmailProviderDomain, TLDS } from "./email-provider-domains.ts";

/**
 * Generate a slug from an email address.
 *
 * Algorithm:
 * - For consumer email providers (gmail.com, yahoo.com, etc.):
 *   → Use the local part (john.doe@gmail.com → "john-doe")
 * - For company domains:
 *   → Use the domain name without TLDs (john@acme.co.uk → "acme")
 *
 * @example
 * generateSlugFromEmail("john.doe@gmail.com")  // "john-doe"
 * generateSlugFromEmail("user@acme.com")       // "acme"
 * generateSlugFromEmail("ceo@company.co.uk")   // "company"
 * generateSlugFromEmail("test@my-startup.io")  // "my-startup"
 */
export function generateSlugFromEmail(email: string): string {
  const [localPart, domain] = email.toLowerCase().split("@");

  if (!domain) {
    return slugify(localPart || "user");
  }

  if (isEmailProviderDomain(domain)) {
    return slugify(localPart);
  }

  return slugifyDomain(domain);
}

/**
 * Slugify a string by:
 * - Converting to lowercase
 * - Replacing non-alphanumeric chars with hyphens
 * - Collapsing multiple hyphens
 * - Trimming leading/trailing hyphens
 */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Extract the company name from a domain and slugify it.
 * Strips TLDs (including compound ones like .co.uk).
 *
 * @example
 * slugifyDomain("acme.com")       // "acme"
 * slugifyDomain("company.co.uk")  // "company"
 * slugifyDomain("my-startup.io")  // "my-startup"
 * slugifyDomain("sub.domain.org") // "sub-domain"
 */
function slugifyDomain(domain: string): string {
  const parts = domain.split(".");

  const nonTldParts: string[] = [];
  for (let i = parts.length - 1; i >= 0; i--) {
    if (TLDS.has(parts[i])) {
      continue;
    }
    nonTldParts.unshift(parts[i]);
  }

  if (nonTldParts.length === 0) {
    return slugify(parts[0] || "company");
  }

  return slugify(nonTldParts.join("-"));
}

/**
 * Generate a unique slug by appending a numeric suffix if needed.
 * Used when the base slug is already taken.
 *
 * @example
 * generateUniqueSlug("acme", async (s) => s === "acme") // "acme-2"
 * generateUniqueSlug("acme", async (s) => s === "acme" || s === "acme-2") // "acme-3"
 */
export async function generateUniqueSlug(
  baseSlug: string,
  isSlugTaken: (slug: string) => Promise<boolean>,
): Promise<string> {
  if (!(await isSlugTaken(baseSlug))) {
    return baseSlug;
  }

  let suffix = 2;
  while (await isSlugTaken(`${baseSlug}-${suffix}`)) {
    suffix++;
    if (suffix > 1000) {
      throw new Error(`Unable to generate unique slug for base: ${baseSlug}`);
    }
  }

  return `${baseSlug}-${suffix}`;
}
