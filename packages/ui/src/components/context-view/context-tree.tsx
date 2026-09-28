// The context tree: every context an app knows (a project's registry, the global namespace's
// announced children) as an indented tree, `/` first, the one shown marked — the explorer's
// navigation, the old platform's left pane. One input over it, "Filter or go to a path": typing
// narrows the tree to the paths that contain it; Enter opens the one match, else the path typed,
// resolved against the one shown by the caller's `resolvePath` (the SDK's `resolveContextPath`, so
// `..` and `/agents/x` work); "/" anywhere on the page focuses it. A segment no context sits at
// (`/agents` over `/agents/web`) is a heading, not a link. Pure: the paths, the current one and
// where a path links (`ContextPathLinks`) are props.
//
// `ContextTree` is the pane (a wide screen's left column); `ContextTreeSheet` is a phone's: the path
// as a button that opens the same tree in a left Sheet.
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "cn";
import { Input } from "../input.tsx";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "../sheet.tsx";
import { navigateToPath, PathLink, type ContextPathLinks } from "./context-path.tsx";

type TreeRow = { path: string; name: string; depth: number; context: boolean };

/** The paths as tree rows, depth first in segment order; every ancestor a row, `/` the first. */
export function contextTreeRows(paths: readonly string[]): TreeRow[] {
  const known = new Set(["/", ...paths]);
  const all = new Set<string>(["/"]);
  for (const path of known) {
    const segments = path.split("/").filter(Boolean);
    for (let at = 1; at <= segments.length; at++) all.add(`/${segments.slice(0, at).join("/")}`);
  }
  return [...all]
    .map((path) => path.split("/").filter(Boolean))
    .sort((a, b) => {
      for (let at = 0; at < Math.min(a.length, b.length); at++)
        if (a[at] !== b[at]) return a[at]! < b[at]! ? -1 : 1;
      return a.length - b.length;
    })
    .map((segments) => {
      const path = `/${segments.join("/")}`;
      return {
        path,
        name: segments.at(-1) ?? "/",
        depth: segments.length,
        context: known.has(path),
      };
    });
}

export function ContextTree({
  paths,
  current,
  links,
  resolvePath,
  className,
}: {
  /** Every context path known; `/` is always listed. */
  paths: readonly string[];
  /** The path shown. */
  current: string;
  links: ContextPathLinks;
  /** A typed path, resolved against the one shown (`resolveContextPath(current, typed)`). */
  resolvePath: (typed: string) => string;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const rows = useMemo(() => contextTreeRows(paths), [paths]);
  const total = rows.filter((row) => row.context).length;
  const needle = query.trim();
  // filtered, the matches read flat, as whole paths
  const matches = needle
    ? rows.filter((row) => row.context && row.path.includes(needle))
    : undefined;
  // "/" focuses the input from anywhere but a field of the page's own
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest("input, textarea, select, [role=textbox]"))
      )
        return;
      const input = inputRef.current;
      if (!input?.offsetParent) return; // hidden (the other breakpoint's tree)
      event.preventDefault();
      input.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const row = "flex h-[26px] min-w-0 items-center rounded-md pr-2 whitespace-nowrap";
  return (
    <nav aria-label="Contexts" className={cn("flex min-h-0 flex-col gap-1.5", className)}>
      <form
        className="relative"
        onSubmit={(event) => {
          event.preventDefault();
          if (!needle) return;
          const only = matches?.length === 1 ? matches[0]!.path : undefined;
          setQuery("");
          navigateToPath(links, only || resolvePath(needle), event);
        }}
      >
        <Input
          ref={inputRef}
          aria-label="Filter or go to a path"
          placeholder="Filter or go to a path"
          className="h-8 pr-9 font-mono text-xs md:text-xs"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setQuery("");
          }}
        />
        <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border px-1 font-sans text-[10px] text-muted-foreground">
          {needle ? "↵ go" : "/"}
        </kbd>
      </form>
      <ul className="min-h-0 flex-1 overflow-y-auto font-mono text-[13px]">
        {(matches || rows).map((item) => {
          const indent = { paddingLeft: `${String(8 + (matches ? 0 : item.depth) * 12)}px` };
          const label = matches ? item.path : item.name;
          return (
            <li key={item.path}>
              {item.context ? (
                <PathLink
                  path={item.path}
                  links={links}
                  aria-label={item.path}
                  aria-current={item.path === current ? "page" : undefined}
                  className={cn(
                    row,
                    "text-foreground/85 hover:bg-muted/60 aria-[current=page]:bg-muted aria-[current=page]:font-semibold aria-[current=page]:text-foreground",
                  )}
                >
                  <span style={indent} className="truncate">
                    {label}
                  </span>
                </PathLink>
              ) : (
                <span className={cn(row, "text-muted-foreground")}>
                  <span style={indent} className="truncate">
                    {label}
                  </span>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="px-2 text-[11px] text-muted-foreground">
        {matches
          ? `${String(matches.length)} of ${String(total)} contexts`
          : total > 1
            ? `${String(total)} contexts`
            : "Contexts show up here as they're created."}
      </p>
    </nav>
  );
}

/** A phone's tree: the path shown, as a button, opening the tree in a left Sheet that closes as a
 *  path is picked. */
export function ContextTreeSheet({ className, ...tree }: Parameters<typeof ContextTree>[0]) {
  const [open, setOpen] = useState(false);
  const links = useMemo(
    (): ContextPathLinks => ({
      hrefOf: tree.links.hrefOf,
      onNavigate: (href, event) => {
        setOpen(false);
        if (tree.links.onNavigate) tree.links.onNavigate(href, event);
        else window.location.assign(href);
      },
    }),
    [tree.links],
  );
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        className={cn(
          "flex min-w-0 items-center gap-1 rounded-md bg-muted px-2 py-0.5 font-mono text-sm",
          className,
        )}
        aria-label={`Contexts: ${tree.current}`}
      >
        <span className="truncate">{tree.current}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </SheetTrigger>
      <SheetContent side="left" className="gap-2 p-3">
        <SheetHeader className="p-1">
          <SheetTitle>Contexts</SheetTitle>
        </SheetHeader>
        <ContextTree {...tree} links={links} className="flex-1" />
      </SheetContent>
    </Sheet>
  );
}
