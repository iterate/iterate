// Id + slug helpers, mirroring apps/auth: minted `prj_`/`org_` ids (distinct from slugs), and a slugify
// that matches @iterate-com/shared/slug's normalization (lowercase, non-alphanumeric → dash, trimmed).

export const slugify = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

const hex32 = () => crypto.randomUUID().replaceAll("-", "");

/** `prj_<32hex>` — auth is the only authority that mints project ids (apps/auth). */
export const newProjectId = () => `prj_${hex32()}`;

/** `org_<32hex>`. */
export const newOrgId = () => `org_${hex32()}`;
