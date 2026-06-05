// Implements the "echo-example" processor.
// It appends an output for every input and is intentionally tiny so runtime
// tests can focus on subscription/runner behavior instead of business logic.

import { implementProcessor } from "../../../processor.ts";
import { standardProcessorBehavior } from "../../standard-processor-behavior.ts";
import { echoExampleProcessorContract } from "./contract.ts";

export const echoExampleProcessor = implementProcessor(echoExampleProcessorContract, () => ({
  afterAppend({ event, state, stream, shouldApplySideEffects, keepAlive }) {
    if (!shouldApplySideEffects({ event })) return;

    standardProcessorBehavior.afterAppend({
      state,
      stream,
      keepAlive,
      contract: echoExampleProcessorContract,
    });

    if (event.type !== "events.iterate.com/echo-example/input-received") return;
    keepAlive(
      stream.append({
        event: {
          type: "events.iterate.com/echo-example/output-echoed",
          payload: { seen: state.seen },
        },
      }),
    );
  },
}));
