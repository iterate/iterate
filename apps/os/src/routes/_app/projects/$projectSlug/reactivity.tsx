import { useCallback, useMemo, useState, type ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ActivityIcon, PlusIcon, RefreshCwIcon, RadioIcon } from "lucide-react";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import { ItxBoundary } from "~/components/itx-boundary.tsx";
import type { ProjectProcessorState, StreamEvent } from "~/next/types.ts";
import { useItx, useItxEffect } from "~/itx/itx-react.tsx";

export const Route = createFileRoute("/_app/projects/$projectSlug/reactivity")({
  ssr: false,
  loader: ({ context }) => {
    return {
      breadcrumb: "Reactivity",
      project: context.project,
    };
  },
  component: ProjectReactivityPage,
});

type ProjectProcessorSnapshot = {
  offset: number;
  state: ProjectProcessorState;
};

type LiveStatus = "connecting" | "live" | "error";

type LiveProjectProcessorState = {
  error?: string;
  lastSnapshotAt?: number;
  lastStateAt?: number;
  snapshot?: ProjectProcessorSnapshot;
  snapshotCount: number;
  state?: ProjectProcessorState;
  statePushCount: number;
  status: LiveStatus;
};

const REACTIVITY_TEST_STREAM_PATH = "/reactivity-test";
const REACTIVITY_TEST_EVENT_TYPE = "events.iterate.com/reactivity-test/appended";

type ReactivityActionState = {
  error?: string;
  kind?: "batch" | "single";
  marker?: string;
  status: "idle" | "running" | "done" | "error";
};

type ReactivityTestEvent = {
  createdAt: string;
  marker: string;
  offset: number;
};

type ReactivityTestStreamState = {
  batchCount: number;
  error?: string;
  events: ReactivityTestEvent[];
  lastBatchAt?: number;
  status: LiveStatus;
};

type LiveProjectProcessorSnapshot = LiveProjectProcessorState & {
  refreshSnapshot: () => Promise<void>;
};

function useLiveProjectProcessorSnapshot(): LiveProjectProcessorSnapshot {
  const itx = useItx();
  const [state, setState] = useState<LiveProjectProcessorState>({
    snapshotCount: 0,
    status: "connecting",
    statePushCount: 0,
  });

  const commitSnapshot = useCallback((snapshot: ProjectProcessorSnapshot) => {
    setState((current) => ({
      ...current,
      lastSnapshotAt: Date.now(),
      snapshot,
      snapshotCount: current.snapshotCount + 1,
      status: "live",
    }));
  }, []);

  const refreshSnapshot = useCallback(async () => {
    const snapshot = (await itx.processor.snapshot()) as ProjectProcessorSnapshot;
    commitSnapshot(snapshot);
  }, [commitSnapshot, itx]);

  useItxEffect(
    async (effectItx) => {
      let disposed = false;
      let latestSnapshotRequest = 0;

      setState((current) => ({
        ...current,
        error: undefined,
        status: "connecting",
      }));

      const readSnapshot = async () => {
        const requestId = ++latestSnapshotRequest;
        const snapshot = (await effectItx.processor.snapshot()) as ProjectProcessorSnapshot;
        if (disposed || requestId !== latestSnapshotRequest) return;
        commitSnapshot(snapshot);
      };

      try {
        const unsubscribe = await effectItx.processor.onStateChange(
          (projectProcessorState: ProjectProcessorState) => {
            if (disposed) return;
            const parsedState = projectProcessorState as ProjectProcessorState;
            setState((current) => ({
              ...current,
              lastStateAt: Date.now(),
              state: parsedState,
              statePushCount: current.statePushCount + 1,
              status: "live",
            }));
            void readSnapshot().catch((error: unknown) => {
              if (disposed) return;
              setState((current) => ({
                ...current,
                error: error instanceof Error ? error.message : String(error),
                status: "error",
              }));
            });
          },
        );

        return () => {
          disposed = true;
          unsubscribe();
        };
      } catch (error: unknown) {
        if (disposed) return;
        setState((current) => ({
          ...current,
          error: error instanceof Error ? error.message : String(error),
          status: "error",
        }));
      }
    },
    [commitSnapshot],
  );

  return { ...state, refreshSnapshot };
}

