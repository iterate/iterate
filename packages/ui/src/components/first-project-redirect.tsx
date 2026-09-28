import { Navigate } from "@tanstack/react-router";
import { DefaultPendingComponent } from "./route-defaults.tsx";

/** `/projects` in an app that shows one project at a time (Agents, Notes, Voice): the first
 *  project this session lists, else a note that there is none. It navigates once the client-only
 *  route has mounted: a redirect from `beforeLoad` during the first hydration can leave TanStack's
 *  destination match in an error state without an error. */
export function FirstProjectRedirect({ project }: { project: { slug: string } | null }) {
  if (project)
    return (
      <>
        <Navigate to="/projects/$slug" params={{ slug: project.slug }} replace />
        <DefaultPendingComponent />
      </>
    );
  return (
    <main className="flex min-h-svh items-center justify-center p-6 text-sm text-muted-foreground">
      No projects yet — create one in the dash.
    </main>
  );
}
