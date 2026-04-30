import { DurableObject, RpcTarget } from "cloudflare:workers";
import { EventInput } from "@iterate-com/events-contract";
import { CodemodeExecutor } from "@iterate-com/shared/codemode/executor";
import type { ToolProvider } from "@iterate-com/shared/codemode/types";
import { CodemodeEventType, createCallId } from "./codemode-events.ts";

type Env = {
  LOADER: WorkerLoader;
  CODEMODE_HOST: DurableObjectNamespace<CodemodeHost>;
  CODEMODE_SESSION: DurableObjectNamespace<CodemodeSession>;
  PROVIDER_A: DurableObjectNamespace<ProviderA>;
  PROVIDER_B: DurableObjectNamespace<ProviderB>;
};

type ToolFunctionCall = {
  path: string[];
  payload: unknown;
  executionId?: string;
};

type SessionEvent = {
  streamPath: string;
  type: string;
  payload: object;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
  offset: number;
  createdAt: string;
};

type SessionStreamQuery = {
  afterOffset?: number | "start" | "end";
  beforeOffset?: number | "start" | "end";
};

type ProviderRpc = {
  executeToolFunction(call: ToolFunctionCall): Promise<unknown>;
  describeToolFunctions(): Promise<{ typeDefinitions: string }>;
};

type BrokerRpc = {
  callProviderToolFunction(providerName: string, call: ToolFunctionCall): Promise<unknown>;
};

type CodemodeSessionCapability = {
  callToolFunction(call: ToolFunctionCall): Promise<unknown>;
  append(input: EventInput): Promise<SessionEvent>;
  getSessionId(): Promise<string>;
  executeScript(input: { code: string }): Promise<SessionEvent>;
};

type CallToolFunctionCallback = (providerName: string, call: ToolFunctionCall) => Promise<unknown>;

type ToolProxyNode = {
  [key: string]: ToolProxyNode;
} & ((payload?: unknown) => Promise<unknown>);

type CodemodeContext = {
  providerA: ToolProxyNode;
  providerB: ToolProxyNode;
  codemode: {
    append(input: EventInput): Promise<SessionEvent>;
    getSessionId(): Promise<string>;
    executeScript(input: { code: string }): Promise<SessionEvent>;
    abortSignal: AbortSignal;
  };
};

const NON_TOOL_PROMISE_KEYS = new Set(["then", "catch", "finally"]);

export default {
  async fetch(request: Request, env: Env) {
    const host = env.CODEMODE_HOST.getByName("host");
    const url = new URL(request.url);

    if (url.pathname === "/direct-rpc-target") {
      return Response.json(await host.directRpcTargetHandoff());
    }

    if (url.pathname === "/broker-callback") {
      return Response.json(await host.brokerCallback());
    }

    if (url.pathname === "/provider-side-tools-proxy") {
      return Response.json(await host.providerSideToolsProxy());
    }

    if (url.pathname === "/provider-side-callback-proxy") {
      return Response.json(await host.providerSideCallbackProxy());
    }

    if (url.pathname === "/codemode-provider-b") {
      return Response.json(await host.codemodeProviderBDelegatesToProviderA());
    }

    if (url.pathname === "/bare-expression") {
      return Response.json(await host.bareExpression());
    }

    if (url.pathname === "/session-dynamic-worker") {
      const session = env.CODEMODE_SESSION.getByName("session");
      return Response.json(await session.executeScript({ code: sessionDynamicWorkerCode }));
    }

    if (url.pathname === "/session-provider-tools") {
      const session = env.CODEMODE_SESSION.getByName("session");
      return Response.json(
        await session.callToolFunction({
          path: ["providerA", "compose", "sessionGreeting"],
          payload: { name: "session provider proxy" },
        }),
      );
    }

    return new Response("codemode rpc provider poc");
  },
};

