import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";

type ReproFooter = "none" | "normal" | "overlay-measured";
type ReproMode = "single" | "microtask" | "raf" | "timeout";

export const Route = createFileRoute("/virtual-repro")({
  validateSearch: (search) => ({
    affordance: search.affordance === "1",
    batch: numberSearchParam(search.batch, 1500),
    chunk: numberSearchParam(search.chunk, 250),
    delayMs: numberSearchParam(search.delayMs, 0),
    directDomUpdates: search.directDomUpdates === "1",
    footer: footerSearchParam(search.footer),
    initial: numberSearchParam(search.initial, 2),
    indexKeys: search.indexKeys === "1",
    mode: modeSearchParam(search.mode),
    threshold: numberSearchParam(search.threshold, 80),
  }),
  component: VirtualReproRoute,
});

function VirtualReproRoute() {
  const search = Route.useSearch();
  const parentRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const didInitialScroll = useRef(false);
  const nextMessageIndex = useRef(search.initial);
  const [footerHeight, setFooterHeight] = useState(0);
  // Canonical "have we hydrated" read: false during SSR, true on the client, no mount flash.
  const hydrated = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const [messages, setMessages] = useState(() => makeMessages(0, search.initial));
  const [runState, setRunState] = useState<"idle" | "running" | "done">("idle");

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 40,
    getItemKey: (index) => (search.indexKeys ? index : (messages[index]?.id ?? index)),
    anchorTo: "end",
    followOnAppend: true,
    paddingEnd: search.footer === "overlay-measured" ? footerHeight : 0,
    scrollEndThreshold: search.threshold,
    overscan: 6,
    directDomUpdates: search.directDomUpdates,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const firstVirtualItem = virtualItems[0];
  const lastVirtualItem = virtualItems.at(-1);

  useLayoutEffect(() => {
    if (didInitialScroll.current) return;
    didInitialScroll.current = true;
    virtualizer.scrollToEnd();
  }, [virtualizer]);

  useLayoutEffect(() => {
    if (search.footer !== "overlay-measured") return;
    const footerElement = footerRef.current;
    if (footerElement === null) return;

    function updateFooterHeight() {
      if (footerElement === null) return;
      setFooterHeight(Math.ceil(footerElement.getBoundingClientRect().height));
    }

    updateFooterHeight();
    const resizeObserver = new ResizeObserver(updateFooterHeight);
    resizeObserver.observe(footerElement);
    return () => resizeObserver.disconnect();
  }, [search.footer]);

  async function appendBatch() {
    setRunState("running");
    const chunks = chunksFor({
      totalCount: search.batch,
      chunkSize: search.chunk,
      startIndex: nextMessageIndex.current,
    });
    nextMessageIndex.current += search.batch;

    for (const chunk of chunks) {
      // Intentional sequential pacing: this repro spaces chunk appends over time to
      // reproduce the virtualizer's same-turn append behavior, so Promise.all is wrong here.
      await waitForMode(search.mode, search.delayMs);
      setMessages((current) => [...current, ...chunk]);
    }
    setRunState("done");
  }

  function reset() {
    didInitialScroll.current = false;
    nextMessageIndex.current = search.initial;
    setMessages(makeMessages(0, search.initial));
    setRunState("idle");
  }

  return (
    <main className="grid h-dvh grid-cols-[20rem_minmax(0,1fr)] bg-white text-slate-950">
      <section className="overflow-y-auto border-r border-slate-200 p-4">
        <h1>TanStack Virtual chat repro</h1>
        <dl>
          <div>
            <dt>Count</dt>
            <dd data-testid="virtual-repro-count">{messages.length}</dd>
          </div>
          <div>
            <dt>At end</dt>
            <dd>{String(virtualizer.isAtEnd(search.threshold))}</dd>
          </div>
          <div>
            <dt>Distance</dt>
            <dd data-testid="virtual-repro-distance">{virtualizer.getDistanceFromEnd()}</dd>
          </div>
          <div>
            <dt>Visible</dt>
            <dd>
              {firstVirtualItem?.index ?? "-"}..{lastVirtualItem?.index ?? "-"}
            </dd>
          </div>
          <div>
            <dt>Mode</dt>
            <dd>{search.mode}</dd>
          </div>
          <div>
            <dt>Footer</dt>
            <dd>{search.footer}</dd>
          </div>
          <div>
            <dt>Keys</dt>
            <dd>{search.indexKeys ? "index" : "id"}</dd>
          </div>
        </dl>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void appendBatch()}>
            Append batch
          </button>
          <button type="button" onClick={reset}>
            Reset
          </button>
          <button type="button" onClick={() => virtualizer.scrollToEnd()}>
            Latest
          </button>
        </div>
        <output>{runState}</output>
        <output data-testid="virtual-repro-hydrated">{String(hydrated)}</output>
      </section>

      <section className="relative min-h-0 overflow-hidden">
        {search.affordance ? (
          <button
            className="pointer-events-none absolute inset-x-0 z-10 flex justify-center p-3 top-0"
            type="button"
            onClick={() => virtualizer.scrollToOffset(0)}
          >
            Top
          </button>
        ) : null}
        <div
          className="h-full overflow-y-auto"
          data-testid="virtual-repro-scroller"
          ref={parentRef}
        >
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualItems.map((virtualItem) => {
              const message = messages[virtualItem.index];
              return (
                <div
                  className="absolute left-0 top-0 w-full border-b border-slate-100 px-3 py-2 font-mono text-xs"
                  data-index={virtualItem.index}
                  key={virtualItem.key}
                  ref={virtualizer.measureElement}
                  style={{ transform: `translateY(${virtualItem.start}px)` }}
                >
                  {message?.text ?? "..."}
                </div>
              );
            })}
          </div>
        </div>
        {search.affordance ? (
          <button
            className="pointer-events-none absolute inset-x-0 z-10 flex justify-center p-3 bottom-0"
            type="button"
            onClick={() => virtualizer.scrollToEnd()}
          >
            Latest
          </button>
        ) : null}
        {search.footer === "none" ? null : (
          <div
            className={
              search.footer === "overlay-measured"
                ? "sticky bottom-0 border-t border-slate-200 bg-white p-3 absolute inset-x-0 bottom-0"
                : "sticky bottom-0 border-t border-slate-200 bg-white p-3"
            }
            ref={footerRef}
          >
            <textarea aria-label="Composer" defaultValue="composer height probe" />
          </div>
        )}
      </section>
    </main>
  );
}

