/** Stable, legible per-author hue (agents get the platform violet). */
export function authorColor(clientId: string, alpha = 0.35): string {
  if (clientId === "external") return `hsla(262, 83%, 58%, ${alpha})`;
  let hash = 0;
  for (const char of clientId) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return `hsla(${((hash % 360) + 360) % 360}, 70%, 45%, ${alpha})`;
}

/** Human name for an attributed change or live cursor. */
export function authorLabel(clientId: string): string {
  if (clientId === "external") return "agent";
  const named = /^u-(.+)-[a-z0-9]+$/.exec(clientId);
  if (named) return named[1]!.replaceAll("-", " ");
  return "someone";
}
