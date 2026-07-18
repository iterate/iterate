import { expect, test } from "vitest";
import type { Agent, AgentChat, CapabilityHost } from "../../src/itx-api.generated.ts";
import { createTestProjectPool } from "../test-support/create-shared-test-project.ts";
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

const agentProjectPool = createTestProjectPool({ size: 2, slugPrefix: "agent-family" });

// These are hand written tests - they MUST pass
test("agent create installs only generic machinery; later events configure it", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });

  using projectLease = await agentProjectPool.acquire(itx);
  using project = itx.projects.get(projectLease.projectId);
  using agent = project.agents.get(`/agents/create-${crypto.randomUUID()}`);
  await expect(
    (
      agent as unknown as {
        create(input: { unexpected: true }): Promise<void>;
      }
    ).create({ unexpected: true }),
  ).rejects.toThrow(
    "agent.create() takes no arguments; append configuration and context through agent.append() after creation",
  );
  expect((await agent.processor.snapshot()).state.birthCertificate).toBeNull();

  await agent.create();
  await expect(agent.create()).resolves.toBeUndefined();

  await expect(
    (
      agent as unknown as {
        append(event: { type: string; payload: Record<string, unknown> }): Promise<unknown>;
      }
    ).append({
      type: "events.iterate.com/stream/subscription-configured",
      payload: {},
    }),
  ).rejects.toThrow(
    'Processor "agent" does not consume event "events.iterate.com/stream/subscription-configured".',
  );

  const ephemeralIdempotencyKey = `agent-append-ephemeral-${crypto.randomUUID()}`;
  await expect(
    (
      agent as unknown as {
        append(event: {
          type: string;
          payload: Record<string, unknown>;
          idempotencyKey: string;
          ephemeral: true;
        }): Promise<unknown>;
      }
    ).append({
      type: AGENT_CONTEXT_ADDED_TYPE,
      idempotencyKey: ephemeralIdempotencyKey,
      ephemeral: true,
      payload: { role: "user", content: "wake processors cannot consume this" },
    }),
  ).rejects.toThrow(
    `Processor "agent" cannot consume ephemeral event "${AGENT_CONTEXT_ADDED_TYPE}".`,
  );
  expect(await agent.stream.getEvent({ idempotencyKey: ephemeralIdempotencyKey })).toBeUndefined();

  const [configured] = await agent.append({
    type: AGENT_CONTEXT_ADDED_TYPE,
    idempotencyKey: `agent-config-after-create-${crypto.randomUUID()}`,
    payload: {
      role: "system",
      key: "test/config-after-create",
      content: "configuration is an ordinary event after generic creation",
    },
  });
  await agent.processor.waitUntilProcessed({ offset: configured.offset, timeoutMs: 30_000 });
  expect((await agent.processor.snapshot()).state.context.system).toContainEqual(
    expect.objectContaining({
      key: "test/config-after-create",
      content: "configuration is an ordinary event after generic creation",
    }),
  );
});

test("Agent scripts update presentation metadata via itx.agent.setMetadata", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });

  using projectLease = await agentProjectPool.acquire(itx);
  using project = itx.projects.get(projectLease.projectId);
  const agentPath = `/agents/set-metadata-${crypto.randomUUID()}`;
  using agent = project.agents.get(agentPath);
  await agent.create();

  const metadataPatch = agent.stream.waitForEvent({
    eventTypes: ["events.iterate.com/agent/metadata-changed"],
    predicate: (event) =>
      (event.payload as { title?: string } | undefined)?.title === "Lisbon trip",
    timeoutMs: 30_000,
  });

  await appendSyntheticProviderOutput(
    agent.stream,
    fencedAgentScript(
      defineItxScript<{ agent: Agent }>(async (itx) => {
        await itx.agent.setMetadata({
          title: "Lisbon trip",
          summary: "Planning a three-day Lisbon trip and comparing the practical options.",
          activity: "Comparing flights",
        });
      }).code,
    ),
  );

  expect(await metadataPatch).toMatchObject({
    type: "events.iterate.com/agent/metadata-changed",
    payload: {
      title: "Lisbon trip",
      summary: "Planning a three-day Lisbon trip and comparing the practical options.",
      activity: "Comparing flights",
    },
  });

  // The same canonical metadata fold feeds the project projection and painters.
  await waitForCondition(
    async () => {
      const snapshot = await agent.processor.snapshot();
      return snapshot.state.metadata.title === "Lisbon trip";
    },
    { description: "metadata.title folded into agent state", timeoutMs: 30_000 },
  );
});

