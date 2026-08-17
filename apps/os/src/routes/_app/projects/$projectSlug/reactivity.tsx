import { useEffect, useRef, useState, type ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ActivityIcon, PlusIcon, RadioIcon, TimerIcon } from "lucide-react";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import {
  useItx,
  useStreamConnection,
  useLiveState,
  type ItxConnectionStatus,
} from "iterate/sdk/itx/react";
import type { StreamEvent } from "iterate/processors";
import { breadcrumbStaticData } from "~/lib/route-breadcrumbs.ts";
import { deploymentStatusFromState } from "~/project-deployment-status.ts";

// The live-state PLAYGROUND — one primitive from several angles: a DO-backed
// composite (`itx.liveState`: the project's folded `reduced` state + the streams
// index + a demo counter), a stateless node (`itx.liveDemo.ticker`, a timer in
// the request isolate with no DO), and the SEPARATE raw event-log lane.

export const Route = createFileRoute("/_app/projects/$projectSlug/reactivity")({
  staticData: breadcrumbStaticData("Reactivity"),
  ssr: false,
  loader: ({ context }) => ({ project: context.project }),
  component: ProjectReactivityContent,
});

const REACTIVITY_TEST_STREAM_PATH = "/reactivity-test";
const REACTIVITY_TEST_EVENT_TYPE = "events.iterate.com/reactivity-test/appended";

type ReactivityTestEvent = { createdAt: string; marker: string; offset: number };

type ReactivityTestStreamState = {
  batchCount: number;
  error?: string;
  events: ReactivityTestEvent[];
  status: ItxConnectionStatus;
};

/**
 * Live raw-EVENT subscription — the lane that stays separate from live state.
 * Recovery is all `useStreamConnection`'s; this hook only accumulates delivered
 * events, deduped by offset so a re-subscription's replay is idempotent.
 */
function useReactivityTestStream(): ReactivityTestStreamState {
  const [feed, setFeed] = useState({ batchCount: 0, events: [] as ReactivityTestEvent[] });
  const subscription = useStreamConnection(
    (itx) =>
      itx.streams.get(REACTIVITY_TEST_STREAM_PATH).openConnection({
        replayAfterOffset: 0,
        processEventBatch: (batch: { events: StreamEvent[] }) => {
          const events = (batch.events || [])
            .filter(isReactivityTestEvent)
            .map(toReactivityTestEvent);
          setFeed((current) => ({
            batchCount: current.batchCount + 1,
            events: mergeReactivityTestEvents(current.events, events),
          }));
        },
      }),
    [],
  );
  return { ...feed, error: subscription.error, status: subscription.status };
}

type ReactivityActionState = {
  error?: string;
  marker?: string;
  status: "idle" | "running" | "done" | "error";
};

