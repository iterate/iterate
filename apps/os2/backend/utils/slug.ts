export function generateSlugFromEmail(email: string): string {
  return email
    .replace(/.*?[+@]/, "")
    .replace("@", "__")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "-");
}

export function generateOrgSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${base}-${suffix}`;
}

export function generateProjectSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_.-]/g, "")
    .slice(0, 50);
}
