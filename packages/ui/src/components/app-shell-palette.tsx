// ⌘K in the AppShell: one dialog to switch project or jump to any page the sidebar offers, by
// typing. The rows and the filter are app-shell-palette-entries.ts; this is the dialog, the
// shortcut and the buttons that open it (the sidebar's "Search" row, and the header's on a phone,
// where the sidebar is a sheet).
//
// command.tsx is vendored shadcn (packages/ui/AGENTS.md), so the palette's own look (#2991) lives
// here, in the classNames it passes: flush rows edge to edge instead of upstream's inset, rounded
// ones, and a borderless search row. Two parts are composed here instead: the search row is cmdk's
// input under the palette's own markup, because upstream's CommandInput wraps it in an InputGroup
// that takes no className; and the dialog is Dialog's parts, because upstream's CommandDialog puts
// its sr-only title outside the popup, where a screen reader finds a "Search" heading on every page
// even while the palette is closed.
import { useEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { CheckIcon, SearchIcon } from "lucide-react";
import {
  filterPaletteEntries,
  plainLeftClick,
  withoutProjectLinks,
  type PaletteEntry,
  type SidebarNavItem,
} from "./app-shell-palette-entries.ts";
import type { AppShellProject } from "./app-shell.tsx";
import { Button } from "./button.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "./command.tsx";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./dialog.tsx";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "./sidebar.tsx";

type PaletteRow =
  | (PaletteEntry & { kind: "project"; href: string })
  | (PaletteEntry & { kind: "nav"; element: HTMLElement });

/** Nothing to subscribe to: the platform does not change under a page. */
const subscribeToNothing = () => () => {};

/** The shortcut as this platform spells it. */
function useShortcutLabel() {
  return useSyncExternalStore(
    subscribeToNothing,
    () => (/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K"),
    () => "⌘K",
  );
}

/** ⌘K (Ctrl+K off a Mac) anywhere on the page toggles the palette — in a text field too, as the
 *  sidebar's ⌘B does. */
export function usePaletteShortcut(toggle: () => void) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.altKey || event.shiftKey) return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      toggle();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggle]);
}

/** The sidebar's "Search" row, above the app's navigation: an icon with a tooltip when the sidebar
 *  is collapsed to its rail. */
