import { Link, createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { buttonVariants } from "@iterate-com/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@iterate-com/ui/components/empty";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { orpc } from "~/orpc/client.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug/codemode-sessions/")({
  loader: async ({ context, params }) => {
    const project = await context.queryClient.ensureQueryData({
      ...orpc.projects.findBySlug.queryOptions({ input: { slug: params.projectSlug } }),
      staleTime: 30_000,
    });
    await context.queryClient.ensureQueryData({
      ...orpc.project.codemode.listSessions.queryOptions({
        input: { projectSlugOrId: project.id },
      }),
      staleTime: 10_000,
    });

    return {
      breadcrumb: "Codemode Sessions",
      project,
    };
  },
  component: CodemodeSessionsPage,
});

function CodemodeSessionsPage() {
  const params = Route.useParams();
  const { project } = Route.useLoaderData();
  const { data } = useQuery({
    ...orpc.project.codemode.listSessions.queryOptions({
      input: { projectSlugOrId: project.id },
    }),
    staleTime: 10_000,
  });
  const sessions = data?.sessions ?? [];

  return (
    <section className="max-w-md space-y-4 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Codemode Sessions</h2>
          <p className="text-sm text-muted-foreground">
            Project-scoped stream processors backed by enumerable Durable Objects.
          </p>
        </div>
        <Link
          className={buttonVariants({ size: "sm" })}
          to="/projects/$projectSlug/codemode-sessions/new"
          params={params}
        >
          New
        </Link>
      </div>

      {sessions.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No codemode sessions</EmptyTitle>
            <EmptyDescription>Create a session or run an example.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Link
              className={buttonVariants({ size: "sm" })}
              to="/projects/$projectSlug/codemode-sessions/new"
              params={params}
            >
              Create session
            </Link>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="space-y-3">
          {sessions.map((session) => (
            <Link
              key={session.name}
              className="block rounded-lg border bg-card p-4 hover:bg-accent"
              to="/projects/$projectSlug/codemode-sessions/$codemodeSessionName"
              params={{ ...params, codemodeSessionName: session.name }}
            >
              <div className="min-w-0 space-y-2">
                <Identifier value={session.name} textClassName="text-sm font-medium" />
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {session.streamPath}
                </p>
                <p className="text-xs text-muted-foreground">
                  Created {formatDate(session.createdAt)} · Woke {formatDate(session.lastWokenAt)}
                </p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}
