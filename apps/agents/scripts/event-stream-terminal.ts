import { Event, ProjectSlug, StreamPath, type EventInput } from "@iterate-com/events-contract";
import type {
  EventsStreamFeedItem,
  EventsStreamRawEventFeedItem,
} from "@iterate-com/ui/components/events/feed-items";
import { rawEventsStreamViewProcessor } from "@iterate-com/ui/components/events/feed-processors";
import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  StyledText,
  TextRenderable,
  bg,
  createCliRenderer,
  fg,
  KeyEvent,
  parseKeypress,
} from "@opentui/core";
import { stringify as stringifyYaml } from "yaml";
import { createEventsOrpcClient } from "../src/lib/events-orpc-client.ts";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error("stream-tui requires an interactive terminal.");
}

const args = parseArgs(process.argv.slice(2));
const client = createEventsOrpcClient({
  baseUrl: args.eventsBaseUrl,
  projectSlug: args.projectSlug,
});

type StreamView = "feed" | "state" | "commands";
type StreamCommand = {
  id: string;
  title: string;
  description: string;
  slash: string;
  run: (args: string) => void | Promise<void>;
};

let state = rawEventsStreamViewProcessor.createInitialState();
let status = "connecting";
let appendStatus = "";
let eventCount = 0;
let pulseOn = true;
let selectedOffset: number | undefined;
let feedNavigation = false;
let activeView: StreamView = "feed";
const collapsedOffsets = new Set<number>();

// One command record powers slash commands now and can back a palette later.
// OpenCode treats slash entries as TUI commands too:
// https://opencode.ai/docs/tui/#slash-commands
const streamCommands: StreamCommand[] = [
  {
    id: "view.feed",
    title: "Show feed",
    description: "Return to the event feed",
    slash: "feed",
    run() {
      activeView = "feed";
    },
  },
  {
    id: "view.state",
    title: "Show reduced state",
    description: "Inspect the current reducer state",
    slash: "state",
    run() {
      activeView = "state";
    },
  },
  {
    id: "view.commands",
    title: "Show commands",
    description: "List available slash commands",
    slash: "help",
    run() {
      activeView = "commands";
    },
  },
  {
    id: "feed.collapse-all",
    title: "Collapse all feed items",
    description: "Collapse every raw event card",
    slash: "collapse",
    run() {
      for (const item of getRawFeedItems()) {
        collapsedOffsets.add(item.offset);
      }
      activeView = "feed";
    },
  },
  {
    id: "feed.expand-all",
    title: "Expand all feed items",
    description: "Expand every raw event card",
    slash: "expand",
    run() {
      collapsedOffsets.clear();
      activeView = "feed";
    },
  },
];

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  targetFps: 30,
  screenMode: "alternate-screen",
  consoleMode: "disabled",
});

const root = new BoxRenderable(renderer, {
  width: "100%",
  height: "100%",
  flexDirection: "column",
  backgroundColor: "#0b0f14",
});
const topBar = new BoxRenderable(renderer, {
  width: "100%",
  height: 3,
  flexDirection: "row",
  gap: 1,
  paddingTop: 1,
  paddingLeft: 1,
  paddingRight: 1,
  backgroundColor: "#27272a",
});
const connectedIndicator = new TextRenderable(renderer, { content: "●", width: 2, fg: "#facc15" });
const streamPathText = new TextRenderable(renderer, {
  content: args.streamPath,
  flexGrow: 1,
  fg: "#e5e7eb",
});
const statsText = new TextRenderable(renderer, { content: "", fg: "#9ca3af" });
const feed = new ScrollBoxRenderable(renderer, {
  width: "100%",
  flexGrow: 1,
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
  placeholder: "Type a message and press Enter",
  backgroundColor: "transparent",
  focusedBackgroundColor: "transparent",
  textColor: "#e5e7eb",
  focusedTextColor: "#e5e7eb",
  placeholderColor: "#6b7280",
  cursorColor: "#22c55e",
});
const inputBox = new BoxRenderable(renderer, {
  width: "100%",
  height: 3,
  flexDirection: "column",
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
  if (!feedNavigation) {
    if (key.name !== "escape") return false;

    focusFeed();
    return true;
  }

  if (key.name === "escape") {
    focusInput();
    return true;
  }

  if (key.name === "tab") {
    selectAdjacentFeedItem(key.shift ? -1 : 1);
    return true;
  }

  if (key.name === "return" && selectedOffset != null) {
    toggleSelectedFeedItem();
    return true;
  }

  if (feed.handleKeyPress(key)) {
    return true;
  }

  return true;
});
input.on(InputRenderableEvents.ENTER, () => void appendInput());
setInterval(() => {
  pulseOn = !pulseOn;
  updateHeader();
}, 700).unref();

