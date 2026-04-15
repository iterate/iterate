import {
  DynamicWorkerConfiguredEvent,
  type DynamicWorkerConfig,
  DynamicWorkerEnvVarSetEvent,
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
import {
  dynamicWorkerEgressConfigHeader,
  dynamicWorkerProjectSlugHeader,
} from "~/lib/dynamic-worker-egress.ts";

export type DynamicWorkerAppendInput = ProcessorAppendInput;

const nodejsCompatFlag = "nodejs_compat";
const nodejsCompatPopulateProcessEnvFlag = "nodejs_compat_populate_process_env";
const nodejsCompatDoNotPopulateProcessEnvFlag = "nodejs_compat_do_not_populate_process_env";
const defaultDynamicWorkerCompatibilityDate = "2026-02-05";
const defaultDynamicWorkerCompatibilityFlags = resolveDynamicWorkerCompatibilityFlags([]);
const defaultDynamicWorkerOutboundGateway = {
  entrypoint: "DynamicWorkerEgressGateway",
} satisfies DynamicWorkerOutboundGateway;
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
  headers.set("${dynamicWorkerProjectSlugHeader}", runtimeConfig.projectSlug);

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
  typeof processor !== "object"
) {
  throw new Error(
    "Dynamic worker processor modules must default-export a processor object with optional initialState and optional reduce/afterAppend/onEvent hooks.",
  );
}

