import { useCallback, useMemo, useState, type ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ActivityIcon, RefreshCwIcon, RadioIcon } from "lucide-react";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import { ItxBoundary } from "~/components/itx-boundary.tsx";
import type { ProjectProcessorState } from "~/domains/projects/stream-processors/project/contract.ts";
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
    const snapshot = (await itx.project.processor.snapshot()) as ProjectProcessorSnapshot;
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
        const snapshot = (await effectItx.project.processor.snapshot()) as ProjectProcessorSnapshot;
        if (disposed || requestId !== latestSnapshotRequest) return;
        commitSnapshot(snapshot);
      };

      try {
        const unsubscribe = await effectItx.project.processor.onStateChange(
          (projectProcessorState) => {
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

function ProjectReactivityPage() {
  return (
    <ItxBoundary>
      <ProjectReactivityContent />
    </ItxBoundary>
  );
}

function ProjectReactivityContent() {
  const { project } = Route.useLoaderData();
  const live = useLiveProjectProcessorSnapshot();
  const [manualRefreshPending, setManualRefreshPending] = useState(false);

  const projectState = live.state ?? live.snapshot?.state;
  const phase = projectState?.phase ?? "unknown";
  const onboarding = projectState?.onboarding ?? "unknown";
  const projectFacts = projectState?.project;
  const liveApi = useMemo(
    () =>
      [
        "useItxEffect(async (itx) => {",
        "  const unsubscribe = await itx.project.processor.onStateChange(setProjectState)",
        "  return () => unsubscribe()",
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

  return (
    <section className="min-h-0 flex-1 overflow-auto p-4">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h1 className="text-lg font-semibold">Reactive reduced state</h1>
            <p className="text-sm text-muted-foreground">
              Project processor playground for {project.slug}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={live.status === "live" ? "default" : "secondary"}>{live.status}</Badge>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={refreshSnapshot}
              disabled={manualRefreshPending}
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

        <div className="grid gap-3 md:grid-cols-3">
          <MetricPanel
            icon={<RadioIcon aria-hidden="true" data-icon="icon" />}
            label="State pushes"
            value={String(live.statePushCount)}
            detail={formatTime(live.lastStateAt)}
          />
          <MetricPanel
            icon={<ActivityIcon aria-hidden="true" data-icon="icon" />}
            label="Snapshot reads"
            value={String(live.snapshotCount)}
            detail={formatTime(live.lastSnapshotAt)}
          />
          <MetricPanel label="Processor offset" value={String(live.snapshot?.offset ?? "-")} />
        </div>

        <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)]">
          <div className="space-y-4">
            <section className="rounded-lg border bg-background p-4">
              <h2 className="text-sm font-semibold">Project lifecycle</h2>
              <dl className="mt-3 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                <dt className="text-muted-foreground">Phase</dt>
                <dd>
                  <Badge variant={phase === "ready" ? "default" : "secondary"}>{phase}</Badge>
                </dd>
                <dt className="text-muted-foreground">Onboarding</dt>
                <dd>{onboarding}</dd>
                <dt className="text-muted-foreground">Project ID</dt>
                <dd className="truncate font-mono text-xs">
                  {projectFacts?.projectId ?? project.id}
                </dd>
                <dt className="text-muted-foreground">Default host</dt>
                <dd className="truncate font-mono text-xs">{projectFacts?.defaultHost ?? "-"}</dd>
              </dl>
            </section>

            <section className="rounded-lg border bg-background p-4">
              <h2 className="text-sm font-semibold">Experiment plan</h2>
              <ol className="mt-3 list-decimal space-y-2 pl-4 text-sm text-muted-foreground">
                <li>Use this bridge to prove the home page can repaint from live stream pushes.</li>
                <li>Watch for processor lag between a root stream push and the snapshot offset.</li>
                <li>
                  Add processor-level push only if this bridge is too indirect or misses updates.
                </li>
              </ol>
            </section>
          </div>

          <div className="grid min-h-0 gap-4 xl:grid-cols-2">
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
  value,
}: {
  detail?: string;
  icon?: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <section className="rounded-lg border bg-background p-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <span className="font-mono text-2xl font-semibold">{value}</span>
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
