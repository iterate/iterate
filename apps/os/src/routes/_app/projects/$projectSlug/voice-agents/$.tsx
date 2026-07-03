import { createFileRoute } from "@tanstack/react-router";
import { VoiceAgentConsole } from "~/components/voice-agent-console.tsx";
import { ItxBoundary } from "~/components/itx-boundary.tsx";
import { breadcrumbLoaderData } from "~/lib/route-breadcrumbs.ts";
import { streamPathFromSplat, streamPathToSplat } from "~/lib/stream-links.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug/voice-agents/$")({
  params: {
    parse: (raw) => ({
      _splat: streamPathFromSplat(raw._splat),
    }),
    stringify: (parsed) => ({
      _splat: streamPathToSplat(parsed._splat),
    }),
  },
  ssr: false,
  loader: ({ context, params }) => {
    const streamPath = params._splat;
    const { project } = context;

    return breadcrumbLoaderData({
      breadcrumb: streamPath,
      project,
      streamPath,
      streamBreadcrumb: {
        projectId: project.id,
        projectSlug: params.projectSlug,
        streamPath,
      },
    });
  },
  component: VoiceAgentConversationPage,
});

function VoiceAgentConversationPage() {
  const params = Route.useParams();
  const { project, streamPath } = Route.useLoaderData();

  return (
    <ItxBoundary>
      <VoiceAgentConsole
        projectId={project.id}
        projectSlug={params.projectSlug}
        streamPath={streamPath}
        title="Voice agent"
      />
    </ItxBoundary>
  );
}
