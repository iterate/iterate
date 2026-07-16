import { test } from "vitest";
import { createTestProject } from "../test-support/create-test-project.ts";

test(
  "explicit capability-host ancestry is atomic at agent birth and survives eviction",
  { timeout: 120_000 },
  async ({ expect }) => {
    await using handle = await createTestProject({ slugPrefix: "host-ancestry" });
    using itx = handle.itx();

    // A new DO incarnation starts with the processor schema's default state.
    // The first foreground read must pull the durable root declaration rather
    // than misclassifying the project as an unconfigured legacy host.
    await itx.capabilityHosts
      .get("/")
      .kill()
      .catch(() => undefined);
    expect(await itx.capabilityHosts.get("/").__describe()).toMatchObject({
      ancestorPath: null,
      path: "/",
    });

    const agentPath = `/agents/web/ancestry-${crypto.randomUUID()}`;
    using agent = itx.agents.get(agentPath);
    await agent.configure({});

    // configure() is an agent lifecycle door. The entire mechanics certificate
    // must precede its first policy fact in the SAME append; relying on the
    // root project's asynchronous child-stream-created reaction recreates the
    // onboarding race this test guards.
    const events = await agent.stream.getEvents({});
    const ancestor = events.find(
      (event) => event.type === "events.iterate.com/capability-host/ancestor-configured",
    );
    const processorSubscriptions = events.filter(
      (event) => event.type === "events.iterate.com/stream/subscription-configured",
    );
    const firstPolicy = events.find(
      (event) =>
        event.type === "events.iterate.com/agents/context-added" ||
        event.type === "events.iterate.com/agent/llm-provider-selected",
    );

    expect(ancestor).toMatchObject({ payload: { ancestorPath: "/" } });
    expect(
      processorSubscriptions.map(
        (event) =>
          (event.payload?.delivery as { processorSlug?: string } | undefined)?.processorSlug,
      ),
    ).toEqual(expect.arrayContaining(["capability-host", "agent"]));
    expect(firstPolicy).toBeDefined();
    expect(ancestor!.offset).toBeLessThan(firstPolicy!.offset);
    expect(processorSubscriptions.every((event) => event.offset < firstPolicy!.offset)).toBe(true);

    // The same durable declaration must be authoritative after the agent host
    // itself is evicted, without waiting for an asynchronous wake delivery.
    await agent.capabilityHost.kill().catch(() => undefined);
    expect(await itx.capabilityHosts.get(agentPath).__describe()).toMatchObject({
      ancestorPath: "/",
      path: agentPath,
    });
  },
);
