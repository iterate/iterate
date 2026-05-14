import { env } from "cloudflare:test";
import { createCodemodeContext } from "@iterate-com/shared/codemode/context-proxy";
import { dispatchCallable } from "@iterate-com/shared/callable/runtime.ts";
import { type Event, type EventInput, type StreamPath } from "@iterate-com/shared/streams/types";
import { getInitializedStreamStub } from "@iterate-com/shared/streams/helpers";
import { deriveDurableObjectNameFromStructuredName } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import type { ToolProviderRegistration } from "@iterate-com/shared/stream-processors/codemode/contract";
import type { StreamProcessorRunnerState } from "@iterate-com/shared/durable-object-utils/mixins/with-stream-processor-runner";
import { describe, expect, test } from "vitest";
import type { CodemodeSession } from "~/domains/codemode/durable-objects/codemode-session.ts";
import { createCodemodeSessionStartupEvents } from "~/domains/codemode/codemode-session-rpc.ts";
import { createExampleRpcProviderRegistration } from "~/domains/codemode/example-capabilities.ts";
import { findCodemodeExample, providersForCodemodeExample } from "~/domains/codemode/examples.ts";

type CodemodeSessionStub = DurableObjectStub<CodemodeSession> & {
  callFunction(input: {
    args: unknown[];
    functionCallId?: string;
    path: string[];
    scriptExecutionId?: string;
  }): Promise<unknown>;
  receiveFunctionCallResult(input: {
    functionCallId: string;
    outcome:
      | { status: "returned"; value: unknown }
      | {
          status: "threw";
          error: unknown;
        };
    functionPath: string[];
    invocationKind: "event" | "rpc";
    path: string[];
    providerPath: string[];
    scriptExecutionId?: string;
  }): Promise<{ event: Event }>;
  createSession(input?: { code?: string; events?: EventInput[] }): Promise<{
    appendedEvents: Event[];
    registeredProviderEvents: Event[];
    scriptExecutionEvent: Event | null;
    streamPath: StreamPath;
  }>;
  afterAppend(input: { event: Event }): Promise<StreamProcessorRunnerState<unknown>>;
  ensureLiveConsumer(): Promise<void>;
  getRunnerState(): Promise<StreamProcessorRunnerState<unknown>>;
  initialize(params: { name: string }): Promise<unknown>;
  registerToolProvider(input: { provider: ToolProviderRegistration }): Promise<Event>;
};

type TestEnv = {
  CODEMODE_SESSION: DurableObjectNamespace<CodemodeSession>;
  STREAM: Env["STREAM"];
};

const projectId = "proj__test__codemodesession";
const activeOrganization = {
  orgId: "org__codemode_session_test",
  orgPermissions: [],
  orgRole: "admin",
  orgSlug: "codemode-session-test",
  sessionId: "sess__codemode_session_test",
  userId: "user__codemode_session_test",
};

