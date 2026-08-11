// One REPL session: the URL suffix IS the session's stream path
// (/repl/<timestamp-slug>, the web-agent timestamp convention — see
// ~/lib/repl-session.ts), so sharing the URL shares the console: everyone on
// it sees the same Out[n] history live. Sessions are LAZY — a URL whose
// stream does not exist yet (a fresh "New REPL", a shared link the sharer
// never ran anything on) renders an empty console and births the stream only
// on the first Run. Bare /repl (../repl/index.tsx) resolves to the most
// recent session.

import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router";
import { ItxScopeRepl } from "~/components/itx-scope-repl.tsx";
import {
  PROJECT_REPL_INITIAL_CODE,
  REPL_SESSION_PATH_PREFIX,
  newReplSessionPath,
  replSessionSlug,
} from "~/lib/repl-session.ts";

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
      // The URL already names this session; nothing to establish.
      onSessionEstablished={() => {}}
      projectId={project.id}
      scopePath={scopePath}
    />
  );
}
