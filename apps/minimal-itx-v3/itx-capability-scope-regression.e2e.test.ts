import { beforeAll, describe, expect, test } from "vitest";
import { connect, ensureProject } from "./e2e-env.ts";
import type { ProjectItxRpc, RpcStub } from "./src/client.ts";

type DynamicProjectItx = ProjectItxRpc & Record<string, any>;

const uniquePath = (prefix: string) => `/agents/${prefix}-${crypto.randomUUID()}`;
const uniqueCapability = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "_")}`;

const PROJECT_ID = "prj_ref";

function connectProject() {
  return connect<DynamicProjectItx>({ projectId: PROJECT_ID });
}

function getAgentItx(itx: RpcStub<DynamicProjectItx>) {
  const agentPath = uniquePath("scope-regression");
  const agent = itx.agents.get(agentPath) as any;
  return { agent, agentPath, agentItx: agent.itx as any };
}

describe("minimal itx v2 capability scope regressions", () => {
  beforeAll(async () => {
    await ensureProject(PROJECT_ID);
  });

  test.fails("an agent domain handle exposes an explicit agent ITX surface", async () => {
    using itx = connectProject();
    const { agentItx, agentPath } = getAgentItx(itx);

    await expect(agentItx.agent.whoami()).resolves.toBe(`agent ${PROJECT_ID}:${agentPath}`);
  });

  test.fails("top-level provideCapability on agent ITX mounts on the project", async () => {
    using itx = connectProject();
    const { agentItx } = getAgentItx(itx);
    const capName = uniqueCapability("providedFromAgentTopLevel");

    await agentItx.provideCapability({
      capability: {
        ping() {
          return "project-mounted";
        },
      },
      path: [capName],
    });

    await expect(itx[capName].ping()).resolves.toBe("project-mounted");
  });

  test.fails("itx.agent.provideCapability mounts only on the agent", async () => {
    using itx = connectProject();
    const { agentItx } = getAgentItx(itx);
    const capName = uniqueCapability("providedOnAgent");

    await agentItx.agent.provideCapability({
      capability: {
        ping() {
          return "agent-mounted";
        },
      },
      path: [capName],
    });

    await expect(agentItx.agent[capName].ping()).resolves.toBe("agent-mounted");
    await expect(itx[capName].ping()).rejects.toThrow(/no capability/);
  });

  test.fails("itx.agent.stream appends to the current agent stream", async () => {
    using itx = connectProject();
    const { agentItx, agentPath } = getAgentItx(itx);
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
