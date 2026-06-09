import { useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  CapnwebReplPage,
  createRootBrowserReplSession,
  type BrowserReplSession,
  type BrowserReplSessionFactory,
} from "~/routes/_app/capnweb-repl.tsx";

const PROJECT_REPL_INITIAL_CODE = "await ctx.project.describe()";

export const Route = createFileRoute("/_app/projects/$projectSlug/repl")({
  staticData: {
    breadcrumb: "Repl",
  },
  component: ProjectCapnwebReplPage,
});

function ProjectCapnwebReplPage() {
  const { project } = Route.useRouteContext();
  const connectSession = useMemo<BrowserReplSessionFactory>(
    () => async () => {
      const rootSession = createRootBrowserReplSession();
      try {
        const projectContext = await rootSession.ctx.projects.get(project.id).getIterateContext();

        return {
          close: rootSession.close,
          // The project-scoped IterateContext arrives as a Workers RPC stub
          // whose static type is unknown; the REPL only needs the ctx shape.
          ctx: projectContext as BrowserReplSession["ctx"],
        };
      } catch (error) {
        rootSession.close();
        throw error;
      }
    },
    [project.id],
  );

  return (
    <CapnwebReplPage
      connectSession={connectSession}
      initialCode={PROJECT_REPL_INITIAL_CODE}
      scope={{ projectId: project.id }}
    />
  );
}
