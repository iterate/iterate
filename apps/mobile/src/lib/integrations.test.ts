import { expect, test, vi } from "vitest";
import { listMobileIntegrations } from "./integrations.ts";

test("joins built-in journals to live status and keeps project-provided mounts", async () => {
  const getConnection = vi.fn(async ({ connection }: { connection: string }) => ({
    connected: connection === "iterate-workspace",
    displayName: connection === "iterate-workspace" ? "Iterate" : null,
    externalId: connection === "iterate-workspace" ? "T123" : null,
    metadata: {},
  }));
  const project = {
    integrations: {
      getConnection,
      list: async () => [
        {
          connection: "iterate-workspace",
          integration: "slack",
          path: "/integrations/slack/iterate-workspace",
          source: "builtin",
        },
        {
          connection: "old-account",
          integration: "gmail",
          path: "/integrations/google/old-account",
          source: "builtin",
        },
        {
          connection: null,
          integration: "weather",
          path: "/integrations/weather",
          source: "provided",
        },
      ],
    },
    secrets: {
      list: async () => [
        {
          createdAt: "2026-08-07T00:00:00.000Z",
          path: "/secrets/integrations/waitrose/personal/session",
        },
        {
          createdAt: "2026-08-07T00:00:00.000Z",
          path: "/secrets/integrations/grocer/mum/session",
        },
        { createdAt: "2026-08-07T00:00:00.000Z", path: "/secrets/ordinary-api-key" },
      ],
    },
  };

  const integrations = await listMobileIntegrations(project as any);

  expect(integrations).toMatchObject({
    accounts: [
      {
        connected: false,
        connection: "personal",
        integration: "waitrose",
      },
      {
        connected: null,
        connection: "mum",
        integration: "grocer",
      },
    ],
    connections: {
      gmail: [
        {
          connection: "old-account",
          status: { connected: false },
        },
      ],
      slack: [
        {
          connection: "iterate-workspace",
          status: { connected: true, displayName: "Iterate", externalId: "T123" },
        },
      ],
    },
    provided: [
      {
        connection: null,
        integration: "weather",
        path: "/integrations/weather",
      },
    ],
  });
  expect(getConnection).toHaveBeenCalledWith({
    connection: "old-account",
    provider: "google",
  });
});