export function PaletteSidebarButton({ onOpen }: { onOpen: () => void }) {
  const shortcut = useShortcutLabel();
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton type="button" tooltip={`Search (${shortcut})`} onClick={onOpen}>
          <SearchIcon />
          <span>Search</span>
          <kbd className="ml-auto font-sans text-xs text-muted-foreground">{shortcut}</kbd>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/** The header's search button, on a phone: there the sidebar is a sheet, closed until asked for. */
export function PaletteHeaderButton({ onOpen }: { onOpen: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="md:hidden"
      aria-label="Search"
      title="Search"
      onClick={onOpen}
    >
      <SearchIcon />
    </Button>
  );
}

/** The dialog. `nav` is the sidebar's navigation as it read when the palette opened, null while
 *  closed. A project row is a real link to `projectHref(project)` — a plain click (or Enter) goes
 *  through `onNavigate` when the app has a client router, a modified or middle click opens a tab —
 *  and a nav row clicks the sidebar's own element. */
export function AppShellPalette({
  nav,
  onClose,
  projects,
  activeProjectId,
  projectHref,
  onNavigate,
}: {
  nav: SidebarNavItem[] | null;
  onClose: () => void;
  projects: AppShellProject[];
  activeProjectId: string | null;
  projectHref: (project: AppShellProject) => string;
  onNavigate: ((href: string, event: MouseEvent<HTMLAnchorElement>) => void) | undefined;
}) {
  return (
    <Dialog
      open={Boolean(nav)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        // near the top, not centred: the list grows and shrinks under the input as you type
        className="top-[12svh] translate-y-0 overflow-hidden p-0 sm:max-w-lg"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Search</DialogTitle>
          <DialogDescription>Switch project or go to a page</DialogDescription>
        </DialogHeader>
        {nav ? (
          <PaletteBody
            nav={nav}
            onClose={onClose}
            projects={projects}
            activeProjectId={activeProjectId}
            projectHref={projectHref}
            onNavigate={onNavigate}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Mounted per opening, so the query starts empty each time. */
function PaletteBody({
  nav,
  onClose,
  projects,
  activeProjectId,
  projectHref,
  onNavigate,
}: {
  nav: SidebarNavItem[];
  onClose: () => void;
  projects: AppShellProject[];
  activeProjectId: string | null;
  projectHref: (project: AppShellProject) => string;
  onNavigate: ((href: string, event: MouseEvent<HTMLAnchorElement>) => void) | undefined;
}) {
  const [query, setQuery] = useState("");
  const links = useRef(new Map<string, HTMLAnchorElement>());
  const projectRows = projects.map(
    (project): PaletteRow => ({
      kind: "project",
      id: `project:${project.id}`,
      label: project.slug,
      group: "Projects",
      detail: project.org?.name,
      active: project.id === activeProjectId,
      href: projectHref(project),
    }),
  );
  const navRows = withoutProjectLinks(
    nav,
    projects.map((project) => ({
      label: project.slug,
      href: new URL(projectHref(project), location.href).href,
    })),
  ).map(
    ({ element, label, group, detail, active }, index): PaletteRow => ({
      kind: "nav",
      id: `nav:${index}`,
      label,
      group,
      detail,
      active,
      element,
    }),
  );
  const groups = filterPaletteEntries([...navRows, ...projectRows], query);
  return (
    <Command shouldFilter={false} loop className="p-0">
      <div className="flex items-center gap-2 px-3 py-2">
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <CommandPrimitive.Input
          data-slot="command-input"
          className="flex h-8 w-full min-w-0 bg-transparent text-sm outline-hidden placeholder:text-muted-foreground"
          placeholder="Search projects and pages…"
          aria-label="Search projects and pages"
          value={query}
          onValueChange={setQuery}
        />
      </div>
      <CommandList className="max-h-[min(24rem,60svh)] border-t">
        <CommandEmpty className="text-muted-foreground">Nothing matches.</CommandEmpty>
        {groups.map(({ group, entries }) => (
          <CommandGroup
            key={group}
            heading={group}
            className="p-0 **:[[cmdk-group-heading]]:px-3 **:[[cmdk-group-heading]]:py-2"
          >
            {entries.map((row) => (
              <CommandItem
                key={row.id}
                value={row.id}
                className="rounded-none px-3 py-2 in-data-[slot=dialog-content]:rounded-none!"
                onSelect={() => {
                  if (row.kind === "project") {
                    links.current.get(row.id)?.click();
                    return;
                  }
                  onClose();
                  row.element.click();
                }}
              >
                {row.kind === "project" ? (
                  <a
                    ref={(link) => {
                      if (link) links.current.set(row.id, link);
                      else links.current.delete(row.id);
                    }}
                    href={row.href}
                    tabIndex={-1}
                    className="flex min-w-0 flex-1 items-center gap-2"
                    onClick={(event) => {
                      // the row's own onSelect would click this again
                      event.stopPropagation();
                      if (!plainLeftClick(event)) return;
                      onClose();
                      onNavigate?.(row.href, event);
                    }}
                  >
                    <PaletteRowLabel row={row} />
                  </a>
                ) : (
                  <PaletteRowLabel row={row} />
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </Command>
  );
}

function PaletteRowLabel({ row }: { row: PaletteRow }) {
  return (
    <>
      <span className="truncate">{row.label}</span>
      {row.detail ? (
        <span className="truncate text-xs text-muted-foreground">{row.detail}</span>
      ) : null}
      {row.active ? (
        <CommandShortcut>
          <CheckIcon aria-label="current" />
        </CommandShortcut>
      ) : null}
    </>
  );
}
