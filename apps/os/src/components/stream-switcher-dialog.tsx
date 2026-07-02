import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@iterate-com/ui/components/dialog";
import { Field, FieldLabel } from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import { cn } from "@iterate-com/ui/lib/utils";
import { normalizePath } from "~/next/domains/durable-object-names.ts";
import { readStreamStateOnce, type StreamNavigator } from "~/lib/stream-navigation.ts";
import { streamPathAncestors, streamPathParent } from "~/lib/stream-links.ts";

// A full canonical StreamPath of at least one segment: leading slash, lowercase
// segments separated by single slashes, no trailing slash.
const STREAM_PATH_PATTERN = /^(?:\/[a-z0-9_-]+)+$/;

// The destination input prefills with the parent of the current stream, so the
// default action creates a *sibling* (type a leaf, hit Create). Keep typing
// past another "/" to go deeper, or edit the prefix to land anywhere.
function destinationPrefill(currentPath: string) {
  const parent = streamPathParent(currentPath);
  return parent === "/" ? "/" : `${parent}/`;
}

// Normalize a typed path for validity/submit: trim, single leading slash, drop
// any trailing slash. Returns null while the leaf is empty or a segment is
// malformed — Create stays disabled until it resolves to a real new path.
function normalizeDestination(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.endsWith("/")) return null;
  const candidate = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return STREAM_PATH_PATTERN.test(candidate) ? candidate : null;
}

/**
 * The ⌘K stream dialog, deliberately simple: the current stream with a form
 * to create/open a stream by path, and the stream tree (expanded along the
 * current path) to click around. Streams are lazily created — navigating IS
 * creating. The path field prefills with the current stream's parent, so the
 * default is a sibling; edit the path to nest deeper or jump elsewhere.
 */
export function StreamSwitcherDialog({
  open,
  onOpenChange,
  currentPath,
  navigator,
  rootPath = normalizePath("/"),
  scope,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentPath: string;
  navigator: StreamNavigator;
  rootPath?: string;
  scope: string;
}) {
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(new Set(["/"]));
  const [destination, setDestination] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Opening reveals "where you are": every ancestor (and the current stream
  // itself) starts expanded, and the path field is seeded for a sibling with
  // the cursor placed after the trailing slash, ready for the leaf.
  useEffect(() => {
    if (!open) return;
    setExpandedPaths(new Set([rootPath, ...streamPathAncestors(currentPath)]));
    setDestination(destinationPrefill(currentPath));
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }, [open, currentPath, rootPath]);

  function openStream(path: string) {
    onOpenChange(false);
    navigator.onOpenPath(normalizePath(path));
  }

  const normalizedDestination = normalizeDestination(destination);
  const destinationValid = normalizedDestination != null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Streams</DialogTitle>
          <DialogDescription className="sr-only">Create or open a stream by path</DialogDescription>
          <p className="font-mono text-xs text-muted-foreground">{currentPath}</p>
        </DialogHeader>
        <div className="max-h-80 overflow-y-auto">
          <StreamTreeItem
            path={rootPath}
            depth={0}
            tree={{
              currentPath,
              expandedPaths,
              navigator,
              scope,
              onOpen: openStream,
              onToggle: (path) =>
                setExpandedPaths((previous) => {
                  const next = new Set(previous);
                  if (next.has(path)) next.delete(path);
                  else next.add(path);
                  return next;
                }),
            }}
          />
        </div>
        <div className="border-t pt-3">
          <form
            className="flex w-full items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (normalizedDestination == null) return;
              openStream(normalizedDestination);
            }}
          >
            <Field className="min-w-0 flex-1 gap-1">
              <FieldLabel htmlFor="stream-switcher-destination" className="sr-only">
                Stream path to create or open
              </FieldLabel>
              <Input
                id="stream-switcher-destination"
                ref={inputRef}
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
                placeholder="/agents/web/new-stream"
                className="h-8 font-mono text-xs"
              />
            </Field>
            <Button type="submit" size="sm" disabled={!destinationValid}>
              Create stream
            </Button>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type StreamTreeContext = {
  currentPath: string;
  expandedPaths: ReadonlySet<string>;
  navigator: StreamNavigator;
  scope: string;
  onOpen: (path: string) => void;
  onToggle: (path: string) => void;
};

/**
 * One tree node and (when expanded) its recursive children. Each node loads
 * its own state once — that single read supplies both the event count badge
 * and the child paths to recurse into.
 */
function StreamTreeItem({
  path,
  depth,
  tree,
}: {
  path: string;
  depth: number;
  tree: StreamTreeContext;
}) {
  const expanded = tree.expandedPaths.has(path);
  const state = useQuery({
    queryKey: ["stream-switcher-children", tree.scope, path],
    queryFn: async () => {
      const streamState = await readStreamStateOnce(tree.navigator.source, normalizePath(path));
      return { eventCount: streamState.eventCount, childPaths: [...streamState.childPaths].sort() };
    },
  });
  const childPaths = state.data?.childPaths ?? [];

  return (
    <>
      <div
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 hover:bg-accent",
          path === tree.currentPath && "bg-accent/50",
        )}
      >
        <span style={{ width: depth * 14 }} className="shrink-0" />
        {childPaths.length > 0 ? (
          <button
            type="button"
            aria-label={expanded ? "Collapse" : "Expand"}
            className="-m-1 shrink-0 rounded p-1 hover:bg-muted"
            onClick={() => tree.onToggle(path)}
          >
            {expanded ? (
              <ChevronDownIcon className="size-3.5 text-muted-foreground/60" />
            ) : (
              <ChevronRightIcon className="size-3.5 text-muted-foreground/60" />
            )}
          </button>
        ) : (
          <span className="size-3.5 shrink-0" />
        )}
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => tree.onOpen(path)}
        >
          <span className="truncate font-mono text-xs">
            {path === "/" ? "/" : (path.split("/").at(-1) ?? path)}
          </span>
          {state.data == null ? null : (
            <span className="ml-auto font-mono text-[10px] tabular-nums text-muted-foreground/70">
              {state.data.eventCount}
            </span>
          )}
        </button>
      </div>
      {expanded
        ? childPaths.map((childPath) => (
            <StreamTreeItem key={childPath} path={childPath} depth={depth + 1} tree={tree} />
          ))
        : null}
    </>
  );
}
