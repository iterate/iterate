// Bare /repl: resume the project's MOST RECENT REPL session — a console
// should be where you left it — by replacing the URL with that session's
// full stream path. When the project has NO sessions, this page renders the
// console UNBORN instead: nothing (no stream, no scope) exists until the
// first Run, which mints the timestamp path (so it reflects when work
// actually started), births the scope, and router-replaces the URL with the
// new session's path.

import { Suspense } from "react";
import { ClientOnly, Navigate, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useItxQuery } from "iterate/sdk/itx/react";
import { ItxScopeRepl } from "~/components/itx-scope-repl.tsx";
import {
  KNOWN_STREAMS_QUERY,
  PROJECT_REPL_INITIAL_CODE,
  newReplSessionPath,
  newestReplSessionPath,
  replSessionSlug,
} from "~/lib/repl-session.ts";

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
  const navigate = useNavigate();
  const streams = useItxQuery({
    key: [...KNOWN_STREAMS_QUERY.key(project.id)],
    query: (itx) => itx.streams.list(),
  });
  const latest = newestReplSessionPath(streams);
  if (latest) {
    return (
      <Navigate
        params={{ projectSlug: project.slug, _splat: replSessionSlug(latest) }}
        replace
        search={{}}
        to="/projects/$projectSlug/repl/$"
      />
    );
  }
  // No sessions yet: an unborn console at the bare URL. The first Run mints
  // the session and lands its path in the URL (replace — the back button
  // must not return to this resolver state).
  return (
    <ItxScopeRepl
      initialCode={PROJECT_REPL_INITIAL_CODE}
      onNewSession={() =>
        void navigate({
          params: {
            projectSlug: project.slug,
            _splat: replSessionSlug(newReplSessionPath(new Date())),
          },
          search: {},
          to: "/projects/$projectSlug/repl/$",
        })
      }
      onSessionEstablished={(sessionPath) =>
        void navigate({
          params: { projectSlug: project.slug, _splat: replSessionSlug(sessionPath) },
          replace: true,
          search: {},
          to: "/projects/$projectSlug/repl/$",
        })
      }
      projectId={project.id}
      scopePath={null}
    />
  );
}
