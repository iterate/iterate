// REPRO (review verification, delete after): contexts.get(own path) resets the resolve depth
// to 0 on every hop, so a self-referential mount routed through `itx.contexts` never trips the
// depth-32 guard — it spins forever. This test mirrors the PRODUCTION wiring exactly:
//   • roots-builder.ts line 219: `sibling.invoke(["itx", ...])` — NO depth argument;
//   • stream-durable-object.ts line 745 / processor-facet.ts line 174: `invoke(call, depth = 0)`.
import { expect, test } from "vitest";
import { parse, parseCapabilityPath, pathProxy, type Expression } from "./core/expression.ts";
import { CapabilityTableProcessor } from "./capability-table-processor.ts";
import { type ProcessorStream } from "./core/processor.ts";
import { type StreamEvent, type StreamEventInput } from "./core/events.ts";

function memoryStream(path = "/") {
  const events: StreamEvent[] = [];
  const stream: ProcessorStream = {
    append: (...inputs: StreamEventInput[]) =>
      inputs.map((input) => {
        const event: StreamEvent = {
          ...input,
          offset: events.length + 1,
          createdAt: new Date(0).toISOString(),
          path,
        };
        events.push(event);
        return event;
      }),
    read: (afterOffset = 0, limit = 500) => {
      const page = events.filter((e) => e.offset > afterOffset).slice(0, limit);
      return Promise.resolve({
        events: page,
        scannedThroughOffset:
          page.length === limit
            ? page[page.length - 1].offset
            : Math.max(afterOffset, events.length),
      });
    },
  };
  return { stream, events };
}

test("contexts.get(own path) resets depth — the guard never fires (loop repro)", async () => {
  const { stream, events } = memoryStream();
  let hops = 0;

  // The parent-DO stub as the facet's `deps.context(p)` hands it back: invoke(call, depth = 0).
  const parentStub = {
    invoke: (call: Expression, depth = 0) => {
      hops++;
      if (hops > 200) throw new Error(`LOOP: ${hops} cross-context hops, depth guard never fired`);
      return host.resolveCurrent(call, depth);
    },
  };

  // VERBATIM shape of roots-builder.ts `contexts` root (lines 206-221), minus append/read.
  const builtIns = {
    contexts: {
      get: (_siblingPath: string) =>
        pathProxy((segments, args) => {
          const last = segments[segments.length - 1] as string;
          return parentStub.invoke([
            "itx",
            ...segments.slice(0, -1),
            [last, ...args],
          ] as Expression);
        }),
    },
  };

  const host = new CapabilityTableProcessor({
    stream,
    builtIns: builtIns as unknown as Record<string, unknown>,
    configMounts: [{ path: parseCapabilityPath("itx.contexts"), target: parse("contexts") }],
  });
  const reduceAll = () =>
    events.reduce(
      (st: ReturnType<typeof host.contract.initialState>, e: StreamEvent) =>
        host.reduce({ event: e, state: st }) ?? st,
      host.contract.initialState(),
    );
  host.resolveCurrent = async (call: Expression, depth = 0) =>
    host.resolve(reduceAll(), call, undefined, depth);

  // The one-character topology typo from the claim: own path instead of a sibling's.
  await host.provide({ path: "itx.a", target: "itx.contexts.get('/').a" });

  // If the depth guard worked across the hop this rejects with /depth 32/; instead it loops
  // until the tripwire (200 hops) fires.
  await expect(host.resolveCurrent(parse("itx.a.go()"))).rejects.toThrow(/LOOP: 201/);
}, 30_000);