describe("CodemodeSession", () => {
  test("createSession returns after appending a slow script request", async () => {
    const streamPath = `/codemode-session-tests/${crypto.randomUUID()}` as StreamPath;
    const session = await initializeSession(streamPath);
    const start = performance.now();

    const result = await session.createSession({
      code: `async () => {
  await new Promise((resolve) => setTimeout(resolve, 8_000));
  return "done";
}`,
    });

    expect(performance.now() - start).toBeLessThan(4_000);
    expect(result.scriptExecutionEvent).toMatchObject({
      type: "events.iterate.com/codemode/script-execution-requested",
      payload: expect.objectContaining({
        code: expect.stringContaining("setTimeout"),
        scriptExecutionId: expect.any(String),
      }),
    });
  });

  test("registerToolProvider appends model-visible provider documentation", async () => {
    const streamPath = `/codemode-session-tests/${crypto.randomUUID()}` as StreamPath;
    const session = await initializeSession(streamPath);
    const provider = providerRegistration(["providerA"]);

    const event = await session.registerToolProvider({ provider });

    expect(event).toMatchObject({
      payload: provider,
      type: "events.iterate.com/codemode/tool-provider-registered",
    });
  });

  test("callFunction appends a function-call-requested event", async () => {
    const streamPath = `/codemode-session-tests/${crypto.randomUUID()}` as StreamPath;
    const session = await initializeSession(streamPath);
    await session.registerToolProvider({ provider: providerRegistration(["providerA"]) });

    const call = session.callFunction({
      args: [{ value: "provider a called provider b" }],
      functionCallId: "fn-test",
      path: ["providerA", "compose", "exclaimViaB"],
      scriptExecutionId: "scr-test",
    });

    await waitFor(async () =>
      (await readCurrentStreamEvents(streamPath)).some(
        (event) =>
          event.type === "events.iterate.com/codemode/function-call-requested" &&
          event.payload.functionCallId === "fn-test",
      ),
    );
    expect(await readCurrentStreamEvents(streamPath)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "events.iterate.com/codemode/function-call-requested",
          payload: expect.objectContaining({
            args: [{ value: "provider a called provider b" }],
            functionCallId: "fn-test",
            functionPath: ["compose", "exclaimViaB"],
            invocationKind: "event",
            path: ["providerA", "compose", "exclaimViaB"],
            providerPath: ["providerA"],
          }),
        }),
      ]),
    );

    await session.receiveFunctionCallResult({
      functionCallId: "fn-test",
      functionPath: ["compose", "exclaimViaB"],
      invocationKind: "event",
      outcome: { status: "returned", value: { ok: true } },
      path: ["providerA", "compose", "exclaimViaB"],
      providerPath: ["providerA"],
      scriptExecutionId: "scr-test",
    });
    await expect(call).resolves.toEqual({ ok: true });
  });

  test("receiveFunctionCallResult appends a serialized function-call-completed event", async () => {
    const streamPath = `/codemode-session-tests/${crypto.randomUUID()}` as StreamPath;
    const session = await initializeSession(streamPath);

    const result = await session.receiveFunctionCallResult({
      functionCallId: "fn-test",
      outcome: {
        status: "returned",
        value: () => "live callback",
      },
      functionPath: ["callbacks", "make"],
      invocationKind: "event",
      path: ["providerA", "callbacks", "make"],
      providerPath: ["providerA"],
      scriptExecutionId: "scr-test",
    });

    expect(result.event).toMatchObject({
      payload: {
        functionCallId: "fn-test",
        functionPath: ["callbacks", "make"],
        invocationKind: "event",
        outcome: {
          status: "returned",
          value: {
            kind: "live-value",
            type: "function",
          },
        },
        path: ["providerA", "callbacks", "make"],
        providerPath: ["providerA"],
        scriptExecutionId: "scr-test",
      },
      type: "events.iterate.com/codemode/function-call-completed",
    });
  });

  test("callable stream subscription delivers direct appends to afterAppend", async () => {
    const streamPath = `/codemode-session-tests/${crypto.randomUUID()}` as StreamPath;
    const session = await initializeSession(streamPath);
    await session.ensureLiveConsumer();
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: (env as TestEnv).STREAM,
      namespace: projectId,
      path: streamPath,
    });
    expect(await stream.getState()).toMatchObject({
      processors: {
        "external-subscriber": {
          subscribersBySlug: expect.objectContaining({
            [`codemode-session:${sessionName({ projectId, streamPath })}`]: expect.objectContaining(
              {
                type: "callable",
              },
            ),
          }),
        },
      },
    });

    const event = await stream.append({
      type: "events.iterate.com/codemode/tool-provider-registered",
      payload: providerRegistration(["providerA"]),
    });

    await waitFor(async () => {
      const state = await session.getRunnerState();
      return state.afterAppendCompletedThroughOffset >= event.offset;
    });

    const runnerState = await session.getRunnerState();
    expect(runnerState.afterAppendCompletedThroughOffset).toBeGreaterThanOrEqual(event.offset);
    expect(runnerState.reducedThroughOffset).toBeGreaterThanOrEqual(event.offset);
  });

  test("runs loopback RPC capability examples with live handles and callbacks", async () => {
    const streamPath = `/codemode-session-tests/${crypto.randomUUID()}` as StreamPath;
    const session = await initializeSession(streamPath);

    const created = await session.createSession({
      events: codemodeSessionStartupEvents({ providers: exampleCapabilityProviders(), streamPath }),
      code: `async (ctx) => {
  const ai = await ctx.ai.run("test-model", { prompt: "hello" });
  const repos = await ctx.repos.list({});
  await ctx.workspace.writeFile("/loopback-rpc-workspace.txt", "workspace from test\\n");
  const workspace = await ctx.workspace.readFile("/loopback-rpc-workspace.txt");
  const agent = await ctx.agents.create().sendMessage({
    message: "hi",
    subPath: "bob",
	  });
	  const procedures = await ctx.os.listProcedures();
	  const streams = await ctx.os.streams.list({});
	  const sessions = await ctx.os.codemode.listSessions({});

	  return { ai, repos, workspace, agent, procedures, sessions, streams };
	}`,
    });
    const scriptExecutionId = scriptExecutionIdFromEvent(created.scriptExecutionEvent);
    const completed = await waitForScriptExecutionCompleted({ scriptExecutionId, streamPath });

    expect(completed.payload).toMatchObject({
      outcome: {
        status: "returned",
        value: {
          ai: expect.objectContaining({ model: "test-model" }),
          agent: expect.objectContaining({ message: "hi", subPath: "bob" }),
          procedures: expect.stringContaining("interface CodemodeExecutionContext"),
          repos: [],
          sessions: expect.objectContaining({ sessions: expect.any(Array) }),
          streams: expect.objectContaining({ streams: expect.any(Array) }),
          workspace: "workspace from test\n",
        },
      },
    });
    expect(await readCurrentStreamEvents(streamPath)).toEqual(
      expect.arrayContaining([
        functionCallRequested(["ai", "run"], ["ai"], ["run"]),
        functionCallRequested(["repos", "list"], ["repos"], ["list"]),
        functionCallCompleted(["repos", "list"], ["repos"], ["list"]),
        functionCallRequested(["workspace", "writeFile"], ["workspace"], ["writeFile"]),
        functionCallRequested(["workspace", "readFile"], ["workspace"], ["readFile"]),
        functionCallRequested(["agents", "create"], ["agents", "create"], []),
        functionCallRequested(["os", "streams", "list"], ["os"], ["streams", "list"]),
        functionCallRequested(
          ["os", "codemode", "listSessions"],
          ["os"],
          ["codemode", "listSessions"],
        ),
      ]),
    );
    const procedures = completed.payload.outcome.value.procedures;
    expect(procedures).toContain("listSessions");
    expect(procedures).not.toContain("projectSlugOrId");
  });

  test("runs the project capability env example with pipelined nested RPC", async () => {
    const streamPath = `/codemode-session-tests/${crypto.randomUUID()}` as StreamPath;
    const session = await initializeSession(streamPath);
    const example = findCodemodeExample("project-capability-pipelining");
    if (!example) throw new Error("Expected project-capability-pipelining codemode example.");
    const script = example.scripts[0];
    if (!script) throw new Error("Expected project-capability-pipelining to have a script.");

    const created = await session.createSession({
      events: codemodeSessionStartupEvents({
        events: example.events,
        providers: providersForCodemodeExample({ example, projectId }),
        streamPath,
      }),
      code: script.code,
    });
    const scriptExecutionId = scriptExecutionIdFromEvent(created.scriptExecutionEvent);
    const completed = await waitForScriptExecutionCompleted({ scriptExecutionId, streamPath });

    expect(completed.payload).toMatchObject({
      outcome: {
        status: "returned",
        value: {
          agentMessage: "hello from env project",
          agentThing: {
            doubled: 42,
            label: "project-pipeline",
            value: 21,
          },
          aiModel: "test-model",
          batchAppendCount: 2,
          eventMessages: expect.arrayContaining([
            "project capability direct stream append",
            "project capability batch append one",
            "project capability batch append two",
            "project capability lowercase env alias",
          ]),
          proceduresIncludeStreams: true,
          repoCount: expect.any(Number),
          streamInitialized: true,
        },
      },
    });
  });

  test("runs default workspace state and git shell operations", async () => {
    const streamPath = `/codemode-session-tests/${crypto.randomUUID()}` as StreamPath;
    const session = await initializeSession(streamPath);

    const created = await session.createSession({
      events: codemodeSessionStartupEvents({ providers: [], streamPath }),
      code: `async (ctx) => {
  await ctx.workspace.writeFile("/README.md", "# Workspace shell test\\n");
  const text = await ctx.workspace.readFile("/README.md");
  const initialized = await ctx.workspace.git.init({ dir: "/", defaultBranch: "main" });
  await ctx.workspace.git.add({ dir: "/", filepath: "README.md" });
  const commit = await ctx.workspace.git.commit({
    dir: "/",
    message: "Add workspace shell README",
    author: { name: "Workspace Test", email: "workspace-test@iterate.com" },
  });
  const status = await ctx.workspace.git.status({ dir: "/" });

  return { commit, initialized, status, text };
}`,
    });
    const scriptExecutionId = scriptExecutionIdFromEvent(created.scriptExecutionEvent);
    const completed = await waitForScriptExecutionCompleted({ scriptExecutionId, streamPath });

    expect(completed.payload).toMatchObject({
      outcome: {
        status: "returned",
        value: {
          commit: {
            message: "Add workspace shell README",
            oid: expect.any(String),
          },
          initialized: { initialized: "/" },
          status: [],
          text: "# Workspace shell test\n",
        },
      },
    });
    expect(await readCurrentStreamEvents(streamPath)).toEqual(
      expect.arrayContaining([
        functionCallRequested(["workspace", "writeFile"], ["workspace"], ["writeFile"]),
        functionCallCompleted(["workspace", "writeFile"], ["workspace"], ["writeFile"]),
        functionCallRequested(["workspace", "readFile"], ["workspace"], ["readFile"]),
        functionCallRequested(["workspace", "git", "init"], ["workspace"], ["git", "init"]),
        functionCallCompleted(["workspace", "git", "init"], ["workspace"], ["git", "init"]),
        functionCallRequested(["workspace", "git", "commit"], ["workspace"], ["git", "commit"]),
        functionCallCompleted(["workspace", "git", "commit"], ["workspace"], ["git", "commit"]),
      ]),
    );
  });

  test("rejects caller supplied project identity in codemode ctx.os calls", async () => {
    const streamPath = `/codemode-session-tests/${crypto.randomUUID()}` as StreamPath;
    const session = await initializeSession(streamPath);

    const created = await session.createSession({
      events: codemodeSessionStartupEvents({ providers: exampleCapabilityProviders(), streamPath }),
      code: `async (ctx) => {
  return await ctx.os.streams.list({ projectSlugOrId: "proj__other" });
}`,
    });
    const scriptExecutionId = scriptExecutionIdFromEvent(created.scriptExecutionEvent);
    const completed = await waitForScriptExecutionCompleted({ scriptExecutionId, streamPath });

    expect(completed.payload).toMatchObject({
      outcome: {
        error: expect.stringContaining("projectSlugOrId"),
        status: "threw",
      },
    });
  });

  test("runs ordinary JavaScript control flow while mixing codemode providers", async () => {
    const streamPath = `/codemode-session-tests/${crypto.randomUUID()}` as StreamPath;
    const session = await initializeSession(streamPath);
    const example = findCodemodeExample("javascript-control-flow-mix");
    if (!example) throw new Error("Expected javascript-control-flow-mix codemode example.");
    const script = example.scripts[0];
    if (!script) throw new Error("Expected javascript-control-flow-mix to have a script.");

    const created = await session.createSession({
      events: codemodeSessionStartupEvents({
        providers: providersForCodemodeExample({ example, projectId }),
        streamPath,
      }),
      code: script.code,
    });
    const scriptExecutionId = scriptExecutionIdFromEvent(created.scriptExecutionEvent);
    const completed = await waitForScriptExecutionCompleted({ scriptExecutionId, streamPath });

    expect(completed.payload).toMatchObject({
      outcome: {
        status: "returned",
        value: {
          body: { hello: "codemode" },
          caughtMessage: "expected example failure",
          hasStreamsListProcedure: true,
          raced: "fast",
          ticks: ["tick-1", "tick-2", "tick-3"],
        },
      },
    });
    expect(await readCurrentStreamEvents(streamPath)).toEqual(
      expect.arrayContaining([
        functionCallRequested(["fetch"], ["fetch"], []),
        functionCallRequested(["os", "listProcedures"], ["os"], ["listProcedures"]),
        functionCallRequested(["streams", "append"], ["streams"], ["append"]),
        expect.objectContaining({
          type: "events.iterate.com/codemode/example-note",
          payload: { message: "appended from javascript-control-flow-mix" },
        }),
        expect.objectContaining({
          type: "events.iterate.com/codemode/log-emitted",
          payload: expect.objectContaining({ level: "log", message: "interval tick 1" }),
        }),
        expect.objectContaining({
          type: "events.iterate.com/codemode/log-emitted",
          payload: expect.objectContaining({
            level: "warn",
            message: "caught and kept going expected example failure",
          }),
        }),
        expect.objectContaining({
          type: "events.iterate.com/codemode/log-emitted",
          payload: expect.objectContaining({
            level: "error",
            message: "error log channel still does not fail the script",
          }),
        }),
      ]),
    );
  });

  test("lets an event-mediated provider use session-started to call another provider", async () => {
    const streamPath = `/codemode-session-tests/${crypto.randomUUID()}` as StreamPath;
    const session = await initializeSession(streamPath);

    const created = await session.createSession({
      events: codemodeSessionStartupEvents({
        providers: [providerRegistration(["discord"]), providerRegistration(["mirrorSlack"])],
        streamPath,
      }),
      code: `async (ctx) => {
  return await ctx.discord.announceRelease({
    discordChannelId: "D123",
    slackChannel: "C123",
    version: "v1.2.3",
  });
}`,
    });
    const scriptExecutionId = scriptExecutionIdFromEvent(created.scriptExecutionEvent);

    const discordRequest = await waitForFunctionCallRequested({
      path: ["discord", "announceRelease"],
      streamPath,
    });
    const sessionStarted = (await readCurrentStreamEvents(streamPath)).find(
      (event) => event.type === "events.iterate.com/codemode/session-started",
    );
    expect(sessionStarted?.payload).toMatchObject({
      sessionCapabilityCallable: expect.any(Object),
    });

    // This block is the event-provider proof: a Discord-style stream processor
    // reduces session-started, invokes the Session Capability Callable, builds a
    // Codemode Context, and then calls another event-mediated Tool Function
    // without becoming an RPC provider itself.
    const codemodeSessionCapability = await dispatchCallable({
      callable: (sessionStarted!.payload as { sessionCapabilityCallable: unknown })
        .sessionCapabilityCallable,
      ctx: { env: env as unknown as Record<string, unknown> },
      payload: {},
    });
    const providerCtx = createCodemodeContext({
      codemodeSessionCapability: codemodeSessionCapability as Parameters<
        typeof createCodemodeContext
      >[0]["codemodeSessionCapability"],
      scriptExecutionId,
    });
    const slackCall = providerCtx.mirrorSlack.chat.postMessage({
      channel: "C123",
      text: "Released v1.2.3 to Discord message discord-msg-1",
    });

    const slackRequest = await waitForFunctionCallRequested({
      path: ["mirrorSlack", "chat", "postMessage"],
      streamPath,
    });
    await session.receiveFunctionCallResult({
      functionCallId: String(slackRequest.payload.functionCallId),
      functionPath: ["chat", "postMessage"],
      invocationKind: "event",
      outcome: { status: "returned", value: { ok: true, ts: "123.456" } },
      path: ["mirrorSlack", "chat", "postMessage"],
      providerPath: ["mirrorSlack"],
      scriptExecutionId,
    });
    await expect(slackCall).resolves.toEqual({ ok: true, ts: "123.456" });

    await session.receiveFunctionCallResult({
      functionCallId: String(discordRequest.payload.functionCallId),
      functionPath: ["announceRelease"],
      invocationKind: "event",
      outcome: {
        status: "returned",
        value: {
          discordMessageId: "discord-msg-1",
          mirroredToSlack: true,
        },
      },
      path: ["discord", "announceRelease"],
      providerPath: ["discord"],
      scriptExecutionId,
    });

    const completed = await waitForScriptExecutionCompleted({ scriptExecutionId, streamPath });
    expect(completed.payload).toMatchObject({
      outcome: {
        status: "returned",
        value: {
          discordMessageId: "discord-msg-1",
          mirroredToSlack: true,
        },
      },
    });
    expect(await readCurrentStreamEvents(streamPath)).toEqual(
      expect.arrayContaining([
        functionCallRequestedWithKind(
          ["discord", "announceRelease"],
          ["discord"],
          ["announceRelease"],
          "event",
        ),
        functionCallRequestedWithKind(
          ["mirrorSlack", "chat", "postMessage"],
          ["mirrorSlack"],
          ["chat", "postMessage"],
          "event",
        ),
      ]),
    );
  });

  test("lets codemode helpers register MCP and OpenAPI providers", async () => {
    const streamPath = `/codemode-session-tests/${crypto.randomUUID()}` as StreamPath;
    const session = await initializeSession(streamPath);

    const created = await session.createSession({
      code: `async (ctx) => {
  const mcp = await ctx.codemode.connectToMcpServer({
    path: ["mcp", "custom"],
    url: "https://example.com/mcp",
  });
  const openApi = await ctx.codemode.connectToOpenApiServer({
    path: ["api", "custom"],
    specUrl: "https://example.com/openapi.json",
    baseUrl: "https://example.com",
  });

  return {
    mcpPath: mcp.payload.path,
    openApiPath: openApi.payload.path,
    openApiExportName: openApi.payload.invocation.callable.via.exportName,
  };
}`,
    });
    const scriptExecutionId = scriptExecutionIdFromEvent(created.scriptExecutionEvent);

    const completed = await waitForScriptExecutionCompleted({ scriptExecutionId, streamPath });
    expect(completed.payload).toMatchObject({
      outcome: {
        status: "returned",
        value: {
          mcpPath: ["mcp", "custom"],
          openApiPath: ["api", "custom"],
          openApiExportName: "OpenApiBridge",
        },
      },
    });
    expect(await readCurrentStreamEvents(streamPath)).toEqual(
      expect.arrayContaining([
        functionCallRequested(
          ["codemode", "connectToMcpServer"],
          ["codemode"],
          ["connectToMcpServer"],
        ),
        expect.objectContaining({
          type: "events.iterate.com/codemode/tool-provider-registered",
          payload: expect.objectContaining({
            path: ["mcp", "custom"],
          }),
        }),
        functionCallRequested(
          ["codemode", "connectToOpenApiServer"],
          ["codemode"],
          ["connectToOpenApiServer"],
        ),
        expect.objectContaining({
          type: "events.iterate.com/codemode/tool-provider-registered",
          payload: expect.objectContaining({
            path: ["api", "custom"],
          }),
        }),
      ]),
    );
  });

  test("lets an outbound-only browser extension provider call builtin session debug tools", async () => {
    const streamPath = `/codemode-session-tests/${crypto.randomUUID()}` as StreamPath;
    const session = await initializeSession(streamPath);

    const created = await session.createSession({
      events: codemodeSessionStartupEvents({
        providers: [providerRegistration(["iterateBrowserExtension"])],
        streamPath,
      }),
      code: `async (ctx) => {
  const ping = await ctx.codemode.ping();
  const navigation = await ctx.iterateBrowserExtension.navigateToPage({
    url: "https://example.com",
  });
  return { ping, navigation };
}`,
    });
    const scriptExecutionId = scriptExecutionIdFromEvent(created.scriptExecutionEvent);

    const navigationRequest = await waitForFunctionCallRequested({
      path: ["iterateBrowserExtension", "navigateToPage"],
      streamPath,
    });
    const sessionStarted = (await readCurrentStreamEvents(streamPath)).find(
      (event) => event.type === "events.iterate.com/codemode/session-started",
    );

    // This models an outbound-only provider such as a browser extension,
    // OpenClaw plugin, or Chrome tab automation runner. The provider can poll
    // the stream and append completion events over fetch. If there is a
    // Worker-side bridge available, it can also reduce session-started, invoke
    // the Session Capability Callable, and build a Codemode Context for calling
    // other session functions. The actual pure-fetch bridge is future work; the
    // event pair and session capability are the contract being proved here.
    const codemodeSessionCapability = await dispatchCallable({
      callable: (sessionStarted!.payload as { sessionCapabilityCallable: unknown })
        .sessionCapabilityCallable,
      ctx: { env: env as unknown as Record<string, unknown> },
      payload: {},
    });
    const providerCtx = createCodemodeContext({
      codemodeSessionCapability: codemodeSessionCapability as Parameters<
        typeof createCodemodeContext
      >[0]["codemodeSessionCapability"],
      scriptExecutionId,
    });
    const debugInfo = await providerCtx.codemode.debugInfo({
      provider: "iterateBrowserExtension",
      reason: "navigateToPage completed from outbound-only provider",
    });
    expect(debugInfo).toMatchObject({
      functionPath: ["debugInfo"],
      invocationKind: "rpc",
      path: ["codemode", "debugInfo"],
      providerPath: ["codemode"],
      scriptExecutionId,
      streamPath,
    });

    await session.receiveFunctionCallResult({
      functionCallId: String(navigationRequest.payload.functionCallId),
      functionPath: ["navigateToPage"],
      invocationKind: "event",
      outcome: {
        status: "returned",
        value: {
          debugInfo,
          navigatedTo: "https://example.com",
          provider: "iterateBrowserExtension",
        },
      },
      path: ["iterateBrowserExtension", "navigateToPage"],
      providerPath: ["iterateBrowserExtension"],
      scriptExecutionId,
    });

    const completed = await waitForScriptExecutionCompleted({ scriptExecutionId, streamPath });
    expect(completed.payload).toMatchObject({
      outcome: {
        status: "returned",
        value: {
          ping: "pong",
          navigation: {
            navigatedTo: "https://example.com",
            provider: "iterateBrowserExtension",
          },
        },
      },
    });
    expect(await readCurrentStreamEvents(streamPath)).toEqual(
      expect.arrayContaining([
        functionCallRequested(["codemode", "ping"], ["codemode"], ["ping"]),
        functionCallCompleted(["codemode", "ping"], ["codemode"], ["ping"]),
        functionCallRequestedWithKind(
          ["iterateBrowserExtension", "navigateToPage"],
          ["iterateBrowserExtension"],
          ["navigateToPage"],
          "event",
        ),
        functionCallRequested(["codemode", "debugInfo"], ["codemode"], ["debugInfo"]),
        functionCallCompleted(["codemode", "debugInfo"], ["codemode"], ["debugInfo"]),
      ]),
    );
  });
});

