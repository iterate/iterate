import { expect, test } from "vitest";
import type { Agent, AgentChat, CapabilityHost } from "../../src/itx-api.generated.ts";
import { defineItxScript, itxScript } from "../test-support/itx-script-builder.ts";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import {
  AGENT_CONTEXT_ADDED_TYPE,
  AGENT_WEB_MESSAGE_SENT_TYPE,
  appendSyntheticProviderOutput,
  fencedAgentScript,
  inlineJsSource,
} from "./itx-test-support.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

// These are hand written tests - they MUST pass
test("Agent scripts update their own status record via itx.agent.setStatus", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });

  using project = itx.projects.create({ slug: "agent-set-status" });
  const agentPath = `/agents/set-status-${crypto.randomUUID()}`;
  using agent = project.agents.get(agentPath);

  const statusPatch = agent.stream.waitForEvent({
    eventTypes: ["events.iterate.com/agent/status-changed"],
    predicate: (event) =>
      (event.payload as { title?: string } | undefined)?.title === "Lisbon trip",
    timeoutMs: 30_000,
  });

  await appendSyntheticProviderOutput(
    agent.stream,
    fencedAgentScript(
      defineItxScript<{ agent: Agent }>(async (itx) => {
        await itx.agent.setStatus({
          title: "Lisbon trip",
          note: "Planning a 3-day Lisbon trip.",
          shortStatus: "comparing flights",
        });
      }).code,
    ),
  );

  expect(await statusPatch).toMatchObject({
    type: "events.iterate.com/agent/status-changed",
    payload: {
      title: "Lisbon trip",
      note: "Planning a 3-day Lisbon trip.",
      shortStatus: "comparing flights",
    },
  });

  // The merged record lands in the agent's reduced state (announcedStatus),
  // which is what the project roster and every painter read.
  await waitForCondition(
    async () => {
      const snapshot = await agent.processor.snapshot();
      const announced = (snapshot.state as { announcedStatus?: { title?: string } })
        .announcedStatus;
      return announced?.title === "Lisbon trip";
    },
    { description: "announcedStatus.title folded into agent state", timeoutMs: 30_000 },
  );
});

test("Agent scripts can send web-chat messages (with file attachments) and call project tools", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });

  using project = itx.projects.create({ slug: "agent-project-tool" });
  const agentPath = `/agents/project-tool-${crypto.randomUUID()}`;
  using agent = project.agents.get(agentPath);

  using _projectToolProvision = await project.provideCapability({
    path: ["projectTool"],
    type: "live",
    capability: {
      format(input: { text: string }) {
        return `project tool saw ${input.text}`;
      },
    },
  });

  const projectToolReply = agent.stream.waitForEvent({
    eventTypes: [AGENT_WEB_MESSAGE_SENT_TYPE],
    predicate: (event) => event.payload?.message === "project tool saw project-capability",
    timeoutMs: 30_000,
  });
  const filesOptionReply = agent.stream.waitForEvent({
    eventTypes: [AGENT_WEB_MESSAGE_SENT_TYPE],
    predicate: (event) => event.payload?.message === "string form with files",
    timeoutMs: 30_000,
  });

  const { llmRequestOffset } = await appendSyntheticProviderOutput(
    agent.stream,
    fencedAgentScript(
      defineItxScript<{
        projectTool: { format(input: { text: string }): Promise<string> };
        chat: AgentChat;
      }>(async (itx) => {
        const message = await itx.projectTool.format({ text: "project-capability" });
        await itx.chat.sendMessage(message);
        // The way to attach files: the options second argument.
        await itx.chat.sendMessage("string form with files", {
          files: [{ filename: "note.txt", contentType: "text/plain", data: "aGVsbG8=" }],
        });
      }).code,
    ),
  );

  expect(await projectToolReply).toMatchObject({
    type: AGENT_WEB_MESSAGE_SENT_TYPE,
    payload: { message: "project tool saw project-capability" },
  });
  expect(await filesOptionReply).toMatchObject({
    type: AGENT_WEB_MESSAGE_SENT_TYPE,
    payload: {
      message: "string form with files",
      files: [{ contentType: "text/plain", filename: "note.txt", size: 5 }],
    },
  });

  const events = await agent.stream.getEvents();
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: AGENT_CONTEXT_ADDED_TYPE,
        payload: expect.objectContaining({
          role: "assistant",
          llmRequestOffset,
        }),
      }),
      expect.objectContaining({
        type: "events.iterate.com/capability-host/script-execution-requested",
      }),
      expect.objectContaining({
        type: "events.iterate.com/capability-host/script-execution-completed",
      }),
      expect.objectContaining({ type: AGENT_WEB_MESSAGE_SENT_TYPE }),
    ]),
  );

  const reflectedFilesReply = events.find(
    (event) =>
      event.type === AGENT_CONTEXT_ADDED_TYPE &&
      event.payload?.role === "assistant" &&
      event.payload.content ===
        "The assistant sent this visible web-chat message: string form with files",
  );
  expect(reflectedFilesReply?.payload).toMatchObject({ role: "assistant" });
  expect(reflectedFilesReply?.payload).not.toHaveProperty("llmRequestOffset");
});

