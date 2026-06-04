// Implements the built-in "core" processor.
// The Stream Durable Object runs this processor inline during append instead
// of through a subscription runner, because stream bookkeeping must be updated
// before committed events are delivered to subscribers.

import type { StreamEventInput } from "../../shared/event.ts";
import { implementBuiltinProcessor } from "../../processor.ts";
import { coreProcessorContract, type CoreProcessorState } from "./contract.ts";

export const coreProcessor = implementBuiltinProcessor(
  coreProcessorContract,
  (deps: { propagateChildStreamCreated: (state: CoreProcessorState) => void }) => ({
    beforeAppend({ event, state }) {
      assertStreamAppendAllowed({ event, state });
    },
    afterAppend({ event, state }) {
      if (event.type !== "events.iterate.com/stream/created") return;
      deps.propagateChildStreamCreated(state);
    },
  }),
);

export function assertStreamAppendAllowed(args: {
  event: StreamEventInput;
  state: { paused: boolean; pauseReason: string | null };
}) {
  if (!args.state.paused) return;
  if (canAppendWhilePaused(args.event)) return;
  throw new Error(`stream paused: ${args.state.pauseReason ?? "circuit breaker open"}`);
}

function canAppendWhilePaused(event: StreamEventInput) {
  return (
    event.type === "events.iterate.com/stream/resumed" ||
    event.type === "events.iterate.com/stream/error-occurred" ||
    event.type === "events.iterate.com/stream/woken"
  );
}

export function getAncestorStreamPaths(path: string): string[] {
  if (path === "/") return [];
  const segments = path.split("/").filter(Boolean);
  const ancestors = ["/"];
  for (let index = 1; index < segments.length; index += 1) {
    ancestors.push(`/${segments.slice(0, index).join("/")}`);
  }
  return ancestors;
}
