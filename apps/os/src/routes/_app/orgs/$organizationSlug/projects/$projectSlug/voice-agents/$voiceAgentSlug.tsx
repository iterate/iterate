import { createFileRoute } from "@tanstack/react-router";
import { StreamPath } from "@iterate-com/shared/streams/types";
import { z } from "zod";
import { VoiceAgentStreamConsole } from "~/components/voice-agent-stream-console.tsx";
import { orpc } from "~/orpc/client.ts";

const Search = z.object({
  streamPath: StreamPath.optional(),
});

export const Route = createFileRoute(
  "/_app/orgs/$organizationSlug/projects/$projectSlug/voice-agents/$voiceAgentSlug",
)({
  validateSearch: Search,
  ssr: false,
  loader: async ({ context, params }) => {
    const project = await context.queryClient.ensureQueryData({
      ...orpc.projects.findBySlug.queryOptions({ input: { slug: params.projectSlug } }),
      staleTime: 30_000,
    });

    return {
      breadcrumb: params.voiceAgentSlug,
      project,
    };
  },
  component: VoiceAgentConversationPage,
});

function VoiceAgentConversationPage() {
  const params = Route.useParams();
  const search = Route.useSearch();
  const { project } = Route.useLoaderData();
  const streamPath =
    search.streamPath ?? StreamPath.parse(`/agents/voice/${params.voiceAgentSlug}`);

  return (
    <VoiceAgentStreamConsole
      enableVoiceAgentProcessor
      organizationSlug={params.organizationSlug}
      project={project}
      projectSlug={params.projectSlug}
      streamPath={streamPath}
      title="Voice agent"
    />
  );
}
