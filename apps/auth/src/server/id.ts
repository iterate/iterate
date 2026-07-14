/** Mint auth-owned identifiers in the representation stored by the existing schema. */
export function generateId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}
