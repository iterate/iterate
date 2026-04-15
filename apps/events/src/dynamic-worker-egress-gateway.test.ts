import { describe, expect, test } from "vitest";
import { parseDynamicWorkerEgressGatewayConfig } from "./lib/dynamic-worker-egress-config.ts";

describe("parseDynamicWorkerEgressGatewayConfig", () => {
  test("returns props for a valid gateway config header", () => {
    expect(
      parseDynamicWorkerEgressGatewayConfig(
        JSON.stringify({
          entrypoint: "DynamicWorkerEgressGateway",
          props: {
            secretHeaderName: "authorization",
            secretHeaderValue: "Bearer test",
          },
        }),
      ),
    ).toEqual({
      secretHeaderName: "authorization",
      secretHeaderValue: "Bearer test",
    });
  });

  test("allows a valid gateway config with no props", () => {
    expect(
      parseDynamicWorkerEgressGatewayConfig(
        JSON.stringify({
          entrypoint: "DynamicWorkerEgressGateway",
        }),
      ),
    ).toBeUndefined();
  });

  test("rejects a config with the wrong entrypoint", () => {
    expect(() =>
      parseDynamicWorkerEgressGatewayConfig(
        JSON.stringify({
          entrypoint: "WrongGateway",
          props: {
            secretHeaderName: "authorization",
            secretHeaderValue: "Bearer test",
          },
        }),
      ),
    ).toThrow("DynamicWorkerEgressGateway received an invalid outbound gateway config.");
  });

  test("rejects a config without a project slug", () => {
    expect(() =>
      parseDynamicWorkerEgressGatewayConfig(
        JSON.stringify({
          entrypoint: "DynamicWorkerEgressGateway",
        }),
      ),
    ).not.toThrow();
  });
});