export class ProviderA extends DurableObject<Env> {
  async executeToolFunction(call: ToolFunctionCall) {
    const name = call.path.join(".");
    if (name === "math.add") {
      const payload = call.payload as { left: number; right: number };
      return {
        provider: "provider-a",
        tool: name,
        value: payload.left + payload.right,
      };
    }

    if (name === "text.upper") {
      const payload = call.payload as { value: string };
      return {
        provider: "provider-a",
        tool: name,
        value: payload.value.toUpperCase(),
      };
    }

    throw new Error(`ProviderA does not have tool ${name}`);
  }

  async executeToolFunctionWithBroker(broker: BrokerRpc, call: ToolFunctionCall) {
    const name = call.path.join(".");
    if (name !== "compose.greeting") {
      throw new Error(`ProviderA does not have broker-backed tool ${name}`);
    }

    const tools = createToolsProxy(broker);
    const payload = call.payload as { name: string };
    const upper = (await tools.providerB.somePath.myFunction({
      value: payload.name,
    })) as { value: string };

    return {
      provider: "provider-a",
      tool: name,
      value: `hello ${upper.value}`,
    };
  }

  async executeToolFunctionWithCallback(
    callToolFunction: CallToolFunctionCallback,
    call: ToolFunctionCall,
  ) {
    const name = call.path.join(".");
    if (name !== "compose.callbackGreeting") {
      throw new Error(`ProviderA does not have callback-backed tool ${name}`);
    }

    const tools = createToolFunctionProxyFromCallback(callToolFunction);
    const payload = call.payload as { name: string };
    const upper = (await tools.providerB.somePath.myFunction({
      value: payload.name,
    })) as { value: string };

    return {
      provider: "provider-a",
      route: "callback-function",
      tool: name,
      value: `hello ${upper.value}`,
    };
  }

  async executeToolFunctionWithCapability(
    sessionTarget: CodemodeSessionCapability,
    call: ToolFunctionCall,
  ) {
    const name = call.path.join(".");
    if (name === "math.add" || name === "text.upper") {
      return await this.executeToolFunction(call);
    }

    if (name !== "compose.sessionGreeting") {
      throw new Error(`ProviderA does not have scoped-target tool ${name}`);
    }

    const ctx = createCodemodeContext(sessionTarget);
    const payload = call.payload as { name: string };
    const upper = (await ctx.providerB.somePath.myFunction({
      value: payload.name,
    })) as { value: string };

    return {
      provider: "provider-a",
      route: "scoped-rpc-target",
      tool: name,
      value: `hello ${upper.value}`,
    };
  }

  async describeToolFunctions() {
    return {
      typeDefinitions: `declare const providerA: {
  math: { add(input: { left: number; right: number }): Promise<{ value: number }> };
  text: { upper(input: { value: string }): Promise<{ value: string }> };
};`,
    };
  }
}

export class ProviderB extends DurableObject<Env> {
  async executeToolFunction(call: ToolFunctionCall) {
    const name = call.path.join(".");
    if (name === "somePath.myFunction") {
      const payload = call.payload as { value: string };
      return {
        provider: "provider-b",
        tool: name,
        value: payload.value.toUpperCase(),
      };
    }

    throw new Error(`ProviderB does not have tool ${name}`);
  }

  async executeToolFunctionWithCapability(
    sessionTarget: CodemodeSessionCapability,
    call: ToolFunctionCall,
  ) {
    const name = call.path.join(".");
    if (name === "somePath.myFunction") {
      return await this.executeToolFunction(call);
    }

    if (name === "compose.addThenUpper") {
      const ctx = createCodemodeContext(sessionTarget);
      const payload = call.payload as { left: number; right: number };
      const sum = (await ctx.providerA.math.add({
        left: payload.left,
        right: payload.right,
      })) as { value: number };
      const upper = (await ctx.providerA.text.upper({
        value: `sum ${sum.value}`,
      })) as { value: string };

      return {
        provider: "provider-b",
        route: "scoped-rpc-target",
        tool: name,
        value: upper.value,
      };
    }

    throw new Error(`ProviderB does not have scoped-target tool ${name}`);
  }

