import { useRef, useState, type ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ActivityIcon, PlusIcon, RadioIcon, TimerIcon } from "lucide-react";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import type { StreamEvent } from "../../../../domains/streams/schemas.ts";
import { ItxBoundary } from "~/components/itx-boundary.tsx";
import { useItx, useItxSubscription, useLiveState } from "~/itx/itx-react.tsx";

// This page is the LIVE-STATE PLAYGROUND — a place to see the one primitive from
// three angles: a stateless node (`itx.liveDemo.ticker`, driven by a timer in
// the request isolate with no Durable Object), a DO-backed node whose state is
// shared across watchers (`itx.live`, mutated by `itx.liveDemo.increment()`),
// and a raw event subscription (the separate, non-folded lane).

export const Route = createFileRoute("/_app/projects/$projectSlug/reactivity")({
  ssr: false,
  loader: ({ context }) => ({ breadcrumb: "Reactivity", project: context.project }),
  component: ProjectReactivityPage,
});

const REACTIVITY_TEST_STREAM_PATH = "/reactivity-test";
const REACTIVITY_TEST_EVENT_TYPE = "events.iterate.com/reactivity-test/appended";

function ProjectReactivityPage() {
  return (
    <ItxBoundary>
      <ProjectReactivityContent />
    </ItxBoundary>
  );
}

function ProjectReactivityContent() {
  const { project } = Route.useLoaderData();
  const itx = useItx();

  // ONE hook, three subscriptions — each reads only the slice it renders, so a
  // change in one slice never re-renders a component reading another.
  const ticker = useLiveState(
    (itx) => itx.liveDemo.ticker,
    (state) => state.tick,
  );
  const counter = useLiveState(
    (itx) => itx.liveState,
    (state) => state.liveDemo,
  );
  const reduced = useLiveState(
    (itx) => itx.liveState,
    (state) => state.reduced,
  );
  const streamsIndex = useLiveState(
    (itx) => itx.liveState,
    (state) => state.streamsIndex,
  );
  const events = useReactivityTestStream();

  const [incrementing, setIncrementing] = useState(false);
  const increment = async () => {
    setIncrementing(true);
    try {
      await itx.liveDemo.increment();
    } finally {
      setIncrementing(false);
    }
  };

  const nextMarker = useRef(1);
  const [lastMarker, setLastMarker] = useState<string>();
  const appendEvent = async () => {
    const marker = `reactivity-event-${nextMarker.current++}`;
    setLastMarker(marker);
    await itx.streams.get(REACTIVITY_TEST_STREAM_PATH).append({
      type: REACTIVITY_TEST_EVENT_TYPE,
      payload: { marker },
    });
  };

  const created = reduced.value === undefined ? "unknown" : String(reduced.value.created);
  const indexedCount =
    streamsIndex.value === undefined ? "-" : String(Object.keys(streamsIndex.value).length);

  return (
    <section className="min-h-0 flex-1 overflow-auto p-4">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h1 className="text-lg font-semibold">Live state playground</h1>
            <p className="text-sm text-muted-foreground">
              One <code>useLiveState</code> primitive for {project.slug}
            </p>
          </div>
          <Badge
            data-testid="reactivity-status"
            variant={counter.status === "live" ? "default" : "secondary"}
          >
            {counter.status}
          </Badge>
        </header>

        <div className="grid gap-3 md:grid-cols-3">
          {/* STATELESS: a request-isolate RpcTarget, no Durable Object. */}
          <MetricPanel
            icon={<TimerIcon aria-hidden="true" data-icon="icon" />}
            label="Stateless ticker"
            detail="itx.liveDemo.ticker · no DO"
            value={ticker.value === undefined ? "…" : String(ticker.value)}
            testId="livedemo-ticker"
          />

          {/* DO-BACKED: a counter in the project DO, shared across every watcher. */}
          <section className="rounded-lg border bg-background p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <RadioIcon aria-hidden="true" data-icon="icon" />
              <span>DO-backed counter</span>
            </div>
            <div className="mt-2 flex items-end justify-between gap-3">
              <span className="font-mono text-2xl font-semibold" data-testid="livedemo-count">
                {counter.value === undefined ? "…" : String(counter.value.count)}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={increment}
                disabled={incrementing}
                data-testid="livedemo-increment"
              >
                <PlusIcon aria-hidden="true" data-icon="icon" />
                Increment
              </Button>
            </div>
          </section>

          {/* PROJECT STATE: the processor's fold, one slice of itx.live. */}
          <MetricPanel
            icon={<ActivityIcon aria-hidden="true" data-icon="icon" />}
            label="Indexed streams"
            detail={`created: ${created}`}
            value={indexedCount}
            testId="reactivity-index-count"
          />
        </div>

        <section className="rounded-lg border bg-background p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Event subscription (separate lane)</h2>
            <Badge variant={events.status === "live" ? "default" : "secondary"}>
              {events.status}
            </Badge>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={appendEvent}
            data-testid="reactivity-append-event"
          >
            <PlusIcon aria-hidden="true" data-icon="icon" />
            Append event
          </Button>
          <dl className="mt-3 grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Received</dt>
            <dd data-testid="reactivity-event-count">{events.markers.length}</dd>
            <dt className="text-muted-foreground">Last sent</dt>
            <dd className="truncate font-mono">{lastMarker ?? "-"}</dd>
          </dl>
        </section>

        <JsonPanel
          title="itx.liveState (project live state)"
          value={{
            reduced: reduced.value,
            streamsIndex: streamsIndex.value,
            liveDemo: counter.value,
          }}
        />
      </div>
    </section>
  );
}

/** Raw event-log subscription — the lane that stays separate from live state. */
function useReactivityTestStream() {
  const [markers, setMarkers] = useState<string[]>([]);
  const { status } = useItxSubscription(
    (itx) =>
      itx.streams.get(REACTIVITY_TEST_STREAM_PATH).subscribe({
        replayAfterOffset: 0,
        processEventBatch: (batch: { events: StreamEvent[] }) => {
          const fresh = (batch.events ?? [])
            .filter((event) => event.type === REACTIVITY_TEST_EVENT_TYPE)
            .map((event) => (event.payload as { marker: string }).marker);
          if (fresh.length > 0) setMarkers((prev) => [...new Set([...prev, ...fresh])].slice(-50));
        },
      }),
    [],
  );
  return { markers, status };
}

function MetricPanel({
  detail,
  icon,
  label,
  testId,
  value,
}: {
  detail?: string;
  icon?: ReactNode;
  label: string;
  testId?: string;
  value: string;
}) {
  return (
    <section className="rounded-lg border bg-background p-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <span className="font-mono text-2xl font-semibold" data-testid={testId}>
          {value}
        </span>
        {detail ? <span className="text-xs text-muted-foreground">{detail}</span> : null}
      </div>
    </section>
  );
}

function JsonPanel({ title, value }: { title: string; value: unknown }) {
  return (
    <section className="min-h-0 rounded-lg border bg-background">
      <header className="border-b px-3 py-2">
        <h2 className="text-sm font-semibold">{title}</h2>
      </header>
      <pre className="max-h-[24rem] overflow-auto p-3 font-mono text-xs whitespace-pre-wrap">
        {JSON.stringify(value, null, 2)}
      </pre>
    </section>
  );
}
