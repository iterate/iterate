export interface SlugifyOptions {
  fallback?: string;
  maxLength?: number;
}

export function slugify(input: string, options: SlugifyOptions = {}) {
  const fallback = options.fallback || "unnamed";
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const resolved = normalized || fallback;

  if (!Number.isFinite(options.maxLength)) {
    return resolved;
  }

  return resolved.slice(0, options.maxLength).replace(/-+$/g, "") || fallback;
}
