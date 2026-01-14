import { Suspense } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useSuspenseQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, RefreshCw } from "lucide-react";
import { trpc } from "../../../lib/trpc.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Spinner } from "../../../components/ui/spinner.tsx";
import { EmptyState } from "../../../components/empty-state.tsx";
import { HeaderActions } from "../../../components/header-actions.tsx";

export const Route = createFileRoute("/_auth/orgs/$organizationSlug/projects/$projectSlug/events")({
  component: EventsPage,
});

function EventsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <Spinner />
        </div>
      }
    >
      <EventsContent />
    </Suspense>
  );
}

function EventsContent() {
  const params = useParams({
    from: "/_auth/orgs/$organizationSlug/projects/$projectSlug/events",
  });
  const queryClient = useQueryClient();

  const eventListQueryOptions = trpc.event.list.queryOptions({
    organizationSlug: params.organizationSlug,
    projectSlug: params.projectSlug,
    limit: 50,
  });

  const { data: events, isFetching } = useSuspenseQuery({
    ...eventListQueryOptions,
    refetchInterval: 3000,
  });

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: eventListQueryOptions.queryKey });
  };

  if (!events.length) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <HeaderActions>
          <Button onClick={handleRefresh} size="sm" variant="outline" disabled={isFetching}>
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
            <span className="sr-only">Refresh</span>
          </Button>
        </HeaderActions>
        <EmptyState
          icon={<Activity className="h-12 w-12" />}
          title="No events yet"
          description="Events will appear here as they occur."
        />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8">
      <HeaderActions>
        <Button onClick={handleRefresh} size="sm" variant="outline" disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          <span className="sr-only">Refresh</span>
        </Button>
      </HeaderActions>
      <div className="space-y-2">
        {events.map((event) => (
          <div
            key={event.id}
            data-event-id={event.id}
            className="flex items-start gap-4 p-3 border rounded-lg bg-card text-sm"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
                  {event.type}
                </span>
                <span className="text-xs text-muted-foreground">
                  {new Date(event.createdAt).toLocaleString()}
                </span>
              </div>
              <pre className="mt-1 text-xs text-muted-foreground max-h-[100px] overflow-auto">
                {JSON.stringify(event.payload, null, 2)}
              </pre>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
