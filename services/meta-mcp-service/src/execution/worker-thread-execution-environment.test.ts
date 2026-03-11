import { describe, expect, test } from "vitest";
import { WorkerThreadMetaMcpExecutionEnvironment } from "./worker-thread-execution-environment.ts";

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
      tools: {
        weather: {
          get_forecast: async (input: { city: string }) => ({
            summary: `Forecast for ${input.city}`,
          }),
        },
        catalog: {
          namespaces: async () => ({ results: ["weather"] }),
        },
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      namespaces: ["weather", "catalog"],
      forecast: {
        summary: "Forecast for Pune",
      },
    });
    expect(result.logs).toContain("namespaces [ 'weather', 'catalog' ]");
  });

  test("times out runaway execution", async () => {
    const environment = new WorkerThreadMetaMcpExecutionEnvironment({
      timeoutMs: 100,
    });

    const result = await environment.execute({
      code: `
        while (true) {}
      `,
      tools: {},
    });

    expect(result.result).toBeNull();
    expect(result.error?.message).toContain("timed out");
  });
});
