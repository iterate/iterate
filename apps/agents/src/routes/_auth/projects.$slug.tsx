import { createFileRoute, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CircleIcon } from "lucide-react";
import { z } from "zod";
import type { AuthenticatedApp } from "iterate/next/app";
import { useIterateContext, useLiveState } from "iterate/next/react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@iterate-com/ui/components/ai-elements/conversation";
import { AppShell } from "@iterate-com/ui/components/app-shell";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@iterate-com/ui/components/breadcrumb";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@iterate-com/ui/components/empty";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { Tabs, TabsList, TabsTrigger } from "@iterate-com/ui/components/tabs";
import { cn } from "@iterate-com/ui/lib/utils";
import type { AgentUiLlmStep } from "@iterate-com/ui/components/events/agent-ui-reducer";
import { ContextView } from "@iterate-com/ui/components/context-view/context-view";
import { AgentFeedItemRow, AgentLiveActivity, type Inspect } from "../../components/agent-feed.tsx";
import { InspectorSheet, type Inspected } from "../../components/agent-inspectors.tsx";
import { LiveStateValue } from "../../components/live-state-value.tsx";
import { agentEventInspectors, agentEventRenderers } from "../../lib/agent-event-renderers.tsx";
import { AgentsNav } from "../../components/agents-nav.tsx";
import { AgentComposer, type StreamInterrupt } from "../../components/composer.tsx";
import { QueuedMessagesPanel } from "../../components/queued-messages.tsx";
import {
  adaptContextRuns,
  reduceAgentFeed,
  toAgentEvent,
  traceOffsetByMessage,
} from "../../lib/agent-events.ts";
import { newWebAgentPath } from "../../lib/web-agent.ts";

// An agent is a conversation on its own path (`/agents/...`); everything it does is an event
// there. This page is a window onto that log — apps/os's agent view at the size os-next carries:
// the CHAT (the shared agent-UI reducer's items: messages, and the activities that open into
// rounds of script + result), the EVENTS (the raw log), and the TRACES (one sheet, URL-backed: an
// LLM request, a script execution, a raw event). The project stub is held for the page's life; the
// agent's context is `project.cd(path)`, subscribed for every committed event and caught up with
// `readEvents`. The header's status is the agent facet's LIVE STATE.
type Project = Awaited<ReturnType<AuthenticatedApp["api"]["projects"]["get"]>>;
type Context = Awaited<ReturnType<Project["cd"]>>;

const AgentList = z.array(z.object({ path: z.string(), createdAt: z.string() }));

/** What the page's subscription receives: every durable event (the Events view is the whole log)
 *  and, named — a wildcard never sweeps an ephemeral — the streamed chunk windows the feed folds
 *  into the answer being written. */
const FEED_SUBSCRIPTION = ["*", "events.iterate.com/agent/llm-response-chunks"];

export const Route = createFileRoute("/_auth/projects/$slug")({
  validateSearch: z.object({
    agent: z.string().optional(),
    view: z.enum(["chat", "events"]).optional(),
    llmRequest: z.number().int().positive().optional(),
    scriptExecution: z.string().optional(),
    event: z.number().int().positive().optional(),
  }),
  loaderDeps: ({ search }) => ({ agent: search.agent }),
  loader: async ({ context, params, deps }) => {
    const projects = await context.api.projects.list();
    // the URL names the project by slug (its id works too); one this sign-in lacks → sign in again
    const project = projects.find((item) => item.slug === params.slug || item.id === params.slug);
    if (!project) return context.signInFor(params.slug);
    using itx = await context.api.projects.get(project.id);
    const agents = AgentList.parse(await itx.invoke(["itx", "agents", ["list"]]));
    return { projects, project, agents, agent: deps.agent || agents[0]?.path };
  },
  component: AgentsPage,
});

