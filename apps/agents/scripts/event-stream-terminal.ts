import { Event, ProjectSlug, StreamPath, type EventInput } from "@iterate-com/events-contract";
import type {
  EventsStreamBuiltInElement,
  EventsStreamRawEventElement,
} from "@iterate-com/ui/components/events/feed-items";
import { rawEventsStreamViewReducer } from "@iterate-com/ui/components/events/feed-processors";
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

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error("stream-tui requires an interactive terminal.");
}

const args = parseArgs(process.argv.slice(2));
const client = createEventsOrpcClient({
  baseUrl: args.eventsBaseUrl,
  projectSlug: args.projectSlug,
});

type ReducedStreamState = ReturnType<typeof rawEventsStreamViewReducer.createInitialState>;
let state: ReducedStreamState = rawEventsStreamViewReducer.createInitialState();
let status = "connecting";
let appendStatus = "";
let eventCount = 0;
let pulseOn = true;
let selectedOffset: number | undefined;
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
const collapsedOffsets = new Set<number>();

function cleanupRuntime() {
  activeStreamController?.abort();
  if (pulseInterval != null) {
    clearInterval(pulseInterval);
    pulseInterval = undefined;
  }
}

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
  backgroundColor: "#0b0f14",
});
const topBar = new BoxRenderable(renderer, {
  width: "100%",
  height: 5,
  flexDirection: "row",
  gap: 1,
  border: true,
  borderStyle: "single",
  borderColor: "#3f3f46",
  focusedBorderColor: "#22c55e",
  focusable: true,
  paddingTop: 1,
  paddingLeft: 1,
  paddingRight: 1,
  backgroundColor: "#27272a",
});
const connectedIndicator = new TextRenderable(renderer, { content: "●", width: 2, fg: "#facc15" });
const streamPathText = new TextRenderable(renderer, {
  content: currentStreamPath,
  flexGrow: 1,
  fg: "#e5e7eb",
});
const statsText = new TextRenderable(renderer, { content: "", fg: "#9ca3af" });
const feed = new ScrollBoxRenderable(renderer, {
  width: "100%",
  flexGrow: 1,
  border: true,
  borderStyle: "single",
  borderColor: "#27272a",
  focusedBorderColor: "#22c55e",
  // OpenTUI's native sticky scroll pauses when the user scrolls away, then
  // resumes when they return to the edge:
  // https://opentui.com/docs/components/scrollbox#sticky-scroll
  stickyScroll: true,
  stickyStart: "bottom",
  contentOptions: { flexDirection: "column", paddingLeft: 1, paddingRight: 1 },
  backgroundColor: "#0b0f14",
});
const input = new InputRenderable(renderer, {
  width: "100%",
  placeholder: "Type a message or / for commands",
  backgroundColor: "transparent",
  focusedBackgroundColor: "transparent",
  textColor: "#e5e7eb",
  focusedTextColor: "#e5e7eb",
  placeholderColor: "#6b7280",
  cursorColor: "#22c55e",
});
const slashAutocomplete = new BoxRenderable(renderer, {
  width: "100%",
  height: 0,
  flexDirection: "column",
  paddingLeft: 1,
  paddingRight: 1,
  backgroundColor: "#111827",
});
const inputBox = new BoxRenderable(renderer, {
  width: "100%",
  height: 5,
  flexDirection: "column",
  border: true,
  borderStyle: "single",
  borderColor: "#27272a",
  focusedBorderColor: "#22c55e",
  focusable: true,
  padding: 1,
  backgroundColor: "#0b0f14",
});
const inputSeparator = new BoxRenderable(renderer, {
  width: "100%",
  height: 1,
  backgroundColor: "#27272a",
});

topBar.add(streamPathText);
topBar.add(statsText);
topBar.add(connectedIndicator);
root.add(topBar);
root.add(feed);
inputBox.add(input);
root.add(slashAutocomplete);
root.add(inputSeparator);
root.add(inputBox);
renderer.root.add(root);

