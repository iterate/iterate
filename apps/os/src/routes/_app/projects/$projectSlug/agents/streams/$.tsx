import { createFileRoute } from "@tanstack/react-router";
import { ItxBoundary } from "~/components/itx-boundary.tsx";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import { connectItxBrowser } from "~/itx/itx-react.tsx";
import { breadcrumbLoaderData, streamBreadcrumb } from "~/lib/route-breadcrumbs.ts";
import { streamPathFromSplat, streamPathToSplat } from "~/lib/stream-links.ts";
import { StreamViewSearch } from "~/lib/stream-view-search.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug/agents/streams/$")({
  params: {
    parse: (raw) => ({
      _splat: streamPathFromSplat(raw._splat),
    }),
    stringify: (parsed) => ({
      _splat: streamPathToSplat(parsed._splat),
    }),
  },
  validateSearch: StreamViewSearch,
  ssr: false,
  loader: ({ context, params }) =>
    breadcrumbLoaderData({
      project: context.project,
      streamBreadcrumb: streamBreadcrumb(context.project, params._splat),
    }),
  component: ProjectAgentDetailPage,
});

function ProjectAgentDetailPage() {
  // The boundary is only for the lazily-loaded stream-view chunk. The feed
  // runtime dials itx imperatively, so a reconnect is handled inside the
  // stream mirror without blanking the whole page.
  return (
    <ItxBoundary>
      <ProjectAgentDetailContent />
    </ItxBoundary>
  );
}

function ProjectAgentDetailContent() {
  const { project } = Route.useLoaderData();
  const { _splat: streamPath } = Route.useParams();
  // The stream view subscribes live, so a send needs no cache invalidation —
  // the new events arrive over the socket. Agent setup is owned by project and
  // agent processor facts; sendMessage only appends the user-facing input fact.
  // The socket is keyed by project ID (the provider pre-warmed it), and agents
  // are addressed by their stream path (e.g. "/agents/onboarding").
  async function submitAgentMessage(message: string) {
    const itx = await connectItxBrowser({ projectId: project.id });
    await itx.agents.get(streamPath).message(message);
  }

  async function submitAgentFiles({ files, message }: { files: File[]; message: string }) {
    const itx = await connectItxBrowser({ projectId: project.id });
    // One addFiles call → ONE input event carrying every attachment, so the
    // feed shows a single message and the agent gets one turn trigger.
    await itx.agents.get(streamPath).addFiles({
      files: await Promise.all(
        files.map(async (file) => ({
          contentType: file.type || "application/octet-stream",
          data: new Uint8Array(await file.arrayBuffer()),
          filename: file.name,
        })),
      ),
      ...(message ? { message } : {}),
    });
  }

  async function interruptAgentMessage(llmRequestOffset: number) {
    const itx = await connectItxBrowser({ projectId: project.id });
    await itx.streams.get(streamPath).append({
      type: "events.iterate.com/agent/llm-request-cancelled",
      payload: {
        phase: "requested",
        llmRequestOffset,
        reason: "interrupted-by-user-input",
      },
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <ProjectStreamView
          autoFocusMessageComposer
          emptyLabel="No events on this agent stream yet."
          messageComposer={{
            onInterrupt: interruptAgentMessage,
            onSubmit: submitAgentMessage,
            onSubmitFiles: submitAgentFiles,
            placeholder: "Message this agent",
          }}
          projectId={project.id}
          projectSlug={project.slug}
          streamPath={streamPath}
        />
      </div>
    </div>
  );
}
