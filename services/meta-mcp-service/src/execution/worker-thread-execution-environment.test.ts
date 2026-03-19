import { describe, expect, test } from "vitest";
import type { MetaMcpTools } from "../metamcp/tools.ts";
import { WorkerThreadMetaMcpExecutionEnvironment } from "./worker-thread-execution-environment.ts";

function createTestTools(): MetaMcpTools {
  return {
    weather: {
      get_forecast: async (input: { city: string }) => ({
        summary: `Forecast for ${input.city}`,
      }),
    },
    discover: async () => null,
    describe: {
      tool: async () => null,
    },
    catalog: {
      namespaces: async () => ({ results: ["weather"] }),
      tools: async () => ({ results: [] }),
    },
    metamcp: {
      addServer: async () => null,
      getSchema: async () => null,
      startOAuth: async () => null,
    },
  };
}

describe("WorkerThreadMetaMcpExecutionEnvironment", () => {
  test("executes code through nested tool proxies", async () => {
    const environment = new WorkerThreadMetaMcpExecutionEnvironment({
      timeoutMs: 5_000,
    });

    const result = await environment.execute({
      code: `
        const namespaces = Object.keys(tools);
        const forecast = await tools.weather.get_forecast({ city: "Pune" });
        console.log("namespaces", namespaces);
        return { namespaces, forecast };
      `,
      tools: createTestTools(),
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected successful execution");
    }

    expect(result.result).toMatchObject({
      namespaces: expect.arrayContaining(["weather", "discover", "describe", "catalog", "metamcp"]),
      forecast: {
        summary: "Forecast for Pune",
      },
    });
    expect(result.logs.some((log) => log.includes("namespaces"))).toBe(true);
  });

  test("times out runaway execution", async () => {
    const environment = new WorkerThreadMetaMcpExecutionEnvironment({
      timeoutMs: 100,
    });

    const result = await environment.execute({
      code: `
        while (true) {}
      `,
      tools: createTestTools(),
    });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected timed out execution");
    }

    expect(result.error.message).toContain("timed out");
  });
});
