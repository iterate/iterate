#!/usr/bin/env bun
/** @jsxImportSource @opentui/react */
// oxlint-disable react/only-export-components -- CLI entrypoint, not a Vite Fast Refresh module.
/**
 * React/OpenTUI terminal UI for inspecting and appending to an iterate event
 * stream. Event interpretation is shared with the browser renderer via
 * `EventsStreamViewReducer`; this file only owns terminal runtime state,
 * keyboard routing, and stream-scoped side effects.
 */
import { Event, StreamPath, type EventInput } from "@iterate-com/shared/streams/types";
import type { EventsStreamViewState } from "@iterate-com/ui/components/events/feed-items";
import {
  reduceStreamViewEvents,
  StreamViewProcessorContract,
} from "@iterate-com/ui/components/events/stream-view-processor/contract";
import { getInitialProcessorState } from "@iterate-com/shared/stream-processors";
import { createCliRenderer, type KeyEvent } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer } from "@opentui/react";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { ORPCError } from "@orpc/server";
import { osContract } from "@iterate-com/os-contract";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  acceptedSlashInput,
  findSlashCommand as findDiscoveredSlashCommand,
  formatSlashCommandLabelSegments,
  parseSlashAutocompleteQuery,
  suggestSlashCommands,
} from "./command-discovery.ts";
import {
  MissingCommandArgumentsError,
  parseSlashCommandInput,
  parseSlashInvocation,
} from "./command-invocation.ts";
import {
  commandEntries,
  runCommand as runTuiCommand,
  type AppContext,
  type CommandEntry,
  type StreamApi,
  type StreamSummary,
} from "./command-router.ts";
import { TuiEventsStreamView } from "./react-stream-renderers.tsx";
import {
  formatCommandDocsForTui,
  getRawEventRowTargetsForTui,
  getRawEventSummariesForTui,
  type TuiSlashSuggestion,
} from "./react-stream-view-model.ts";
import {
  focusStreamTuiComposer,
  focusStreamTuiFeed,
  focusStreamTuiHeader,
  initialStreamTuiNavigationState,
  setStreamTuiView,
  type StreamTuiView,
} from "./navigation-state.ts";
import { resolveStreamPath as resolveStreamPathForCurrent } from "./stream-paths.ts";
import { getDefaultExpandedStreamPaths, getStreamTreeRows } from "./stream-tree.ts";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error("stream-tui requires an interactive terminal.");
}

const args = parseArgs(process.argv.slice(2));
type OrpcClient = ContractRouterClient<typeof osContract>;
const ROOT_STREAM_PATH = StreamPath.parse("/");

const feedModes = {
  raw: { label: "Raw" },
  mixed: { label: "Mixed" },
  pretty: { label: "Pretty" },
} as const;
type FeedMode = keyof typeof feedModes;

function applyFeedMode(state: EventsStreamViewState, mode: FeedMode): EventsStreamViewState {
  if (mode === "pretty") {
    return {
      ...state,
      slots: {
        ...state.slots,
        feed: state.slots.feed.filter((el) => el.type !== "grouped-raw-event"),
      },
    };
  }
  if (mode === "raw") {
    return {
      ...state,
      slots: {
        ...state.slots,
        feed: state.slots.feed.filter((el) => el.type === "grouped-raw-event"),
      },
    };
  }
  return state;
}

