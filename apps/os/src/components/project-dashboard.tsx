import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useLiveState } from "iterate/sdk/itx/react";
import { ArrowRightIcon } from "lucide-react";
import { buttonVariants } from "@iterate-com/ui/components/button";
import { NewAgentComposer } from "~/components/new-agent-composer.tsx";
import {
  AGENT_DISPLAY_STATE_PRESENTATION,
  bindingIcon,
} from "~/components/agents/agent-presentation.ts";
import { agentTitle } from "~/components/agents/agent-tree.ts";
import {
  RECENTLY_ACTIVE_AGENTS_LIMIT,
  selectRecentlyActiveAgents,
} from "~/components/agents/recent-agents.ts";
import { deriveAgentDisplayState, type AgentRecord } from "~/domains/agents/agent-presence.ts";
import { formatTimeAgo } from "~/lib/format-relative-time.ts";
import { ONBOARDING_AGENT_PATH } from "~/lib/onboarding-agent.ts";
import { useTickingNowMs } from "~/lib/use-ticking-now-ms.ts";

const CLOCK_TICK_MS = 15_000;

/**
 * Project home for ready projects: start a new thread, continue from a few
 * recent agents. Keeps copy short on purpose.
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
    () =>
      agentsState === undefined
        ? []
        : selectRecentlyActiveAgents(agentsState, RECENTLY_ACTIVE_AGENTS_LIMIT),
    [agentsState],
  );
  const nowMs = useTickingNowMs(CLOCK_TICK_MS);
  const agentsLoading = agentsState === undefined;

  return (
    <main
      className="flex min-h-full flex-1 flex-col px-4 py-8 sm:px-6 sm:py-10"
      data-testid="project-dashboard"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-10">
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

        <section className="flex flex-col gap-4" aria-labelledby="start-thread-heading">
          <div className="space-y-1">
            <h1
              id="start-thread-heading"
              className="text-2xl font-semibold tracking-tight sm:text-3xl"
            >
              Start a new thread
            </h1>
            <p className="text-sm text-muted-foreground">Say what you need. We’ll open an agent.</p>
          </div>
          <NewAgentComposer projectId={projectId} projectSlug={projectSlug} />
        </section>

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
            <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
              No agents yet — start one above.
            </p>
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
