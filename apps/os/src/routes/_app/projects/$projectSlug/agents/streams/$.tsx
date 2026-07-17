import { useCallback, useEffect, useRef } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "@iterate-com/ui/components/sonner";
import { connectItx, useLiveState } from "iterate/react";
import { AgentDetailHeader } from "~/components/agents/agent-detail-header.tsx";
import { ONBOARDING_AGENT_PATH, onboardingAgentCreateInput } from "~/lib/onboarding-agent.ts";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
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
  component: ProjectAgentDetailContent,
});

function ProjectAgentDetailContent() {
  const { project } = Route.useLoaderData();
  const { _splat: streamPath } = Route.useParams();
  const onboardingBirthRef = useRef<{ key: string; promise: Promise<void> } | null>(null);
  const agents =
    useLiveState(
      (itx) => itx.liveState,
      (state) => state.agents,
      [],
    ).value ?? {};

  // THE onboarding-agent birth: the agent is deliberately not born during
  // project bootstrap (it costs a real LLM turn), so opening its chat is what
  // births it. The onboarding prompt and kickoff are explicit here rather
  // than inferred from the stream path. One shared promise closes the race
  // between this eager birth and a user sending immediately; retries cover
  // the create-flow window where the itx session's claims may still be
  // catching up.
  const ensureOnboardingAgent = useCallback((): Promise<void> => {
    if (streamPath !== ONBOARDING_AGENT_PATH) return Promise.resolve();

    const key = `${project.id}:${streamPath}`;
    if (onboardingBirthRef.current?.key === key) {
      return onboardingBirthRef.current.promise;
    }

    const promise = (async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const itx = await connectItx(project.id);
          const agent = itx.agents.get(ONBOARDING_AGENT_PATH);
          const snapshot = await agent.processor.snapshot();
          if (snapshot.state.birthCertificate === null) {
            await agent.create(onboardingAgentCreateInput(project.id));
          }
          return;
        } catch (error) {
          lastError = error;
          if (attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 2_000 * (attempt + 1)));
          }
        }
      }
      throw new Error("Could not create the onboarding agent.", { cause: lastError });
    })();

    onboardingBirthRef.current = { key, promise };
    void promise.catch(() => {
      if (onboardingBirthRef.current?.promise === promise) {
        onboardingBirthRef.current = null;
      }
    });
    return promise;
  }, [project.id, streamPath]);

  useEffect(() => {
    let active = true;
    void ensureOnboardingAgent().catch((error: unknown) => {
      if (active) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    });
    return () => {
      active = false;
    };
  }, [ensureOnboardingAgent]);
  // The stream view subscribes live, so a send needs no cache invalidation —
  // the new events arrive over the socket. Agent setup is owned by project and
  // agent processor facts; sendMessage only appends the user-facing input fact.
  // The socket is keyed by project ID (the provider pre-warmed it), and agents
  // are addressed by their stream path (e.g. "/agents/onboarding").
  async function submitAgentMessage(message: string) {
    await ensureOnboardingAgent();
    const itx = await connectItx(project.id);
    // Returned so the composer can feed the committed offset into the
    // store's consume-own-append metric (real append→observed latency).
    return await itx.agents.get(streamPath).message(message);
  }

  async function submitAgentFiles({ files, message }: { files: File[]; message: string }) {
    await ensureOnboardingAgent();
    const itx = await connectItx(project.id);
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
    const itx = await connectItx(project.id);
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
          contextHeader={
            <AgentDetailHeader
              agents={agents}
              path={streamPath}
              projectId={project.id}
              projectSlug={project.slug}
            />
          }
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