async function initializeSession(streamPath: StreamPath) {
  const name = sessionName({ projectId, streamPath });
  const session = (env as TestEnv).CODEMODE_SESSION.getByName(
    name,
  ) as unknown as CodemodeSessionStub;

  await session.initialize({
    name,
  });
  return session;
}

function sessionName(input: { projectId: string; streamPath: StreamPath }) {
  return deriveDurableObjectNameFromStructuredName({
    structuredName: { projectId: input.projectId, streamPath: input.streamPath },
  });
}

function providerRegistration(path: string[]): ToolProviderRegistration {
  return {
    instructions: `Provider ${path.join(".")} is available for codemode scripts.`,
    invocation: { kind: "event" },
    path,
  };
}

function scriptExecutionIdFromEvent(event: Event | null) {
  if (event == null) {
    throw new Error("Expected createSession to append a script execution event.");
  }
  const scriptExecutionId = (event.payload as { scriptExecutionId?: unknown }).scriptExecutionId;
  if (typeof scriptExecutionId !== "string") {
    throw new Error("Script execution event is missing scriptExecutionId.");
  }
  return scriptExecutionId;
}

function exampleCapabilityProviders(): ToolProviderRegistration[] {
  return [
    createExampleRpcProviderRegistration({
      exportName: "AiCapability",
      instructions: "Use ctx.ai.run(model, input) to call the Workers AI binding.",
      path: ["ai"],
      projectId,
    }),
    createExampleRpcProviderRegistration({
      exportName: "ReposCapability",
      instructions:
        "Use ctx.repos.create({ slug }) to create a Repo, ctx.repos.get({ slug }).getInfo() to inspect one, and ctx.repos.list({}) to list Repos.",
      path: ["repos"],
      projectId,
    }),
    createExampleRpcProviderRegistration({
      exportName: "AgentCapability",
      instructions: "Use ctx.agents.create() to get a subagent handle.",
      path: ["agents", "create"],
      projectId,
    }),
    createExampleRpcProviderRegistration({
      exportName: "OrpcCapability",
      activeOrganization,
      instructions: "Use ctx.os.listProcedures() and ctx.os.streams.list({}).",
      path: ["os"],
      projectId,
    }),
  ];
}

