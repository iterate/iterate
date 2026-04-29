/**
 * Interactive terminal UI for streaming and inspecting events on an iterate
 * event stream. Built on OpenTUI's imperative renderable API.
 *
 * Layout: header (stream path + stats) | scrollable feed | input box
 * Views:  "feed" (live events), "state" (debug yaml), "streams" (tree browser)
 *
 * Keyboard: Tab/Shift+Tab cycles regions, Esc returns to input + feed view,
 * "/" in input opens slash command autocomplete.
 *
 * Run via:
 *   pnpm --dir apps/agents cli stream-tui \
 *     --project-slug <slug> --stream-path <path>
 */
import { Event, ProjectSlug, StreamPath, type EventInput } from "@iterate-com/events-contract";
import type {
  EventsStreamBuiltInElement,
  EventsStreamRawEventElement,
} from "@iterate-com/ui/components/events/feed-items";
import { rawPrettyEventsStreamViewReducer } from "@iterate-com/ui/components/events/feed-processors";
import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  StyledText,
  TextRenderable,
  bold,
  bg,
  createCliRenderer,
  fg,
  CliRenderEvents,
  KeyEvent,
  parseKeypress,
} from "@opentui/core";
import { ORPCError } from "@orpc/server";
import { stringify as stringifyYaml } from "yaml";
import { createEventsOrpcClient } from "../src/lib/events-orpc-client.ts";
import {
  acceptedSlashInput,
  findSlashCommand as findDiscoveredSlashCommand,
  formatSlashCommandLabelSegments,
  parseSlashAutocompleteQuery,
  suggestSlashCommands,
} from "../src/stream-tui/command-discovery.ts";
import {
  MissingCommandArgumentsError,
  parseSlashCommandInput,
  parseSlashInvocation,
} from "../src/stream-tui/command-invocation.ts";
import {
  commandEntries,
  runCommand as runTuiCommand,
  type AppContext,
  type CommandEntry,
  type StreamApi,
  type StreamSummary,
} from "../src/stream-tui/command-router.ts";
import {
  formatElapsedTime,
  formatEventSummary,
  formatTime,
  getElapsedByOffset,
  orderEventKeysForYamlDisplay,
  rightAlign,
  wrapLine,
} from "../src/stream-tui/feed-formatting.ts";
import {
  focusStreamTuiComposer,
  focusStreamTuiFeed,
  focusStreamTuiHeader,
  initialStreamTuiNavigationState,
  setStreamTuiView,
  type StreamTuiView,
} from "../src/stream-tui/navigation-state.ts";
import { resolveStreamPath as resolveStreamPathForCurrent } from "../src/stream-tui/stream-paths.ts";
import {
  getDefaultExpandedStreamPaths,
  getStreamTreeRows,
  type StreamTreeRow,
} from "../src/stream-tui/stream-tree.ts";

// ---------------------------------------------------------------------------
// Color palette — follows the OpenTUI keymap-demo pattern of a single palette
// object for all colors. See:
// https://github.com/anomalyco/opentui/blob/main/packages/core/src/examples/keymap-demo.ts
// ---------------------------------------------------------------------------

const P = {
  /** Main background */
  bg: "#0b0f14",
  /** Panel/border surfaces */
  surface: "#27272a",
  /** Autocomplete dropdown background */
  surfaceDark: "#111827",
  /** YAML card body background */
  surfaceCard: "#0f172a",
  /** Selected row highlight */
  surfaceSelected: "#1f2937",
  /** Header border (slightly lighter than surface) */
  borderHeader: "#3f3f46",
  /** Primary accent (green) — focus borders, connection indicator, cursor */
  accent: "#22c55e",
  /** Dimmed accent for the pulsing connection dot */
  accentDim: "#16a34a",
  /** Warning (yellow) — connecting/disconnected indicator */
  warning: "#facc15",
  /** Primary text */
  text: "#e5e7eb",
  /** Secondary text (stats bar) */
  textSecondary: "#9ca3af",
  /** Body text (feed item default) */
  textBody: "#d1d5db",
  /** Content text (yaml values, slash labels) */
  textContent: "#cbd5e1",
  /** Muted text (placeholders, help hints) */
  textMuted: "#6b7280",
  /** Dim text (event summaries, inactive labels) */
  textDim: "#71717a",
  /** Subdued text (non-current stream rows) */
  textSubdued: "#94a3b8",
  /** Assistant/agent message header */
  agent: "#a78bfa",
  /** Error/danger text */
  danger: "#ef4444",
} as const;

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error("stream-tui requires an interactive terminal.");
}

const args = parseArgs(process.argv.slice(2));
const client = createEventsOrpcClient({
  baseUrl: args.eventsBaseUrl,
  projectSlug: args.projectSlug,
});

// ---------------------------------------------------------------------------
// Mutable TUI state — module-level lets are the idiomatic pattern for
// OpenTUI's imperative API (same approach as the core examples).
// ---------------------------------------------------------------------------

type ReducedStreamState = ReturnType<typeof rawPrettyEventsStreamViewReducer.createInitialState>;
let state: ReducedStreamState = rawPrettyEventsStreamViewReducer.createInitialState();
let status = "connecting";
let appendStatus = "";
let eventCount = 0;
let pulseOn = true;
let selectedOffset: number | undefined;
/** When set, the feed shows the full YAML detail for this event offset. */
let detailEventOffset: number | undefined;
let selectedSlashCommandPath: string | undefined;
let selectedSlashQuery: string | undefined;
let navigationState = initialStreamTuiNavigationState;
let renderedView: StreamTuiView = "feed";
let currentStreamPath = args.streamPath;
let activeStreamController: AbortController | undefined;
let streamSummaries: StreamSummary[] = [];
let selectedStreamPath: StreamPath | undefined = currentStreamPath;
let expandedStreamPaths = getDefaultExpandedStreamPaths(currentStreamPath);
let streamSearchOpen = false;
let streamSearchQuery = "";
let lastSpaceTimestamp = 0;
let pulseInterval: ReturnType<typeof setInterval> | undefined;

/** Tear down background work (stream subscription, pulse timer). */
function cleanupRuntime() {
  activeStreamController?.abort();
  if (pulseInterval != null) {
    clearInterval(pulseInterval);
    pulseInterval = undefined;
  }
}

// ---------------------------------------------------------------------------
// Renderer + layout
//
// Three focusable regions stacked vertically: topBar, feed, inputBox.
// Tab/Shift+Tab cycles between them (see focusAdjacentRegion).
// ---------------------------------------------------------------------------

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  targetFps: 30,
  screenMode: "alternate-screen",
  consoleMode: "disabled",
  onDestroy: cleanupRuntime,
});