function getInitialProcessorState(processor) {
  return "initialState" in processor ? processor.initialState : {};
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

const logger = {
  debug: (...args) => console.log(...args),
  info: (...args) => console.log(...args),
  log: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

async function replayProcessorState(stream, processor) {
  let state = structuredClone(getInitialProcessorState(processor));
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
          logger,
          state,
        });
      }

      if (hasFunction(processor, "onEvent")) {
        await processor.onEvent({
          append: (input) => appendSameStream(stream, input),
          event,
          logger,
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
  initialState: { envVarsByKey: {}, workersBySlug: {} },

  reduce({ event, state }) {
    const configured = DynamicWorkerConfiguredEvent.safeParse(event);

    if (configured.success) {
      const normalizedConfig = normalizeDynamicWorkerConfig(configured.data.payload);

      return {
        envVarsByKey: state.envVarsByKey,
        workersBySlug: {
          ...state.workersBySlug,
          [configured.data.payload.slug]: normalizedConfig,
        },
      };
    }

    const envVarSet = DynamicWorkerEnvVarSetEvent.safeParse(event);
    if (!envVarSet.success) {
      return state;
    }

    return {
      envVarsByKey: {
        ...state.envVarsByKey,
        [envVarSet.data.payload.key]: envVarSet.data.payload.value,
      },
      workersBySlug: {
        ...state.workersBySlug,
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
  const outboundGateway = resolveDynamicWorkerOutboundGateway(input.outboundGateway);

  if (input.script != null) {
    return {
      compatibilityDate: input.compatibilityDate ?? defaultDynamicWorkerCompatibilityDate,
      compatibilityFlags: resolveDynamicWorkerCompatibilityFlags(
        input.compatibilityFlags ?? defaultDynamicWorkerCompatibilityFlags,
      ),
      mainModule: defaultDynamicWorkerMainModule,
      modules: {
        [defaultDynamicWorkerProcessorModule]: input.script,
        [defaultDynamicWorkerMainModule]: dynamicWorkerRuntimeModule,
      },
      outboundGateway,
    };
  }

  return {
    compatibilityDate: input.compatibilityDate ?? defaultDynamicWorkerCompatibilityDate,
    compatibilityFlags: resolveDynamicWorkerCompatibilityFlags(
      input.compatibilityFlags ?? defaultDynamicWorkerCompatibilityFlags,
    ),
    mainModule: defaultDynamicWorkerMainModule,
    modules: {
      ...normalizeDynamicWorkerModules(input.modules ?? {}),
      [defaultDynamicWorkerMainModule]: dynamicWorkerRuntimeModule,
    },
    outboundGateway,
  };
}

export function createDynamicWorkerManager(context: {
  append: (event: EventInput) => Event;
  history: (args?: { after?: StreamCursor; before?: StreamCursor }) => Event[];
  stream: (args?: { after?: StreamCursor; before?: StreamCursor }) => ReadableStream<Uint8Array>;
  createLoopbackBinding: (args: { exportName: string }) => Fetcher;
  getPath: () => StreamPath;
  getProjectSlug: () => string;
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

  function ensureDynamicWorker(
    slug: string,
    config: DynamicWorkerConfig,
    envVarsByKey: DynamicWorkerState["envVarsByKey"],
  ) {
    const previousTransition = transitionsBySlug.get(slug) ?? Promise.resolve();
    const nextTransition = previousTransition
      .catch(() => {})
      .then(async () => {
        if (disposed) {
          return;
        }

        const existing = runsBySlug.get(slug);
        const configKey = JSON.stringify({
          config,
          envVarsByKey,
        });

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

        const outboundGateway = resolveDynamicWorkerOutboundGateway(config.outboundGateway);
        const globalOutbound = context.createLoopbackBinding({
          exportName: outboundGateway.entrypoint,
        });
        const env = buildDynamicWorkerEnvBindings(envVarsByKey);
        const entrypoint = context.loader
          .get(
            buildDynamicWorkerLoaderKey({
              configKey,
              path: context.getPath(),
              projectSlug: context.getProjectSlug(),
              slug,
            }),
            () =>
              buildDynamicWorkerLoaderCode({
                config,
                env,
                globalOutbound,
                projectSlug: context.getProjectSlug(),
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
      await ensureDynamicWorker(slug, config, state.envVarsByKey);
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

function buildDynamicWorkerRuntimeConfigModule(input: {
  outboundGateway: DynamicWorkerOutboundGateway | undefined;
  projectSlug?: string;
}) {
  return `export default ${JSON.stringify(input)};`;
}

function buildDynamicWorkerEnvBindings(envVarsByKey: DynamicWorkerState["envVarsByKey"]) {
  if (Object.keys(envVarsByKey).length === 0) {
    return undefined;
  }

  return { ...envVarsByKey };
}

export function resolveDynamicWorkerCompatibilityFlags(compatibilityFlags: string[]) {
  const flags = new Set(compatibilityFlags);
  flags.add(nodejsCompatFlag);

  if (!flags.has(nodejsCompatDoNotPopulateProcessEnvFlag)) {
    flags.add(nodejsCompatPopulateProcessEnvFlag);
  }

  return Array.from(flags);
}

export function resolveDynamicWorkerOutboundGateway(
  outboundGateway: DynamicWorkerOutboundGateway | undefined,
) {
  return outboundGateway ?? defaultDynamicWorkerOutboundGateway;
}

export function buildDynamicWorkerLoaderCode(args: {
  config: DynamicWorkerConfig;
  env: Record<string, string> | undefined;
  globalOutbound: Fetcher | undefined;
  projectSlug: string;
}) {
  const modules = {
    ...args.config.modules,
    [defaultDynamicWorkerRuntimeConfigModule]: buildDynamicWorkerRuntimeConfigModule({
      outboundGateway: args.config.outboundGateway,
      projectSlug: args.projectSlug,
    }),
  };

  return {
    compatibilityDate: args.config.compatibilityDate,
    compatibilityFlags: resolveDynamicWorkerCompatibilityFlags(args.config.compatibilityFlags),
    env: args.env,
    mainModule: args.config.mainModule,
    modules,
    ...(args.globalOutbound == null ? {} : { globalOutbound: args.globalOutbound }),
  };
}

export function buildDynamicWorkerLoaderKey(args: {
  configKey: string;
  path: string;
  projectSlug: string;
  slug: string;
}) {
  return `dynamic-worker:${args.projectSlug}:${args.path}:${args.slug}:${hashDynamicWorkerConfig(args.configKey)}`;
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
