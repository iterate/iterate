export function generateSlugFromEmail(email: string): string {
  const domain = email.split("@")[1];
  if (!domain) {
    return email.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  }

  const parts = domain.split(".");
  const tld = parts.at(-1);

  let slug: string;
  if (tld === "com" && parts.length >= 2) {
    slug = parts.slice(0, -1).join(".");
  } else {
    slug = domain;
  }

  return slug.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
}

export function generateProjectSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_.-]/g, "")
    .slice(0, 50);
}