const root = new BoxRenderable(renderer, {
  width: "100%",
  height: "100%",
  flexDirection: "column",
  backgroundColor: P.bg,
});

const topBar = new BoxRenderable(renderer, {
  width: "100%",
  height: 3,
  flexDirection: "row",
  gap: 1,
  border: true,
  borderStyle: "single",
  borderColor: P.borderHeader,
  focusedBorderColor: P.accent,
  focusable: true,
  paddingLeft: 1,
  paddingRight: 1,
  backgroundColor: P.surface,
});

// iterate brand mark: white 𝑖 on black, using half-block characters (▐ ▌) for
// smooth sub-cell edges that blend into the parent background.
// ▐ (U+2590) fills the RIGHT half of the cell with fg color.
// ▌ (U+258C) fills the LEFT half of the cell with fg color.
const brandMark = new TextRenderable(renderer, {
  content: new StyledText([
    fg("#000000")(bg(P.surface)("▐")),
    bg("#000000")(fg("#ffffff")(" 𝑖 ")),
    fg("#000000")(bg(P.surface)("▌")),
  ]),
  width: 6,
  fg: P.text,
});
const streamPathText = new TextRenderable(renderer, {
  content: currentStreamPath,
  flexGrow: 1,
  fg: P.text,
});
const statsText = new TextRenderable(renderer, { content: "", fg: P.textSecondary });
const connectedIndicator = new TextRenderable(renderer, { content: "●", width: 2, fg: P.warning });

const feed = new ScrollBoxRenderable(renderer, {
  width: "100%",
  flexGrow: 1,
  border: true,
  borderStyle: "single",
  borderColor: P.surface,
  focusedBorderColor: P.accent,
  // OpenTUI's native sticky scroll pauses when the user scrolls away, then
  // resumes when they return to the edge:
  // https://opentui.com/docs/components/scrollbox#sticky-scroll
  stickyScroll: true,
  stickyStart: "bottom",
  contentOptions: { flexDirection: "column", paddingLeft: 1, paddingRight: 1 },
  backgroundColor: P.bg,
});

const input = new InputRenderable(renderer, {
  width: "100%",
  placeholder: "Type a message or / for commands",
  backgroundColor: "transparent",
  focusedBackgroundColor: "transparent",
  textColor: P.text,
  focusedTextColor: P.text,
  placeholderColor: P.textMuted,
  cursorColor: P.accent,
});

const slashAutocomplete = new BoxRenderable(renderer, {
  width: "100%",
  height: 0,
  flexDirection: "column",
  paddingLeft: 1,
  paddingRight: 1,
  backgroundColor: P.surfaceDark,
});

const inputBox = new BoxRenderable(renderer, {
  width: "100%",
  height: 3,
  flexDirection: "column",
  border: true,
  borderStyle: "single",
  borderColor: P.surface,
  focusedBorderColor: P.accent,
  focusable: true,
  paddingLeft: 1,
  paddingRight: 1,
  backgroundColor: P.bg,
});

// Assemble the widget tree
topBar.add(brandMark);
topBar.add(streamPathText);
topBar.add(statsText);
topBar.add(connectedIndicator);
root.add(topBar);
root.add(feed);
inputBox.add(input);
root.add(slashAutocomplete);
root.add(inputBox);
renderer.root.add(root);

// ---------------------------------------------------------------------------
// Keyboard input — uses prependInputHandler to intercept keys before OpenTUI's
// built-in handlers (e.g. InputRenderable's text handling). This is the
// recommended approach when you need global key interception:
// https://opentui.com/docs/core-concepts/keyboard
// ---------------------------------------------------------------------------

input.focus();
renderer.prependInputHandler((sequence) => {
  // OpenTUI enables Kitty keyboard protocol by default (renderer.ts:636).
  // Ghostty and other modern terminals send Kitty-encoded keys (e.g. \x1b[9;2u
  // for Shift+Tab instead of legacy \x1b[Z). We must pass useKittyKeyboard so
  // parseKeypress can decode both Kitty and legacy escape sequences.
  const parsedKey = parseKeypress(sequence, { useKittyKeyboard: true });
  if (parsedKey == null) return false;

  const key = new KeyEvent(parsedKey);

  // Slash autocomplete takes priority when visible
  if (handleSlashAutocompleteKey(key)) return true;

  // Tab / Shift+Tab cycles focus between header, feed, and input.
  // OpenTUI's parseKeypress maps \x1b[Z (Shift+Tab) to name:"tab" + shift:true.
  if (key.name === "tab") {
    focusAdjacentRegion(key.shift ? -1 : 1);
    return true;
  }

  // Streams view has its own key handling (arrow nav, type-to-filter, etc.)
  if (
    navigationState.focus === "feed" &&
    navigationState.view === "streams" &&
    handleStreamsViewKey({ key, sequence })
  ) {
    return true;
  }

  // Esc from header → return to input + feed view
  if (navigationState.focus !== "feed") {
    if (key.name !== "escape") return false;
    returnToFeedView();
    return true;
  }

  // Esc from feed — close detail view (return to feed with selection visible),
  // or return to input if already on the feed
  if (key.name === "escape") {
    if (detailEventOffset != null) {
      detailEventOffset = undefined;
      updateHeader();
      updateFeed("selected");
      return true;
    }
    returnToFeedView();
    return true;
  }

  // In event detail view: left/right navigates between events
  if (detailEventOffset != null) {
    if (key.name === "left") {
      navigateDetailEvent(-1);
      return true;
    }
    if (key.name === "right") {
      navigateDetailEvent(1);
      return true;
    }
    return false;
  }

  // Arrow keys navigate feed items when feed is focused
  if (key.name === "down") {
    selectAdjacentFeedItem(1);
    return true;
  }
  if (key.name === "up") {
    selectAdjacentFeedItem(-1);
    return true;
  }

  // Enter, Space, or Right arrow opens the event detail view
  if (
    (key.name === "return" || key.name === "right" || key.name === "space") &&
    selectedOffset != null
  ) {
    detailEventOffset = selectedOffset;
    updateHeader();
    updateFeed("keep");
    return true;
  }

  return false;
});

// Wire up events
input.on(InputRenderableEvents.INPUT, () => updateSlashAutocomplete());
input.on(InputRenderableEvents.ENTER, () => void appendInput());
renderer.on(CliRenderEvents.RESIZE, () => {
  updateHeader();
  updateFeed("keep");
});