// Let OpenTUI focus own keyboard input. Forwarding raw stdin or renderer key
// events into this input duplicates real terminal keystrokes.
input.focus();
renderer.prependInputHandler((sequence) => {
  const parsedKey = parseKeypress(sequence);
  if (parsedKey == null) return false;

  const key = new KeyEvent(parsedKey);
  if (handleSlashAutocompleteKey(key)) {
    return true;
  }

  if (key.name === "tab" || key.name === "backtab") {
    focusAdjacentRegion(key.shift || key.name === "backtab" ? -1 : 1);
    return true;
  }

  if (
    navigationState.focus === "feed" &&
    navigationState.view === "streams" &&
    handleStreamsViewKey({ key, sequence })
  ) {
    return true;
  }

  if (navigationState.focus !== "feed") {
    if (key.name !== "escape") return false;

    if (navigationState.view !== "feed") {
      navigationState = setStreamTuiView(navigationState, "feed");
      updateHeader();
      updateFeed("keep");
    }
    focusInput();
    return true;
  }

  if (key.name === "escape") {
    if (navigationState.view !== "feed") {
      navigationState = setStreamTuiView(navigationState, "feed");
      updateHeader();
      updateFeed("keep");
    }
    focusInput();
    return true;
  }

  if (key.name === "down") {
    selectAdjacentFeedItem(1);
    return true;
  }

  if (key.name === "up") {
    selectAdjacentFeedItem(-1);
    return true;
  }

  if (key.name === "return" && selectedOffset != null) {
    toggleSelectedFeedItem();
    return true;
  }

  return false;
});
input.on(InputRenderableEvents.INPUT, () => updateSlashAutocomplete());
pulseInterval = setInterval(() => {
  pulseOn = !pulseOn;
  updateHeader();
}, 700).unref();
input.on(InputRenderableEvents.ENTER, () => void appendInput());
renderer.on(CliRenderEvents.RESIZE, () => {
  updateHeader();
  updateFeed("keep");
});

updateHeader();
updateFeed();
startStream(currentStreamPath);

function startStream(streamPath: StreamPath) {
  activeStreamController?.abort();
  activeStreamController = new AbortController();
  state = rawEventsStreamViewReducer.createInitialState();
  eventCount = 0;
  selectedOffset = undefined;
  collapsedOffsets.clear();
  status = "connecting";
  renderedView = navigationState.view === "feed" ? "state" : renderedView;
  updateHeader();
  updateFeed();
  void streamEvents({ streamPath, signal: activeStreamController.signal });
}

