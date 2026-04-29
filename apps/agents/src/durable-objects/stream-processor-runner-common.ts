import type { ProcessorStreamApi } from "@iterate-com/shared/stream-processors";

/**
 * Creates the scoped stream API WorkerEntrypoint that processor implementations use.
 *
 * The Durable Object runner binds this to its immutable stream path from
 * lifecycle init params. Processor implementations receive only the scoped API,
 * not Cloudflare storage, Durable Object state, or raw events service bindings.
 */
export function createStreamProcessorApi<Contract>(args: {
  ctx: DurableObjectState;
  streamPath: string;
}): ProcessorStreamApi<Contract> {
  const ctx = args.ctx as DurableObjectState & {
    exports: {
      StreamApi(args: { props: { streamPath: string } }): unknown;
    };
  };

  return ctx.exports.StreamApi({
    props: { streamPath: args.streamPath },
  }) as unknown as ProcessorStreamApi<Contract>;
}

export function streamProcessorWebSocketMessageToString(
  message: string | ArrayBuffer,
): string | null {
  if (typeof message === "string") return message;
  return new TextDecoder().decode(message);
}