function AgentsPage() {
  const data = Route.useLoaderData();
  const { api, info } = Route.useRouteContext();
  const navigate = useNavigate();
  const router = useRouter();
  const href = useRouterState({ select: (state) => state.location.href });
  // the loader sends a sign-in the project is missing from off to sign in again, so it is here
  const project = data.project.id;
  return (
    <AppShell
      app="Agents"
      projects={data.projects}
      activeProjectId={project}
      projectHref={(item) => `/projects/${item.slug}`}
      nav={
        <AgentsNav
          slug={data.project.slug}
          agents={data.agents}
          agent={data.agent}
          onCreate={async () => {
            // an agent is its path; a new one is born at the moment's path, as in apps/os
            const path = newWebAgentPath(new Date());
            using itx = await api.projects.get(project);
            await itx.invoke(["itx", "agents", ["create", path]]);
            await router.invalidate();
            await navigate({
              to: "/projects/$slug",
              params: { slug: data.project.slug },
              search: { agent: path },
            });
          }}
        />
      }
      header={
        data.agent ? (
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem className="hidden md:inline-flex">Agents</BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:inline-flex" />
              <BreadcrumbItem>
                <BreadcrumbPage className="font-mono">{data.agent}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        ) : null
      }
      account={{ email: info.principal.email || info.principal.actor }}
      locationKey={href}
    >
      {data.agent ? (
        <AgentConversation key={`${project}${data.agent}`} project={project} path={data.agent} />
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No agents yet</EmptyTitle>
            <EmptyDescription>Create one in the sidebar, then talk to it here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </AppShell>
  );
}

// ── the agent's log, live ──

/** The agent's context, its log so far, and whether the catch-up read has reached the head. */
/** The agent's context — `project.cd(path)` — held for the page's life: the stub every call
 *  (the composer's `message`, the live states) goes through. Released on unmount AND again after
 *  the connect settles, since an unmount mid-await comes before the handle that await returns. */
function useAgentContext(
  api: AuthenticatedApp["api"],
  project: string,
  path: string,
): { context: Context | undefined; error: string | undefined } {
  const [context, setContext] = useState<Context>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let disposed = false;
    setError(undefined);
    const held: { stub?: Project; agent?: Context } = {};
    const release = () => {
      held.agent?.[Symbol.dispose]();
      held.stub?.[Symbol.dispose]();
      held.agent = held.stub = undefined;
    };
    (async () => {
      held.stub = await api.projects.get(project);
      if (disposed) return;
      const agent = (held.agent = await held.stub.cd(path));
      if (disposed) return;
      // A capnweb stub is a callable proxy: handed to a state setter directly, React would take it
      // for an updater and CALL it (an empty method call the server refuses).
      setContext(() => agent);
    })()
      // the connect itself failing (no such project, no such path, the sign-in gone) is the page's
      // message; what fails after the handle exists is the log hook's
      .catch((e: unknown) => !disposed && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => disposed && release());
    return () => {
      disposed = true;
      release();
      setContext(undefined);
    };
  }, [api, project, path]);
  return { context, error };
}

/** The agent's log, from the SDK's ONE `useIterateContext` over its context (subscribed for every
 *  committed event and the streamed chunk windows, caught up with `readEvents`; the processors
 *  table, who is here, and the live state of `core` and every hosted facet ride the same
 *  subscription), then — for the chat and its traces — as the shared reducer reads it: the wire
 *  envelope tagged with the path, the context's script runs in the reducer's vocabulary
 *  (agent-events.ts). The raw log itself feeds the Events view untouched. */
function useAgentLog(context: Context | undefined, path: string) {
  const iterateContext = useIterateContext(context, { consumes: FEED_SUBSCRIPTION });
  const events = useMemo(
    () =>
      adaptContextRuns(
        iterateContext.events.flatMap((event) => {
          const tagged = toAgentEvent(event, path);
          return tagged ? [tagged] : [];
        }),
      ),
    [iterateContext.events, path],
  );
  return {
    iterateContext,
    events,
    caughtUp: iterateContext.caughtUp,
    error: iterateContext.error || null,
  };
}

/** apps/os's interrupt affordance for the running turn, shared by the composer and the queued
 *  panel. Null while nothing is running, so consumers gate on existence. */