  async callProviderDirect(provider: ProviderRpc, call: ToolFunctionCall) {
    const result = await provider.executeToolFunction(call);
    return {
      provider: "provider-b",
      route: "direct-rpc-target",
      result,
    };
  }

  async callProviderViaBroker(broker: BrokerRpc, providerName: string, call: ToolFunctionCall) {
    const result = await broker.callProviderToolFunction(providerName, call);
    return {
      provider: "provider-b",
      route: "broker-callback",
      result,
    };
  }
}

export class CodemodeHost extends DurableObject<Env> {
  async directRpcTargetHandoff() {
    const providerA = this.env.PROVIDER_A.getByName("provider-a");
    const providerB = this.env.PROVIDER_B.getByName("provider-b");

    return await providerB.callProviderDirect(new ProviderAHandle(providerA), {
      path: ["math", "add"],
      payload: { left: 2, right: 5 },
    });
  }

  async brokerCallback() {
    const providerB = this.env.PROVIDER_B.getByName("provider-b");

    return await providerB.callProviderViaBroker(
      new ToolBroker({
        providers: {
          providerA: new ProviderAHandle(this.env.PROVIDER_A.getByName("provider-a")),
        },
      }),
      "providerA",
      {
        path: ["text", "upper"],
        payload: { value: "across durable object boundaries" },
      },
    );
  }

  async providerSideToolsProxy() {
    const providerA = this.env.PROVIDER_A.getByName("provider-a");

    return await providerA.executeToolFunctionWithBroker(
      new ToolBroker({
        providers: {
          providerB: new ProviderBHandle(this.env.PROVIDER_B.getByName("provider-b")),
        },
      }),
      {
        path: ["compose", "greeting"],
        payload: { name: "proxy call" },
      },
    );
  }

  async providerSideCallbackProxy() {
    const providerA = this.env.PROVIDER_A.getByName("provider-a");
    const providerB = new ProviderBHandle(this.env.PROVIDER_B.getByName("provider-b"));

    const callToolFunction: CallToolFunctionCallback = async (providerName, call) => {
      if (providerName !== "providerB") throw new Error(`Unknown provider ${providerName}`);
      return await providerB.executeToolFunction(call);
    };

    return await providerA.executeToolFunctionWithCallback(callToolFunction, {
      path: ["compose", "callbackGreeting"],
      payload: { name: "callback proxy call" },
    });
  }

  async codemodeProviderBDelegatesToProviderA() {
    const providerB = this.env.PROVIDER_B.getByName("provider-b");
    const broker = new ToolBroker({
      providers: {
        providerA: new ProviderAHandle(this.env.PROVIDER_A.getByName("provider-a")),
      },
    });

    const provider: ToolProvider = {
      async executeToolFunction(path, payload) {
        return await providerB.callProviderViaBroker(broker, "providerA", { path, payload });
      },
      async describeToolFunctions() {
        return {
          typeDefinitions: `declare const providerB: {
  math: { add(input: { left: number; right: number }): Promise<unknown> };
  text: { upper(input: { value: string }): Promise<unknown> };
};`,
        };
      },
    };

    const events: unknown[] = [];
    const executor = new CodemodeExecutor({ loader: this.env.LOADER });
    return await executor.execute({
      code: `const added = await providerB.math.add({ left: 10, right: 32 });
  const upper = await providerB.text.upper({ value: "provider b called provider a" });
  ({ added, upper })`,
      providers: [{ path: ["providerB"], provider }],
      blockId: "cblk_poc",
      onEvent: (event) => events.push(event),
    });
  }

  async bareExpression() {
    const events: unknown[] = [];
    const executor = new CodemodeExecutor({ loader: this.env.LOADER });
    return await executor.execute({
      code: `const value = await Promise.resolve(20 + 22);
value`,
      providers: [],
      blockId: "cblk_bare",
      onEvent: (event) => events.push(event),
    });
  }
}

