import {
  DynamicWorkerConfiguredEvent,
  type DynamicWorkerConfig,
  type DynamicWorkerOutboundGateway,
  type DynamicWorkerState,
  type Event,
  type JSONObject,
} from "@iterate-com/events-contract";
import {
  defineBuiltinProcessor,
  type BuiltinProcessorContext,
} from "./define-builtin-processor.ts";

export type DynamicWorkerAppendInput = {
  type: Event["type"];
  payload?: JSONObject;
  metadata?: JSONObject;
  idempotencyKey?: string;
  offset?: number;
};

const defaultDynamicWorkerCompatibilityDate = "2026-02-05";
const defaultDynamicWorkerCompatibilityFlags: string[] = [];
const defaultDynamicWorkerMainModule = "worker.js";
const defaultDynamicWorkerProcessorModule = "processor.js";
const defaultDynamicWorkerRuntimeConfigModule = "runtime-config.js";

export const pingPongDynamicWorkerScript = `
function containsPing(event) {
  if (event.type === "https://events.iterate.com/events/stream/dynamic-worker/configured") {
    return false;
  }

  return /\\bping\\b/i.test(
    JSON.stringify({
      type: event.type,
      payload: event.payload,
      metadata: event.metadata ?? null,
    }),
  );
}

export default {
  initialState: {},

  reduce(state) {
    return state;
  },

  async onEvent({ append, event }) {
    if (!containsPing(event)) {
      return;
    }

    await append({ type: "pong" });
  },
};
`.trim();

export const httpbinEchoDynamicWorkerScript = `
function containsPing(event) {
  if (event.type === "https://events.iterate.com/events/stream/dynamic-worker/configured") {
    return false;
  }

  return /\\bping\\b/i.test(
    JSON.stringify({
      type: event.type,
      payload: event.payload,
      metadata: event.metadata ?? null,
    }),
  );
}

function normalizeHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers ?? {}).map(([key, value]) => [String(key).toLowerCase(), value]),
  );
}

export default {
  initialState: {},

  reduce(state) {
    return state;
  },

  async onEvent({ append, event }) {
    if (!containsPing(event)) {
      return;
    }

    const response = await fetch("https://httpbin.org/headers");
    const responseJson = await response.json();

    await append({
      type: "https://events.iterate.com/events/example/httpbin-echoed",
      payload: {
        ok: response.ok,
        status: response.status,
        normalizedHeaders: normalizeHeaders(responseJson.headers),
        response: responseJson,
      },
    });
  },
};
`.trim();