function ProjectReactivityContent() {
  const { project } = Route.useLoaderData();
  const itx = useItx();

  // The project's live state — the processor's fold (`reduced`) is one slice.
  // Each selector re-renders only when ITS slice changes.
  const live = useLiveState(
    (itx) => itx.liveState,
    (state) => state.reduced,
    [],
  );
  const streamsIndex = useLiveState(
    (itx) => itx.liveState,
    (state) => state.streamsIndex,
    [],
  );
  const counter = useLiveState(
    (itx) => itx.liveState,
    (state) => state.liveDemo,
    [],
  );
  const ticker = useLiveState(
    (itx) => itx.liveDemo.ticker,
    (state) => state.tick,
  );
  const testStream = useReactivityTestStream();

  // Count live-state pushes observed here — how the page makes server pushes
  // visible without owning a subscription. (`reduced` gets a new reference only
  // when the fold actually changes, e.g. a child stream is born.)
  const [pushCount, setPushCount] = useState(0);
  useEffect(() => {
    if (live.value === undefined) return;
    setPushCount((current) => current + 1);
  }, [live.value]);

  const nextActionId = useRef(1);
  const [action, setAction] = useState<ReactivityActionState>({ status: "idle" });
  const [incrementing, setIncrementing] = useState(false);

  const projectState = live.value;
  const phase = projectState === undefined ? "unknown" : deploymentStatusFromState(projectState);
  const projectId = project.id;
  const indexedCount =
    streamsIndex.value === undefined ? "-" : String(Object.keys(streamsIndex.value).length);

  async function appendTestEvent() {
    const marker = `reactivity-event-${nextActionId.current++}`;
    setAction({ marker, status: "running" });
    try {
      await itx.streams.get(REACTIVITY_TEST_STREAM_PATH).append({
        type: REACTIVITY_TEST_EVENT_TYPE,
        payload: { marker },
      });
      setAction({ marker, status: "done" });
    } catch (error: unknown) {
      setAction({ error: stringifyError(error), marker, status: "error" });
    }
  }

  async function appendTestBatch() {
    const id = nextActionId.current++;
    const markers = [1, 2, 3].map((index) => `reactivity-batch-${id}-${index}`);
    setAction({ marker: markers.at(-1), status: "running" });
    try {
      await itx.streams
        .get(REACTIVITY_TEST_STREAM_PATH)
        .append(
          ...markers.map((marker) => ({ type: REACTIVITY_TEST_EVENT_TYPE, payload: { marker } })),
        );
      setAction({ marker: markers.at(-1), status: "done" });
    } catch (error: unknown) {
      setAction({ error: stringifyError(error), marker: markers.at(-1), status: "error" });
    }
  }

  async function increment() {
    setIncrementing(true);
    try {
      await itx.liveDemo.increment();
    } finally {
      setIncrementing(false);
    }
  }

  return (
    <section className="min-h-0 flex-1 overflow-auto p-4">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h1 className="text-lg font-semibold">Live state playground</h1>
            <p className="text-sm text-muted-foreground">
              One <code>useLiveState</code> primitive for {project.slug}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {live.status === "connecting" || testStream.status === "connecting" ? (
              <Badge variant="secondary" data-spinner="true">
                connecting…
              </Badge>
            ) : null}
            <Badge
              data-testid="reactivity-status"
              variant={live.status === "live" ? "default" : "secondary"}
            >
              {live.status}
            </Badge>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={live.refresh}
              data-testid="reactivity-refresh"
            >
              Refresh
            </Button>
          </div>
        </header>

        <div className="grid gap-3 md:grid-cols-4">
          {/* STATELESS: a request-isolate node, no Durable Object. */}
          <MetricPanel
            icon={<TimerIcon aria-hidden="true" data-icon="icon" />}
            label="Stateless ticker"
            detail="itx.liveDemo.ticker · no DO"
            value={ticker.value === undefined ? "…" : String(ticker.value)}
            testId="livedemo-ticker"
          />
          {/* DO-BACKED counter, shared across every watcher. */}
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
          <MetricPanel
            icon={<ActivityIcon aria-hidden="true" data-icon="icon" />}
            label="Indexed streams"
            value={indexedCount}
            testId="reactivity-index-count"
          />
          {/* How many times the folded `reduced` slice pushed (offset is gone; this is the live-state analogue). */}
          <MetricPanel
            label="State updates"
            value={String(pushCount)}
            testId="reactivity-state-push-count"
          />
        </div>

        <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)]">
          <div className="space-y-4">
            <section className="rounded-lg border bg-background p-4">
              <h2 className="text-sm font-semibold">Project lifecycle</h2>
              <dl className="mt-3 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                <dt className="text-muted-foreground">Phase</dt>
                <dd>
                  <Badge
                    data-testid="reactivity-phase"
                    variant={
                      phase === "created"
                        ? "default"
                        : phase === "failed"
                          ? "destructive"
                          : "secondary"
                    }
                  >
                    {phase}
                  </Badge>
                </dd>
                <dt className="text-muted-foreground">Created</dt>
                <dd data-testid="reactivity-onboarding">
                  {projectState === undefined
                    ? "unknown"
                    : String(projectState.birthCertificate !== null)}
                </dd>
                <dt className="text-muted-foreground">Project ID</dt>
                <dd className="truncate font-mono text-xs" data-testid="reactivity-project-id">
                  {projectId}
                </dd>
                <dt className="text-muted-foreground">Streams</dt>
                <dd className="truncate font-mono text-xs">
                  {projectState === undefined ? "-" : String(projectState.streams.length)}
                </dd>
              </dl>
            </section>

            <section className="rounded-lg border bg-background p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">Event subscription (separate lane)</h2>
                <Badge
                  data-testid="reactivity-stream-status"
                  variant={testStream.status === "live" ? "default" : "secondary"}
                >
                  {testStream.status}
                </Badge>
              </div>
              <div className="mt-3 grid gap-2">
                <Button type="button" variant="outline" size="sm" onClick={appendTestEvent}>
                  <PlusIcon aria-hidden="true" data-icon="icon" />
                  Append stream event
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={appendTestBatch}>
                  <PlusIcon aria-hidden="true" data-icon="icon" />
                  Append stream batch
                </Button>
              </div>
              <dl className="mt-3 grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                <dt className="text-muted-foreground">Events</dt>
                <dd data-testid="reactivity-stream-event-count">{testStream.events.length}</dd>
                <dt className="text-muted-foreground">Status</dt>
                <dd
                  data-spinner={action.status === "running" ? "true" : undefined}
                  data-testid="reactivity-action-status"
                >
                  {action.status}
                </dd>
                <dt className="text-muted-foreground">Marker</dt>
                <dd className="truncate font-mono" data-testid="reactivity-last-action-marker">
                  {action.marker || "-"}
                </dd>
                {action.error ? (
                  <>
                    <dt className="text-muted-foreground">Error</dt>
                    <dd
                      className="font-mono text-destructive"
                      data-testid="reactivity-action-error"
                    >
                      {action.error}
                    </dd>
                  </>
                ) : null}
              </dl>
            </section>

            <section className="rounded-lg border bg-background p-4">
              <h2 className="text-sm font-semibold">Subscribed events</h2>
              <ReactivityEventList events={testStream.events} />
            </section>
          </div>

          <div className="grid min-h-0 gap-4 xl:grid-cols-2">
            <JsonPanel title="itx.liveState.reduced (folded)" value={projectState ?? null} />
            <JsonPanel title="itx.liveState.streamsIndex" value={streamsIndex.value ?? null} />
          </div>
        </div>
      </div>
    </section>
  );
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

function ReactivityEventList({ events }: { events: ReactivityTestEvent[] }) {
  return (
    <section className="mt-3 text-sm" data-testid="reactivity-event-list">
      {events.length === 0 ? (
        <p className="mt-1 text-muted-foreground">None</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {events.map((event) => (
            <li className="truncate font-mono text-xs" key={event.offset}>
              {event.marker}
            </li>
          ))}
        </ul>
      )}
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

function stringifyError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isReactivityTestEvent(event: StreamEvent) {
  const payload = (event.payload ?? {}) as { marker?: unknown };
  return event.type === REACTIVITY_TEST_EVENT_TYPE && typeof payload.marker === "string";
}

function toReactivityTestEvent(event: StreamEvent): ReactivityTestEvent {
  const payload = event.payload as { marker: string };
  return { createdAt: event.createdAt, marker: payload.marker, offset: event.offset };
}

function mergeReactivityTestEvents(
  existing: ReactivityTestEvent[],
  incoming: ReactivityTestEvent[],
) {
  const byOffset = new Map(existing.map((event) => [event.offset, event]));
  for (const event of incoming) byOffset.set(event.offset, event);
  return [...byOffset.values()].sort((a, b) => a.offset - b.offset).slice(-50);
}
