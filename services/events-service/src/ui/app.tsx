/// <reference lib="dom" />

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  STREAM_CREATED_TYPE,
  STREAM_METADATA_UPDATED_TYPE,
  serviceManifest,
  type EventStreamEvent,
  type EventStreamSummary,
} from "@iterate-com/events-contract";
import { IterateEventType } from "@iterate-com/events-contract/lib";
import { cn } from "@iterate-com/ui/lib/utils";
import { Button } from "@iterate-com/ui/components/button";
import { Input } from "@iterate-com/ui/components/input";
import { Label } from "@iterate-com/ui/components/label";
import { NativeSelect, NativeSelectOption } from "@iterate-com/ui/components/native-select";
import { Textarea } from "@iterate-com/ui/components/textarea";
import { createEventBusClient, createEventBusWebSocketClient } from "../orpc/client.ts";

type StreamTransport = "websocket" | "sse";
type StatusTone = "neutral" | "connected" | "error";

interface ConnectionStatus {
  readonly text: string;
  readonly tone: StatusTone;
}

const DEFAULT_STREAM_PATH = "/demo/stream";
const META_STREAM_PATH = "/events/_meta";
const FIREHOSE_PAGE_PATH = "/firehose";
const TRANSPORT_QUERY_PARAM = "transport";

const runtimeServicePort = Number.parseInt(location.port, 10);
const runtimeServiceManifest =
  Number.isFinite(runtimeServicePort) && runtimeServicePort > 0
    ? { ...serviceManifest, port: runtimeServicePort }
    : serviceManifest;

const serviceClientOptions = {
  env: { ITERATE_PROJECT_BASE_URL: location.origin },
  manifest: runtimeServiceManifest,
} as const;

const httpClient = createEventBusClient(serviceClientOptions);

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const parseTransport = (value: string): StreamTransport => (value === "sse" ? "sse" : "websocket");

const transportLabel = (transport: StreamTransport): "WS" | "SSE" =>
  transport === "websocket" ? "WS" : "SSE";

const normalizePath = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error("Stream path is required");
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replaceAll(/\/+/g, "/");
};

const isFirehoseLocation = (path: string): boolean =>
  path === FIREHOSE_PAGE_PATH || path === `${FIREHOSE_PAGE_PATH}/`;

const isReservedPath = (path: string): boolean =>
  path === "/api" ||
  path.startsWith("/api/") ||
  path.startsWith("/@vite/") ||
  path.startsWith("/@id/") ||
  path.startsWith("/@fs/") ||
  path.startsWith("/node_modules/") ||
  path === FIREHOSE_PAGE_PATH ||
  path.startsWith(`${FIREHOSE_PAGE_PATH}/`) ||
  path === "/docs" ||
  path.startsWith("/docs/") ||
  path === "/openapi.json";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    const extra = isRecord(error)
      ? {
          code: error.code,
          status: error.status,
        }
      : undefined;

    return [
      error.message,
      ...(typeof extra?.code === "string" ? [`code=${extra.code}`] : []),
      ...(typeof extra?.status === "number" ? [`status=${String(extra.status)}`] : []),
    ].join(" | ");
  }

  return String(error);
};

const parseJsonObject = (
  input: string,
  kind: "Event payload" | "Metadata",
): Record<string, unknown> => {
  const parsed = JSON.parse(input || "{}");
  if (!isRecord(parsed)) {
    throw new Error(`${kind} must be a JSON object`);
  }
  return parsed;
};

const streamPathFromLocation = (): string => {
  const raw = decodeURIComponent(location.pathname);
  if (raw === "/" || raw.trim().length === 0) return DEFAULT_STREAM_PATH;
  if (isFirehoseLocation(raw)) return DEFAULT_STREAM_PATH;
  return normalizePath(raw);
};

const transportFromLocation = (): StreamTransport => {
  const url = new URL(location.href);
  return parseTransport(url.searchParams.get(TRANSPORT_QUERY_PARAM) ?? "websocket");
};

const setTransportInLocation = (transport: StreamTransport, replace = false): void => {
  const url = new URL(location.href);
  url.searchParams.set(TRANSPORT_QUERY_PARAM, transport);
  const nextURL = `${url.pathname}${url.search}${url.hash}`;
  if (replace) {
    history.replaceState({}, "", nextURL);
    return;
  }
  history.pushState({}, "", nextURL);
};