test("New agent streams install processors and replay existing child events", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });

  const marker = `agent-auto-bootstrap-${crypto.randomUUID()}`;
  using project = itx.projects.create({ slug: `agent-auto-bootstrap-${marker}` });
  const agentPath = `/agents/auto-bootstrap-${crypto.randomUUID()}`;
  using agent = project.agents.get(agentPath);

  const content = fencedAgentScript(
    defineItxScript<{ chat: AgentChat }, { marker: string }>(
      async (itx, vars) => {
        await itx.chat.sendMessage(vars.marker);
      },
      { marker },
    ).code,
  );
  const { assistantContext: historicalAssistantContext, llmRequestOffset } =
    await appendSyntheticProviderOutput(agent.stream, content);

  const replayedReply = await agent.stream.waitForEvent({
    afterOffset: historicalAssistantContext.offset,
    eventTypes: [AGENT_WEB_MESSAGE_SENT_TYPE],
    predicate: (event) => event.payload?.message === marker,
    timeoutMs: 30_000,
  });

  expect(replayedReply).toMatchObject({
    type: AGENT_WEB_MESSAGE_SENT_TYPE,
    payload: { message: marker },
  });

  const events = await agent.stream.getEvents({ afterOffset: 0 });
  const assistantContextOffset = events.find(
    (event) =>
      event.type === AGENT_CONTEXT_ADDED_TYPE &&
      event.payload?.role === "assistant" &&
      event.payload?.llmRequestOffset === llmRequestOffset &&
      event.payload?.content === content,
  )?.offset;
  // Processor subscriptions are wake-mode deliveries addressed by itx
  // expression over the ordinary domain surface: { delivery: { mode:
  // "wake", expression: ["agents", ["get", path], "processor",
  // "wakeStreamSubscriber"] } }. The expression ROOT names the host domain.
  const wakeSubscriptionPayload = (event: { payload?: Record<string, unknown> }) =>
    event.payload as {
      subscriptionKey?: string;
      delivery?: { mode?: string; expression?: unknown[] };
    };
  const wakeExpressionRoot = (event: { payload?: Record<string, unknown> }) =>
    wakeSubscriptionPayload(event).delivery?.expression?.[0];
  const agentSubscriptionOffset = events.find(
    (event) =>
      event.type === "events.iterate.com/stream/subscription-configured" &&
      wakeExpressionRoot(event) === "agents" &&
      String(wakeSubscriptionPayload(event).subscriptionKey).endsWith("#agent"),
  )?.offset;
  const itxSubscriptionOffset = events.find(
    (event) =>
      event.type === "events.iterate.com/stream/subscription-configured" &&
      wakeExpressionRoot(event) === "capabilityHosts",
  )?.offset;
  const scriptRequestedOffset = events.find(
    (event) => event.type === "events.iterate.com/capability-host/script-execution-requested",
  )?.offset;
  const modelSelectionOffset = events.find(
    (event) => event.type === "events.iterate.com/agent/llm-provider-selected",
  )?.offset;

  expect(assistantContextOffset).toBe(historicalAssistantContext.offset);
  expect(agentSubscriptionOffset).toBeGreaterThan(historicalAssistantContext.offset);
  expect(itxSubscriptionOffset).toBeGreaterThan(historicalAssistantContext.offset);
  expect(modelSelectionOffset).toBeGreaterThan(historicalAssistantContext.offset);
  expect(scriptRequestedOffset).toBeGreaterThan(agentSubscriptionOffset!);
});