function StreamTerminalApp() {
  const renderer = useRenderer();
  const client = useMemo(() => createOsClient(args.baseUrl), []);
  const [currentStreamPath, setCurrentStreamPath] = useState(args.streamPath ?? ROOT_STREAM_PATH);
  const [currentFeedMode, setCurrentFeedMode] = useState<FeedMode>("mixed");
  const [rawEvents, setRawEvents] = useState<Event[]>([]);
  const [viewState, setViewState] = useState<EventsStreamViewState>(() =>
    getInitialProcessorState(StreamViewProcessorContract),
  );
  const [status, setStatus] = useState("connecting");
  const [appendStatus, setAppendStatus] = useState("");
  const [pulseOn, setPulseOn] = useState(true);
  const [composerValue, setComposerValue] = useState("");
  const [composerRevision, setComposerRevision] = useState(0);
  const [selectedOffset, setSelectedOffset] = useState<number | undefined>();
  const [detailEventOffset, setDetailEventOffset] = useState<number | undefined>();
  const [navigationState, setNavigationState] = useState(() =>
    args.streamPath == null
      ? focusStreamTuiFeed(setStreamTuiView(initialStreamTuiNavigationState, "streams"))
      : initialStreamTuiNavigationState,
  );
  const [streamSummaries, setStreamSummaries] = useState<StreamSummary[]>([]);
  const [selectedStreamPath, setSelectedStreamPath] = useState<StreamPath | undefined>(
    args.streamPath ?? ROOT_STREAM_PATH,
  );
  const [expandedStreamPaths, setExpandedStreamPaths] = useState<Set<StreamPath>>(
    () => new Set(getDefaultExpandedStreamPaths(args.streamPath ?? ROOT_STREAM_PATH)),
  );
  const [streamSearchOpen, setStreamSearchOpen] = useState(false);
  const [streamSearchQuery, setStreamSearchQuery] = useState("");
  const [selectedSlashCommandPath, setSelectedSlashCommandPath] = useState<string | undefined>();
  const [lastSpaceTimestamp, setLastSpaceTimestamp] = useState(0);
  const [streamRestartNonce, setStreamRestartNonce] = useState(0);
  const activeAbortController = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    const interval = setInterval(() => setPulseOn((previous) => !previous), 700);
    interval.unref();
    return () => clearInterval(interval);
  }, []);

  const replaceComposerValue = useCallback((value: string) => {
    setComposerValue(value);
    setComposerRevision((previous) => previous + 1);
  }, []);

  useEffect(() => {
    setViewState(applyFeedMode(reduceStreamViewEvents(rawEvents), currentFeedMode));
  }, [currentFeedMode, rawEvents]);

  useEffect(() => {
    const abortController = new AbortController();
    activeAbortController.current?.abort();
    activeAbortController.current = abortController;
    setRawEvents([]);
    setSelectedOffset(undefined);
    setDetailEventOffset(undefined);
    setStatus("connecting");

    void (async () => {
      try {
        const stream = await client.project.streams.streamEvents(
          {
            afterOffset: "start",
            projectSlugOrId: args.projectSlugOrId,
            streamPath: currentStreamPath,
          },
          { signal: abortController.signal },
        );
        setStatus("streaming");

        for await (const value of stream) {
          if (abortController.signal.aborted) return;
          const event = Event.parse(value);
          setRawEvents((previous) => [...previous, event]);
        }

        setStatus("stream closed");
      } catch (error) {
        if (abortController.signal.aborted) return;
        setStatus(`stream error: ${formatError(error)}`);
      }
    })();

    return () => abortController.abort();
  }, [client, currentStreamPath, streamRestartNonce]);

  const resolveStreamPath = useCallback(
    (streamPath?: string) => resolveStreamPathForCurrent({ currentStreamPath, streamPath }),
    [currentStreamPath],
  );

  const navigateToStream = useCallback((streamPath: StreamPath) => {
    setCurrentStreamPath(streamPath);
    setSelectedStreamPath(streamPath);
    setExpandedStreamPaths(
      (previous) => new Set([...previous, ...getDefaultExpandedStreamPaths(streamPath)]),
    );
    setStreamSearchOpen(false);
    setStreamSearchQuery("");
    setNavigationState((previous) => setStreamTuiView(previous, "feed"));
    setAppendStatus(`opened ${streamPath}`);
  }, []);

  const restartStream = useCallback(() => {
    setStreamRestartNonce((previous) => previous + 1);
  }, []);

  const streamApi = useMemo<StreamApi>(
    () => ({
      append: async (input) => {
        const result = await client.project.streams.append({
          projectSlugOrId: args.projectSlugOrId,
          streamPath: resolveStreamPath(input.streamPath),
          event: input.event,
        });
        return result.event;
      },
      getState: async (input = {}) =>
        client.project.streams.getState({
          projectSlugOrId: args.projectSlugOrId,
          streamPath: resolveStreamPath(input.streamPath),
        }),
      listChildren: async (input = {}) => {
        const { streams } = await client.project.streams.list({
          projectSlugOrId: args.projectSlugOrId,
        });
        const basePath = resolveStreamPath(input.streamPath);
        return streams
          .filter((stream) => basePath === "/" || stream.streamPath.startsWith(`${basePath}/`))
          .map((stream) => ({
            path: stream.streamPath,
            createdAt: stream.createdAt,
          }));
      },
      resolvePath: resolveStreamPath,
    }),
    [client, resolveStreamPath],
  );

  useEffect(() => {
    if (args.streamPath != null) return;

    let cancelled = false;
    void (async () => {
      try {
        const streams = await streamApi.listChildren({ streamPath: "/" });
        if (cancelled) return;
        setStreamSummaries(streams);
        setSelectedStreamPath(ROOT_STREAM_PATH);
        setAppendStatus(`${streams.length} stream${streams.length === 1 ? "" : "s"}`);
      } catch (error) {
        if (cancelled) return;
        setAppendStatus(`stream tree error: ${formatError(error)}`);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [streamApi]);

  const setActiveView = useCallback((view: StreamTuiView) => {
    setNavigationState((previous) => setStreamTuiView(previous, view));
  }, []);

  const switchFeedMode = useCallback((mode: FeedMode) => {
    setCurrentFeedMode(mode);
    setSelectedOffset(undefined);
    setDetailEventOffset(undefined);
    setNavigationState((previous) => setStreamTuiView(previous, "feed"));
    setAppendStatus(`${feedModes[mode].label} mode`);
  }, []);

  const focusInput = useCallback(() => {
    setStreamSearchOpen(false);
    setNavigationState((previous) => focusStreamTuiComposer(previous));
  }, []);

  const focusFeed = useCallback(() => {
    setNavigationState((previous) => focusStreamTuiFeed(previous));
    if (navigationState.view === "streams") {
      setSelectedStreamPath((previous) => previous ?? currentStreamPath);
      return;
    }
    const rawRows = getRawEventRowTargetsForTui(viewState.slots.feed);
    setSelectedOffset((previous) => previous ?? rawRows[rawRows.length - 1]?.offset);
  }, [currentStreamPath, navigationState.view, viewState.slots.feed]);

  const focusHeader = useCallback(() => {
    setNavigationState((previous) => focusStreamTuiHeader(previous));
  }, []);

  const appContext = useMemo<AppContext>(
    () => ({
      get streamPath() {
        return currentStreamPath;
      },
      get reducedState() {
        return viewState;
      },
      streamApi,
      setActiveView,
      switchFeedMode,
      setStreamSummaries(streams, filter) {
        setStreamSummaries(streams);
        setSelectedStreamPath(currentStreamPath);
        setExpandedStreamPaths(
          (previous) => new Set([...previous, ...getDefaultExpandedStreamPaths(currentStreamPath)]),
        );
        setStreamSearchOpen((filter ?? "").length > 0);
        setStreamSearchQuery(filter ?? "");
      },
      navigateToStream,
      restartStream,
      prefillInput(value) {
        replaceComposerValue(value);
        focusInput();
      },
      collapseVisibleFeedItems() {},
      expandVisibleFeedItems() {},
      openEventDetail(offset) {
        setDetailEventOffset(offset);
        setSelectedOffset(offset);
        setNavigationState((previous) => setStreamTuiView(previous, "feed"));
        focusFeed();
      },
      exit() {
        activeAbortController.current?.abort();
        renderer.destroy();
      },
      toast: {
        info(message) {
          setAppendStatus(message);
        },
        success(message) {
          setAppendStatus(message);
        },
        error(message) {
          setAppendStatus(`error: ${message}`);
        },
      },
    }),
    [
      currentStreamPath,
      focusFeed,
      focusInput,
      navigateToStream,
      replaceComposerValue,
      renderer,
      restartStream,
      setActiveView,
      streamApi,
      switchFeedMode,
      viewState,
    ],
  );

  const slashUi = useMemo(() => {
    const resolvedCommand = getResolvedSlashCommand(composerValue);
    if (resolvedCommand != null) {
      return {
        suggestions: [] satisfies TuiSlashSuggestion[],
        commandDocs: formatCommandDocsForTui(resolvedCommand),
      };
    }

    const suggestions = suggestSlashCommands({
      commands: commandEntries,
      input: composerValue,
      limit: 8,
    });
    return {
      suggestions: suggestions.map((command) => ({
        path: command.path,
        segments: formatSlashCommandLabelSegments({ command, input: composerValue }),
      })),
      commandDocs: [] as string[],
    };
  }, [composerValue]);

  useEffect(() => {
    const query = parseSlashAutocompleteQuery(composerValue);
    if (slashUi.suggestions.length === 0) {
      setSelectedSlashCommandPath(undefined);
      return;
    }

    setSelectedSlashCommandPath((previous) =>
      previous != null && slashUi.suggestions.some((command) => command.path === previous)
        ? previous
        : slashUi.suggestions[0]?.path,
    );
    void query;
  }, [composerValue, slashUi.suggestions]);

  const visibleStreamRows = useMemo(
    () =>
      getStreamTreeRows({
        streams: streamSummaries,
        currentStreamPath,
        expandedPaths: expandedStreamPaths,
        searchQuery: streamSearchOpen ? streamSearchQuery : "",
        selectedPath: selectedStreamPath,
      }),
    [
      currentStreamPath,
      expandedStreamPaths,
      selectedStreamPath,
      streamSearchOpen,
      streamSearchQuery,
      streamSummaries,
    ],
  );

  const runSlashCommand = useCallback(
    async (content: string) => {
      if (!content.startsWith("/")) return false;
      const invocation = parseSlashInvocation(content);
      if (invocation == null) return false;

      const command = findDiscoveredSlashCommand({
        commands: commandEntries,
        slash: invocation.slash,
      });
      if (command == null) {
        setAppendStatus(`unknown command /${invocation.slash}`);
        return true;
      }

      try {
        setAppendStatus("");
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
          replaceComposerValue(`/${error.slashName} `);
          focusInput();
          return true;
        }
        setAppendStatus(`error: ${formatError(error)}`);
      }

      setAppendStatus((previous) => previous || `/${invocation.slash}`);
      return true;
    },
    [appContext, focusInput, replaceComposerValue],
  );

  const appendInput = useCallback(
    async (value: string) => {
      const content = value.trim();
      if (content.length === 0) return;

      replaceComposerValue("");
      if (await runSlashCommand(content)) return;

      setAppendStatus("sending");
      const event: EventInput = {
        type: "events.iterate.com/agent-chat/user-message-added",
        payload: { channel: "tui", content },
      };

      try {
        const appendedEvent = await streamApi.append({ event });
        setAppendStatus(`sent offset ${appendedEvent.offset}`);
      } catch (error) {
        setAppendStatus(`append error: ${formatError(error)}`);
      }
    },
    [replaceComposerValue, runSlashCommand, streamApi],
  );

  const selectAdjacentFeedItem = useCallback(
    (direction: -1 | 1) => {
      const rawRows = getRawEventRowTargetsForTui(viewState.slots.feed);
      if (rawRows.length === 0) return;
      const currentIndex = rawRows.findIndex((row) =>
        selectedOffset == null ? false : row.offsets.has(selectedOffset),
      );
      const nextIndex =
        currentIndex === -1 ? (direction === 1 ? 0 : rawRows.length - 1) : currentIndex + direction;
      if (nextIndex < 0 || nextIndex >= rawRows.length) return;
      setSelectedOffset(rawRows[nextIndex]?.offset);
    },
    [selectedOffset, viewState.slots.feed],
  );

  const navigateDetailEvent = useCallback(
    (direction: -1 | 1) => {
      const rawSummaries = getRawEventSummariesForTui(viewState.slots.feed);
      const currentIndex = rawSummaries.findIndex((item) => item.offset === detailEventOffset);
      const next = rawSummaries[currentIndex + direction];
      if (next == null) return;
      setDetailEventOffset(next.offset);
      setSelectedOffset(next.offset);
    },
    [detailEventOffset, viewState.slots.feed],
  );

  const selectAdjacentStreamRow = useCallback(
    (direction: -1 | 1) => {
      if (visibleStreamRows.length === 0) return;
      const currentIndex = visibleStreamRows.findIndex((row) => row.path === selectedStreamPath);
      const nextIndex =
        currentIndex === -1
          ? direction === 1
            ? 0
            : visibleStreamRows.length - 1
          : (currentIndex + direction + visibleStreamRows.length) % visibleStreamRows.length;
      setSelectedStreamPath(visibleStreamRows[nextIndex]?.path);
    },
    [selectedStreamPath, visibleStreamRows],
  );

  const openSelectedStreamPath = useCallback(() => {
    if (selectedStreamPath == null) return;
    navigateToStream(selectedStreamPath);
  }, [navigateToStream, selectedStreamPath]);

  const toggleSelectedStreamPath = useCallback(() => {
    const selectedRow = visibleStreamRows.find((row) => row.path === selectedStreamPath);
    if (selectedRow == null) return;
    if (!selectedRow.hasChildren) {
      openSelectedStreamPath();
      return;
    }
    setExpandedStreamPaths((previous) => {
      const next = new Set(previous);
      if (selectedRow.expanded) next.delete(selectedRow.path);
      else next.add(selectedRow.path);
      return next;
    });
  }, [openSelectedStreamPath, selectedStreamPath, visibleStreamRows]);

  const setSelectedStreamExpanded = useCallback(
    (expanded: boolean) => {
      if (selectedStreamPath == null) return;
      setExpandedStreamPaths((previous) => {
        const next = new Set(previous);
        if (expanded) next.add(selectedStreamPath);
        else next.delete(selectedStreamPath);
        return next;
      });
    },
    [selectedStreamPath],
  );

  const handleSlashAutocompleteKey = useCallback(
    (key: KeyEvent) => {
      if (slashUi.commandDocs.length > 0) {
        if (key.name === "escape") {
          replaceComposerValue("");
          return true;
        }
        return false;
      }
      if (slashUi.suggestions.length === 0) return false;

      if (key.name === "escape") {
        replaceComposerValue("");
        setSelectedSlashCommandPath(undefined);
        return true;
      }

      if (key.name === "tab" || key.name === "down" || key.name === "up") {
        const currentIndex = slashUi.suggestions.findIndex(
          (command) => command.path === selectedSlashCommandPath,
        );
        const direction = key.name === "up" || key.shift ? -1 : 1;
        const nextIndex =
          currentIndex === -1
            ? direction === 1
              ? 0
              : slashUi.suggestions.length - 1
            : (currentIndex + direction + slashUi.suggestions.length) % slashUi.suggestions.length;
        setSelectedSlashCommandPath(slashUi.suggestions[nextIndex]?.path);
        return true;
      }

      if (key.name === "return") {
        const command = commandEntries.find((entry) => entry.path === selectedSlashCommandPath);
        if (command != null) {
          const nextValue = acceptedSlashInput(command);
          if (command.input?.positional?.required !== true) {
            void appendInput(nextValue);
          } else {
            replaceComposerValue(nextValue);
          }
        }
        return true;
      }

      return false;
    },
    [
      appendInput,
      replaceComposerValue,
      selectedSlashCommandPath,
      slashUi.commandDocs.length,
      slashUi.suggestions,
    ],
  );

  const handleStreamsViewKey = useCallback(
    (key: KeyEvent) => {
      if (key.name === "escape") {
        if (streamSearchOpen) {
          setStreamSearchOpen(false);
          setStreamSearchQuery("");
          return true;
        }
        return false;
      }
      if (key.name === "down") {
        selectAdjacentStreamRow(1);
        return true;
      }
      if (key.name === "up") {
        selectAdjacentStreamRow(-1);
        return true;
      }
      if (key.name === "return") {
        openSelectedStreamPath();
        return true;
      }

      if (streamSearchOpen) {
        if (key.name === "backspace") {
          setStreamSearchQuery((previous) => previous.slice(0, -1));
          return true;
        }
        if (isPrintableCharacter(key.sequence)) {
          setStreamSearchQuery((previous) => previous + key.sequence);
          return true;
        }
        return true;
      }

      if (key.sequence === " ") {
        const now = Date.now();
        if (now - lastSpaceTimestamp < 300) {
          setExpandedStreamPaths((previous) => {
            const next = new Set(previous);
            if (selectedStreamPath != null) {
              next.add(selectedStreamPath);
              for (const stream of streamSummaries) {
                if (stream.path.startsWith(`${selectedStreamPath}/`)) next.add(stream.path);
              }
            }
            return next;
          });
          setLastSpaceTimestamp(0);
        } else {
          toggleSelectedStreamPath();
          setLastSpaceTimestamp(now);
        }
        return true;
      }

      if (key.name === "right") {
        setSelectedStreamExpanded(true);
        return true;
      }
      if (key.name === "left") {
        setSelectedStreamExpanded(false);
        return true;
      }
      if (isPrintableCharacter(key.sequence)) {
        setStreamSearchOpen(true);
        setStreamSearchQuery(key.sequence);
        return true;
      }
      return false;
    },
    [
      lastSpaceTimestamp,
      openSelectedStreamPath,
      selectAdjacentStreamRow,
      selectedStreamPath,
      setSelectedStreamExpanded,
      streamSearchOpen,
      streamSummaries,
      toggleSelectedStreamPath,
    ],
  );

  useKeyboard((key) => {
    if (handleSlashAutocompleteKey(key)) {
      key.preventDefault();
      key.stopPropagation();
      return;
    }

    if (key.name === "tab") {
      const regions = ["header", "feed", "composer"] as const;
      const currentIndex = regions.indexOf(navigationState.focus);
      const next = regions[(currentIndex + (key.shift ? -1 : 1) + regions.length) % regions.length];
      if (next === "composer") focusInput();
      else if (next === "feed") focusFeed();
      else focusHeader();
      key.preventDefault();
      key.stopPropagation();
      return;
    }

    if (
      navigationState.focus === "feed" &&
      navigationState.view === "streams" &&
      handleStreamsViewKey(key)
    ) {
      key.preventDefault();
      key.stopPropagation();
      return;
    }

    if (navigationState.focus !== "feed") {
      if (key.name === "escape") {
        setNavigationState((previous) => setStreamTuiView(previous, "feed"));
        focusInput();
        key.preventDefault();
        key.stopPropagation();
      }
      return;
    }

    if (key.name === "escape") {
      if (detailEventOffset != null) {
        setDetailEventOffset(undefined);
      } else {
        setNavigationState((previous) => setStreamTuiView(previous, "feed"));
        focusInput();
      }
      key.preventDefault();
      key.stopPropagation();
      return;
    }

    if (detailEventOffset != null) {
      if (key.name === "left") navigateDetailEvent(-1);
      if (key.name === "right") navigateDetailEvent(1);
      return;
    }

    if (key.name === "down") {
      selectAdjacentFeedItem(1);
      key.preventDefault();
      return;
    }
    if (key.name === "up") {
      selectAdjacentFeedItem(-1);
      key.preventDefault();
      return;
    }
    if (
      (key.name === "return" || key.name === "right" || key.name === "space") &&
      selectedOffset != null
    ) {
      setDetailEventOffset(selectedOffset);
      key.preventDefault();
    }
  });

  const composerPlaceholder =
    navigationState.focus === "composer"
      ? "Type a message or / for commands"
      : "Tab to return to input";

  return (
    <TuiEventsStreamView
      streamPath={currentStreamPath}
      viewState={viewState}
      modeLabel={feedModes[currentFeedMode].label}
      status={status}
      appendStatus={appendStatus}
      pulseOn={pulseOn}
      focusedRegion={navigationState.focus}
      activeView={navigationState.view}
      detailEventOffset={detailEventOffset}
      selectedOffset={selectedOffset}
      streamRows={visibleStreamRows}
      streamSearchOpen={streamSearchOpen}
      streamSearchQuery={streamSearchQuery}
      composerValue={composerValue}
      composerRevision={composerRevision}
      composerPlaceholder={composerPlaceholder}
      slashSuggestions={slashUi.suggestions}
      selectedSlashCommandPath={selectedSlashCommandPath}
      commandDocs={slashUi.commandDocs}
      onComposerInput={setComposerValue}
      onComposerSubmit={appendInput}
    />
  );
}

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  targetFps: 30,
  screenMode: "alternate-screen",
  consoleMode: "disabled",
});
createRoot(renderer).render(<StreamTerminalApp />);