// Pulse the connection indicator to show liveness
pulseInterval = setInterval(() => {
  pulseOn = !pulseOn;
  updateHeader();
}, 700).unref();

// Initial render + start streaming
updateHeader();
updateFeed();
startStream(currentStreamPath);

// ---------------------------------------------------------------------------
// Stream lifecycle
// ---------------------------------------------------------------------------

/** Reset state and begin streaming events from the given path. */
function startStream(streamPath: StreamPath) {
  activeStreamController?.abort();
  activeStreamController = new AbortController();
  state = rawPrettyEventsStreamViewReducer.createInitialState();
  eventCount = 0;
  selectedOffset = undefined;
  detailEventOffset = undefined;
  status = "connecting";
  // Force renderedView to differ from the current view so updateFeed() detects a
  // "view change" and re-enables sticky scroll to bottom for the fresh stream.
  renderedView = navigationState.view === "feed" ? "state" : renderedView;
  updateHeader();
  updateFeed();
  void streamEvents({ streamPath, signal: activeStreamController.signal });
}

/** Long-running async loop that consumes the server-sent event stream. */
async function streamEvents(args: { streamPath: StreamPath; signal: AbortSignal }) {
  try {
    const stream = await client.stream(
      { path: args.streamPath, afterOffset: "start" },
      { signal: args.signal },
    );
    status = "streaming";
    updateHeader();

    for await (const value of stream) {
      if (args.signal.aborted || args.streamPath !== currentStreamPath) return;
      const event = Event.parse(value);
      eventCount += 1;
      state = rawPrettyEventsStreamViewReducer.reduce({ event, state }) ?? state;
      updateHeader();
      updateFeed("keep");
    }

    status = "stream closed";
  } catch (error) {
    if (args.signal.aborted || args.streamPath !== currentStreamPath) return;
    status = `stream error: ${formatError(error)}`;
  }

  updateHeader();
}

// ---------------------------------------------------------------------------
// Input handling — submitting messages and slash commands
// ---------------------------------------------------------------------------

/** Handle Enter in the input box: run slash command or append a chat message. */
async function appendInput() {
  const content = input.value.trim();
  if (content.length === 0) return;

  input.value = "";
  updateSlashAutocomplete();
  if (await runSlashCommand(content)) return;

  appendStatus = "sending";
  updateHeader();

  const event: EventInput = {
    type: "events.iterate.com/tui/user-message-added",
    payload: { content },
  };
  try {
    const appendedEvent = await streamApi.append({ event });
    appendStatus = `sent offset ${appendedEvent.offset}`;
  } catch (error) {
    appendStatus = `append error: ${formatError(error)}`;
  }
  updateHeader();
}

/**
 * Try to parse and execute a slash command from the input text.
 * Returns true if the input was recognized as a command (even if it failed).
 */
async function runSlashCommand(content: string) {
  if (!content.startsWith("/")) return false;

  const invocation = parseSlashInvocation(content);
  if (invocation == null) return false;

  const command = findDiscoveredSlashCommand({ commands: commandEntries, slash: invocation.slash });
  if (command == null) {
    appendStatus = `unknown command /${invocation.slash}`;
    updateHeader();
    return true;
  }

  try {
    appendStatus = "";
    await runTuiCommand({
      appContext,
      command,
      inputValue: parseSlashCommandInput({
        commandTitle: command.title,
        slashName: command.slash.name,
        input: command.input,
        rawArgs: invocation.rawArgs,
      }),
    });
  } catch (error) {
    if (error instanceof MissingCommandArgumentsError) {
      appContext.prefillInput(`/${error.slashName} `);
    }
    appContext.toast.error(formatError(error));
  }

  appendStatus ||= `/${invocation.slash}`;
  updateHeader();
  updateFeed(navigationState.view === "streams" ? "selected" : "keep");
  return true;
}

// ---------------------------------------------------------------------------
// Stream API — bridges slash commands to the events oRPC client
// ---------------------------------------------------------------------------

function resolveStreamPath(streamPath?: string) {
  return resolveStreamPathForCurrent({ currentStreamPath, streamPath });
}

const streamApi: StreamApi = {
  append: async (input) => {
    const result = await client.append({
      path: resolveStreamPath(input.streamPath),
      event: input.event,
    });
    return result.event;
  },
  getState: async (input = {}) => {
    return client.getState({ path: resolveStreamPath(input.streamPath) });
  },
  listChildren: async (input = {}) => {
    const children = await client.listChildren({ path: resolveStreamPath(input.streamPath) });
    return children.map((child) => ({
      path: StreamPath.parse(child.path),
      createdAt: child.createdAt,
    }));
  },
  reset: async (input) => {
    return client.destroy({
      params: { path: resolveStreamPath(input.streamPath) },
      query: { destroyChildren: input.destroyChildren },
    });
  },
  resolvePath: resolveStreamPath,
};

// ---------------------------------------------------------------------------
// App context — the bridge between slash commands and TUI state
// ---------------------------------------------------------------------------

const appContext: AppContext = {
  get streamPath() {
    return currentStreamPath;
  },
  get reducedState() {
    return state;
  },
  streamApi,
  setActiveView(view) {
    navigationState = setStreamTuiView(navigationState, view);
  },
  setStreamSummaries(streams, filter) {
    streamSummaries = streams;
    selectedStreamPath = currentStreamPath;
    expandedStreamPaths = new Set([
      ...expandedStreamPaths,
      ...getDefaultExpandedStreamPaths(currentStreamPath),
    ]);
    if (filter != null && filter.length > 0) {
      streamSearchOpen = true;
      streamSearchQuery = filter;
    } else {
      streamSearchOpen = false;
      streamSearchQuery = "";
    }
  },
  navigateToStream(streamPath) {
    currentStreamPath = streamPath;
    selectedStreamPath = streamPath;
    expandedStreamPaths = new Set([
      ...expandedStreamPaths,
      ...getDefaultExpandedStreamPaths(streamPath),
    ]);
    streamSearchOpen = false;
    streamSearchQuery = "";
    navigationState = setStreamTuiView(navigationState, "feed");
    appendStatus = `opened ${streamPath}`;
    startStream(streamPath);
  },
  restartStream() {
    startStream(currentStreamPath);
  },
  prefillInput(value) {
    input.value = value;
    focusInput();
    updateSlashAutocomplete();
  },
  collapseVisibleFeedItems() {},
  expandVisibleFeedItems() {},
  openEventDetail(offset) {
    detailEventOffset = offset;
    selectedOffset = offset;
    navigationState = setStreamTuiView(navigationState, "feed");
    updateHeader();
    updateFeed("keep");
    focusFeed();
  },
  exit() {
    cleanupRuntime();
    renderer.destroy();
    process.exit(0);
  },
  toast: {
    info(message) {
      appendStatus = message;
    },
    success(message) {
      appendStatus = message;
    },
    error(message) {
      appendStatus = `error: ${message}`;
    },
  },
};

