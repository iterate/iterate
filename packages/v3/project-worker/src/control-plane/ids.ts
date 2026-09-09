// Id + slug helpers: a minted `org_` id, and a slugify that matches @iterate-com/shared/slug's
// normalization (lowercase, non-alphanumeric → dash, trimmed). A PROJECT has no minted id — its slug
// IS its id (directory.ts); an org has no slug at all.

export const slugify = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

/** `org_<32hex>`. */
export const newOrgId = () => `org_${crypto.randomUUID().replaceAll("-", "")}`;