updateHeader();
updateFeed();
void streamEvents();

async function streamEvents() {
  try {
    const stream = await client.stream({
      path: args.streamPath,
      afterOffset: "start",
    });
    status = "streaming";
    updateHeader();

    for await (const value of stream) {
      const event = Event.parse(value);
      eventCount += 1;
      state = rawEventsStreamViewProcessor.reduce({ event, state }) ?? state;
      collapsedOffsets.delete(event.offset);
      updateHeader();
      updateFeed("keep");
    }

    status = "stream closed";
  } catch (error) {
    status = `stream error: ${formatError(error)}`;
  }

  updateHeader();
}

async function appendInput() {
  const content = input.value.trim();
  if (content.length === 0) return;

  input.value = "";
  if (await runSlashCommand(content)) return;

  appendStatus = "sending";
  updateHeader();

  const event: EventInput = {
    type: "webchat-message-received",
    payload: { content },
  };
  try {
    const result = await client.append({ path: args.streamPath, event });
    appendStatus = `sent offset ${result.event.offset}`;
  } catch (error) {
    appendStatus = `append error: ${formatError(error)}`;
  }
  updateHeader();
}

async function runSlashCommand(content: string) {
  if (!content.startsWith("/")) return false;

  const [slash = "", ...args] = content.slice(1).trim().split(/\s+/);
  const command = streamCommands.find((candidate) => candidate.slash === slash);
  if (command == null) {
    appendStatus = `unknown command /${slash}`;
    updateHeader();
    return true;
  }

  await command.run(args.join(" "));
  appendStatus = `/${command.slash}`;
  updateHeader();
  updateFeed("keep");
  return true;
}

function updateHeader() {
  connectedIndicator.content = "●";
  connectedIndicator.fg = status === "streaming" ? (pulseOn ? "#22c55e" : "#16a34a") : "#facc15";
  statsText.content = [
    `${eventCount} event${eventCount === 1 ? "" : "s"}`,
    `${state.feedItems.length} item${state.feedItems.length === 1 ? "" : "s"}`,
    activeView === "feed" ? "" : activeView,
    feedNavigation ? "feed focus" : "",
    status === "streaming" ? "" : status,
    appendStatus,
  ]
    .filter(Boolean)
    .join(" · ");
}

function updateFeed(scroll: "selected" | "keep" = "keep") {
  feed.stickyScroll = activeView === "feed";
  feed.stickyStart = activeView === "feed" ? "bottom" : undefined;

  for (const child of feed.getChildren()) {
    feed.remove(child.id);
  }

  for (const child of renderFeedChildren()) {
    feed.add(child);
  }

  if (scroll === "selected") {
    const selectedCardId = getRawEventCardId(selectedOffset);
    setImmediate(() => feed.scrollChildIntoView(selectedCardId));
  } else if (activeView !== "feed") {
    setImmediate(() => feed.scrollTo(0));
  }
}

function renderFeedChildren() {
  if (activeView === "state") return renderStateViewChildren();
  if (activeView === "commands") return renderCommandViewChildren();

  if (state.feedItems.length === 0) {
    return [
      new TextRenderable(renderer, {
        id: "events-feed-waiting",
        content: "Waiting for events...",
        width: "100%",
        fg: "#d1d5db",
      }),
    ];
  }

  const elapsedByOffset = getElapsedByOffset(state.feedItems);
  return state.feedItems.flatMap((item) => {
    const elapsedLabel = item.type === "raw-event" ? elapsedByOffset.get(item.offset) : undefined;
    return renderFeedItemChild(item, elapsedLabel);
  });
}

function renderStateViewChildren() {
  return [
    new TextRenderable(renderer, {
      id: "events-feed-state",
      content: stringifyYaml({
        streamPath: args.streamPath,
        status,
        appendStatus,
        eventCount,
        activeView,
        feedNavigation,
        selectedOffset,
        collapsedOffsets: [...collapsedOffsets],
        reducedState: state,
      }).trimEnd(),
      width: "100%",
      fg: "#cbd5e1",
    }),
  ];
}

function renderCommandViewChildren() {
  const content = streamCommands
    .map((command) => `/${command.slash.padEnd(10)} ${command.title}\n  ${command.description}`)
    .join("\n\n");

  return [
    new TextRenderable(renderer, {
      id: "events-feed-commands",
      content,
      width: "100%",
      fg: "#cbd5e1",
    }),
  ];
}

