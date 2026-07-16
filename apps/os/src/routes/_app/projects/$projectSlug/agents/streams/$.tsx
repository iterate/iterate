import { useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ItxBoundary } from "~/components/itx-boundary.tsx";
import { ONBOARDING_AGENT_PATH } from "~/lib/onboarding-agent.ts";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import { connectItxBrowser } from "~/itx/itx-react.tsx";
import {
  breadcrumbLoaderData,
  streamBreadcrumb,
  streamPageStaticData,
} from "~/lib/route-breadcrumbs.ts";
import { streamPathFromSplat, streamPathToSplat } from "~/lib/stream-links.ts";
import { StreamViewSearch } from "~/lib/stream-view-search.ts";

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

  // THE onboarding-agent birth: the agent is deliberately not born during
  // project bootstrap (it costs a real LLM turn), so opening its chat is what
  // births it. configure({}) is the idempotent birth-with-defaults door — on a
  // fresh path it establishes the full default policy (prompt, model, the
  // "Start onboarding now" kickoff) in the SAME append that creates the
  // stream, so there is no stock-defaults window; on an already-born agent
  // every keyed event dedupes away. Retries cover the create-flow window where
  // the itx session's claims may still be catching up.
  useEffect(() => {
    if (streamPath !== ONBOARDING_AGENT_PATH) return;
    let cancelled = false;
    void (async () => {
      for (let attempt = 0; attempt < 3 && !cancelled; attempt++) {
        try {
          const itx = await connectItxBrowser({ projectId: project.id });
          await itx.agents.get(ONBOARDING_AGENT_PATH).configure({});
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 2_000 * (attempt + 1)));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project.id, streamPath]);
  // The stream view subscribes live, so a send needs no cache invalidation —
  // the new events arrive over the socket. Agent setup is owned by project and
  // agent processor facts; sendMessage only appends the user-facing input fact.
  // The socket is keyed by project ID (the provider pre-warmed it), and agents
  // are addressed by their stream path (e.g. "/agents/onboarding").
  async function submitAgentMessage(message: string) {
    const itx = await connectItxBrowser({ projectId: project.id });
    // Returned so the composer can feed the committed offset into the
    // store's consume-own-append metric (real append→observed latency).
    return await itx.agents.get(streamPath).message(message);
  }

  async function submitAgentFiles({ files, message }: { files: File[]; message: string }) {
    const itx = await connectItxBrowser({ projectId: project.id });
    // One addFiles call → ONE input event carrying every attachment, so the
    // feed shows a single message and the agent gets one turn trigger.
    const { event } = await itx.agents.get(streamPath).addFiles({
      files: await Promise.all(
        files.map(async (file) => ({
          contentType: file.type || "application/octet-stream",
          data: new Uint8Array(await file.arrayBuffer()),
          filename: file.name,
        })),
      ),
      ...(message ? { message } : {}),
    });
    return event;
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
      {/* Must be a flex column: the stream view sizes itself with flex-1 and
          relies on this parent constraining it — in a block wrapper it grows
          to content height, the feed never scrolls internally, and the
          composer is pushed below the fold. */}
      <div className="flex min-h-0 flex-1 flex-col">
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
