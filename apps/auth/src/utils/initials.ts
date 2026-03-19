export function getInitials(name: string): string {
  return name
    .split(/[\s@]/)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join("");
}
