import {
  DynamicWorkerConfiguredEvent,
  type DynamicWorkerConfig,
  type DynamicWorkerOutboundGateway,
  type DynamicWorkerState,
  type Event,
  EventInput,
  type StreamCursor,
  type StreamPath,
} from "@iterate-com/events-contract";
import {
  defineBuiltinProcessor,
  type ProcessorAppendInput,
} from "@iterate-com/events-contract/sdk";
import { dynamicWorkerEgressConfigHeader } from "~/lib/dynamic-worker-egress.ts";

export type DynamicWorkerAppendInput = ProcessorAppendInput;

const defaultDynamicWorkerCompatibilityDate = "2026-02-05";
const defaultDynamicWorkerCompatibilityFlags: string[] = [];
const defaultDynamicWorkerMainModule = "worker.js";
const defaultDynamicWorkerProcessorModule = "processor.js";
const defaultDynamicWorkerRuntimeConfigModule = "runtime-config.js";
export const pingPongDynamicWorkerScript = `
export default {
  slug: "ping-pong",
  initialState: {},

  reduce({ state }) {
    return state;
  },

  async afterAppend({ append, event }) {
    if (
      event.type === "https://events.iterate.com/events/stream/dynamic-worker/configured" ||
      !/\\bping\\b/i.test(
        JSON.stringify({
          type: event.type,
          payload: event.payload,
          metadata: event.metadata ?? null,
        }),
      )
    ) {
      return;
    }

    await append({
      event: {
        type: "pong",
      },
    });
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
  slug: "httpbin-echo",
  initialState: {},

  reduce({ state }) {
    return state;
  },

  async afterAppend({ append, event }) {
    if (!containsPing(event)) {
      return;
    }

    const response = await fetch("https://httpbin.org/headers");
    const responseJson = await response.json();

    await append({
      event: {
        type: "https://events.iterate.com/events/example/httpbin-echoed",
        payload: {
          ok: response.ok,
          status: response.status,
          normalizedHeaders: normalizeHeaders(responseJson.headers),
          response: responseJson,
        },
      },
    });
  },
};
`.trim();

