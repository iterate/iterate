import { useEffect, useRef, useState } from "react";
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
import { normalizePath } from "~/domains/durable-object-names.ts";
import { StreamTree } from "~/components/stream-tree.tsx";
import type { StreamNavigator } from "~/lib/stream-navigation.ts";
import { streamPathParent } from "~/lib/stream-links.ts";

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
 *
 * The dialog takes a FIXED two-thirds of the viewport; the tree scrolls
 * inside it, so expanding nodes never resizes or re-centers the dialog.
 */
export function StreamSwitcherDialog({
  open,
  onOpenChange,
  currentPath,
  navigator,
  scope,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentPath: string;
  navigator: StreamNavigator;
  scope: string;
}) {
  const [destination, setDestination] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Opening seeds the path field for a sibling with the cursor placed after
  // the trailing slash, ready for the leaf. (The tree seeds its own expansion
  // from currentPath; Radix unmounts the content on close, so each open
  // starts from a fresh tree.)
  useEffect(() => {
    if (!open) return;
    setDestination(destinationPrefill(currentPath));
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }, [open, currentPath]);

  function openStream(path: string) {
    onOpenChange(false);
    navigator.onOpenPath(normalizePath(path));
  }

  const normalizedDestination = normalizeDestination(destination);
  const destinationValid = normalizedDestination != null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[66svh] w-[66vw] flex-col sm:max-w-[66vw]">
        <DialogHeader className="shrink-0">
          <DialogTitle>Streams</DialogTitle>
          <DialogDescription className="sr-only">Create or open a stream by path</DialogDescription>
          <p className="font-mono text-xs text-muted-foreground">{currentPath}</p>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <StreamTree
            // Fresh expansion state (ancestors of the current stream) per open.
            key={`${scope}:${currentPath}`}
            currentPath={currentPath}
            onOpenPath={openStream}
            scope={scope}
            source={navigator.source}
          />
        </div>
        <div className="shrink-0 border-t pt-3">
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
