import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { formatTimeAgo } from "~/lib/format-relative-time.ts";
import { useLiveState } from "~/itx/itx-react.tsx";

// A full canonical StreamPath of at least one segment: leading slash, lowercase
// segments separated by single slashes, no trailing slash. `~` is legal — GitHub
// agent paths use g~<hex> (must stay aligned with StreamPath in stream-links).
const STREAM_PATH_PATTERN = /^(?:\/[a-z0-9_~-]+)+$/;

// The "what's happening right now" window for the default ⌘K list.
const RECENT_WINDOW_MS = 5 * 60_000;

// How often the open dialog re-reads the clock: refreshes the "ago" labels and
// lets quiet streams age out of the recent window without a reopen.
const CLOCK_TICK_MS = 5_000;

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

// How many characters of the pre-match "head" to keep when it's too long to fit
// whole. We keep the END of the head (the segment nearest the match) and drop the
// front behind an ellipsis, so the match never scrolls off the left edge.
const HEAD_KEEP = 20;

/**
 * A stream path in a result row, truncated the way editors truncate file paths —
 * and, when searching, with the matched text highlighted and guaranteed visible:
 *
 *   - no query → keep the LEAF whole (the informative part), let the parent
 *     directory ellipsize: `/agents/web/really/lo…/thread-abc` → `…/thread-abc`.
 *   - with a query → the matched span is a non-shrinking, highlighted island; the
 *     head before it ellipsizes from the FAR end (nearest text kept) and the tail
 *     after it ellipsizes on the right. So the match is never hidden in an ellipsis.
 */
function MatchedStreamPath({ path, query }: { path: string; query: string }) {
  const at = query === "" ? -1 : path.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) {
    const leaf = path.split("/").at(-1) ?? path;
    const parent = path.slice(0, path.length - leaf.length);
    return (
      <span className="flex min-w-0 items-center overflow-hidden font-mono">
        <span className="truncate text-muted-foreground">{parent}</span>
        <span className="shrink-0 whitespace-nowrap">{leaf}</span>
      </span>
    );
  }
  const head = path.slice(0, at);
  const match = path.slice(at, at + query.length);
  const tail = path.slice(at + query.length);
  const shownHead = head.length > HEAD_KEEP ? `…${head.slice(head.length - HEAD_KEEP)}` : head;
  return (
    <span className="flex min-w-0 items-center overflow-hidden font-mono">
      <span className="shrink-0 whitespace-nowrap text-muted-foreground">{shownHead}</span>
      <mark className="shrink-0 whitespace-nowrap rounded-sm bg-yellow-200/80 px-0.5 text-foreground dark:bg-yellow-500/30">
        {match}
      </mark>
      <span className="truncate text-muted-foreground">{tail}</span>
    </span>
  );
}

/**
 * The ⌘K stream dialog: the recently-active streams by default, a live substring
 * search over the whole project index as you type (arrow keys move the selection,
 * Enter opens it), and a form to create/open a stream by path. Streams are lazily
 * created — navigating IS creating. The path field prefills with the current
 * stream's parent, so the default is a sibling; edit the path to nest deeper or
 * jump elsewhere. A quiet project (nothing to list) falls back to the browsable
 * tree, expanded along the current path.
 *
 * The list wears its liveness: rows are newest-first (labelled), every row shows
 * how long ago its stream was last active (ticking while open), and a stream
 * touched while you watch FLASHES as it jumps (a keyed remount replays a
 * one-shot CSS fade) — reordering reads as activity, not as rows teleporting.
 *
 * The dialog takes a FIXED two-thirds of the viewport (near-fullscreen on
 * phones); the list/tree scrolls inside it, so navigating never resizes or
 * re-centers the dialog.
 */
