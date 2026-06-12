import { Suspense, useMemo } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { StreamPath as StreamPathType } from "@iterate-com/shared/streams/types";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import { useItx } from "~/itx/use-itx.ts";
import {
  projectAgentRuntimeStateQueryOptions,
  projectAgentsListQueryOptions,
} from "~/lib/project-route-query.ts";
import { breadcrumbLoaderData } from "~/lib/route-breadcrumbs.ts";
import { streamPathFromSplat, streamPathToSplat } from "~/lib/stream-links.ts";
import { orpc } from "~/orpc/client.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug/agents/streams/$")({
  staticData: { hideAppHeader: true },
  params: {
    parse: (raw) => ({
      _splat: streamPathFromSplat(raw._splat),
    }),
    stringify: (parsed) => ({
      _splat: streamPathToSplat(parsed._splat),
    }),
  },
  ssr: false,
  loader: async ({ context, params }) => {
    const agentPath = params._splat;
    const { project } = context;
    await context.queryClient.ensureQueryData(
      projectAgentRuntimeStateQueryOptions({ agentPath, projectId: project.id }),
    );

    return breadcrumbLoaderData({
      breadcrumb: agentPath,
      project,
      streamPath: agentPath,
      streamBreadcrumb: {
        projectId: project.id,
        projectSlug: params.projectSlug,
        streamPath: agentPath,
      },
    });
  },
  component: ProjectAgentDetailPage,
});

function ProjectAgentDetailPage() {
  return (
    <Suspense
      fallback={<div className="p-4 text-sm text-muted-foreground">Connecting to itx...</div>}
    >
      <ProjectAgentDetailContent />
    </Suspense>
  );
}

function ProjectAgentDetailContent() {
  const params = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { project, streamPath } = Route.useLoaderData();
  const itx = useItx(project.id);
  const source = useMemo(() => (path: StreamPathType) => itx.streams.get(path), [itx]);
  const agentsQueryOptions = projectAgentsListQueryOptions(project.id);
  const sendMessage = useMutation(
    orpc.project.agents.sendMessage.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: agentsQueryOptions.queryKey });
      },
    }),
  );

  async function submitAgentMessage(message: string) {
    await sendMessage.mutateAsync({
      agentPath: streamPath,
      message,
      projectSlugOrId: project.id,
    });
  }

  function openStream(path: StreamPathType) {
    void navigate({
      to: "/projects/$projectSlug/agents/streams/$",
      params: {
        projectSlug: params.projectSlug,
        _splat: path,
      },
    });
  }

  return (
    <ProjectStreamView
      emptyLabel="No events on this agent stream yet."
      messageComposer={{
        onSubmit: submitAgentMessage,
        placeholder: "Message this agent",
      }}
      projectSlug={params.projectSlug}
      projectSlugOrId={project.id}
      streamPath={streamPath}
      streamNavigator={{ source, onOpenPath: openStream }}
    />
  );
}