const dynamicWorkerRuntimeModule = `
import processor from "./processor.js";
import runtimeConfig from "./runtime-config.js";

void runtimeConfig;

function createRemoteAsyncIterator(target) {
  return {
    [Symbol.asyncIterator]() {
      return this;
    },

    async next() {
      return target.next();
    },

    async return() {
      return target.return();
    },
  };
}

async function replayProcessorState(stream, processor) {
  let state = structuredClone(processor.initialState);
  let lastOffset = 0;
  const history = await stream.history({ afterOffset: 0 });

  for (const event of history) {
    lastOffset = event.offset;
    state = processor.reduce(structuredClone(state), event) ?? state;
  }

  return { lastOffset, state };
}

export default {
  async run(stream) {
    let { lastOffset, state } = await replayProcessorState(stream, processor);
    const live = createRemoteAsyncIterator(await stream.subscribe({ afterOffset: lastOffset }));

    for await (const event of live) {
      if (event.offset === lastOffset) {
        continue;
      }

      const prevState = state;
      state = processor.reduce(structuredClone(state), event) ?? state;

      await processor.onEvent?.({
        append: (nextEvent) => stream.append(nextEvent),
        event,
        state,
        prevState,
      });

      lastOffset = event.offset;
    }
  },
};
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
  modules?: Record<string, string>;
  outboundGateway?: DynamicWorkerOutboundGateway;
  script?: string;
}): DynamicWorkerConfig {
  if (input.script != null) {
    return {
      compatibilityDate: input.compatibilityDate ?? defaultDynamicWorkerCompatibilityDate,
      compatibilityFlags: input.compatibilityFlags ?? defaultDynamicWorkerCompatibilityFlags,
      mainModule: defaultDynamicWorkerMainModule,
      modules: {
        [defaultDynamicWorkerProcessorModule]: input.script,
        [defaultDynamicWorkerRuntimeConfigModule]: buildDynamicWorkerRuntimeConfigModule(
          input.outboundGateway,
        ),
        [defaultDynamicWorkerMainModule]: dynamicWorkerRuntimeModule,
      },
      outboundGateway: input.outboundGateway,
    };
  }

  return {
    compatibilityDate: input.compatibilityDate ?? defaultDynamicWorkerCompatibilityDate,
    compatibilityFlags: input.compatibilityFlags ?? defaultDynamicWorkerCompatibilityFlags,
    mainModule: defaultDynamicWorkerMainModule,
    modules: {
      ...normalizeDynamicWorkerModules(input.modules ?? {}),
      [defaultDynamicWorkerRuntimeConfigModule]: buildDynamicWorkerRuntimeConfigModule(
        input.outboundGateway,
      ),
      [defaultDynamicWorkerMainModule]: dynamicWorkerRuntimeModule,
    },
    outboundGateway: input.outboundGateway,
  };
}

function createDynamicWorkerRuntime(context: BuiltinProcessorContext) {
  const runsBySlug = new Map<
    string,
    {
      configKey: string;
      stream: LocalDynamicWorkerTarget;
      run: Promise<void>;
      stopping: boolean;
    }
  >();
  const transitionsBySlug = new Map<string, Promise<void>>();

  function ensureDynamicWorker(slug: string, config: DynamicWorkerConfig) {
    const previousTransition = transitionsBySlug.get(slug) ?? Promise.resolve();
    const nextTransition = previousTransition
      .catch(() => {})
      .then(async () => {
        const existing = runsBySlug.get(slug);
        const configKey = JSON.stringify(config);

        if (existing?.configKey === configKey) {
          return;
        }

        if (existing != null) {
          existing.stopping = true;
          await existing.stream.dispose();
        }

        const stream = context.createStreamTarget() as unknown as LocalDynamicWorkerTarget;
        const entrypoint = context.loader
          .get(
            `dynamic-worker:${context.getPath()}:${slug}:${hashDynamicWorkerConfig(configKey)}`,
            () => ({
              compatibilityDate: config.compatibilityDate,
              compatibilityFlags: config.compatibilityFlags,
              mainModule: config.mainModule,
              modules: config.modules,
              globalOutbound:
                config.outboundGateway == null
                  ? null
                  : context.createLoopbackBinding({
                      exportName: config.outboundGateway.entrypoint,
                      props: config.outboundGateway.props,
                    }),
            }),
          )
          .getEntrypoint() as unknown as {
          run(stream: RpcDynamicWorkerTarget): Promise<void>;
        };
        const run = entrypoint.run(stream as RpcDynamicWorkerTarget);
        const nextRun = {
          configKey,
          stream,
          run,
          stopping: false,
        };

        runsBySlug.set(slug, nextRun);
        context.waitUntil(run);

        void run.then(
          () => {
            if (runsBySlug.get(slug) === nextRun) {
              runsBySlug.delete(slug);
            }
          },
          (error) => {
            if (runsBySlug.get(slug) === nextRun) {
              runsBySlug.delete(slug);
            }

            if (nextRun.stopping) {
              return;
            }

            console.error("[stream-do] dynamic worker failed", {
              path: context.getPath(),
              slug,
              error,
            });
          },
        );
      });
    const trackedTransition = nextTransition.finally(() => {
      if (transitionsBySlug.get(slug) === trackedTransition) {
        transitionsBySlug.delete(slug);
      }
    });
    transitionsBySlug.set(slug, trackedTransition);
    return trackedTransition;
  }

  async function ensureConfiguredWorkers(state: DynamicWorkerState) {
    for (const [slug, config] of Object.entries(state.workersBySlug)) {
      await ensureDynamicWorker(slug, config);
    }
  }

  return {
    afterAppend({ state }: { event: Event; state: DynamicWorkerState }) {
      return ensureConfiguredWorkers(state);
    },
    onStateLoaded({ state }: { state: DynamicWorkerState }) {
      return ensureConfiguredWorkers(state);
    },
  };
}

function normalizeDynamicWorkerModules(modules: Record<string, string>) {
  const normalized = { ...modules };
  const processorModule = normalized["processor.ts"];

  if (processorModule != null) {
    delete normalized["processor.ts"];
    normalized[defaultDynamicWorkerProcessorModule] = processorModule;
  }

  return normalized;
}

function buildDynamicWorkerRuntimeConfigModule(
  outboundGateway: DynamicWorkerOutboundGateway | undefined,
) {
  return `export default ${JSON.stringify({ outboundGateway })};`;
}

function hashDynamicWorkerConfig(value: string) {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash.toString(36);
}

type RpcDynamicWorkerTarget = {
  append(input: DynamicWorkerAppendInput): Promise<Event>;
  history(args?: { afterOffset?: number }): Promise<Event[]>;
  subscribe(args?: { afterOffset?: number }): Promise<{
    next(): Promise<{ done: boolean; value?: Event }>;
    return(): Promise<{ done: boolean; value?: Event }>;
  }>;
};

type LocalDynamicWorkerTarget = RpcDynamicWorkerTarget & {
  dispose(): Promise<void>;
};
