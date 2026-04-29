import { Event, ProjectSlug, StreamPath, type EventInput } from "@iterate-com/events-contract";
import type {
  EventsStreamFeedItem,
  EventsStreamRawEventFeedItem,
  EventsStreamViewState,
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
  type TextChunk,
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

let state = structuredClone(rawEventsStreamViewProcessor.initialState) as EventsStreamViewState;
let status = "connecting";
let appendStatus = "";
let eventCount = 0;
let pulseOn = true;

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  targetFps: 30,
  useAlternateScreen: true,
  useConsole: false,
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
  contentOptions: { flexDirection: "column", paddingLeft: 1, paddingRight: 1 },
  backgroundColor: "#0b0f14",
});
const feedText = new TextRenderable(renderer, {
  content: "Waiting for events...",
  width: "100%",
  fg: "#d1d5db",
});
const input = new InputRenderable(renderer, {
  width: "100%",
  height: 1,
  placeholder: "Type a message and press Enter",
  backgroundColor: "#030712",
  focusedBackgroundColor: "#030712",
  textColor: "#e5e7eb",
  focusedTextColor: "#e5e7eb",
  placeholderColor: "#6b7280",
  cursorColor: "#22c55e",
});
const inputBox = new BoxRenderable(renderer, {
  width: "100%",
  height: 3,
  padding: 1,
  backgroundColor: "#0b0f14",
});

topBar.add(connectedIndicator);
topBar.add(streamPathText);
topBar.add(statsText);
root.add(topBar);
feed.add(feedText);
root.add(feed);
inputBox.add(input);
root.add(inputBox);
renderer.root.add(root);
input.focus();

input.on(InputRenderableEvents.ENTER, () => void appendInput());
setInterval(() => {
  pulseOn = !pulseOn;
  updateView();
}, 700).unref();

updateView();
void streamEvents();

async function streamEvents() {
  try {
    const stream = await client.stream({
      path: args.streamPath,
      afterOffset: "start",
    });
    status = "streaming";
    updateView();

    for await (const value of stream) {
      const event = Event.parse(value);
      eventCount += 1;
      state = rawEventsStreamViewProcessor.reduce({ event, state }) ?? state;
      updateView();
    }

    status = "stream closed";
  } catch (error) {
    status = `stream error: ${formatError(error)}`;
  }

  updateView();
}

async function appendInput() {
  const content = input.value.trim();
  if (content.length === 0) return;

  input.value = "";
  appendStatus = "sending";
  updateView();

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
  updateView();
}

function updateView() {
  connectedIndicator.content = "●";
  connectedIndicator.fg = status === "streaming" ? (pulseOn ? "#22c55e" : "#16a34a") : "#facc15";
  statsText.content = [
    `${eventCount} event${eventCount === 1 ? "" : "s"}`,
    `${state.feedItems.length} item${state.feedItems.length === 1 ? "" : "s"}`,
    status === "streaming" ? "" : status,
    appendStatus,
  ]
    .filter(Boolean)
    .join(" · ");
  feedText.content = renderFeed();
  feed.scrollTo({ x: 0, y: feed.scrollHeight });
}

function renderFeed() {
  if (state.feedItems.length === 0) {
    return "Waiting for events...";
  }

  const elapsedByOffset = getElapsedByOffset(state.feedItems);
  const chunks = state.feedItems.flatMap((item) => {
    const elapsedLabel = item.type === "raw-event" ? elapsedByOffset.get(item.offset) : undefined;
    return renderFeedItem({ item, elapsedLabel });
  });

  return new StyledText(chunks);
}

function renderFeedItem({
  item,
  elapsedLabel,
}: {
  item: EventsStreamFeedItem;
  elapsedLabel?: string;
}): TextChunk[] {
  if (item.type !== "raw-event") return [];

  return renderRawEventCard({ item, elapsedLabel });
}

function renderRawEventCard({
  item,
  elapsedLabel,
}: {
  item: EventsStreamRawEventFeedItem;
  elapsedLabel?: string;
}) {
  const width = Math.max(48, feed.width - 2);
  const yaml = stringifyYaml(orderEventKeysForYamlDisplay(item.raw)).trimEnd();
  return [
    mutedText("\n"),
    summaryText(`${rightAlign(formatEventSummary({ item, elapsedLabel }), width)}\n`),
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

function formatEventSummary({
  item,
  elapsedLabel,
}: {
  item: EventsStreamRawEventFeedItem;
  elapsedLabel?: string;
}) {
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
    return `+${trimTrailingZero(seconds)}s`;
  }

  const totalSeconds = Math.floor(normalizedDurationMs / 1_000);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `+${totalMinutes}m${seconds}s`;
}

function trimTrailingZero(value: number) {
  return value.toFixed(1).replace(/\.0$/, "");
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
