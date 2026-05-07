import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { EventsStreamPathLabel } from "@iterate-com/ui/components/events/stream-path-label";
import type { Event } from "@iterate-com/shared/streams/types";
import { orpc } from "~/orpc/client.ts";
import { streamPathFromSplat } from "~/lib/stream-links.ts";

export const Route = createFileRoute(
  "/_app/orgs/$organizationSlug/projects/$projectSlug/streams/$",
)({
  loader: async ({ context, params }) => {
    const streamPath = streamPathFromSplat(params._splat);
    const project = await context.queryClient.ensureQueryData({
      ...orpc.projects.findBySlug.queryOptions({ input: { slug: params.projectSlug } }),
      staleTime: 30_000,
    });
    await context.queryClient.ensureQueryData({
      ...orpc.projects.streams.getState.queryOptions({
        input: { projectId: project.id, streamPath },
      }),
      staleTime: 10_000,
    });
    await context.queryClient.ensureQueryData({
      ...orpc.projects.streams.read.queryOptions({
        input: { projectId: project.id, streamPath, beforeOffset: "end" },
      }),
      staleTime: 5_000,
    });

    return {
      breadcrumb: streamPath,
      project,
      streamPath,
      streamBreadcrumb: {
        organizationSlug: params.organizationSlug,
        projectId: project.id,
        projectSlug: params.projectSlug,
        streamPath,
      },
    };
  },
  component: ProjectStreamDetailPage,
});

function ProjectStreamDetailPage() {
  const { project, streamPath } = Route.useLoaderData();
  const { data: state } = useQuery({
    ...orpc.projects.streams.getState.queryOptions({
      input: { projectId: project.id, streamPath },
    }),
    staleTime: 10_000,
  });
  const { data: history } = useQuery({
    ...orpc.projects.streams.read.queryOptions({
      input: { projectId: project.id, streamPath, beforeOffset: "end" },
    }),
    staleTime: 5_000,
  });
  const events = history?.events ?? [];

  return (
    <section className="max-w-md space-y-4 p-4">
      <div className="space-y-2 rounded-lg border bg-card p-4">
        <EventsStreamPathLabel path={streamPath} className="text-sm font-medium" />
        <p className="text-xs text-muted-foreground">
          {state?.eventCount ?? events.length} events · {state?.childPaths.length ?? 0} child
          streams
        </p>
      </div>

      <div className="space-y-3">
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No events in this stream yet.</p>
        ) : (
          events.map((event) => <StreamEventCard key={event.offset} event={event} />)
        )}
      </div>
    </section>
  );
}

function StreamEventCard({ event }: { event: Event }) {
  return (
    <article className="space-y-2 rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 truncate text-sm font-medium">{event.type}</p>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">#{event.offset}</span>
      </div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">
        {JSON.stringify(event.payload, null, 2)}
      </pre>
    </article>
  );
}