function makeMessages(startIndex: number, count: number) {
  return Array.from({ length: count }, (_, offset) => {
    const index = startIndex + offset;
    return {
      id: `message-${index}`,
      text: `${index + 1} events.iterate.com/debug/grid h-dvh grid-cols-[20rem_minmax(0,1fr)] bg-white text-slate-950 ${new Date(0).toISOString()}`,
    };
  });
}

function chunksFor(args: { totalCount: number; chunkSize: number; startIndex: number }) {
  const chunks: Array<ReturnType<typeof makeMessages>> = [];
  for (let index = 0; index < args.totalCount; index += args.chunkSize) {
    chunks.push(
      makeMessages(args.startIndex + index, Math.min(args.chunkSize, args.totalCount - index)),
    );
  }
  return chunks;
}

async function waitForMode(mode: ReproMode, delayMs: number) {
  if (mode === "single") return;
  if (mode === "microtask") {
    await Promise.resolve();
    return;
  }
  if (mode === "raf") {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return;
  }
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs));
}

function numberSearchParam(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function footerSearchParam(value: unknown): ReproFooter {
  return value === "normal" || value === "overlay-measured" ? value : "none";
}

function modeSearchParam(value: unknown): ReproMode {
  return value === "microtask" || value === "raf" || value === "timeout" ? value : "single";
}
