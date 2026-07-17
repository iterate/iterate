import type { StreamEvent } from "../itx-api.generated.ts";
import type { Itx } from "../itx/itx-react.ts";

const EVENT_PAGE_SIZE = 500;

/**
 * Fold subscription or mutation results into the durable Query cache.
 * Ephemeral rows belong only to the live model; durable offsets are unique,
 * and sorting closes the harmless mutation-return vs subscription race.
 */
export function mergeAgentFeedHistory(
  current: StreamEvent[],
  incoming: readonly StreamEvent[],
): StreamEvent[] {
  const knownOffsets = new Set(current.map((event) => event.offset));
  const added: StreamEvent[] = [];
  for (const event of incoming) {
    if (event.ephemeral === true || knownOffsets.has(event.offset)) continue;
    knownOffsets.add(event.offset);
    added.push(event);
  }
  if (added.length === 0) return current;
  return [...current, ...added].sort((left, right) => left.offset - right.offset);
}

/**
 * Read the durable history that seeds the terminal feed's TanStack query.
 * Live and ephemeral events arrive through the subscription opened after this
 * read; its replay cursor closes the durable race between the two operations.
 */
export async function readAgentFeedHistory(itx: Itx, agentPath: string): Promise<StreamEvent[]> {
  const agent = itx.agents.get(agentPath);
  const events: StreamEvent[] = [];
  let afterOffset = 0;

  try {
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
