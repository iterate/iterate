// One REPL session: the URL suffix IS the session's stream path
// (/repl/<timestamp-slug>, the web-agent timestamp convention — see
// ~/lib/repl-session.ts), so sharing the URL shares the console: everyone on
// it sees the same Out[n] history live. Bare /repl (../repl/index.tsx)
// resolves to the most recent session; "New REPL" in the page header mints a
// fresh one.

import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router";
import { ItxActivityTail } from "~/components/itx-activity-tail.tsx";
import { ItxScopeRepl } from "~/components/itx-scope-repl.tsx";
import {
  REPL_SESSION_PATH_PREFIX,
  newReplSessionPath,
  replSessionSlug,
} from "~/lib/repl-session.ts";

// Deliberately a bare expression: the default Run doubles as a demo of the
// REPL echo (a trailing expression answers with its value).
const PROJECT_REPL_INITIAL_CODE = "await itx.__describe()";

export const Route = createFileRoute("/_app/projects/$projectSlug/repl/$")({
  staticData: {
    breadcrumb: "Repl",
  },
  component: ReplSessionPage,
});

function ReplSessionPage() {
  const { project } = Route.useRouteContext();
  const { _splat } = Route.useParams();
  const navigate = useNavigate();
  const sessionSlug = (_splat || "").replace(/^\/+|\/+$/g, "");
  if (sessionSlug === "") {
    // /repl/ with nothing after it: let the resolver pick the session.
    return (
      <Navigate params={{ projectSlug: project.slug }} replace to="/projects/$projectSlug/repl" />
    );
  }
  const scopePath = `${REPL_SESSION_PATH_PREFIX}${sessionSlug}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1">
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
          projectId={project.id}
          scopePath={scopePath}
        />
      </div>
      {/* useStreamConnection never suspends, and the tail is client-only, so it
          needs no ClientOnly/Suspense wrapper. */}
      <div className="flex max-h-56 min-h-0 flex-col">
        {/* Tail the stream this session journals on — runs, provides, revokes
            all land on the session scope, not the project root. */}
        <ItxActivityTail key={`${project.id}:${scopePath}`} path={scopePath} />
      </div>
    </div>
  );
}
