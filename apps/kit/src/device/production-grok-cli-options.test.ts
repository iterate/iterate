import { describe, expect, test } from "vitest";
import { parseProductionGrokCliOptions } from "./production-grok-cli-options.ts";

const environment = {
  ITERATE_KIT_PROJECT_API_KEY: "itxk_project_secret",
  XAI_API_KEY: "xai_provider_secret",
};

describe("production Grok proof CLI options", () => {
  test("keeps the historical Stick invocation as the default device route", () => {
    const options = parseProductionGrokCliOptions([], environment);

    expect(options.deviceId).toBe("m5sticks3");
    expect(options.outputDirectory).toMatch(/\/evidence\/m5sticks3-production-grok$/u);
    expect(options.turns).toBe(1);
  });

  test("selects a bounded number of PTT turns for one deployed conversation", () => {
    const options = parseProductionGrokCliOptions(["--turns", "3"], environment);

    expect(options.turns).toBe(3);
  });

  test("selects a reusable device identity explicitly", () => {
    const options = parseProductionGrokCliOptions(
      ["--device-id", "stackchan", "--device-host", "192.168.0.31"],
      environment,
    );

    expect(options).toMatchObject({
      deviceHost: "192.168.0.31",
      deviceId: "stackchan",
    });
    expect(options.outputDirectory).toMatch(/\/evidence\/stackchan-production-grok$/u);
  });

  test("rejects a device identity that cannot own one isolated stream", () => {
    expect(() =>
      parseProductionGrokCliOptions(["--device-id", "devices/stackchan"], environment),
    ).toThrow("device id");
  });
});