test("Agent-only dynamic worker and durable object capabilities run from LLM scripts", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });

  using project = itx.projects.create({ slug: "agent-only-tools" });
  const { projectId } = await project.__describe();
  const agentPath = `/agents/agent-only-${crypto.randomUUID()}`;
  using agent = project.agents.get(agentPath);
  const durableWorkerKey = `agent-counter-${crypto.randomUUID()}`;

  using _agentProbeProvision = await agent.provideCapability({
    expression: [
      "workers",
      [
        "get",
        {
          entrypoint: "AgentProbeEntrypoint",
          path: agentPath,
          source: inlineJsSource("agent-probe.js", {
            "agent-probe.js": `
                import { WorkerEntrypoint } from "cloudflare:workers";

                export class AgentProbeEntrypoint extends WorkerEntrypoint {
                  async inspect(input) {
                    const itx = await this.env.ITX.get();
                    return {
                      input,
                      projectId: ${JSON.stringify(projectId)},
                      whoami: (await itx.agent.__describe()).whoami,
                    };
                  }
                }
              `,
          }),
          type: "stateless",
        },
      ],
    ],
    path: ["agentProbe"],
    type: "itx-expression",
  });
  using _agentCounterProvision = await agent.provideCapability({
    expression: [
      "workers",
      [
        "get",
        {
          // The seeded stateful app: CounterApp is a named export of the
          // one-file seeded worker.ts.
          className: "CounterApp",
          durableWorkerKey,
          path: agentPath,
          source: {
            files: { repoPath: "/repos/config", type: "repo" },
            options: { entryPoint: "worker.ts" },
          },
          type: "stateful",
        },
      ],
    ],
    path: ["agentCounter"],
    type: "itx-expression",
  });

  await expect(
    // @ts-expect-error - proves agent-provided capabilities are not mounted on the project.
    project.agentProbe.inspect("project should not see this"),
  ).rejects.toThrow(/no capability "agentProbe.inspect"/);

  const scriptReply = agent.stream.waitForEvent({
    eventTypes: [AGENT_WEB_MESSAGE_SENT_TYPE],
    predicate: (event) =>
      typeof event.payload?.message === "string" &&
      event.payload.message.includes(durableWorkerKey),
    timeoutMs: 30_000,
  });

  await appendSyntheticProviderOutput(
    agent.stream,
    fencedAgentScript(
      defineItxScript<
        {
          agentProbe: {
            inspect(input: string): Promise<{ input: string; projectId: string; whoami: string }>;
          };
          agent: Agent & {
            agentCounter: { increment(): Promise<number> };
            capabilityHost: CapabilityHost & { agentCounter: { current(): Promise<number> } };
          };
          chat: AgentChat;
        },
        { durableWorkerKey: string }
      >(
        async (itx, vars) => {
          // Agent-scope capabilities: itx.<cap> is the canonical spelling in
          // your own scope; itx.agent.capabilityHost.<cap> is the explicit
          // handle door; itx.agent.<cap> also works via the handle's
          // prototype-chain fallback. All three dispatch identically —
          // exercise one of each.
          const probe = await itx.agentProbe.inspect("agent-only");
          const first = await itx.agent.agentCounter.increment();
          const current = await itx.agent.capabilityHost.agentCounter.current();
          await itx.chat.sendMessage(
            JSON.stringify({
              durableWorkerKey: vars.durableWorkerKey,
              current,
              first,
              probe,
            }),
          );
        },
        { durableWorkerKey },
      ).code,
    ),
  );

  const event = await scriptReply;
  const message = JSON.parse(String(event.payload?.message)) as {
    current: number;
    durableWorkerKey: string;
    first: number;
    probe: { input: string; projectId: string; whoami: string };
  };
  expect(message).toEqual({
    current: 1,
    durableWorkerKey,
    first: 1,
    probe: {
      input: "agent-only",
      projectId,
      whoami: `agent ${projectId}:${agentPath}`,
    },
  });
});

test("Dynamic worker env.ITX.get() is scoped by project and agent host path", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });

  using project = itx.projects.create({ slug: "dynamic-worker-scope-cache" });
  const { projectId } = await project.__describe();
  const agentPath = `/agents/scope-cache-${crypto.randomUUID()}`;
  using agent = project.agents.get(agentPath);
  const scopeProbeWorkerRef = (path: string) => ({
    entrypoint: "ScopeProbeEntrypoint",
    path,
    source: inlineJsSource("scope-probe.js", {
      "scope-probe.js": `
          import { WorkerEntrypoint } from "cloudflare:workers";

          export class ScopeProbeEntrypoint extends WorkerEntrypoint {
            async projectScope() {
              const itx = await this.env.ITX.get();
              const description = await itx.__describe();
              return { kind: "project", projectId: description.projectId };
            }

            async agentScope() {
              const itx = await this.env.ITX.get();
              return { kind: "agent", whoami: (await itx.agent.__describe()).whoami };
            }
          }
        `,
    }),
    type: "stateless" as const,
  });

  using _projectScopeProbeProvision = await project.provideCapability({
    expression: ["workers", ["get", scopeProbeWorkerRef("/")]],
    path: ["scopeProbe"],
    type: "itx-expression",
  });
  using _agentScopeProbeProvision = await agent.provideCapability({
    expression: ["workers", ["get", scopeProbeWorkerRef(agentPath)]],
    path: ["scopeProbe"],
    type: "itx-expression",
  });

  // @ts-expect-error - dynamic project capability mounted by this test.
  expect(await project.scopeProbe.projectScope()).toEqual({ kind: "project", projectId });
  // The handle's dynamic capabilities: dispatched by the prototype-chain
  // fallback (agent.scopeProbe...) or the explicit capabilityHost door —
  // this exercises the explicit spelling.
  // @ts-expect-error - dynamic agent capability mounted by this test.
  expect(await agent.capabilityHost.scopeProbe.agentScope()).toEqual({
    kind: "agent",
    whoami: `agent ${projectId}:${agentPath}`,
  });
});