function renderFeedItemChild(item: EventsStreamFeedItem, elapsedLabel?: string) {
  if (item.type !== "raw-event") return [];

  return [
    new TextRenderable(renderer, {
      id: getRawEventCardId(item.offset),
      content: new StyledText(renderRawEventCard(item, elapsedLabel)),
      width: "100%",
      fg: "#d1d5db",
    }),
  ];
}

function renderRawEventCard(item: EventsStreamRawEventFeedItem, elapsedLabel?: string) {
  const width = Math.max(3, feed.width - 2);
  const yaml = stringifyYaml(orderEventKeysForYamlDisplay(item.raw)).trimEnd();
  const isSelected = feedNavigation && item.offset === selectedOffset;
  const isCollapsed = collapsedOffsets.has(item.offset);
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

function getElapsedByOffset(feedItems: readonly EventsStreamFeedItem[]) {
  const elapsedByOffset = new Map<number, string>();
  const rawEvents = feedItems.filter((item) => item.type === "raw-event");

  for (const [index, item] of rawEvents.entries()) {
    const previousItem = rawEvents[index - 1];
    if (previousItem == null) continue;

    elapsedByOffset.set(item.offset, formatElapsedTime(item.timestamp - previousItem.timestamp));
  }

  return elapsedByOffset;
}

function selectAdjacentFeedItem(direction: -1 | 1) {
  const rawItems = getRawFeedItems();
  if (rawItems.length === 0) return;

  const currentIndex = rawItems.findIndex((item) => item.offset === selectedOffset);
  const nextIndex =
    currentIndex === -1
      ? direction === 1
        ? 0
        : rawItems.length - 1
      : (currentIndex + direction + rawItems.length) % rawItems.length;

  selectedOffset = rawItems[nextIndex].offset;
  updateFeed("selected");
}

function focusFeed() {
  const rawItems = getRawFeedItems();
  if (rawItems.length === 0) return;

  feedNavigation = true;
  selectedOffset ??= rawItems[rawItems.length - 1]?.offset;
  input.placeholder = "Feed focus: Tab selects, Enter toggles, Esc returns";
  input.blur();
  updateHeader();
  updateFeed("selected");
}

function focusInput() {
  feedNavigation = false;
  input.placeholder = "Type a message and press Enter";
  input.focus();
  updateHeader();
  updateFeed("keep");
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

function getRawFeedItems() {
  return state.feedItems.filter((item) => item.type === "raw-event");
}

function getRawEventCardId(offset: number | undefined) {
  return `events-feed-raw-event-${offset ?? "none"}`;
}

function formatEventSummary(item: EventsStreamRawEventFeedItem, elapsedLabel?: string) {
  return [item.offset, item.eventType, elapsedLabel, formatTime(item.timestamp)]
    .filter(Boolean)
    .join(" · ");
}

function orderEventKeysForYamlDisplay(event: Event): Record<string, unknown> {
  const eventRecord = event as Record<string, unknown>;
  const orderedEvent: Record<string, unknown> = {};

  for (const key of ["type", "payload", "metadata", "idempotencyKey", "offset", "createdAt"]) {
    if (key in eventRecord) {
      orderedEvent[key] = eventRecord[key];
    }
  }

  for (const [key, value] of Object.entries(eventRecord)) {
    if (key === "streamPath" || key in orderedEvent) {
      continue;
    }

    orderedEvent[key] = value;
  }

  return orderedEvent;
}

function wrapLine(value: string, width: number) {
  if (value.length <= width) return [value];

  const lines: string[] = [];
  for (let index = 0; index < value.length; index += width) {
    lines.push(value.slice(index, index + width));
  }
  return lines;
}

function rightAlign(value: string, width: number) {
  const trimmed = value.length > width ? value.slice(value.length - width) : value;
  return trimmed.padStart(width);
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString();
}

function formatElapsedTime(durationMs: number) {
  const normalizedDurationMs = Math.max(0, Math.floor(durationMs));

  if (normalizedDurationMs < 1_000) {
    return `+${normalizedDurationMs}ms`;
  }

  if (normalizedDurationMs < 60_000) {
    const seconds = Math.floor(normalizedDurationMs / 100) / 10;
    return `+${seconds.toFixed(1).replace(/\.0$/, "")}s`;
  }

  const totalSeconds = Math.floor(normalizedDurationMs / 1_000);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `+${totalMinutes}m${seconds}s`;
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
  return error instanceof Error ? error.message : String(error);
}
