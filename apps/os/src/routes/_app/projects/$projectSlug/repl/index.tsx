// Bare /repl: resume the project's MOST RECENT REPL session — a console
// should be where you left it — minting a fresh timestamped session stream
// only when none exists. Either way this page immediately REPLACES itself
// with the session's full URL (/projects/<slug>/repl/<timestamp-slug>), so
// the address bar always shows the real stream path and the back button
// never lands on the resolver.

import { Suspense } from "react";
import { ClientOnly, Navigate, createFileRoute } from "@tanstack/react-router";
import { useItxQuery } from "iterate/sdk/itx/react";
import { newReplSessionPath, newestReplSessionPath, replSessionSlug } from "~/lib/repl-session.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug/repl/")({
  staticData: {
    breadcrumb: "Repl",
  },
  component: ReplIndexPage,
});

function ReplIndexPage() {
  // itx never SSRs; the shell (and the SSR response body) shows the same
  // connecting note the session page uses.
  return (
    <ClientOnly fallback={<ReplResolving />}>
      <Suspense fallback={<ReplResolving />}>
        <ReplSessionResolver />
      </Suspense>
    </ClientOnly>
  );
}

function ReplResolving() {
  return (
    <div className="p-4 text-sm text-muted-foreground" data-spinner="true">
      Connecting to itx...
    </div>
  );
}

function ReplSessionResolver() {
  const { project } = Route.useRouteContext();
  const streams = useItxQuery({
    key: ["repl-sessions", project.id],
    query: (itx) => itx.streams.list(),
  });
  const sessionPath = newestReplSessionPath(streams) || newReplSessionPath(new Date());
  return (
    <Navigate
      params={{ projectSlug: project.slug, _splat: replSessionSlug(sessionPath) }}
      replace
      search={{}}
      to="/projects/$projectSlug/repl/$"
    />
  );
}
