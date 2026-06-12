import { useEffect, useMemo, useState } from "react";
import { ChevronRightIcon, CornerLeftUpIcon, HistoryIcon, FolderOpenIcon } from "lucide-react";
import type { StreamPath as StreamPathType } from "@iterate-com/shared/streams/types";
import {
  CommandDialog,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@iterate-com/ui/components/command";
import { Spinner } from "@iterate-com/ui/components/spinner";
import {
  parentStreamPath,
  parseStreamPath,
  readRecentStreams,
  readStreamStateOnce,
  type StreamNavigator,
} from "~/lib/stream-navigation.ts";

type ChildrenState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; childPaths: string[] };

/**
 * The streams command palette: recents on top, a lazily-loaded tree below.
 * Selecting a row opens that stream; the trailing chevron descends into it
 * without opening. Backed by shadcn Command (cmdk) for idiomatic filtering
 * and keyboard navigation.
 */
export function StreamSwitcherDialog({
  open,
  onOpenChange,
  currentPath,
  navigator,
  recentsScope,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentPath: StreamPathType;
  navigator: StreamNavigator;
  recentsScope: string;
}) {
  const [browsePath, setBrowsePath] = useState<string>("/");
  const [query, setQuery] = useState("");
  const [children, setChildren] = useState<ChildrenState>({ status: "loading" });
  const [countsByPath, setCountsByPath] = useState<ReadonlyMap<string, number>>(new Map());

  const recents = useMemo(
    () => (open ? readRecentStreams(recentsScope).filter((path) => path !== currentPath) : []),
    [open, recentsScope, currentPath],
  );

  // Opening resets the browse location to the current stream's parent so the
  // first thing shown is "where you are" — siblings plus recents.
  useEffect(() => {
    if (!open) return;
    setBrowsePath(parentStreamPath(currentPath));
    setQuery("");
  }, [open, currentPath]);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    setChildren({ status: "loading" });
    readStreamStateOnce(navigator.source, parseStreamPath(browsePath))
      .then((state) => {
        if (disposed) return;
        setChildren({ status: "ok", childPaths: [...state.childPaths].sort() });
        // Counts pop in asynchronously, one read per child.
        for (const childPath of state.childPaths.slice(0, 48)) {
          readStreamStateOnce(navigator.source, parseStreamPath(childPath))
            .then((childState) => {
              if (disposed) return;
              setCountsByPath((previous) => {
                const next = new Map(previous);
                next.set(childPath, childState.eventCount);
                return next;
              });
            })
            .catch(() => {});
        }
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setChildren({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      disposed = true;
    };
  }, [open, browsePath, navigator.source]);

  function openStream(path: string) {
    onOpenChange(false);
    navigator.onOpenPath(parseStreamPath(path));
  }

  function descendInto(path: string) {
    setBrowsePath(path);
    setQuery("");
  }

  const showRecents = recents.length > 0;

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Switch stream"
      description="Search and navigate streams"
      className="sm:max-w-lg"
    >
      <Command>
        <CommandInput placeholder="Go to stream…" value={query} onValueChange={setQuery} />
        <CommandList>
          <CommandEmpty>No streams found.</CommandEmpty>
          {showRecents ? (
            <>
              <CommandGroup heading="Recent">
                {recents.map((path) => (
                  <CommandItem
                    key={`recent-${path}`}
                    value={`recent ${path}`}
                    onSelect={() => openStream(path)}
                  >
                    <HistoryIcon className="size-3.5 text-muted-foreground" />
                    <span className="truncate font-mono text-xs">{path}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandSeparator />
            </>
          ) : null}
          <CommandGroup heading={browsePath}>
            {browsePath === "/" ? null : (
              <CommandItem
                value=".. up one level"
                onSelect={() => descendInto(parentStreamPath(browsePath))}
              >
                <CornerLeftUpIcon className="size-3.5 text-muted-foreground" />
                <span className="font-mono text-xs text-muted-foreground">..</span>
              </CommandItem>
            )}
            <CommandItem value={`open ${browsePath}`} onSelect={() => openStream(browsePath)}>
              <FolderOpenIcon className="size-3.5 text-muted-foreground" />
              <span className="truncate font-mono text-xs">Open {browsePath}</span>
            </CommandItem>
            {children.status === "loading" ? (
              <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
                <Spinner className="size-3" /> Loading child streams…
              </div>
            ) : children.status === "error" ? (
              <div className="px-2 py-2 text-xs text-destructive">{children.message}</div>
            ) : children.childPaths.length === 0 ? (
              <div className="px-2 py-2 text-xs text-muted-foreground">No child streams yet.</div>
            ) : (
              children.childPaths.map((childPath) => (
                <CommandItem
                  key={childPath}
                  value={childPath}
                  onSelect={() => openStream(childPath)}
                >
                  <span className="truncate font-mono text-xs">
                    {relativeStreamLabel(browsePath, childPath)}
                  </span>
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    {countsByPath.get(childPath) == null ? null : (
                      <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
                        {countsByPath.get(childPath)}
                      </span>
                    )}
                    <button
                      type="button"
                      title={`Browse ${childPath}`}
                      className="grid size-5 place-items-center rounded text-muted-foreground/60 hover:bg-muted hover:text-foreground"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        descendInto(childPath);
                      }}
                    >
                      <ChevronRightIcon className="size-3.5" />
                    </button>
                  </span>
                </CommandItem>
              ))
            )}
          </CommandGroup>
        </CommandList>
        <div className="flex items-center gap-3 border-t px-3 py-1.5 text-[10px] text-muted-foreground">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </Command>
    </CommandDialog>
  );
}

function relativeStreamLabel(basePath: string, childPath: string): string {
  const prefix = basePath === "/" ? "/" : `${basePath}/`;
  return childPath.startsWith(prefix) ? childPath.slice(prefix.length) : childPath;
}