function useAgentInterrupt(args: {
  onInterrupt: (() => Promise<void>) | undefined;
  runningLlmRequestId: number | undefined;
}): StreamInterrupt | null {
  const [isInterrupting, setIsInterrupting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const { onInterrupt, runningLlmRequestId } = args;
  // An interrupt error belongs to the turn it failed against; without this a stale error would
  // resurface on the NEXT turn. State-adjust-during-render per react.dev — no effect.
  const [errorRequestId, setErrorRequestId] = useState(runningLlmRequestId);
  if (errorRequestId !== runningLlmRequestId) {
    setErrorRequestId(runningLlmRequestId);
    setError(undefined);
  }
  if (!onInterrupt || runningLlmRequestId === undefined) return null;
  return {
    isInterrupting,
    error,
    run: async () => {
      if (isInterrupting) return;
      setIsInterrupting(true);
      setError(undefined);
      try {
        await onInterrupt();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setIsInterrupting(false);
      }
    },
  };
}

/** The agent facet's live state, the fields the header reads (src/agent/contract.ts `stateSchema`):
 *  a pause, the one open request, the one pending trigger. A script the agent asked for is the
 *  CONTEXT's obligation, not in this state — the feed's running code step says so. */
const AgentLive = z.object({
  paused: z.object({ reason: z.string() }).nullable(),
  openRequest: z.object({ model: z.string() }).nullable(),
  pendingLlmRequestTrigger: z.object({}).nullable(),
});

function AgentConversation({ project, path }: { project: string; path: string }) {
  const { api } = Route.useRouteContext();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { slug } = Route.useParams();
  const { context, error: connectError } = useAgentContext(api, project, path);
  const { iterateContext, events, caughtUp, error: logError } = useAgentLog(context, path);
  const error = connectError || logError;
  const live = useLiveState<unknown>(context, {
    key: "agent",
    door: async () =>
      z
        .object({ rev: z.number(), state: z.unknown() })
        .parse(await context!.invoke("itx.facets.get('agent').liveSnapshot()")),
  });
  const facet = AgentLive.safeParse(live.value);
  // The turn is over when the facet holds no obligation — a pause included (a paused loop owes no
  // follow-up round). Without live state at all (the read failed), the log alone decides: the
  // reducer settles only once no step is running, and a follow-up round reopens an activity.
  const idle = facet.success
    ? !facet.data.openRequest && !facet.data.pendingLlmRequestTrigger
    : live.status === "error";
  const feed = useMemo(() => reduceAgentFeed(events, idle), [events, idle]);
  // A script still running is the context's, read from the log: the feed's running code step.
  const runningScript =
    feed.state.live?.steps.some((step) => step.kind === "code" && step.status === "running") ??
    false;
  const traceOffsets = useMemo(() => traceOffsetByMessage(events), [events]);
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());
  const onToggle = useCallback(
    (id: string) =>
      setToggled((held) => {
        const next = new Set(held);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [],
  );
  const inspected: Inspected = search.llmRequest
    ? { kind: "llmRequest", llmRequestOffset: search.llmRequest }
    : search.scriptExecution
      ? { kind: "scriptExecution", executionId: search.scriptExecution }
      : search.event
        ? { kind: "event", offset: search.event }
        : null;
  const onInspect = useCallback(
    (next: Inspected) =>
      void navigate({
        to: "/projects/$slug",
        params: { slug },
        search: (prev) => ({
          ...prev,
          llmRequest: next?.kind === "llmRequest" ? next.llmRequestOffset : undefined,
          scriptExecution: next?.kind === "scriptExecution" ? next.executionId : undefined,
          event: next?.kind === "event" ? next.offset : undefined,
        }),
        replace: true,
      }),
    [navigate, slug],
  );
  const inspect = useMemo<Inspect>(
    () => ({
      llmRequest: (llmRequestOffset) => onInspect({ kind: "llmRequest", llmRequestOffset }),
      scriptExecution: (executionId) => onInspect({ kind: "scriptExecution", executionId }),
    }),
    [onInspect],
  );
  const signedUrl = useCallback(
    async (filePath: string) => {
      if (!context) throw new Error("not connected");
      return z
        .object({ url: z.string() })
        .parse(await context.invoke(["itx", "files", ["get", filePath], ["url"]])).url;
    },
    [context],
  );
  const view = search.view || "chat";
  // THE INTERRUPT (apps/os's): cancellation is a property of new input, never a command — a
  // developer item that tells the model why its answer stopped, marked as the person's so it
  // counts as external input; the agent settles the open request as cancelled when it lands.
  const runningLlmRequestId = feed.state.live?.steps.findLast(
    (step): step is AgentUiLlmStep => step.kind === "llm" && step.status === "running",
  )?.llmRequestOffset;
  const interrupt = useAgentInterrupt({
    runningLlmRequestId,
    onInterrupt: context
      ? async () => {
          await context.append({
            type: "events.iterate.com/agent/context-added",
            payload: {
              role: "developer",
              content: "The user interrupted the in-progress response from the web chat.",
              actor: { type: "user" },
              llmRequestPolicy: { behaviour: "interrupt-current-request" },
            },
          });
        }
      : undefined,
  });
  const status = !facet.success
    ? {
        text: live.status === "error" ? "Live state unavailable" : "Connecting…",
        tone: "muted" as const,
      }
    : facet.data.paused
      ? { text: `Paused — ${facet.data.paused.reason}`, tone: "amber" as const }
      : runningScript
        ? {
            text: `Running a script${feed.state.summaryActivity ? ` · ${feed.state.summaryActivity}` : ""}`,
            tone: "live" as const,
          }
        : facet.data.openRequest
          ? { text: `Thinking · ${facet.data.openRequest.model}`, tone: "live" as const }
          : facet.data.pendingLlmRequestTrigger
            ? { text: "About to think", tone: "live" as const }
            : { text: "Idle", tone: "muted" as const };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* the shell's header names the agent; this strip is its live status and the two views */}
      <div className="flex shrink-0 items-center gap-3 px-4 py-1">
        <span
          className="flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground"
          title={live.error}
          data-status={status.tone}
        >
          <CircleIcon
            className={cn(
              "size-2 shrink-0",
              status.tone === "live" && "animate-pulse fill-emerald-500 text-emerald-500",
              status.tone === "amber" && "fill-amber-500 text-amber-500",
              status.tone === "muted" && "fill-muted-foreground/40 text-muted-foreground/40",
            )}
          />
          <span className="truncate">{status.text}</span>
        </span>
        <Tabs
          value={view}
          onValueChange={(value) =>
            void navigate({
              to: "/projects/$slug",
              params: { slug },
              search: (prev) => ({ ...prev, view: value === "chat" ? undefined : "events" }),
              replace: true,
            })
          }
          className="ml-auto"
        >
          <TabsList className="h-8">
            <TabsTrigger value="chat" className="text-xs">
              Chat
            </TabsTrigger>
            <TabsTrigger value="events" className="text-xs">
              Events
              <span className="font-mono text-[10px] text-muted-foreground/70">
                {events.length}
              </span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {error ? <p className="px-4 py-2 text-sm text-destructive">{error}</p> : null}
      {view === "events" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ContextView
            className="mx-auto w-full max-w-3xl px-4 py-2 md:px-6"
            title={<span className="font-mono text-xs">{path}</span>}
            events={iterateContext.events}
            caughtUp={caughtUp}
            error={error || undefined}
            renderers={agentEventRenderers}
            inspectors={agentEventInspectors}
            processors={iterateContext.processors.rows}
            presence={iterateContext.presence}
            renderCoreState={() => <LiveStateValue state={iterateContext.liveState.core} />}
            renderLiveState={(name) => <LiveStateValue state={iterateContext.liveState[name]} />}
            emptyText="Nothing has happened on this agent yet."
          />
        </div>
      ) : (
        <>
          <Conversation className="min-h-0 flex-1">
            <ConversationContent className="mx-auto w-full max-w-3xl gap-0 px-4 py-2 md:px-6">
              {!caughtUp ? (
                <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                  <Spinner className="size-4" /> Reading the log…
                </div>
              ) : feed.items.length === 0 && !feed.state.live ? (
                <Empty className="py-16">
                  <EmptyHeader>
                    <EmptyTitle>Nothing said yet</EmptyTitle>
                    <EmptyDescription>
                      Say something below. The agent answers with prose, or with a script it runs
                      against the project.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : null}
              {feed.items.map((item) => (
                <AgentFeedItemRow
                  key={item.id}
                  item={item}
                  expanded={toggled.has(item.id)}
                  onToggle={onToggle}
                  inspect={inspect}
                  traceOffset={item.kind === "assistant" ? traceOffsets.get(item.id) : undefined}
                  signedUrl={signedUrl}
                />
              ))}
              <AgentLiveActivity
                state={feed.state}
                toggledIds={toggled}
                onToggle={onToggle}
                inspect={inspect}
              />
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>
          <div className="shrink-0 px-4 pb-4 pt-2 md:px-6">
            <div className="mx-auto w-full max-w-3xl">
              {/* Queued input grows the composer column; the feed follows on resize. */}
              <QueuedMessagesPanel
                messages={feed.state.queuedUserMessages}
                isInterrupting={interrupt?.isInterrupting || false}
                onInterrupt={interrupt?.run}
                signedUrl={signedUrl}
              />
              <AgentComposer
                autoFocusMessage
                interrupt={interrupt}
                onSubmit={async ({ message, files }) => {
                  using itx = await api.projects.get(project);
                  await itx.invoke([
                    "itx",
                    "agents",
                    ["get", path],
                    ["message", { message, files }],
                  ]);
                }}
                onAppendRaw={async (events) => {
                  if (!context) throw new Error("not connected");
                  // The raw editor parsed each event with the stream's own input schema; `append` is
                  // typed as the SDK's tuple of inputs, a shape a parsed array cannot spell.
                  await context.append(...(events as Parameters<Context["append"]>));
                }}
              />
            </div>
          </div>
        </>
      )}
      <InspectorSheet
        events={events}
        live={feed.state.live}
        inspected={inspected}
        onInspect={onInspect}
      />
    </div>
  );
}
