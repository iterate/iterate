import {
  DynamicWorkerConfiguredEvent,
  type DynamicWorkerConfig,
  type DynamicWorkerState,
  type Event,
  type JSONObject,
} from "@iterate-com/events-contract";
import { defineBuiltinProcessor, type BuiltinProcessorContext } from "./define-processor.ts";

export type DynamicWorkerAppendInput = {
  type: Event["type"];
  payload?: JSONObject;
  metadata?: JSONObject;
  idempotencyKey?: string;
  offset?: number;
};

const defaultDynamicWorkerCompatibilityDate = "2026-02-05";
const defaultDynamicWorkerCompatibilityFlags = ["rpc_params_dup_stubs"];
const defaultDynamicWorkerMainModule = "dynamic-worker.js";

export const pingPongDynamicWorkerScript = `
import { WorkerEntrypoint } from "cloudflare:workers";

async function* decodeEventStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const newlineIndex = buffer.indexOf("\\n");
        if (newlineIndex === -1) {
          break;
        }

        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (line.length === 0) {
          continue;
        }

        const event = decodeEventLine(line);
        if (event) {
          yield event;
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      const event = decodeEventLine(buffer);
      if (event) {
        yield event;
      }
    }
  } finally {
    if (!finished) {
      await reader.cancel();
    }

    reader.releaseLock();
  }
}

function decodeEventLine(line) {
  try {
    const parsed = JSON.parse(line);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function containsPing(event) {
  return /\\bping\\b/i.test(
    JSON.stringify({
      type: event.type,
      payload: event.payload,
      metadata: event.metadata ?? null,
    }),
  );
}

async function processEvents(stream, subscription) {
  for await (const event of decodeEventStream(subscription)) {
    if (!containsPing(event)) {
      continue;
    }

    await stream.append({ type: "pong" });
  }
}

export default class extends WorkerEntrypoint {
  async run(stream) {
    const subscription = await stream.subscribe();
    await processEvents(stream, subscription);
  }
}
`.trim();

export const dynamicWorkerProcessor = defineBuiltinProcessor<DynamicWorkerState>(() => ({
  slug: "dynamic-worker",
  initialState: { workersBySlug: {} },

  reduce({ event, state }) {
    const configured = DynamicWorkerConfiguredEvent.safeParse(event);
    if (!configured.success) {
      return state;
    }

    const normalizedConfig = normalizeDynamicWorkerConfig(configured.data.payload);

    return {
      workersBySlug: {
        ...state.workersBySlug,
        [configured.data.payload.slug]: normalizedConfig,
      },
    };
  },

  createRuntime(context) {
    return createDynamicWorkerRuntime(context);
  },
}));

export function normalizeDynamicWorkerConfig(input: {
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  mainModule?: string;
  modules?: Record<string, string>;
  script?: string;
}): DynamicWorkerConfig {
  if (input.script != null) {
    return {
      compatibilityDate: input.compatibilityDate ?? defaultDynamicWorkerCompatibilityDate,
      compatibilityFlags: input.compatibilityFlags ?? defaultDynamicWorkerCompatibilityFlags,
      mainModule: input.mainModule ?? defaultDynamicWorkerMainModule,
      modules: {
        [input.mainModule ?? defaultDynamicWorkerMainModule]: input.script,
      },
    };
  }

  return {
    compatibilityDate: input.compatibilityDate ?? defaultDynamicWorkerCompatibilityDate,
    compatibilityFlags: input.compatibilityFlags ?? defaultDynamicWorkerCompatibilityFlags,
    mainModule: input.mainModule ?? defaultDynamicWorkerMainModule,
    modules: input.modules ?? {},
  };
}

function createDynamicWorkerRuntime(context: BuiltinProcessorContext) {
  const runsBySlug = new Map<
    string,
    {
      configKey: string;
      run: Promise<void>;
    }
  >();

  return {
    async afterAppend({ event, state }: { event: Event; state: DynamicWorkerState }) {
      if (DynamicWorkerConfiguredEvent.safeParse(event).success) {
        return;
      }

      for (const [slug, config] of Object.entries(state.workersBySlug)) {
        const existing = runsBySlug.get(slug);
        const configKey = JSON.stringify(config);

        if (existing?.configKey === configKey) {
          continue;
        }

        if (existing != null) {
          console.warn(
            "[stream-do] dynamic worker config changed after startup; keeping existing runtime",
            {
              path: context.getPath(),
              slug,
            },
          );
          continue;
        }

        const entrypoint = context.loader
          .get(`dynamic-worker:${context.getPath()}:${slug}`, () => ({
            compatibilityDate: config.compatibilityDate,
            compatibilityFlags: config.compatibilityFlags,
            mainModule: config.mainModule,
            modules: config.modules,
            globalOutbound: null,
          }))
          .getEntrypoint() as unknown as {
          run(stream: RpcDynamicWorkerTarget): Promise<void>;
        };
        const afterOffset = getInitialAfterOffset({
          event,
          slug,
        });
        const run = entrypoint.run(
          context.createStreamTarget({
            afterOffset: Math.max(0, afterOffset),
          }) as unknown as RpcDynamicWorkerTarget,
        );

        runsBySlug.set(slug, {
          configKey,
          run,
        });
        context.waitUntil(run);

        void run.catch((error) => {
          runsBySlug.delete(slug);
          console.error("[stream-do] dynamic worker failed", {
            path: context.getPath(),
            slug,
            error,
          });
        });
      }
    },
  };
}

function getInitialAfterOffset(args: { event: Event; slug: string }) {
  const configured = DynamicWorkerConfiguredEvent.safeParse(args.event);
  if (configured.success && configured.data.payload.slug === args.slug) {
    return args.event.offset;
  }

  return Math.max(0, args.event.offset - 1);
}

type RpcDynamicWorkerTarget = {
  append(input: DynamicWorkerAppendInput): Promise<Event>;
  subscribe(): Promise<ReadableStream<Uint8Array>>;
};