async function streamEvents(args: { streamPath: StreamPath; signal: AbortSignal }) {
  try {
    const stream = await client.stream(
      {
        path: args.streamPath,
        afterOffset: "start",
      },
      { signal: args.signal },
    );
    status = "streaming";
    updateHeader();

    for await (const value of stream) {
      if (args.signal.aborted || args.streamPath !== currentStreamPath) return;
      const event = Event.parse(value);
      eventCount += 1;
      state = rawEventsStreamViewReducer.reduce({ event, state }) ?? state;
      collapsedOffsets.delete(event.offset);
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

async function appendInput() {
  const content = input.value.trim();
  if (content.length === 0) return;

  input.value = "";
  updateSlashAutocomplete();
  if (await runSlashCommand(content)) return;

  appendStatus = "sending";
  updateHeader();

  const event: EventInput = {
    type: "events.iterate.com/webchat/user-message-added",
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
    await runCommand({
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
  collapseVisibleFeedItems() {
    for (const item of getRawFeedItems()) {
      collapsedOffsets.add(item.props.offset);
    }
  },
  expandVisibleFeedItems() {
    collapsedOffsets.clear();
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

async function runCommand(args: { command: CommandEntry; inputValue: unknown }) {
  appendStatus = "";
  await runTuiCommand({
    appContext,
    command: args.command,
    inputValue: args.inputValue,
  });
}

function getSlashCommandEntries() {
  return suggestSlashCommands({ commands: commandEntries, input: input.value, limit: 8 });
}

function updateSlashAutocomplete() {
  const commands = getSlashCommandEntries();

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
    slashAutocomplete.add(
      new TextRenderable(renderer, {
        id: `events-slash-command-${command.path}`,
        content: new StyledText(renderSlashCommandLabelChunks({ command, isSelected })),
        width: "100%",
        height: 1,
        fg: "#cbd5e1",
      }),
    );
  }
}

function renderSlashCommandLabelChunks(args: { command: CommandEntry; isSelected: boolean }) {
  return formatSlashCommandLabelSegments({ command: args.command, input: input.value }).map(
    (segment) => {
      const chunk = args.isSelected ? selectedSummaryText(segment.text) : summaryText(segment.text);
      return segment.matched ? bold(chunk) : chunk;
    },
  );
}

function clearBoxChildren(box: BoxRenderable) {
  for (const child of box.getChildren()) {
    child.destroyRecursively();
  }
}

function handleSlashAutocompleteKey(key: KeyEvent) {
  const commands = getSlashCommandEntries();
  if (commands.length === 0) return false;

  if (key.name === "escape") {
    selectedSlashCommandPath = undefined;
    slashAutocomplete.height = 0;
    clearBoxChildren(slashAutocomplete);
    return true;
  }

  if (key.name === "tab" || key.name === "backtab" || key.name === "down") {
    selectAdjacentSlashCommand(key.shift || key.name === "backtab" ? -1 : 1);
    return true;
  }

  if (key.name === "up") {
    selectAdjacentSlashCommand(-1);
    return true;
  }

  if (key.name === "return") {
    acceptSelectedSlashCommand();
    return true;
  }

  return false;
}

function selectAdjacentSlashCommand(direction: -1 | 1) {
  const commands = getSlashCommandEntries();
  if (commands.length === 0) return;

  const currentIndex = commands.findIndex((command) => command.path === selectedSlashCommandPath);
  const nextIndex =
    currentIndex === -1
      ? direction === 1
        ? 0
        : commands.length - 1
      : (currentIndex + direction + commands.length) % commands.length;

  selectedSlashCommandPath = commands[nextIndex].path;
  updateSlashAutocomplete();
}

function acceptSelectedSlashCommand() {
  const command = getSlashCommandEntries().find((entry) => entry.path === selectedSlashCommandPath);
  if (command == null) return;

  input.value = acceptedSlashInput(command);
  updateSlashAutocomplete();

  if (!commandNeedsInput(command)) {
    void appendInput();
  }
}

function commandNeedsInput(command: CommandEntry) {
  return command.input?.positional?.required === true;
}

function resolveStreamPath(streamPath?: string) {
  return resolveStreamPathForCurrent({ currentStreamPath, streamPath });
}

function updateHeader() {
  streamPathText.content =
    navigationState.view === "streams"
      ? "Streams"
      : navigationState.view === "state"
        ? "State"
        : currentStreamPath;
  connectedIndicator.content = "●";
  connectedIndicator.fg = status === "streaming" ? (pulseOn ? "#22c55e" : "#16a34a") : "#facc15";
  statsText.content = [
    `${eventCount} event${eventCount === 1 ? "" : "s"}`,
    `${state.slots.feed.length} item${state.slots.feed.length === 1 ? "" : "s"}`,
    status === "streaming" ? "" : status,
    appendStatus,
  ]
    .filter(Boolean)
    .join(" · ");
}

function updateFeed(scroll: "selected" | "keep" = "keep") {
  const viewChanged = navigationState.view !== renderedView;
  const shouldStickToBottom =
    navigationState.view === "feed" &&
    scroll === "keep" &&
    (navigationState.focus !== "feed" || viewChanged || isFeedAtBottom());

  feed.stickyScroll = navigationState.view === "feed";
  feed.stickyStart = navigationState.view === "feed" ? "bottom" : undefined;
  renderedView = navigationState.view;

  for (const child of feed.getChildren()) {
    child.destroyRecursively();
  }

  for (const child of renderFeedChildren()) {
    feed.add(child);
  }

  if (scroll === "selected" && navigationState.view === "streams") {
    setImmediate(() => feed.scrollChildIntoView(getStreamRowId(selectedStreamPath)));
  } else if (scroll === "selected") {
    setImmediate(() => feed.scrollChildIntoView(getRawEventCardId(selectedOffset)));
  } else if (shouldStickToBottom) {
    requestFeedBottomScroll();
  } else if (navigationState.view !== "feed") {
    setImmediate(() => feed.scrollTo(0));
  }
}

function renderFeedChildren() {
  if (navigationState.view === "state") return renderStateViewChildren();
  if (navigationState.view === "streams") return renderStreamsViewChildren();

  if (state.slots.feed.length === 0) {
    return [
      new TextRenderable(renderer, {
        id: "events-feed-waiting",
        content: "Waiting for events...",
        width: "100%",
        height: 1,
        fg: "#d1d5db",
      }),
    ];
  }

  const elapsedByOffset = getElapsedByOffset(state.slots.feed);
  return state.slots.feed.flatMap((item) => {
    const elapsedLabel =
      item.type === "raw-event" ? elapsedByOffset.get(item.props.offset) : undefined;
    return renderFeedItemChild(item, elapsedLabel);
  });
}

function renderStateViewChildren() {
  const content = stringifyYaml({
    streamPath: currentStreamPath,
    status,
    appendStatus,
    eventCount,
    navigationState,
    selectedOffset,
    collapsedOffsets: [...collapsedOffsets],
    reducedState: state,
  }).trimEnd();

  return [
    new TextRenderable(renderer, {
      id: "events-feed-state",
      content,
      width: "100%",
      height: countTextLines(content),
      fg: "#cbd5e1",
    }),
  ];
}

function renderStreamsViewChildren() {
  const rows = getVisibleStreamRows();
  const children = [];

  const helpText = streamSearchOpen
    ? `filter: ${streamSearchQuery}▏`
    : "↑↓ navigate · ←→ expand/collapse · Space toggle · 2×Space expand all · Enter open · Type to filter";

  children.push(
    new TextRenderable(renderer, {
      id: "events-feed-streams-help",
      content: new StyledText([summaryText(` ${helpText}\n`)]),
      width: "100%",
      height: 2,
      fg: "#6b7280",
    }),
  );

  if (rows.length === 0) {
    const content =
      streamSearchQuery.trim().length > 0
        ? `No streams match "${streamSearchQuery}".`
        : "No streams loaded. Type /streams.tree to load the stream tree.";

    children.push(
      new TextRenderable(renderer, {
        id: "events-feed-streams-empty",
        content,
        width: "100%",
        height: 1,
        fg: "#71717a",
      }),
    );
    return children;
  }

  for (const row of rows) {
    children.push(
      new TextRenderable(renderer, {
        id: getStreamRowId(row.path),
        content: new StyledText(renderStreamTreeRowChunks(row)),
        width: "100%",
        height: 1,
        fg: "#cbd5e1",
      }),
    );
  }

  return children;
}

function renderFeedItemChild(item: EventsStreamBuiltInElement, elapsedLabel?: string) {
  if (item.type !== "raw-event") return [];

  const chunks = renderRawEventCard(item, elapsedLabel);
  return [
    new TextRenderable(renderer, {
      id: getRawEventCardId(item.props.offset),
      content: new StyledText(chunks),
      width: "100%",
      height: countChunkLines(chunks),
      fg: "#d1d5db",
    }),
  ];
}

function renderRawEventCard(item: EventsStreamRawEventElement, elapsedLabel?: string) {
  const width = Math.max(3, feed.viewport.width - 2);
  const yaml = stringifyYaml(orderEventKeysForYamlDisplay(item.props.raw)).trimEnd();
  const isSelected = navigationState.focus === "feed" && item.props.offset === selectedOffset;
  const isCollapsed = collapsedOffsets.has(item.props.offset);
  const summary = `${rightAlign(formatEventSummary(item, elapsedLabel), width)}\n`;

  if (isCollapsed) {
    return [mutedText("\n"), isSelected ? selectedSummaryText(summary) : summaryText(summary)];
  }

  return [
    mutedText("\n"),
    isSelected ? selectedSummaryText(summary) : summaryText(summary),
    rawText(` ${" ".repeat(width - 2)} \n`),
    ...yaml
      .split("\n")
      .flatMap((line) => wrapLine(line, width - 2))
      .map((line) => rawText(` ${line.padEnd(width - 2)} \n`)),
    rawText(` ${" ".repeat(width - 2)} \n`),
  ];
}

function countChunkLines(chunks: readonly { text: string }[]) {
  return countTextLines(chunks.map((chunk) => chunk.text).join(""));
}

function countTextLines(value: string) {
  if (value.length === 0) return 1;

  const lineBreaks = value.match(/\n/g)?.length ?? 0;
  return value.endsWith("\n") ? Math.max(1, lineBreaks) : lineBreaks + 1;
}

function summaryText(value: string) {
  return fg("#71717a")(value);
}

function selectedSummaryText(value: string) {
  return bg("#1f2937")(fg("#e5e7eb")(value));
}

function mutedText(value: string) {
  return fg("#0b0f14")(value);
}

function rawText(value: string) {
  return bg("#0f172a")(fg("#cbd5e1")(value));
}

function selectAdjacentFeedItem(direction: -1 | 1) {
  const rawItems = getRawFeedItems();
  if (rawItems.length === 0) return;

  const currentIndex = rawItems.findIndex((item) => item.props.offset === selectedOffset);
  const nextIndex =
    currentIndex === -1
      ? direction === 1
        ? 0
        : rawItems.length - 1
      : (currentIndex + direction + rawItems.length) % rawItems.length;

  selectedOffset = rawItems[nextIndex].props.offset;
  updateFeed("selected");
}

function focusFeed() {
  const rawItems = getRawFeedItems();

  navigationState = focusStreamTuiFeed(navigationState);
  if (navigationState.view === "streams") {
    selectedStreamPath ??= currentStreamPath;
  } else {
    selectedOffset ??= rawItems[rawItems.length - 1]?.props.offset;
  }
  input.placeholder = "Tab to return to input";
  feed.focus();
  updateHeader();
  updateFeed("selected");
}

function focusInput() {
  navigationState = focusStreamTuiComposer(navigationState);
  streamSearchOpen = false;
  input.placeholder = "Type a message or / for commands";
  input.focus();
  updateHeader();
  updateFeed("keep");
}

function focusHeader() {
  navigationState = focusStreamTuiHeader(navigationState);
  input.placeholder = "Tab to return to input";
  topBar.focus();
  updateHeader();
  updateFeed("keep");
}

function focusAdjacentRegion(direction: -1 | 1) {
  const regions = ["header", "feed", "composer"] as const;
  const currentIndex = regions.indexOf(navigationState.focus);
  const nextIndex = (currentIndex + direction + regions.length) % regions.length;

  if (regions[nextIndex] === "composer") {
    focusInput();
    return;
  }

  if (regions[nextIndex] === "feed") {
    focusFeed();
    return;
  }

  focusHeader();
}

function toggleSelectedFeedItem() {
  if (selectedOffset == null) return;

  if (collapsedOffsets.has(selectedOffset)) {
    collapsedOffsets.delete(selectedOffset);
  } else {
    collapsedOffsets.add(selectedOffset);
  }

  updateFeed("selected");
}

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

  if (streamSearchOpen) {
    if (args.key.name === "return") {
      openSelectedStreamPath();
      return true;
    }

    if (args.key.name === "backspace" || args.sequence === "\u007f") {
      streamSearchQuery = streamSearchQuery.slice(0, -1);
      if (streamSearchQuery.length === 0) {
        streamSearchOpen = false;
      }
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

  if (isPrintableCharacter(args.sequence)) {
    streamSearchOpen = true;
    streamSearchQuery = args.sequence;
    selectFirstMatchedStreamRow();
    updateFeed("selected");
    return true;
  }

  return false;
}

function getVisibleStreamRows() {
  return getStreamTreeRows({
    streams: streamSummaries,
    currentStreamPath,
    expandedPaths: expandedStreamPaths,
    searchQuery: streamSearchOpen ? streamSearchQuery : "",
    selectedPath: selectedStreamPath,
  });
}

function renderStreamTreeRowChunks(row: StreamTreeRow) {
  const width = Math.max(3, feed.viewport.width - 2);
  const prefix = `${"  ".repeat(row.depth)}${row.hasChildren ? (row.expanded ? "▾" : "▸") : " "} `;
  const suffix = [
    row.current ? "●" : "",
    row.createdAt == null ? "" : formatTime(new Date(row.createdAt).getTime()),
  ]
    .filter(Boolean)
    .join("  ");

  const label = row.labelSegments.map((s) => s.text).join("");
  const leftLen = prefix.length + label.length;
  const rightLen = suffix.length;
  const gap = Math.max(2, width - leftLen - rightLen);
  const paddedSuffix = suffix.length > 0 ? " ".repeat(gap) + suffix : " ".repeat(gap);

  const chunks = [
    ...renderStreamRowText({ row, value: prefix }),
    ...row.labelSegments.flatMap((segment) =>
      renderStreamRowText({ row, value: segment.text, matched: segment.matched }),
    ),
    ...renderStreamRowText({ row, value: paddedSuffix }),
  ];

  return chunks;
}

function renderStreamRowText(args: { row: StreamTreeRow; value: string; matched?: boolean }) {
  const color = args.row.current ? "#e5e7eb" : "#94a3b8";
  const selected = navigationState.focus === "feed" && args.row.selected;
  const chunk = selected ? bg("#1f2937")(fg(color)(args.value)) : fg(color)(args.value);

  return [args.matched ? bold(chunk) : chunk];
}

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

function selectFirstMatchedStreamRow() {
  const rows = getVisibleStreamRows();
  selectedStreamPath =
    rows.find((row) => row.labelSegments.some((segment) => segment.matched))?.path ??
    rows.find((row) => row.path === currentStreamPath)?.path ??
    rows[0]?.path;
}

function toggleSelectedStreamPath() {
  const selectedRow = getSelectedStreamRow();
  if (selectedRow == null) return;

  if (!selectedRow.hasChildren) {
    openSelectedStreamPath();
    return;
  }

  setSelectedStreamExpanded(!selectedRow.expanded);
}

function setSelectedStreamExpanded(expanded: boolean) {
  if (selectedStreamPath == null) return;

  if (expanded) {
    expandedStreamPaths.add(selectedStreamPath);
  } else {
    expandedStreamPaths.delete(selectedStreamPath);
  }

  updateFeed("selected");
}

function expandAllDescendants() {
  if (selectedStreamPath == null) return;

  for (const stream of streamSummaries) {
    if (stream.path === selectedStreamPath || stream.path.startsWith(selectedStreamPath + "/")) {
      expandedStreamPaths.add(stream.path);
    }
  }
  expandedStreamPaths.add(selectedStreamPath);
  updateFeed("selected");
}

function openSelectedStreamPath() {
  if (selectedStreamPath == null) return;
  appContext.navigateToStream(selectedStreamPath);
}

function getSelectedStreamRow() {
  return getVisibleStreamRows().find((row) => row.path === selectedStreamPath);
}

function isPrintableCharacter(sequence: string) {
  return sequence.length === 1 && sequence >= " " && sequence !== "\u007f";
}

function getRawFeedItems() {
  return state.slots.feed.filter((item) => item.type === "raw-event");
}

function isFeedAtBottom() {
  const maxScrollTop = Math.max(0, feed.scrollHeight - feed.viewport.height);
  return feed.scrollTop >= maxScrollTop - 1;
}

function scrollFeedToBottom() {
  feed.scrollTo(feed.scrollHeight);
}

function requestFeedBottomScroll() {
  setImmediate(scrollFeedToBottom);
  setTimeout(scrollFeedToBottom, 0).unref();
}

function getRawEventCardId(offset: number | undefined) {
  return `events-feed-raw-event-${offset ?? "none"}`;
}

function getStreamRowId(path: StreamPath | undefined) {
  return `events-feed-stream-${path ?? "none"}`;
}

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

function formatError(error: unknown) {
  if (error instanceof ORPCError) {
    return `${error.code}: ${error.message}`;
  }

  return error instanceof Error ? error.message : String(error);
}
