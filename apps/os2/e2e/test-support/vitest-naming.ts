import { slugify } from "@iterate-com/shared/slugify";

export function createVitestRunSlug(now: Date = new Date()) {
  return slugify(`os2-vitest-run-${formatDateTime(now)}`);
}

export function formatDateTime(date: Date) {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}
