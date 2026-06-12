import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRightIcon, CornerLeftUpIcon, HistoryIcon, FolderOpenIcon } from "lucide-react";
import { StreamPath, type StreamPath as StreamPathType } from "@iterate-com/shared/streams/types";
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
  readRecentStreams,
  readStreamStateOnce,
  type StreamNavigator,
} from "~/lib/stream-navigation.ts";

/**
 * The streams command palette: recents on top, a lazily-loaded tree below.
 * Enter opens the selected stream; → descends into it without opening.
 * Backed by shadcn Command (cmdk) for filtering and keyboard navigation.
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
  const [selectedValue, setSelectedValue] = useState("");

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

  const children = useQuery({
    queryKey: ["stream-switcher-children", recentsScope, browsePath],
    queryFn: async () => {
      const state = await readStreamStateOnce(navigator.source, StreamPath.parse(browsePath));
      return [...state.childPaths].sort();
    },
    enabled: open,
  });

  function openStream(path: string) {
    onOpenChange(false);
    navigator.onOpenPath(StreamPath.parse(path));
  }

  function descendInto(path: string) {
    setBrowsePath(path);
    setQuery("");
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Switch stream"
      description="Search and navigate streams"
      className="sm:max-w-lg"
    >
      <Command
        value={selectedValue}
        onValueChange={setSelectedValue}
        onKeyDown={(event) => {
          // → descends into the highlighted child stream without opening it.
          if (event.key !== "ArrowRight" || query !== "") return;
          const childPath = children.data?.find((path) => path === selectedValue);
          if (childPath == null) return;
          event.preventDefault();
          descendInto(childPath);
        }}
      >
        <CommandInput placeholder="Go to stream…" value={query} onValueChange={setQuery} />
        <CommandList>
          <CommandEmpty>No streams found.</CommandEmpty>
          {recents.length === 0 ? null : (
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
          )}
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
            {children.isPending ? (
              <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
                <Spinner className="size-3" /> Loading child streams…
              </div>
            ) : children.isError ? (
              <div className="px-2 py-2 text-xs text-destructive">
                {children.error instanceof Error ? children.error.message : "Failed to load"}
              </div>
            ) : children.data.length === 0 ? (
              <div className="px-2 py-2 text-xs text-muted-foreground">No child streams yet.</div>
            ) : (
              children.data.map((childPath) => (
                <ChildStreamItem
                  key={childPath}
                  browsePath={browsePath}
                  childPath={childPath}
                  navigator={navigator}
                  recentsScope={recentsScope}
                  onOpen={openStream}
                />
              ))
            )}
          </CommandGroup>
        </CommandList>
        <div className="flex items-center gap-3 border-t px-3 py-1.5 text-[10px] text-muted-foreground">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>→ browse</span>
          <span>esc close</span>
        </div>
      </Command>
    </CommandDialog>
  );
}

function ChildStreamItem({
  browsePath,
  childPath,
  navigator,
  recentsScope,
  onOpen,
}: {
  browsePath: string;
  childPath: string;
  navigator: StreamNavigator;
  recentsScope: string;
  onOpen: (path: string) => void;
}) {
  // Counts pop in asynchronously, one cached read per child path.
  const count = useQuery({
    queryKey: ["stream-switcher-count", recentsScope, childPath],
    queryFn: async () => {
      const state = await readStreamStateOnce(navigator.source, StreamPath.parse(childPath));
      return state.eventCount;
    },
  });

  return (
    <CommandItem value={childPath} onSelect={() => onOpen(childPath)}>
      <span className="truncate font-mono text-xs">
        {relativeStreamLabel(browsePath, childPath)}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {count.data == null ? null : (
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
            {count.data}
          </span>
        )}
        <ChevronRightIcon className="size-3.5 text-muted-foreground/40" />
      </span>
    </CommandItem>
  );
}

function relativeStreamLabel(basePath: string, childPath: string): string {
  const prefix = basePath === "/" ? "/" : `${basePath}/`;
  return childPath.startsWith(prefix) ? childPath.slice(prefix.length) : childPath;
}