const setLocationStreamPath = (path: string, replace = false): void => {
  const normalizedPath = normalizePath(path);
  if (isReservedPath(normalizedPath)) {
    throw new Error(`"${normalizedPath}" is reserved for server routes`);
  }
  if (location.pathname === normalizedPath) return;
  const url = new URL(location.href);
  url.pathname = normalizedPath;
  const nextURL = `${url.pathname}${url.search}${url.hash}`;
  if (replace) {
    history.replaceState({}, "", nextURL);
    return;
  }
  history.pushState({}, "", nextURL);
};

const setLocationFirehose = (replace = false): void => {
  const url = new URL(location.href);
  url.pathname = FIREHOSE_PAGE_PATH;
  const nextURL = `${url.pathname}${url.search}${url.hash}`;
  if (replace) {
    history.replaceState({}, "", nextURL);
    return;
  }
  history.pushState({}, "", nextURL);
};

const formatRelativeTime = (timestamp: string): string => {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "unknown";

  const deltaSeconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (deltaSeconds < 5) return "just now";
  if (deltaSeconds < 60) return `${String(deltaSeconds)}s ago`;

  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${String(deltaMinutes)}m ago`;

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) return `${String(deltaHours)}h ago`;

  const deltaDays = Math.floor(deltaHours / 24);
  return `${String(deltaDays)}d ago`;
};

const extractMetadataFromEvent = (event: EventStreamEvent): Record<string, unknown> | undefined => {
  if (event.type !== STREAM_METADATA_UPDATED_TYPE) return undefined;
  if (!isRecord(event.payload)) return undefined;
  const metadata = event.payload.metadata;
  if (!isRecord(metadata)) return undefined;
  return metadata;
};

const extractStreamCreatedPath = (event: EventStreamEvent): string | undefined => {
  if (event.type !== STREAM_CREATED_TYPE) return undefined;
  if (!isRecord(event.payload)) return undefined;

  const pathValue = event.payload.path;
  if (typeof pathValue !== "string") return undefined;

  try {
    return normalizePath(pathValue);
  } catch {
    return undefined;
  }
};

const statusToneClass = (tone: StatusTone): string => {
  if (tone === "connected") return "text-emerald-700";
  if (tone === "error") return "text-destructive";
  return "text-muted-foreground";
};

const closeIterator = async (
  iterator: AsyncIterator<EventStreamEvent> | undefined,
): Promise<void> => {
  if (iterator?.return === undefined) return;
  await Promise.race([Promise.resolve(iterator.return()).catch(() => undefined), sleep(250)]);
};

const openLiveIterator = async (
  path: string,
  transport: StreamTransport,
): Promise<{ iterator: AsyncIterator<EventStreamEvent> }> => {
  if (transport === "websocket") {
    const websocketClient = createEventBusWebSocketClient(serviceClientOptions);
    const stream = await websocketClient.stream({ path, live: true });
    return { iterator: stream[Symbol.asyncIterator]() };
  }

  const stream = await httpClient.stream({ path, live: true });
  return { iterator: stream[Symbol.asyncIterator]() };
};

const openFirehoseIterator = async (): Promise<{ iterator: AsyncIterator<EventStreamEvent> }> => {
  const stream = await httpClient.firehose({});
  return { iterator: stream[Symbol.asyncIterator]() };
};

function StreamInspectorApp() {
  const [activePane, setActivePane] = useState<"stream" | "firehose">("stream");
  const [transport, setTransport] = useState<StreamTransport>("websocket");
  const [selectedStreamPath, setSelectedStreamPath] = useState<string>(DEFAULT_STREAM_PATH);
  const [streamPathInput, setStreamPathInput] = useState<string>(DEFAULT_STREAM_PATH);
  const [streamListState, setStreamListState] = useState<Map<string, EventStreamSummary>>(
    () => new Map(),
  );
  const [streamSearchInput, setStreamSearchInput] = useState<string>("");
  const [metaStatus, setMetaStatus] = useState<ConnectionStatus>({
    text: `Disconnected via ${transportLabel("websocket")} to ${META_STREAM_PATH}`,
    tone: "neutral",
  });
  const [streamStatus, setStreamStatus] = useState<ConnectionStatus>({
    text: `Disconnected via ${transportLabel("websocket")} to ${DEFAULT_STREAM_PATH}`,
    tone: "neutral",
  });
  const [statusText, setStatusText] = useState<string>("");
  const [statusTone, setStatusTone] = useState<"neutral" | "error">("neutral");
  const [metadataInput, setMetadataInput] = useState<string>("{}");
  const [eventType, setEventType] = useState<string>(
    "https://events.iterate.com/events/ui/manual-event-appended",
  );
  const [eventPayload, setEventPayload] = useState<string>('{"message":"hello"}');
  const [events, setEvents] = useState<EventStreamEvent[]>([]);

  const transportRef = useRef<StreamTransport>("websocket");
  const selectedStreamPathRef = useRef<string>(DEFAULT_STREAM_PATH);
  const knownStreamsRef = useRef<Map<string, EventStreamSummary>>(new Map());
  const metadataTokenRef = useRef<number>(0);
  const metadataIteratorRef = useRef<AsyncIterator<EventStreamEvent> | undefined>(undefined);
  const metadataReconnectTimerRef = useRef<number | undefined>(undefined);
  const streamTokenRef = useRef<number>(0);
  const streamIteratorRef = useRef<AsyncIterator<EventStreamEvent> | undefined>(undefined);
  const openStreamPathRef = useRef<string | undefined>(undefined);
  const firehoseTokenRef = useRef<number>(0);
  const firehoseIteratorRef = useRef<AsyncIterator<EventStreamEvent> | undefined>(undefined);
  const activePaneRef = useRef<"stream" | "firehose">("stream");
  const refreshIntervalRef = useRef<number | undefined>(undefined);

  const setStatus = useCallback((message: string, isError = false): void => {
    setStatusText(message);
    setStatusTone(isError ? "error" : "neutral");
  }, []);

  const setKnownStreams = useCallback((nextMap: Map<string, EventStreamSummary>): void => {
    knownStreamsRef.current = nextMap;
    setStreamListState(new Map(nextMap));
  }, []);

  const ensureKnownStream = useCallback(
    (path: string): void => {
      const current = knownStreamsRef.current;
      if (current.has(path)) return;
      const now = new Date().toISOString();
      const next = new Map(current);
      next.set(path, {
        path,
        createdAt: now,
        eventCount: 0,
        lastEventCreatedAt: now,
        metadata: {},
      });
      setKnownStreams(next);
    },
    [setKnownStreams],
  );

  const applySelectedStreamMetadata = useCallback((): void => {
    const summary = knownStreamsRef.current.get(selectedStreamPathRef.current);
    if (summary === undefined) {
      setMetadataInput("{}");
      return;
    }
    setMetadataInput(JSON.stringify(summary.metadata, null, 2));
  }, []);

  const refreshStreams = useCallback(async (): Promise<void> => {
    const summaries = await httpClient.listStreams({});

    const next = new Map<string, EventStreamSummary>();
    for (const summary of summaries) {
      let normalizedPath: string;
      try {
        normalizedPath = normalizePath(summary.path);
      } catch {
        continue;
      }

      next.set(normalizedPath, {
        ...summary,
        path: normalizedPath,
        metadata: isRecord(summary.metadata) ? summary.metadata : {},
      });
    }

    if (!next.has(selectedStreamPathRef.current)) {
      const now = new Date().toISOString();
      next.set(selectedStreamPathRef.current, {
        path: selectedStreamPathRef.current,
        createdAt: now,
        eventCount: 0,
        lastEventCreatedAt: now,
        metadata: {},
      });
    }

    setKnownStreams(next);
    applySelectedStreamMetadata();
  }, [applySelectedStreamMetadata, setKnownStreams]);

  const updateStreamSummaryFromEvent = useCallback(
    (event: EventStreamEvent): void => {
      let path: string;
      try {
        path = normalizePath(event.path);
      } catch {
        return;
      }

      const previous = knownStreamsRef.current.get(path);
      const metadata = extractMetadataFromEvent(event) ?? previous?.metadata ?? {};
      const createdAt = previous?.createdAt ?? event.createdAt;
      const eventCount = (previous?.eventCount ?? 0) + 1;

      const next = new Map(knownStreamsRef.current);
      next.set(path, {
        path,
        createdAt,
        eventCount,
        lastEventCreatedAt: event.createdAt,
        metadata,
      });
      setKnownStreams(next);

      if (path === selectedStreamPathRef.current) {
        setMetadataInput(JSON.stringify(metadata, null, 2));
      }
    },
    [setKnownStreams],
  );

  const clearMetadataReconnectTimer = useCallback((): void => {
    if (metadataReconnectTimerRef.current !== undefined) {
      clearTimeout(metadataReconnectTimerRef.current);
      metadataReconnectTimerRef.current = undefined;
    }
  }, []);

  const disconnectMetadata = useCallback(async (): Promise<void> => {
    metadataTokenRef.current += 1;
    clearMetadataReconnectTimer();

    const iterator = metadataIteratorRef.current;
    metadataIteratorRef.current = undefined;

    await closeIterator(iterator);

    setMetaStatus({
      text: `Disconnected via ${transportLabel(transportRef.current)} to ${META_STREAM_PATH}`,
      tone: "neutral",
    });
  }, [clearMetadataReconnectTimer]);

  const disconnectStream = useCallback(async (): Promise<void> => {
    streamTokenRef.current += 1;

    const iterator = streamIteratorRef.current;
    streamIteratorRef.current = undefined;
    openStreamPathRef.current = undefined;

    await closeIterator(iterator);

    setStreamStatus({
      text: `Disconnected via ${transportLabel(transportRef.current)} to ${selectedStreamPathRef.current}`,
      tone: "neutral",
    });
  }, []);

  const disconnectFirehose = useCallback(async (): Promise<void> => {
    firehoseTokenRef.current += 1;

    const iterator = firehoseIteratorRef.current;
    firehoseIteratorRef.current = undefined;

    await closeIterator(iterator);
  }, []);

  const connectMetadata = useCallback(async (): Promise<void> => {
    await disconnectMetadata();

    const token = metadataTokenRef.current + 1;
    metadataTokenRef.current = token;

    const currentTransport = transportRef.current;
    setMetaStatus({
      text: `Connecting via ${transportLabel(currentTransport)} to ${META_STREAM_PATH}`,
      tone: "neutral",
    });

    const scheduleReconnect = (): void => {
      clearMetadataReconnectTimer();
      metadataReconnectTimerRef.current = window.setTimeout(() => {
        void connectMetadata();
      }, 1_000);
    };

    try {
      const opened = await openLiveIterator(META_STREAM_PATH, currentTransport);
      metadataIteratorRef.current = opened.iterator;

      setMetaStatus({
        text: `Connected via ${transportLabel(currentTransport)} to ${META_STREAM_PATH}`,
        tone: "connected",
      });
      setStatus("");

      void refreshStreams().catch(() => undefined);

      void (async () => {
        try {
          while (token === metadataTokenRef.current) {
            const next = await opened.iterator.next();
            if (next.done) break;

            const createdPath = extractStreamCreatedPath(next.value);
            if (createdPath !== undefined) {
              ensureKnownStream(createdPath);
            }

            updateStreamSummaryFromEvent(next.value);
            void refreshStreams().catch(() => undefined);
          }

          if (token === metadataTokenRef.current) {
            setMetaStatus({
              text: `Connection closed via ${transportLabel(currentTransport)} to ${META_STREAM_PATH}`,
              tone: "error",
            });
            scheduleReconnect();
          }
        } catch (error) {
          if (token !== metadataTokenRef.current) return;
          setMetaStatus({
            text: `Connection error via ${transportLabel(currentTransport)} to ${META_STREAM_PATH}`,
            tone: "error",
          });
          setStatus(`Metadata stream error: ${errorMessage(error)}`, true);
          scheduleReconnect();
        }
      })();
    } catch (error) {
      setMetaStatus({
        text: `Connection error via ${transportLabel(currentTransport)} to ${META_STREAM_PATH}`,
        tone: "error",
      });
      setStatus(`Metadata stream error: ${errorMessage(error)}`, true);
      scheduleReconnect();
    }
  }, [
    clearMetadataReconnectTimer,
    disconnectMetadata,
    ensureKnownStream,
    refreshStreams,
    setStatus,
    updateStreamSummaryFromEvent,
  ]);

  const connectFirehose = useCallback(
    async (
      options: { readonly syncHistory: boolean; readonly replaceHistory?: boolean } = {
        syncHistory: true,
      },
    ): Promise<void> => {
      await disconnectStream();
      await disconnectFirehose();
      setEvents([]);

      activePaneRef.current = "firehose";
      setActivePane("firehose");

      if (options.syncHistory) {
        setLocationFirehose(options.replaceHistory === true);
      }

      const token = firehoseTokenRef.current + 1;
      firehoseTokenRef.current = token;

      setStreamStatus({
        text: "Connecting via SSE to /firehose",
        tone: "neutral",
      });

      try {
        const opened = await openFirehoseIterator();
        firehoseIteratorRef.current = opened.iterator;

        setStreamStatus({
          text: "Connected via SSE to /firehose",
          tone: "connected",
        });
        setStatus("");

        void (async () => {
          try {
            while (token === firehoseTokenRef.current) {
              const next = await opened.iterator.next();
              if (next.done) break;
              setEvents((previous) => [next.value, ...previous].slice(0, 500));
              updateStreamSummaryFromEvent(next.value);
            }

            if (token === firehoseTokenRef.current) {
              setStreamStatus({
                text: "Connection closed via SSE to /firehose",
                tone: "error",
              });
            }
          } catch (error) {
            if (token !== firehoseTokenRef.current) return;
            setStreamStatus({
              text: "Connection error via SSE to /firehose",
              tone: "error",
            });
            setStatus(`Firehose error: ${errorMessage(error)}`, true);
          }
        })();
      } catch (error) {
        setStreamStatus({
          text: "Connection error via SSE to /firehose",
          tone: "error",
        });
        setStatus(errorMessage(error), true);
      }
    },
    [disconnectStream, disconnectFirehose, setStatus, updateStreamSummaryFromEvent],
  );

  const connectStream = useCallback(
    async (
      streamPath: string,
      options: { readonly syncHistory: boolean; readonly replaceHistory?: boolean } = {
        syncHistory: true,
      },
    ): Promise<void> => {
      const normalizedPath = normalizePath(streamPath);
      if (isReservedPath(normalizedPath)) {
        throw new Error(`"${normalizedPath}" is reserved for server routes`);
      }

      selectedStreamPathRef.current = normalizedPath;
      setSelectedStreamPath(normalizedPath);
      setStreamPathInput(normalizedPath);

      if (options.syncHistory) {
        setLocationStreamPath(normalizedPath, options.replaceHistory === true);
      }

      await disconnectStream();
      await disconnectFirehose();
      setEvents([]);
      ensureKnownStream(normalizedPath);
      applySelectedStreamMetadata();
      activePaneRef.current = "stream";
      setActivePane("stream");

      const token = streamTokenRef.current + 1;
      streamTokenRef.current = token;

      const currentTransport = transportRef.current;
      setStreamStatus({
        text: `Connecting via ${transportLabel(currentTransport)} to ${normalizedPath}`,
        tone: "neutral",
      });

      try {
        const opened = await openLiveIterator(normalizedPath, currentTransport);
        streamIteratorRef.current = opened.iterator;
        openStreamPathRef.current = normalizedPath;

        setStreamStatus({
          text: `Connected via ${transportLabel(currentTransport)} to ${normalizedPath}`,
          tone: "connected",
        });
        setStatus("");

        void (async () => {
          try {
            while (token === streamTokenRef.current) {
              const next = await opened.iterator.next();
              if (next.done) break;
              setEvents((previous) => [next.value, ...previous].slice(0, 200));
              updateStreamSummaryFromEvent(next.value);
            }

            if (token === streamTokenRef.current) {
              openStreamPathRef.current = undefined;
              setStreamStatus({
                text: `Connection closed via ${transportLabel(currentTransport)} to ${normalizedPath}`,
                tone: "error",
              });
            }
          } catch (error) {
            if (token === streamTokenRef.current) {
              openStreamPathRef.current = undefined;
              setStreamStatus({
                text: `Connection error via ${transportLabel(currentTransport)} to ${normalizedPath}`,
                tone: "error",
              });
              setStatus(`Stream error: ${errorMessage(error)}`, true);
            }
          }
        })();

        await refreshStreams();
      } catch (error) {
        openStreamPathRef.current = undefined;
        setStreamStatus({
          text: `Connection error via ${transportLabel(currentTransport)} to ${normalizedPath}`,
          tone: "error",
        });
        setStatus(errorMessage(error), true);
      }
    },
    [
      applySelectedStreamMetadata,
      disconnectFirehose,
      disconnectStream,
      ensureKnownStream,
      refreshStreams,
      setStatus,
      updateStreamSummaryFromEvent,
    ],
  );

  const reconnectAll = useCallback(async (): Promise<void> => {
    await connectMetadata();
    if (activePaneRef.current === "firehose") {
      await connectFirehose({ syncHistory: false });
      return;
    }
    await connectStream(selectedStreamPathRef.current, { syncHistory: false });
  }, [connectMetadata, connectFirehose, connectStream]);

  const sortedStreams = useMemo(() => {
    return [...streamListState.values()].sort(
      (left, right) =>
        right.lastEventCreatedAt.localeCompare(left.lastEventCreatedAt) ||
        left.path.localeCompare(right.path),
    );
  }, [streamListState]);

  const filteredStreams = useMemo(() => {
    const query = streamSearchInput.trim().toLowerCase();
    if (query.length === 0) return sortedStreams;
    return sortedStreams.filter((stream) => JSON.stringify(stream).toLowerCase().includes(query));
  }, [sortedStreams, streamSearchInput]);

  const onOpenStream = useCallback(async (): Promise<void> => {
    await connectStream(streamPathInput, { syncHistory: true });
  }, [connectStream, streamPathInput]);

  const onOpenFirehose = useCallback(async (): Promise<void> => {
    await connectFirehose({ syncHistory: true });
  }, [connectFirehose]);

  const onTransportChange = useCallback(
    async (nextTransport: StreamTransport): Promise<void> => {
      transportRef.current = nextTransport;
      setTransport(nextTransport);
      setTransportInLocation(nextTransport, true);
      await reconnectAll();
      setStatus("");
    },
    [reconnectAll, setStatus],
  );

  const onAppendEvent = useCallback(async (): Promise<void> => {
    const path = normalizePath(streamPathInput);
    const trimmedType = eventType.trim();
    if (trimmedType.length === 0) throw new Error("Event type is required");
    const parsedType = IterateEventType.parse(trimmedType);

    const payload = parseJsonObject(eventPayload, "Event payload");

    if (openStreamPathRef.current !== path) {
      await connectStream(path, { syncHistory: true });
    }

    await httpClient.append({
      path,
      events: [{ type: parsedType, payload }],
    });

    setStatus("");
  }, [connectStream, eventPayload, eventType, setStatus, streamPathInput]);

  const onSetMetadata = useCallback(async (): Promise<void> => {
    const path = normalizePath(streamPathInput);
    const parsed = parseJsonObject(metadataInput, "Metadata");

    if (openStreamPathRef.current !== path) {
      await connectStream(path, { syncHistory: true });
    }

    await httpClient.append({
      path,
      events: [
        {
          type: STREAM_METADATA_UPDATED_TYPE,
          payload: { metadata: parsed },
        },
      ],
    });

    setMetadataInput(JSON.stringify(parsed, null, 2));
    setStatus("");
    await refreshStreams();
  }, [connectStream, metadataInput, refreshStreams, setStatus, streamPathInput]);

  useEffect(() => {
    let disposed = false;

    const setup = async (): Promise<void> => {
      try {
        const initialTransport = transportFromLocation();
        transportRef.current = initialTransport;
        setTransport(initialTransport);
        setTransportInLocation(initialTransport, true);
        const locationIsFirehose = isFirehoseLocation(location.pathname);
        const locationPath = streamPathFromLocation();
        selectedStreamPathRef.current = locationPath;
        setSelectedStreamPath(locationPath);
        setStreamPathInput(locationPath);
        activePaneRef.current = locationIsFirehose ? "firehose" : "stream";
        setActivePane(locationIsFirehose ? "firehose" : "stream");
        setMetadataInput("{}");
        setMetaStatus({
          text: `Connecting via ${transportLabel(initialTransport)} to ${META_STREAM_PATH}`,
          tone: "neutral",
        });
        setStreamStatus({
          text: locationIsFirehose
            ? "Disconnected via SSE to /firehose"
            : `Disconnected via ${transportLabel(initialTransport)} to ${locationPath}`,
          tone: "neutral",
        });

        ensureKnownStream(locationPath);
        await refreshStreams();
        void connectMetadata();

        if (disposed) return;

        if (locationIsFirehose) {
          await connectFirehose({ syncHistory: false });
        } else if (location.pathname === "/") {
          await connectStream(locationPath, { syncHistory: true, replaceHistory: true });
        } else {
          await connectStream(locationPath, { syncHistory: false });
        }
      } catch (error) {
        setStatus(errorMessage(error), true);
      }
    };

    const onPopState = (): void => {
      void (async () => {
        try {
          const locationTransport = transportFromLocation();
          if (locationTransport !== transportRef.current) {
            transportRef.current = locationTransport;
            setTransport(locationTransport);
            await connectMetadata();
          }
          if (isFirehoseLocation(location.pathname)) {
            await connectFirehose({ syncHistory: false });
          } else {
            await connectStream(streamPathFromLocation(), { syncHistory: false });
          }
        } catch (error) {
          setStatus(errorMessage(error), true);
        }
      })();
    };

    window.addEventListener("popstate", onPopState);

    refreshIntervalRef.current = window.setInterval(() => {
      void refreshStreams().catch(() => undefined);
    }, 5_000);

    void setup();

    return () => {
      disposed = true;
      window.removeEventListener("popstate", onPopState);
      if (refreshIntervalRef.current !== undefined) {
        clearInterval(refreshIntervalRef.current);
        refreshIntervalRef.current = undefined;
      }
      void disconnectMetadata();
      void disconnectStream();
      void disconnectFirehose();
      if (metadataReconnectTimerRef.current !== undefined) {
        clearTimeout(metadataReconnectTimerRef.current);
        metadataReconnectTimerRef.current = undefined;
      }
    };
  }, [
    connectFirehose,
    connectMetadata,
    connectStream,
    disconnectFirehose,
    disconnectMetadata,
    disconnectStream,
    ensureKnownStream,
    refreshStreams,
    setStatus,
  ]);

  return (
    <main className="mx-auto grid w-full max-w-7xl gap-4 p-4 md:grid-cols-[21rem_1fr] md:p-6">
      <section className="h-fit space-y-4 rounded-lg border p-4">
        <header className="space-y-1">
          <h2 className="text-base font-semibold">Stream Controls</h2>
          <p className={statusToneClass(metaStatus.tone)}>{metaStatus.text}</p>
        </header>

        <div className="grid gap-2">
          <Label>Connect via</Label>
          <NativeSelect
            value={transport}
            onChange={(event) => {
              const nextTransport = parseTransport(event.currentTarget.value);
              void onTransportChange(nextTransport).catch((error) => {
                setStatus(errorMessage(error), true);
              });
            }}
          >
            <NativeSelectOption value="websocket">WebSocket</NativeSelectOption>
            <NativeSelectOption value="sse">SSE</NativeSelectOption>
          </NativeSelect>
        </div>

        <div className="grid gap-2">
          <Label>Connect to stream</Label>
          <Input
            value={streamPathInput}
            onChange={(event) => {
              setStreamPathInput(event.currentTarget.value);
            }}
          />
        </div>

        <Button
          className="w-full"
          type="button"
          onClick={() => {
            void onOpenStream().catch((error) => {
              setStatus(errorMessage(error), true);
            });
          }}
        >
          Open Stream
        </Button>

        <div className="space-y-2">
          <Label>Special Stream</Label>
          <button
            type="button"
            className={cn(
              "w-full rounded-md border px-3 py-2 text-left text-xs",
              activePane === "firehose"
                ? "bg-accent text-accent-foreground"
                : "hover:bg-accent hover:text-accent-foreground",
            )}
            onClick={() => {
              void onOpenFirehose().catch((error) => {
                setStatus(errorMessage(error), true);
              });
            }}
          >
            <div className="truncate font-mono">/firehose</div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              Live firehose · this is a special case stream
            </div>
          </button>
        </div>

        <div className="space-y-2">
          <Label>Search streams</Label>
          <Input
            value={streamSearchInput}
            placeholder="Search streams"
            onChange={(event) => {
              setStreamSearchInput(event.currentTarget.value);
            }}
          />
        </div>

        <ul className="max-h-[45vh] space-y-2 overflow-y-auto pr-1">
          {filteredStreams.length === 0 ? (
            <li className="py-2 text-xs text-muted-foreground">No streams yet</li>
          ) : (
            filteredStreams.map((stream) => (
              <li key={stream.path}>
                <button
                  type="button"
                  className={cn(
                    "w-full rounded-md border px-3 py-2 text-left text-xs",
                    activePane === "stream" && stream.path === selectedStreamPath
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent hover:text-accent-foreground",
                  )}
                  onClick={() => {
                    void connectStream(stream.path, { syncHistory: true }).catch((error) => {
                      setStatus(errorMessage(error), true);
                    });
                  }}
                >
                  <div className="truncate font-mono">{stream.path}</div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {String(stream.eventCount)} event{stream.eventCount === 1 ? "" : "s"} · updated{" "}
                    {formatRelativeTime(stream.lastEventCreatedAt)}
                  </div>
                </button>
              </li>
            ))
          )}
        </ul>
      </section>

      <div className="space-y-4">
        <section className="space-y-5 rounded-lg border p-4">
          <header className="space-y-1">
            <h2 className="text-base font-semibold">
              {activePane === "firehose" ? "Firehose" : "Active Stream"}
            </h2>
            <p className={statusToneClass(streamStatus.tone)}>{streamStatus.text}</p>
            {statusTone === "error" && statusText.length > 0 ? (
              <p className="text-xs text-destructive">{statusText}</p>
            ) : null}
          </header>

          {activePane === "firehose" ? (
            <p className="text-xs text-muted-foreground">
              Live-only SSE firehose across all streams. No offsets, no historic catch-up, no
              metadata controls.
            </p>
          ) : (
            <>
              <div className="space-y-2">
                <Label>Stream metadata</Label>
                <Textarea
                  rows={4}
                  className="font-mono text-xs"
                  value={metadataInput}
                  onChange={(event) => {
                    setMetadataInput(event.currentTarget.value);
                  }}
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    void onSetMetadata().catch((error) => {
                      setStatus(errorMessage(error), true);
                    });
                  }}
                >
                  Update Metadata
                </Button>
              </div>

              <div className="space-y-2">
                <Label>Append event</Label>
                <Input
                  value={eventType}
                  className="font-mono text-xs"
                  onChange={(event) => {
                    setEventType(event.currentTarget.value);
                  }}
                />
                <Textarea
                  rows={4}
                  className="font-mono text-xs"
                  value={eventPayload}
                  onChange={(event) => {
                    setEventPayload(event.currentTarget.value);
                  }}
                />
                <Button
                  type="button"
                  onClick={() => {
                    void onAppendEvent().catch((error) => {
                      setStatus(errorMessage(error), true);
                    });
                  }}
                >
                  Send JSON Event
                </Button>
              </div>
            </>
          )}
        </section>

        <section className="rounded-lg border p-4">
          <h2 className="mb-3 text-base font-semibold">
            {activePane === "firehose" ? "Firehose Events" : "Live Events"}
          </h2>
          <ul className="divide-y divide-border">
            {events.length === 0 ? (
              <li className="py-2 text-xs text-muted-foreground">
                {activePane === "firehose" ? "No firehose events yet" : "No live events yet"}
              </li>
            ) : null}
            {events.map((event) => (
              <li key={`${event.path}:${event.offset}`} className="py-2">
                <details className="group">
                  <summary
                    className="flex w-full list-none cursor-pointer items-center gap-3 py-1 text-xs [&::-webkit-details-marker]:hidden"
                    aria-label={`Toggle raw data for ${event.type} at offset ${event.offset}`}
                  >
                    <span className="min-w-0 truncate">{event.type}</span>
                    <span className="ml-auto flex flex-col items-end text-right">
                      {activePane === "firehose" ? (
                        <span className="font-mono">{event.path}</span>
                      ) : null}
                      <span className="font-mono">{event.offset}</span>
                      <span className="text-muted-foreground" title={event.createdAt}>
                        {formatRelativeTime(event.createdAt)}
                      </span>
                    </span>
                    <span className="text-muted-foreground transition-transform group-open:rotate-90">
                      ▸
                    </span>
                  </summary>
                  <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded-md border bg-muted p-2 text-[11px]">
                    {JSON.stringify(event, null, 2) ?? "null"}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}

export function App() {
  return <StreamInspectorApp />;
}
