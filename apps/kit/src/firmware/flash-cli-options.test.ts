import { describe, expect, it } from "vitest";
import { parseLocalFlashCliOptions } from "./flash-cli-options.ts";

const environment = {
  ITERATE_KIT_PROJECT_API_KEY: "itxk_secret",
  ITERATE_KIT_WIFI_PASSWORD: "wifi-secret",
};

describe("parseLocalFlashCliOptions", () => {
  it("keeps secrets in environment variables while accepting non-secret flags", () => {
    const options = parseLocalFlashCliOptions(
      [
        "--",
        "--port",
        "/dev/cu.usbmodem101",
        "--wifi-ssid",
        "studio",
        "--project-id",
        "prj_voice_lab",
        "--base-url",
        "os.iterate.com",
        "--build-directory",
        ".build/custom",
        "--dry-run",
      ],
      environment,
      "/repo/apps/kit",
    );

    expect(options).toEqual({
      buildDirectory: "/repo/apps/kit/.build/custom",
      configuration: {
        schemaVersion: 1,
        wifi: { ssid: "studio", password: "wifi-secret" },
        iterate: {
          baseUrl: "https://os.iterate.com",
          projectId: "prj_voice_lab",
          projectApiKey: "itxk_secret",
        },
      },
      dryRun: true,
      port: "/dev/cu.usbmodem101",
    });
  });

  it("rejects secret command-line flags so credentials do not enter shell history", () => {
    expect(() =>
      parseLocalFlashCliOptions(
        [
          "--port",
          "/dev/cu.usbmodem101",
          "--wifi-ssid",
          "studio",
          "--project-id",
          "prj_voice_lab",
          "--wifi-password",
          "do-not-allow-this",
        ],
        environment,
        "/repo/apps/kit",
      ),
    ).toThrow("Unknown option --wifi-password");
  });

  it("names every missing required input without printing any supplied secret", () => {
    expect(() =>
      parseLocalFlashCliOptions(
        ["--port", "/dev/cu.usbmodem101"],
        {},
        "/repo/apps/kit",
      ),
    ).toThrow(
      "Missing --wifi-ssid or ITERATE_KIT_WIFI_SSID, --project-id or ITERATE_KIT_PROJECT_ID, ITERATE_KIT_WIFI_PASSWORD, ITERATE_KIT_PROJECT_API_KEY",
    );
  });
});
