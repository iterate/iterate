import { describe, expect, it } from "vitest";
import type { DeviceConfiguration } from "./config-image.ts";
import { assertWifiReprovisionReadback, withReprovisionedWifi } from "./wifi-reprovision.ts";

const existing: DeviceConfiguration = {
  schemaVersion: 1,
  wifi: { password: "old network secret", ssid: "old network" },
  iterate: {
    baseUrl: "https://os.iterate.com",
    pcmBaseUrl: "https://kit--physical-proof.iterate.app",
    projectApiKey: "itxk_existing_device_identity",
    projectId: "prj_existing_device_identity",
  },
};

describe("withReprovisionedWifi", () => {
  it("preserves the complete production identity while replacing only Wi-Fi", () => {
    /*
     * Moving rooms must not become an implicit project migration. Losing the
     * retained API key or PCM origin here would make later mount failures look
     * like network faults and could send voice traffic to the wrong worker.
     */
    const updated = withReprovisionedWifi(existing, {
      password: "new network secret",
      ssid: "new network",
    });

    expect(updated).toEqual({
      ...existing,
      wifi: { password: "new network secret", ssid: "new network" },
    });
    expect(updated.iterate).not.toBe(existing.iterate);
    expect(existing.wifi.ssid).toBe("old network");
  });
});

describe("assertWifiReprovisionReadback", () => {
  it("rejects credential drift without including either secret in the error", () => {
    /*
     * A diagnostic error often lands in durable evidence. It must say which
     * invariant failed while never serializing the expected or actual project
     * key (nor the Wi-Fi password) into logs.
     */
    const expected = withReprovisionedWifi(existing, {
      password: "new network secret",
      ssid: "new network",
    });
    const actual = {
      ...expected,
      iterate: { ...expected.iterate, projectApiKey: "unexpected key material" },
    };

    let message = "";
    try {
      assertWifiReprovisionReadback(existing, expected, actual);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("project API key");
    expect(message).not.toContain(existing.iterate.projectApiKey);
    expect(message).not.toContain(actual.iterate.projectApiKey);
    expect(message).not.toContain(expected.wifi.password);
  });
});
