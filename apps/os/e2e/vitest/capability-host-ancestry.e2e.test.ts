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
    await agent.create({});

    // Agent creation commits the explicit relationship and both processor
    // subscriptions in one batch. No physical path prefix is consulted.
    const events = await agent.stream.getEvents({});
    const capabilityHostBirth = events.find(
      (event) => event.type === "events.iterate.com/capability-host/created",
    );
    const processorSubscriptions = events.filter(
      (event) => event.type === "events.iterate.com/stream/subscription-configured",
    );
    expect(capabilityHostBirth).toMatchObject({
      payload: { config: { ancestorPath: "/" } },
    });
    expect(
      processorSubscriptions.map(
        (event) =>
          (event.payload?.delivery as { processorSlug?: string } | undefined)?.processorSlug,
      ),
    ).toEqual(expect.arrayContaining(["capability-host", "agent"]));

    // The same durable declaration must be authoritative after the agent host
    // itself is evicted, without waiting for an asynchronous wake delivery.
    await agent.capabilityHost.kill().catch(() => undefined);
    expect(await itx.capabilityHosts.get(agentPath).__describe()).toMatchObject({
      ancestorPath: "/",
      path: agentPath,
    });
  },
);
