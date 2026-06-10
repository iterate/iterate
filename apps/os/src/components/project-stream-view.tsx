import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Spinner } from "@iterate-com/ui/components/spinner";
import {
  acquireStreamRuntime,
  type StreamBrowserSnapshot,
} from "@iterate-com/streams/browser/stream-browser-store";
import { useStreamQuery } from "@iterate-com/streams/browser/hooks/use-stream-query";
import type {
  StreamBrowserDatabase,
  StreamEventRow,
} from "@iterate-com/streams/browser/stream-browser-db";
import { browserProcessorStateStorage } from "@iterate-com/streams/browser/processor-state-storage";
import {
  BROWSER_RAW_EVENTS_SCHEMA_VERSION,
  BrowserRawEventsContract,
  BrowserRawEventsProcessor,
  type BrowserRawEventsState,
} from "@iterate-com/streams/processors/browser-raw-events/implementation";
import { StreamEventInput } from "@iterate-com/streams/shared/event";
import type { StreamPath } from "@iterate-com/shared/streams/types";
import { parse as parseYaml } from "yaml";

type ProjectStreamMessageComposer = {
  placeholder?: string;
  onSubmit: (message: string) => Promise<void>;
};

export function ProjectStreamView({
  defaultComposerMode,
  emptyLabel = "No events in this stream yet.",
  headerAccessory,
  messageComposer,
  projectSlugOrId,
  streamPath,
}: {
  defaultComposerMode?: "message" | "raw";
  emptyLabel?: string;
  headerAccessory?: ReactNode;
  messageComposer?: ProjectStreamMessageComposer;
  projectSlug: string;
  projectSlugOrId: string;
  streamPath: StreamPath;
}) {
  const streamPathText = streamPath.toString();
  const store = useMemo(
    () =>
      acquireStreamRuntime({
        namespace: projectSlugOrId,
        streamPath: streamPathText,
        streamUrl: projectStreamRpcPath(projectSlugOrId, streamPathText),
        slug: BrowserRawEventsContract.slug,
        schemaVersion: BROWSER_RAW_EVENTS_SCHEMA_VERSION,
        tables: ["events"],
        createProcessor({ stream, sql, subscriptionKey }) {
          const storage = browserProcessorStateStorage<BrowserRawEventsState>({
            sql,
            processorSlug: BrowserRawEventsContract.slug,
            subscriptionKey,
          });
          return new BrowserRawEventsProcessor({
            iterateContext: { stream },
            sql,
            readState: storage.readState,
            writeState: storage.writeState,
          });
        },
      }),
    [projectSlugOrId, streamPathText],
  );
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
  const countResult = useStreamQuery(store.streamDatabase, `SELECT COUNT(*) AS count FROM events`);
  const eventCount = Number(countResult.data[0]?.count ?? 0);
  const composerMode = defaultComposerMode ?? (messageComposer ? "message" : "raw");
  const [composerText, setComposerText] = useState(
    composerMode === "raw"
      ? "type: events.iterate.com/os/manual-event\npayload:\n  message: Hello from OS\n"
      : "",
  );
  const [submitError, setSubmitError] = useState<string | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Only auto-scroll to the bottom when the viewport is already pinned there.
  // Yanking a scrolled-up reader back to the bottom on every append shifts the
  // virtualized window far enough that the whole visible range re-queries and
  // flashes grey skeletons before SQLite returns the new rows.
  const stickToBottomRef = useRef(true);

  async function submit() {
    const trimmed = composerText.trim();
    if (!trimmed) return;
    setIsSubmitting(true);
    setSubmitError(undefined);
    // The user just appended from the composer at the bottom, so follow the
    // new event down even if they had scrolled up earlier.
    stickToBottomRef.current = true;
    try {
      if (composerMode === "message" && messageComposer) {
        await messageComposer.onSubmit(trimmed);
      } else {
        const parsed = parseYaml(trimmed) as unknown;
        const events = (Array.isArray(parsed) ? parsed : [parsed]).map((event) =>
          StreamEventInput.parse(event),
        );
        await store.appendBatch({ events });
      }
      setComposerText(composerMode === "raw" ? composerText : "");
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
      window.requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }

  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const scrollContainer = scrollContainerRef.current;
      if (scrollContainer == null) {
        return;
      }

      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [eventCount]);

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-white">
      <header className="shrink-0 border-b px-4 py-3">
        <h1 className="truncate font-mono text-sm font-semibold">{streamPathText}</h1>
        <StreamStatus count={eventCount} snapshot={snapshot} />
      </header>
      {headerAccessory == null ? null : <div className="shrink-0 border-b">{headerAccessory}</div>}
      <main
        ref={scrollContainerRef}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          const el = event.currentTarget;
          // Within ~80px of the bottom counts as "pinned"; expanding a row or a
          // late virtualizer measurement can leave a few px of slack.
          stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {countResult.status !== "ok" ? (
          <Centered>
            {countResult.status === "error"
              ? (countResult.error?.message ?? "SQLite query failed")
              : "Opening local SQLite mirror"}
          </Centered>
        ) : (
          <VirtualEventRows
            database={store.streamDatabase}
            emptyLabel={emptyLabel}
            eventCount={eventCount}
            scrollElementRef={scrollContainerRef}
            snapshot={snapshot}
          />
        )}
        {isSubmitting ? <PendingResultRow /> : null}
        <form
          className="border-t p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <textarea
            ref={inputRef}
            className="block max-h-48 min-h-20 w-full resize-y rounded-md border px-3 py-2 font-mono text-[13px] outline-none focus:border-slate-400"
            placeholder={messageComposer?.placeholder ?? "YAML event"}
            spellCheck={false}
            value={composerText}
            onChange={(event) => setComposerText(event.currentTarget.value)}
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <output className="min-w-0 truncate font-mono text-xs text-red-700">
              {submitError ?? ""}
            </output>
            <button
              className="rounded-md bg-slate-950 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              disabled={isSubmitting}
              type="submit"
            >
              {isSubmitting ? "Sending" : composerMode === "message" ? "Send" : "Append"}
            </button>
          </div>
        </form>
      </main>
    </section>
  );
}

