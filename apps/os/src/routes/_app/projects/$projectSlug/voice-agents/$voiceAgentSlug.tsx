import { createFileRoute } from "@tanstack/react-router";
import { StreamPath } from "@iterate-com/shared/streams/types";
import { VoiceAgentStreamConsole } from "~/components/voice-agent-stream-console.tsx";
import { breadcrumbLoaderData } from "~/lib/route-breadcrumbs.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug/voice-agents/$voiceAgentSlug")({
  ssr: false,
  loader: async ({ context, params }) => {
    const { project } = context;
    const streamPath = StreamPath.parse(`/agents/voice/${params.voiceAgentSlug}`);
    return breadcrumbLoaderData({
      breadcrumb: params.voiceAgentSlug,
      project,
      streamPath,
      streamBreadcrumb: {
        projectId: project.id,
        projectSlug: params.projectSlug,
        streamPath,
      },
    });
  },
  component: VoiceAgentDetailPage,
});

function VoiceAgentDetailPage() {
  const params = Route.useParams();
  const { project, streamPath } = Route.useLoaderData();

  return (
    <VoiceAgentStreamConsole
      enableVoiceAgentProcessor
      project={project}
      projectSlug={params.projectSlug}
      streamPath={streamPath}
      title={params.voiceAgentSlug}
    />
  );
}