test("Agent scripts can send web-chat messages (with file attachments) and call project tools", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });

  using projectLease = await agentProjectPool.acquire(itx);
  using project = itx.projects.get(projectLease.projectId);
  const agentPath = `/agents/project-tool-${crypto.randomUUID()}`;
  using agent = project.agents.get(agentPath);
  await agent.create();

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
        type: "events.iterate.com/capability-host/script-run-requested",
      }),
      expect.objectContaining({
        type: "events.iterate.com/capability-host/script-run-settled",
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

test("Agent create replays its earlier birth and setup events through its subscriptions", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });

  using projectLease = await agentProjectPool.acquire(itx);
  using project = itx.projects.get(projectLease.projectId);
  const agentPath = `/agents/create-replay-${crypto.randomUUID()}`;
  using agent = project.agents.get(agentPath);

  await agent.create();

  const events = await agent.stream.getEvents({ afterOffset: 0 });
  const requiredOffset = (
    description: string,
    predicate: (event: (typeof events)[number]) => boolean,
  ) => {
    const offset = events.find(predicate)?.offset;
    if (offset === undefined) throw new Error(`agent creation has no ${description}`);
    return offset;
  };

  const birthCertificateOffset = requiredOffset(
    "agent birth certificate",
    (event) => event.type === "events.iterate.com/agent/created",
  );
  const agentConfiguredOffset = requiredOffset(
    "agent configuration",
    (event) => event.type === "events.iterate.com/agent/configured",
  );
  const systemPromptOffset = requiredOffset(
    "platform system context",
    (event) =>
      event.type === AGENT_CONTEXT_ADDED_TYPE && event.payload?.key === "agent/system-prompt",
  );
  const bootContextOffset = requiredOffset(
    "boot context",
    (event) =>
      event.type === AGENT_CONTEXT_ADDED_TYPE && event.payload?.key === "agent/boot-context",
  );
  const capabilityHostBirthOffset = requiredOffset(
    "capability-host birth certificate",
    (event) => event.type === "events.iterate.com/capability-host/created",
  );
  const workspaceProvidedOffset = requiredOffset(
    "workspace capability",
    (event) =>
      event.type === "events.iterate.com/capability-host/capability-provided" &&
      Array.isArray(event.payload?.path) &&
      event.payload.path.join(".") === "workspace",
  );
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
  const agentSubscriptionOffset = requiredOffset(
    "agent processor subscription",
    (event) =>
      event.type === "events.iterate.com/stream/subscription-configured" &&
      wakeExpressionRoot(event) === "agents" &&
      String(wakeSubscriptionPayload(event).subscriptionKey).endsWith("#agent"),
  );
  const capabilityHostSubscriptionOffset = requiredOffset(
    "capability-host processor subscription",
    (event) =>
      event.type === "events.iterate.com/stream/subscription-configured" &&
      wakeExpressionRoot(event) === "capabilityHosts",
  );

  // This is the supported replay case: create commits one complete birth
  // batch, with each processor's ordinary setup facts before its durable
  // subscription. The creation barrier only resolves after both processors
  // have replayed those earlier offsets.
  expect(agentSubscriptionOffset).toBeGreaterThan(birthCertificateOffset);
  expect(agentSubscriptionOffset).toBeGreaterThan(agentConfiguredOffset);
  expect(agentSubscriptionOffset).toBeGreaterThan(systemPromptOffset);
  expect(agentSubscriptionOffset).toBeGreaterThan(bootContextOffset);
  expect(capabilityHostSubscriptionOffset).toBeGreaterThan(capabilityHostBirthOffset);
  expect(capabilityHostSubscriptionOffset).toBeGreaterThan(workspaceProvidedOffset);

  const agentSnapshot = await agent.processor.snapshot();
  expect(agentSnapshot.offset).toBeGreaterThanOrEqual(agentSubscriptionOffset);
  expect(agentSnapshot.state).toMatchObject({
    birthCertificate: {},
    config: { llm: { model: expect.any(String) } },
    context: {
      system: expect.arrayContaining([
        expect.objectContaining({ key: "agent/system-prompt" }),
        expect.objectContaining({ key: "agent/boot-context" }),
      ]),
    },
  });

  const capabilityHostSnapshot = await agent.capabilityHost.processor.snapshot();
  expect(capabilityHostSnapshot.offset).toBeGreaterThanOrEqual(capabilityHostSubscriptionOffset);
  expect(capabilityHostSnapshot.state).toMatchObject({ birthCertificate: { config: {} } });
  expect(await agent.capabilityHost.__describe()).toMatchObject({
    capabilities: expect.arrayContaining([expect.objectContaining({ path: ["workspace"] })]),
  });
});