export function StreamSwitcherDialog({
  open,
  onOpenChange,
  currentPath,
  navigator,
  scope,
  liveIndex = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentPath: string;
  navigator: StreamNavigator;
  scope: string;
  /**
   * Whether to hold the live streams-index subscription. The admin explorer
   * turns it off: its lane dials through platform-wide operator authority, and the
   * `__null__` deployment namespace has no project DO to subscribe to at all —
   * it browses the tree instead.
   */
  liveIndex?: boolean;
}) {
  const [destination, setDestination] = useState("");
  // Whether the path field has been edited THIS open. Fresh open = untouched → the
  // list is the recently-active default; the first keystroke flips it to search.
  // (The field still prefills the parent so "type a leaf, Enter" creates a sibling.)
  const [touched, setTouched] = useState(false);
  // The keyboard cursor into the result list. -1 = nothing highlighted (fresh open,
  // before you arrow or type), so Enter falls through to "create the typed path".
  const [selectedIndex, setSelectedIndex] = useState(-1);
  // The open dialog's clock, ticking every few seconds (never Date.now() in
  // render: impure under concurrent replays). One tick drives BOTH the "ago"
  // labels and the recent window, so quiet streams age out while you watch.
  // Seeded in a LAYOUT effect: the clock stops while closed, so an open must
  // re-read it before paint — a passive effect would paint one frame with a
  // stale window (or, on first open, no list at all).
  const [now, setNow] = useState(0);
  useLayoutEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(interval);
  }, [open]);
  const recentSince = now - RECENT_WINDOW_MS;
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);

  // The whole streams index, live, in ONE subscription — so typing filters it in
  // memory (most-recently-active first) instead of waking a Durable Object per
  // node. That is the "⌘K, type, see" path; an empty query falls back to the
  // browsable tree. Held while the dialog is closed ON PURPOSE: ⌘K must paint
  // instantly, and one warm per-tab subscription is the accepted price.
  //
  // `scope` is the project id. ⌘K opens from the global palette — the app shell,
  // OUTSIDE any `<ProjectScope>` — so we name the project explicitly via `slug`
  // (an id works too). The subscription resolves the connection inside the
  // effect, so it never suspends the shell.
  const streamsIndex = useLiveState(
    (itx) => itx.liveState,
    (state) => state.streamsIndex,
    [scope],
    { slug: scope, enabled: liveIndex },
  );
  const query = destination.trim().replace(/^\/+/, "").toLowerCase();
  // Default view (untouched): streams active in the last few minutes — ⌘K, glance,
  // jump. Start typing and it becomes a substring search over the whole index.
  // Either way the list is most-recent-first, and an empty result falls through to
  // the browsable tree. Memoized — and empty while closed — so the standing
  // subscription's pushes don't run a filter+sort for an invisible dialog.
  const matches = useMemo(() => {
    if (!open || now === 0 || streamsIndex.value === undefined) return [];
    const rows = Object.values(streamsIndex.value);
    return (
      touched
        ? query === ""
          ? []
          : rows.filter((row) => row.path.toLowerCase().includes(query))
        : rows.filter((row) => new Date(row.lastActivityAt).getTime() >= recentSince)
    )
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
      .slice(0, 50);
  }, [open, now, streamsIndex.value, touched, query, recentSince]);
  // Clamp the cursor to the current list (it shrinks as you type). -1 stays -1.
  const selected = selectedIndex < 0 ? -1 : Math.min(selectedIndex, matches.length - 1);

  // Keep the highlighted row in view as the cursor moves past the fold.
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // Opening seeds the path field for a sibling with the cursor placed after
  // the trailing slash, ready for the leaf. (The tree seeds its own expansion
  // from currentPath; Radix unmounts the content on close, so each open
  // starts from a fresh tree.)
  useEffect(() => {
    if (!open) return;
    setDestination(destinationPrefill(currentPath));
    setTouched(false);
    setSelectedIndex(-1);
    const frame = requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, [open, currentPath]);

  function openStream(path: string) {
    onOpenChange(false);
    navigator.onOpenPath(normalizePath(path));
  }

  const normalizedDestination = normalizeDestination(destination);
  const destinationValid = normalizedDestination != null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[calc(100svh-2rem)] w-[calc(100vw-1rem)] max-w-none flex-col sm:h-[66svh] sm:w-[66vw] sm:max-w-[66vw]">
        <DialogHeader className="shrink-0">
          <DialogTitle>Streams</DialogTitle>
          <DialogDescription className="sr-only">Create or open a stream by path</DialogDescription>
          <p className="font-mono text-xs text-muted-foreground">{currentPath}</p>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {matches.length > 0 ? (
            <ul
              id="stream-switcher-listbox"
              className="flex flex-col gap-0.5"
              role="listbox"
              aria-label={
                touched
                  ? "Matching streams, most recently active first"
                  : "Recently active streams, most recent first"
              }
              data-testid="stream-switcher-matches"
            >
              <li
                className="flex items-baseline justify-between px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60"
                role="presentation"
                aria-hidden
              >
                <span>{touched ? "Matches" : "Recently active"}</span>
                <span className="normal-case tracking-normal">newest first</span>
              </li>
              {matches.map((row, index) => (
                <li key={row.path} role="presentation">
                  {/* Keyed by activity: a touch remounts the button, replaying
                      the one-shot stream-flash fade (see styles.css) — pure
                      CSS, no flash bookkeeping. Rows also flash once on open,
                      which reads as "this list is fresh". */}
                  <button
                    key={row.lastActivityAt}
                    ref={index === selected ? selectedRef : undefined}
                    id={`stream-switcher-option-${index}`}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    title={row.path}
                    aria-selected={index === selected}
                    data-selected={index === selected || undefined}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left animate-[stream-flash_1.2s_ease-out] ${
                      index === selected ? "bg-accent" : "hover:bg-accent/70"
                    }`}
                    onMouseMove={() => setSelectedIndex(index)}
                    onClick={() => openStream(row.path)}
                  >
                    <MatchedStreamPath path={row.path} query={touched ? query : ""} />
                    <span
                      className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground"
                      data-testid="stream-switcher-last-active"
                    >
                      {formatTimeAgo(row.lastActivityAt, now)}
                    </span>
                    <span className="w-10 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground/60">
                      {row.eventCount}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <StreamTree
              // Fresh expansion state (ancestors of the current stream) per open.
              key={`${scope}:${currentPath}`}
              currentPath={currentPath}
              onOpenPath={openStream}
              scope={scope}
              source={navigator.source}
            />
          )}
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
                // Focus stays in the input while arrows move the visual cursor —
                // the WAI-ARIA combobox pattern: aria-activedescendant is how a
                // screen reader follows a highlight it can't see.
                role="combobox"
                aria-expanded={matches.length > 0}
                aria-controls="stream-switcher-listbox"
                aria-autocomplete="list"
                aria-activedescendant={
                  selected >= 0 ? `stream-switcher-option-${selected}` : undefined
                }
                onChange={(event) => {
                  setDestination(event.target.value);
                  setTouched(true);
                  setSelectedIndex(0); // each keystroke reshapes the list → highlight its top
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setSelectedIndex((i) => Math.min(i + 1, matches.length - 1));
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    // Past the top = back to -1, the create-the-typed-path mode:
                    // without it, Enter could NEVER create a path that substring-
                    // matches an existing stream once you'd typed anything.
                    setSelectedIndex((i) => Math.max(i - 1, -1));
                  } else if (event.key === "Enter" && selected >= 0 && matches[selected]) {
                    // A highlighted result wins; otherwise Enter falls through to the
                    // form submit below, which creates/opens the typed path.
                    event.preventDefault();
                    openStream(matches[selected].path);
                  }
                }}
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
