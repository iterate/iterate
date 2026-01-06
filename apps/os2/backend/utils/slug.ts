export function generateSlugFromEmail(email: string): string {
  const domain = email.split("@")[1];
  if (!domain) {
    return "default";
  }

  let slug = domain;

  if (slug.endsWith(".com")) {
    slug = slug.slice(0, -4);
  }

  slug = slug
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return slug || "default";
}

export function generateSlugFromName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "default"
  );
}

export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*[a-z0-9]$|^[a-z0-9]$/.test(slug);
}