test("Agent-only dynamic worker and durable object capabilities run from LLM scripts", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });

  using projectLease = await agentProjectPool.acquire(itx);
  using project = itx.projects.get(projectLease.projectId);
  const { projectId } = await project.__describe();
  const agentPath = `/agents/agent-only-${crypto.randomUUID()}`;
  using agent = project.agents.get(agentPath);
  await agent.create();
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

  using projectLease = await agentProjectPool.acquire(itx);
  using project = itx.projects.get(projectLease.projectId);
  const { projectId } = await project.__describe();
  const agentPath = `/agents/scope-cache-${crypto.randomUUID()}`;
  using agent = project.agents.get(agentPath);
  await agent.create();
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

  using projectLease = await agentProjectPool.acquire(itx);
  using project = itx.projects.get(projectLease.projectId);
  await project.__describe();
  const agentPath = `/agents/cross-scope-${crypto.randomUUID()}`;
  using agent = project.agents.get(agentPath);
  await agent.create();

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
      // Visible on the root host itself, and through the agent scope's
      // journaled fallback (local miss -> one hop to the root host).
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

test("agents.get(path).create explicitly appends and processes the complete birth batch", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });

  using projectLease = await agentProjectPool.acquire(itx);
  using project = itx.projects.get(projectLease.projectId);
  const agentPath = `/agents/policy-probe-${crypto.randomUUID()}`;
  using agentStream = project.streams.get(agentPath);

  // A scope may already have an explicitly created capability host. Its
  // birth and subscription are old idempotency hits at the end of the agent
  // create input batch; create() must still wait through the batch's NEWEST
  // offset, not merely the last returned item.
  await project.capabilityHosts.get(agentPath).create();

  const birth = agentStream.waitForEvent({
    eventTypes: ["events.iterate.com/agent/created"],
    timeoutMs: 60_000,
  });
  const workspaceMount = agentStream.waitForEvent({
    eventTypes: ["events.iterate.com/capability-host/capability-provided"],
    timeoutMs: 60_000,
  });
  const configured = agentStream.waitForEvent({
    eventTypes: ["events.iterate.com/agent/configured"],
    timeoutMs: 60_000,
  });
  const basePrompt = agentStream.waitForEvent({
    eventTypes: [AGENT_CONTEXT_ADDED_TYPE],
    predicate: (event) =>
      (event.payload as { key?: string } | undefined)?.key === "agent/system-prompt",
    timeoutMs: 60_000,
  });
  await project.agents.get(agentPath).create();

  expect(await project.agents.list()).toEqual(
    expect.arrayContaining([expect.objectContaining({ path: agentPath })]),
  );

  const birthEvent = await birth;
  expect(birthEvent).toMatchObject({ payload: {} });
  expect((await configured).payload).toMatchObject({
    config: { llm: { model: expect.any(String) } },
  });
  expect((await basePrompt).payload).toMatchObject({
    role: "system",
    key: "agent/system-prompt",
    content: expect.stringContaining("async (itx)"),
  });
  expect((await workspaceMount).payload).toMatchObject({ path: ["workspace"] });

  // Birth mechanics: project-worker (every project stream) + agent processor +
  // capability-host. One agent processor owns history, scheduling, and the
  // Workers AI call — no separate LLM provider processors.
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