// ---------------------------------------------------------------------------
// Header rendering
// ---------------------------------------------------------------------------

/** Update the top bar to reflect current view, connection status, and stats. */
function updateHeader() {
  streamPathText.content =
    detailEventOffset != null
      ? `Event ${detailEventOffset}`
      : navigationState.view === "streams"
        ? "Streams"
        : navigationState.view === "state"
          ? "State"
          : currentStreamPath;
  connectedIndicator.content = "●";
  connectedIndicator.fg = status === "streaming" ? (pulseOn ? P.accent : P.accentDim) : P.warning;
  statsText.content = [
    `${eventCount} event${eventCount === 1 ? "" : "s"}`,
    `${state.slots.feed.length} item${state.slots.feed.length === 1 ? "" : "s"}`,
    status === "streaming" ? "" : status,
    appendStatus,
  ]
    .filter(Boolean)
    .join(" · ");
}

// ---------------------------------------------------------------------------
// Feed rendering — the main scrollable content area
// ---------------------------------------------------------------------------

/**
 * The usable text width inside the feed's content area.
 * feed.viewport.width gives the width inside the border (excluding scrollbar),
 * minus 2 for the contentOptions paddingLeft/paddingRight.
 */
function getFeedContentWidth() {
  return Math.max(3, feed.viewport.width - 2);
}

/**
 * Re-render all feed children and manage scroll position.
 * @param scroll - "keep" preserves position (or sticks to bottom), "selected"
 *   scrolls the selected item into view.
 */
function updateFeed(scroll: "selected" | "keep" = "keep") {
  const viewChanged = navigationState.view !== renderedView;
  const shouldStickToBottom =
    navigationState.view === "feed" &&
    scroll === "keep" &&
    (navigationState.focus !== "feed" || viewChanged || isFeedAtBottom());

  feed.stickyScroll = navigationState.view === "feed";
  feed.stickyStart = navigationState.view === "feed" ? "bottom" : undefined;
  renderedView = navigationState.view;

  clearBoxChildren(feed);
  for (const child of renderFeedChildren()) {
    feed.add(child);
  }

  if (scroll === "selected" && navigationState.view === "streams") {
    setImmediate(() =>
      feed.scrollChildIntoView(`events-feed-stream-${selectedStreamPath ?? "none"}`),
    );
  } else if (scroll === "selected") {
    // Raw event IDs from the reducer are "raw-event-{offset}"
    setImmediate(() => feed.scrollChildIntoView(`raw-event-${selectedOffset ?? "none"}`));
  } else if (shouldStickToBottom) {
    setImmediate(() => feed.scrollTo(feed.scrollHeight));
    setTimeout(() => feed.scrollTo(feed.scrollHeight), 0).unref();
  } else if (navigationState.view !== "feed") {
    setImmediate(() => feed.scrollTo(0));
  }
}

