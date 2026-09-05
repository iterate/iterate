import { createFileRoute } from "@tanstack/react-router";
import { connectItx } from "iterate/sdk/itx/react";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import {
  breadcrumbLoaderData,
  streamBreadcrumb,
  streamPageStaticData,
} from "~/lib/route-breadcrumbs.ts";
import { streamPathFromSplat, streamPathToSplat } from "~/lib/stream-links.ts";
import { StreamViewSearch } from "~/lib/stream-view-search.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug/streams/$")({
  staticData: streamPageStaticData(),
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
  component: ProjectStreamDetailContent,
});

function ProjectStreamDetailContent() {
  const { project } = Route.useLoaderData();
  const { _splat: streamPath } = Route.useParams();

  async function submitMessage({
    content,
    attachments,
  }: {
    content: string;
    attachments: import("@iterate-com/shared/agent-message-attachments").AgentMessageAttachment[];
  }) {
    const itx = await connectItx(project.id);
    const [event] = await itx.streams.get(streamPath).append({
      type: "events.iterate.com/agents/context-added",
      payload: {
        role: "user",
        content,
        ...(attachments.length === 0 ? {} : { attachments }),
        actor: { type: "user", origin: "web" },
      },
    });
    // Feeds the composer's consume-own-append metric (see StreamMessageComposer).
    return event;
  }

  return (
    <ProjectStreamView
      defaultComposerMode="raw"
      messageComposer={{
        onSubmit: submitMessage,
        placeholder: "Message this stream",
      }}
      projectId={project.id}
      projectSlug={project.slug}
      streamPath={streamPath}
    />
  );
}
