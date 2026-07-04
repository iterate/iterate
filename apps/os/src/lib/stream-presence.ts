// Presence helpers shared by the stream header chrome and the processors panel.

import type { AgentUiPresenceEntry } from "@iterate-com/ui/components/events/agent-ui-reducer";

// ---------------------------------------------------------------------------
// Presence avatars
// ---------------------------------------------------------------------------

const AVATAR_PALETTE = [
  "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
];

export function presenceLabel(entry: AgentUiPresenceEntry): string {
  return entry.processor?.slug ?? entry.description ?? entry.subscriptionKey;
}

export function presenceInitials(label: string): string {
  const segments = label.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (segments.length === 0) return "??";
  if (segments.length === 1) return segments[0]!.slice(0, 2).toUpperCase();
  return `${segments[0]![0]}${segments[1]![0]}`.toUpperCase();
}

export function presenceColorClasses(label: string): string {
  return AVATAR_PALETTE[hashString(label) % AVATAR_PALETTE.length]!;
}

export function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index++) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}