function getResolvedSlashCommand(input: string): CommandEntry | undefined {
  if (!input.startsWith("/") || !input.includes(" ")) return undefined;
  const invocation = parseSlashInvocation(input);
  if (invocation == null) return undefined;
  return findDiscoveredSlashCommand({ commands: commandEntries, slash: invocation.slash });
}

function isPrintableCharacter(sequence: string) {
  return sequence.length === 1 && sequence >= " " && sequence !== "\u007f";
}

function formatError(error: unknown) {
  if (error instanceof ORPCError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

function parseArgs(argv: string[]) {
  const baseUrl = readFlag(argv, "--base-url");
  const projectSlugOrId = readFlag(argv, "--project-slug-or-id");
  const streamPath = readFlag(argv, "--stream-path");

  if (baseUrl == null || projectSlugOrId == null) {
    throw new Error(
      "Usage: bun event-stream-terminal.tsx --base-url <url> --project-slug-or-id <slug-or-id> [--stream-path <path>]",
    );
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    projectSlugOrId,
    streamPath: streamPath == null ? undefined : StreamPath.parse(streamPath),
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

function createOsClient(baseUrl: string): OrpcClient {
  const authHeaders = requireAuthHeaders();
  return createORPCClient(
    new OpenAPILink(osContract, {
      url: new URL("/api", `${baseUrl}/`).toString(),
      fetch: (input, init) => {
        const requestInit: RequestInit = init ?? {};
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        for (const [key, value] of new Headers(requestInit.headers)) headers.set(key, value);
        for (const [key, value] of Object.entries(authHeaders)) headers.set(key, value);
        if (input instanceof Request) {
          return fetch(new Request(input, { ...requestInit, headers }));
        }
        return fetch(input, { ...requestInit, headers });
      },
    }),
  ) as OrpcClient;
}

function requireAuthHeaders() {
  const bearerToken =
    process.env.OS_E2E_ADMIN_API_SECRET?.trim() ||
    process.env.OS_ADMIN_API_SECRET?.trim() ||
    process.env.APP_CONFIG_ADMIN_API_SECRET?.trim() ||
    process.env.OS_E2E_BEARER_TOKEN?.trim();
  const cookie = process.env.OS_E2E_COOKIE?.trim();
  if (!bearerToken && !cookie) {
    throw new Error(
      "OS_E2E_ADMIN_API_SECRET, OS_ADMIN_API_SECRET, APP_CONFIG_ADMIN_API_SECRET, OS_E2E_BEARER_TOKEN, or OS_E2E_COOKIE is required.",
    );
  }

  return {
    ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
  };
}
