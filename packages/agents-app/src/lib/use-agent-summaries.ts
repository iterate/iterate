// The sidebar's live read of every agent: each agent's facet live state (the `agent` key on its own
// context), subscribed once per path and reduced to its summary (agent-summary.ts) as each delta
// lands — pushed, never polled. One project stub for the set; a changed set of paths reconnects
// the set and keeps the summaries it had meanwhile, so the order does not flicker on a new agent.
import { useEffect, useState } from "react";
import { z } from "zod";
import type { AuthenticatedApp } from "iterate/app";
import { connectLiveState } from "iterate/client";
import { summarizeAgentState, type AgentSummary } from "./agent-summary.ts";

/** What the sidebar knows of one agent's live state: its summary, or why there is none — the
 *  subscription failed, or the facet's state is not an agent's (a context whose `agent` row
 *  another app owns). Absent while connecting. */
export type AgentLiveSummary =
  | { kind: "live"; summary: AgentSummary }
  | { kind: "unavailable"; reason: string };

const Seed = z.object({ rev: z.number(), state: z.unknown() });

export function useAgentSummaries(
  api: AuthenticatedApp["api"],
  project: string,
  paths: readonly string[],
): Readonly<Record<string, AgentLiveSummary>> {
  const key = JSON.stringify(paths.toSorted());
  const [held, setHeld] = useState<{
    project: string;
    summaries: Record<string, AgentLiveSummary>;
  }>();
  useEffect(() => {
    const wanted = JSON.parse(key) as string[];
    // a new set of the same project keeps what it knew until the fresh subscriptions seed
    setHeld((previous) => (previous?.project === project ? previous : { project, summaries: {} }));
    if (wanted.length === 0) return;
    let disposed = false;
    const unmounted = new AbortController();
    const releases: (() => unknown)[] = [];
    // Last acquired, first released; each at most once (the cleanup and a connect still in flight
    // at unmount both reach here).
    const releaseAll = () => {
      for (const release of releases.splice(0).reverse()) void release();
    };
    const record = (path: string, entry: AgentLiveSummary) =>
      setHeld((previous) =>
        disposed || previous?.project !== project
          ? previous
          : { project, summaries: { ...previous.summaries, [path]: entry } },
      );
    (async () => {
      const stub = await api.projects.get(project);
      releases.push(() => stub[Symbol.dispose]());
      if (disposed) return;
      await Promise.all(
        wanted.map(async (path) => {
          try {
            const context = await stub.cd(path);
            releases.push(() => context[Symbol.dispose]());
            if (disposed) return;
            const connection = await connectLiveState<unknown>(context, {
              key: "agent",
              readSeed: async () =>
                Seed.parse(await context.invoke("itx.facets.get('agent').liveSnapshot()")),
              signal: unmounted.signal,
              // a failed gap heal keeps the last summary; the next delta retries the heal
            });
            releases.push(() => connection.dispose());
            if (disposed) return;
            const publish = () => {
              const summary = summarizeAgentState(connection.store.get());
              record(
                path,
                summary
                  ? { kind: "live", summary }
                  : { kind: "unavailable", reason: "its live state is not an agent's" },
              );
            };
            releases.push(connection.store.subscribe(publish));
            publish();
          } catch (error) {
            // one agent's failure is its own row's, never the list's
            record(path, {
              kind: "unavailable",
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }),
      );
    })()
      .catch((error: unknown) => {
        for (const path of wanted)
          record(path, {
            kind: "unavailable",
            reason: error instanceof Error ? error.message : String(error),
          });
      })
      .finally(() => disposed && releaseAll());
    return () => {
      disposed = true;
      unmounted.abort();
      releaseAll();
    };
  }, [api, project, key]);
  return held?.project === project ? held.summaries : {};
}
