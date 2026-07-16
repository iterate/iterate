import type { ProcessorRuntimeState, ProcessorSnapshot, StreamProcessorRpc } from "./rpc-types.ts";

/**
 * One data-only call from an isolate-side processor handle to the Durable
 * Object that owns the processor. The processor slug is explicit because a
 * single host can own several processors (Project owns project/email/slack/
 * telegram); the operation union keeps every response on ordinary Workers
 * RPC serialization instead of returning another live RpcTarget.
 */
export type ProcessorReadRequest =
  | { operation: "getRuntimeState"; processorSlug: string }
  | { operation: "snapshot"; processorSlug: string }
  | {
      operation: "waitUntilProcessed";
      processorSlug: string;
      input: { offset: number; timeoutMs?: number };
    };

/** The data-only processor method exposed by every processor-hosting DO. */
export type ProcessorReadHost = {
  readStreamProcessor(request: ProcessorReadRequest): Promise<unknown>;
};

export async function readProcessorSnapshot<State>(
  host: ProcessorReadHost,
  processorSlug: string,
): Promise<ProcessorSnapshot<State>> {
  return (await host.readStreamProcessor({
    operation: "snapshot",
    processorSlug,
  })) as ProcessorSnapshot<State>;
}

export async function readProcessorRuntimeState<State>(
  host: ProcessorReadHost,
  processorSlug: string,
): Promise<ProcessorRuntimeState<State>> {
  return (await host.readStreamProcessor({
    operation: "getRuntimeState",
    processorSlug,
  })) as ProcessorRuntimeState<State>;
}

export async function waitUntilProcessorOffset(
  host: ProcessorReadHost,
  processorSlug: string,
  input: { offset: number; timeoutMs?: number },
): Promise<void> {
  await host.readStreamProcessor({
    input,
    operation: "waitUntilProcessed",
    processorSlug,
  });
}

/**
 * Serve a direct processor read on its owning Durable Object. Returning a
 * processor RpcTarget from a DO property getter creates a second RPC hop and
 * has produced opaque workerd internal errors during concurrent cold births;
 * this helper keeps the target local and returns only serialized results.
 */
export async function serveProcessorRead<State>(input: {
  expectedProcessorSlug: string;
  processor: StreamProcessorRpc<State>;
  request: ProcessorReadRequest;
}): Promise<unknown> {
  if (input.request.processorSlug !== input.expectedProcessorSlug) {
    throw new Error(
      `processor host does not expose ${JSON.stringify(input.request.processorSlug)}; expected ${JSON.stringify(input.expectedProcessorSlug)}`,
    );
  }

  switch (input.request.operation) {
    case "getRuntimeState":
      return await input.processor.getRuntimeState();
    case "snapshot":
      return await input.processor.snapshot();
    case "waitUntilProcessed":
      return await input.processor.waitUntilProcessed(input.request.input);
  }
}
