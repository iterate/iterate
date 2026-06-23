import { beforeAll, describe, expect, test } from "vitest";
import { connect, ensureProject } from "./e2e-env.ts";
import type { RpcStub } from "./src/client.ts";

type DynamicProjectItx = Record<string, any>;

const uniquePath = (prefix: string) => `/agents/${prefix}-${crypto.randomUUID()}`;
const uniqueCapability = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "_")}`;

const PROJECT_ID = "prj_ref";

function connectProject() {
  return connect<DynamicProjectItx>({ projectId: PROJECT_ID });
}

function getAgent(itx: RpcStub<DynamicProjectItx>) {
  const agentPath = uniquePath("scope-regression");
  const agent = itx.agents.get(agentPath) as any;
  return { agent, agentPath };
}

describe("minimal itx v3 capability scopes", () => {
  beforeAll(async () => {
    await ensureProject(PROJECT_ID);
  });

  test("an agent domain handle exposes an explicit agent ITX surface", async () => {
    using itx = connectProject();
    const { agent, agentPath } = getAgent(itx);
    using agentStub = await agent;
    using agentItx = await agentStub.itx;

    await expect(agentItx.agent.whoami()).resolves.toBe(`agent ${PROJECT_ID}:${agentPath}`);
  });

  test("top-level provideCapability on agent ITX mounts on the project", async () => {
    using itx = connectProject();
    const { agent } = getAgent(itx);
    using agentStub = await agent;
    using agentItx = await agentStub.itx;
    const capName = uniqueCapability("providedFromAgentTopLevel");

    const provision = await agentItx.provideCapability({
      capability: {
        type: "live",
        target: {
          ping() {
            return "project-mounted";
          },
        },
      },
      path: [capName],
    });

    try {
      await expect(itx[capName].ping()).resolves.toBe("project-mounted");
    } finally {
      await provision.revoke();
    }
  });

  test("itx.agent.provideCapability mounts on the agent", async () => {
    using itx = connectProject();
    const { agent } = getAgent(itx);
    using agentStub = await agent;
    using agentItx = await agentStub.itx;
    const capName = uniqueCapability("providedOnAgent");

    const provision = await agentItx.agent.provideCapability({
      capability: {
        type: "live",
        target: {
          ping() {
            return "agent-mounted";
          },
        },
      },
      path: [capName],
    });

    try {
      await expect(agentItx.agent[capName].ping()).resolves.toBe("agent-mounted");
    } finally {
      await provision.revoke();
    }
  });

  test("itx.agent.stream appends to the current agent stream", async () => {
    using itx = connectProject();
    const { agent, agentPath } = getAgent(itx);
    using agentStub = await agent;
    using agentItx = await agentStub.itx;
    const marker = uniqueCapability("agentStreamMarker");

    await agentItx.agent.stream.append({
      event: {
        type: "events.iterate.com/test/agent-stream-scope",
        payload: { marker },
      },
    });

    const events = await itx.streams.get(agentPath).getEvents({ afterOffset: 0 });
    expect(events).toContainEqual(
      expect.objectContaining({
        payload: { marker },
        type: "events.iterate.com/test/agent-stream-scope",
      }),
    );
  });
});
