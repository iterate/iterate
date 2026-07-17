import type { StreamEvent } from "../itx-api.generated.ts";
import type { Itx } from "../itx/itx-react.ts";

const EVENT_PAGE_SIZE = 500;

/**
 * Read the durable history that seeds the terminal feed's TanStack query.
 * All live events arrive through the ordered subscription opened after this
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
