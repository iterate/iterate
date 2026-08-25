import { expect, test } from "vitest";
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
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
test("agent create installs only generic machinery; later events configure it", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });

  using project = await itx.projects.get(`agent-create-${crypto.randomUUID()}`).create({});
  expect(await project.agents.list()).toEqual([]);
  using agent = project.agents.get(`/agents/create-${crypto.randomUUID()}`);
  expect((await agent.processor.snapshot()).state.birthCertificate).toBeNull();

  // create() resolves with the same agent handle, so create chains.
  using created = await agent.create({ note: "birth facts ride the certificate" });
  const createdSnapshot = await created.processor.snapshot();
  expect(createdSnapshot.state).toMatchObject({
    birthCertificate: { createdAtOffset: expect.any(Number) },
  });
  const [birthEvent] = await created.stream.getEvents({
    eventTypes: ["events.iterate.com/agent/created"],
  });
  expect(birthEvent?.payload).toEqual({ note: "birth facts ride the certificate" });
  // An identical-payload retry dedupes on the birth idempotency keys …
  using retried = await agent.create({ note: "birth facts ride the certificate" });
  expect((await retried.processor.snapshot()).state).toMatchObject({
    birthCertificate: createdSnapshot.state.birthCertificate,
  });
  // … while a different payload over the existing agent fails loudly (the
  // stream rejects a same-key-different-body created event).
  await expect(
    (async () => {
      await agent.create({ note: "a conflicting birth certificate" });
    })(),
  ).rejects.toThrow();
  expect((await agent.processor.snapshot()).state).toMatchObject({
    birthCertificate: createdSnapshot.state.birthCertificate,
  });

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

  await expect(
    (
      agent as unknown as {
        append(event: {
          type: string;
          payload: Record<string, unknown>;
          ephemeral: true;
        }): Promise<unknown>;
      }
    ).append({
      type: AGENT_CONTEXT_ADDED_TYPE,
      ephemeral: true,
      payload: { role: "user", content: "hosted processors cannot consume this" },
    }),
  ).rejects.toThrow(
    `Processor "agent" cannot consume ephemeral event "${AGENT_CONTEXT_ADDED_TYPE}".`,
  );

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
  expect((await agent.processor.snapshot()).state.contextItems).toContainEqual(
    expect.objectContaining({
      kind: "section",
      key: "test/config-after-create",
      payload: expect.objectContaining({
        content: "configuration is an ordinary event after generic creation",
      }),
    }),
  );
});

test("Agent scripts update their summary through the typed append door", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });

  using project = await itx.projects.get(uniqueFixtureSlug("agent-update-summary")).create({});
  const agentPath = `/agents/update-summary-${crypto.randomUUID()}`;
  using agent = project.agents.get(agentPath);
  await agent.create();

  const summaryUpdate = agent.stream.waitForEvent({
    eventTypes: ["events.iterate.com/agent/summary-updated"],
    predicate: (event) =>
      (event.payload as { title?: string } | undefined)?.title === "Lisbon trip",
    timeoutMs: 30_000,
  });

  await appendSyntheticProviderOutput(
    agent.stream,
    fencedAgentScript(
      defineItxScript<{ agent: Agent }>(async (itx) => {
        await itx.agent.append({
          type: "events.iterate.com/agent/summary-updated",
          payload: {
            title: "Lisbon trip",
            description: "Planning a three-day Lisbon trip and comparing the practical options.",
            activity: "Comparing flights",
          },
        });
      }).code,
    ),
  );

  expect(await summaryUpdate).toMatchObject({
    type: "events.iterate.com/agent/summary-updated",
    payload: {
      title: "Lisbon trip",
      description: "Planning a three-day Lisbon trip and comparing the practical options.",
      activity: "Comparing flights",
    },
  });

  // The same canonical summary fold feeds the project projection and painters.
  await waitForCondition(
    async () => {
      const snapshot = await agent.processor.snapshot();
      return snapshot.state.summary.title === "Lisbon trip";
    },
    { description: "summary.title folded into agent state", timeoutMs: 30_000 },
  );
});

