import { createHash } from "node:crypto";

function slugSafe(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function hashFragment(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 6);
}

export function createSlug(params: { input: string; maxLength?: number }) {
  const normalized = slugSafe(params.input) || "unnamed";
  if (params.maxLength == null) return normalized;

  const maxLength = Math.max(1, params.maxLength);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  const hash = hashFragment(normalized);
  const infix = `--${hash}--`;
  if (maxLength <= hash.length) {
    return hash.slice(0, maxLength);
  }
  if (maxLength <= infix.length) {
    return infix.slice(0, maxLength).replace(/^-+|-+$/g, "") || hash.slice(0, maxLength);
  }

  const remaining = maxLength - infix.length;
  const startLength = Math.ceil(remaining / 2);
  const endLength = Math.floor(remaining / 2);
  const start = normalized.slice(0, startLength).replace(/-+$/g, "");
  const end = normalized.slice(-endLength).replace(/^-+/g, "");

  const candidate = `${start}${infix}${end}`.replace(/---+/g, "--").replace(/^-+|-+$/g, "");
  if (candidate.length <= maxLength) {
    return candidate;
  }

  return candidate.slice(0, maxLength).replace(/-+$/g, "");
}
