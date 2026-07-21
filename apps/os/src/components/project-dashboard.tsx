import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useLiveState } from "iterate/sdk/itx/react";
import { ArrowRightIcon } from "lucide-react";
import { buttonVariants } from "@iterate-com/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@iterate-com/ui/components/empty";
import { NewAgentComposer } from "~/components/new-agent-composer.tsx";
import {
  AGENT_DISPLAY_STATE_PRESENTATION,
  bindingIcon,
} from "~/components/agents/agent-presentation.ts";
import { agentTitle } from "~/components/agents/agent-tree.ts";
import { selectRecentlyActiveAgents } from "~/components/agents/recent-agents.ts";
import { deriveAgentDisplayState, type AgentRecord } from "~/domains/agents/agent-presence.ts";
import { formatTimeAgo } from "~/lib/format-relative-time.ts";
import { ONBOARDING_AGENT_PATH } from "~/lib/onboarding-agent.ts";
import { useTickingNowMs } from "~/lib/use-ticking-now-ms.ts";

const CLOCK_TICK_MS = 15_000;

/**
 * Project home for ready projects: start a new thread, continue from a few
 * recent agents. No page title — the shell breadcrumb carries context, the
 * composer placeholder says what to do.
 */
export function ProjectDashboard({
  projectId,
  projectSlug,
  showContinueOnboarding = false,
}: {
  projectId: string;
  projectSlug: string;
  showContinueOnboarding?: boolean;
}) {
  const agentsState = useLiveState(
    (itx) => itx.agents.liveState,
    (state) => state.agents,
    [projectId],
    { slug: projectId },
  ).value;
  const recent = useMemo(
    () => (agentsState === undefined ? [] : selectRecentlyActiveAgents(agentsState)),
    [agentsState],
  );
  const nowMs = useTickingNowMs(CLOCK_TICK_MS);
  const agentsLoading = agentsState === undefined;

  return (
    <main className="flex min-h-full flex-1 flex-col p-4 md:p-8" data-testid="project-dashboard">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 pt-4 md:pt-8">
        {showContinueOnboarding ? (
          <Link
            to="/projects/$projectSlug/agents/streams/$"
            params={{ projectSlug, _splat: ONBOARDING_AGENT_PATH }}
            search={{}}
            className={buttonVariants({ size: "lg", className: "w-full sm:w-auto sm:self-start" })}
          >
            Continue onboarding
            <ArrowRightIcon data-icon="inline-end" aria-hidden="true" />
          </Link>
        ) : null}

        <NewAgentComposer projectId={projectId} projectSlug={projectSlug} />

        <section className="flex flex-col gap-3" aria-labelledby="recent-agents-heading">
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="recent-agents-heading" className="text-base font-medium tracking-tight">
              Recently Active Agents
            </h2>
            <Link
              to="/projects/$projectSlug/agents"
              params={{ projectSlug }}
              search={{}}
              className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              See all
            </Link>
          </div>

          {agentsLoading ? (
            <p className="py-6 text-sm text-muted-foreground">Loading agents…</p>
          ) : recent.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No agents yet</EmptyTitle>
                <EmptyDescription>Message a new agent above to start one.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2" data-testid="recent-agents-list">
              {recent.map((agent) => (
                <li key={agent.path}>
                  <RecentAgentCard agent={agent} nowMs={nowMs} projectSlug={projectSlug} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

function RecentAgentCard({
  agent,
  nowMs,
  projectSlug,
}: {
  agent: AgentRecord;
  nowMs: number;
  projectSlug: string;
}) {
  const displayState = deriveAgentDisplayState(agent.runtime, agent.summary.waitingFor);
  const state = AGENT_DISPLAY_STATE_PRESENTATION[displayState];
  const BindingIcon = bindingIcon(agent.binding);

  return (
    <Link
      to="/projects/$projectSlug/agents/streams/$"
      params={{ projectSlug, _splat: agent.path }}
      search={{}}
      className="group flex gap-3 rounded-xl border bg-background px-3.5 py-3 transition-colors hover:bg-accent/40"
      data-agent-path={agent.path}
      data-testid="recent-agent-card"
    >
      <BindingIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{agentTitle(agent)}</span>
          <span
            className={`size-1.5 shrink-0 rounded-full ${state.dot}`}
            title={state.label}
            aria-hidden
          />
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {agent.summary.activity ? (
            <span className="min-w-0 truncate">{agent.summary.activity}</span>
          ) : (
            <span className="truncate">{state.label}</span>
          )}
          <span aria-hidden>·</span>
          <time
            dateTime={agent.timestamps.lastWorkAt}
            title={agent.timestamps.lastWorkAt}
            className="shrink-0 tabular-nums"
          >
            {formatTimeAgo(agent.timestamps.lastWorkAt, nowMs)}
          </time>
        </span>
      </span>
    </Link>
  );
}