function VirtualEventRows({
  database,
  emptyLabel,
  eventCount,
  scrollElementRef,
  snapshot,
}: {
  database: StreamBrowserDatabase;
  emptyLabel: string;
  eventCount: number;
  scrollElementRef: RefObject<HTMLDivElement | null>;
  snapshot: StreamBrowserSnapshot;
}) {
  const virtualizer = useVirtualizer({
    count: eventCount,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => 44,
    overscan: 24,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const first = virtualItems[0]?.index ?? 0;
  const last = virtualItems.at(-1)?.index ?? -1;
  const rowsResult = useStreamQuery(
    database,
    `SELECT local_index, offset, type, idempotency_key, created_at, inserted_at, json(raw_jsonb) AS raw_json
     FROM events
     WHERE local_index >= ? AND local_index < ?
     ORDER BY local_index ASC`,
    [first, last + 1],
  );
  // Retain the last committed rows across range re-queries. When the visible
  // window shifts (append grows the list, or a scroll moves it), the range SQL
  // query is recreated and briefly reports `pending` carrying a *different*
  // range's rows. Rendering straight from that pending data blanks every
  // already-visible row to a grey skeleton for a frame. Keeping the last "ok"
  // rows means only genuinely-new indices fall back to a skeleton.
  const lastRowsRef = useRef<Map<number, StreamEventRow>>(new Map());
  const rowsByIndex = useMemo(() => {
    if (rowsResult.status !== "ok") return lastRowsRef.current;
    const rows = new Map<number, StreamEventRow>();
    for (const row of rowsResult.data) {
      if (typeof row.local_index === "number") rows.set(row.local_index, row as StreamEventRow);
    }
    lastRowsRef.current = rows;
    return rows;
  }, [rowsResult.data, rowsResult.status]);

  if (eventCount === 0) {
    return (
      <Centered>
        {snapshot.connectionError ??
          (snapshot.connectionStatus === "subscribed" ? emptyLabel : snapshot.connectionStatus)}
      </Centered>
    );
  }

  return (
    <div className="px-4">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualItems.map((item) => {
          const row = rowsByIndex.get(item.index);
          return (
            <article
              className="absolute left-0 top-0 w-full border-b py-2 font-mono text-xs"
              key={item.key}
              ref={row ? virtualizer.measureElement : undefined}
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {row ? (
                <details>
                  <summary className="grid cursor-pointer grid-cols-[64px_minmax(0,1fr)_auto] gap-3 text-slate-600">
                    <span>#{row.offset}</span>
                    <span className="truncate">{row.type}</span>
                    <time>{row.created_at}</time>
                  </summary>
                  <pre className="mt-2 overflow-auto whitespace-pre-wrap break-words text-slate-800">
                    {JSON.stringify(JSON.parse(row.raw_json), null, 2)}
                  </pre>
                </details>
              ) : (
                <div className="h-6 rounded bg-slate-100" />
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function PendingResultRow() {
  return (
    <div className="flex items-center gap-2 border-t px-4 py-3 font-mono text-xs text-slate-500">
      <Spinner className="size-3.5" />
      <span>Waiting for result</span>
    </div>
  );
}

function StreamStatus({ count, snapshot }: { count: number; snapshot: StreamBrowserSnapshot }) {
  return (
    <p className="mt-1 flex gap-3 font-mono text-[11px] text-slate-500">
      <span>{snapshot.connectionStatus}</span>
      <span>{snapshot.subscriptionStatus}</span>
      <span>{count.toLocaleString()} events</span>
    </p>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center p-6 text-sm text-slate-500">
      {children}
    </div>
  );
}

function projectStreamRpcPath(projectSlugOrId: string, streamPath: string) {
  const normalized =
    streamPath === "" ? "/" : streamPath.startsWith("/") ? streamPath : `/${streamPath}`;
  return normalized === "/"
    ? `/api/project-streams/${encodeURIComponent(projectSlugOrId)}`
    : `/api/project-streams/${encodeURIComponent(projectSlugOrId)}/${encodeURIComponent(normalized)}`;
}
