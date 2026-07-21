import type { StreamEvent } from "../itx-api.generated.ts";
import type { Itx } from "../sdk/itx/react.ts";

const EVENT_PAGE_SIZE = 500;

type AgentReadinessHandle = {
  create(): PromiseLike<unknown>;
  processor: {
    snapshot(): PromiseLike<{ state: { birthCertificate: unknown | null } }>;
  };
};

/** Birth a fresh generic agent before its history becomes the feed's durable seed. */
export async function ensureAgentFeedReady(agent: AgentReadinessHandle): Promise<void> {
  const snapshot = await agent.processor.snapshot();
  if (snapshot.state.birthCertificate === null) await agent.create();
}

/**
 * Read the durable history that seeds the terminal feed's TanStack query.
 * All live events arrive through the ordered subscription opened after this
 * read; its replay cursor closes the durable race between the two operations.
 */
export async function readAgentFeedHistory(
  itx: Itx,
  agentPath: string,
  options: {
    initialize?: (agent: ReturnType<Itx["agents"]["get"]>) => Promise<void>;
  } = {},
): Promise<StreamEvent[]> {
  const agent = itx.agents.get(agentPath);
  const events: StreamEvent[] = [];
  let afterOffset = 0;

  try {
    await options.initialize?.(agent);
    for (;;) {
      const page = await agent.stream.getEvents({ afterOffset, limit: EVENT_PAGE_SIZE });
      events.push(...page);
      if (page.length < EVENT_PAGE_SIZE) return events;

      const nextOffset = page.at(-1)!.offset;
      if (nextOffset <= afterOffset) {
        throw new Error(
          `Agent feed history did not advance beyond offset ${afterOffset} for ${agentPath}.`,
        );
      }
      afterOffset = nextOffset;
    }
  } finally {
    (agent as Partial<Disposable>)[Symbol.dispose]?.();
  }
}
