import { Suspense, useMemo } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { StreamPath as StreamPathType } from "@iterate-com/shared/streams/types";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import { getBrowserItx } from "~/itx/use-itx.ts";
import type { StreamTreeSource } from "~/components/stream-tree-browser.tsx";
import { breadcrumbLoaderData } from "~/lib/route-breadcrumbs.ts";
import { streamPathFromSplat, streamPathToSplat } from "~/lib/stream-links.ts";

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
  loader: ({ context, params }) => {
    const agentPath = params._splat;
    const { project } = context;

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
  // The boundary is only for the lazily-loaded ProjectStreamView chunk. The
  // feed itself does NOT depend on itx — it mirrors the project-streams socket
  // directly — so a dropped itx connection must never blank this page.
  return (
    <Suspense fallback={<div className="p-4 text-sm text-muted-foreground">Loading…</div>}>
      <ProjectAgentDetailContent />
    </Suspense>
  );
}

function ProjectAgentDetailContent() {
  const params = Route.useParams();
  const navigate = useNavigate();
  const { project, streamPath } = Route.useLoaderData();
  // itx backs ONLY the ⌘K stream tree, and is dialed lazily when the tree
  // subscribes (not via the suspending useItx) so itx being slow or down
  // degrades just the navigator, never the feed. getBrowserItx shares the
  // same pooled socket useItx would.
  const source = useMemo<StreamTreeSource>(
    () => (path: StreamPathType) => ({
      async onStateChange(onState) {
        const itx = await getBrowserItx(project.id);
        return itx.streams.get(path).onStateChange(onState);
      },
    }),
    [project.id],
  );
  // The stream view subscribes live, so a send needs no cache invalidation —
  // the new events arrive over the socket. Sending a message IS appending the
  // user-message-added event to the agent's own stream (what the agent DO's
  // sendMessage did); the subscribed Agent DO reacts to the new event.
  async function submitAgentMessage(message: string) {
    const itx = await getBrowserItx(project.id);
    await itx.streams.get(streamPath).append({
      type: "events.iterate.com/agent-chat/user-message-added",
      payload: { channel: "web", content: message },
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
