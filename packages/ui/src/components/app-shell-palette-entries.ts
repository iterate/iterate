// What ⌘K in the AppShell offers, and how typing narrows it: the projects the shell's switcher
// lists, and the sidebar's own navigation — read off the rendered sidebar when the palette opens, so
// an app declares its pages once (its `nav`) and the palette offers exactly what the sidebar shows.
// No React here: the filter is a pure function, the reader takes a DOM element.

/** One row of the palette. */
export type PaletteEntry = {
  /** unique across the palette — the row's cmdk value */
  id: string;
  label: string;
  /** the heading the row is listed under */
  group: string;
  /** what the label belongs to (a project's organization, a sub-page's parent) — shown after the
   *  label, and searched with it */
  detail: string | undefined;
  /** the page on screen, or the project it belongs to */
  active: boolean;
};

/** The sidebar's navigation as the palette lists it: every enabled menu button and sub-button in
 *  the sidebar's content, the element itself kept so choosing the row clicks it — the app's own
 *  handler (a client-router `Link`, "New agent") runs exactly as a click in the sidebar would. */
export type SidebarNavItem = Omit<PaletteEntry, "id"> & {
  element: HTMLElement;
  /** the absolute URL, for a link */
  href: string | undefined;
};

/** Rows under a heading the sidebar gives none (an app's top group of pages). */
export const UNLABELLED_NAV_GROUP = "Pages";

/** The rows that match `query`, grouped under their headings in order of first appearance. A row
 *  matches when every whitespace-separated term occurs, case-insensitively, in its label or
 *  detail; a row whose label starts with the query comes first within its heading, the rest keep
 *  their order. */
export function filterPaletteEntries<Entry extends PaletteEntry>(
  entries: readonly Entry[],
  query: string,
): { group: string; entries: Entry[] }[] {
  const needle = query.trim().toLowerCase();
  const terms = needle.split(/\s+/).filter(Boolean);
  const matching = entries.filter((entry) => {
    const haystack = `${entry.label} ${entry.detail || ""}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  const groups = new Map<string, Entry[]>();
  for (const entry of matching)
    groups.set(entry.group, [...(groups.get(entry.group) || []), entry]);
  return [...groups].map(([group, rows]) => ({
    group,
    entries: needle
      ? [
          ...rows.filter((row) => row.label.toLowerCase().startsWith(needle)),
          ...rows.filter((row) => !row.label.toLowerCase().startsWith(needle)),
        ]
      : rows,
  }));
}

/** Reads the sidebar's navigation off `content` (the sidebar's `SidebarContent`, null when it is
 *  not mounted — a phone's closed sheet): each enabled menu button and sub-button, labelled by its
 *  text (or its aria-label when it shows none), under its group's label; a sub-button's detail is
 *  its parent item's label. */
export function readSidebarNav(content: Element | null): SidebarNavItem[] {
  if (!content) return [];
  return [
    ...content.querySelectorAll<HTMLElement>(
      '[data-slot="sidebar-menu-button"], [data-slot="sidebar-menu-sub-button"]',
    ),
  ].flatMap((element) => {
    if (element.matches(':disabled, [aria-disabled="true"]')) return [];
    const label = textOf(element) || element.getAttribute("aria-label")?.trim();
    if (!label) return [];
    const group = element.closest('[data-slot="sidebar-group"]');
    const parent =
      element.dataset.slot === "sidebar-menu-sub-button"
        ? element
            .closest('[data-slot="sidebar-menu-sub"]')
            ?.closest('[data-slot="sidebar-menu-item"]')
            ?.querySelector('[data-slot="sidebar-menu-button"]')
        : null;
    return [
      {
        element,
        label,
        group:
          textOf(group?.querySelector('[data-slot="sidebar-group-label"]')) || UNLABELLED_NAV_GROUP,
        detail: textOf(parent) || undefined,
        active: element.hasAttribute("data-active"),
        href: element instanceof HTMLAnchorElement ? element.href : undefined,
      },
    ];
  });
}

function textOf(element: Element | null | undefined) {
  return element?.textContent?.replace(/\s+/g, " ").trim() || "";
}

/** A plain left click — not a modified one (cmd/ctrl/shift/alt: a new tab or window), not the
 *  middle button, not one something else already handled. */
export function plainLeftClick(
  event: Pick<
    MouseEvent,
    "defaultPrevented" | "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"
  >,
) {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}
