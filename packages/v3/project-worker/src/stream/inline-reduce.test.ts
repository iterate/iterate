// stream/inline-reduce.test.ts — the inline host takes the SAME `StreamProcessor` class a facet does,
// and enforces the one rule that hosting at the commit point implies: only `reduce` ever runs there,
// so a processor that overrides `processEvent` is refused at construction (its effects would silently
// never run). The rest of the inline engine is pinned against real storage in
// __workers-tests__/stream.test.ts; this file is about the author-class contract.
import { expect, test } from "vitest";
import type { StreamEvent } from "./events.ts";
import { InlineReduce } from "./inline-reduce.ts";
import { StreamProcessor, type ProcessEventArgs, type ReduceArgs } from "./processor.ts";
import { memoryStorage } from "./test-support.ts";

const contract = (slug: string) => ({
  slug,
  version: "1",
  consumes: ["tick"],
  emits: [],
  initialState: () => ({ n: 0 }),
});

class TicksProcessor extends StreamProcessor<{ n: number }> {
  readonly contract = contract("ticks");
  override reduce({ state }: ReduceArgs<{ n: number }>) {
    return { n: state.n + 1 };
  }
}

class TicksWithEffectsProcessor extends StreamProcessor<{ n: number }> {
  readonly contract = contract("ticks-fx");
  override reduce({ state }: ReduceArgs<{ n: number }>) {
    return { n: state.n + 1 };
  }
  override processEvent(_args: ProcessEventArgs<{ n: number }>): undefined {}
}

function inlineHost(proc: StreamProcessor<any>) {
  const log: StreamEvent[] = [];
  // the DURABLE MARK the host hands the reduces — set after a commit, the way Stream's txn tail does
  const durable = { mark: 0 };
  const event = (offset: number, ephemeral?: true): StreamEvent => ({
    type: "tick",
    offset,
    createdAt: new Date(0).toISOString(),
    path: "/",
    ...(ephemeral && { ephemeral }),
  });
  const reduces = new InlineReduce(proc, {
    kv: memoryStorage(),
    read: (after, limit) => {
      const page = log.filter((e) => e.offset > after).slice(0, limit);
      return { events: page, scannedThroughOffset: page.at(-1)?.offset ?? after };
    },
    head: () => durable.mark,
    sink: { append: () => undefined },
  });
  return { reduces, log, event, durable };
}

test("a reduce-only StreamProcessor hosts INLINE: durables fold at commit, ephemerals never do", () => {
  const { reduces, log, event, durable } = inlineHost(new TicksProcessor());
  // a commit of two durables and one ephemeral, offsets 1..3, after the empty log
  const batch = [event(1), event(2, true), event(3)];
  log.push(batch[0], batch[2]);
  reduces.reduceAtCommit(batch, 0, 3);
  durable.mark = 3;
  expect(reduces.entry()).toEqual({ state: { n: 2 }, throughOffset: 3 });
});

test("a processor that overrides processEvent is REFUSED at construction — effects cannot run at the commit point", () => {
  expect(() => inlineHost(new TicksWithEffectsProcessor())).toThrow(
    /overrides processEvent.*host it as a facet/,
  );
});
