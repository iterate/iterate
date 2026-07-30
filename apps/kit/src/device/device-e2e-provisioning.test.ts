import { describe, expect, test, vi } from "vitest";
import type { DeviceConfiguration } from "../firmware/config-image.ts";
import { resolveDeviceE2eProvisioning } from "./device-e2e-provisioning.ts";

const storedConfiguration: DeviceConfiguration = {
  schemaVersion: 1,
  wifi: {
    ssid: "physical-test-network",
    password: "stored-wifi-password",
  },
  iterate: {
    baseUrl: "https://stable-device-tunnel.example",
    projectId: "prj_stored_physical_device",
    projectApiKey: "itxk_stored_physical_device_secret",
  },
};

describe("device E2E provisioning", () => {
  test("reuses the credentials already flashed on a no-flash physical rerun", () => {
    /*
     * A no-flash run starts a fresh local peer but leaves the device's raw
     * provisioning partition untouched. Minting a new random project ID/key
     * therefore makes TLS succeed while every Cap'n Web mount is rejected.
     * The partition is the independent authority in this mode: the host must
     * authenticate the peer with those exact stored values.
     */
    const generateProjectId = vi.fn(() => "prj_new_random_value");
    const generateProjectApiKey = vi.fn(() => "itxk_new_random_value");

    expect(
      resolveDeviceE2eProvisioning({
        environment: {},
        existingConfiguration: storedConfiguration,
        flash: false,
        generateProjectApiKey,
        generateProjectId,
      }),
    ).toEqual({
      baseUrl: "https://stable-device-tunnel.example",
      environment: {
        ITERATE_KIT_PROJECT_API_KEY: "itxk_stored_physical_device_secret",
        ITERATE_KIT_PROJECT_ID: "prj_stored_physical_device",
        ITERATE_KIT_WIFI_PASSWORD: "stored-wifi-password",
        ITERATE_KIT_WIFI_SSID: "physical-test-network",
      },
    });
    expect(generateProjectId).not.toHaveBeenCalled();
    expect(generateProjectApiKey).not.toHaveBeenCalled();
  });

  test("rejects a no-flash host override that cannot match the stored device", () => {
    /*
     * Silently ignoring an explicit project key would make an operator believe
     * they had tested that credential. Using it would recreate the rejected
     * mount. Rejecting the contradiction before opening the tunnel is the only
     * result that preserves an honest account of what the physical run uses.
     */
    expect(() =>
      resolveDeviceE2eProvisioning({
        environment: {
          ITERATE_KIT_PROJECT_API_KEY: "itxk_requested_but_not_flushed",
        },
        existingConfiguration: storedConfiguration,
        flash: false,
        generateProjectApiKey: () => "itxk_unused",
        generateProjectId: () => "prj_unused",
      }),
    ).toThrow("project API key differs");
  });
});