test("Agent scripts can send web-chat messages (with file attachments) and call project tools", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });

  using project = await itx.projects.get(uniqueFixtureSlug("agent-project-tool")).create({});
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
  const reflectedFilesReply = agent.stream.waitForEvent({
    eventTypes: [AGENT_CONTEXT_ADDED_TYPE],
    predicate: (event) =>
      event.payload?.role === "assistant" &&
      event.payload.content ===
        "The assistant sent this visible web-chat message: string form with files",
    timeoutMs: 30_000,
  });
  const scriptSettled = agent.stream.waitForEvent({
    eventTypes: ["events.iterate.com/capability-host/script-run-settled"],
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
  await scriptSettled;
  const reflectedFilesEvent = await reflectedFilesReply;

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

  expect(reflectedFilesEvent.payload).toMatchObject({ role: "assistant" });
  expect(reflectedFilesEvent.payload).not.toHaveProperty("llmRequestOffset");
});

test("Agent create replays its earlier birth and setup events through its subscriptions", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });

  using project = await itx.projects.get(`agent-create-replay-${crypto.randomUUID()}`).create({});
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
    (event) => event.type === AGENT_CONTEXT_ADDED_TYPE && event.payload?.segments !== undefined,
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
  // Hosted processor subscriptions are facet-placed: the subscription name is
  // the instance identity (defaulting to the contract slug) and the facet name;
  // no itx expression names a host Durable Object.
  const wakeSubscriptionPayload = (event: { payload?: Record<string, unknown> }) =>
    event.payload as {
      name?: string;
      receiver?: { action?: string; placement?: string };
    };
  // The subscription NAME is the contract selector (name == registered slug).
  const facetWakeSubscriptionOffset = (description: string, name: string) =>
    requiredOffset(description, (event) => {
      if (event.type !== "events.iterate.com/stream/subscription-configured") return false;
      const payload = wakeSubscriptionPayload(event);
      return payload.receiver?.action === "facet-processor" && payload.name === name;
    });
  const agentSubscriptionOffset = facetWakeSubscriptionOffset(
    "agent processor subscription",
    "agent",
  );
  const capabilityHostSubscriptionOffset = facetWakeSubscriptionOffset(
    "capability-host processor subscription",
    "capability-host",
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
    birthCertificate: { createdAtOffset: expect.any(Number) },
    config: { llm: { model: expect.any(String) } },
    contextItems: expect.arrayContaining([
      // The sectionized default prompt establishes its sections at birth…
      expect.objectContaining({ kind: "section", key: "identity" }),
      expect.objectContaining({ kind: "section", key: "output-formatting" }),
      // …plus the boot context, keyed the same everyday way.
      expect.objectContaining({ kind: "section", key: "agent/boot-context" }),
    ]),
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

  using project = await itx.projects.get(uniqueFixtureSlug("agent-only-tools")).create({});
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
    type: "itx-call",
  });
  using _agentCounterProvision = await agent.provideCapability({
    expression: [
      "workers",
      [
        "get",
        {
          // A test-authored stateful worker: the proof is about agent-scope
          // capability provisioning, not any seeded app.
          className: "CounterDo",
          durableWorkerKey,
          path: agentPath,
          source: inlineJsSource("counter-do.js", {
            "counter-do.js": `
                import { DurableObject } from "cloudflare:workers";

                export class CounterDo extends DurableObject {
                  async increment() {
                    const next = ((await this.ctx.storage.get("n")) ?? 0) + 1;
                    await this.ctx.storage.put("n", next);
                    return next;
                  }
                  async current() {
                    return (await this.ctx.storage.get("n")) ?? 0;
                  }
                }
              `,
          }),
          type: "stateful",
        },
      ],
    ],
    path: ["agentCounter"],
    type: "itx-call",
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

  using project = await itx.projects
    .get(uniqueFixtureSlug("dynamic-worker-scope-cache"))
    .create({});
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
    type: "itx-call",
  });
  using _agentScopeProbeProvision = await agent.provideCapability({
    expression: ["workers", ["get", scopeProbeWorkerRef(agentPath)]],
    path: ["scopeProbe"],
    type: "itx-call",
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

  using project = await itx.projects.get(uniqueFixtureSlug("cross-scope-provide")).create({});
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

  using project = await itx.projects.get(uniqueFixtureSlug("worker-births-agents")).create({});
  const agentPath = `/agents/policy-probe-${crypto.randomUUID()}`;
  using agentStream = project.streams.get(agentPath);

  // A scope may already have an explicitly created capability host. Its
  // birth and subscription are old idempotency hits at the end of the agent
  // create input batch; create() must still wait through the batch's NEWEST
  // offset, not merely the last returned item.
  await project.capabilityHosts.get(agentPath).create();

  await project.agents.get(agentPath).create();

  // create() is a read-after-create barrier for the collection processor, not
  // merely the per-agent processors: its reduced database must be coherent as
  // soon as the call returns.
  expect(await project.agents.list()).toEqual(
    expect.arrayContaining([expect.objectContaining({ path: agentPath })]),
  );

  // This test proves the durable birth batch and create()'s read-after-create
  // barrier, not the live waitForEvent transport. Read the committed facts
  // after create returns so a deployment replacing a waiter incarnation does
  // not turn durable product truth into a test-only transient failure.
  const birthEvents = await agentStream.getEvents({ afterOffset: 0 });
  const birthEvent = birthEvents.find((event) => event.type === "events.iterate.com/agent/created");
  const configured = birthEvents.find(
    (event) => event.type === "events.iterate.com/agent/configured",
  );
  const basePrompt = birthEvents.find(
    (event) =>
      event.type === AGENT_CONTEXT_ADDED_TYPE &&
      (event.payload as { segments?: unknown } | undefined)?.segments !== undefined,
  );
  const workspaceMount = birthEvents.find(
    (event) => event.type === "events.iterate.com/capability-host/capability-provided",
  );
  expect(birthEvent).toMatchObject({ payload: {} });
  expect(configured?.payload).toMatchObject({
    config: { llm: { model: expect.any(String) } },
  });
  expect(basePrompt?.payload).toMatchObject({
    role: "system",
    // The sectionized default prompt, parsed at append time; the codemode
    // contract lives in its output-formatting section.
    segments: expect.arrayContaining([
      expect.objectContaining({
        key: "output-formatting",
        content: expect.stringContaining("async (itx)"),
      }),
    ]),
  });
  expect(workspaceMount?.payload).toMatchObject({ path: ["workspace"] });

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
      .filter((event) => {
        const action = (event.payload as { receiver?: { action?: string } } | undefined)?.receiver
          ?.action;
        return action === "facet-processor" || action === "wake-processor";
      })
      // The subscription NAME is the contract selector (name == registered slug).
      .map((event) => (event.payload as { name?: string } | undefined)?.name)
      .filter((slug): slug is string => typeof slug === "string");
    if (processorSlugs.includes("agent") && processorSlugs.includes("capability-host")) break;
    if (Date.now() > mechanicsDeadline) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  expect(processorSlugs).toEqual(expect.arrayContaining(["agent", "capability-host"]));
  expect(subscriptionCount).toBeGreaterThanOrEqual(3);
});
test("Project worker processEventBatch receives events from every project stream and can copy", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });

  using project = await itx.projects
    .get(uniqueFixtureSlug("project-worker-process-event"))
    .create({});
  const marker = `copy-${crypto.randomUUID()}`;
  // NOT the root stream: every project child stream self-configures the
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
                if (event.metadata?.copyMarker !== ${JSON.stringify(marker)}) return;

                const project = await this.env.ITX.get();
                await project.streams.get("/copied").append({
                  type: "events.iterate.com/test/copied",
                  idempotencyKey: \`project-worker-copy:\${event.path}@\${event.offset}\`,
                  metadata: {
                    copiedBy: "project-worker",
                    marker: event.metadata.copyMarker,
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
    message: "Copy selected project events from processEventBatch",
  });

  const copiedStream = project.streams.get("/copied");
  const copied = copiedStream.waitForEvent({
    eventTypes: ["events.iterate.com/test/copied"],
    // A fresh commit deliberately exercises the cold project-worker build.
    // Durable feed handoff preserves delivery, but two consecutive preview
    // runs exceeded the old 30s client deadline before the worker copied.
    // Keep enough headroom to observe that delivery while the follow-up task
    // reduces the cold-path tail and restores the tighter budget.
    timeoutMs: 100_000,
  });

  const [sourceEvent] = await project.streams.get(sourcePath).append({
    type: "events.iterate.com/test/source",
    metadata: { copyMarker: marker },
    payload: { text: "hello from a child stream" },
  });

  const copiedEvent = await copied;
  expect(copiedEvent.metadata).toMatchObject({
    copiedBy: "project-worker",
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
  // beat after the copy became observable — so poll briefly.
  await waitForCondition(
    async () => {
      const runtimeState = await project.streams.get(sourcePath).runtimeState();
      const subscription = runtimeState.runtime.subscriptions["project-worker"];
      return (subscription?.confirmedOffset ?? 0) >= sourceEvent.offset;
    },
    {
      description: "project-worker subscription acknowledgement to reach the source event",
      timeoutMs: 10_000,
    },
  );
});