const dynamicWorkerRuntimeModule = `
import processor from "./processor.js";
import runtimeConfig from "./runtime-config.js";

const originalFetch = globalThis.fetch.bind(globalThis);

function withDynamicWorkerEgressConfig(input, init) {
  const request = new Request(input, init);

  if (runtimeConfig.outboundGateway == null) {
    return request;
  }

  const headers = new Headers(request.headers);
  headers.set("${dynamicWorkerEgressConfigHeader}", JSON.stringify(runtimeConfig.outboundGateway));

  return new Request(request, { headers });
}

if (runtimeConfig.outboundGateway != null) {
  globalThis.fetch = (input, init) => originalFetch(withDynamicWorkerEgressConfig(input, init));
}

function hasFunction(value, key) {
  return value != null && typeof value === "object" && typeof value[key] === "function";
}

if (
  processor == null ||
  typeof processor !== "object" ||
  !("initialState" in processor)
) {
  throw new Error(
    "Dynamic worker processor modules must default-export a processor object with initialState and optional reduce/afterAppend/onEvent hooks.",
  );
}

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

function reduceEvent(state, event) {
  if (!hasFunction(processor, "reduce")) {
    return state;
  }

  return processor.reduce({ state: structuredClone(state), event }) ?? state;
}

async function appendSameStream(stream, input) {
  const normalizedInput =
    input != null && typeof input === "object" && "event" in input ? input : { event: input };

  if (
    normalizedInput == null ||
    typeof normalizedInput !== "object" ||
    !("event" in normalizedInput)
  ) {
    throw new Error("Dynamic worker processors must call append(event) or append({ event }).");
  }

  if ("path" in normalizedInput && normalizedInput.path != null) {
    throw new Error(
      "Dynamic worker processors can only append to their own stream. append({ path }) is not supported.",
    );
  }

  return stream.append({ event: normalizedInput.event });
}

async function replayProcessorState(stream, processor) {
  let state = structuredClone(processor.initialState);
  let lastOffset = 0;
  const history = await stream.history({ before: "end" });

  for (const event of history) {
    lastOffset = event.offset;
    state = reduceEvent(state, event);
  }

  return { lastOffset, state };
}

export default {
  async run(stream) {
    let { lastOffset, state } = await replayProcessorState(stream, processor);
    const live = createRemoteAsyncIterator(
      await stream.subscribe({ after: lastOffset > 0 ? lastOffset : "start" }),
    );

    for await (const event of live) {
      if (event.offset === lastOffset) {
        continue;
      }

      const prevState = structuredClone(state);
      state = reduceEvent(state, event);

      if (hasFunction(processor, "afterAppend")) {
        await processor.afterAppend({
          append: (input) => appendSameStream(stream, input),
          event,
          state,
        });
      }

      if (hasFunction(processor, "onEvent")) {
        await processor.onEvent({
          append: (input) => appendSameStream(stream, input),
          event,
          prevState,
          state,
        });
      }

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
}));

function normalizeDynamicWorkerConfig(input: {
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

export function createDynamicWorkerManager(context: {
  append: (event: EventInput) => Event;
  history: (args?: { after?: StreamCursor; before?: StreamCursor }) => Event[];
  stream: (args?: { after?: StreamCursor; before?: StreamCursor }) => ReadableStream<Uint8Array>;
  createLoopbackBinding: (args: { exportName: string }) => Fetcher;
  getPath: () => StreamPath;
  loader: WorkerLoader;
  waitUntil: (promise: Promise<unknown>) => void;
}) {
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
  let disposed = false;

  function ensureDynamicWorker(slug: string, config: DynamicWorkerConfig) {
    const previousTransition = transitionsBySlug.get(slug) ?? Promise.resolve();
    const nextTransition = previousTransition
      .catch(() => {})
      .then(async () => {
        if (disposed) {
          return;
        }

        const existing = runsBySlug.get(slug);
        const configKey = JSON.stringify(config);

        if (existing?.configKey === configKey) {
          return;
        }

        if (existing != null) {
          existing.stopping = true;
          await existing.stream.dispose();
        }

        if (disposed) {
          return;
        }

        const { createDynamicWorkerStreamTarget } =
          await import("./dynamic-worker-stream-target.ts");
        const stream = createDynamicWorkerStreamTarget({
          append: (input: DynamicWorkerAppendInput) => {
            if (input.path != null) {
              throw new Error(
                "Dynamic worker processors can only append to their own stream. append({ path }) is not supported.",
              );
            }

            return context.append(
              EventInput.parse({ ...input.event, payload: input.event.payload ?? {} }),
            );
          },
          history: (args) =>
            context.history({
              after: args?.after,
              before: args?.before,
            }),
          stream: (args) =>
            context.stream({
              after: args?.after,
              before: args?.before,
            }),
        }) as LocalDynamicWorkerTarget;

        if (disposed) {
          await stream.dispose();
          return;
        }

        const globalOutbound =
          config.outboundGateway == null
            ? null
            : context.createLoopbackBinding({
                exportName: config.outboundGateway.entrypoint,
              });
        const entrypoint = context.loader
          .get(
            `dynamic-worker:${context.getPath()}:${slug}:${hashDynamicWorkerConfig(configKey)}`,
            () => ({
              compatibilityDate: config.compatibilityDate,
              compatibilityFlags: config.compatibilityFlags,
              mainModule: config.mainModule,
              modules: config.modules,
              globalOutbound,
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
    sync(state: DynamicWorkerState) {
      return ensureConfiguredWorkers(state);
    },
    afterAppend({ state }: { event: Event; state: DynamicWorkerState }) {
      return ensureConfiguredWorkers(state);
    },
    async dispose() {
      disposed = true;
      await Promise.all(
        Array.from(transitionsBySlug.values(), (transition) => transition.catch(() => {})),
      );
      await Promise.all(
        Array.from(runsBySlug.values(), async (run) => {
          run.stopping = true;
          await run.stream.dispose();
        }),
      );
      transitionsBySlug.clear();
      runsBySlug.clear();
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
  history(args?: { after?: StreamCursor; before?: StreamCursor }): Promise<Event[]>;
  subscribe(args?: { after?: StreamCursor; before?: StreamCursor }): Promise<{
    next(): Promise<{ done: boolean; value?: Event }>;
    return(): Promise<{ done: boolean; value?: Event }>;
  }>;
};

type LocalDynamicWorkerTarget = RpcDynamicWorkerTarget & {
  dispose(): Promise<void>;
};