test('An agent scope provides a capability to the whole project via capabilityHosts.get("/")', async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });

  using project = itx.projects.create({ slug: "cross-scope-provide" });
  await project.__describe();
  const agentPath = `/agents/cross-scope-${crypto.randomUUID()}`;
  using agent = project.agents.get(agentPath);

  // The provide runs INSIDE the agent scope: the script's `itx` fronts the
  // agent's own capability host and mounts on the project root by addressing
  // it through `capabilityHosts.get("/")`.
  const executed = await itxScript(agent.capabilityHost)
    .context<{ crossScopeProbe: { ping(): Promise<string> } }>()
    .execute(async (itx) => {
      // capabilityHosts.get() pipelines; a handle is kept here only because
      // the script calls the root host twice (provide + invoke below).
      const host = await itx.capabilityHosts.get("/");
      const provision = await host.provideCapability({
        type: "live",
        path: ["crossScopeProbe"],
        capability: { ping: () => "pong-from-agent-mount" },
      });
      // Visible on the root host itself, and through the agent scope's own
      // inheritance chain (local miss -> parent -> root).
      const viaRoot = await host.invokeCapability({
        path: ["crossScopeProbe", "ping"],
        args: [],
      });
      const viaChain = await itx.crossScopeProbe.ping();
      const describedScopes = (await itx.capabilityHost.__describe()).capabilities
        .filter((capability) => capability.path.join(".") === "crossScopeProbe")
        .map((capability) => capability.scope);
      await provision.revoke();
      return { viaRoot, viaChain, describedScopes };
    });

  expect(executed.success()).toEqual({
    viaRoot: "pong-from-agent-mount",
    viaChain: "pong-from-agent-mount",
    describedScopes: ["/"],
  });
});

test("Project worker births agents: policy from itx.agents.defaults, appended by the seeded template", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });

  using project = itx.projects.create({ slug: "worker-births-agents" });
  const agentPath = `/agents/policy-probe-${crypto.randomUUID()}`;
  using agentStream = project.streams.get(agentPath);

  // Wait for the policy BEFORE materializing the stream, so the birth
  // reaction (worker sees child-stream-created on "/") races nothing.
  const systemContext = agentStream.waitForEvent({
    eventTypes: [AGENT_CONTEXT_ADDED_TYPE],
    predicate: (event) =>
      event.payload?.role === "system" && event.payload?.key === "agent/system-prompt",
    timeoutMs: 60_000,
  });
  const providerSelected = agentStream.waitForEvent({
    eventTypes: ["events.iterate.com/agent/llm-provider-selected"],
    timeoutMs: 60_000,
  });
  const workspaceMount = agentStream.waitForEvent({
    eventTypes: ["events.iterate.com/capability-host/capability-provided"],
    timeoutMs: 60_000,
  });
  // Policy (worker) and mechanics (project processor) are appended by two
  // INDEPENDENT reactors to the same child-stream-created announcement —
  // policy arriving says nothing about the mechanics batch. Await the batch
  // itself: it is one atomic append, so its capability-host member visible
  // means all four are.
  const mechanics = agentStream.waitForEvent({
    eventTypes: ["events.iterate.com/stream/subscription-configured"],
    predicate: (event) => event.idempotencyKey?.endsWith("#capability-host") ?? false,
    timeoutMs: 60_000,
  });

  // Any append materializes the agent stream; the platform announces it on
  // the root stream, the project worker reacts with the defaults batch.
  await agentStream.append({
    type: "events.iterate.test/agent-policy-probe",
    payload: {},
  });

  const systemContextEvent = await systemContext;
  expect(systemContextEvent.payload?.content).toContain("async (itx)");
  expect((await providerSelected).payload).toMatchObject({ ifUnset: true });
  expect((await workspaceMount).payload).toMatchObject({ path: ["workspace"] });
  await mechanics;

  // Birth mechanics: project-worker (every project stream) + agent processor +
  // capability-host. One agent processor owns history, scheduling, and the
  // Workers AI call — no separate LLM provider processors. The mechanics come
  // from the project processor's serialized lane (queued behind the worker
  // probe), so they can land AFTER the pump-delivered policy above — wait
  // for them instead of snapshotting the instant policy arrives.
  const mechanicsDeadline = Date.now() + 60_000;
  let subscriptionCount = 0;
  let processorSlugs: string[] = [];
  for (;;) {
    const events = await agentStream.getEvents({ afterOffset: 0 });
    const subscriptions = events.filter(
      (event) => event.type === "events.iterate.com/stream/subscription-configured",
    );
    subscriptionCount = subscriptions.length;
    processorSlugs = subscriptions
      .map(
        (event) =>
          (event.payload as { delivery?: { processorSlug?: string } } | undefined)?.delivery
            ?.processorSlug,
      )
      .filter((slug): slug is string => typeof slug === "string");
    if (processorSlugs.includes("agent") && processorSlugs.includes("capability-host")) break;
    if (Date.now() > mechanicsDeadline) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  expect(processorSlugs).toEqual(expect.arrayContaining(["agent", "capability-host"]));
  expect(subscriptionCount).toBeGreaterThanOrEqual(3);
});