function codemodeSessionStartupEvents(input: {
  events?: EventInput[];
  providers: ToolProviderRegistration[];
  streamPath: StreamPath;
}) {
  return createCodemodeSessionStartupEvents({
    events: input.events ?? [],
    projectId,
    providers: input.providers,
    streamPath: input.streamPath,
  });
}

function functionCallRequested(path: string[], providerPath: string[], functionPath: string[]) {
  return functionCallRequestedWithKind(path, providerPath, functionPath, "rpc");
}

function functionCallRequestedWithKind(
  path: string[],
  providerPath: string[],
  functionPath: string[],
  invocationKind: "event" | "rpc",
) {
  return expect.objectContaining({
    type: "events.iterate.com/codemode/function-call-requested",
    payload: expect.objectContaining({
      functionPath,
      invocationKind,
      path,
      providerPath,
    }),
  });
}

function functionCallCompleted(path: string[], providerPath: string[], functionPath: string[]) {
  return expect.objectContaining({
    type: "events.iterate.com/codemode/function-call-completed",
    payload: expect.objectContaining({
      functionPath,
      invocationKind: "rpc",
      outcome: expect.objectContaining({ status: "returned" }),
      path,
      providerPath,
    }),
  });
}

async function waitForScriptExecutionCompleted(input: {
  scriptExecutionId: string;
  streamPath: StreamPath;
}) {
  let completed: Event | undefined;
  await waitFor(async () => {
    completed = (await readCurrentStreamEvents(input.streamPath)).find(
      (event) =>
        event.type === "events.iterate.com/codemode/script-execution-completed" &&
        event.payload.scriptExecutionId === input.scriptExecutionId,
    );
    return completed != null;
  });
  return completed!;
}

async function waitForFunctionCallRequested(input: { path: string[]; streamPath: StreamPath }) {
  let requested: Event | undefined;
  await waitFor(async () => {
    requested = (await readCurrentStreamEvents(input.streamPath)).find(
      (event) =>
        event.type === "events.iterate.com/codemode/function-call-requested" &&
        JSON.stringify(event.payload.path) === JSON.stringify(input.path),
    );
    return requested != null;
  });
  return requested!;
}

async function readCurrentStreamEvents(streamPath: StreamPath) {
  const stream = await getInitializedStreamStub({
    durableObjectNamespace: (env as TestEnv).STREAM,
    namespace: projectId,
    path: streamPath,
  });
  const events = await stream.history({ before: "end" });
  return events.filter((event) => event.type.startsWith("events.iterate.com/codemode/"));
}

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("Timed out waiting for condition.");
}