/** Dispatch to the active view's renderer. */
function renderFeedChildren() {
  if (navigationState.view === "state") return renderStateViewChildren();
  if (navigationState.view === "streams") return renderStreamsViewChildren();
  if (detailEventOffset != null) return renderEventDetailView();

  if (state.slots.feed.length === 0) {
    return [
      new TextRenderable(renderer, {
        id: "events-feed-waiting",
        content: "Waiting for events...",
        width: "100%",
        height: 1,
        fg: P.textBody,
      }),
    ];
  }

  const elapsedByOffset = getElapsedByOffset(state.slots.feed);
  const children: TextRenderable[] = [];
  let lastDateStr: string | undefined;

  for (const item of state.slots.feed) {
    // Date boundary — insert a horizontal rule when events cross a calendar date
    const itemTimestamp = getItemTimestamp(item);
    if (itemTimestamp != null) {
      const dateStr = new Date(itemTimestamp).toLocaleDateString(undefined, {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      if (lastDateStr != null && dateStr !== lastDateStr) {
        const width = getFeedContentWidth();
        const label = ` ${dateStr} `;
        const lineLen = Math.max(0, width - label.length);
        const left = "─".repeat(Math.floor(lineLen / 2));
        const right = "─".repeat(Math.ceil(lineLen / 2));
        children.push(
          new TextRenderable(renderer, {
            id: `date-boundary-${itemTimestamp}`,
            content: new StyledText([fg(P.textDim)(`\n${left}${label}${right}\n`)]),
            width: "100%",
            height: 2,
            fg: P.textDim,
          }),
        );
      }
      lastDateStr = dateStr;
    }

    const chunks = renderFeedItem(item, elapsedByOffset);
    if (chunks.length === 0) continue;
    children.push(
      new TextRenderable(renderer, {
        id: item.id,
        content: new StyledText(chunks),
        width: "100%",
        height: countTextLines(chunks.map((c) => c.text).join("")),
        fg: P.textBody,
      }),
    );
  }

  return children;
}

/** Debug view: dump the full TUI + reducer state as YAML. */
function renderStateViewChildren() {
  const content = stringifyYaml({
    streamPath: currentStreamPath,
    status,
    appendStatus,
    eventCount,
    navigationState,
    selectedOffset,
    detailEventOffset,
    reducedState: state,
  }).trimEnd();

  return [
    new TextRenderable(renderer, {
      id: "events-feed-state",
      content,
      width: "100%",
      height: countTextLines(content),
      fg: P.textContent,
    }),
  ];
}

// ---------------------------------------------------------------------------
// Streams tree view
// ---------------------------------------------------------------------------

/** Render the streams tree browser with help bar and search. */
function renderStreamsViewChildren() {
  const rows = getVisibleStreamRows();
  const children = [];

  const helpText = streamSearchOpen
    ? `filter: ${streamSearchQuery}▏`
    : "↑↓ navigate · ←→ expand/collapse · Space toggle · 2×Space expand all · Enter open · Type to filter";

  children.push(
    new TextRenderable(renderer, {
      id: "events-feed-streams-help",
      content: new StyledText([fg(P.textDim)(` ${helpText}\n`)]),
      width: "100%",
      height: 2,
      fg: P.textMuted,
    }),
  );

  if (rows.length === 0) {
    children.push(
      new TextRenderable(renderer, {
        id: "events-feed-streams-empty",
        content:
          streamSearchQuery.trim().length > 0
            ? `No streams match "${streamSearchQuery}".`
            : "No streams loaded. Type /streams.tree to load the stream tree.",
        width: "100%",
        height: 1,
        fg: P.textDim,
      }),
    );
    return children;
  }

  for (const row of rows) {
    children.push(
      new TextRenderable(renderer, {
        id: `events-feed-stream-${row.path}`,
        content: new StyledText(renderStreamTreeRowChunks(row)),
        width: "100%",
        height: 1,
        fg: P.textContent,
      }),
    );
  }

  return children;
}

/**
 * Render a single stream tree row as styled text chunks.
 * Left side: tree indent + expand/collapse icon + path label (with fuzzy match highlighting).
 * Right side: current indicator + timestamp, right-aligned to fill the full width.
 */
function renderStreamTreeRowChunks(row: StreamTreeRow) {
  const width = getFeedContentWidth();
  const selected = navigationState.focus === "feed" && row.selected;
  const color = row.current ? P.text : P.textSubdued;
  const style = (value: string, matched?: boolean) => {
    const chunk = selected ? bg(P.surfaceSelected)(fg(color)(value)) : fg(color)(value);
    return matched ? bold(chunk) : chunk;
  };

  const prefix = `${"  ".repeat(row.depth)}${row.hasChildren ? (row.expanded ? "▾" : "▸") : " "} `;
  const suffix = [
    row.current ? "●" : "",
    row.createdAt == null ? "" : formatTime(new Date(row.createdAt).getTime()),
  ]
    .filter(Boolean)
    .join("  ");

  const label = row.labelSegments.map((s) => s.text).join("");
  const gap = Math.max(2, width - prefix.length - label.length - suffix.length);

  return [
    style(prefix),
    ...row.labelSegments.map((segment) => style(segment.text, segment.matched)),
    style(suffix.length > 0 ? " ".repeat(gap) + suffix : " ".repeat(gap)),
  ];
}

// ---------------------------------------------------------------------------
// Feed item rendering — dispatch by element type
// ---------------------------------------------------------------------------

/** Extract a timestamp from any feed element (used for date boundary detection). */
function getItemTimestamp(item: EventsStreamBuiltInElement): number | undefined {
  if ("timestamp" in item.props) return item.props.timestamp as number;
  if ("firstTimestamp" in item.props) return item.props.firstTimestamp as number;
  return undefined;
}

/** Route a feed element to its renderer, returning styled text chunks. */
function renderFeedItem(item: EventsStreamBuiltInElement, elapsedByOffset: Map<number, string>) {
  if (item.type === "raw-event")
    return renderRawEventSummary(item, elapsedByOffset.get(item.props.offset));
  if (item.type === "message") return renderMessageItem(item.props);
  if (item.type === "lifecycle") return renderLifecycleItem(item.props);
  if (item.type === "error") return renderErrorItem(item.props);
  if (item.type === "child-stream-created") return renderChildStreamItem(item.props);
  if (item.type === "grouped-raw-event") return renderGroupedRawItem(item.props);
  return [];
}

/**
 * Render a chat message. Mirrors the web renderer's pattern:
 * - User messages: right-aligned with accent color header
 * - Assistant messages: left-aligned with purple header
 * Both show "role · timestamp" header then wrapped body text.
 */
function renderMessageItem(props: { role: "user" | "assistant"; text: string; timestamp: number }) {
  const width = getFeedContentWidth();
  const isUser = props.role === "user";
  const label = isUser ? "You" : "Agent";
  const labelColor = isUser ? P.accent : P.agent;
  const time = formatTime(props.timestamp);
  const wrappedLines = props.text.split("\n").flatMap((line) => wrapLine(line, width - 2));

  if (isUser) {
    // User: right-aligned header, content indented from right (matches web's ml-auto bubble)
    const header = rightAlign(`${label} · ${time}`, width);
    return [
      fg(P.bg)("\n"),
      bold(fg(labelColor)(`${header}\n`)),
      ...wrappedLines.map((line) => fg(P.text)(`${rightAlign(line, width)}\n`)),
    ];
  }

  // Assistant: left-aligned, no bubble (matches web's bare left-aligned text)
  return [
    fg(P.bg)("\n"),
    bold(fg(labelColor)(`${label} · ${time}\n`)),
    ...wrappedLines.map((line) => fg(P.text)(`  ${line}\n`)),
  ];
}

/**
 * Render a lifecycle event as a centered horizontal rule with label pill.
 * Matches the web renderer's TimelineLine: ──── label ────
 */
function renderLifecycleItem(props: { label: string; timestamp: number }) {
  const width = getFeedContentWidth();
  const label = ` ${props.label} · ${formatTime(props.timestamp)} `;
  const lineLen = Math.max(0, width - label.length);
  const left = "─".repeat(Math.floor(lineLen / 2));
  const right = "─".repeat(Math.ceil(lineLen / 2));
  return [fg(P.textDim)(`${left}${label}${right}\n`)];
}

/**
 * Render an error event. Matches the web's FeedEvent with tone="danger":
 * ⚠ Error: message · timestamp
 */
function renderErrorItem(props: { message: string; timestamp: number }) {
  const width = getFeedContentWidth();
  const text = `⚠ Error: ${props.message}`;
  const time = formatTime(props.timestamp);
  const padded = `${text}${" ".repeat(Math.max(1, width - text.length - time.length))}${time}`;
  return [fg(P.bg)("\n"), fg(P.danger)(`${padded}\n`)];
}

/**
 * Render a child-stream-created event.
 * Matches the web's FeedEvent with FolderPlusIcon.
 */
function renderChildStreamItem(props: { childPath: string; timestamp: number }) {
  const width = getFeedContentWidth();
  const text = `＋ Child stream: ${props.childPath}`;
  const time = formatTime(props.timestamp);
  const padded = `${text}${" ".repeat(Math.max(1, width - text.length - time.length))}${time}`;
  return [fg(P.textSubdued)(`${padded}\n`)];
}

/**
 * Render a grouped raw event as a right-aligned compact summary.
 * Matches the web's right-aligned muted text with count badge and · separators.
 */
function renderGroupedRawItem(props: {
  eventType: string;
  count: number;
  firstTimestamp: number;
  lastTimestamp: number;
}) {
  const width = getFeedContentWidth();
  const elapsed = formatElapsedTime(props.lastTimestamp - props.firstTimestamp);
  const summary = `${props.eventType} · ×${props.count} · ${elapsed} · ${formatTime(props.lastTimestamp)}`;
  return [fg(P.textDim)(`${rightAlign(summary, width)}\n`)];
}

// ---------------------------------------------------------------------------
// Raw event summary row — compact right-aligned one-liner matching the web's
// tiny muted justify-end style. Press Enter to open the detail view.
// ---------------------------------------------------------------------------

/**
 * Render a raw event as a compact right-aligned summary row.
 * Shows: offset · event type · elapsed · timestamp
 * Highlighted when selected (feed focus mode).
 */
function renderRawEventSummary(item: EventsStreamRawEventElement, elapsedLabel?: string) {
  const width = getFeedContentWidth();
  const isSelected = navigationState.focus === "feed" && item.props.offset === selectedOffset;
  const summary = `${rightAlign(formatEventSummary(item, elapsedLabel), width)}\n`;
  return [isSelected ? bg(P.surfaceSelected)(fg(P.text)(summary)) : fg(P.textDim)(summary)];
}

// ---------------------------------------------------------------------------
// Event detail view — full YAML payload with left/right navigation.
// Mirrors the web's EventInspectorSheet (packages/ui event-inspector-sheet.tsx).
// ---------------------------------------------------------------------------

/** Render the full event detail view for detailEventOffset. */
function renderEventDetailView(): TextRenderable[] {
  const rawEvents = getRawFeedItems();
  const currentIndex = rawEvents.findIndex((item) => item.props.offset === detailEventOffset);
  const event = rawEvents[currentIndex]?.props.raw;

  if (event == null) {
    detailEventOffset = undefined;
    return [];
  }

  const width = getFeedContentWidth();
  const prevEvent = rawEvents[currentIndex - 1]?.props.raw;
  const nextEvent = rawEvents[currentIndex + 1]?.props.raw;
  const sincePrev = prevEvent
    ? formatElapsedTime(Date.parse(event.createdAt) - Date.parse(prevEvent.createdAt))
    : undefined;
  const toNext = nextEvent
    ? formatElapsedTime(Date.parse(nextEvent.createdAt) - Date.parse(event.createdAt))
    : undefined;

  // Header: event type and navigation hints
  const headerLine = bold(fg(P.text)(`${event.type}\n`));
  const metaParts = [
    `offset ${event.offset}`,
    event.createdAt,
    sincePrev ? `since prev: ${sincePrev}` : undefined,
    toNext ? `until next: ${toNext}` : undefined,
  ].filter(Boolean);
  const metaLine = fg(P.textSubdued)(`${metaParts.join(" · ")}\n`);
  const navHint = fg(P.textDim)("← prev · → next · Esc close\n");
  const separator = fg(P.textDim)(`${"─".repeat(width)}\n`);

  // YAML body
  const yaml = stringifyYaml(orderEventKeysForYamlDisplay(event)).trimEnd();
  const bodyLine = (line: string) =>
    bg(P.surfaceCard)(fg(P.textContent)(` ${line.padEnd(width - 2)} \n`));
  const bodyLines = yaml
    .split("\n")
    .flatMap((line) => wrapLine(line, width - 2))
    .map(bodyLine);

  const chunks = [headerLine, metaLine, navHint, separator, ...bodyLines];

  return [
    new TextRenderable(renderer, {
      id: `event-detail-${detailEventOffset}`,
      content: new StyledText(chunks),
      width: "100%",
      height: countTextLines(chunks.map((c) => c.text).join("")),
      fg: P.textBody,
    }),
  ];
}

/** Navigate to the previous/next raw event in the detail view. */
function navigateDetailEvent(direction: -1 | 1) {
  const rawEvents = getRawFeedItems();
  const currentIndex = rawEvents.findIndex((item) => item.props.offset === detailEventOffset);
  if (currentIndex === -1) return;

  const nextIndex = currentIndex + direction;
  if (nextIndex < 0 || nextIndex >= rawEvents.length) return;

  detailEventOffset = rawEvents[nextIndex].props.offset;
  selectedOffset = detailEventOffset;
  updateFeed("keep");
}

// ---------------------------------------------------------------------------
// Focus management
//
// Three regions in visual top-to-bottom order: header, feed, composer (input).
// Tab cycles forward, Shift+Tab cycles backward.
// ---------------------------------------------------------------------------

/** Focus the feed panel and select the last item if nothing is selected. */
function focusFeed() {
  navigationState = focusStreamTuiFeed(navigationState);
  if (navigationState.view === "streams") {
    selectedStreamPath ??= currentStreamPath;
  } else {
    const rawItems = getRawFeedItems();
    selectedOffset ??= rawItems[rawItems.length - 1]?.props.offset;
  }
  input.placeholder = "Tab to return to input";
  feed.focus();
  updateHeader();
  updateFeed("selected");
}

/** Focus the input box and reset placeholder. */
function focusInput() {
  navigationState = focusStreamTuiComposer(navigationState);
  streamSearchOpen = false;
  input.placeholder = "Type a message or / for commands";
  input.focus();
  updateHeader();
  updateFeed("keep");
}

/** Focus the header bar. */
function focusHeader() {
  navigationState = focusStreamTuiHeader(navigationState);
  input.placeholder = "Tab to return to input";
  topBar.focus();
  updateHeader();
  updateFeed("keep");
}

/** Cycle focus between header → feed → composer (or reverse with direction=-1). */
function focusAdjacentRegion(direction: -1 | 1) {
  const regions = ["header", "feed", "composer"] as const;
  const currentIndex = regions.indexOf(navigationState.focus);
  const nextIndex = (currentIndex + direction + regions.length) % regions.length;
  const next = regions[nextIndex];
  if (next === "composer") focusInput();
  else if (next === "feed") focusFeed();
  else focusHeader();
}

/** Switch back to feed view and focus the input. Used by Esc from any region. */
function returnToFeedView() {
  if (navigationState.view !== "feed") {
    navigationState = setStreamTuiView(navigationState, "feed");
    updateHeader();
    updateFeed("keep");
  }
  focusInput();
}

// ---------------------------------------------------------------------------
// Feed item selection (up/down in event feed view)
// ---------------------------------------------------------------------------

/** Move selection to the next/previous raw event in the feed. */
function selectAdjacentFeedItem(direction: -1 | 1) {
  const rawItems = getRawFeedItems();
  if (rawItems.length === 0) return;

  const currentIndex = rawItems.findIndex((item) => item.props.offset === selectedOffset);
  const nextIndex =
    currentIndex === -1 ? (direction === 1 ? 0 : rawItems.length - 1) : currentIndex + direction;

  // Clamp to bounds — don't wrap around
  if (nextIndex < 0 || nextIndex >= rawItems.length) return;

  selectedOffset = rawItems[nextIndex].props.offset;
  updateFeed("selected");
}

// ---------------------------------------------------------------------------
// Slash command autocomplete
// ---------------------------------------------------------------------------

/**
 * Refresh the autocomplete dropdown based on the current input value.
 *
 * Two modes:
 * - **Search mode**: input is a partial slash query (e.g. "/str") — show matching commands
 * - **Docs mode**: input is a resolved command with args (e.g. "/stream.reset --no-children")
 *   — show the command's description, usage, and available arguments
 */
function updateSlashAutocomplete() {
  // Check if the input matches a resolved command (has a space after the slash name)
  if (input.value.startsWith("/") && input.value.includes(" ")) {
    const invocation = parseSlashInvocation(input.value);
    if (invocation != null) {
      const command = findDiscoveredSlashCommand({
        commands: commandEntries,
        slash: invocation.slash,
      });
      if (command != null) {
        showCommandDocs(command);
        return;
      }
    }
  }

  const commands = suggestSlashCommands({ commands: commandEntries, input: input.value, limit: 8 });

  if (commands.length === 0) {
    selectedSlashCommandPath = undefined;
    selectedSlashQuery = undefined;
    slashAutocomplete.height = 0;
    clearBoxChildren(slashAutocomplete);
    return;
  }

  const query = parseSlashAutocompleteQuery(input.value);
  if (
    query !== selectedSlashQuery ||
    !commands.some((command) => command.path === selectedSlashCommandPath)
  ) {
    selectedSlashCommandPath = commands[0].path;
    selectedSlashQuery = query;
  }

  slashAutocomplete.height = Math.min(commands.length, 8);
  clearBoxChildren(slashAutocomplete);

  for (const command of commands) {
    const isSelected = command.path === selectedSlashCommandPath;
    const chunks = formatSlashCommandLabelSegments({ command, input: input.value }).map(
      (segment) => {
        const chunk = isSelected
          ? bg(P.surfaceSelected)(fg(P.text)(segment.text))
          : fg(P.textDim)(segment.text);
        return segment.matched ? bold(chunk) : chunk;
      },
    );
    slashAutocomplete.add(
      new TextRenderable(renderer, {
        id: `events-slash-command-${command.path}`,
        content: new StyledText(chunks),
        width: "100%",
        height: 1,
        fg: P.textContent,
      }),
    );
  }
}

/**
 * Show inline documentation for a resolved command in the autocomplete area.
 * Displays: command name, description, positional arg, options, and flags.
 */
function showCommandDocs(command: CommandEntry) {
  clearBoxChildren(slashAutocomplete);

  const lines: string[] = [];
  lines.push(`/${command.slash.name}  ${command.description ?? command.title}`);

  if (command.input?.positional) {
    const pos = command.input.positional;
    lines.push(`  <${pos.name}>${pos.required ? "" : "?"} ${pos.placeholder ?? ""}`);
  }
  for (const opt of command.input?.options ?? []) {
    lines.push(`  ${opt.flag} <${opt.name}>`);
  }
  for (const flag of command.input?.flags ?? []) {
    lines.push(`  ${flag.flag}`);
  }

  slashAutocomplete.height = lines.length;
  for (const [i, line] of lines.entries()) {
    slashAutocomplete.add(
      new TextRenderable(renderer, {
        id: `events-slash-docs-${i}`,
        content: new StyledText([i === 0 ? bold(fg(P.text)(line)) : fg(P.textSubdued)(line)]),
        width: "100%",
        height: 1,
        fg: P.textContent,
      }),
    );
  }
}

/**
 * Handle keyboard events when the slash autocomplete dropdown is visible.
 * Returns true if the key was consumed.
 */
function handleSlashAutocompleteKey(key: KeyEvent) {
  // Only intercept keys when the autocomplete dropdown is actually visible.
  // Without this guard, any "/" left in the input (e.g. after Esc) would cause
  // suggestSlashCommands to return results, swallowing Tab/Shift+Tab forever.
  if (slashAutocomplete.height === 0) return false;
  const commands = suggestSlashCommands({ commands: commandEntries, input: input.value, limit: 8 });
  if (commands.length === 0) return false;

  if (key.name === "escape") {
    selectedSlashCommandPath = undefined;
    slashAutocomplete.height = 0;
    clearBoxChildren(slashAutocomplete);
    return true;
  }

  if (key.name === "tab" || key.name === "down") {
    // Move selection in the autocomplete list
    const currentIndex = commands.findIndex((c) => c.path === selectedSlashCommandPath);
    const direction = key.shift ? -1 : 1;
    const nextIndex =
      currentIndex === -1
        ? direction === 1
          ? 0
          : commands.length - 1
        : (currentIndex + direction + commands.length) % commands.length;
    selectedSlashCommandPath = commands[nextIndex].path;
    updateSlashAutocomplete();
    return true;
  }

  if (key.name === "up") {
    const currentIndex = commands.findIndex((c) => c.path === selectedSlashCommandPath);
    const nextIndex =
      currentIndex === -1
        ? commands.length - 1
        : (currentIndex - 1 + commands.length) % commands.length;
    selectedSlashCommandPath = commands[nextIndex].path;
    updateSlashAutocomplete();
    return true;
  }

  if (key.name === "return") {
    const command = commands.find((entry) => entry.path === selectedSlashCommandPath);
    if (command != null) {
      input.value = acceptedSlashInput(command);
      updateSlashAutocomplete();
      if (command.input?.positional?.required !== true) {
        void appendInput();
      }
    }
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Streams view keyboard handling
// ---------------------------------------------------------------------------

/**
 * Handle keyboard events when the streams tree view is focused.
 * Returns true if the key was consumed.
 *
 * Navigation:  ↑↓ moves selection, ←→ collapses/expands, Enter opens,
 *              Space toggles, double-Space expands all descendants.
 * Filtering:   any printable character starts type-to-filter mode.
 *              Backspace removes chars, empty query exits filter mode.
 */
function handleStreamsViewKey(args: { key: KeyEvent; sequence: string }) {
  if (args.key.name === "escape") {
    if (streamSearchOpen) {
      streamSearchOpen = false;
      streamSearchQuery = "";
      updateFeed("selected");
      return true;
    }
    return false;
  }

  if (args.key.name === "down") {
    selectAdjacentStreamRow(1);
    return true;
  }
  if (args.key.name === "up") {
    selectAdjacentStreamRow(-1);
    return true;
  }

  // When search/filter is active, keys go to the search query
  if (streamSearchOpen) {
    if (args.key.name === "return") {
      openSelectedStreamPath();
      return true;
    }
    if (args.key.name === "backspace" || args.sequence === "\u007f") {
      streamSearchQuery = streamSearchQuery.slice(0, -1);
      if (streamSearchQuery.length === 0) streamSearchOpen = false;
      selectFirstMatchedStreamRow();
      updateFeed("selected");
      return true;
    }
    if (isPrintableCharacter(args.sequence)) {
      streamSearchQuery += args.sequence;
      selectFirstMatchedStreamRow();
      updateFeed("selected");
      return true;
    }
    return true;
  }

  if (args.key.name === "return") {
    openSelectedStreamPath();
    return true;
  }

  // Space toggles expand/collapse; double-space (within 300ms) expands all descendants
  if (args.sequence === " ") {
    const now = Date.now();
    if (now - lastSpaceTimestamp < 300) {
      expandAllDescendants();
      lastSpaceTimestamp = 0;
    } else {
      toggleSelectedStreamPath();
      lastSpaceTimestamp = now;
    }
    return true;
  }

  if (args.key.name === "right") {
    setSelectedStreamExpanded(true);
    return true;
  }
  if (args.key.name === "left") {
    setSelectedStreamExpanded(false);
    return true;
  }

  // Any printable character starts type-to-filter
  if (isPrintableCharacter(args.sequence)) {
    streamSearchOpen = true;
    streamSearchQuery = args.sequence;
    selectFirstMatchedStreamRow();
    updateFeed("selected");
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Stream tree selection helpers
// ---------------------------------------------------------------------------

function getVisibleStreamRows() {
  return getStreamTreeRows({
    streams: streamSummaries,
    currentStreamPath,
    expandedPaths: expandedStreamPaths,
    searchQuery: streamSearchOpen ? streamSearchQuery : "",
    selectedPath: selectedStreamPath,
  });
}

/** Move selection to the next/previous visible stream row. */
function selectAdjacentStreamRow(direction: -1 | 1) {
  const rows = getVisibleStreamRows();
  if (rows.length === 0) return;

  const currentIndex = rows.findIndex((row) => row.path === selectedStreamPath);
  const nextIndex =
    currentIndex === -1
      ? direction === 1
        ? 0
        : rows.length - 1
      : (currentIndex + direction + rows.length) % rows.length;

  selectedStreamPath = rows[nextIndex].path;
  updateFeed("selected");
}

/** Select the first row that matches the current search query. */
function selectFirstMatchedStreamRow() {
  const rows = getVisibleStreamRows();
  selectedStreamPath =
    rows.find((row) => row.labelSegments.some((segment) => segment.matched))?.path ??
    rows.find((row) => row.path === currentStreamPath)?.path ??
    rows[0]?.path;
}

/** Toggle expand/collapse on the selected stream. Opens leaf nodes. */
function toggleSelectedStreamPath() {
  const selectedRow = getVisibleStreamRows().find((row) => row.path === selectedStreamPath);
  if (selectedRow == null) return;

  if (!selectedRow.hasChildren) {
    openSelectedStreamPath();
    return;
  }
  setSelectedStreamExpanded(!selectedRow.expanded);
}

/** Set the expand state of the currently selected stream path. */
function setSelectedStreamExpanded(expanded: boolean) {
  if (selectedStreamPath == null) return;
  if (expanded) expandedStreamPaths.add(selectedStreamPath);
  else expandedStreamPaths.delete(selectedStreamPath);
  updateFeed("selected");
}

/** Recursively expand the selected stream and all its descendants. */
function expandAllDescendants() {
  if (selectedStreamPath == null) return;
  expandedStreamPaths.add(selectedStreamPath);
  for (const stream of streamSummaries) {
    if (stream.path.startsWith(selectedStreamPath + "/")) {
      expandedStreamPaths.add(stream.path);
    }
  }
  updateFeed("selected");
}

/** Navigate into the selected stream path. */
function openSelectedStreamPath() {
  if (selectedStreamPath == null) return;
  appContext.navigateToStream(selectedStreamPath);
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

/** Remove and destroy all children of a BoxRenderable. */
function clearBoxChildren(box: BoxRenderable | ScrollBoxRenderable) {
  for (const child of box.getChildren()) {
    child.destroyRecursively();
  }
}

function getRawFeedItems() {
  return state.slots.feed.filter(
    (item): item is EventsStreamRawEventElement => item.type === "raw-event",
  );
}

function isFeedAtBottom() {
  return feed.scrollTop >= Math.max(0, feed.scrollHeight - feed.viewport.height) - 1;
}

function isPrintableCharacter(sequence: string) {
  return sequence.length === 1 && sequence >= " " && sequence !== "\u007f";
}

/** Count visible lines in a text string (accounts for trailing newlines). */
function countTextLines(value: string) {
  if (value.length === 0) return 1;
  const lineBreaks = value.match(/\n/g)?.length ?? 0;
  return value.endsWith("\n") ? Math.max(1, lineBreaks) : lineBreaks + 1;
}

function formatError(error: unknown) {
  if (error instanceof ORPCError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const eventsBaseUrl = readFlag(argv, "--events-base-url");
  const projectSlug = readFlag(argv, "--project-slug");
  const streamPath = readFlag(argv, "--stream-path");

  if (eventsBaseUrl == null || projectSlug == null || streamPath == null) {
    throw new Error(
      "Usage: bun scripts/event-stream-terminal.ts --events-base-url <url> --project-slug <slug> --stream-path <path>",
    );
  }

  return {
    eventsBaseUrl,
    projectSlug: ProjectSlug.parse(projectSlug),
    streamPath: StreamPath.parse(streamPath),
  };
}

function readFlag(argv: string[], flagName: string) {
  const index = argv.indexOf(flagName);
  if (index === -1) return undefined;

  const value = argv[index + 1];
  if (value == null || value.startsWith("--")) {
    throw new Error(`${flagName} requires a value.`);
  }
  return value;
}