test("Project worker processEventBatch receives events from every project stream and can cross-post", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });

  using project = itx.projects.create({ slug: "project-worker-process-event" });
  const marker = `cross-post-${crypto.randomUUID()}`;
  // NOT the root stream: every project stream self-configures the
  // project-worker push feed at birth, so a freshly minted child stream must
  // reach the worker with no wiring at all.
  const sourcePath = `/sources/ping-${crypto.randomUUID()}`;

  await project.repo.commitFiles({
    changes: [
      {
        path: "worker.ts",
        content: `
            import { WorkerEntrypoint } from "cloudflare:workers";

            export default class ProjectWorker extends WorkerEntrypoint {
              fetch() {
                return new Response("ok");
              }

              async processEventBatch(batch) {
                for (const event of batch.events) await this.processEvent(event);
              }

              async processEvent(event) {
                if (event.metadata?.crossPostMarker !== ${JSON.stringify(marker)}) return;

                const project = await this.env.ITX.get();
                await project.streams.get("/cross-posted").append({
                  type: "events.iterate.com/test/cross-posted",
                  idempotencyKey: \`project-worker-cross-post:\${event.path}@\${event.offset}\`,
                  metadata: {
                    crossPostedBy: "project-worker",
                    marker: event.metadata.crossPostMarker,
                    sourceOffset: event.offset,
                    sourcePath: event.path,
                  },
                  payload: {
                    originalPayload: event.payload ?? null,
                    originalType: event.type,
                  },
                });
              }
            }
          `,
      },
    ],
    message: "Cross-post selected project events from processEventBatch",
  });

  const crossPosted = project.streams.get("/cross-posted");
  const copied = crossPosted.waitForEvent({
    eventTypes: ["events.iterate.com/test/cross-posted"],
    timeoutMs: 30_000,
  });

  const [sourceEvent] = await project.streams.get(sourcePath).append({
    type: "events.iterate.com/test/source",
    metadata: { crossPostMarker: marker },
    payload: { text: "hello from a child stream" },
  });

  const copiedEvent = await copied;
  expect(copiedEvent.metadata).toMatchObject({
    crossPostedBy: "project-worker",
    marker,
    sourceOffset: sourceEvent.offset,
    sourcePath,
  });
  // oxlint-disable-next-line iterate/prefer-object-property-match -- exhaustive equality: the copied payload must be exactly the original (metadata above is deliberately subset-matched); toMatchObject would hide contamination
  expect(copiedEvent.payload).toEqual({
    originalPayload: { text: "hello from a child stream" },
    originalType: "events.iterate.com/test/source",
  });

  // The source stream's worker-feed cursor reflects the delivery. The push
  // ack lands after the worker's processEventBatch resolves — which can be a
  // beat after the cross-posted copy became observable — so poll briefly.
  await waitForCondition(
    async () => {
      const runtimeState = await project.streams.get(sourcePath).runtimeState();
      const feed = runtimeState.runtime.subscriptions["project-worker"];
      return (feed?.ackedOffset ?? 0) >= sourceEvent.offset;
    },
    {
      description: "project-worker feed ackedOffset to reach the source event",
      timeoutMs: 10_000,
    },
  );
});