function useReactivityTestStream(): ReactivityTestStreamState {
  const [state, setState] = useState<ReactivityTestStreamState>({
    batchCount: 0,
    events: [],
    status: "connecting",
  });

  useItxEffect(async (effectItx) => {
    let disposed = false;
    setState((current) => ({ ...current, error: undefined, status: "connecting" }));

    try {
      const subscription = await effectItx.streams.get(REACTIVITY_TEST_STREAM_PATH).subscribe({
        replayAfterOffset: 0,
        processEventBatch: (batch: { events: StreamEvent[] }) => {
          if (disposed) return;
          const events = (batch.events || [])
            .filter(isReactivityTestEvent)
            .map(toReactivityTestEvent);
          setState((current) => ({
            ...current,
            batchCount: current.batchCount + 1,
            events: mergeReactivityTestEvents(current.events, events),
            lastBatchAt: Date.now(),
            status: "live",
          }));
        },
      });
      if (!disposed) {
        setState((current) => ({ ...current, status: "live" }));
      }

      return () => {
        disposed = true;
        void subscription.unsubscribe();
      };
    } catch (error: unknown) {
      if (disposed) return;
      setState((current) => ({
        ...current,
        error: stringifyError(error),
        status: "error",
      }));
    }
  }, []);

  return state;
}

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
  const live = useLiveProjectProcessorSnapshot();
  const testStream = useReactivityTestStream();
  const [manualRefreshPending, setManualRefreshPending] = useState(false);
  const [nextActionId, setNextActionId] = useState(1);
  const [action, setAction] = useState<ReactivityActionState>({ status: "idle" });

  const projectState = live.state ?? live.snapshot?.state;
  // The next project processor state has no phase/onboarding machine; `created`
  // is the lifecycle fact, and the create request carries the project identity.
  const phase = projectState == null ? "unknown" : projectState.created ? "ready" : "pending";
  const projectId = projectState?.createRequest?.projectId ?? project.id;
  const actionObserved = isActionObserved(action, testStream.events);
  const actionSyncing = action.status === "done" && !actionObserved;
  const actionPending = action.status === "running" || actionSyncing;
  const actionStatus = actionSyncing ? "syncing..." : action.status;
  const liveApi = useMemo(
    () =>
      [
        "useItxEffect(async (itx) => {",
        '  const subscription = await itx.streams.get("/reactivity-test").subscribe({',
        "    processEventBatch: appendDeliveredEvents,",
        "  })",
        "  return () => void subscription.unsubscribe()",
        "}, [])",
      ].join("\n"),
    [],
  );

  async function refreshSnapshot() {
    setManualRefreshPending(true);
    try {
      await live.refreshSnapshot();
    } finally {
      setManualRefreshPending(false);
    }
  }

  async function appendTestEvent() {
    const actionId = nextActionId;
    const marker = `reactivity-event-${actionId}`;
    setNextActionId(actionId + 1);
    setAction({ kind: "single", marker, status: "running" });
    try {
      await itx.streams.get(REACTIVITY_TEST_STREAM_PATH).append({
        type: REACTIVITY_TEST_EVENT_TYPE,
        payload: { marker },
      });
      setAction({ kind: "single", marker, status: "done" });
    } catch (error: unknown) {
      setAction({ error: stringifyError(error), kind: "single", marker, status: "error" });
    }
  }

  async function appendTestBatch() {
    const actionId = nextActionId;
    const markers = [1, 2, 3].map((index) => `reactivity-batch-${actionId}-${index}`);
    const marker = markers.at(-1)!;
    setNextActionId(actionId + 1);
    setAction({ kind: "batch", marker, status: "running" });
    try {
      await itx.streams.get(REACTIVITY_TEST_STREAM_PATH).append(
        ...markers.map((eventMarker) => ({
          type: REACTIVITY_TEST_EVENT_TYPE,
          payload: { marker: eventMarker },
        })),
      );
      setAction({ kind: "batch", marker, status: "done" });
    } catch (error: unknown) {
      setAction({ error: stringifyError(error), kind: "batch", marker, status: "error" });
    }
  }

  return (
    <section className="min-h-0 flex-1 overflow-auto p-4">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h1 className="text-lg font-semibold">Reactive reduced state</h1>
            <p className="text-sm text-muted-foreground">
              Project reactivity playground for {project.slug}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge
              data-testid="reactivity-status"
              data-spinner={live.status === "connecting" ? "true" : undefined}
              variant={live.status === "live" ? "default" : "secondary"}
            >
              {live.status}
            </Badge>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={refreshSnapshot}
              disabled={manualRefreshPending}
              data-testid="reactivity-refresh"
            >
              <RefreshCwIcon aria-hidden="true" data-icon="icon" />
              Refresh
            </Button>
          </div>
        </header>

        {live.status === "error" ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 font-mono text-xs text-destructive">
            {live.error}
          </div>
        ) : null}

        <div className="grid gap-3 md:grid-cols-4">
          <MetricPanel
            icon={<RadioIcon aria-hidden="true" data-icon="icon" />}
            label="Stream batches"
            value={String(testStream.batchCount)}
            detail={formatTime(testStream.lastBatchAt)}
            testId="reactivity-stream-batch-count"
          />
          <MetricPanel
            icon={<ActivityIcon aria-hidden="true" data-icon="icon" />}
            label="Stream events"
            value={String(testStream.events.length)}
            testId="reactivity-stream-event-count"
          />
          <MetricPanel
            label="Project pushes"
            value={String(live.statePushCount)}
            detail={formatTime(live.lastStateAt)}
            testId="reactivity-state-push-count"
          />
          <MetricPanel
            label="Processor offset"
            value={String(live.snapshot?.offset ?? "-")}
            testId="reactivity-processor-offset"
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
                    variant={phase === "ready" ? "default" : "secondary"}
                  >
                    {phase}
                  </Badge>
                </dd>
                <dt className="text-muted-foreground">Created</dt>
                <dd data-testid="reactivity-onboarding">
                  {projectState == null ? "unknown" : String(projectState.created)}
                </dd>
                <dt className="text-muted-foreground">Project ID</dt>
                <dd className="truncate font-mono text-xs" data-testid="reactivity-project-id">
                  {projectId}
                </dd>
                <dt className="text-muted-foreground">Streams</dt>
                <dd className="truncate font-mono text-xs">
                  {projectState == null ? "-" : String(projectState.streams.length)}
                </dd>
              </dl>
            </section>

            <section className="rounded-lg border bg-background p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">Stream subscription</h2>
                <Badge
                  data-testid="reactivity-stream-status"
                  data-spinner={testStream.status === "connecting" ? "true" : undefined}
                  variant={testStream.status === "live" ? "default" : "secondary"}
                >
                  {testStream.status}
                </Badge>
              </div>
              <div className="mt-3 grid gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={appendTestEvent}
                  disabled={actionPending}
                >
                  <PlusIcon aria-hidden="true" data-icon="icon" />
                  Append stream event
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={appendTestBatch}
                  disabled={actionPending}
                >
                  <PlusIcon aria-hidden="true" data-icon="icon" />
                  Append stream batch
                </Button>
              </div>
              <dl className="mt-3 grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                <dt className="text-muted-foreground">Status</dt>
                <dd
                  data-testid="reactivity-action-status"
                  data-spinner={actionPending ? "true" : undefined}
                >
                  {action.status === "running" ? "running..." : actionStatus}
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
            <JsonPanel title="Subscribed stream events" value={testStream.events} />
            <JsonPanel title="Live processor state" value={live.state ?? null} />
            <JsonPanel title="Processor snapshot" value={live.snapshot ?? null} />
            <CodePanel title="React hook shape" code={liveApi} />
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
      <pre className="max-h-[32rem] overflow-auto p-3 font-mono text-xs whitespace-pre-wrap">
        {JSON.stringify(value, null, 2)}
      </pre>
    </section>
  );
}

function CodePanel({ title, code }: { title: string; code: string }) {
  return (
    <section className="min-h-0 rounded-lg border bg-background">
      <header className="border-b px-3 py-2">
        <h2 className="text-sm font-semibold">{title}</h2>
      </header>
      <pre className="overflow-auto p-3 font-mono text-xs whitespace-pre-wrap">{code}</pre>
    </section>
  );
}

function formatTime(timestamp: number | undefined) {
  if (timestamp === undefined) return "No push yet";
  return new Date(timestamp).toLocaleTimeString();
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
  return {
    createdAt: event.createdAt,
    marker: payload.marker,
    offset: event.offset,
  };
}

function mergeReactivityTestEvents(
  existing: ReactivityTestEvent[],
  incoming: ReactivityTestEvent[],
) {
  const byOffset = new Map(existing.map((event) => [event.offset, event]));
  for (const event of incoming) byOffset.set(event.offset, event);
  return [...byOffset.values()].sort((a, b) => a.offset - b.offset).slice(-50);
}

function isActionObserved(action: ReactivityActionState, events: ReactivityTestEvent[]) {
  if (action.status !== "done") return true;
  if (!action.marker) return false;
  return events.some((event) => event.marker === action.marker);
}
