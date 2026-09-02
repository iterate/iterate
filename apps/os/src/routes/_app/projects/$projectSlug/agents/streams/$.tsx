import { createFileRoute } from "@tanstack/react-router";
import { connectItx, useLiveState } from "iterate/sdk/itx/react";
import { AgentDetailsSheet } from "~/components/agents/agent-details-sheet.tsx";
import { filesToAgentPayload } from "~/lib/web-agent.ts";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import {
  breadcrumbLoaderData,
  streamBreadcrumb,
  streamPageStaticData,
} from "~/lib/route-breadcrumbs.ts";
import { streamPathFromSplat, streamPathToSplat } from "~/lib/stream-links.ts";
import { StreamViewSearch } from "~/lib/stream-view-search.ts";
import { configRepoFileMentionProvider } from "~/components/config-repo-file-mentions.tsx";

export const Route = createFileRoute("/_app/projects/$projectSlug/agents/streams/$")({
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
  component: ProjectAgentDetailContent,
});

function ProjectAgentDetailContent() {
  const { project } = Route.useLoaderData();
  const { _splat: streamPath } = Route.useParams();
  const fileMentions = configRepoFileMentionProvider(project.id);
  const agents =
    useLiveState(
      (itx) => itx.agents.liveState,
      (state) => state.agents,
      [],
    ).value ?? {};
  const agentRuntimeTransition = useLiveState(
    (itx) => itx.agents.get(streamPath).liveState,
    (state) => state.runtimeChange,
    [streamPath],
    { slug: project.id },
  ).value;

  // The stream view subscribes live, so a send needs no cache invalidation —
  // the new events arrive over the socket. Agent setup is represented by
  // explicit project and agent facts; sendMessage appends only the user-facing
  // input fact.
  // The socket is keyed by project ID (the provider pre-warmed it), and agents
  // are addressed by their stream path.
  async function submitAgentMessage(message: string) {
    const itx = await connectItx(project.id);
    // Returned so the composer can feed the committed offset into the
    // store's consume-own-append metric (real append→observed latency).
    return await itx.agents.get(streamPath).message(message);
  }

  async function submitAgentFiles({ files, message }: { files: File[]; message: string }) {
    const itx = await connectItx(project.id);
    // One addFiles call → ONE input event carrying every attachment, so the
    // feed shows a single message and the agent gets one turn trigger.
    const { event } = await itx.agents.get(streamPath).addFiles({
      files: await filesToAgentPayload(files),
      ...(message && { message }),
    });
    return event;
  }

  async function interruptAgentMessage() {
    // Cancellation is a property of new input, never a free-standing command:
    // the agent processor settles the open request as cancelled
    // (interrupted-by-user-input) when an interrupting context item lands. A
    // developer item stays out of the chat feed while telling the model why
    // its response stopped; the USER actor is load-bearing — it classifies
    // the stop as an external trigger (a no-actor developer item counts as
    // the agent loop's own feedback, which would not refill the
    // autonomous-turn budget and could trip the loop breaker).
    const itx = await connectItx(project.id);
    await itx.streams.get(streamPath).append({
      type: "events.iterate.com/agents/context-added",
      payload: {
        role: "developer",
        content: "The user interrupted the in-progress response from the web chat.",
        actor: { type: "user", origin: "web" },
        llmRequestPolicy: { behaviour: "interrupt-current-request" },
      },
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Must be a flex column: the stream view sizes itself with flex-1 and
          relies on this parent constraining it — in a block wrapper it grows
          to content height, the feed never scrolls internally, and the
          composer is pushed below the fold. */}
      <div className="flex min-h-0 flex-1 flex-col">
        <ProjectStreamView
          autoFocusMessageComposer
          contextHeader={
            <AgentDetailsSheet
              agents={agents}
              path={streamPath}
              projectId={project.id}
              projectSlug={project.slug}
              runtimeTransition={agentRuntimeTransition}
            />
          }
          emptyLabel={null}
          messageComposer={{
            onInterrupt: interruptAgentMessage,
            onSubmit: submitAgentMessage,
            onSubmitFiles: submitAgentFiles,
            placeholder: "Message this agent",
            suggestionProviders: [fileMentions],
          }}
          projectId={project.id}
          projectSlug={project.slug}
          agentRuntimeTransition={agentRuntimeTransition ?? null}
          streamPath={streamPath}
        />
      </div>
    </div>
  );
}