export class CodemodeSession extends DurableObject<Env> {
  #events: SessionEvent[] = [];
  #subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();

  scopedRpcTarget() {
    return this.getScopedRpcTarget();
  }

  getScopedRpcTarget() {
    return new ScopedCodemodeSessionTarget(this);
  }

  getSessionId() {
    return this.ctx.id.toString();
  }

  async callToolFunction(call: ToolFunctionCall) {
    const callId = createCallId();
    const started = this.appendCodemodeEvent({
      type: CodemodeEventType.toolFunctionCallRequested,
      payload: {
        callId,
        executionId: call.executionId,
        path: call.path,
        payload: call.payload,
      },
    });

    const [providerName, ...toolPath] = call.path;
    if (!providerName) throw new Error("Provider name is required");

    try {
      let result: unknown;

      if (providerName === "providerA") {
        const providerA = this.env.PROVIDER_A.getByName("provider-a");
        result = await providerA.executeToolFunctionWithCapability(this.scopedRpcTarget(), {
          path: toolPath,
          payload: call.payload,
        });
      } else if (providerName === "providerB") {
        const providerB = this.env.PROVIDER_B.getByName("provider-b");
        result = await providerB.executeToolFunctionWithCapability(this.scopedRpcTarget(), {
          path: toolPath,
          payload: call.payload,
        });
      } else {
        throw new Error(`Unknown provider ${providerName}`);
      }

      this.appendCodemodeEvent({
        type: CodemodeEventType.toolFunctionCallSucceeded,
        payload: {
          callId,
          requestedOffset: started.offset,
          path: call.path,
          result,
        },
      });

      return result;
    } catch (error) {
      this.appendCodemodeEvent({
        type: CodemodeEventType.toolFunctionCallFailed,
        payload: {
          callId,
          requestedOffset: started.offset,
          path: call.path,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }

  executeScript(input: { code: string }): SessionEvent {
    const executionId = crypto.randomUUID();
    const startEvent = this.appendCodemodeEvent({
      type: CodemodeEventType.scriptExecutionRequested,
      payload: {
        executionId,
        code: input.code,
      },
    });

    void this.runTypescriptExecution({
      code: input.code,
      executionId,
    });

    // Prototype start shape: return the committed event immediately so callers
    // have a durable cursor. In production this append should go to a real
    // events app stream; an oRPC adapter can then subscribe from startEvent.offset
    // and yield matching output events while execution continues asynchronously.
    return startEvent;
  }

  append(input: EventInput): SessionEvent {
    return this.appendCodemodeEvent(EventInput.parse(input));
  }

  stream(query: SessionStreamQuery = {}) {
    const backlog = this.history(query);
    let subscriber: ReadableStreamDefaultController<Uint8Array> | undefined;

    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        for (const event of backlog) {
          controller.enqueue(encodeSessionEvent(event));
        }

        if (query.beforeOffset != null) {
          controller.close();
          return;
        }

        subscriber = controller;
        this.#subscribers.add(controller);
      },
      cancel: () => {
        if (subscriber) this.#subscribers.delete(subscriber);
      },
    });
  }

  history(query: SessionStreamQuery = {}) {
    const after = resolveAfterSessionCursor(query.afterOffset, this.#events.length);
    const before = resolveBeforeSessionCursor(query.beforeOffset, this.#events.length);
    return this.#events.filter((event) => event.offset > after && event.offset < before);
  }

  private async runTypescriptExecution(input: { code: string; executionId: string }) {
    const worker = this.env.LOADER.get(`codemode-session-${crypto.randomUUID()}`, () => ({
      compatibilityDate: "2026-04-27",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "executor.js",
      modules: {
        "executor.js": buildSessionExecutorModule(input.code),
      },
      globalOutbound: null,
    }));

    const entrypoint = worker.getEntrypoint() as unknown as {
      evaluate(sessionTarget: CodemodeSessionCapability): Promise<unknown>;
    };

    try {
      const result = await entrypoint.evaluate(this.scopedRpcTarget());
      this.appendCodemodeEvent({
        type: CodemodeEventType.scriptExecutionSucceeded,
        payload: {
          executionId: input.executionId,
          result,
        },
      });
    } catch (error) {
      this.appendCodemodeEvent({
        type: CodemodeEventType.scriptExecutionFailed,
        payload: {
          executionId: input.executionId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private appendCodemodeEvent(input: EventInput): SessionEvent {
    const event: SessionEvent = {
      streamPath: `/codemode/sessions/${this.getSessionId()}`,
      type: input.type,
      payload: input.payload,
      metadata: input.metadata,
      idempotencyKey: input.idempotencyKey,
      offset: this.#events.length + 1,
      createdAt: new Date().toISOString(),
    };
    this.#events.push(event);
    this.publish(event);
    return event;
  }

  private publish(event: SessionEvent) {
    const chunk = encodeSessionEvent(event);
    for (const subscriber of this.#subscribers) {
      try {
        subscriber.enqueue(chunk);
      } catch {
        this.#subscribers.delete(subscriber);
      }
    }
  }
}

class ProviderAHandle extends RpcTarget implements ProviderRpc {
  #providerA: DurableObjectStub<ProviderA>;

  constructor(providerA: DurableObjectStub<ProviderA>) {
    super();
    this.#providerA = providerA;
  }

  async executeToolFunction(call: ToolFunctionCall) {
    return await this.#providerA.executeToolFunction(call);
  }

  async describeToolFunctions() {
    return await this.#providerA.describeToolFunctions();
  }
}

class ScopedCodemodeSessionTarget extends RpcTarget implements CodemodeSessionCapability {
  #session: CodemodeSession;

  constructor(session: CodemodeSession) {
    super();
    this.#session = session;
  }

  async callToolFunction(call: ToolFunctionCall) {
    return await this.#session.callToolFunction(call);
  }

  async append(input: EventInput) {
    return this.#session.append(input);
  }

  async getSessionId() {
    return this.#session.getSessionId();
  }

  async executeScript(input: { code: string }) {
    return this.#session.executeScript(input);
  }
}

class ProviderBHandle extends RpcTarget implements ProviderRpc {
  #providerB: DurableObjectStub<ProviderB>;

  constructor(providerB: DurableObjectStub<ProviderB>) {
    super();
    this.#providerB = providerB;
  }

  async executeToolFunction(call: ToolFunctionCall) {
    return await this.#providerB.executeToolFunction(call);
  }

  async describeToolFunctions() {
    return {
      typeDefinitions: `declare const providerB: {
  somePath: { myFunction(input: { value: string }): Promise<{ value: string }> };
};`,
    };
  }
}

class ToolBroker extends RpcTarget implements BrokerRpc {
  #providers: Record<string, ProviderRpc>;

  constructor(options: { providers: Record<string, ProviderRpc> }) {
    super();
    this.#providers = options.providers;
  }

  async callProviderToolFunction(providerName: string, call: ToolFunctionCall) {
    const provider = this.#providers[providerName];
    if (!provider) throw new Error(`Unknown provider ${providerName}`);
    return await provider.executeToolFunction(call);
  }
}

function createToolsProxy(broker: BrokerRpc) {
  return createToolFunctionProxyFromCallback(async (providerName, call) => {
    return await broker.callProviderToolFunction(providerName, call);
  });
}

function createCodemodeContext(sessionCapability: CodemodeSessionCapability) {
  const toolFunctions = createToolFunctionProxyFromCallback(async (providerName, call) => {
    return await sessionCapability.callToolFunction({
      path: [providerName, ...call.path],
      payload: call.payload,
    });
  });

  const codemodeControlSurface: CodemodeContext["codemode"] = {
    append: (input) => sessionCapability.append(input),
    getSessionId: () => sessionCapability.getSessionId(),
    executeScript: (input) => sessionCapability.executeScript(input),
    abortSignal: new AbortController().signal,
  };

  return new Proxy(toolFunctions, {
    get(target, key, receiver) {
      if (key === "codemode") return codemodeControlSurface;
      return Reflect.get(target, key, receiver);
    },
  }) as CodemodeContext;
}

function createToolFunctionProxyFromCallback(callToolFunction: CallToolFunctionCallback) {
  const make = (path: string[] = []): ToolProxyNode =>
    new Proxy(async () => {}, {
      get(_target, key) {
        if (typeof key !== "string") return undefined;
        if (NON_TOOL_PROMISE_KEYS.has(key)) return undefined;
        return make([...path, key]);
      },
      async apply(_target, _thisArg, args) {
        const [providerName, ...toolPath] = path;
        if (!providerName) throw new Error("Tool provider name is required");
        return await callToolFunction(providerName, {
          path: toolPath,
          payload: args[0] ?? {},
        });
      },
    }) as ToolProxyNode;

  return make();
}

function buildSessionExecutorModule(code: string) {
  return [
    'import { WorkerEntrypoint } from "cloudflare:workers";',
    "",
    createCodemodeContextSource(),
    "",
    "export default class CodeExecutor extends WorkerEntrypoint {",
    "  async evaluate(__sessionTarget) {",
    "    const ctx = __createCodemodeContext(__sessionTarget);",
    "    const execute = (",
    code,
    "    );",
    "    if (typeof execute !== 'function') throw new Error('Codemode code must evaluate to a function');",
    "    return await execute(ctx);",
    "  }",
    "}",
  ].join("\n");
}

function createCodemodeContextSource() {
  return `
function __createCodemodeContext(sessionCapability) {
  const make = (path = []) => new Proxy(async () => {}, {
    get(_target, key) {
      if (typeof key !== "string") return undefined;
      if (key === "then" || key === "catch" || key === "finally") return undefined;
      return make([...path, key]);
    },
    async apply(_target, _thisArg, args) {
      return await sessionCapability.callToolFunction({
        path,
        payload: args[0] ?? {},
      });
    },
  });
  const toolFunctions = make();
  const codemodeControlSurface = {
    append: async (input) => await sessionCapability.append(input),
    getSessionId: async () => await sessionCapability.getSessionId(),
    executeScript: async (input) => await sessionCapability.executeScript(input),
    abortSignal: new AbortController().signal,
  };
  return new Proxy(toolFunctions, {
    get(target, key, receiver) {
      if (key === "codemode") return codemodeControlSurface;
      return Reflect.get(target, key, receiver);
    },
  });
}`;
}

const sessionDynamicWorkerCode = `async (ctx) => {
  const fromB = await ctx.providerB.somePath.myFunction({ value: "dynamic worker" });
  const fromA = await ctx.providerA.compose.sessionGreeting({ name: "dynamic worker via provider a" });
  const fromBCallingA = await ctx.providerB.compose.addThenUpper({ left: 19, right: 23 });
  const appended = await ctx.codemode.append({
    type: "events.iterate.com/codemode/log-emitted",
    payload: { message: "appended from dynamic worker" },
  });
  return {
    sessionId: await ctx.codemode.getSessionId(),
    appendedOffset: appended.offset,
    fromB,
    fromA,
    fromBCallingA,
  };
}`;

const sessionEventEncoder = new TextEncoder();

function encodeSessionEvent(event: SessionEvent) {
  return sessionEventEncoder.encode(`${JSON.stringify(event)}\n`);
}

function resolveAfterSessionCursor(
  cursor: number | "start" | "end" | undefined,
  endOffset: number,
) {
  if (cursor == null || cursor === "start") return 0;
  if (cursor === "end") return endOffset;
  return cursor;
}

function resolveBeforeSessionCursor(
  cursor: number | "start" | "end" | undefined,
  endOffset: number,
) {
  if (cursor == null || cursor === "end") return endOffset + 1;
  if (cursor === "start") return 0;
  return cursor;
}
